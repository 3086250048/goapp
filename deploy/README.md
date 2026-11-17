# 部署与运维

当前架构是 Python + SQLite 应用容器，可选择内置 Caddy 自动 HTTPS。SQLite 数据保存在 Docker 命名卷 `goapp_goapp-data`。唯一部署入口是 `deploy/deploy.sh`。

## 1. 一键部署

目标机支持 Ubuntu 22.04 / Debian 12，建议至少 1 核 1 GB。系统会由脚本自动安装 Docker、Docker Compose 和基础依赖。

从开发机部署到新服务器：

```bash
./deploy/deploy.sh --remote root@203.0.113.10 \
  --domain trip.example.com
```

如果同时迁移现有数据，追加数据库备份：

```bash
./deploy/deploy.sh --remote root@203.0.113.10 \
  --domain trip.example.com \
  --restore-file ./goapp-2026-11-17.sqlite3
```

恢复文件会先上传到目标机 `/tmp`，部署脚本停止应用、替换持久卷中的 SQLite 数据库、修复文件权限，再启动并执行健康检查；任务结束后自动清理远端临时备份。

脚本会：

1. 通过 SSH 把最新脚本传到目标机，并安装 Docker。
2. 拉取 `master` 到 `/opt/goapp`，重复执行时执行 `git pull --ff-only`。
3. 生成服务器本地的 `.env`，构建并启动应用与 SQLite 数据卷。
4. 带域名时启动 Caddy `https` profile，自动申请并续期 HTTPS 证书。
5. 生成或保留管理员凭据，后台入口为 `/admin/`。
6. 等待 `/api/health`，并验证公网 `https://域名/api/health`。

Windows 可在 WSL 中执行同一命令，或在 PowerShell 中运行：

```powershell
.\deploy\deploy.ps1 -Remote root@203.0.113.10 -Domain trip.example.com
```

如果代码已经在目标服务器上，也可以直接运行：

```bash
sudo ./deploy/deploy.sh --domain trip.example.com
```

不带 `--domain` 时只绑定 `127.0.0.1:18080`，适合已有反向代理或仅做内网验收。

首次部署完成后检查：

```json
{"ok":true,"database":"sqlite","version":"2.1.0"}
```

## 2. 环境变量

| 部署参数 / 变量 | 默认 | 说明 |
|---|---|---|
| `--domain` / `DOMAIN` | 空 | 设置后启用 Caddy HTTPS |
| `APP_PORT` | `18080` | Compose 暴露到本机的端口 |
| `DATA_DIR` | `/data` | 容器内数据库目录 |
| `DEMO_MODE` | `1` | 开启体验账号与固定体验验证码；生产接入短信后必须关闭 |
| `DEMO_OTP` | `123456` | 体验验证码 |
| `ADMIN_USERNAME` | `admin` | 管理后台账号 |
| `ADMIN_PASSWORD` | 自动生成 | 管理后台密码；首次生成后重复部署会保留 |
| `COOKIE_SECURE` | `0` | 正式 HTTPS 部署设为 `1` |
| `CADDY_IMAGE` | `caddy:2.10-alpine` | 可替换为内网镜像仓库地址 |

脚本每次部署都会根据命令行参数重建项目根目录的 `.env`。`.env` 已加入 `.gitignore`，不能提交。

显式指定管理员凭据：

```bash
./deploy/deploy.sh --remote root@203.0.113.10 \
  --domain trip.example.com \
  --admin-user admin \
  --admin-password 'replace-with-a-strong-password'
```

不传参数时，首次部署会生成随机密码，可通过以下命令读取：

```bash
grep '^ADMIN_' .env
```

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

## 3. 内置 Caddy + 自动 HTTPS

一键脚本传入 `--domain` 后，会执行：

```bash
docker compose --profile https up -d --remove-orphans
```

`deploy/Caddyfile` 通过 `DOMAIN` 环境变量生成站点，反向代理到 `goapp:8080`。DNS 的 A/AAAA 记录要先指向这台主机，并放行 80/443。

Caddy 数据保存在独立卷 `goapp_caddy-data`，更新应用不会丢失证书。

## 4. 使用已有 nginx + certbot

不使用内置 Caddy 时，部署命令不要传 `--domain`，然后配置同机 nginx：

```bash
sudo cp deploy/nginx-trip.conf /etc/nginx/sites-available/trip
sudo ln -sf /etc/nginx/sites-available/trip /etc/nginx/sites-enabled/trip
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d trip.example.com
```

nnginx 反向代理指向 `127.0.0.1:18080`；应用的 API 与 `/sw.js` 已自行返回正确的 `no-store` 响应头。

## 5. 发布更新

```bash
./deploy/deploy.sh --remote root@203.0.113.10 \
  --domain trip.example.com
```

重复执行原部署命令即可。远端模式会从 Git 拉取已推送的代码，所以部署前必须完成提交与推送。

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

恢复前先停止应用，把备份写入数据卷并修复文件所有者：

```bash
docker compose stop goapp
docker compose run --rm --user root --entrypoint sh goapp \
  -c 'rm -f /data/goapp.sqlite3 /data/goapp.sqlite3-wal /data/goapp.sqlite3-shm'
docker cp goapp-backup.sqlite3 goapp:/data/goapp.sqlite3
docker compose run --rm --user root --entrypoint chown goapp \
  -R goapp:goapp /data
docker compose start goapp
```

建议每天异地备份一次，并定期实际恢复验证。

## 7. 上线检查

```bash
curl -fsS https://你的域名/api/health
BASE_URL=https://你的域名 python3 tools/api-smoke.py
node tools/check.js
./tools/check-deploy.sh
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
