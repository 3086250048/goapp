# 工程实现说明

本文件只管**代码怎么跑、怎么改、怎么验收**。产品的定位、页面职责、业务规则、设计语言见 [AGENTS.md](../AGENTS.md)——那份是产品的事实来源，本文件是它的实现。

## 这是什么（技术视角）

移动端 PWA + Python API + SQLite 的单容器应用：

- `prototype/` 是 HTML + CSS + 原生 JS 前端，无框架、无前端构建
- `server/app.py` 同时输出静态文件与 `/api/*`
- 用户、会话、画像、地址、订单、凭证和行程内容保存在 SQLite
- 订单金额由服务端按权威行程重新计算；凭证二维码由服务端生成
- 封面渐变+emoji、地图/POI、支付渠道仍是演示实现

账号会话使用 HttpOnly Cookie。刷新页面后通过 `GET /api/bootstrap` 恢复当前用户、默认地址和订单列表。

## 快速开始

| 目的 | 命令 |
|---|---|
| 本地完整运行（**推荐**） | `docker compose up -d --build` → http://127.0.0.1:18080/ |
| 本地非 Docker 运行 | `pip install -r server/requirements.txt && DEMO_MODE=1 python server/app.py` |
| 渲染自检（无需浏览器） | `node tools/check.js` |
| 已部署服务全链路测试 | `BASE_URL=http://127.0.0.1:18080 python3 tools/api-smoke.py` |
| 真实浏览器端到端测试 | 启动 CDP 后 `BASE_URL=http://127.0.0.1:18080 node tools/browser-smoke.js` |
| 交互回归（需 Chromium） | `node tools/probe.js` |
| 导航回归 | `node tools/diag5.js` |
| 单项编辑回归 | `node tools/diag6.js` |
| 截图（390×844 @2x） | `node tools/shot.js` → `.shots/` |
| 重生成 PWA 图标 | `python tools/make_icons.py`（需 Pillow） |
| 重生成服务端种子 | `node tools/export-seed.js` |
| 一键部署 / 更新 | `./deploy/deploy.sh --remote user@host --domain trip.example.com` |
| 部署配置自检 | `./tools/check-deploy.sh` |
| 构建 Android APK | `APP_URL=https://trip.example.com/ ./android/build-apk.sh` |
| 管理后台 API 回归 | `ADMIN_PASSWORD=... python3 tools/admin-api-smoke.py` |
| 管理后台浏览器回归 | `ADMIN_PASSWORD=... node tools/admin-smoke.js` |

两点注意：

- `tools/serve.py` 带 `Cache-Control: no-store`。**不要换成 `python -m http.server`**，那个会缓存，改完代码刷新看不到效果。
- `probe.js` / `diag*.js` / `shot.js` 走 Chrome DevTools Protocol。可用 `CHROME_PATH` 指定浏览器，用 `BASE_URL` 指定站点；默认站点是 http://127.0.0.1:18080/。

## 目录

```
prototype/              前端 PWA
├── index.html          入口：设备外框、PWA meta、SW 注册（仅 https）
├── styles.css          设计令牌 + 全部页面样式（:root 里是颜色/圆角）
├── data.js             TAXONOMY（画像枚举）+ TRIPS（16 条行程 mock）
├── app.js              路由 + 状态 + 11 个页面 + 价格/二维码
├── sw.js               离线缓存，网络优先
├── manifest.webmanifest
└── icons/              192/512/maskable/apple-touch

admin/
├── index.html          管理后台登录与主布局
├── admin.css           后台桌面/移动端样式
└── admin.js            仪表盘、用户、标签、订单与审计页面

server/
├── app.py              API、SQLite、会话、订单、真实二维码
├── seed.json           服务端权威画像与行程内容
└── requirements.txt    仅 segno 一个运行依赖

deploy/                 一键部署脚本、Caddy 配置与运维手册
tools/                  自检 / HTTP 探针 / 回归 / 图标 / 种子导出
Dockerfile              生产镜像
compose.yaml            单机编排与持久化数据卷
android/                原生 WebView 壳、资源、Manifest 与无 Gradle APK 构建脚本
docs/                   文档
```

Android 包使用 `aapt2 + javac + dx + apksigner` 构建，不依赖 Gradle。APK 与本地签名密钥分别写入 `dist/`、`.android-keys/`，两者都不入库。签名密钥一旦用于发布必须长期保留，否则新包无法覆盖安装。

## 服务端数据模型

| 表 | 用途 |
|---|---|
| `trips` | 服务端权威首页项目；首次从 `server/seed.json` 导入，之后由管理后台维护 |
| `users` | 手机号、昵称和四类画像 |
| `sessions` | 只存会话 token 的 SHA-256 哈希，30 天过期 |
| `otp_challenges` | 验证码哈希、过期时间与尝试次数 |
| `addresses` | 每用户最多 5 条地址，恰好一条默认地址 |
| `orders` | 目的地、出行日期、人数、服务端结算金额、地址快照 |
| `vouchers` | 每站一张，独立二维码内容与 8 位核销码 |
| `taxonomy_tags` | 四类可配置标签；启用状态与排序直接影响用户端画像页 |
| `admin_sessions` | 管理员独立 12 小时会话，只保存 token 哈希 |
| `admin_audit` | 管理员登录及用户/标签写操作审计 |

