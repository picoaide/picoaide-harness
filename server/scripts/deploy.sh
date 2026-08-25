#!/usr/bin/env bash
# ============================================================
# PicoAide 服务端自动化部署脚本
# ============================================================
# 用法:
#   ./scripts/deploy.sh install          # 首次部署(非交互,环境变量驱动)
#   ./scripts/deploy.sh update           # 升级镜像并重启(数据不丢)
#   ./scripts/deploy.sh status           # 查看容器状态 + 健康检查 + 固定 IP
#   ./scripts/deploy.sh logs [-t]        # 查看日志(--tail=200;-t/--follow 跟踪)
#   ./scripts/deploy.sh backup           # 备份数据(picoaide-data + caddy-data 证书库;pg 模式含 pg_dump)
#   ./scripts/deploy.sh migrate [--dry-run]   # 把已有 sqlite 数据迁移到 PostgreSQL(见 cmd_migrate)
#   ./scripts/deploy.sh uninstall        # 卸载(停容器;--volumes 全删数据目录,需确认)
#
# 数据库后端(DB_MODE):
#   sqlite(默认) | pg(内置 postgres 容器,叠加 docker-compose.pg.yml) |
#   pg-external(已有 PostgreSQL 实例,叠加 docker-compose.pg-ext.yml)
#   pg 两种模式需含 -db-driver 支持的服务端镜像(发布 0.5.0+ 或 make docker-image 本地构建);
#   sqlite→pg 数据迁移: ./deploy.sh migrate(migrate 子命令要求 .env 已配 DB_MODE=pg* + PG_DSN)
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
#   DB_MODE           sqlite(默认) | pg | pg-external
#   PG_PASSWORD       pg 模式:内置 postgres 容器密码(缺省随机生成并写入 .env)
#   PG_DSN            pg-external 必填;pg 模式由脚本生成(postgres://picoaide:<pw>@postgres:5432/picoaide)
#   PG_IMAGE          pg 模式内置镜像(默认 postgres:16-alpine)
#   PG_IP             pg 容器固定 IP(默认 172.28.0.4)
#   MIGRATE=yes       migrate 子命令无人值守确认(跳过交互确认)
#   CONFIRM_CDN       auto 模式:域名解析不直连本机(疑似 CDN/代理)时,
#                     交互确认;无人值守设 CONFIRM_CDN=yes 直接继续
#   REINSTALL=yes     .env 已存在时清除旧部署重装(默认安全退出)
#   UNINSTALL_VOLUMES=yes  uninstall --volumes 无人值守确认(删除数据目录)
# 注意:依赖(docker/compose/curl/jq/openssl/dns 工具)自动安装由 install-server.sh 负责;
#   直接运行本脚本需先自行安装 REQUIRED_CMDS 中的命令,缺失即报错退出(绝不带病执行)。
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
DB_MODE="${DB_MODE:-}"
PG_PASSWORD="${PG_PASSWORD:-}"
PG_DSN="${PG_DSN:-}"
PG_IMAGE="${PG_IMAGE:-}"
PG_IP="${PG_IP:-}"
MIGRATE="${MIGRATE:-}"
CADDY_HTTP_PORT="${CADDY_HTTP_PORT:-}"
CADDY_HTTPS_PORT="${CADDY_HTTPS_PORT:-}"
TZ="${TZ:-}"

# 优先级:环境变量 > 已存在 .env > 内置默认(下面赋值)
# 只读非敏感部署变量;PICOAI_ADMIN_PASSWORD 不在此加载(由 compose 读取 .env,避免 shell 环境暴露明文)
if [ -f "$DEPLOY_DIR/.env" ]; then
  while IFS='=' read -r key val; do
    case "$key" in
      TLS_MODE|DOMAIN|ADMIN_USER|SERVER_IMAGE|NETWORK_SUBNET|CADDY_IP|SERVER_IP|TZ|DB_MODE|PG_PASSWORD|PG_DSN|PG_IMAGE|PG_IP|MIGRATE|CADDY_HTTP_PORT|CADDY_HTTPS_PORT)
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
DB_MODE="${DB_MODE:-sqlite}"
PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"
PG_IP="${PG_IP:-172.28.0.4}"
TZ="${TZ:-Asia/Shanghai}"
CADDY_HTTP_PORT="${CADDY_HTTP_PORT:-80}"
CADDY_HTTPS_PORT="${CADDY_HTTPS_PORT:-443}"
CADDY_CONTAINER="picoaide-caddy"
SERVER_CONTAINER="picoaide-server"
PG_CONTAINER="picoaide-postgres"
NETWORK_NAME="picoaide-net"

