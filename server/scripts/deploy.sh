#!/usr/bin/env bash
# ============================================================
# PicoAide 服务端自动化部署脚本
# ============================================================
# 用法:
#   ./scripts/deploy.sh install          # 首次部署(非交互,环境变量驱动)
#   ./scripts/deploy.sh update           # 升级镜像并重启(数据不丢)
#   ./scripts/deploy.sh status           # 查看容器状态 + 健康检查 + 固定 IP
#   ./scripts/deploy.sh logs [-t]        # 查看日志(--tail=200;-t/--follow 跟踪)
#   ./scripts/deploy.sh backup           # 备份数据(picoaide-data + caddy-data 证书库)
#   ./scripts/deploy.sh uninstall        # 卸载(停容器;--volumes 全删数据目录,需确认)
#
# 环境变量(全部可选,均有默认值):
#   DEPLOY_DIR        部署目录(含 docker-compose.yml;默认 = 当前目录,install-server.sh 会传入)
#   DOMAIN            对外域名或 IP(默认 picoaide.example.com,部署时必改)
#   TLS_MODE          证书模式:manual(默认,自签占位+提示替换) | auto(Let's Encrypt 自动)
#   ADMIN_USER        初始超管用户名(默认 admin)
#   PICOAI_ADMIN_PASSWORD 初始超管密码(默认随机生成并在最后打印;已有 admin 后可用空值清除)
#   SERVER_IMAGE      服务端镜像(默认 ghcr.io/picoaide/picoaide-server:latest)
#   NETWORK_SUBNET    私有网段(默认 172.28.0.0/24)
#   CADDY_IP / SERVER_IP  容器固定 IP(默认 172.28.0.2 / 172.28.0.3)
#   CONFIRM_CDN       auto 模式:域名解析不直连本机(疑似 CDN/代理)时,
#                     交互确认;无人值守设 CONFIRM_CDN=yes 直接继续
#   REINSTALL=yes     .env 已存在时清除旧部署重装(默认安全退出)
#   UNINSTALL_VOLUMES=yes  uninstall --volumes 无人值守确认(删除数据目录)
set -euo pipefail

# ---- 路径与参数 ----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 部署目录:环境变量 > 当前目录(在部署目录里运行脚本) > 仓库根
DEPLOY_DIR="${DEPLOY_DIR:-$PWD}"
cd "$DEPLOY_DIR"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml"
# 资产模板目录:部署目录优先(install-server.sh 已复制),否则回退仓库脚本上级
TEMPLATE_DIR=""
if [ -f "$DEPLOY_DIR/Caddyfile.autocert" ]; then TEMPLATE_DIR="$DEPLOY_DIR"; fi
if [ -z "$TEMPLATE_DIR" ] && [ -f "$SCRIPT_DIR/../Caddyfile.autocert" ]; then TEMPLATE_DIR="$SCRIPT_DIR/.."; fi
LOG_FILE="${LOG_FILE:-/tmp/picoaide-deploy.log}"
COMPOSE="docker compose"
: > "$LOG_FILE"

DOMAIN="${DOMAIN:-}"
TLS_MODE="${TLS_MODE:-}"
ADMIN_USER="${ADMIN_USER:-}"
PICOAI_ADMIN_PASSWORD="${PICOAI_ADMIN_PASSWORD:-}"
SERVER_IMAGE="${SERVER_IMAGE:-}"
NETWORK_SUBNET="${NETWORK_SUBNET:-}"
CADDY_IP="${CADDY_IP:-}"
SERVER_IP="${SERVER_IP:-}"
CONFIRM_CDN="${CONFIRM_CDN:-}"
REINSTALL="${REINSTALL:-}"
UNINSTALL_VOLUMES="${UNINSTALL_VOLUMES:-}"
TZ="${TZ:-}"

# 优先级:环境变量 > 已存在 .env > 内置默认(下面赋值)
# 只读非敏感部署变量;PICOAI_ADMIN_PASSWORD 不在此加载(由 compose 读取 .env,避免 shell 环境暴露明文)
if [ -f "$DEPLOY_DIR/.env" ]; then
  while IFS='=' read -r key val; do
    case "$key" in
      TLS_MODE|DOMAIN|ADMIN_USER|SERVER_IMAGE|NETWORK_SUBNET|CADDY_IP|SERVER_IP|TZ)
        : "${!key:=$val}" ;;   # 环境变量已设置则保留,否则用 .env 值
    esac
  done < <(grep -E '^[A-Z_]+=' "$DEPLOY_DIR/.env" 2>/dev/null || true)
