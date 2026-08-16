#!/usr/bin/env bash
# PicoAide 本地一键开发测试环境
#
# 起 mock 上游 + 本地服务端,并用真实管理 API 灌入 seed 数据
# (部门知识库/技能/MCP/授权/测试用户)——全部走正常 HTTP 接口链路。
#
# 用法:
#   bash scripts/dev-env.sh            # 首次:构建 + 启动 + 灌数据
#   bash scripts/dev-env.sh up         # 仅启动(数据保留,跳过 seed)
#   bash scripts/dev-env.sh down       # 停止服务
#   bash scripts/dev-env.sh fresh      # 清空数据并重建(等价首次)
#   PICOAI_UPSTREAM_KEY=sk-xxx bash scripts/dev-env.sh   # 切真实 DeepSeek 上游
#   SEED_REPO=/path/to/picoaide-next-seed bash scripts/dev-env.sh  # 指定 seed 仓库
#
# 客户端:cd desktop && npm run dev → 登录页填 http://127.0.0.1:18080
# 管理端:浏览器打开 http://127.0.0.1:18080/admin/
# 测试账号:admin(密码见启动输出)/ alice(研发部)/ bob(人事部),密码 PicoSeed12345

set -euo pipefail

DEV_ENV_PORT="${DEV_ENV_PORT:-18080}"
DEV_ENV_MOCK_PORT="${DEV_ENV_MOCK_PORT:-18081}"
DEV_ADMIN_PASS="${DEV_ADMIN_PASS:-DevAdmin@123456}"
# 测试用户密码(seed 仓库默认,保持一致)
DEV_USER_PASS="${DEV_USER_PASS:-PicoSeed12345}"
PICOAI_UPSTREAM_KEY="${PICOAI_UPSTREAM_KEY:-}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$ROOT/dev-data"
SEED_REPO="${SEED_REPO:-$(cd "$ROOT/.." && pwd)/picoaide-next-seed}"

say() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
die() { echo "错误: $*" >&2; exit 1; }

port_free() { # port
  ! ss -tlnp 2>/dev/null | grep -q ":$1 "
}

stop_all() {
  [ -f "$DATA_DIR/mock.pid" ] && kill "$(cat "$DATA_DIR/mock.pid")" 2>/dev/null || true
  [ -f "$DATA_DIR/server.pid" ] && kill "$(cat "$DATA_DIR/server.pid")" 2>/dev/null || true
  sleep 0.5
  rm -f "$DATA_DIR/mock.pid" "$DATA_DIR/server.pid"
}

case "${1:-up}" in
  down)
    say "停止服务"
    stop_all
    exit 0
    ;;
esac

# ---- 依赖检查 ----
command -v curl >/dev/null || die "缺少 curl"
command -v jq >/dev/null || die "缺少 jq"
command -v go >/dev/null 2>&1 || [ -x /usr/local/go/bin/go ] || die "缺少 go 工具链"
if ! command -v go >/dev/null 2>&1 && [ -x /usr/local/go/bin/go ]; then
  export PATH="$PATH:/usr/local/go/bin"
fi
[ -d "$SEED_REPO" ] || die "未找到 seed 仓库($SEED_REPO),请用 SEED_REPO=/path/to/picoaide-next-seed 指定"

# ---- 构建 ----
say "构建服务端与 mock 上游"
make -C "$ROOT" build-server >/dev/null
mkdir -p "$DATA_DIR"
go build -o "$DATA_DIR/mock-upstream" "$ROOT/scripts/mock-upstream.go"

# ---- 端口检查 ----
port_free "$DEV_ENV_PORT" || die "端口 $DEV_ENV_PORT 被占用(已有 dev-env 在跑?先 down)"
port_free "$DEV_ENV_MOCK_PORT" || die "端口 $DEV_ENV_MOCK_PORT 被占用"

# ---- 启动 ----
say "启动 mock 上游(:$DEV_ENV_MOCK_PORT)与服务端(:$DEV_ENV_PORT)"
"$DATA_DIR/mock-upstream" -addr ":$DEV_ENV_MOCK_PORT" >"$DATA_DIR/mock.log" 2>&1 &
echo $! > "$DATA_DIR/mock.pid"
PICOAI_ADMIN_PASSWORD="$DEV_ADMIN_PASS" "$ROOT/bin/picoaide-server" \
  -addr ":$DEV_ENV_PORT" -data "$DATA_DIR" --bootstrap-admin admin \
  >"$DATA_DIR/server.log" 2>&1 &
echo $! > "$DATA_DIR/server.pid"