log()  { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "$LOG_FILE"; }
warn() { log "警告: $*"; }
fail() { log "错误: $*"; exit 1; }

# mask_dsn 掩码 PostgreSQL DSN 中的密码(bash 的 ${DSN%%@*@} 会保留整个含密码
# 前缀——实测输出完整 DSN,审计 2026-08-25 B-01 曾致密码明文进日志)。只按
# postgres://user:pw@host 形态掩码;非该形态原样返回(不误报)。
mask_dsn() {
  sed -E 's#(://[^:@/]+:)[^@/]+@#\1***@#' <<<"$1"
}

# 数据库后端 → compose override 文件(COMPOSE_FILE 叠加,全部子命令自动生效)
case "$DB_MODE" in
  sqlite) : ;;
  pg) COMPOSE_FILE="${COMPOSE_FILE}:$(dirname "$COMPOSE_FILE")/docker-compose.pg.yml" ;;
  pg-external) COMPOSE_FILE="${COMPOSE_FILE}:$(dirname "$COMPOSE_FILE")/docker-compose.pg-ext.yml" ;;
  *) fail "DB_MODE 仅支持 sqlite/pg/pg-external,当前: $DB_MODE" ;;
esac
export COMPOSE_FILE

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
    busy="$(ss -tln 2>/dev/null | awk '{print $4}' | grep -E ":($CADDY_HTTP_PORT|$CADDY_HTTPS_PORT)$" || true)"
  elif command -v lsof >/dev/null 2>&1; then
    busy="$(lsof -iTCP:$CADDY_HTTP_PORT -iTCP:$CADDY_HTTPS_PORT -sTCP:LISTEN 2>/dev/null || true)"
  fi
  [ -n "$busy" ] && fail "端口 $CADDY_HTTP_PORT/$CADDY_HTTPS_PORT 已被占用:"$'\n'"$busy"$'\n'"请先释放端口,或修改 .env 的 CADDY_HTTP_PORT/CADDY_HTTPS_PORT 并调整 Caddyfile。"
  log "  ✓ 端口 $CADDY_HTTP_PORT/$CADDY_HTTPS_PORT 空闲"
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
  # ---- PG 后端字段 ----
  if [ "$DB_MODE" = "pg" ]; then
    if [ -z "$PG_PASSWORD" ]; then
      if [ -f .env ] && grep -q '^PG_PASSWORD=.\+' .env 2>/dev/null; then
        : # 复用旧 .env 里的 PG 密码
      else
        PG_PASSWORD="$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 16)"
        log "  已随机生成 PostgreSQL 密码(部署完成后写入 .env)"
      fi
    fi
    [ -z "$PG_DSN" ] && PG_DSN="postgres://picoaide:${PG_PASSWORD}@postgres:5432/picoaide"
  elif [ "$DB_MODE" = "pg-external" ]; then
    [ -n "$PG_DSN" ] || fail "DB_MODE=pg-external 必须提供 PG_DSN(如 postgres://user:pass@host:5432/db)"
    case "$PG_DSN" in
      postgres://*|postgresql://*|*host=*|*hostaddr=*) : ;;
      *) fail "PG_DSN 格式不合法(需 postgres:// 或 keyword 形式)" ;;
    esac
  fi
  cat > .env <<ENV
# PicoAide 部署配置(由 deploy.sh 生成;手工修改后 docker compose up -d 生效)
# 证书模式: manual(自签占位+提示替换,默认) | auto(Caddy 自动申请 Let's Encrypt)
# 数据库后端: sqlite(默认) | pg(内置 postgres 容器) | pg-external(已有 PostgreSQL 实例)
TLS_MODE=$TLS_MODE
DOMAIN=$DOMAIN
ADMIN_USER=$ADMIN_USER
PICOAI_ADMIN_PASSWORD=$PICOAI_ADMIN_PASSWORD
SERVER_IMAGE=$SERVER_IMAGE
NETWORK_SUBNET=$NETWORK_SUBNET
CADDY_IP=$CADDY_IP
SERVER_IP=$SERVER_IP
CADDY_HTTP_PORT=$CADDY_HTTP_PORT
CADDY_HTTPS_PORT=$CADDY_HTTPS_PORT
TZ=${TZ:-Asia/Shanghai}
DB_MODE=$DB_MODE
PG_PASSWORD=$PG_PASSWORD
PG_DSN=$PG_DSN
PG_IMAGE=$PG_IMAGE
PG_IP=$PG_IP
ENV
  chmod 600 .env
  log "  ✓ 已生成 .env(权限 600)"
}