fi

DOMAIN="${DOMAIN:-picoaide.example.com}"
TLS_MODE="${TLS_MODE:-manual}"
ADMIN_USER="${ADMIN_USER:-admin}"
SERVER_IMAGE="${SERVER_IMAGE:-ghcr.io/picoaide/picoaide-server:latest}"
NETWORK_SUBNET="${NETWORK_SUBNET:-172.28.0.0/24}"
CADDY_IP="${CADDY_IP:-172.28.0.2}"
SERVER_IP="${SERVER_IP:-172.28.0.3}"
TZ="${TZ:-Asia/Shanghai}"
CADDY_CONTAINER="picoaide-caddy"
SERVER_CONTAINER="picoaide-server"
NETWORK_NAME="picoaide-net"

log()  { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "$LOG_FILE"; }
warn() { log "警告: $*"; }
fail() { log "错误: $*"; exit 1; }

# ============================================================
# 命令存在性检查:缺失即提示安装包并退出,绝不带病执行
# ============================================================
# 检查表:命令 | 用途 | 缺失提示
REQUIRED_CMDS=(
  "docker|容器运行时|请安装 Docker: curl -fsSL https://get.docker.com | sh(或 apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin)"
  "compose-plugin|Docker Compose v2 插件|请安装 compose 插件: apt-get install -y docker-compose-plugin(或 curl -fsSL https://get.docker.com | sh)"
  "curl|HTTP 健康检查/公网 IP 查询|请安装: apt-get install -y curl"
  "jq|JSON 解析(docker network 查询)|请安装: apt-get install -y jq"
  "openssl|自签证书生成(manual 模式)|请安装: apt-get install -y openssl"
  "dns|域名解析校验(auto 模式;dig 或 nslookup)|请安装: apt-get install -y dnsutils(或 bind-utils)"
  "port|端口占用检测(ss 或 lsof)|请安装: apt-get install -y iproute2(或 lsof)"
)

check_cmds() {
  local missing=() name hint found
  for entry in "${REQUIRED_CMDS[@]}"; do
    name="${entry%%|*}"; rest="${entry#*|}"
    hint="${rest#*|}"
    found=0
    case "$name" in
      compose-plugin)
        docker compose version >/dev/null 2>&1 && found=1 ;;
      dns)
        command -v dig >/dev/null 2>&1 && found=1
        [ "$found" = 0 ] && command -v nslookup >/dev/null 2>&1 && found=1 ;;
      port)
        command -v ss >/dev/null 2>&1 && found=1
        [ "$found" = 0 ] && command -v lsof >/dev/null 2>&1 && found=1 ;;
      *)
        command -v "$name" >/dev/null 2>&1 && found=1 ;;
    esac
    if [ "$found" = 1 ]; then
      log "  ✓ 已存在: $name"
    else
      log "  ✗ 缺失: $name → $hint"
      missing+=("$name($hint)")
    fi
  done
  [ ${#missing[@]} -gt 0 ] && fail "以下必需命令缺失,请先安装后重试:"$'\n'"$(printf '    - %s\n' "${missing[@]}")"
  return 0
}

# ============================================================
# 辅助:网络/端口/证书
# ============================================================
is_ip() { case "$1" in *[!0-9.]*) return 1;; esac; return 0; }

