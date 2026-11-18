# 一键行万里 · 中国大陆旅行轨迹生成器

> **One-Click Journey** — generate your China travel plan & map trajectory with one click.

输入目的地 + 天数 → AI 生成多日行程 → 腾讯地图轨迹 + 真实里程。

**架构**：前端（index.html）+ 后端（server.js，零依赖）+ 管理后台（admin.html）
**Key 安全**：DeepSeek API Key 只存在服务器 `data/deepseek_key.json`，前端代码和用户浏览器里都没有，用户无需也看不到 Key。

---

## English

**One-Click Journey** is a minimalist AI travel planner for mainland China. Enter a destination and the number of days — DeepSeek generates a multi-day itinerary (with spot highlights, descriptions and tips), and the journey is drawn as a trajectory on Tencent Maps with real driving mileage for each day.

### Features

- 🤖 **AI itinerary** — DeepSeek generates a day-by-day plan: spots, intro, tips
- 🗺️ **Map trajectory** — spots connected on a Tencent Map, day by day
- 🛣️ **Real mileage** — driving distance between spots via Tencent Map routing (auto fallback to great-circle × 1.3)
- 🔑 **Key stays server-side** — your DeepSeek API key is configured once in the admin panel and never reaches the browser
- 🧩 **Zero dependencies** — backend is a single Node.js file (`server.js`), no `npm install`

### Quick start

```bash
git clone https://github.com/daibenhui2005-ux/one-click-journey.git
cd one-click-journey
node server.js          # http://localhost:8787
```

Open `http://localhost:8787/admin.html`, set the admin password, paste your DeepSeek API key — done. See the Chinese sections below for full deployment (systemd + Nginx) details.

> This project targets **mainland China travel** and uses Tencent Map services, so it is documented in Chinese.

---

## 一、文件结构

```
.
├── index.html          前端页面（用户端）
├── admin.html          管理后台（只有你知道地址）
├── server.js           后端服务（静态托管 + 生成接口 + 管理接口）
├── cities.json         中国大陆城市名录（371 条，前端校验/补全 + 服务端校验共用）
├── bg/                 页头背景图
├── data/               运行时自动生成，存 Key 与管理员密码哈希（勿提交 Git）
└── .gitignore
```

---

## 二、本地运行

```bash
cd 项目目录
node server.js          # 默认 8787 端口，可用 PORT=9000 node server.js 改端口
```

打开：

| 地址 | 用途 |
|---|---|
| http://localhost:8787 | 用户端页面 |
| http://localhost:8787/admin.html | **管理后台（录入 Key）** |

### 首次使用三步

1. 打开 `/admin.html` → 设置管理员密码（至少 6 位，这是你自己记的密码，不是 DeepSeek 的）
2. 登录后粘贴 DeepSeek API Key（`sk-` 开头）→ 点「保存 Key」
3. 回到首页输入目的地和天数 → 点「✨ 生成旅行计划」，直接可用

> 之后换 Key：随时登录后台粘贴新 Key 覆盖即可，用户端零感知、无需改代码。

---

## 三、部署到服务器（腾讯云 Ubuntu）

### 1. 上传文件

```bash
# 本地执行（data/ 不要传，服务器上会自动生成）
scp -r index.html admin.html server.js bg ubuntu@你的服务器IP:/var/www/yjxl/
```

### 2. 用 systemd 常驻

```bash
sudo tee /etc/systemd/system/yjxl.service > /dev/null <<'EOF'
[Unit]
Description=YiJianXingWanLi
After=network.target

[Service]
Type=simple
WorkingDirectory=/var/www/yjxl
ExecStart=/usr/bin/node server.js
Environment=PORT=8787
Restart=always
RestartSec=3
User=www-data

[Install]
WantedBy=multi-user.target
EOF

sudo mkdir -p /var/www/yjxl/data
sudo chown -R www-data:www-data /var/www/yjxl
sudo systemctl daemon-reload && sudo systemctl enable --now yjxl
sudo systemctl status yjxl --no-pager
```

