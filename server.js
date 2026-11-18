/**
 * 一键行万里 · 后端服务（零依赖，Node 内置模块）
 * 功能：
 *   1. 静态托管 index.html / admin.html / bg/
 *   2. POST /api/generate —— 前端行程生成接口（服务端持有 DeepSeek Key，前端无感知）
 *   3. /admin.html —— 管理后台：设置管理员密码、录入/更换 DeepSeek Key
 * 安全：
 *   - Key 只存服务器 data/deepseek_key.json（不入 Git、不下发给前端）
 *   - 管理接口需密码登录（HMAC token，12 小时有效）
 *   - 公开生成接口有 IP 限流
 * 启动：node server.js   （默认端口 8787，可用环境变量 PORT 覆盖）
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8787;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');
const KEY_FILE = path.join(DATA_DIR, 'deepseek_key.json');
const KEY_FILE_TMP = KEY_FILE + '.tmp';
const CITY_FILE = path.join(ROOT, 'cities.json');

/* ============ 城市名录（用于校验目的地真实存在） ============ */
const CITY_LIST = (() => {
    try { return JSON.parse(fs.readFileSync(CITY_FILE, 'utf8')); }
    catch (e) { console.warn('cities.json 读取失败，城市校验将跳过'); return []; }
})();
const CITY_SET = new Set(CITY_LIST);
// 港澳台及相关城市：仅支持中国大陆
const NOT_MAINLAND = new Set(['香港','澳门','台湾','台北','新北','台中','台南','高雄','基隆','新竹','嘉义','花莲','垦丁']);
/* 省级行政区 → 推荐城市：用户输入省份时给出明确引导，而不是笼统报「城市名不正确」 */
const PROVINCE_MAP = {
    '河北': ['石家庄','承德','秦皇岛','保定'],
    '山西': ['太原','大同','晋中','忻州'],
    '辽宁': ['沈阳','大连','丹东'],
    '吉林': ['长春','集安','延边'],
    '黑龙江': ['哈尔滨','漠河','牡丹江'],
    '江苏': ['南京','苏州','扬州','无锡'],
    '浙江': ['杭州','宁波','绍兴','舟山'],
    '安徽': ['黄山','合肥','宣城'],
    '福建': ['厦门','福州','泉州','武夷山'],
    '江西': ['南昌','景德镇','婺源','庐山'],
    '山东': ['青岛','济南','泰安','曲阜'],
    '河南': ['洛阳','郑州','开封'],
    '湖北': ['武汉','宜昌','恩施','神农架'],
    '湖南': ['长沙','张家界','凤凰'],
    '广东': ['广州','深圳','珠海','潮州'],
    '海南': ['三亚','海口','博鳌'],
    '四川': ['成都','九寨沟','峨眉山','稻城'],
    '贵州': ['贵阳','荔波','镇远','赤水'],
    '云南': ['昆明','大理','丽江','香格里拉'],
    '陕西': ['西安','延安','汉中'],
    '甘肃': ['兰州','敦煌','张掖'],
    '青海': ['西宁','海北','海西'],
    '宁夏': ['银川','中卫'],
    '新疆': ['乌鲁木齐','喀什','伊犁','吐鲁番'],
    '内蒙古': ['呼和浩特','呼伦贝尔','鄂尔多斯','阿尔山'],
    '广西': ['桂林','南宁','北海','涠洲岛'],
    '西藏': ['拉萨','林芝','日喀则','阿里']
};
function normalizeProvince(raw) {
    let s = String(raw || '').trim().replace(/\s+/g, '');
    s = s.replace(/(壮族自治区|回族自治区|维吾尔自治区|自治区|省)$/, '');
    if (s === '内蒙') s = '内蒙古';
    return s;
}

/**
 * 校验城市名。返回 { valid, reason, message }
 * 规则（与前端 index.html 保持一致）：
 *   1. 原名或归一化后（去「自治州+民族名」「市/地区/盟/县」后缀）精确命中名录
 *   2. 「城市名 + 合法后缀」放行（丽江古城 / 西双版纳傣族自治州）
 *   3. 其余一律视为不存在的城市，避免「成都敷」这类错字被放过
 */
const CITY_SUFFIX_OK = ['市','区','县','地区','盟','自治州','自治县','古城','古镇','古城景区','景区','风景区','旅游区','度假区','新区'];

function normalizeCity(raw) {
    let s = String(raw || '').trim().replace(/\s+/g, '');
    if (/自治州$/.test(s)) s = s.replace(/自治州$/, '').replace(/([^\s]{1,5}族)+$/, '');
    return s.replace(/(市|地区|盟|自治县|县)$/, '');
}