check_network_conflict() {
  # 已有同名网络:子网不一致 → 报错;容器 IP 冲突 → 报错
  if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
    local existing_subnet
    existing_subnet="$(docker network inspect "$NETWORK_NAME" -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null || true)"
    if [ -n "$existing_subnet" ] && [ "$existing_subnet" != "$NETWORK_SUBNET" ]; then
      fail "网络 $NETWORK_NAME 已存在且子网($existing_subnet)与配置($NETWORK_SUBNET)不一致。"$'\n'"如需更换网段: docker network rm $NETWORK_NAME 后重试(会断开现有容器)。"
    fi
    log "  ✓ 网络 $NETWORK_NAME($existing_subnet)已存在,复用"
  else
    # 检查与宿主机已有 docker 网络是否撞网段
    local overlap
    overlap="$(docker network ls -q | while read -r nid; do
      docker network inspect "$nid" -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null
    done | grep -F "$NETWORK_SUBNET" | head -1 || true)"
    [ -n "$overlap" ] && fail "网段 $NETWORK_SUBNET 已被其他 docker 网络占用,请在 .env 中改 NETWORK_SUBNET(如 172.30.0.0/24)"
    log "  ✓ 网段 $NETWORK_SUBNET 空闲"
  fi
}

check_ports() {
  local busy=""
  if command -v ss >/dev/null 2>&1; then
    busy="$(ss -tln 2>/dev/null | awk '{print $4}' | grep -E ':(80|443)$' || true)"
  elif command -v lsof >/dev/null 2>&1; then
    busy="$(lsof -iTCP:80 -iTCP:443 -sTCP:LISTEN 2>/dev/null || true)"
  fi
  [ -n "$busy" ] && fail "端口 80/443 已被占用:"$'\n'"$busy"$'\n'"请先释放端口,或修改 compose 中 CADDY_HTTP_PORT/CADDY_HTTPS_PORT 并调整 Caddyfile。"
  log "  ✓ 端口 80/443 空闲"
  return 0
}

# ---- auto 模式:域名解析校验(直连本机 or CDN 需人工确认) ----
verify_dns_auto() {
  log "  校验域名解析($DOMAIN)..."
  [ "$TLS_MODE" = auto ] || return 0
  is_ip "$DOMAIN" && fail "auto 模式需要公网域名(Let's Encrypt 不支持 IP)。IP 部署请用 TLS_MODE=manual(自签)或内网 internal。"

  local resolved=""
  if command -v dig >/dev/null 2>&1; then
    resolved="$(dig +short A "$DOMAIN" 2>/dev/null || true)"
    resolved="$resolved $(dig +short AAAA "$DOMAIN" 2>/dev/null || true)"
  else
    resolved="$(nslookup -type=A "$DOMAIN" 2>/dev/null | awk '/^Address: /{print $2}' || true)"
  fi
  resolved="$(echo "$resolved" | tr ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ' ' | sed 's/ $//')"
  [ -n "$resolved" ] || fail "域名 $DOMAIN 无解析记录。请检查 DNS 配置;若走 CDN/内网未解析,请改用 TLS_MODE=manual。"
  log "  解析结果: $resolved"

  local pub_ip=""
  pub_ip="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 10 https://ifconfig.me 2>/dev/null || true)"
  if [ -n "$pub_ip" ]; then
    log "  本机公网出口 IP: $pub_ip"
    if echo "$resolved" | grep -qw "$pub_ip"; then
      log "  ✓ 域名直接解析到本机,自动申请 Let's Encrypt 证书"
      return 0
    fi
  else
    warn "无法获取本机公网 IP(可能无外网),跳过直连对比"
  fi

  # 非直连:打印诊断,要求人工确认
  warn "域名未直接解析到本机(可能经 CDN/代理,或记录不完整)。"
  warn "若流量确实经 CDN,Let's Encrypt ACME 验证可能失败,建议改用手动证书(TLS_MODE=manual)。"
  if [ "$CONFIRM_CDN" = "yes" ]; then
    log "  CONFIRM_CDN=yes → 人工确认(无人值守):继续使用自动证书"
  elif [ -n "$CONFIRM_CDN" ]; then
    fail "CONFIRM_CDN 仅接受 yes;请确认后重试"
  else
    for i in $(seq 1 5); do
      log "  ⚠ 是否已确认 CDN/代理会将 HTTP-01 验证与流量转发到本机? [y/N]"
      local ans=""
      read -r ans < /dev/tty || break
      case "$ans" in
        y|Y|yes|YES) log "  已确认,继续"; return 0 ;;
        *) fail "已取消。请确认解析/转发配置后重试,或改用 TLS_MODE=manual(手动证书)。" ;;
      esac
    done
    fail "未收到确认,中止"
  fi
}