### 3. Nginx 反向代理（复用现有 80/443）

```nginx
server {
    listen 80;
    server_name your-domain.com;      # 没有域名就用服务器 IP

    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;      # AI 生成较慢，超时要放宽
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

### 4. 上线后

访问 `http://你的域名/admin.html` 设置密码、录入 Key，即可对外使用。

---

## 四、目的地校验规则

目的地不是「随便填」，前后端用同一份 371 条城市名录双重校验。**名录已内嵌进 index.html**，因此即使没有后端（静态预览 / 纯静态托管）校验同样生效；`/api/cities` 只是用来在服务端更新名录后覆盖内置版本。

| 输入 | 结果 | 说明 |
|---|---|---|
| 西安 / 成都 / 大理 | ✅ 通过 | 城市正式名 |
| 西安市 / 成都市 | ✅ 通过 | 自动去掉「市 / 地区 / 盟 / 县」后缀 |
| 西双版纳傣族自治州 / 恩施土家族苗族自治州 | ✅ 通过 | 自动去掉「民族名 + 自治州」 |
| 丽江古城 / 平遥古城 | ✅ 通过 | 城市名 + 合法后缀（古城/古镇/景区/风景区/旅游区/度假区/新区…） |
| 敦煌 / 婺源 / 凤凰 / 都江堰 | ✅ 通过 | 热门县级旅游目的地已收录 |
| **成都敷 / 火星 / 火星市** | ❌ 「请输入正确的城市名」 | 错字、虚构城市一律拦截（不允许前缀蒙混） |
| 南京路 / 中山公园 / 西安兵马俑 | ❌ 同上 | 前缀命中城市但不是城市名 |
| **西藏 / 云南 / 四川 / 内蒙 / 广西** | ❌ 「「西藏」是省级行政区，请选择具体城市」+ **可点击城市胶囊** | 不笼统报错：识别 27 个省级行政区，给出该省热门城市（如 拉萨/林芝/日喀则/阿里），点一下即填入 |
| 香港 / 澳门 / 台湾 | ❌ 「暂仅支持中国大陆目的地」 | 合规要求 |

交互行为：输入框**失焦即校验**（红框 + 输入框下方红字提示）、**输入时即时清除错误**、**提交时再拦一次**且不发起请求；输入框带 **datalist 自动补全**（浏览器原生下拉候选）。服务端 `/api/generate` 也做同样校验，防止绕过前端直接调接口。

---

## 五、安全设计

| 措施 | 说明 |
|---|---|
| Key 不下发 | 前端只调 `/api/generate`，请求体只有 `{city, days}`，拿不到 Key |
| Key 文件保护 | 存 `data/deepseek_key.json`，权限 600，且 `data/` 已进 `.gitignore` |
| 管理后台鉴权 | 密码经 SHA-256 存哈希；登录换 HMAC 签名 Token（12 小时有效），放 sessionStorage |
| 防暴力破解 | 首次设置后 `/api/admin/setup` 永久失效，别人无法重置你的密码 |
| 防滥用 | `/api/generate` 按 IP 限流 10 次/分钟 |
| 静态白名单 | 只对外暴露 `index.html`、`admin.html`、`bg/`，`data/`、`server.js` 一律 404 |
| 错误脱敏 | 后端把 DeepSeek 的原始报错转成中文提示，不向前端泄漏细节 |

> 建议：`admin.html` 若想更隐蔽，可在 Nginx 层加 `allow/deny` 只允许你的 IP 访问。

---

## 六、接口一览（自用参考）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/generate` | 生成行程，body `{city, days}`，返回行程 JSON |
| GET | `/api/cities` | 城市名录（前端校验与输入补全用） |
| POST | `/api/admin/setup` | 首次设置管理员密码，body `{password}` |
| POST | `/api/admin/login` | 登录，body `{password}` → `{token}` |
| GET | `/api/admin/status` | 查 Key 配置状态（需 Bearer token） |
| POST | `/api/admin/key` | 保存 Key，body `{key}`（需 Bearer token） |
| GET | `/api/health` | 健康检查 |
