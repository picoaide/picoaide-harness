#!/usr/bin/env bash
# ============================================================
# PicoAide 服务端一键部署薄封装(准备资产 → 转发 scripts/deploy.sh)
# ============================================================
# 兼容两种运行方式(行为一致,均把部署资产落到 INSTALL_DIR 后执行 deploy.sh install):
#   1. 仓库克隆内运行:  bash scripts/install-server.sh
#      → 从仓库根(脚本上级)复制 docker-compose.yml / Caddyfile 模板 / .env.example 到 INSTALL_DIR
#   2. curl 管道安装:  curl -fsSL <install-server.sh 地址> | DOMAIN=... bash
#      → 自动从 DEPLOY_BASE_URL 下载部署资产到 INSTALL_DIR
#        (默认 https://raw.githubusercontent.com/picoaide/picoaide-harness/master/server,
#         有需要时用 DEPLOY_BASE_URL 覆盖)
#
# 环境变量(兼容旧版 + 新版):
#   DOMAIN          对外域名或 IP(必填;仅 -t 0 时交互询问)
#   INSTALL_DIR     部署目录(默认 /data/picoaide/deploy;兼容 DEPLOY_DIR)
#   ADMIN_USER      超管用户名(默认 admin)
#   ADMIN_PASS      超管密码(默认随机生成;兼容 PICOAI_ADMIN_PASSWORD)
#   TLS_MODE        证书模式(默认 manual;auto=Let's Encrypt)
#   SERVER_IMAGE    服务端镜像(默认 ghcr.io/picoaide/picoaide-server:latest)
#   REINSTALL=yes   已存在部署时清除重装(默认安全退出)
#   DEPLOY_BASE_URL 资产下载基址(仅 curl 管道模式使用)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="${INSTALL_DIR:-${DEPLOY_DIR:-/data/picoaide/deploy}}"
DOMAIN="${DOMAIN:-}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-${PICOAI_ADMIN_PASSWORD:-}}"
TLS_MODE="${TLS_MODE:-manual}"
SERVER_IMAGE="${SERVER_IMAGE:-ghcr.io/picoaide/picoaide-server:latest}"
REINSTALL="${REINSTALL:-}"
DEPLOY_BASE_URL="${DEPLOY_BASE_URL:-https://raw.githubusercontent.com/picoaide/picoaide-harness/master/server}"

# 部署资产清单(所有模式必须就位)
ASSETS="docker-compose.yml Caddyfile.autocert Caddyfile.manual .env.example"

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
fail() { log "错误: $*"; exit 1; }

# ---- 域名:必填;仅 stdin 为终端时交互询问 ----
if [ -z "$DOMAIN" ]; then
  if [ -t 0 ]; then
    read -r -p "请输入服务端对外域名或 IP: " DOMAIN || true
  else
    fail "未提供域名,请以 DOMAIN=your.domain bash 方式运行(或 curl ... | DOMAIN=xx bash)"
  fi
fi
[ -n "$DOMAIN" ] || fail "未提供域名"
case "$DOMAIN" in */*) fail "域名不合法: $DOMAIN" ;; esac

# ---- 准备部署资产(本地复制或管道下载,幂等) ----
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

if [ -f "$REPO_DIR/docker-compose.yml" ] && [ "$REPO_DIR" != "$INSTALL_DIR" ]; then
  log "本地模式: 从仓库 $REPO_DIR 复制部署资产到 $INSTALL_DIR"
  for f in $ASSETS; do cp -f "$REPO_DIR/$f" "$INSTALL_DIR/$f"; done
elif command -v curl >/dev/null 2>&1 && ! ls "$INSTALL_DIR/docker-compose.yml" >/dev/null 2>&1; then
  log "管道/下载模式: 从 $DEPLOY_BASE_URL 下载部署资产到 $INSTALL_DIR"
  for f in $ASSETS; do
    log "  下载 $f ..."
    curl -fsSL "$DEPLOY_BASE_URL/$f" -o "$INSTALL_DIR/$f" || fail "下载 $f 失败(可用 DEPLOY_BASE_URL 指定资产源)"
  done
else
  log "部署目录 $INSTALL_DIR 已含资产(或仓库即目录),复用"
fi
# deploy.sh 若不在 INSTALL_DIR 则一并准备(本地模式从仓库复制)
if [ ! -f "$INSTALL_DIR/deploy.sh" ]; then
  if [ -f "$REPO_DIR/scripts/deploy.sh" ]; then
    cp -f "$REPO_DIR/scripts/deploy.sh" "$INSTALL_DIR/deploy.sh"
  else
    curl -fsSL "$DEPLOY_BASE_URL/deploy.sh" -o "$INSTALL_DIR/deploy.sh" || fail "下载 deploy.sh 失败"
  fi
fi
chmod +x "$INSTALL_DIR/deploy.sh"

# ---- 转发给 deploy.sh install ----
DEPLOY_DIR="$INSTALL_DIR" DOMAIN="$DOMAIN" ADMIN_USER="$ADMIN_USER" \
  PICOAI_ADMIN_PASSWORD="$ADMIN_PASS" TLS_MODE="$TLS_MODE" \
  SERVER_IMAGE="$SERVER_IMAGE" REINSTALL="$REINSTALL" \
  bash "$INSTALL_DIR/deploy.sh" install
