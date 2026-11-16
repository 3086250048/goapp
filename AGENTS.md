# AGENTS.md

给在本仓库工作的 AI Agent 看。**动手前请先读完「硬约束」和「产品决策」两节**——那里记录的是已经踩过坑、已经定稿的内容，不要重新发明。

## 这是什么

「出行规划 App」的可点击高保真原型：面向 1–6 人的小团体，像刷外卖一样刷出行方案（双列标签块瀑布流）→ 看详情（铁路站点式时间轴）→ 选日期人数 → 下单 → 拿每个站点一张核销二维码。

- **纯静态**：HTML + CSS + 原生 JS，无框架、无构建、无依赖。双击 `prototype/index.html` 就能跑。
- **无后端**：所有数据在浏览器 `sessionStorage`（key `trip_proto_v1`），刷新不丢，关标签页清空。
- **是原型不是产品**：封面是渐变+emoji，二维码是按凭证码生成的占位图案（扫不出内容），地图是 CSS 画的，支付是 1.4 秒假支付。

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

- `tools/serve.py` 带 `Cache-Control: no-store`。**不要换成 `python -m http.server`**，那个会缓存，改完代码刷新看不到效果（之前为此排查了很久）。
- `probe.js` / `diag*.js` / `shot.js` 走 Chrome DevTools Protocol，脚本里**硬编码了 Windows 的 Chrome 路径**。在 Linux 上跑需要改 `CHROME` 常量（如 `/usr/bin/google-chrome`），并且要有本地服务。

## 目录

```
prototype/              要部署的全部静态文件
├── index.html          入口：设备外框、PWA meta、SW 注册（仅 https）
├── styles.css          设计令牌 + 全部页面样式（:root 里是颜色/圆角）
├── data.js             TAXONOMY（画像枚举）+ TRIPS（16 条行程 mock）
├── app.js              路由 + 状态 + 11 个页面 + 价格/二维码（约 1400 行）
├── sw.js               离线缓存，网络优先
├── manifest.webmanifest
└── icons/              192/512/maskable/apple-touch

deploy/                 部署配置与手册（Caddyfile、nginx、上传脚本、README）
tools/                  自检 / 回归 / 截图 / 图标 / 静态服务
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
| `#/register` | ① 注册（手机号/微信/QQ） |
| `#/profile` | ② 用户画像（仅注册流使用） |
| `#/address?from=onboarding\|home\|me` | ③ 生活地址（CSS 假地图 + 选点） |
| `#/home` | 首页双列瀑布流 |
| `#/detail/:tripId` | 目的地详情（日期/人数/时间轴） |
| `#/checkout/:tripId` | 确认订单 |
| `#/success/:orderId` | 下单成功 + 凭证 |
| `#/me` | 个人信息 |
| `#/edit/hobby\|personality\|occupation\|gender\|nickname` | **单项编辑**（只显示该字段） |
| `#/orders?tab=all\|unused\|done\|refund` | 订单列表 |
| `#/order/:orderId` | 订单详情 |

## 硬约束

破坏任何一条都会让线上出问题：

1. **不要引入构建步骤或 npm 依赖。** 这是纯静态站，`index.html` 直接双击也要能跑。
2. **不要删 `bootGuard()` 和全局 `window.onerror` 横幅。** 之前 `data.js` 加载失败时，注册按钮点了没反应、页面静默卡死，排查了很久。现在失败会显示「数据没加载出来」。
3. **不要只依赖 `hashchange`。** 路由有 250ms 轮询兜底（某些内嵌 WebView 不派发该事件），并且 `render()` 开头有 `if (bootFailed) return;` 闸门——否则轮询会把启动错误页冲掉。改路由时必须保住这两处。
4. **Service Worker 只在 https 下注册。** 改 `sw.js` 要同步升 `VERSION`，否则老客户端会一直用旧缓存。
5. **页面跳转统一用 `data-nav` / `data-back`**，由 document 上的委托处理；不要在 HTML 里写 `onclick="location.hash=..."`（动态插入的卡片会绑不上）。
6. **每次改 UI 都要升 `APP_VER`**（注册页底部、个人信息页脚都显示版本号），这是和用户核对"是不是新版"的唯一手段。
7. `.shots/` 已在 `.gitignore`；**不要提交截图**。
8. **不要提交 `.env` 或任何密钥**（`DEEPSEEK_API_KEY`、支付密钥、高德 Key）。

## 产品决策（已定稿，不要重新讨论）

