#!/usr/bin/env bash
#
# WASM「客户端专属」改造 · 验收门禁（设计总纲 §13 的六组 + §10 渠道组）。
#
# 权威文档：docs/planning/2026-09-19-wasm-client-only-design.md
#   §13   验收判据（六组 + "禁止静默跳过" + "零残留三分法" + "结论绑定 HEAD"）
#   §10   渠道与白标（app_origin_scheme 必填/唯一/正则）
#   §16   唯一权威波次表（W0-D 探针 / W4 删除波次 / W6 本脚本入库 / W7 发布）
# 台账：docs/planning/2026-09-19-wasm-client-only-findings-ledger.md（只读；L4 行与 §C）
#
# **为什么必须入库**（R1-TST-12 / OPS-7 / R2T-3）：早期草稿放在 gitignore 的 `temp/` 里，
# 审计者与 CI 都复现不了 —— "可复跑"就成了口头承诺。本文件是唯一入口。
#
# 六组 + 一组：
#   1 静态守卫（布局/清单/工作流）        2 三方对拍 + 旧模型零残留（三分法）
#   3 服务端 go build/vet/定向测试（真 PG；**用例级 0 skip**）
#   4 客户端三包 check                   5 webadmin npm test
#   6 协议探针（scripts/wasm/probes/*，自判定 + 退出码；xvfb-run -a 与探针同命令）
#   7 渠道约束（§10：app_origin_scheme 必填/形状/唯一 + 正式 tag dry-run + 仓库 pin）
#   8 W5 文档与作者面判据（纯 grep；便携组；TST-15 的机器判据）
#
# 用法：
#   bash scripts/verify-wasm-client-only.sh                 # 全量（1–8）
#   bash scripts/verify-wasm-client-only.sh --portable      # 与产物/PG/显示器无关的子集（1,2,7,8）
#                                                           # —— 供 `yarn check` 的 GUARDS 与本地快跑
#   bash scripts/verify-wasm-client-only.sh --groups 2,6    # 只跑指定组（1–8）
#   bash scripts/verify-wasm-client-only.sh --list
# 环境变量（参数化，避免把本机路径写死 —— R2T-12）：
#   PG_DSN_TEST      定向测试的数据库（缺省 postgres://postgres:postgres@127.0.0.1:5432/picoaide_test）
#   PROBE_TIMEOUT    单探针超时秒数（缺省 180）
#   ELECTRON_BIN     Electron 可执行文件（缺省 packages/host/desktop/node_modules/.bin/electron）
#   WASM_CHANNELS_REPO  真实私有渠道仓检出（可选；给了就跑正式 tag dry-run）
#   WASM_GATE_LOG_DIR   日志目录（缺省 temp/wasm-client-only/gate-logs）
#   WASM_GATE_REQUIRE_COVERED_PLATFORM=1  非 Linux 平台上探针按显式 SKIP（退出码 77）处理
# 退出码：0 = 所选组全部通过；1 = 有失败项；2 = 用法/环境错误。

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PG_DSN_TEST="${PG_DSN_TEST:-postgres://postgres:postgres@127.0.0.1:5432/picoaide_test}"
PROBE_TIMEOUT="${PROBE_TIMEOUT:-180}"
ELECTRON_BIN="${ELECTRON_BIN:-$ROOT/packages/host/desktop/node_modules/.bin/electron}"
LOG_DIR="${WASM_GATE_LOG_DIR:-$ROOT/temp/wasm-client-only/gate-logs}"
PROBE_HOME="${PROBE_HOME:-${TMPDIR:-/tmp}/wasm-gate-home}"

# Go 缓存固定落在仓库内（判据要求）：不写 ~/.cache，且**离线**（GOPROXY=off）——
# 门禁不允许在跑的中途去下载模块，那会让"同一 HEAD 两次结论不同"。
export GOCACHE="$ROOT/temp/go-build"
export GOMODCACHE="$ROOT/temp/gomodcache"
export GOPROXY=off
export PG_DSN_TEST

mkdir -p "$LOG_DIR" "$PROBE_HOME"

