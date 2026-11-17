# 出行 App · 可部署 MVP

面向个人 / 小团体（1–6 人）的出行规划 App —— 像刷外卖一样刷行程方案，一键下单。
本目录包含移动端 PWA、Python API 与 SQLite 数据库，可直接构建成单容器部署。

## 文档地图

| 文档 | 内容 |
|---|---|
| [AGENTS.md](AGENTS.md) | **产品说明书**：定位、用户旅程、页面职责、业务规则、内容规范、设计语言、已定稿决策 |
| [docs/ENGINEERING.md](docs/ENGINEERING.md) | 工程实现：代码地图、数据模型、命令、测试与常见坑 |
| [deploy/README.md](deploy/README.md) | Docker、HTTPS、域名、备份、生产环境变量与上线检查 |

## 本地运行

推荐用 Docker（自动创建持久化数据库卷）：

```bash
docker compose up -d --build
```

打开 `http://127.0.0.1:18080/`。体验版验证码固定为 `123456`，也可以在注册页点“先随便看看”创建独立体验账号。

不用 Docker 时：

```bash
python3 -m pip install -r server/requirements.txt
DEMO_MODE=1 DEMO_OTP=123456 PORT=18080 python3 server/app.py
```

生产环境不能双击 `prototype/index.html`：登录、画像、地址、订单和凭证依赖同域 API。

### 如果打不开或点了没反应

1. 强制刷新：`Ctrl + Shift + R`（Mac 是 `Cmd + Shift + R`）。
2. 页面若出现红色横幅，把上面的文字和版本号发回来。
3. 想跳过注册直接看：点注册页底部“先随便看看”，或访问 `?demo=1#/home`。

## 60 秒体验路线

| 步骤 | 操作 | 看点 |
|---|---|---|
| 1 | 输入任意 11 位手机号 →「获取验证码」→ 登录 | 服务端验证码、30 天会话、协议勾选 |
| 2 | 画像页选爱好/性格/职业/性别 | 多选上限、计数、昵称骰子、保存到数据库 |
| 3 | 地图页选地址 → 确认 | 中心针、附近 POI、默认地址持久化 |
| 4 | 首页下滑 | 双列瀑布流、骨架屏、触底加载 16 条方案 |
| 5 | 点卡片 → 详情 | 日期横条、周末溢价、售罄、人数步进改价 |
| 6 | 立即下单 → 确认支付 | 服务端复核价格、创建订单与逐站凭证 |
| 7 | 下单成功页 | 每站一张真实可扫描二维码 + 8 位核销码 |
| 8 | 点头像 → 个人信息 → 订单 | 画像、地址、订单状态全部从 SQLite 恢复 |

跳过注册直接看：

`http://127.0.0.1:18080/?demo=1#/home`

每个体验链接会创建独立的服务端体验账号，带一条默认地址、一笔待使用订单和一笔历史订单。

## 路由

| Hash | 页面 |
|---|---|
| `#/register` | ① 注册 |
| `#/profile` | ② 用户画像 |
| `#/address` | ③ 生活地址（地图选点占位） |
| `#/home` | 首页双列瀑布流 |
| `#/detail/:tripId` | 目的地详情（时间轴 / 日期 / 人数） |
| `#/checkout/:tripId` | 确认订单 |
| `#/success/:orderId` | 下单成功 + 凭证 |
| `#/me` | 个人信息 |
| `#/orders` | 订单列表 |
| `#/order/:orderId` | 订单详情 |

## 已实现 / 未实现

**已实现**

- 手机号验证码登录、HttpOnly 服务端会话、退出登录
- 画像、地址、订单、凭证的 SQLite 持久化
- 双列瀑布流、骨架屏、无限加载
- 服务端权威价格：每人价 / 整团价 / 4 人 9 折 / 5 人 85 折 / 周末溢价
- 日期档期、售罄校验、人数 1–6 步进
- 下单与逐站凭证发放（N 站 = N 张二维码）
- 订单状态由凭证聚合：待使用 / 使用中 / 已完成 / 已过期
- PWA manifest、图标与 Service Worker 离线外壳