订单表不保存独立的“部分核销”字段。读取时按凭证状态和出行日期聚合为 `paid / partially_used / completed / expired`。

## API

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/bootstrap` | 目录 + 当前用户完整状态 |
| `POST` | `/api/auth/request-code` | 创建验证码 challenge |
| `POST` | `/api/auth/verify` | 验证并建立 Cookie 会话 |
| `POST` | `/api/auth/demo` | 创建独立体验账号（仅 `DEMO_MODE=1`） |
| `POST` | `/api/auth/logout` | 撤销会话 |
| `PATCH` | `/api/profile` | 保存画像与昵称 |
| `PATCH` | `/api/nickname` | 仅保存昵称 |
| `POST` | `/api/addresses` | 新增地址 |
| `POST` | `/api/orders` | 服务端复核并创建订单与逐站凭证 |
| `GET` | `/api/vouchers/:id/qr.svg` | 当前用户有权限的真实二维码 |
| `POST` | `/api/admin/login` | 管理员登录，独立 HttpOnly Cookie |
| `GET` | `/api/admin/dashboard` | 后台统计与最近订单/用户 |
| `GET/POST` | `/api/admin/trips` | 首页项目分页搜索与新增 |
| `GET/PATCH/DELETE` | `/api/admin/trips/:id` | 首页项目详情、编辑、上下线与删除 |
| `GET/POST` | `/api/admin/users` | 用户分页搜索与新增 |
| `GET/PATCH/DELETE` | `/api/admin/users/:id` | 用户详情、修改与级联删除 |
| `GET/POST` | `/api/admin/tags` | 标签列表与新增 |
| `PATCH/DELETE` | `/api/admin/tags/:id` | 标签修改、启停和删除；被引用时需 `force=1` |
| `GET` | `/api/admin/orders` | 订单分页、搜索与状态筛选 |
| `GET` | `/api/admin/orders/:id` | 订单详情与逐站凭证 |
| `GET` | `/api/admin/audit` | 操作审计分页 |

## 代码地图（prototype/app.js）

按这个顺序读，别从头翻：

1. `APP_VER` + `window.onerror` 错误横幅
2. 基础工具：`$` `$$` `esc` `toast` `fmt` `yuan` `pad2`
3. 状态：`blankState()` → `S` → `save()`
4. 业务计算：`tripStats()`（总价/人均/折扣）、`stopSubtotal()`、`labelOf()`、`dateKey/dateLabel/dateShort`
5. 订单：`createOrder()`、`ensureSeed()`（预置一条历史已完成订单）
6. 二维码：线上凭证使用服务端 `segno` 生成真实二维码；前端 `qrGrid()` / `qrSvg()` 只保留给无浏览器的本地渲染自检
7. 通用片段：`skeletonCard` `feedCardHtml` `voucherCardHtml` `orderCardHtml`
8. **11 个 Screen 对象**，每个形如 `{ theme: 'light'|'dark', render(id, params), mount(id, params) }`
9. `demoBootstrap()`：`?demo=1` 直接进入已登录状态
10. 路由：`ROUTES` → `parseHash()` → `render()` → `bootGuard()` → 启动

### 路由表

| Hash | 页面 |
|---|---|
| `#/register` | ① 注册 |
| `#/profile` | ② 用户画像（仅注册流使用） |
| `#/address?from=onboarding\|home\|me` | ③ 生活地址 |
| `#/home` | 首页双列瀑布流 |
| `#/detail/:tripId` | 目的地详情 |
| `#/checkout/:tripId` | 确认订单 |
| `#/success/:orderId` | 下单成功 + 凭证 |
| `#/me` | 个人信息 |
| `#/edit/hobby\|personality\|occupation\|gender\|nickname` | 单项编辑（只显示该字段） |
| `#/orders?tab=all\|unused\|done\|refund` | 订单列表 |
| `#/order/:orderId` | 订单详情 |

## 硬约束

破坏任何一条都会让线上出问题：

1. **前端不要引入构建步骤或 npm 依赖。** `prototype/` 仍是可直接托管的 HTML/CSS/JS；完整业务必须通过 API 运行。
2. **不要删 `bootGuard()` 和全局 `window.onerror` 横幅。** 之前 `data.js` 加载失败时，注册按钮点了没反应、页面静默卡死。
3. **不要只依赖 `hashchange`。** 路由有 250ms 轮询兜底（某些内嵌 WebView 不派发该事件），`render()` 开头有 `if (bootFailed) return;` 闸门——否则轮询会把启动错误页冲掉。
4. **Service Worker 只在 https 下注册。** 改 `sw.js` 要同步升 `VERSION`；`/api/*` 永远不能进入缓存。
5. **跳转统一用 `data-nav` / `data-back`**（document 上的委托），不要写 `onclick="location.hash=..."`，动态插入的卡片会绑不上。
6. **每次改 UI 都要升 `APP_VER`**（注册页底部、个人信息页脚都显示），这是核对"是不是新版"的唯一手段。
7. `.shots/` 已在 `.gitignore`；不要提交截图。
8. **不要提交 `.env` 或任何密钥。**
9. **每次改动必须提交并同步到远端。** 仓库带 `post-commit` 钩子自动 push；每个新克隆执行一次 `git config core.hooksPath tools/githooks`（Windows 上跑 `.\tools\install-hooks.ps1`）。
10. **部署组件与一键脚本必须同步。** 改 Dockerfile、Compose、服务名、端口、环境变量、数据卷、健康检查、启动命令或反向代理时，同一次提交必须更新 `deploy/deploy.sh` 并运行 `./tools/check-deploy.sh`。

