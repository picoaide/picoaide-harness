#!/usr/bin/env bash
# ============================================================
# PicoAide 服务端 oh-my-zsh 式一键部署安装器
# ============================================================
# 单命令安装(自动提权/按发行版装依赖/交互收集配置/复用 deploy.sh 部署):
#   sh -c "$(curl -fsSL https://raw.githubusercontent.com/picoaide/picoaide-harness/master/server/scripts/install-server.sh)"
# 非交互(全部配置用环境变量):
#   curl -fsSL <本脚本地址> | sudo DOMAIN=picoaide.example.com ADMIN_PASS=your-strong-password \
#     DB_MODE=sqlite bash
#
# 环境变量(全部可选,均有默认值;交互模式可省略,由脚本经 /dev/tty 询问):
#   DOMAIN            对外域名或 IP(生产必改;交互时会询问,非交互必须提供)
#   INSTALL_DIR       部署目录(默认 /data/picoaide/deploy;兼容旧版 DEPLOY_DIR)
#   DB_MODE           数据库后端: sqlite(默认) | pg(内置 postgres 容器) | pg-external(已有实例)
#   PG_PASSWORD       pg 模式:内置 postgres 密码(缺省随机生成并写入 .env)
#   PG_DSN            pg-external 必填(如 postgres://user:pass@host:5432/db)
#   ADMIN_USER        超管用户名(默认 admin)
#   ADMIN_PASS        超管密码(默认随机生成;兼容 PICOAI_ADMIN_PASSWORD)
#   TLS_MODE          证书模式: manual(默认,自签占位+提示替换) | auto(Let's Encrypt)
#   SERVER_IMAGE      服务端镜像(默认 ghcr.io/picoaide/picoaide-server:latest)
#   REINSTALL=yes     已存在部署时清除重装(默认安全退出)
#   SKIP_DEPS=1       跳过依赖自动安装(仅检查已装命令,缺失即提示并退出)
#   SKIP_IMAGE_CHECK=1 跳过"镜像是否含 -db-driver 支持"探测(pg 模式)
#   DOCKER_MIRROR     安装 docker 时使用的镜像源(如 https://mirrors.tuna.tsinghua.edu.cn/docker-ce)
#   DEPLOY_BASE_URL   资产下载基址(默认 https://raw.githubusercontent.com/picoaide/picoaide-harness/master/server)
#   MIRROR_URL        通用镜像加速(如 https://mirrors.aliyun.com,curl/apt/docker 取源)
#   NO_DEPS           同 SKIP_DEPS(兼容)
# ============================================================
set -euo pipefail

# ---- 路径与默认值 ----
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="${INSTALL_DIR:-${DEPLOY_DIR:-/data/picoaide/deploy}}"
DOMAIN="${DOMAIN:-}"
DB_MODE="${DB_MODE:-sqlite}"
PG_PASSWORD="${PG_PASSWORD:-}"
PG_DSN="${PG_DSN:-}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-${PICOAI_ADMIN_PASSWORD:-}}"
TLS_MODE="${TLS_MODE:-manual}"
SERVER_IMAGE="${SERVER_IMAGE:-ghcr.io/picoaide/picoaide-server:latest}"
REINSTALL="${REINSTALL:-}"
SKIP_DEPS="${SKIP_DEPS:-${NO_DEPS:-}}"
SKIP_IMAGE_CHECK="${SKIP_IMAGE_CHECK:-}"
DOCKER_MIRROR="${DOCKER_MIRROR:-}"
MIRROR_URL="${MIRROR_URL:-}"
DEPLOY_BASE_URL="${DEPLOY_BASE_URL:-https://raw.githubusercontent.com/picoaide/picoaide-harness/master/server}"

ASSETS="docker-compose.yml Caddyfile.autocert Caddyfile.manual .env.example docker-compose.pg.yml docker-compose.pg-ext.yml"
DEPLOY_SH="$SCRIPT_DIR/deploy.sh"
SUDO=""
LOG_FILE="${LOG_FILE:-/tmp/picoaide-install.log}"
[ -e "$LOG_FILE" ] || : > "$LOG_FILE"