# ---- 证书准备(manual 模式:openssl 自签占位 / 已有正式证书则直接使用) ----
prepare_certs() {
  [ "$TLS_MODE" = manual ] || return 0   # auto 模式证书由 Caddy 自动管理
  mkdir -p certs
  if [ -f certs/server.crt ] && [ -f certs/server.key ]; then
    log "  ✓ 检测到已有证书,直接使用: certs/server.crt + certs/server.key"
    return 0
  fi
  log "  生成自签占位证书(10 年,SAN=$DOMAIN)..."
  local san
  if is_ip "$DOMAIN"; then san="IP:$DOMAIN"; else san="DNS:$DOMAIN"; fi
  openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 3650 \
    -keyout certs/server.key -out certs/server.crt \
    -subj "/CN=$DOMAIN" -addext "subjectAltName=$san" >/dev/null 2>>"$LOG_FILE" || fail "openssl 自签证书生成失败"
  chmod 600 certs/server.key
  log "  ✓ 已生成自签占位证书"
  log "  → 正式证书替换路径: 用正式 PEM 覆盖 certs/server.crt 与 certs/server.key,然后:"
  log "    cd $DEPLOY_DIR && docker compose restart caddy"
}

# ---- .env 生成(缺失时;已有则复用,REINSTALL=yes 才覆盖) ----
write_env() {
  if [ -f .env ]; then
    if [ "$REINSTALL" = "yes" ]; then
      warn "REINSTALL=yes → 备份并重建 .env(旧 .env 存为 .env.bak)"
      [ -f .env.bak ] || cp .env .env.bak
    else
      fail "检测到 $DEPLOY_DIR/.env 已存在(疑似已部署)。
  继续部署请用 ./deploy.sh update(升级),或加 REINSTALL=yes 清除重装。"
    fi
  fi
  if [ -z "$PICOAI_ADMIN_PASSWORD" ]; then
    if [ -f .env ] && grep -q '^PICOAI_ADMIN_PASSWORD=.\+' .env 2>/dev/null; then
      : # 复用旧 .env 里的密码
    else
      PICOAI_ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 16)"
      log "  已随机生成管理员密码(部署完成后打印)"
    fi
  fi
  cat > .env <<ENV
# PicoAide 部署配置(由 deploy.sh 生成;手工修改后 docker compose up -d 生效)
# 证书模式: manual(自签占位+提示替换,默认) | auto(Caddy 自动申请 Let's Encrypt)
TLS_MODE=$TLS_MODE
DOMAIN=$DOMAIN
ADMIN_USER=$ADMIN_USER
PICOAI_ADMIN_PASSWORD=$PICOAI_ADMIN_PASSWORD
SERVER_IMAGE=$SERVER_IMAGE
NETWORK_SUBNET=$NETWORK_SUBNET
CADDY_IP=$CADDY_IP
SERVER_IP=$SERVER_IP
TZ=${TZ:-Asia/Shanghai}
ENV
  chmod 600 .env
  log "  ✓ 已生成 .env(权限 600)"
}

# ---- Caddyfile 生成(按 TLS_MODE 选模板并替换域名) ----
write_caddyfile() {
  local src
  case "$TLS_MODE" in
    auto)   src="$TEMPLATE_DIR/Caddyfile.autocert" ;;
    manual) src="$TEMPLATE_DIR/Caddyfile.manual" ;;
    *)      fail "TLS_MODE 仅支持 manual/auto,当前: $TLS_MODE" ;;
  esac
  [ -f "$src" ] || fail "缺少模板: $src(请从仓库复制 Caddyfile.* 到部署目录)"
  sed "s/picoaide\.example\.com/$DOMAIN/g" "$src" > Caddyfile
  log "  ✓ 已生成 Caddyfile(TLS_MODE=$TLS_MODE,域名=$DOMAIN)"
}

# ---- 健康等待 ----
# 域名用 --resolve 打到 127.0.0.1(本机验证);IP 直连即可
curl_health() {
  if is_ip "$DOMAIN"; then
    curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "https://$DOMAIN/healthz" 2>/dev/null || true
  else
    curl -sk -o /dev/null -w '%{http_code}' --max-time 5 \
      --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/healthz" 2>/dev/null || true
  fi
}