# ---------------------------------------------------------------------------
# 参数
# ---------------------------------------------------------------------------
MODE="full"
GROUPS_SELECTED=""
while [ $# -gt 0 ]; do
  case "$1" in
    --portable) MODE="portable"; shift ;;
    --groups) GROUPS_SELECTED="${2:-}"; shift 2 ;;
    --list) MODE="list"; shift ;;
    -h|--help) MODE="help"; shift ;;
    *) echo "verify-wasm-client-only: 未知参数 $1（用 --help）" >&2; exit 2 ;;
  esac
done

GROUP_NAMES=(
  "1 静态守卫（布局/清单/工作流）"
  "2 三方对拍 + 旧模型零残留（三分法）"
  "3 服务端 go build/vet/定向测试（真 PG，用例级 0 skip）"
  "4 客户端三包 check（wasm-apps-host / browser / wasm-apps）"
  "5 webadmin npm test"
  "6 协议探针（自判定 + 退出码）"
  "7 渠道约束（§10 app_origin_scheme + 正式 tag dry-run + 仓库 pin）"
  "8 W5 文档与作者面判据（纯 grep；TST-15 的机器判据）"
)

case "$MODE" in
  help)
    sed -n '2,35p' "${BASH_SOURCE[0]}"
    exit 0 ;;
  list)
    printf '%s\n' "${GROUP_NAMES[@]}"
    exit 0 ;;
  portable)
    # W5 文档判据（组 8）是纯 grep、无外部依赖 ⇒ 进便携组，`yarn check` 每次都跑（TST-15）。
    if [ -z "$GROUPS_SELECTED" ]; then GROUPS_SELECTED="1 2 7 8"; fi ;;
  full)
    # `--groups` 显式点名时不得被缺省值覆盖（否则 `--groups 2` 会静默跑成全部七组）。
    if [ -z "$GROUPS_SELECTED" ]; then GROUPS_SELECTED="1 2 3 4 5 6 7 8"; fi ;;
esac

# `--groups 2,6` → `2 6`
GROUPS_SELECTED="${GROUPS_SELECTED//,/ }"
if [ -z "${GROUPS_SELECTED// /}" ]; then
  echo "verify-wasm-client-only: 没有选中任何组（--groups 传了空值？）" >&2
  exit 2
fi
for g in $GROUPS_SELECTED; do
  case "$g" in 1|2|3|4|5|6|7|8) ;; *) echo "verify-wasm-client-only: 未知组 '$g'（可选 1–8）" >&2; exit 2 ;; esac
done
want() { case " $GROUPS_SELECTED " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# ---------------------------------------------------------------------------
# 报告原语
# ---------------------------------------------------------------------------
FAIL=0
PASS_COUNT=0
SKIP_COUNT=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL + 1)); }
skip() { printf '  \033[33mSKIP\033[0m %s\n' "$1"; SKIP_COUNT=$((SKIP_COUNT + 1)); }
note() { printf '  %s\n' "$1"; }
step() { printf '\n== %s\n' "$1"; }

run_limited() { # run_limited <秒> <命令...>（没有 timeout(1) 的平台直接跑）
  local seconds="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$seconds" "$@"; else "$@"; fi
}

pg_reachable() {
  node -e '
    const net = require("node:net")
    const url = new URL(process.env.PG_DSN_TEST)
    const socket = net.connect(Number(url.port || 5432), url.hostname)
    socket.setTimeout(2500)
    socket.on("connect", () => { socket.destroy(); process.exit(0) })
    socket.on("error", () => process.exit(1))
    socket.on("timeout", () => { socket.destroy(); process.exit(1) })
  ' 2>/dev/null
}

# ---------------------------------------------------------------------------
# HEAD 绑定（§13 判据 6；R2T-10）：本仓有并发编辑史，结论不绑 HEAD 就不可比。
# ---------------------------------------------------------------------------
HEAD_START="$(git rev-parse HEAD)"
BRANCH_START="$(git rev-parse --abbrev-ref HEAD)"
DIRTY_START="$(git status --porcelain | wc -l | tr -d ' ')"
BINDING="$ROOT/temp/wasm-client-only/HEAD-binding.txt"
{
  printf 'HEAD %s\n' "$HEAD_START"
  printf 'branch %s\n' "$BRANCH_START"
  printf 'dirty-files %s\n' "$DIRTY_START"
  printf 'groups %s\n' "$GROUPS_SELECTED"
  printf 'started %s\n' "$(date -Is)"
} >"$BINDING"