log()  { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*" | tee -a "$LOG_FILE"; }
warn() { log "警告: $*"; }
fail() { log "错误: $*"; exit 1; }

# ============================================================
# 阶段 1:自检与提权
# ============================================================
step1_elevate() {
  log "▶ [1/6] 自检与提权"
  command -v bash >/dev/null 2>&1 || fail "需要 bash"
  if [ "$(id -u)" = 0 ]; then
    log "  ✓ 已是 root,无需提权"
    SUDO=""
    return
  fi
  # 非 root:有 tty 用 sudo -v;无 tty 提示用 sudo bash(oh-my-zsh 同款哲学)
  if [ -t 0 ]; then
    if command -v sudo >/dev/null 2>&1 && sudo -v < /dev/tty 2>/dev/null; then
      log "  ✓ 已通过 sudo 验证(后续特权操作使用 sudo)"
      SUDO="sudo -E"
    else
      fail "sudo 不可用或验证失败,请以 root/sudo 执行: curl -fsSL <本脚本> | sudo bash"
    fi
  else
    fail "非 root 且无交互终端。请用 root 执行: curl -fsSL <本脚本> | sudo bash"
  fi
}

# ============================================================
# 阶段 2:系统探测(发行版/包管理器)
# ============================================================
PKG=""
DNS_PKG=""       # DNS 工具包名(按发行版)
NET_PKG=""       # 端口检测工具包名(按发行版)
detect_distro() {
  log "▶ [2/6] 系统探测"
  if [ -r /etc/os-release ]; then
    . /etc/os-release
    ID="${ID:-unknown}"; ID_LIKE="${ID_LIKE:-}"
  else
    ID="unknown"; ID_LIKE=""
  fi
  log "  发行版: $ID${ID_LIKE:+ (likes: $ID_LIKE)}"
  # ID 或 ID_LIKE 命中即视为该类(ID_LIKE 可能是空格分隔的多词)
  case " $ID $ID_LIKE " in
    *" ubuntu "*|*" debian "*)
      PKG="apt"; DNS_PKG="dnsutils"; NET_PKG="iproute2"; log "  ✓ 包管理器: apt" ;;
    *" rhel "*|*" fedora "*|*" almalinux "*|*" rocky "*|*" centos "*)
      PKG="dnf"; DNS_PKG="bind-utils"; NET_PKG="iproute"; log "  ✓ 包管理器: dnf" ;;
    *" alpine "*)
      PKG="apk"; DNS_PKG="bind-tools"; NET_PKG="iproute2"; log "  ✓ 包管理器: apk" ;;
    *" opensuse "*|*" sles "*)
      PKG="zypper"; DNS_PKG="bind-utils"; NET_PKG="iproute2"; log "  ✓ 包管理器: zypper" ;;
    *)
      case "$ID" in
        centos) PKG="yum"; DNS_PKG="bind-utils"; NET_PKG="iproute"; log "  ✓ 包管理器: yum" ;;
        *) fail "未知发行版($ID)。请手动安装 docker/compose/curl/jq/openssl/dns 工具后运行,或参考 docs/DEPLOY.md" ;;
      esac ;;
  esac
  case "$PKG" in
    apt) [ -n "$MIRROR_URL" ] && warn "检测到 MIRROR_URL,apt 源请自行替换 /etc/apt/sources.list(如需加速)" || true ;;
  esac
}

# ============================================================
# 阶段 3:依赖自动安装
# ============================================================
install_if_missing() {
  local cmd="$1" pkg="$2" desc="$3"
  if command -v "$cmd" >/dev/null 2>&1; then
    log "  ✓ 已存在: $cmd"
  else
    log "  安装 $desc($pkg)..."
    case "$PKG" in
      apt) $SUDO apt-get update -qq >/dev/null 2>&1 || true; DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq "$pkg" >/dev/null 2>&1 || fail "安装 $pkg 失败,请手动: sudo apt-get install -y $pkg" ;;
      dnf) $SUDO dnf install -y -q "$pkg" >/dev/null 2>&1 || fail "安装 $pkg 失败,请手动: sudo dnf install -y $pkg" ;;
      yum) $SUDO yum install -y -q "$pkg" >/dev/null 2>&1 || fail "安装 $pkg 失败,请手动: sudo yum install -y $pkg" ;;
      apk) $SUDO apk add --no-cache "$pkg" >/dev/null 2>&1 || fail "安装 $pkg 失败,请手动: sudo apk add $pkg" ;;
      zypper) $SUDO zypper -n install "$pkg" >/dev/null 2>&1 || fail "安装 $pkg 失败,请手动: sudo zypper -n install $pkg" ;;
      *) fail "未知包管理器" ;;
    esac
    command -v "$cmd" >/dev/null 2>&1 || fail "$cmd 安装后仍不可用"
  fi
}

