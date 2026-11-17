#!/usr/bin/env bash
# 出行 App 一键部署：可在服务器本地执行，也可从开发机通过 SSH 执行。
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DEFAULT_REPO_URL="https://github.com/3086250048/goapp.git"
DEFAULT_REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)

REMOTE=""
SSH_PORT="${SSH_PORT:-22}"
APP_DIR="${APP_DIR:-/opt/goapp}"
BRANCH="${BRANCH:-master}"
DOMAIN="${DOMAIN:-}"
APP_PORT="${APP_PORT:-18080}"
DEMO_MODE="${DEMO_MODE:-1}"
DEMO_OTP="${DEMO_OTP:-123456}"
ADMIN_USERNAME="${ADMIN_USERNAME:-}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
ADMIN_USER_EXPLICIT=0
ADMIN_PASSWORD_EXPLICIT=0
[[ -n "$ADMIN_USERNAME" ]] && ADMIN_USER_EXPLICIT=1
[[ -n "$ADMIN_PASSWORD" ]] && ADMIN_PASSWORD_EXPLICIT=1
REPO_URL="${REPO_URL:-$DEFAULT_REPO_URL}"
RESTORE_FILE="${RESTORE_FILE:-}"
SKIP_PULL=0
BOOTSTRAP=0

log() { printf '\033[36m→ %s\033[0m\n' "$*"; }
ok() { printf '\033[32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m⚠ %s\033[0m\n' "$*" >&2; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  cat <<'EOF'
出行 App 一键部署

在目标服务器本地执行：
  sudo ./deploy/deploy.sh [选项]

从开发机部署到新服务器：
  ./deploy/deploy.sh --remote root@1.2.3.4 --domain trip.example.com

常用选项：
  --remote USER@HOST   通过 SSH 部署到远端；代码从 Git 仓库拉取
  --ssh-port PORT      SSH 端口，默认 22
  --domain DOMAIN      域名；设置后启动 Caddy 并自动申请 HTTPS 证书
  --app-dir PATH       服务器安装目录，默认 /opt/goapp
  --app-port PORT      仅绑定本机的应用端口，默认 18080
  --branch NAME        部署分支，默认 master
  --repo-url URL       远端拉取的 Git 仓库地址
  --restore-file PATH  部署时导入 SQLite 备份（可选）
  --demo-mode 0|1      是否开启体验账号与固定验证码，默认 1
  --demo-otp CODE      体验验证码，默认 123456
  --admin-user USER    后台管理员账号，默认 admin
  --admin-password PW  后台管理员密码，仅支持字母数字和 ._~!@%^+=-
  --skip-pull          本次不更新 Git，适合服务器上离线重跑
  -h, --help           显示帮助

示例：
  ./deploy/deploy.sh --remote ubuntu@203.0.113.10 \
    --domain trip.example.com --branch master

重复执行同一条命令即为更新部署。脚本不会删除 goapp-data 数据卷。
EOF
}

while (($#)); do
  case "$1" in
    --remote) REMOTE="${2:-}"; shift 2 ;;
    --ssh-port) SSH_PORT="${2:-}"; shift 2 ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --app-dir) APP_DIR="${2:-}"; shift 2 ;;
    --app-port) APP_PORT="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --repo-url) REPO_URL="${2:-}"; shift 2 ;;
    --restore-file) RESTORE_FILE="${2:-}"; shift 2 ;;
    --demo-mode) DEMO_MODE="${2:-}"; shift 2 ;;
    --demo-otp) DEMO_OTP="${2:-}"; shift 2 ;;
    --admin-user) ADMIN_USERNAME="${2:-}"; ADMIN_USER_EXPLICIT=1; shift 2 ;;
    --admin-password) ADMIN_PASSWORD="${2:-}"; ADMIN_PASSWORD_EXPLICIT=1; shift 2 ;;
    --skip-pull) SKIP_PULL=1; shift ;;
    --bootstrap) BOOTSTRAP=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "未知参数：$1（使用 --help 查看用法）" ;;
  esac
done

[[ "$SSH_PORT" =~ ^[0-9]+$ ]] && ((SSH_PORT >= 1 && SSH_PORT <= 65535)) \
  || fail "SSH 端口无效：$SSH_PORT"
[[ "$APP_PORT" =~ ^[0-9]+$ ]] && ((APP_PORT >= 1 && APP_PORT <= 65535)) \
  || fail "应用端口无效：$APP_PORT"