# ---- Caddyfile 生成(按 TLS_MODE 选模板并替换域名) ----
write_caddyfile() {
  local src
  case "$TLS_MODE" in
    auto)     src="$TEMPLATE_DIR/Caddyfile.autocert" ;;
    manual)   src="$TEMPLATE_DIR/Caddyfile.manual" ;;
    # 审计 2026-08-25 E-02:internal = 仓库默认 Caddyfile(tls internal 自签),
    # 供纯内网/沙箱开箱即用;与占位域名 fail 校验配合,强制显式确认。
    internal) src="$TEMPLATE_DIR/Caddyfile" ;;
    *)        fail "TLS_MODE 仅支持 auto/manual/internal,当前: $TLS_MODE" ;;
  esac
  [ -f "$src" ] || fail "缺少模板: $src(请从仓库复制 Caddyfile.* 到部署目录)"
  sed "s/picoaide\.example\.com/$DOMAIN/g" "$src" > Caddyfile
  log "  ✓ 已生成 Caddyfile(TLS_MODE=$TLS_MODE,域名=$DOMAIN)"
}

# ---- 健康等待 ----
# 域名用 --resolve 打到 127.0.0.1(本机验证);IP 直连即可;端口用 .env 的可配置端口
curl_health() {
  local code
  if is_ip "$DOMAIN"; then
    code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "https://$DOMAIN:$CADDY_HTTPS_PORT/healthz" 2>/dev/null || true)"
  else
    code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 \
      --resolve "$DOMAIN:$CADDY_HTTPS_PORT:127.0.0.1" "https://$DOMAIN:$CADDY_HTTPS_PORT/healthz" 2>/dev/null || true)"
  fi
  echo "${code:-000}"
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
  [ "$TLS_MODE" = "auto" ] || [ "$TLS_MODE" = "manual" ] || [ "$TLS_MODE" = "internal" ] || fail "TLS_MODE 仅支持 auto/manual/internal"
  # 审计 2026-08-25 E-02:占位域名只 warn 会在生产误用自签证书+占位域名而不自知;
  # 改为 fail(显式 ALLOW_PLACEHOLDER_DOMAIN=yes 可跳过,供内部沙箱测试)。
  if [ "$DOMAIN" = "picoaide.example.com" ] && [ "${ALLOW_PLACEHOLDER_DOMAIN:-}" != "yes" ]; then
    fail "DOMAIN 仍为示例值 picoaide.example.com —— 请修改 .env 中 DOMAIN 为你的真实域名/IP(内部自签部署请在 .env 设 ALLOW_PLACEHOLDER_DOMAIN=yes 并显式确认)"
  fi

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
  BASE_URL="https://$DOMAIN"; [ "$CADDY_HTTPS_PORT" != "443" ] && BASE_URL="$BASE_URL:$CADDY_HTTPS_PORT"
  log "管理后台: $BASE_URL/admin/"
  log "员工登录: $BASE_URL"
  log "管理员账号: $ADMIN_USER"
  log "管理员密码: ${PICOAI_ADMIN_PASSWORD:-<已从 .env 读取,已有 admin 后可清空>}"
  log "数据目录: $DEPLOY_DIR/picoaide-data"
  log "证书模式: $TLS_MODE"
  case "$TLS_MODE" in
    manual) log "  当前为自签占位(正式证书替换: 覆盖 certs/server.crt+server.key → docker compose restart caddy)" ;;
    auto)   log "  Caddy 将自动签发/续期 Let's Encrypt 证书" ;;
  esac
  log "固定 IP: caddy=$CADDY_IP, server=$SERVER_IP(网段 $NETWORK_SUBNET)"
  case "$DB_MODE" in
    sqlite) log "数据库: SQLite($DEPLOY_DIR/picoaide-data/picoaide.db;备份 $DEPLOY_DIR/picoaide-data)" ;;
    pg)
      log "数据库: PostgreSQL(内置容器 $PG_CONTAINER,IP $PG_IP,数据 $DEPLOY_DIR/pg-data)"
      log "  DSN: postgres://picoaide:***@postgres:5432/picoaide"
      log "  备份: ./deploy.sh backup(pg_dump)或停服后拷 pg-data/;镜像需含 -db-driver 支持" ;;
    pg-external)
      log "数据库: PostgreSQL(外部实例;数据备份由外部 PG 运维策略负责)"
      log "  DSN: $(mask_dsn "$PG_DSN") (密码已掩码)" ;;
  esac
  log "提示: 登录后在 webadmin 网关页填写\"对外访问地址\" = $BASE_URL"
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
  [ -f "$DEPLOY_DIR/docker-compose.yml" ] || fail "未发现 $DEPLOY_DIR/docker-compose.yml,请 cd 到部署目录"
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
      code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "https://$domain:$CADDY_HTTPS_PORT/healthz" 2>/dev/null || true)"
    else
      code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 --resolve "$domain:$CADDY_HTTPS_PORT:127.0.0.1" "https://$domain:$CADDY_HTTPS_PORT/healthz" 2>/dev/null || true)"
    fi
    [ -z "$code" ] && code="000"
    log "健康检查(https://$domain:$CADDY_HTTPS_PORT/healthz): HTTP $code"
  fi
}