echo "WASM 客户端专属验收门禁（scripts/verify-wasm-client-only.sh）"
echo "HEAD $HEAD_START（$BRANCH_START；工作树 ${DIRTY_START} 个改动 —— 本仓并发编辑，结论按此 HEAD 归档）"
echo "组：$GROUPS_SELECTED（模式 $MODE）｜日志目录 $LOG_DIR"

if [ "$MODE" = "portable" ]; then
  echo "portable 模式：只跑与构建产物 / PG / 显示器无关的组。**显式**不在本模式内（不是静默跳过）："
  echo "  · 组 3 服务端 go build/vet/定向测试 —— 需要真 PG，归带 PG 的 server job（§16 W6）"
  echo "  · 组 4 客户端三包 check —— \`yarn check\` 的包任务已覆盖同一批命令"
  echo "  · 组 5 webadmin npm test —— 归 server job"
  echo "  · 组 6 协议探针 —— 需要 xvfb/显示器；归 W6 三平台与 tag 流水线"
fi

# ---------------------------------------------------------------------------
if want 1; then
  step "1. 静态守卫（新包登记 / 布局 / 工作流）"
  for guard in verify-layout verify-inventories check-workflows; do
    log="$LOG_DIR/$guard.log"
    if node "scripts/$guard.mjs" >"$log" 2>&1; then
      pass "$guard"
    else
      fail "$guard（日志 $log）"
      tail -n 8 "$log" | sed 's/^/      /'
    fi
  done
fi

# ---------------------------------------------------------------------------
if want 2; then
  step "2. 三方对拍 + 旧模型零残留（四桶：A 业务零命中 / B 契约型保留（带标识+上限） / C 夹具与文档 / D 生成物与演示内容；未跟踪文件也查）"
  log="$LOG_DIR/route-parity.log"
  if node scripts/wasm/check-route-parity.mjs >"$log" 2>&1; then
    pass "三方对拍：客户端 OPEN_APP_PATH == 宿主 WASM_APP_OPEN_ROUTE == 设计总纲 §5.2 冻结串"
    grep -E '^  (PENDING|待办)' "$log" | sed 's/^/      /' || true
  else
    fail "三方对拍失败（漂移即 404；命中文件与行号见 $log）"
    grep -E '^  (客户端常量|宿主路由|文档冻结串|FAIL)' "$log" | sed 's/^/      /' || true
  fi

  # 零残留：脚本自己判定 + 退出码；四桶计数与命中逐条打印（--all 打印全部）。
  log="$LOG_DIR/residue.log"
  if node scripts/wasm/check-old-model-residue.mjs --json "$LOG_DIR/residue.json" 2>&1 | tee "$log"; then
    pass "旧模型零残留：A 桶（业务代码）零命中，B 桶契约型保留带标识且在上限内"
  else
    fail "旧模型零残留：A 桶（业务代码）仍有命中（W4 删除波次未完成；五桶计数 A/B/ANN/C/D 见上，结构化报告 $LOG_DIR/residue.json）"
  fi

  for deleted in server/internal/wasmapp/session server/internal/wasmapp/anonlimit \
                 server/internal/wasmapp/edge/hostgate.go server/internal/wasmapp/edge/subdomain.go; do
    if [ -e "$deleted" ]; then fail "删除面仍存在：$deleted（§8.4 删除清单）"; else pass "删除面不存在：$deleted"; fi
  done
fi