function validateCity(raw) {
    const input = String(raw || '').trim();
    if (!input) return { valid: false, reason: 'EMPTY', message: '请输入目的地城市' };
    if (input.length > 20) return { valid: false, reason: 'TOO_LONG', message: '目的地名称过长，请输入城市名（如：西安）' };
    for (const t of NOT_MAINLAND) {
        if (input.includes(t)) return { valid: false, reason: 'NOT_MAINLAND', message: '暂仅支持中国大陆目的地，请输入大陆城市名' };
    }
    if (CITY_SET.has(input) || CITY_SET.has(normalizeCity(input))) return { valid: true };
    for (const city of CITY_LIST) {
        if (city.length >= 2 && input.startsWith(city)) {
            const rest = input.slice(city.length);
            if (CITY_SUFFIX_OK.includes(rest) || /自治(州|县)$/.test(rest)) return { valid: true };
        }
    }
    const prov = normalizeProvince(input);
    if (PROVINCE_MAP[prov]) {
        const cities = PROVINCE_MAP[prov].filter(c => CITY_SET.has(c));
        return {
            valid: false, reason: 'PROVINCE', suggestions: cities,
            message: `「${prov}」是省级行政区，请选择具体城市（如：${cities.slice(0, 3).join('、')}）`
        };
    }
    return { valid: false, reason: 'NOT_FOUND', message: '请输入正确的城市名（如：西安、成都、大理）' };
}

/* ============ 系统提示词（只存服务端） ============ */
const SYSTEM_PROMPT = `你是一位专业的中国大陆旅行规划师。根据用户给定的目的地城市和旅行天数，生成一份结构化的多日行程计划。

【硬性规则】
1. 只推荐真实存在的中国大陆景点，不得编造景点名称；只覆盖中国大陆地区（港澳台除外）。
2. 每个景点必须给出经纬度坐标（GCJ-02 火星坐标系），坐标需真实可用，误差应在 1 公里以内。
3. 同一天的景点必须地理上顺路：按"上午→下午→傍晚"合理排序，同一天景点间距离不宜超过 30 公里。
4. 每天安排 3~4 个景点，第 1 天和最后 1 天节奏放宽（考虑抵达和返程）。
5. 只输出严格 JSON，不要输出 JSON 以外的任何文字（包括 Markdown 代码块标记）。

【输出 JSON 结构】
{
  "destination": "城市名",
  "days": 天数,
  "transportAdvice": "市内交通建议（一句话）",
  "itinerary": [
    { "day": 1,
      "title": "当日主题（10字内）",
      "spots": [
        { "name": "景点名", "lng": 经度, "lat": 纬度,
          "tags": ["标签1","标签2","标签3"],
          "intro": "简短介绍40~60字",
          "tips": "注意事项1~2条",
          "duration": "2小时", "period": "上午" }
      ] }
  ]
}`;