cmd_logs() {
  [ -f "$DEPLOY_DIR/docker-compose.yml" ] || fail "未发现 $DEPLOY_DIR/docker-compose.yml,请 cd 到部署目录"
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
  # PostgreSQL 模式:pg_dump 自定义格式(运行中安全,含 schema+数据)
  if [ "$DB_MODE" = "pg" ] && docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
    if docker exec "$PG_CONTAINER" sh -c 'command -v pg_dump >/dev/null 2>&1'; then
      docker exec "$PG_CONTAINER" pg_dump -U picoaide -Fc picoaide > "$outdir/pg-data-$ts.dump" \
        && log "  ✓ PostgreSQL 备份(pg_dump): $outdir/pg-data-$ts.dump" \
        && log "    恢复: docker exec -i $PG_CONTAINER pg_restore -U picoaide -d picoaide < $outdir/pg-data-$ts.dump" \
        || warn "pg_dump 备份失败"
    else
      warn "容器内无 pg_dump,跳过线上备份;可停服后拷贝 pg-data/ 目录冷备"
    fi
  elif [ "$DB_MODE" = "pg" ]; then
    [ -d pg-data ] && tar czf "$outdir/pg-data-$ts.tar.gz" -C . pg-data \
      && log "  ✓ PostgreSQL 数据备份(离线): $outdir/pg-data-$ts.tar.gz" || warn "pg 数据备份失败(容器未运行且目录为空?)"
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
  [ "$DB_MODE" = "pg" ] && log "  PostgreSQL 数据恢复: 用上条 pg_restore 命令(或停服后恢复 pg-data/ 冷备)"
}