# ---------------------------------------------------------------------------
if want 3; then
  step "3. 服务端构建 + 定向测试（真 PG；禁止静默跳过）"
  log="$LOG_DIR/go-build.log"
  if (cd server && run_limited 900 go build ./...) >"$log" 2>&1; then
    pass "go build ./..."
  else
    fail "go build ./...（日志 $log）"
    tail -n 6 "$log" | sed 's/^/      /'
  fi

  log="$LOG_DIR/go-vet.log"
  if (cd server && run_limited 600 go vet ./internal/wasmapp/... ./internal/router/...) >"$log" 2>&1; then
    pass "go vet ./internal/wasmapp/... ./internal/router/..."
  else
    fail "go vet（日志 $log）"
    tail -n 6 "$log" | sed 's/^/      /'
  fi

  if pg_reachable; then
    log="$LOG_DIR/go-test.json"
    # 只取退出码会让"PG 不可达 ⇒ 全部 t.Skip"变成零断言的门禁绿（R1-TST-2）⇒ -json + 解析。
    if (cd server && run_limited 1200 go test ./internal/wasmapp/... ./internal/router/... -count=1 -json) >"$log" 2>&1; then
      # 关键用例名单（**改上游/改名时同步这里**）：W1 把 `TestClientFrameUser_MatchesSessionProjection`
      # 改名为 `TestClientFrameUser_ProjectsUserRowAndPublisherFlag`（同一意图）。checker 会区分
      # "报告里不存在（多半被改名，给出候选）"与"存在但没通过"—— 见 2026-09-20 的 R1-L4-5。
      if node scripts/wasm/check-go-test-json.mjs "$log" \
          --require TestClientRequest_LoginRequiredWithoutIdentityIs401,TestCheckClientOrigin,TestClientFrameUser_ProjectsUserRowAndPublisherFlag; then
        pass "go test 定向包（真 PG；用例级 0 skip；三条关键用例确实 pass）"
      else
        fail "go test 报告不合格（用例级 skip / 关键用例缺失 / 有失败事件；报告 $log）"
      fi
    else
      fail "go test 失败（报告 $log）"
      grep -E '"Action":"fail"' "$log" | head -n 8 | sed 's/^/      /' || true
      tail -n 5 "$log" | sed 's/^/      /'
    fi
  else
    # **不静默跳过**：PG 不可达时本组是失败，不是通过（CI 里本组归 server job）。
    fail "PG 不可达（$PG_DSN_TEST）：定向测试无法执行 —— 本组必须在带 PG 的 server job 跑（§16 W6），不得当通过"
  fi
fi

# ---------------------------------------------------------------------------
if want 4; then
  step "4. 客户端包检查（新包 / 浏览器 / 客户端应用中心）"
  for pkg in @picoaide/dsh-wasm-apps-host @picoaide/dsh-browser @picoaide/dsh-wasm-apps; do
    log="$LOG_DIR/pkg-${pkg//\//_}.log"
    if corepack yarn workspace "$pkg" check >"$log" 2>&1; then
      pass "$pkg check"
    else
      fail "$pkg check（日志 $log）"
      tail -n 8 "$log" | sed 's/^/      /'
    fi
  done
fi

# ---------------------------------------------------------------------------
if want 5; then
  step "5. webadmin 测试"
  log="$LOG_DIR/webadmin.log"
  if [ ! -d server/webadmin/node_modules ]; then
    fail "server/webadmin/node_modules 不存在：先 corepack yarn install（不得把「跑不起来」当通过）"
  elif (cd server/webadmin && run_limited 900 npm test) >"$log" 2>&1; then
    pass "webadmin npm test"
  else
    fail "webadmin npm test（日志 $log）"
    tail -n 8 "$log" | sed 's/^/      /'
  fi
fi