**未实现**

- 真实图片：封面仍为渐变 + emoji 占位
- 高德 API：地图、定位和 POI 为示意数据
- 微信 / 支付宝真实支付：订单由服务端创建，但尚未接支付渠道回调
- 短信服务商：默认使用固定体验验证码；上线真实用户前应关闭 `DEMO_MODE`
- 开发者投放后台、退款审核流、分享/收藏/评价

## 目录

```text
prototype/          PWA 静态前端
server/app.py       API、SQLite 迁移、会话、订单与二维码
server/seed.json    从 data.js 导出的服务端权威行程内容
tools/check.js      无浏览器渲染自检
tools/api-smoke.py  已部署服务的 HTTP 全链路自检
tools/browser-smoke.js 真实 Chromium 首页/下单/二维码回归
tools/probe.js      CDP 交互回归（需要 Chromium）
Dockerfile          单容器生产镜像
compose.yaml        本地/单机部署编排与数据卷
deploy/deploy.sh    一键部署、更新与 HTTPS 验收入口
deploy/deploy.ps1   Windows / WSL 入口
android/            原生 Android WebView 壳与 APK 构建脚本
admin/              管理后台静态页面
```

## 部署

从开发机迁移或更新远端服务器：

```bash
./deploy/deploy.sh --remote root@203.0.113.10 \
  --domain trip.example.com
```

迁移已有数据时追加 `--restore-file ./goapp-backup.sqlite3`。脚本会安装 Docker、拉取最新代码、生成 `.env`、启动 SQLite 数据卷、按需导入备份、可选启用 Caddy HTTPS，并验证健康检查。重复执行同一条命令即为更新。Windows 使用 `.\deploy\deploy.ps1`，或在 WSL 中运行同一 Bash 命令。

只在服务器本地启动、不配公网域名：

```bash
sudo ./deploy/deploy.sh
```

域名、HTTPS、反向代理、数据备份和生产环境变量见 [deploy/README.md](deploy/README.md)。

## Android APK

```bash
APP_URL=https://你的域名/ ./android/build-apk.sh
```

不传 `APP_URL` 时优先读取 `.env` 的 `DOMAIN`。产物为 `dist/goapp-v<版本>.apk`，最低支持 Android 6.0，需要联网访问后端。

## 管理后台

访问 `/admin/`，使用部署时生成的 `ADMIN_USERNAME` 与 `ADMIN_PASSWORD` 登录。首次一键部署会自动生成密码并写入权限为 600 的 `.env`：

```bash
grep '^ADMIN_' .env
```

后台支持：

- 数据概览：用户、订单、交易额、凭证和标签状态
- 首页项目：搜索、新增、编辑、上下线、排序、删除，并结构化维护站点与消费项
- 用户管理：搜索、新增、编辑画像、删除及级联清理订单凭证
- 标签管理：四类标签增删改查、启停、排序和引用数量
- 订单查询：按状态、订单号、用户或行程筛选并查看逐站凭证
- 操作日志：记录管理员登录及所有用户、标签写操作

首页项目与标签修改直接写入 SQLite，用户端下一次启动会读取最新内容，无需重新部署。

## 自检

```bash
node tools/check.js
BASE_URL=http://127.0.0.1:18080 python3 tools/api-smoke.py
node tools/browser-smoke.js   # 需先启动 CDP_URL 指向的 Chromium
./tools/check-deploy.sh
ADMIN_PASSWORD="$(sed -n 's/^ADMIN_PASSWORD=//p' .env)" python3 tools/admin-api-smoke.py
```

`check.js` 覆盖页面渲染、事件绑定、导航和价格模型；`api-smoke.py` 覆盖静态站、体验会话、下单、二维码、持久化和退出登录；`browser-smoke.js` 覆盖真实浏览器里的首页、下单和凭证渲染。