wait_ready() {
  log "  等待服务就绪(最多 90s)..."
  for _ in $(seq 1 30); do
    code="$(curl_health)"
    # 经 Caddy 反代 /healthz 应返回 200(无认证)
    [ "$code" = "200" ] && { log "  ✓ 服务就绪(https://$DOMAIN/healthz → 200)"; return 0; }
    sleep 3
  done
  warn "服务可能仍在启动,稍后访问确认: https://$DOMAIN/admin/"
}

# ============================================================
# 子命令
# ============================================================
cmd_install() {
  log "========== PicoAide 部署(install)=="
  [ "$TLS_MODE" = "auto" ] || [ "$TLS_MODE" = "manual" ] || fail "TLS_MODE 仅支持 manual/auto"
  [ "$DOMAIN" != "picoaide.example.com" ] || warn "域名仍为示例值 picoaide.example.com,生产前请改 DOMAIN"

  log "▶ 检查命令依赖"
  check_cmds
  log "▶ 检查私有网段与端口"
  check_network_conflict
  check_ports
  log "▶ 证书模式: $TLS_MODE"
  verify_dns_auto
  prepare_certs
  write_env
  write_caddyfile

  log "▶ 拉取镜像并启动"
  $COMPOSE pull 2>/dev/null || warn "镜像拉取失败(网络/权限),尝试直接启动"
  $COMPOSE up -d
  wait_ready
  log "========== 部署完成 =========="
  log "管理后台: https://$DOMAIN/admin/"
  log "员工登录: https://$DOMAIN"
  log "管理员账号: $ADMIN_USER"
  log "管理员密码: ${PICOAI_ADMIN_PASSWORD:-<已从 .env 读取,已有 admin 后可清空>}"
  log "数据目录: $DEPLOY_DIR/picoaide-data"
  log "证书模式: $TLS_MODE"
  case "$TLS_MODE" in
    manual) log "  当前为自签占位(正式证书替换: 覆盖 certs/server.crt+server.key → docker compose restart caddy)" ;;
    auto)   log "  Caddy 将自动签发/续期 Let's Encrypt 证书" ;;
  esac
  log "固定 IP: caddy=$CADDY_IP, server=$SERVER_IP(网段 $NETWORK_SUBNET)"
  log "提示: 登录后在 webadmin 网关页填写\"对外访问地址\" = https://$DOMAIN"
}

cmd_update() {
  log "========== PicoAide 升级(update)=="
  [ -f .env ] || fail "未发现 .env,请先执行 install(或 cd 到部署目录)"
  check_cmds
  log "▶ 拉取新镜像($SERVER_IMAGE)"
  $COMPOSE pull || warn "拉取失败(可能已是最新/无网络),尝试直接重建"
  log "▶ 重建并重启容器(数据卷不变,数据不丢)"
  $COMPOSE up -d
  wait_ready
  log "========== 升级完成 =========="
}

cmd_status() {
  [ -f "$COMPOSE_FILE" ] || fail "未发现 $COMPOSE_FILE,请 cd 到部署目录"
  $COMPOSE ps 2>&1 || true
  echo
  log "容器固定 IP:"
  for c in "$CADDY_CONTAINER" "$SERVER_CONTAINER"; do
    ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$c" 2>/dev/null || echo "<未运行>")"
    log "  $c → $ip"
  done
  if command -v curl >/dev/null 2>&1; then
    local code domain
    domain="$(grep -E '^DOMAIN=' .env 2>/dev/null | cut -d= -f2- || echo picoaide.example.com)"
    if is_ip "$domain"; then
      code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "https://$domain/healthz" 2>/dev/null || echo 000)"
    else
      code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$domain:443:127.0.0.1" "https://$domain/healthz" 2>/dev/null || echo 000)"
    fi
    log "健康检查(https://$domain/healthz): HTTP $code"
  fi
}

cmd_logs() {
  [ -f "$COMPOSE_FILE" ] || fail "未发现 $COMPOSE_FILE,请 cd 到部署目录"
  if [ "${1:-}" = "-t" ] || [ "${1:-}" = "--follow" ]; then
    $COMPOSE logs -f --tail=200
  else
    $COMPOSE logs --tail=200
  fi
}

