# 工程实现说明

本文件只管**代码怎么跑、怎么改、怎么验收**。产品的定位、页面职责、业务规则、设计语言见 [AGENTS.md](../AGENTS.md)——那份是产品的事实来源，本文件是它的实现。

## 这是什么（技术视角）

纯静态单页应用：HTML + CSS + 原生 JS，**无框架、无构建、无依赖**。双击 `prototype/index.html` 就能跑。

- 数据全在浏览器 `sessionStorage`（key `trip_proto_v1`），无后端
- 部分内容是假的：封面渐变+emoji、二维码是占位图案（扫不出内容）、地图是 CSS 画的、支付是 1.4 秒假支付
- 11 条路由、11 个 Screen 对象、1388 行 `app.js`

## 快速开始

| 目的 | 命令 |
|---|---|
| 本地预览（**推荐**） | `python tools/serve.py` → http://127.0.0.1:4321/ |
| 渲染自检（无需浏览器） | `node tools/check.js` |
| 交互回归（需服务在跑） | `node tools/probe.js` |
| 导航回归 | `node tools/diag5.js` |
| 单项编辑回归 | `node tools/diag6.js` |
| 截图（390×844 @2x） | `node tools/shot.js` → `.shots/` |
| 重生成 PWA 图标 | `python tools/make_icons.py`（需 Pillow） |
| 一键部署到服务器 | `.\deploy\upload.ps1 -Server <IP>` |

两点注意：

- `tools/serve.py` 带 `Cache-Control: no-store`。**不要换成 `python -m http.server`**，那个会缓存，改完代码刷新看不到效果。
- `probe.js` / `diag*.js` / `shot.js` 走 Chrome DevTools Protocol，脚本里**硬编码了 Windows 的 Chrome 路径**。在 Linux 上跑要改 `CHROME` 常量（如 `/usr/bin/google-chrome`），并且要有本地服务在 4321。

## 目录

```
prototype/              要部署的全部静态文件
├── index.html          入口：设备外框、PWA meta、SW 注册（仅 https）
├── styles.css          设计令牌 + 全部页面样式（:root 里是颜色/圆角）
├── data.js             TAXONOMY（画像枚举）+ TRIPS（16 条行程 mock）
├── app.js              路由 + 状态 + 11 个页面 + 价格/二维码
├── sw.js               离线缓存，网络优先
├── manifest.webmanifest
└── icons/              192/512/maskable/apple-touch

deploy/                 部署配置与手册（Caddyfile、nginx、上传脚本、README）
tools/                  自检 / 回归 / 截图 / 图标 / 静态服务
docs/                   文档
```

## 代码地图（prototype/app.js）

按这个顺序读，别从头翻：

1. `APP_VER` + `window.onerror` 错误横幅
2. 基础工具：`$` `$$` `esc` `toast` `fmt` `yuan` `pad2`
3. 状态：`blankState()` → `S` → `save()`
4. 业务计算：`tripStats()`（总价/人均/折扣）、`stopSubtotal()`、`labelOf()`、`dateKey/dateLabel/dateShort`
5. 订单：`createOrder()`、`ensureSeed()`（预置一条历史已完成订单）
6. 二维码占位：`qrGrid()` / `qrSvg()`（按行合并的 path，别退回逐格 rect，会让单页从 18KB 涨到 58KB）
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

1. **不要引入构建步骤或 npm 依赖。** 纯静态站，`index.html` 直接双击也要能跑。
2. **不要删 `bootGuard()` 和全局 `window.onerror` 横幅。** 之前 `data.js` 加载失败时，注册按钮点了没反应、页面静默卡死。
3. **不要只依赖 `hashchange`。** 路由有 250ms 轮询兜底（某些内嵌 WebView 不派发该事件），`render()` 开头有 `if (bootFailed) return;` 闸门——否则轮询会把启动错误页冲掉。
4. **Service Worker 只在 https 下注册。** 改 `sw.js` 要同步升 `VERSION`。
5. **跳转统一用 `data-nav` / `data-back`**（document 上的委托），不要写 `onclick="location.hash=..."`，动态插入的卡片会绑不上。
6. **每次改 UI 都要升 `APP_VER`**（注册页底部、个人信息页脚都显示），这是核对"是不是新版"的唯一手段。
7. `.shots/` 已在 `.gitignore`；不要提交截图。
8. **不要提交 `.env` 或任何密钥。**
9. **每次改动必须提交并同步到远端。** 仓库带 `post-commit` 钩子自动 push；每个新克隆执行一次 `git config core.hooksPath tools/githooks`（Windows 上跑 `.\tools\install-hooks.ps1`）。

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

静态站，见 [deploy/README.md](../deploy/README.md)。

- 服务器 `git clone` 后，nginx `root` 指向 `prototype/`，`git pull` 即上线
- 上 HTTPS（Caddy 自动证书）后手机可「添加到主屏幕」当 App 用
- **必须加访问口令**：原型无鉴权，挂公网等于公开

## 常见坑

| 现象 | 原因 |
|---|---|
| 改了代码刷新没变化 | SW 缓存（https 下）→ 升 `sw.js` 的 `VERSION`；或浏览器缓存 → 强刷 |
| 点按钮没反应 | `data.js` 没加载 → 看页面底部红色横幅；或 `hashchange` 没触发 → 确认轮询仍在 |
| 点进页面出不来 | 新页面漏了返回按钮（`data-back`） |
| 卡片高度不齐 | 标题必须固定 2 行高（`height:40px` + `-webkit-line-clamp:2`） |
| 二维码单页体积暴涨 | `qrSvg` 退回逐格 `<rect>` 了，要用按行合并的 `<path>` |
| 状态栏文字看不清 | 只有 `theme:'dark'` 的页面（详情页）才是白色状态栏 |