/* ============ 小工具 ============ */
function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    // 保护数据目录：禁止 web 直接访问（静态白名单机制本身已拦截，这里再降权提示）
}
function readJSON(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}
function writeJSONAtomic(file, obj) {
    fs.writeFileSync(file + '.tmp', JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(file + '.tmp', file);
}
const sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/* ============ 管理员凭据 ============ */
function getAdmin() {
    // { hash: sha256(password), secret: 随机签名密钥 }
    return readJSON(ADMIN_FILE, null);
}
function ensureAdminSecret(admin) {
    if (!admin.secret) {
        admin.secret = crypto.randomBytes(32).toString('hex');
        writeJSONAtomic(ADMIN_FILE, admin);
    }
    return admin;
}
function signToken(admin, ttlMs) {
    const exp = Date.now() + (ttlMs || 12 * 3600 * 1000);
    const payload = String(exp);
    const sig = crypto.createHmac('sha256', admin.secret).update(payload).digest('hex');
    return payload + '.' + sig;
}
function verifyToken(admin, token) {
    if (!admin || !admin.secret || typeof token !== 'string') return false;
    const i = token.indexOf('.');
    if (i < 0) return false;
    const payload = token.slice(0, i), sig = token.slice(i + 1);
    const expect = crypto.createHmac('sha256', admin.secret).update(payload).digest('hex');
    try {
        if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return false;
    } catch (e) { return false; }
    return Number(payload) > Date.now();
}

/* ============ DeepSeek Key ============ */
function getDeepseekKey() {
    const o = readJSON(KEY_FILE, null);
    return o && o.key ? String(o.key) : '';
}

/* ============ IP 限流（滑动窗口，内存版） ============ */
const rateMap = new Map();
function rateLimit(ip, limit, windowMs) {
    const now = Date.now();
    let rec = rateMap.get(ip);
    if (!rec || now > rec.reset) { rec = { count: 0, reset: now + windowMs }; rateMap.set(ip, rec); }
    rec.count++;
    // 顺带清理过期项，防止内存膨胀
    if (rateMap.size > 5000) for (const [k, v] of rateMap) if (now > v.reset) rateMap.delete(k);
    return rec.count <= limit;
}

/* ============ 调用 DeepSeek（JSON mode） ============ */
function callDeepseek(key, city, nDays) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({
            model: 'deepseek-chat',
            temperature: 1.0,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: `目的地：${city}\n旅行天数：${nDays} 天\n请生成行程计划，严格按系统提示词的 JSON 结构输出。` }
            ],
            response_format: { type: 'json_object' },
            max_tokens: 4000
        });
        const req = https.request({
            hostname: 'api.deepseek.com', path: '/chat/completions', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'Content-Length': Buffer.byteLength(body) },
            timeout: 90000
        }, res => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    const err = new Error('DeepSeek ' + res.statusCode + ': ' + raw.slice(0, 200));
                    err.upstreamStatus = res.statusCode;
                    return reject(err);
                }
                try {
                    const data = JSON.parse(raw);
                    let content = data.choices[0].message.content.trim();
                    if (content.startsWith('```')) content = content.replace(/^```(json)?/, '').replace(/```$/, '').trim();
                    const plan = JSON.parse(content);
                    if (!plan.itinerary || !Array.isArray(plan.itinerary) || !plan.itinerary.length) {
                        return reject(new Error('BAD_PLAN'));
                    }
                    resolve(plan);
                } catch (e) { reject(new Error('BAD_PLAN')); }
            });
        });
        req.on('timeout', () => req.destroy(new Error('UPSTREAM_TIMEOUT')));
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

/* ============ 静态文件（白名单） ============ */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8' };
function serveStatic(req, res, urlPath) {
    // 白名单：只允许这些路径，data/、server.js、.workbuddy 等一律 404
    let file = null;
    if (urlPath === '/' || urlPath === '/index.html') file = path.join(ROOT, 'index.html');
    else if (urlPath === '/admin.html') file = path.join(ROOT, 'admin.html');
    else if (urlPath.startsWith('/bg/')) {
        const name = path.basename(urlPath);           // 防目录穿越
        file = path.join(ROOT, 'bg', name);
        if (!fs.existsSync(file)) file = null;
    }
    if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
    fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('404'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': urlPath.startsWith('/bg/') ? 'public, max-age=86400' : 'no-cache' });
        res.end(buf);
    });
}

/* ============ 请求体读取 ============ */
function readBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        let size = 0; const chunks = [];
        req.on('data', c => { size += c.length; if (size > (maxBytes || 64 * 1024)) { reject(new Error('BODY_TOO_LARGE')); req.destroy(); } else chunks.push(c); });
        req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { resolve({}); } });
        req.on('error', reject);
    });
}
function sendJSON(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
}
function maskKey(key) { return key.slice(0, 5) + '****' + key.slice(-4); }