# ---------------------------------------------------------------------------
if want 6; then
  step "6. 协议探针（探针自判定 + 退出码；不 grep 文本；xvfb-run -a 与探针同命令）"
  PROBES=()
  while IFS= read -r probe; do
    # `if` 而不是 `[ … ] && …`：后者在 set -e 下，条件为假时整条列表非零 ⇒ 直接退出脚本。
    if [ -n "$probe" ]; then PROBES+=("$probe"); fi
  done < <(find scripts/wasm/probes scripts/probes -maxdepth 1 -type f -name 'probe-*.cjs' 2>/dev/null | sort -u)

  if [ "${#PROBES[@]}" -eq 0 ]; then
    fail "scripts/wasm/probes 下没有任何 probe-*.cjs —— 探针全丢等于本组没跑（拒绝空集通过）"
  elif [ ! -x "$ELECTRON_BIN" ] && [ ! -f "$ELECTRON_BIN" ]; then
    fail "找不到 Electron（$ELECTRON_BIN）：先 corepack yarn install"
  elif ! command -v xvfb-run >/dev/null 2>&1; then
    if [ "$(uname -s)" = "Linux" ]; then
      fail "Linux 上缺少 xvfb-run（apt install xvfb）—— 无头环境下探针跑不起来，不得静默跳过"
    else
      skip "非 Linux（$(uname -s)）：本机不使用 xvfb-run；三平台探针属 §16 W6（§17 认账 1），请在 W6 用各平台原生方式跑"
    fi
  else
    for probe in "${PROBES[@]}"; do
      name="$(basename "$probe")"
      log="$LOG_DIR/probe-$name.log"
      rc=0
      # 同一条命令里同时给 xvfb-run -a 与探针（否则显示器生命周期与探针不匹配）。
      # timeout 必须放在 env 链里（它得罩住 Electron 进程本身）；coreutils 的 timeout
      # 在 Linux 上一定存在，而本分支只在有 xvfb-run(⇒Linux) 时才走到。
      xvfb-run -a --server-args="-screen 0 1280x800x24" \
        env HOME="$PROBE_HOME" XDG_CONFIG_HOME="$PROBE_HOME/.config" \
            ELECTRON_DISABLE_SECURITY_WARNINGS=1 \
            PROBE_REQUIRE_COVERED_PLATFORM="${WASM_GATE_REQUIRE_COVERED_PLATFORM:-}" \
            PROBE_OUT_DIR="$LOG_DIR" \
            timeout "$PROBE_TIMEOUT" "$ELECTRON_BIN" --no-sandbox --disable-gpu "$probe" >"$log" 2>&1 || rc=$?
      case "$rc" in
        0)
          pass "$name（退出码 0 = 期望值全部满足）"
          grep -m1 'VERDICT' "$log" | sed 's/^/      /' || true ;;
        77)
          skip "$name 显式 SKIP（平台未覆盖；§17 认账 1 / W6 待补）" ;;
        *)
          fail "$name（退出码 $rc ≠ 0；日志 $log）"
          grep -m1 -E 'ASSERT|SKIP|fatal' "$log" | sed 's/^/      /' || true
          # W0-D 型探针的判定表（每条 required 的 PASS/FAIL/UNKNOWN + 汇总行）——
          # 没有它，失败只剩"退出码 1"，排障要翻整份日志。
          grep -E '^\[W0-D\] (FAIL|UNKNOWN) |^\[W0-D\] required=' "$log" | head -n 6 | sed 's/^/      /' || true
          grep -m1 '\[skip-note\]' "$log" | sed 's/^/      /' || true ;;
      esac
    done
  fi
fi

# ---------------------------------------------------------------------------
if want 7; then
  step "7. 渠道约束（§10：app_origin_scheme 必填 / 形状 / 跨渠道唯一；正式 tag dry-run；仓库 pin）"
  CHANNEL_ARGS=()
  if [ -n "${WASM_CHANNELS_REPO:-}" ]; then CHANNEL_ARGS+=(--channels-repo "$WASM_CHANNELS_REPO"); fi
  log="$LOG_DIR/channels.log"
  # 先语法检查再跑：这一段门禁的内容全在 `scripts/verify-wasm-channels.mjs` 里，
  # 而脚本解析失败时**整段代码根本不执行**，报出来的却只是"渠道约束未通过"——
  # 2026-09-20 实测被这一点绕了一圈（真正的病根是少了一个 `}`）。`node --check`
  # 只解析不执行，秒级成本换一个明确的失败原因。
  if ! node --check scripts/verify-wasm-channels.mjs 2>"$log"; then
    sed 's/^/  /' "$log"
    fail "守卫脚本本身语法错误（scripts/verify-wasm-channels.mjs 解析失败）"
  elif node scripts/verify-wasm-channels.mjs ${CHANNEL_ARGS[@]+"${CHANNEL_ARGS[@]}"} >"$log" 2>&1; then
    sed 's/^/  /' "$log"
    pass "渠道约束（含五条负例与正式 tag dry-run）"
  else
    sed 's/^/  /' "$log"
    fail "渠道约束未通过（日志 $log）"
  fi