ensure_docker() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    log "  ✓ docker 可用($(docker --version 2>/dev/null | head -1))"
  elif command -v docker >/dev/null 2>&1; then
    log "  ?? docker 命令存在但 daemon 不可达(可能未启动/组未生效)"
  else
    log "  安装 docker(docker.com 官方安装脚本)..."
    local installer
    installer="$(mktemp)"
    if ! curl -fsSL -o "$installer" "https://get.docker.com" 2>/dev/null; then
      fail "下载 docker 安装脚本失败。请手动安装: curl -fsSL https://get.docker.com | sudo sh(或使用发行版仓库)"
    fi
    if [ -n "$DOCKER_MIRROR" ]; then
      log "  使用镜像源安装 docker: (由官方脚本 + DOWNLOAD_URL=$DOCKER_MIRROR 支持)"
      DOWNLOAD_URL="$DOCKER_MIRROR" $SUDO sh "$installer" >/dev/null 2>&1 || {
        warn "官方脚本失败,尝试发行版仓库..."
        ensure_docker_distro
      }
    else
      $SUDO sh "$installer" >/dev/null 2>&1 || {
        warn "官方脚本失败,尝试发行版仓库..."
        ensure_docker_distro
      }
    fi
    rm -f "$installer"
    command -v docker >/dev/null 2>&1 || fail "docker 安装后仍不可用,请手动: curl -fsSL https://get.docker.com | sudo sh"
  fi
  # compose 插件检查
  docker compose version >/dev/null 2>&1 || fail "docker compose 插件不可用。请安装: ${PKG}-install docker-compose-plugin(或重新登录后重试)"
  log "  ✓ docker compose 可用"
  # 非 root 且 docker 组未生效:提示
  if [ "$(id -u)" != 0 ] && ! docker info >/dev/null 2>&1; then
    fail "docker 组未生效(需重新登录使 docker 组生效,或继续以 sudo bash 运行本脚本)"
  fi
}

ensure_docker_distro() {
  case "$PKG" in
    apt) $SUDO apt-get update -qq >/dev/null 2>&1 || true; DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq docker.io docker-compose-v2 >/dev/null 2>&1 || fail "发行版仓库安装 docker 失败,请手动: sudo apt-get install -y docker.io docker-compose-v2" ;;
    dnf|yum) $SUDO ${PKG} install -y -q docker docker-compose-plugin >/dev/null 2>&1 || fail "发行版仓库安装 docker 失败,请手动: sudo ${PKG} install -y docker docker-compose-plugin" ;;
    apk) $SUDO apk add --no-cache docker docker-cli-compose >/dev/null 2>&1 || fail "发行版仓库安装 docker 失败,请手动: sudo apk add docker docker-cli-compose" ;;
    zypper) $SUDO zypper -n install docker docker-compose >/dev/null 2>&1 || fail "发行版仓库安装 docker 失败,请手动: sudo zypper -n install docker docker-compose" ;;
  esac
  $SUDO systemctl enable --now docker >/dev/null 2>&1 || true
}