## 新增一个页面

1. 写 Screen 对象：`{ theme, render(id, params), mount(id, params) }`
   - `render` 返回字符串，以 `<div class="screen">` 开头（沉浸式页面加 `immersive` 类）
   - `mount` 里用 `const root = $('.screen', appEl)`，事件绑在 `root` 上（绑 `appEl` 会累积监听器）
2. 加进 `ROUTES`
3. 返回按钮用 `data-back="<兜底页>"`
4. `node tools/check.js` 确认渲染无异常、mount 引用的 id 都存在
5. 升 `APP_VER`

## 改价格 / 算钱

只有两处真源：`tripStats(trip, people)` 和 `stopSubtotal(stop, people)`。

**结算页明细必须和合计对得上**——逐站小计是折扣前原价，所以要额外渲染「N 人同行折扣 −¥X」「周末档期溢价 +¥X」两行。之前漏了，导致 180+420+380 ≠ 882。

## 验收标准

```bash
node tools/check.js     # 10 个页面渲染 + 绑定 id 存在性 + 导航目标 + 价格模型
BASE_URL=http://127.0.0.1:18080 python3 tools/api-smoke.py
BASE_URL=http://127.0.0.1:18080 node tools/browser-smoke.js
node tools/probe.js     # 无限加载 / 人数改价 / 支付跳转 / 凭证数量（需服务在跑）
node tools/diag5.js     # 首页↔个人信息↔订单 的返回栈
node tools/diag6.js     # 单项编辑：只显示该字段、保存后回个人信息
node tools/shot.js      # 改了 UI 就出一版截图自查
```

`check.js` 不需要浏览器；后四个需要 `python tools/serve.py` 在跑，且本机有 Chrome。

## 同步到远端

仓库用 git hook 做**自动推送**，不要再手动攒一批再推。

**启用（每个克隆一次）**

```bash
git config core.hooksPath tools/githooks       # Linux / macOS / Git Bash
```

```powershell
.\tools\install-hooks.ps1                      # Windows
```

**效果**：每次 `git commit` 完成后，`tools/githooks/post-commit` 会自动执行 `git push origin <当前分支>`，成功打印 `✓ 已同步到 origin/master`。

**行为约定**

| 情况 | 行为 |
|---|---|
| 没有 `origin` | 跳过，不影响提交 |
| detached HEAD | 跳过 |
| 推送成功 | 绿色提示 |
| 推送失败（离线 / 非快进） | 黄色提示 + `git pull --rebase && git push`，**提交本身仍然成功** |
| 停用 | `git config --unset core.hooksPath` |

**注意**：钩子只看 `core.hooksPath`，`.git/hooks/` 里的旧钩子会被忽略。钩子脚本提交在仓库里，所以团队/服务器的行为一致——但**每台机器仍需执行一次启用命令**（这是本地配置，不随仓库同步）。

## 部署

见 [deploy/README.md](../deploy/README.md)。

```bash
./deploy/deploy.sh --remote user@host --domain trip.example.com
```

- 应用和 SQLite 同容器运行，数据在 `goapp_goapp-data` 命名卷
- 带域名时由 Compose `https` profile 启动 Caddy，反向代理到 `goapp:8080`
- 不带域名时只绑定 `127.0.0.1:18080`，可接已有 nginx
- `DEMO_MODE=1` 用于体验环境；接真实短信后设 `DEMO_MODE=0`
- 重建容器不会丢数据；禁止随意 `docker compose down -v`

## 常见坑

| 现象 | 原因 |
|---|---|
| 改了代码刷新没变化 | SW 缓存（https 下）→ 升 `sw.js` 的 `VERSION`；或浏览器缓存 → 强刷 |
| 点按钮没反应 | `data.js` 没加载 → 看页面底部红色横幅；或 `hashchange` 没触发 → 确认轮询仍在 |
| 点进页面出不来 | 新页面漏了返回按钮（`data-back`） |
| 卡片高度不齐 | 标题必须固定 2 行高（`height:40px` + `-webkit-line-clamp:2`） |
| 二维码 401 | 用户会话已失效；重新登录后凭证图片会随 Cookie 加载 |
| 状态栏文字看不清 | 只有 `theme:'dark'` 的页面（详情页）才是白色状态栏 |