[[ "$DEMO_MODE" == "0" || "$DEMO_MODE" == "1" ]] || fail "demo-mode 只能是 0 或 1"
[[ "$DEMO_OTP" =~ ^[0-9]{6}$ ]] || fail "demo-otp 必须是 6 位数字"
[[ "$ADMIN_USERNAME" =~ ^[A-Za-z0-9._-]{3,64}$ || -z "$ADMIN_USERNAME" ]] \
  || fail "admin-user 需为 3–64 位字母、数字、. _ 或 -"
[[ "$ADMIN_PASSWORD" =~ ^[A-Za-z0-9._~!@%^+=-]{8,128}$ || -z "$ADMIN_PASSWORD" ]] \
  || fail "admin-password 不符合允许的字符规则"
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "分支名无效：$BRANCH"
[[ "$APP_DIR" == /* && "$APP_DIR" != "/" ]] || fail "app-dir 必须是非根目录的绝对路径"
if [[ -n "$DOMAIN" && ! "$DOMAIN" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}$ ]]; then
  fail "域名格式无效：$DOMAIN"
fi
if [[ -n "$RESTORE_FILE" && ! -f "$RESTORE_FILE" ]]; then
  fail "恢复文件不存在：$RESTORE_FILE"
fi

if [[ -n "$REMOTE" ]]; then
  have ssh || fail "本机缺少 ssh"
  [[ "$REMOTE" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9.:-]+$ ]] || fail "remote 格式应为 user@host"
  log "通过 SSH 部署到 $REMOTE"
  remote_args=(
    --bootstrap
    --app-dir "$APP_DIR"
    --app-port "$APP_PORT"
    --branch "$BRANCH"
    --repo-url "$REPO_URL"
    --demo-mode "$DEMO_MODE"
    --demo-otp "$DEMO_OTP"
  )
  ((ADMIN_USER_EXPLICIT)) && remote_args+=(--admin-user "$ADMIN_USERNAME")
  ((ADMIN_PASSWORD_EXPLICIT)) && remote_args+=(--admin-password "$ADMIN_PASSWORD")
  [[ -n "$DOMAIN" ]] && remote_args+=(--domain "$DOMAIN")
  ((SKIP_PULL)) && remote_args+=(--skip-pull)
  remote_restore=""
  if [[ -n "$RESTORE_FILE" ]]; then
    have scp || fail "本机缺少 scp，无法上传数据库备份"
    remote_restore="/tmp/goapp-restore-$(date +%s)-$$.sqlite3"
    log "上传数据库备份"
    scp -P "$SSH_PORT" -- "$RESTORE_FILE" "$REMOTE:$remote_restore"
    remote_args+=(--restore-file "$remote_restore")
  fi

  quoted=""
  for arg in "${remote_args[@]}"; do
    escaped=${arg//\'/\'\\\'\'}
    quoted+=" '$escaped'"
  done
  remote_cmd="if [ \"\$(id -u)\" -eq 0 ]; then bash -s --$quoted; else sudo bash -s --$quoted; fi"
  set +e
  ssh -p "$SSH_PORT" -o ServerAliveInterval=30 "$REMOTE" "$remote_cmd" < "${BASH_SOURCE[0]}"
  status=$?
  set -e
  if [[ -n "$remote_restore" ]]; then
    ssh -p "$SSH_PORT" -o ServerAliveInterval=30 "$REMOTE" \
      "rm -f '$remote_restore'" >/dev/null 2>&1 || true
  fi
  exit "$status"
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  fail "目标机必须是 Linux；开发机请使用 --remote 模式"
fi

SUDO=()
if [[ "$(id -u)" -ne 0 ]]; then
  have sudo || fail "需要 root 权限或 sudo"
  log "检查 sudo 权限"
  sudo -v
  SUDO=(sudo)
fi
run_root() { "${SUDO[@]}" "$@"; }

install_base_packages() {
  have curl && have git && have openssl && return
  have apt-get || fail "自动安装仅支持 Debian/Ubuntu；请先安装 curl 与 git"
  log "安装基础依赖"
  run_root apt-get update
  run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git openssl
}

install_docker() {
  if have docker && docker compose version >/dev/null 2>&1; then
    return
  fi
  have apt-get || fail "未安装 Docker，且系统不是 Debian/Ubuntu"
  log "安装 Docker Engine 与 Compose"
  run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  run_root sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh
  if have systemctl; then
    run_root systemctl enable --now docker
  fi
  docker compose version >/dev/null 2>&1 || fail "Docker Compose 插件安装失败"
}

ensure_server_dependencies() {
  install_base_packages
  install_docker
}

sync_repository() {
  if [[ -d "$APP_DIR/.git" ]]; then
    log "更新 $APP_DIR ($BRANCH)"
    run_root git -C "$APP_DIR" fetch origin "$BRANCH"
    current=$(run_root git -C "$APP_DIR" rev-parse --abbrev-ref HEAD)
    [[ "$current" == "$BRANCH" ]] || fail "$APP_DIR 当前在 $current，不是 $BRANCH；请先手动切换分支"
    run_root git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
    return
  fi
  if [[ -e "$APP_DIR" ]] && [[ -n "$(ls -A "$APP_DIR" 2>/dev/null || true)" ]]; then
    fail "$APP_DIR 已存在且不是 Git 仓库；为避免覆盖，请指定新的 --app-dir"
  fi
  log "克隆 $REPO_URL ($BRANCH) 到 $APP_DIR"
  run_root mkdir -p "$(dirname -- "$APP_DIR")"
  run_root git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$APP_DIR"
}

if ((BOOTSTRAP)); then
  ensure_server_dependencies
  if ((SKIP_PULL)); then
    [[ -x "$APP_DIR/deploy/deploy.sh" ]] || fail "$APP_DIR 中找不到 deploy/deploy.sh"
  else
    sync_repository
  fi
  args=(
    --app-dir "$APP_DIR"
    --app-port "$APP_PORT"
    --branch "$BRANCH"
    --demo-mode "$DEMO_MODE"
    --demo-otp "$DEMO_OTP"
    --skip-pull
  )
  ((ADMIN_USER_EXPLICIT)) && args+=(--admin-user "$ADMIN_USERNAME")
  ((ADMIN_PASSWORD_EXPLICIT)) && args+=(--admin-password "$ADMIN_PASSWORD")
  [[ -n "$DOMAIN" ]] && args+=(--domain "$DOMAIN")
  [[ -n "$RESTORE_FILE" ]] && args+=(--restore-file "$RESTORE_FILE")
  log "切换到最新部署脚本"
  set +e
  bash "$APP_DIR/deploy/deploy.sh" "${args[@]}"
  status=$?
  set -e
  if [[ -n "$RESTORE_FILE" ]]; then
    rm -f "$RESTORE_FILE"
  fi
  exit "$status"
fi

if [[ -f "$DEFAULT_REPO_ROOT/compose.yaml" && -f "$DEFAULT_REPO_ROOT/Dockerfile" ]]; then
  REPO_ROOT="$DEFAULT_REPO_ROOT"
else
  ensure_server_dependencies
  ((SKIP_PULL)) || sync_repository
  REPO_ROOT="$APP_DIR"
fi

[[ -f "$REPO_ROOT/compose.yaml" ]] || fail "$REPO_ROOT 缺少 compose.yaml"
[[ -f "$REPO_ROOT/Dockerfile" ]] || fail "$REPO_ROOT 缺少 Dockerfile"
ensure_server_dependencies
cd "$REPO_ROOT"

ENV_FILE="$REPO_ROOT/.env"
env_value() {
  [[ -f "$ENV_FILE" ]] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1
}
if ((!ADMIN_USER_EXPLICIT)); then
  ADMIN_USERNAME=$(env_value ADMIN_USERNAME)
  ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
fi
if ((!ADMIN_PASSWORD_EXPLICIT)); then
  ADMIN_PASSWORD=$(env_value ADMIN_PASSWORD)
fi
if [[ -z "$ADMIN_PASSWORD" ]]; then
  ADMIN_PASSWORD=$(openssl rand -hex 18)
  ADMIN_PASSWORD_GENERATED=1
else
  ADMIN_PASSWORD_GENERATED=0
fi
umask 077
{
  printf 'COMPOSE_PROJECT_NAME=goapp\n'
  printf 'APP_PORT=%s\n' "$APP_PORT"
  printf 'DEMO_MODE=%s\n' "$DEMO_MODE"
  printf 'DEMO_OTP=%s\n' "$DEMO_OTP"
  printf 'ADMIN_USERNAME=%s\n' "$ADMIN_USERNAME"
  printf 'ADMIN_PASSWORD=%s\n' "$ADMIN_PASSWORD"
  printf 'CADDY_IMAGE=%s\n' "${CADDY_IMAGE:-caddy:2.10-alpine}"
  if [[ -n "$DOMAIN" ]]; then
    printf 'DOMAIN=%s\n' "$DOMAIN"
    printf 'COOKIE_SECURE=1\n'
  else
    printf 'DOMAIN=\n'
    printf 'COOKIE_SECURE=0\n'
  fi
} > "$ENV_FILE.tmp"
mv "$ENV_FILE.tmp" "$ENV_FILE"

compose=(run_root docker compose --project-directory "$REPO_ROOT" --env-file "$ENV_FILE")

log "构建应用镜像"
"${compose[@]}" build goapp
if [[ -n "$DOMAIN" ]]; then
  "${compose[@]}" --profile https pull caddy || warn "Caddy 镜像拉取失败；若本地已有镜像仍可继续"
fi

if [[ -n "$RESTORE_FILE" ]]; then
  restore_abs=$(cd -- "$(dirname -- "$RESTORE_FILE")" && pwd)/$(basename -- "$RESTORE_FILE")
  log "导入 SQLite 备份（会替换当前数据库）"
  "${compose[@]}" stop goapp >/dev/null 2>&1 || true
  "${compose[@]}" run --rm --user root --no-deps \
    -v "$restore_abs:/restore.sqlite3:ro" \
    --entrypoint python goapp -c '
import os, sqlite3
for path in ("/data/goapp.sqlite3", "/data/goapp.sqlite3-wal", "/data/goapp.sqlite3-shm"):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
source = sqlite3.connect("/restore.sqlite3")
target = sqlite3.connect("/data/goapp.sqlite3")
source.backup(target)
target.execute("PRAGMA journal_mode=WAL")
target.close()
source.close()
'
  "${compose[@]}" run --rm --user root --no-deps \
    --entrypoint chown goapp -R goapp:goapp /data
  ok "数据库备份已导入"
fi

log "启动应用与数据库"
if [[ -n "$DOMAIN" ]]; then
  "${compose[@]}" --profile https up -d --remove-orphans
else
  "${compose[@]}" up -d --remove-orphans
  if run_root docker inspect goapp-caddy >/dev/null 2>&1; then
    warn "当前未配置域名，停止旧 Caddy 容器"
    run_root docker rm -f goapp-caddy >/dev/null
  fi
fi

health_url="http://127.0.0.1:$APP_PORT/api/health"
log "等待应用健康检查"
healthy=0
for _ in $(seq 1 60); do
  if curl -fsS "$health_url" 2>/dev/null | grep -q '"ok":true'; then
    healthy=1
    break
  fi
  sleep 2
done
[[ "$healthy" -eq 1 ]] || {
  "${compose[@]}" logs --tail=120 goapp >&2 || true
  fail "应用未在 120 秒内通过健康检查"
}
ok "应用健康检查通过：$health_url"

if [[ -n "$DOMAIN" ]]; then
  public_url="https://$DOMAIN"
  resolved=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1 {print $1}' || true)
  public_ip=$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)
  if [[ -n "$resolved" && -n "$public_ip" && "$resolved" != "$public_ip" ]]; then
    warn "域名解析到 $resolved，服务器出口 IP 是 $public_ip；证书签发可能失败"
  fi
  log "等待 HTTPS 就绪（最多 180 秒）"
  https_ok=0
  for _ in $(seq 1 90); do
    if curl -fsS --max-time 8 "$public_url/api/health" 2>/dev/null | grep -q '"ok":true'; then
      https_ok=1
      break
    fi
    sleep 2
  done
  if [[ "$https_ok" -ne 1 ]]; then
    "${compose[@]}" --profile https logs --tail=120 caddy >&2 || true
    fail "HTTPS 未就绪；检查 DNS、80/443 防火墙与 Caddy 日志"
  fi
  ok "公网 HTTPS 已上线：$public_url"
else
  ok "仅本机启动完成：http://127.0.0.1:$APP_PORT"
  warn "未传 --domain，不会配置公网 HTTPS"
fi

printf '\n部署信息\n'
printf '  代码目录  %s\n' "$REPO_ROOT"
printf '  环境文件  %s\n' "$ENV_FILE"
printf '  数据卷    goapp_goapp-data\n'
printf '  管理后台  /admin/（账号 %s）\n' "$ADMIN_USERNAME"
if ((ADMIN_PASSWORD_GENERATED)); then
  printf '  后台密码  已生成，保存在 %s 的 ADMIN_PASSWORD\n' "$ENV_FILE"
fi
printf '  更新命令  重复执行本次部署命令即可\n'
printf '  查看日志  docker compose logs -f goapp\n'