step3_deps() {
  log "▶ [3/6] 依赖检查与安装"
  if [ "$SKIP_DEPS" = "1" ]; then
    log "  SKIP_DEPS=1 → 跳过自动安装,仅检查"
    local missing=()
    for cmd in curl jq openssl; do command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd"); done
    command -v docker >/dev/null 2>&1 || missing+=("docker")
    docker compose version >/dev/null 2>&1 || missing+=("docker compose 插件")
    if [ ${#missing[@]} -gt 0 ]; then
      fail "缺失: ${missing[*]}(SKIP_DEPS=1 不自动安装;请手动安装后重试)"
    fi
    return
  fi
  install_if_missing curl curl "curl(资产下载/健康检查)"
  install_if_missing jq jq "jq(JSON 解析)"
  install_if_missing openssl openssl "openssl(证书生成)"
  install_if_missing dig "$DNS_PKG" "DNS 工具(dig/nslookup)"
  install_if_missing ss "$NET_PKG" "端口检测(ss/lsof)"
  ensure_docker
  log "  ✓ 依赖就绪"
}

# ============================================================
# 阶段 4:配置收集(环境变量优先;tty 交互经 /dev/tty)
# ============================================================
# ---- 镜像是否含 -db-driver 支持(通过 --help 探测;失败仅警告) ----
require_pg_image() {
  local img="$1"
  [ "$SKIP_IMAGE_CHECK" = "1" ] && return 0
  [ -n "$img" ] || return 0
  local out=""
  # 默认 ENTRYPOINT 即 /app/entrypoint.sh → 透传到 picoaide-server;直接跑 -h 即可
  out="$(docker run --rm "$img" -h 2>&1 || true)"
  if echo "$out" | grep -q "db-driver"; then
    log "  ✓ 镜像 $img 含 -db-driver 支持"
    return 0
  fi
  warn "镜像 $img 未探测到 -db-driver(可能是网络未拉取/镜像旧)。请确认镜像含 PG 支持后再继续"
  return 1
}

validate_domain() {
  case "$DOMAIN" in
    "" ) fail "未提供域名(DOMAIN)。交互运行可等待询问;非交互请用 DOMAIN=... bash" ;;
    */*) fail "域名不合法: $DOMAIN" ;;
  esac
}

write_docker_daemon() {
  # 若 DOCKER_MIRROR 被设定且当前无镜像加速,写入 /etc/docker/daemon.json(仅提示不动)
  if [ -n "$DOCKER_MIRROR" ]; then
    warn "DOCKER_MIRROR 已设:$DOCKER_MIRROR —— docker 拉取镜像加速需在 /etc/docker/daemon.json 配 registry-mirrors(部署后也可用 PG_IMAGE 镜像地址换内网镜像)"
  fi
}

step4_config() {
  log "▶ [4/6] 配置收集"
  if [ -z "$DOMAIN" ]; then
    if [ -t 0 ]; then
      read -r -p "请输入服务端对外域名或 IP(生产必改,如 picoaide.example.com 或 10.0.0.5): " DOMAIN < /dev/tty || true
    fi
  fi
  validate_domain
  log "  域名: $DOMAIN"
  case "$DOMAIN" in *[!0-9.]*) ;; *) log "  (IP 部署,证书将用自签名;TLS_MODE=auto 不支持 IP)" ;; esac

  # TLS 模式(manual/auto)
  if [ "$TLS_MODE" != "manual" ] && [ "$TLS_MODE" != "auto" ]; then fail "TLS_MODE 仅支持 manual/auto"; fi
  if [ -t 0 ] && [ "$TLS_MODE" = "manual" ]; then
    log "  (提示: TLS_MODE=auto 可让 Caddy 自动申请 Let's Encrypt,需公网域名直连+80/443 开放)"
  fi
  log "  证书模式: $TLS_MODE"

  # DB 模式(sqlite/pg/pg-external)
  case "$DB_MODE" in
    sqlite|pg|pg-external) : ;;
    *) fail "DB_MODE 仅支持 sqlite/pg/pg-external" ;;
  esac
  log "  数据库: $DB_MODE"
  if [ "$DB_MODE" = "pg-external" ] && [ -z "$PG_DSN" ]; then
    if [ -t 0 ]; then
      read -r -p "请输入外部 PostgreSQL 连接串(PG_DSN,如 postgres://user:pass@host:5432/db): " PG_DSN < /dev/tty || true
    fi
    [ -n "$PG_DSN" ] || fail "DB_MODE=pg-external 需要 PG_DSN"
    case "$PG_DSN" in postgres://*|postgresql://*|*host=*) : ;; *) fail "PG_DSN 格式不合法" ;; esac
  fi
  if [ "$DB_MODE" = "pg" ] && [ -z "$PG_PASSWORD" ] && [ -t 0 ]; then
    read -r -p "请输入内置 PostgreSQL 密码(回车则随机生成): " PG_PASSWORD < /dev/tty || true
  fi
  if [ "$DB_MODE" = "pg" ] || [ "$DB_MODE" = "pg-external" ]; then
    require_pg_image "$SERVER_IMAGE" || fail "当前镜像 $SERVER_IMAGE 不支持 PG(-db-driver)。请使用含本分支的镜像(0.5.0+ 或 make docker-image 本地构建),或 SKIP_IMAGE_CHECK=1 跳过"
  fi
  log "  管理员账号: $ADMIN_USER"

  # 已部署检测(INSTALL_DIR 非空)
  if [ -d "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
    if [ "$REINSTALL" = "yes" ]; then
      log "  REINSTALL=yes → 清除重装(旧部署数据将被备份为 .env.bak)"
    else
      fail "部署目录 $INSTALL_DIR 已存在且非空。继续请加 REINSTALL=yes(清除重装),或改用: cd $INSTALL_DIR && ./deploy.sh update(升级)"
    fi
  fi
  write_docker_daemon
}

# ============================================================
# 阶段 5:资产准备(本地复制或下载)
# ============================================================
step5_assets() {
  log "▶ [5/6] 准备部署资产 → $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  local f
  if [ -f "$REPO_DIR/docker-compose.yml" ] && [ "$REPO_DIR" != "$INSTALL_DIR" ]; then
    log "  本地模式: 从仓库 $REPO_DIR 复制"
    for f in $ASSETS; do cp -f "$REPO_DIR/$f" "$INSTALL_DIR/$f"; chmod 644 "$INSTALL_DIR/$f"; done
    cp -f "$REPO_DIR/scripts/deploy.sh" "$INSTALL_DIR/deploy.sh"
  elif command -v curl >/dev/null 2>&1 && ! ls "$INSTALL_DIR/docker-compose.yml" >/dev/null 2>&1; then
    log "  下载模式: 从 $DEPLOY_BASE_URL 下载(assets: $ASSETS)"
    for f in $ASSETS; do
      log "    下载 $f ..."
      curl -fsSL "$DEPLOY_BASE_URL/$f" -o "$INSTALL_DIR/$f" || fail "下载 $f 失败(可用 DEPLOY_BASE_URL 指定资产源,或手动 curl -fsSLo $INSTALL_DIR/$f $DEPLOY_BASE_URL/$f)"
      chmod 644 "$INSTALL_DIR/$f"
    done
    curl -fsSL "$DEPLOY_BASE_URL/deploy.sh" -o "$INSTALL_DIR/deploy.sh" || fail "下载 deploy.sh 失败"
  else
    log "  $INSTALL_DIR 已含资产(或仓库即目录),复用"
    # 若 deploy.sh 缺失,补一份(deploy.sh 不在 ASSETS 里,单独处理)
    if [ ! -f "$INSTALL_DIR/deploy.sh" ]; then
      if [ -f "$REPO_DIR/scripts/deploy.sh" ]; then cp -f "$REPO_DIR/scripts/deploy.sh" "$INSTALL_DIR/deploy.sh"
      else curl -fsSL "$DEPLOY_BASE_URL/deploy.sh" -o "$INSTALL_DIR/deploy.sh" || fail "下载 deploy.sh 失败"; fi
    fi
  fi
  [ -f "$INSTALL_DIR/deploy.sh" ] || fail "缺少 deploy.sh"
  chmod +x "$INSTALL_DIR/deploy.sh"
  log "  ✓ 资产就绪"
}

# ============================================================
# 阶段 6:转发 deploy.sh install + 收尾
# ============================================================
step6_deploy() {
  log "▶ [6/6] 开始部署(转发 deploy.sh install)"
  log "  (部署由 deploy.sh 完成: 网段/端口预检、证书、.env、Caddyfile、镜像启动、健康等待)"
  cd "$INSTALL_DIR"
  DEPLOY_DIR="$INSTALL_DIR" \
  DOMAIN="$DOMAIN" \
  ADMIN_USER="$ADMIN_USER" \
  PICOAI_ADMIN_PASSWORD="$ADMIN_PASS" \
  TLS_MODE="$TLS_MODE" \
  SERVER_IMAGE="$SERVER_IMAGE" \
  DB_MODE="$DB_MODE" \
  PG_PASSWORD="$PG_PASSWORD" \
  PG_DSN="$PG_DSN" \
  REINSTALL="$REINSTALL" \
  bash "$INSTALL_DIR/deploy.sh" install
  log "========== 安装器完成 =========="
  log "部署目录: $INSTALL_DIR"
  log "数据库: $DB_MODE"
  log "后续命令: cd $INSTALL_DIR && ./deploy.sh update | status | logs | backup | migrate | uninstall"
  log "提醒: 定期 ./deploy.sh backup(含 master.key);升级前先备份"
  [ "$DB_MODE" = "pg" ] && log "  PostgreSQL 数据目录: $INSTALL_DIR/pg-data(备份: ./deploy.sh backup)" || true
  return 0
}

# ============================================================
# 入口
# ============================================================
step1_elevate
detect_distro
step3_deps
step4_config
step5_assets
step6_deploy