/* ============ 路由 ============ */
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

    /* 访问日志：请求结束时记录 时间/IP/方法/路径/状态码/耗时，进 journalctl 可查 */
    const t0 = Date.now();
    res.on('finish', () => {
        // 静态资源不记日志，避免刷屏；只记 API 与页面入口
        if (p === '/' || p === '/admin.html' || p.startsWith('/api/')) {
            console.log(`[access] ${new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })} ${ip} ${req.method} ${p} -> ${res.statusCode} ${Date.now() - t0}ms`);
        }
    });

    try {
        /* ---- 管理后台 API ---- */
        if (p === '/api/admin/setup' && req.method === 'POST') {
            const admin = getAdmin();
            if (admin && admin.hash) return sendJSON(res, 409, { error: 'ALREADY_SET', message: '管理员密码已设置，请直接登录' });
            const body = await readBody(req);
            const pwd = String(body.password || '');
            if (pwd.length < 6) return sendJSON(res, 400, { error: 'WEAK_PASSWORD', message: '密码至少 6 位' });
            ensureDataDir();
            writeJSONAtomic(ADMIN_FILE, { hash: sha256(pwd), secret: crypto.randomBytes(32).toString('hex') });
            const a = ensureAdminSecret(getAdmin());
            return sendJSON(res, 200, { ok: true, token: signToken(a) });
        }
        if (p === '/api/admin/login' && req.method === 'POST') {
            const admin = getAdmin();
            if (!admin || !admin.hash) return sendJSON(res, 404, { error: 'NOT_SET_UP', message: '尚未设置管理员密码' });
            const body = await readBody(req);
            const ok = sha256(String(body.password || '')) === admin.hash;
            if (!ok) return sendJSON(res, 401, { error: 'BAD_PASSWORD', message: '密码错误' });
            ensureAdminSecret(admin);
            return sendJSON(res, 200, { ok: true, token: signToken(admin) });
        }
        if (p === '/api/admin/status' && req.method === 'GET') {
            const admin = getAdmin();
            const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
            if (!verifyToken(admin, token)) return sendJSON(res, 401, { error: 'UNAUTHORIZED' });
            const key = getDeepseekKey();
            return sendJSON(res, 200, { ok: true, configured: !!key, keyMasked: key ? maskKey(key) : '' });
        }
        if (p === '/api/admin/key' && req.method === 'POST') {
            const admin = getAdmin();
            const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
            if (!verifyToken(admin, token)) return sendJSON(res, 401, { error: 'UNAUTHORIZED', message: '登录已过期，请重新登录' });
            const body = await readBody(req);
            const key = String(body.key || '').trim();
            if (!/^sk-[A-Za-z0-9]{20,}$/.test(key)) return sendJSON(res, 400, { error: 'BAD_KEY_FORMAT', message: 'Key 格式不对，应以 sk- 开头' });
            ensureDataDir();
            writeJSONAtomic(KEY_FILE, { key, updatedAt: new Date().toISOString() });
            try { fs.chmodSync(KEY_FILE, 0o600); } catch (e) {}
            return sendJSON(res, 200, { ok: true, keyMasked: maskKey(key) });
        }

        /* ---- 公开生成接口 ---- */
        if (p === '/api/generate' && req.method === 'POST') {
            if (!rateLimit(ip, 10, 60 * 1000)) return sendJSON(res, 429, { error: 'RATE_LIMITED', message: '请求太频繁，请稍后再试' });
            const body = await readBody(req);
            const city = String(body.city || '').trim().slice(0, 30);
            const days = Math.min(Math.max(parseInt(body.days, 10) || 3, 1), 7);
            if (!city) return sendJSON(res, 400, { error: 'NO_CITY', message: '请填写目的地' });
            const chk = validateCity(city);
            if (!chk.valid) return sendJSON(res, 400, { error: 'INVALID_CITY', message: chk.message || '请输入正确的城市名', suggestions: chk.suggestions || [] });
            const key = getDeepseekKey();
            if (!key) return sendJSON(res, 503, { error: 'KEY_NOT_SET', message: '服务暂未配置，请稍后再试' });
            const plan = await callDeepseek(key, city, days);
            return sendJSON(res, 200, plan);
        }

        /* ---- 城市名录（前端校验 + 自动补全用） ---- */
        if (p === '/api/cities' && req.method === 'GET') {
            return sendJSON(res, 200, { cities: CITY_LIST });
        }

        /* ---- 健康检查 ---- */
        if (p === '/api/health') return sendJSON(res, 200, { ok: true, time: new Date().toISOString() });

        /* ---- 静态资源 ---- */
        if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, p);

        res.writeHead(405); res.end();
    } catch (e) {
        const map = {
            'BAD_PLAN':      [502, { error: 'BAD_PLAN',      message: 'AI 返回的数据不完整，请重试一次' }],
            'UPSTREAM_TIMEOUT': [504, { error: 'TIMEOUT',    message: 'AI 生成超时，请重试' }],
            'BODY_TOO_LARGE':[413, { error: 'TOO_LARGE',     message: '请求体过大' }]
        };
        const hit = map[e.message];
        if (hit) return sendJSON(res, hit[0], hit[1]);
        const st = e.upstreamStatus;
        const msg = st === 401 || st === 403 ? '服务端 AI Key 已失效，请联系管理员更新'
            : st === 402 ? '服务端 AI 额度不足，请联系管理员充值'
            : st === 429 ? '当前生成请求过多，请稍后再试'
            : '生成服务暂时不可用，请稍后再试';
        sendJSON(res, 502, { error: 'UPSTREAM', message: msg });
    }
});

ensureDataDir();
server.listen(PORT, () => {
    const admin = getAdmin();
    const hasKey = !!getDeepseekKey();
    console.log('「一键行万里」服务已启动: http://localhost:' + PORT);
    console.log('  管理后台: http://localhost:' + PORT + '/admin.html  ' + (admin && admin.hash ? '(密码已设置)' : '(首次使用，请先设置管理员密码)'));
    console.log('  DeepSeek Key: ' + (hasKey ? '已配置' : '未配置 —— 请到管理后台录入'));
});
