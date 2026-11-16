# 部署到公网 Linux 服务器

目标：把这个原型放到你的服务器上，手机能打开，并且可以「添加到主屏幕」当 App 用。

> ⚠️ 先说清楚：**这是前端原型**。数据存在手机浏览器本地（sessionStorage），不上传服务器、换设备就没了。它适合内部评审、给朋友演示、验证交互。要变成真产品，还需要第 6 节说的后端。

---

## 0. 你要准备什么

| 项 | 必需 | 说明 |
|---|---|---|
| 一台 Linux 服务器 | ✅ | Ubuntu 22.04 / Debian 12 最省事，1 核 1G 够用 |
| SSH 能登录 | ✅ | `ssh root@你的IP` |
| 一个域名 | 强烈建议 | 没有域名也能用 IP + 端口访问，但拿不到 HTTPS，手机上「添加到主屏幕」体验会差一截 |
| DNS 解析 | 有域名时 | 加一条 A 记录：`trip.你的域名.com → 服务器IP` |

> **为什么强烈建议上 HTTPS**：iOS 的「添加到主屏幕」在 http 下会退化成普通书签；后续接高德定位、剪贴板等功能，浏览器也要求安全上下文。域名 + Caddy 能自动搞定证书，不用碰 certbot。

---

## 1. 三条路线，先选一条

```
① 手机浏览器直接访问        最快，5 分钟        —— 适合自己看
② 浏览器「添加到主屏幕」     今天就能用          —— 有图标、全屏、离线可开，≈ App   ← 推荐
③ 打包成真的 APK / IPA     再花 1–2 天         —— Capacitor 套壳，或用 RN 重写
```

本文全部围绕 **②**。③ 的做法在第 6 节给出路径。

---

## 2. 方案 A：Caddy（推荐，自动 HTTPS）

### 2.1 服务器装 Caddy

```bash
sudo apt update
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy unzip rsync
```

### 2.2 建目录

```bash
sudo mkdir -p /var/www/trip
sudo chown -R $USER:$USER /var/www/trip
```

### 2.3 从 Windows 上传（在项目根目录执行）

```powershell
.\deploy\upload.ps1 -Server 你的服务器IP
```

脚本会打包 `prototype/` → scp → 远程解压 → `rsync --delete` 到 `/var/www/trip`。
如果 sudo 需要密码，把脚本里的 `ssh ... $remoteCmd` 改成手动执行等价命令即可。

### 2.4 配 Caddy

```bash
sudo nano /etc/caddy/Caddyfile
```

把 `deploy/Caddyfile` 的内容粘进去，把 `trip.example.com` 改成你的域名。

```bash
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
```

Caddy 会自动向 Let's Encrypt 申请证书（首次约 10 秒）。访问 `https://你的域名` 应该直接打开原型。

---

## 3. 方案 B：nginx + certbot（已有 nginx 时用）

```bash
sudo apt install -y nginx certbot python3-certbot-nginx unzip rsync

# 先放站点配置（改成你的域名）
sudo cp deploy/nginx-trip.conf /etc/nginx/sites-available/trip
sudo ln -sf /etc/nginx/sites-available/trip /etc/nginx/sites-enabled/trip
sudo rm -f /etc/nginx/sites-enabled/default

# 先只放行 80 端口跑起来，再申请证书
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d 你的域名.com
```

上传仍是：

```powershell
.\deploy\upload.ps1 -Server 你的服务器IP -User ubuntu
```

---

## 4. 手机上打开 + 添加到主屏幕

### iOS（Safari，必须用 Safari）

1. Safari 打开 `https://你的域名`
2. 点底部「分享」→「添加到主屏幕」
3. 桌面出现橙色罗盘图标，点开就是全屏、无地址栏

### Android（Chrome / Edge）

1. 打开网址
2. 右上角菜单 →「安装应用」或「添加到主屏幕」
3. Chrome 可能直接弹安装横幅（前提是 HTTPS + manifest，两个都已配好）

装完之后：**图标 + 启动画面 + 全屏 + 断网也能开**（service worker 缓存了外壳）。

---

## 5. 给原型加一层访问口令（强烈建议）

原型没有任何鉴权，挂到公网等于公开。加 Basic Auth：

**Caddy**

```bash
caddy hash-password --plaintext 'your-password'
# 复制输出的 $2a$14$... 到 Caddyfile 的 basic_auth 段
sudo systemctl reload caddy
```

**nginx**

```bash
sudo apt install -y apache2-utils
sudo htpasswd -c /etc/nginx/.htpasswd demo
sudo nginx -t && sudo systemctl reload nginx
```

手机第一次打开会弹账号密码框，输一次后记住。

---

## 6. 接下来要做什么（从原型到产品）

现在部署的是「壳」。真要用起来，按这个顺序补：

| 阶段 | 要做的事 | 影响 |
|---|---|---|
| **1. 接后端** | 用户表、订单表、凭证表、内容表；把 `data.js` 的 mock 换成 API | `app.js` 里的 `S` 从 sessionStorage 换成接口调用 |
| **2. 接高德** | 定位 SDK + 逆地理/POI 搜索（服务端代理，Key 不能进前端） | 地址页那套 CSS 假地图换成真地图 |
| **3. 接支付** | 微信/支付宝 App 支付 + 回调幂等 + 库存锁定 | 下单页的 1.4s 假支付换成真调起 |
| **4. 打包 App** | Capacitor 套壳：`npx cap add android` → 出 APK；iOS 需 Apple 开发者账号 | 能上架、能推送、能调系统能力 |

**关于打包成 APK**：如果只是想让手机上有个原生 App，用 Capacitor 把这套前端原样套进去最快（半天），但它本质还是 WebView。要真正的原生体验（流畅滚动、原生地图、推送），就得按我们前面定稿的方案用 React Native 重写——那才是长期方案。

---

## 7. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 打开是 nginx 欢迎页 | `sites-enabled/default` 没删，或 root 指错 |
| 403 Forbidden | 目录权限：`sudo chown -R www-data:www-data /var/www/trip` |
| 改了代码手机不更新 | service worker 缓存。见下条 |
| 白屏 + 提示「数据没加载出来」 | `data.js` 没传上去，检查文件是否在 `/var/www/trip/` 根目录 |
| 图标是灰色的 / 没图标 | manifest 路径或图标 404；确认 `/icons/icon-192.png` 可访问 |
| 添加到主屏幕后还是带地址栏 | 用了 http；iOS 必须 Safari；检查 manifest 的 `display` |
| 证书申请失败 | 域名没解析到这台机器，或 80 端口被防火墙挡了 |

**更新不生效怎么办**：打开 `https://你的域名/?v=2`（加任意 query 会绕过 HTML 缓存），或者在手机浏览器设置里「清除网站数据」。开发阶段也可以临时把 `sw.js` 里的 `VERSION` 改一下再传，缓存会自动换新。

---

## 8. 文件清单

```
prototype/                  要部署的全部静态文件
├── index.html              入口（含 manifest / iOS meta / SW 注册）
├── manifest.webmanifest    PWA 清单
├── sw.js                   离线缓存（网络优先）
├── icons/                  192 / 512 / maskable / apple-touch
├── styles.css
├── data.js
└── app.js

deploy/
├── Caddyfile               推荐方案
├── nginx-trip.conf         nginx 方案
├── upload.ps1              Windows 一键上传
└── README.md               本文件
```