fi

# ---------------------------------------------------------------------------
if want 8; then
  # TST-15：W5 的判据此前只是"文本存在性、无命令"，且只在 gitignore 的 temp 脚本里
  # （`temp/wasm-client-only/l5-acceptance.sh`）—— CI 与 `yarn check` 都碰不到。本组把
  # 它们变成**可复跑的命令**：纯 grep、无外部依赖、命中行先打印再 fail，每条失败都指回
  # 总纲条号，让人知道"为什么这条不能松"。
  #
  # 只看**源**文件：`site/dist`/`node_modules`/`.astro` 是构建产物（改了源会被覆盖），
  # `server/docs/**` 是第三方研究快照（抓取的大 JSON）—— 算进来只会把真正的文案问题淹掉。
  # 命中最多打印 12 行，避免刷屏。
  step "8. W5 文档与作者面判据（纯 grep；便携）"
  AUTHOR_DOC="docs/wasm-app-authoring.md"
  AUTHOR_SKILL_DIR="server/skills/app-builder"
  GREP_SRC_OPTS=(--exclude-dir=dist --exclude-dir=node_modules --exclude-dir=.astro --exclude-dir=build
                 --include='*.md' --include='*.mdx' --include='*.astro' --include='*.ts' --include='*.tsx')
  # 记录面（**必须**逐字保留旧措辞才有意义）不参与这两条文案判据：
  #   · docs/planning/**     —— 总纲/台账/早期契约：订正记录要引用被推翻的原话
  #                              （例如台账 R1-L5-14 必须写"原写『冻结与已下架都不列』"）；
  #   · docs/decisions/**    —— 作废决策（带作废横幅）；
  #   · docs/AUDIT-*.md      —— 审计留痕；docs/releases/** —— 历史发布说明。
  # 它们是"证据"，不是"现行处方"；把它们算进来只会让判据因为**记录本身**永远红。
  # （这些文件仍被第 2 组的零残留扫描以 C 桶覆盖，不是不管。）
  GREP_RECORD_EXCLUDES=(--exclude-dir=planning --exclude-dir=decisions --exclude-dir=releases --exclude=AUDIT-*.md)
  show_hits() {
    printf '%s\n' "$1" | head -n 12 | sed 's/^/      /'
    local total
    total="$(printf '%s\n' "$1" | wc -l | tr -d ' ')"
    if [ "$total" -gt 12 ]; then note "（命中 $total 行；此处只列前 12 行）"; fi
  }

  if [ ! -f "$AUTHOR_DOC" ] || [ ! -d "$AUTHOR_SKILL_DIR" ]; then
    fail "作者面文件缺失（$AUTHOR_DOC / $AUTHOR_SKILL_DIR）—— 判据无处可查不等于通过"
  else
    # ① 不得再宣称"不能联网"（§6 硬限制 + R1-RED-9/R2S-12 订正：CSP 不约束顶层导航与弹窗，
    #    真实边界是"不能主动发起 XHR/fetch 型请求"）。允许"不要对外说成不能联网"这类告诫句。
    hits="$(grep -rnE '不能联网|零网络' "$AUTHOR_DOC" "$AUTHOR_SKILL_DIR/SKILL.md" 2>/dev/null | grep -vE '不要对外说成|不要写|不等于' || true)"
    if [ -n "$hits" ]; then
      fail "作者面仍宣称「不能联网」（§6：真实边界=不能主动发起 XHR/fetch；顶层导航/弹窗由窗口闸门兜底）："
      show_hits "$hits"
    else
      pass "作者面没有「不能联网/零网络」的错误宣称（§6 订正）"
    fi

    # ② 作者面必须写明 Cache Storage 不可用（§3 F13 / 台账 CTL-3 的落点：custom scheme 上
    #    cache.put() 抛 TypeError ⇒ 允许 localStorage/IndexedDB，禁止依赖 Cache Storage）。
    if grep -rq 'Cache Storage' "$AUTHOR_DOC" "$AUTHOR_SKILL_DIR"; then
      pass "作者面写明 Cache Storage 的可用性口径（§3 F13）"
    else
      fail "作者面缺 Cache Storage 口径（§3 F13：可 open、不可 put ⇒ 禁止依赖）"
    fi

    # ③ 作者面必须有 window.ratio/width/height（§6 作者契约 + §13.2：ratio 越界 ⇒ 发布期 APP_CONFIG_INVALID）。
    if grep -rqE 'window\.(ratio|width|height)' "$AUTHOR_DOC" "$AUTHOR_SKILL_DIR"; then
      pass "作者面写明 window.ratio/width/height（§6/§13.2）"
    else
      fail "作者面缺 window.ratio/width/height（§6 作者契约；§13.2 要求 ratio 越界在发布期报 APP_CONFIG_INVALID）"
    fi

    # ④ 目录口径：不得再出现"下架不列/冻结与已下架都不列"（R1-L5-14 订正后：一律列出，
    #    只是不可打开/标注状态；"入口链接"字段也不存在）。
    hits="$(grep -rnE '冻结与已下架都不列|下架都列出来|下架不列' "${GREP_SRC_OPTS[@]}" "${GREP_RECORD_EXCLUDES[@]}" docs/ "$AUTHOR_SKILL_DIR" 2>/dev/null || true)"
    if [ -n "$hits" ]; then
      fail "仍有「下架不列」类口径（R1-L5-14 订正：目录一律列出，仅不可打开）："
      show_hits "$hits"
    else
      pass "目录口径统一（下架仍列出；R1-L5-14）"
    fi

    # ⑤ 载体词：全仓不得再出现"内置浏览器加载 / 浏览器标签承载"（§2.1/§4：应用只在桌面
    #    客户端内、每个应用一个独立窗口；浏览器标签不是承载形态）。
    hits="$(grep -rnE '内置浏览器加载|浏览器标签承载' "${GREP_SRC_OPTS[@]}" "${GREP_RECORD_EXCLUDES[@]}" \
      docs site/src server/docs "$AUTHOR_SKILL_DIR" README.md README.zh-CN.md 2>/dev/null || true)"
    if [ -n "$hits" ]; then
      fail "仍有把应用描述成「内置浏览器加载 / 浏览器标签承载」的文案（§2.1/§4：应用只在客户端内的独立窗口打开）："
      show_hits "$hits"
    else
      pass "载体口径统一（独立窗口；§2.1/§4）"
    fi
  fi