# ---- sqlite → PostgreSQL 数据迁移 ----
# 前提:.env 的 DB_MODE=pg(内置容器)或 pg-external(已有实例,需 PG_DSN);
#   也可 DB_MODE=pg ./deploy.sh migrate(环境变量优先,迁移后写入 .env)。
# 流程: --dry-run 行数预览 → 交互确认/MIGRATE=yes → 起 postgres → 停 server
#       → 清空目标表(pg 容器 psql / 外部 psql) → 迁移镜像执行
#       → .env 的 DB_MODE 改为 pg → up -d → 健康等待。
# 迁移后原 sqlite 文件保留(回滚点):恢复 = .env 改回 DB_MODE=sqlite 并 up -d。
cmd_migrate() {
  local dry_run=0
  if [ "${1:-}" = "--dry-run" ]; then dry_run=1; shift; fi
  log "========== SQLite → PostgreSQL 迁移(migrate)=========="
  [ "$DB_MODE" = "pg" ] || [ "$DB_MODE" = "pg-external" ] || fail "migrate 需要 DB_MODE=pg 或 pg-external(.env 配置后重试,或 DB_MODE=pg ./deploy.sh migrate)"
  [ -f picoaide-data/picoaide.db ] || fail "未找到 picoaide-data/picoaide.db(没有可迁移的 SQLite 数据)"
  command -v docker >/dev/null 2>&1 || fail "缺少 docker"
  docker inspect "$SERVER_IMAGE" >/dev/null 2>&1 || docker pull "$SERVER_IMAGE" >/dev/null 2>&1 || fail "无法获取镜像 $SERVER_IMAGE(须含 migrate-sqlite-pg 工具 / -db-driver 支持,0.5.0+ 或本地构建)"

  # ---- 目标模式参数(内置容器:缺省生成 PG_PASSWORD/PG_DSN 并写入 .env) ----
  if [ "$DB_MODE" = "pg-external" ]; then
    [ -n "$PG_DSN" ] || fail "DB_MODE=pg-external 需要 PG_DSN(如 postgres://user:pass@host:5432/db)"
  else
    [ -n "$PG_PASSWORD" ] || PG_PASSWORD="$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 16)"
    [ -n "$PG_DSN" ] || PG_DSN="postgres://picoaide:${PG_PASSWORD}@postgres:5432/picoaide"
    # 把生成的密码/DSN 补进 .env(幂等:已有则不重复追加;供后续 compose up 读取)
    ensure_env_key() { # key value —— 不存在才追加
      local k="$1" v="$2"
      grep -q "^$k=" .env && sed -i "s|^$k=.*|$k=$v|" .env || printf '%s=%s\n' "$k" "$v" >> .env
    }
    ensure_env_key PG_PASSWORD "$PG_PASSWORD"
    ensure_env_key PG_DSN "$PG_DSN"
    ensure_env_key PG_IMAGE "$PG_IMAGE"
    ensure_env_key PG_IP "$PG_IP"
    chmod 600 .env
  fi
  # 迁移后的 compose 必须叠加 pg override(脚本顶部按 sqlite 算的 COMPOSE_FILE 在此覆盖)
  COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml:$DEPLOY_DIR/docker-compose.pg.yml"
  [ "$DB_MODE" = "pg-external" ] && COMPOSE_FILE="$DEPLOY_DIR/docker-compose.yml:$DEPLOY_DIR/docker-compose.pg-ext.yml"
  export COMPOSE_FILE

  log "源: picoaide-data/picoaide.db"
  log "目标: $(mask_dsn "$PG_DSN") (密码已掩码);模式: $DB_MODE"

  local run_mig=()
  run_mig=(docker run --rm --entrypoint /app/migrate-sqlite-pg)
  run_mig+=(-v "$DEPLOY_DIR/picoaide-data:/src:ro")
  # 内置容器模式:必须加入 picoaide-net,才能用服务名 postgres 解析到 PG 容器;
  # 外部模式:默认网络 + PG_DSN 主机名(用户给的公网/内网地址)
  [ "$DB_MODE" = "pg" ] && run_mig+=(--network "$NETWORK_NAME")
  run_mig+=("$SERVER_IMAGE" -sqlite /src/picoaide.db -pg-dsn "$PG_DSN")

  # 内置容器模式:先拉起 postgres(dry-run/迁移工具都需要它可达);等 healthy
  if [ "$DB_MODE" = "pg" ]; then
    log "▶ 启动 postgres 容器($PG_IMAGE)..."
    $COMPOSE up -d postgres
    log "  等待 postgres 就绪(最多 60s)..."
    for _ in $(seq 1 20); do
      if [ "$($COMPOSE ps -q postgres 2>/dev/null)" != "" ] && docker inspect -f '{{.State.Health.Status}}' "$PG_CONTAINER" 2>/dev/null | grep -q healthy; then
        log "  ✓ postgres 就绪"
        break
      fi
      sleep 3
    done
  fi

  if [ "$dry_run" = 1 ]; then
    log "▶ 预览(dry-run:只统计行数,不写入)..."
    "${run_mig[@]}" -dry-run || fail "dry-run 失败(检查 PG_DSN/网络/镜像是否含迁移工具)"
    log "  ✓ 以上为各表行数;确认后执行: ./deploy.sh migrate(建议先 ./deploy.sh backup)"
    return 0
  fi

  if [ "$MIGRATE" != "yes" ]; then
    read -r -p "(交互)确认迁移? 目标库将被清空;建议先 ./deploy.sh backup [y/N] " ans < /dev/tty || ans=n
    case "$ans" in y|Y|yes|YES) ;; *) fail "已取消" ;; esac
  fi

  log "▶ 停止 server(保证 SQLite 一致性)..."
  $COMPOSE stop "$SERVER_CONTAINER" >/dev/null 2>&1 || true

  log "▶ 清空目标库表(TRUNCATE ... CASCADE;新库无表时忽略错误)..."
  # 审计 2026-08-25 B-03:清单曾缺 shared_skills/shared_skill_grants/
  # agent_presets/agent_preset_grants/kb_audit_logs/schema_migrations,
  # 迁移后遗留旧数据或 schema_migrations 冲突。此处与服务端 migrations-pg
  # 的 CREATE TABLE 全集对齐(新增表须同步更新)。
  local tables="users, groups, user_groups, settings, api_tokens, gateway_providers, models, usage, skills, admin_sessions, skill_grants, audit_logs, kb_audit_logs, agent_presets, shared_skills, shared_skill_grants, agent_preset_grants, schema_migrations"
  local trunc="TRUNCATE TABLE $tables CASCADE"
  if [ "$DB_MODE" = "pg" ]; then
    docker exec "$PG_CONTAINER" psql -U picoaide -d picoaide -c "$trunc" >/dev/null 2>&1 \
      && log "  ✓ 已清空目标库表(内置容器)" || log "  · 目标库为空/表不存在(忽略,继续)"
  else
    docker run --rm --network host --entrypoint psql "$PG_IMAGE" "$PG_DSN" -c "$trunc" >/dev/null 2>&1 \
      && log "  ✓ 已清空目标库表(外部实例)" || log "  · 目标库为空/无权限(忽略,继续;若已有数据将被跳过可能导致迁移失败)"
  fi

  log "▶ 执行迁移(写入 PostgreSQL)..."
  "${run_mig[@]}" || fail "迁移失败(可重试:目标表保持空闲后重新执行;SQLite 数据未动)"

  log "▶ 写入 .env: DB_MODE → $DB_MODE ..."
  local tmp
  tmp="$(mktemp)"
  awk -v m="$DB_MODE" '/^DB_MODE=/{print "DB_MODE=" m; next} {print}' .env > "$tmp" && mv "$tmp" .env
  grep -q '^DB_MODE=' .env || printf 'DB_MODE=%s\n' "$DB_MODE" >> .env
  chmod 600 .env

  log "▶ 以 PostgreSQL 后端重启..."
  $COMPOSE up -d
  wait_ready
  log "========== 迁移完成 =========="
  log "数据已迁移到 PostgreSQL;原 SQLite 文件保留(picoaide-data/picoaide.db,回滚点)"
  log "回滚: .env 改回 DB_MODE=sqlite → docker compose up -d(数据仍在 sqlite 中)"
  log "注意: master.key 不变(在 ./picoaide-data/master.key,加密凭证仍可解密)"
  return 0
}