| 主题 | 结论 |
|---|---|
| 人群 | 1–6 人，默认 2 人；超过 6 人提示联系客服 |
| 首页布局 | **双列等高**瀑布流（不做错落），封面 4:3，列间距 10，分页 8 条 |
| 首页信息 | 卡片只展示：封面、总结标题（≤18 字，须含"玩/食"词）、类型徽标、距离、站数、时长、人均价 |
| 定价 | 支持 `perPerson` / `perGroup` / `included`；4 人 9 折、5 人 85 折；周末档期 +50/人 |
| 出行日期 | **单一日期，不做多日行程**；可约窗口 14 天；售罄日期不可选 |
| 凭证 | **一站点一码**，N 站 = N 张；全单同一有效期（= 出行当天） |
| 订单状态 | 订单状态是凭证状态的聚合：`paid` / `partially_used` / `completed` / `expired` |
| 注册 | **强制绑定手机号**；画像顺序 爱好→性格→职业→性别；爱好必填 ≥1 且 ≤5；性格 ≤3 |
| 地址 | 允许多条、上限 5、默认地址唯一；从个人信息进地址页，确认后要回到个人信息 |
| 个人信息编辑 | 4 行画像**各自独立编辑页**（`#/edit/<field>`），**不要**跳回注册用的完整画像页 |
| 导航 | 返回走返回栈 `goBack()`，不要写死目标页；个人信息页必须有返回入口 |
| 个人中心 | 三宫格（待使用/已使用/已过期）+ 最近一单 + 「全部 ›」进独立订单列表页 |

## 视觉令牌

| 项 | 值 |
|---|---|
| 主色 | `#FF6B2C`（按压 `#E85A1E`，淡底 `#FFF3ED`，线 `#FFE1D2`） |
| 文字 | 主 `#1F2329` / 次 `#646A73` / 弱 `#8F959E` |
| 分割线 | `#EBEDF0` |
| 页面底 | `#F5F6F8` |
| 圆角 | 标签 10 / 卡片 14 / 输入 12 / 主按钮 25（全圆） |
| 字号 | H1 24 / H2 17 / 正文 15 / 辅助 13 / 微 11 |
| 触控热区 | ≥ 44×44 |
| 底部栏 | 高 64 + 安全区，`position: absolute` |

页面内容区若有固定底栏，`ScrollView` 的 `paddingBottom` 必须 ≥ 栏高 + 24，否则最后一屏被遮。

## 新增一个页面

1. 写一个 Screen 对象：`{ theme, render(id, params), mount(id, params) }`
   - `render` 返回字符串，必须以 `<div class="screen">` 开头（沉浸式页面加 `immersive` 类，自管状态栏留白）
   - `mount` 里用 `const root = $('.screen', appEl)` 取作用域，事件绑在 `root` 上（`appEl` 不会重建，绑它会导致监听器累积）
2. 加进 `ROUTES`
3. 返回按钮用 `data-back="<兜底页>"`
4. `node tools/check.js` 确认渲染无异常、mount 引用的 id 都存在
5. 升 `APP_VER`

## 改价格 / 算钱

只有两处真源：`tripStats(trip, people)` 和 `stopSubtotal(stop, people)`。

**结算页的明细必须和合计对得上**——逐站小计是折扣前的原价，所以要额外渲染「N 人同行折扣 −¥X」和「周末档期溢价 +¥X」两行。之前漏了，导致 180+420+380 ≠ 882。改完自己加一遍。

## 验收标准

改完必须全绿：

```bash
node tools/check.js     # 10 个页面渲染 + 事件绑定 id 存在性 + 导航目标 + 价格模型
node tools/probe.js     # 无限加载 / 人数改价 / 支付跳转 / 凭证数量（需服务在 4321）
node tools/diag5.js     # 首页↔个人信息↔订单 的返回栈
node tools/diag6.js     # 单项编辑：只显示该字段、保存后回个人信息
node tools/shot.js      # 改了 UI 就出一版截图自查
```

`check.js` 不需要浏览器；后四个需要 `python tools/serve.py` 在跑，且本机有 Chrome。

## 部署

静态站，看 [deploy/README.md](deploy/README.md)。

- 服务器 `git clone` 后，nginx `root` 直接指向 `prototype/`，`git pull` 即上线
- 上 HTTPS（Caddy 自动证书）后手机可「添加到主屏幕」当 App 用
- **必须加访问口令**：原型无鉴权，挂公网等于公开

## 常见坑

| 现象 | 原因 |
|---|---|
| 改了代码刷新没变化 | 开了 SW 缓存（https 下）→ 改 `sw.js` 的 `VERSION`；或浏览器缓存 → 强刷 |
| 点按钮没反应 | `data.js` 没加载 → 看页面底部有没有红色横幅；或 `hashchange` 没触发 → 确认轮询仍在 |
| 点进页面出不来 | 新页面漏了返回按钮（`data-back`） |
| 卡片高度不齐 | 标题必须固定 2 行高（`height: 40px` + `-webkit-line-clamp:2`），别改成自适应 |
| 二维码单页体积暴涨 | `qrSvg` 退回成逐格 `<rect>` 了，要用按行合并的 `<path>` |
| 深色状态栏 | 只有 `theme: 'dark'` 的页面（详情页）才有白色状态栏文字 |