cmd_backup() {
  local ts="$(date +%Y%m%d-%H%M%S)" outdir="$DEPLOY_DIR/deploy-backup"
  mkdir -p "$outdir"
  log "========== 备份(backup)=========="
  # 数据目录:经容器内 busybox tar 打包(避免 SQLite WAL 缺文件;含 master.key)
  if docker ps --format '{{.Names}}' | grep -qx "$SERVER_CONTAINER"; then
    docker exec "$SERVER_CONTAINER" sh -c 'tar czf - -C /data .' > "$outdir/picoaide-data-$ts.tar.gz" \
      && log "  ✓ 数据备份: $outdir/picoaide-data-$ts.tar.gz" || warn "数据备份失败"
  else
    [ -d picoaide-data ] && tar czf "$outdir/picoaide-data-$ts.tar.gz" -C . picoaide-data \
      && log "  ✓ 数据备份(离线): $outdir/picoaide-data-$ts.tar.gz" || warn "数据备份失败(容器未运行且数据目录为空?)"
  fi
  # auto 模式:Caddy 自动证书库在 ./caddy-data(当前目录 bind mount,不用命名卷)
  # 备份方式:直接拷当前目录文件(容器跑没跑都能备)
  if [ "${TLS_MODE:-manual}" = "auto" ] || grep -q '^TLS_MODE=auto' .env 2>/dev/null; then
    if [ -d caddy-data ] && [ -n "$(ls -A caddy-data 2>/dev/null)" ]; then
      tar czf "$outdir/caddy-data-$ts.tar.gz" -C . caddy-data \
        && log "  ✓ Caddy 数据备份: $outdir/caddy-data-$ts.tar.gz" || warn "Caddy 数据备份失败"
    fi
  fi
  log "恢复方式: 停服(picoaide-server 容器)后解包覆盖 picoaide-data/、caddy-data/,再 docker compose up -d"
}

cmd_uninstall() {
  log "========== 卸载(uninstall)=========="
  [ -f "$COMPOSE_FILE" ] || fail "未发现 $COMPOSE_FILE"
  if [ "${1:-}" = "--volumes" ]; then
    if [ "$UNINSTALL_VOLUMES" != "yes" ]; then
      read -r -p "(交互)确认删除当前目录全部数据(picoaide-data/ caddy-data/ caddy-config/ certs/)? [y/N] " ans < /dev/tty || ans=n
      case "$ans" in y|Y|yes|YES) ;; *) fail "已取消" ;; esac
    fi
    $COMPOSE down --remove-orphans
    rm -rf picoaide-data caddy-data caddy-config
    log "  ✓ 已停止容器并删除数据目录(picoaide-data/ caddy-data/ caddy-config/;配置文件 .env/Caddyfile 保留)"
  else
    $COMPOSE down --remove-orphans
    log "  ✓ 已停止容器(数据目录保留: picoaide-data/ caddy-data/ caddy-config/)"
  fi
}

# ============================================================
# 入口
# ============================================================
CMD="${1:-}"
[ $# -gt 0 ] && shift || true
case "$CMD" in
  install)   cmd_install ;;
  update)    cmd_update ;;
  status)    cmd_status ;;
  logs)      cmd_logs "$@" ;;
  backup)    cmd_backup ;;
  uninstall) cmd_uninstall "$@" ;;
  *)
    cat >&2 <<EOF
用法: $(basename "$0") <install|update|status|logs|backup|uninstall> [参数]

  install        首次部署(自动: 命令检查→网段/端口检查→证书→.env→启动)
  update         升级镜像并重启(数据不丢)
  status         容器状态 + 健康检查 + 固定 IP
  logs [-t]      查看日志(--tail=200;-t=跟踪)
  backup         备份数据 + auto 模式 Caddy 证书
  uninstall [--volumes]  卸载(--volumes 连同数据卷删除,需确认)

环境变量见脚本头部注释(如 DOMAIN/TLS_MODE/PICOAI_ADMIN_PASSWORD/CONFIRM_CDN)。
EOF
    exit 1 ;;
esac
