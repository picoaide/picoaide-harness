#!/usr/bin/env bash
# PicoAide 服务端一键部署脚本(Ubuntu,非交互,全部用环境变量配置)
# 用法(需 root 用户直接运行;若系统有 sudo 也可 sudo bash):
#   curl -fsSL https://raw.githubusercontent.com/picoaide/picoaide-next/master/scripts/install-server.sh | \
#     DOMAIN=picoaide.example.com bash
#
# 环境变量(必填 DOMAIN,其余可选):
#   DOMAIN        部署域名(必填,支持 IP,如 10.0.0.5 或 picoaide.example.com)
#   INSTALL_DIR   部署目录(默认 /data/picoaide-next)
#   ADMIN_USER    管理员账号(默认 admin)
#   ADMIN_PASS    管理员密码(默认随机生成并打印)
#   SERVER_IMAGE  服务端镜像(默认 ghcr.io/picoaide/picoaide-server:latest)
#   REINSTALL=yes 目录已存在且非空时,清除旧部署并重新安装(默认安全退出)
#
# 行为:
#   1. 检查系统(Ubuntu)与依赖(docker/compose/curl/jq/openssl),缺失自动安装
#   2. 用 openssl 生成自签名证书到 certs/,Caddyfile 显式指定
#      tls /certs/server.crt /certs/server.key,管理员换证书 = 替换 certs/ 下文件后重启
#   3. 生成随机强密码(可用 ADMIN_PASS 指定);全部变量内联写入 docker-compose.yml
#   4. 已有目录且有文件 → 除非 REINSTALL=yes 否则安全退出
#   5. 启动服务,展示访问地址/账号/密码/已安装项清单

set -euo pipefail

# ---- 默认值 ----
INSTALL_DIR="${INSTALL_DIR:-/data/picoaide-next}"
DOMAIN="${DOMAIN:-}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-}"
DOCKER_MIRROR="${DOCKER_MIRROR:-https://mirrors.tuna.tsinghua.edu.cn/docker-ce}"
SERVER_IMAGE="${SERVER_IMAGE:-ghcr.io/picoaide/picoaide-server:latest}"
LOG_FILE="${LOG_FILE:-/tmp/picoaide-install.log}"
REINSTALL="${REINSTALL:-}"

# ---- 环境检查(最先,非 root 直接退出) ----
[ "$(id -u)" = 0 ] || { echo "错误: 必须以 root 用户运行。请用 root 登录后重试(例如: curl -fsSL ... | bash),或使用 sudo 运行。" >&2; exit 1; }

# ---- 展示与日志 ----
installed=()
: > "$LOG_FILE"
log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "$LOG_FILE"; }
fail() { log "错误: $*"; exit 1; }
# step 输出醒目的阶段标题
step() {
  log ""
  log "──────────────────────────────────────────────"
  log "▶ $*"
  log "──────────────────────────────────────────────"
}
step "检查系统与依赖"
command -v lsb_release >/dev/null 2>&1 || { log "安装 lsb-release"; apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq lsb-release; installed+=("lsb-release"); }
distro="$(lsb_release -is 2>/dev/null || echo unknown)"
[ "$distro" = "Ubuntu" ] || log "警告: 检测到 $distro,脚本针对 Ubuntu 优化"

# ---- 依赖安装 ----
step "安装基础依赖(curl/jq/openssl/ca-certificates)"
install_if_missing() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log "安装 $3($1)..."
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$2"
    installed+=("$2")
  else
    log "已存在: $1"
  fi
}
for cmd in curl jq openssl ca-certificates; do
  install_if_missing "$cmd" "$cmd" "$cmd"
done

# ---- Docker 安装(含 compose 插件) ----
step "检查/安装 Docker 与 compose"
ensure_docker() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    log "docker 已安装"
    return 0
  fi
  log "未检测到可用 docker,从 $DOCKER_MIRROR 镜像源安装 docker-ce..."
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl gnupg lsb-release || fail "依赖安装失败"
  export DOWNLOAD_URL="$DOCKER_MIRROR"
  if curl -fsSL https://raw.githubusercontent.com/docker/docker-install/master/install.sh | sh; then
    :
  else
    log "官方脚本失败,改用 apt 源安装..."
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/ubuntu/gpg" | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg 2>/dev/null || true
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] $DOCKER_MIRROR/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
  installed+=("docker-ce")
  docker --version || fail "docker 安装后仍不可用"
}
ensure_docker
docker compose version >/dev/null 2>&1 || fail "docker compose 插件不可用"
log "docker compose 已就绪"