# ---- 等待就绪 ----
for _ in $(seq 1 30); do
  if curl -s -m 2 "http://127.0.0.1:$DEV_ENV_PORT/healthz" | jq -e '.ok == true' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
curl -s -m 2 "http://127.0.0.1:$DEV_ENV_PORT/healthz" | jq -e '.ok == true' >/dev/null 2>&1 \
  || { echo "服务端未就绪,日志:"; tail -5 "$DATA_DIR/server.log"; die "启动失败"; }

# ---- mock 渠道配置(聊天/工具调用/embeddings 全走正常网关链路) ----
say "配置 mock 渠道(模型 mock-chat)"
CSRF="$(curl -s -c "$DATA_DIR/admin.jar" -X POST "http://127.0.0.1:$DEV_ENV_PORT/api/admin/login" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$DEV_ADMIN_PASS\"}" | jq -r .csrf_token)"
existing="$(curl -s -b "$DATA_DIR/admin.jar" -H "X-CSRF-Token: $CSRF" \
  "http://127.0.0.1:$DEV_ENV_PORT/api/admin/providers" | jq -r '.providers[] | select(.name=="mock") | .id' 2>/dev/null || true)"
if [ -z "$existing" ]; then
  curl -s -b "$DATA_DIR/admin.jar" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
    -X POST "http://127.0.0.1:$DEV_ENV_PORT/api/admin/providers" \
    -d "{\"name\":\"mock\",\"base_url\":\"http://127.0.0.1:$DEV_ENV_MOCK_PORT\",\"api_key\":\"dev-key\",\"models\":[\"mock-chat\"]}" >/dev/null
  echo "  mock 渠道已创建(mock-chat)"
fi

# ---- 真实上游(可选):配置 deepseek 渠道 + 同步模型 ----
if [ -n "$PICOAI_UPSTREAM_KEY" ]; then
  say "配置真实 DeepSeek 上游(密钥来自环境变量,不进仓库)"
  existing="$(curl -s -b "$DATA_DIR/admin.jar" -H "X-CSRF-Token: $CSRF" \
    "http://127.0.0.1:$DEV_ENV_PORT/api/admin/providers" | jq -r '.providers[] | select(.name=="deepseek-real") | .id' 2>/dev/null || true)"
  if [ -z "$existing" ]; then
    curl -s -b "$DATA_DIR/admin.jar" -H "X-CSRF-Token: $CSRF" -H 'Content-Type: application/json' \
      -X POST "http://127.0.0.1:$DEV_ENV_PORT/api/admin/providers" \
      -d "{\"name\":\"deepseek-real\",\"channel\":\"deepseek\",\"api_key\":\"$PICOAI_UPSTREAM_KEY\"}" >/dev/null
  fi
  curl -s -b "$DATA_DIR/admin.jar" -H "X-CSRF-Token: $CSRF" \
    -X POST "http://127.0.0.1:$DEV_ENV_PORT/api/admin/providers/sync-all" | jq -c '.results'
fi

# ---- seed 数据(仅首次/fresh) ----
if [ "${1:-up}" = "fresh" ] || [ ! -f "$DATA_DIR/.seeded" ]; then
  say "灌入 seed 数据(真实管理 API,来自 $SEED_REPO)"
  SEED_LOCAL=1 SEED_FRESH=1 \
  SEED_BASE="http://127.0.0.1:$DEV_ENV_PORT" \
  SEED_ADMIN=admin SEED_ADMIN_PASS="$DEV_ADMIN_PASS" \
  SEED_USER_PASS="$DEV_USER_PASS" \
  bash "$SEED_REPO/scripts/seed.sh"
  touch "$DATA_DIR/.seeded"
else
  say "数据已存在(.seeded),跳过 seed;加参数 fresh 可重建"
fi

# ---- 完成 ----
say "开发测试环境就绪"
echo "  服务端:     http://127.0.0.1:$DEV_ENV_PORT  (数据: $DATA_DIR)"
echo "  管理端:     http://127.0.0.1:$DEV_ENV_PORT/admin/  admin / $DEV_ADMIN_PASS"
echo "  mock 上游:  :$DEV_ENV_MOCK_PORT"
[ -n "$PICOAI_UPSTREAM_KEY" ] && echo "  LLM 上游:   真实 DeepSeek(deepseek-real 渠道)"
echo "  测试用户:   alice(研发部)/ bob(人事部)  密码 $DEV_USER_PASS"
echo "  客户端:     cd desktop && npm run dev → 登录页填 http://127.0.0.1:$DEV_ENV_PORT"
echo "  停止:       bash scripts/dev-env.sh down"
