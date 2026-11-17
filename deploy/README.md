# 部署与运维

当前架构是单容器应用：Python 同时提供 PWA 静态文件和 `/api/*`，SQLite 数据保存在 Docker 命名卷 `goapp-data`。生产环境只需把 HTTPS 反向代理指向容器端口。

## 1. 服务器准备

Ubuntu 22.04 / Debian 12，1 核 1 GB 可运行。安装 Docker 与 Compose 后：

```bash
git clone git@github.com:3086250048/goapp.git
cd goapp
docker compose up -d --build
curl -fsS http://127.0.0.1:18080/api/health
```

预期返回：

```json
{"ok":true,"database":"sqlite","version":"2.0.0"}
```

`compose.yaml` 默认只把应用绑定到 `127.0.0.1:18080`，不会直接裸奔到公网。通过同机 Caddy 或 nginx 暴露 HTTPS。

## 2. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `APP_PORT` | `18080` | Compose 暴露到本机的端口 |
| `DATA_DIR` | `/data` | 容器内数据库目录 |
| `DEMO_MODE` | `1` | 开启体验账号与固定体验验证码；生产接入短信后必须关闭 |
| `DEMO_OTP` | `123456` | 体验验证码 |
| `COOKIE_SECURE` | `0` | 正式 HTTPS 部署设为 `1` |

生产环境示例：

```yaml
services:
  goapp:
    build: .
    restart: unless-stopped
    ports:
      - "127.0.0.1:18080:8080"
    environment:
      DEMO_MODE: "0"
      COOKIE_SECURE: "1"
    volumes:
      - goapp-data:/data

volumes:
  goapp-data:
```

`DEMO_MODE=0` 时，验证码只写入 `otp_challenges` 表，不会返回给浏览器，也不会打印到日志。接入短信服务商时需要把服务端生成的验证码交给短信 SDK；当前仓库没有虚构第三方短信接入。

## 3. Caddy + 自动 HTTPS

把 `deploy/Caddyfile` 中的 `trip.example.com` 改成你的域名，然后：

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

DNS 的 A/AAAA 记录要先指向这台主机，并放行 80/443。

## 4. nginx + certbot

```bash
sudo cp deploy/nginx-trip.conf /etc/nginx/sites-available/trip
sudo ln -sf /etc/nginx/sites-available/trip /etc/nginx/sites-enabled/trip
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d trip.example.com
```

两种反向代理都已关闭静态缓存，`/api/*` 不会被缓存。

## 5. 发布更新

```bash
git pull --ff-only
docker compose up -d --build
curl -fsS http://127.0.0.1:18080/api/health
BASE_URL=https://trip.example.com python3 tools/api-smoke.py
```

SQLite 使用 WAL 模式，数据库位于：

```text
goapp-data/goapp.sqlite3
```

重建应用容器不会删除数据卷。不要执行 `docker compose down -v`，除非确实要清空全部用户、地址、订单和凭证。

## 6. 备份与恢复

在线备份：

```bash
docker exec goapp python -c \
  "import sqlite3; src=sqlite3.connect('/data/goapp.sqlite3'); dst=sqlite3.connect('/data/backup.sqlite3'); src.backup(dst); dst.close(); src.close()"
docker cp goapp:/data/backup.sqlite3 "./goapp-$(date +%F).sqlite3"
docker exec goapp rm /data/backup.sqlite3
```

恢复前先停应用，替换数据卷中的数据库，再启动：

```bash
docker compose stop goapp
docker cp goapp-backup.sqlite3 goapp:/data/goapp.sqlite3
docker compose start goapp
```

建议每天异地备份一次，并定期实际恢复验证。

## 7. 上线检查

```bash
curl -fsS https://你的域名/api/health
BASE_URL=https://你的域名 python3 tools/api-smoke.py
node tools/check.js
```

还要人工确认：

- 注册、登录、退出后会话状态正确。
- 换一个浏览器或设备登录同一手机号，画像、地址、订单仍存在。
- 下单总价、人数折扣、周末溢价与确认页一致。
- 每张凭证二维码可扫描，8 位核销码存在且不同。
- Caddy/nginx 的 `/sw.js` 返回 `no-store`，`/api/*` 返回 `no-store`。
- 数据卷已纳入备份，恢复流程演练通过。

## 8. 当前边界

- 支付仍是模拟确认：没有支付渠道签名、回调验签、库存锁和退款。
- 短信仍使用体验验证码；正式开放注册前必须接入短信服务商并关闭 `DEMO_MODE`。
- 地图与 POI 仍是示意数据，需要高德服务端代理。
- 核销人员端尚未实现；二维码内容格式为 `GOAPP:<16位凭证码>`，可据此开发扫码核销。