# ---- 参数校验(纯环境变量,非交互) ----
step "配置部署参数(域名 / 管理员密码)"
[ -n "$DOMAIN" ] || fail "未提供域名,请以 DOMAIN=your.domain bash 方式运行"
case "$DOMAIN" in
  */*) fail "域名不合法: $DOMAIN" ;;
esac
log "域名: $DOMAIN"
[ -n "$ADMIN_PASS" ] || ADMIN_PASS="$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 16)"
[ ${#ADMIN_PASS} -ge 8 ] || fail "管理员密码过短"
log "管理员账号: $ADMIN_USER(密码由下方展示)"

# ---- 已有目录检查:是否重装 ----
step "检查部署目录 $INSTALL_DIR"
if [ -d "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
  if [ "$REINSTALL" = "yes" ]; then
    log "检测到 $INSTALL_DIR 已存在且非空,REINSTALL=yes → 清除旧部署重新安装"
    log "将停止相关容器、检查 80/443 端口、并清空 $INSTALL_DIR 下所有文件"
    log "停止相关容器..."
    docker compose -f "$INSTALL_DIR/docker-compose.yml" down 2>/dev/null || true
    docker ps -aq --filter "name=picoaide-" | xargs -r docker rm -f 2>/dev/null || true
    log "清空 $INSTALL_DIR 下所有文件..."
    rm -rf "${INSTALL_DIR:?}/"*
    log "旧部署已清除"
  else
    log "检测到 $INSTALL_DIR 已存在且非空"
    fail "为避免覆盖已有部署,已安全退出。确认要重装请加 REINSTALL=yes 重新运行"
  fi
fi

# ---- 部署目录 ----
step "创建部署目录并生成配置"
mkdir -p "$INSTALL_DIR" "$INSTALL_DIR/picoaide-data"
cd "$INSTALL_DIR"

# ---- 证书生成(openssl 自签名 → certs/ 目录) ----
step "生成自签名证书(certs/)"
mkdir -p "$INSTALL_DIR/certs"
if [ -f "$INSTALL_DIR/certs/server.crt" ] && [ -f "$INSTALL_DIR/certs/server.key" ]; then
  log "检测到已有证书,保留不重新生成:"
  log "  $INSTALL_DIR/certs/server.crt"
  log "  $INSTALL_DIR/certs/server.key"
else
  log "用 openssl 生成 10 年自签名证书(CN/SAN=$DOMAIN)..."
  # 域名为 IP 时 SAN 用 IP:,否则用 DNS:
  case "$DOMAIN" in
    *[!0-9.]*) san="DNS:$DOMAIN" ;;
    *) san="IP:$DOMAIN" ;;
  esac
  openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
    -keyout "$INSTALL_DIR/certs/server.key" \
    -out "$INSTALL_DIR/certs/server.crt" \
    -subj "/CN=$DOMAIN" \
    -addext "subjectAltName=$san" || fail "证书生成失败"
  log "已生成:"
  log "  证书: $INSTALL_DIR/certs/server.crt"
  log "  私钥: $INSTALL_DIR/certs/server.key"
fi
installed+=("生成自签名证书(openssl)")

# ---- Caddyfile 生成(显式指定证书文件) ----
cat > Caddyfile <<CADDY
# PicoAide HTTPS 反代(由 install-server.sh 自动生成)
# 证书: 部署脚本用 openssl 生成的自签名证书,位于 $INSTALL_DIR/certs/
# 替换证书(管理员): 直接用新证书覆盖 certs/server.crt 与 certs/server.key,然后:
#   cd $INSTALL_DIR && docker compose restart caddy
$DOMAIN {
	tls /certs/server.crt /certs/server.key

	reverse_proxy server:8080 {
		header_up Host {host}
		header_up X-Forwarded-Proto {scheme}
		header_up X-Forwarded-For {remote_host}
	}
}
CADDY
log "已生成 Caddyfile(指定 tls /certs/server.crt /certs/server.key)"

# ---- docker-compose.yml 生成(变量全部内联) ----
cat > docker-compose.yml <<COMPOSE
services:
  caddy:
    image: caddy:2-alpine
    container_name: picoaide-caddy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./certs:/certs:ro
    depends_on:
      - server

  server:
    image: $SERVER_IMAGE
    container_name: picoaide-server
    restart: unless-stopped
    expose:
      - "8080"
    environment:
      PICOAI_ADMIN_PASSWORD: $ADMIN_PASS
    volumes:
      - ./picoaide-data:/data
    command: ["--bootstrap-admin", "$ADMIN_USER"]
    healthcheck:
      # /healthz 无需认证返回 200;wget 退出码 0=healthy(连接失败/非200=unhealthy)
      test: ["CMD-SHELL", "wget -q -O /dev/null http://127.0.0.1:8080/healthz"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
COMPOSE
installed+=("生成 Caddyfile 与 docker-compose.yml")

# ---- 端口检查(80/443 必须空闲,caddy 才能绑定) ----
step "检查端口 80/443 是否空闲"
for port in 80 443; do
  if ss -tlnp 2>/dev/null | grep -q ":$port "; then
    log "端口 $port 被占用,当前占用:"
    ss -tlnp 2>/dev/null | grep ":$port " || true
    fail "端口 $port 被其他进程占用,请先释放后再重装/安装"
  fi
  log "端口 $port 空闲"
done

# ---- 启动 ----
step "拉取镜像并启动服务"
log "拉取镜像..."
docker compose pull 2>/dev/null || true
log "启动容器..."
docker compose up -d
installed+=("docker compose up -d(启动服务)")

# ---- 等待就绪(最多 90s) ----
log "等待服务就绪(最多 90s)..."
ready=0
for _ in $(seq 1 30); do
  code="$(curl -sk -o /dev/null -w '%{http_code}' --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/admin/" 2>/dev/null || true)"
  if [ "$code" = "200" ]; then ready=1; break; fi
  sleep 3
done
[ "$ready" = 1 ] || log "警告: 服务可能仍在启动,请稍后访问确认"

# ---- 展示 ----
log ""
log "========== PicoAide 部署完成 =========="
log "管理后台: https://$DOMAIN/admin/"
log "员工登录: https://$DOMAIN"
log "账号: $ADMIN_USER"
log "密码: $ADMIN_PASS"
log "数据目录: $INSTALL_DIR/picoaide-data"
log "证书: 自签名(openssl 生成,10 年有效期)"
log "  证书文件: $INSTALL_DIR/certs/server.crt"
log "  私钥文件: $INSTALL_DIR/certs/server.key"
log "  替换正式证书: 用新证书覆盖上面两个文件,然后:"
log "  cd $INSTALL_DIR && docker compose restart caddy"
log "--------------------------------------"
log "已执行操作:"
for i in "${installed[@]}"; do log "  ✓ $i"; done
log "======================================"
log "提示: 登录后在 webadmin 网关页填写\"对外访问地址\" = https://$DOMAIN"