cmd_uninstall() {
  log "========== 卸载(uninstall)=========="
  [ -f "$DEPLOY_DIR/docker-compose.yml" ] || fail "未发现 $DEPLOY_DIR/docker-compose.yml"
  if [ "${1:-}" = "--volumes" ]; then
    if [ "$UNINSTALL_VOLUMES" != "yes" ]; then
      read -r -p "(交互)确认删除当前目录全部数据(picoaide-data/ caddy-data/ caddy-config/ certs/ pg-data/)? [y/N] " ans < /dev/tty || ans=n
      case "$ans" in y|Y|yes|YES) ;; *) fail "已取消" ;; esac
    fi
    $COMPOSE down --remove-orphans
    rm -rf picoaide-data caddy-data caddy-config pg-data
    log "  ✓ 已停止容器并删除数据目录(picoaide-data/ caddy-data/ caddy-config/ pg-data/;配置文件 .env/Caddyfile 保留)"
  else
    $COMPOSE down --remove-orphans
    log "  ✓ 已停止容器(数据目录保留: picoaide-data/ caddy-data/ caddy-config/ pg-data/)"
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
  migrate)   cmd_migrate "$@" ;;
  uninstall) cmd_uninstall "$@" ;;
  *)
    cat >&2 <<EOF
用法: $(basename "$0") <install|update|status|logs|backup|migrate|uninstall> [参数]

  install        首次部署(自动: 命令检查→网段/端口检查→证书→.env→启动)
  update         升级镜像并重启(数据不丢)
  status         容器状态 + 健康检查 + 固定 IP
  logs [-t]      查看日志(--tail=200;-t=跟踪)
  backup         备份数据 + auto 模式 Caddy 证书(+ pg 模式 pg_dump)
  migrate [--dry-run]  SQLite→PostgreSQL 数据迁移(需 DB_MODE=pg|pg-external;--dry-run 只统计)
  uninstall [--volumes]  卸载(--volumes 连同数据卷删除,需确认)

环境变量见脚本头部注释(如 DOMAIN/TLS_MODE/DB_MODE/PG_DSN/PICOAI_ADMIN_PASSWORD/CONFIRM_CDN)。
EOF
    exit 1 ;;
esac