fi

# ---------------------------------------------------------------------------
step "结论（绑定 HEAD $HEAD_START）"
HEAD_END="$(git rev-parse HEAD)"
DIRTY_END="$(git status --porcelain | wc -l | tr -d ' ')"
{
  printf 'finished %s\n' "$(date -Is)"
  printf 'head_end %s\n' "$HEAD_END"
  printf 'dirty-end %s\n' "$DIRTY_END"
  printf 'pass %s fail %s skip %s\n' "$PASS_COUNT" "$FAIL" "$SKIP_COUNT"
} >>"$BINDING"

if [ "$HEAD_END" != "$HEAD_START" ]; then
  fail "跑的过程中 HEAD 变了（$HEAD_START → $HEAD_END）：本次结论不可比，必须重跑（本仓有并发编辑史）"
else
  note "HEAD 未变（$HEAD_START）；工作树改动 ${DIRTY_START} → ${DIRTY_END}"
fi
note "PASS ${PASS_COUNT} ｜ FAIL ${FAIL} ｜ SKIP ${SKIP_COUNT} ｜ 绑定文件 ${BINDING#"$ROOT/"}"

if [ "$FAIL" -eq 0 ]; then
  echo "全部通过 ✅"
  exit 0
fi
echo "存在失败项 ❌（见上；日志在 ${LOG_DIR#"$ROOT/"}）"
exit 1
