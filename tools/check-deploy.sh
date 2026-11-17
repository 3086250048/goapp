#!/usr/bin/env bash
# 部署文件静态校验：脚本语法、Compose 配置与关键约束。
set -Eeuo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

printf '→ 检查 deploy/deploy.sh 语法\n'
bash -n deploy/deploy.sh
./deploy/deploy.sh --help >/dev/null

printf '→ 检查一键部署脚本不会删除数据卷\n'
if grep -Eq 'down[[:space:]]+-v|volume[[:space:]]+rm' deploy/deploy.sh; then
  printf '✗ deploy/deploy.sh 含有删除数据卷的命令\n' >&2
  exit 1
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  env_file=$(mktemp)
  trap 'rm -f "$env_file"' EXIT
  cat > "$env_file" <<'EOF'
COMPOSE_PROJECT_NAME=goapp
APP_PORT=18080
DEMO_MODE=1
DEMO_OTP=123456
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin-test-password
COOKIE_SECURE=0
DOMAIN=
CADDY_IMAGE=caddy:2.10-alpine
EOF
  printf '→ 检查默认 Compose 配置\n'
  docker compose --project-directory "$ROOT" --env-file "$env_file" config --quiet

  cat > "$env_file" <<'EOF'
COMPOSE_PROJECT_NAME=goapp
APP_PORT=18080
DEMO_MODE=1
DEMO_OTP=123456
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin-test-password
COOKIE_SECURE=1
DOMAIN=trip.example.com
CADDY_IMAGE=caddy:2.10-alpine
EOF
  printf '→ 检查 HTTPS Compose profile\n'
  docker compose --project-directory "$ROOT" --env-file "$env_file" --profile https config --quiet
else
  printf '· 未检测到 Docker Compose，跳过 Compose 配置解析\n'
fi

printf '✓ 一键部署配置检查通过\n'
