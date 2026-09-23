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
#   1 静态守卫（布局/清单/工作流）        2 三方对拍 + 旧模型零残留（清单/规则驱动）
#   3 服务端 go build/vet/定向测试（真 PG；**用例级 0 skip**）
#   4 客户端三包 check                   5 webadmin npm test
#   6 协议探针（scripts/wasm/probes/*，自判定 + 退出码；xvfb-run -a 与探针同命令）
#   7 渠道约束（§10：app_origin_scheme 必填/形状/唯一 + 仓库 pin）
#       真实渠道仓 dry-run 是**显式可选步骤**（公开仓不持有渠道仓，也不联网）：未提供
#       WASM_CHANNELS_REPO 时按 SKIP 计入组级 SKIP 计数，PASS 文案按**实际执行面**生成
#       （2026-09-23 三轮审计 W-6：旧文案把没跑的 dry-run 说成跑过了，且 SKIP 不计入计数）。
#   8 W5 文档与作者面判据（模式判据 + 按分句豁免 + 结论钉牢 + 合成负例回归；便携组；TST-15 的机器判据）
#       实现收在 `scripts/wasm/check-authoring-claims.mjs`（2026-09-23 三轮审计 W-7/W-9：
#       三条反向判据曾是固定枚举、一条豁免是整行关键词、两条正向判据只查关键词存在、
#       扫描根含死条目且 `2>/dev/null || true` 吞掉 grep 自身的 rc≥2）。
#       扫描面（2026-09-23 W-7 收口）：docs / site/src / server/docs / server/skills/app-builder
#       **+ packages（workspace 源码）+ community** + 仓库根 `README*.md`；`lib`（构建产物）
#       与 `__snapshots__` 排除，"扫描面不得静默缩小"有两条互相独立的判据（登记值全覆盖 +
#       package.json#workspaces 顶层段全覆盖，任一缺项即退出码 2）。
#
# **组级不变量（R4-A-15，2026-09-23 四轮审计）**：所选定的**每一个组都必须至少跑成 1 条
# 断言**（PASS ≥ 1），否则该组在收尾时判红并点名"组 N 零断言"。它由 `group_begin` /
# `group_settle` 一对原语实现，**不依附于任何分支** —— 早退 skip（非 Linux 平台）、
# 探针全 77、前置缺失、子脚本空转、将来新增的任何早退路径，一律覆盖。旧实现把
# "全组 SKIP = 失败"只写在组 6 的 xvfb-run 分支里，于是非 Linux 上 `--groups 6` 打印
# `PASS 0 ｜ FAIL 0 ｜ SKIP 1` + `全部通过 ✅` 且 EXIT=0（零断言当通过）。
# SKIP 的**语义与理由可解析**（照 W-6 在组 7 建立的协议）：绑定文件里逐组写
# `group <n> pass=… fail=… skip=…`，每处跳过写一行 `group-skip <n> <理由>`；
# 收尾按这份独立来源复算条数，与内存计数不符即判"SKIP 记账协议坏了"。
#
# 用法：
#   bash scripts/verify-wasm-client-only.sh                 # 全量（1–8）
#   bash scripts/verify-wasm-client-only.sh --portable      # 与产物/PG/显示器无关的子集（1,2,7,8）
#                                                           # —— 供 `yarn check` 的 GUARDS 与本地快跑
#   bash scripts/verify-wasm-client-only.sh --groups 2,6    # 只跑指定组（1–8）
#   bash scripts/verify-wasm-client-only.sh --require-clean # 工作树脏 ⇒ 本组结论判失败（CI 用）
#   bash scripts/verify-wasm-client-only.sh --list
#
# 各组前置与**接线现状**（2026-09-23 第三轮审计 W-4/W-5；改 CI 前先读这段）：
#   组 3（用例级 0 skip）需要真 PG：本地 = `PG_DSN_TEST=… bash scripts/verify-wasm-client-only.sh --groups 3`；
#        CI 里**尚未接线**（`.github/workflows` 目前跑的是裸 `go test`，没有 -json + 判定这一步）。
#        Go 环境缺省钉在仓内（temp/gomodcache + GOPROXY=off）；CI/宿主已有模块缓存时用
#        `WASM_GATE_GO_ENV=host` 继承调用方的 GOCACHE/GOMODCACHE/GOPROXY。
#   组 6（协议探针）需要显示器与 Electron：本地 = `bash scripts/verify-wasm-client-only.sh --groups 6`
#        （Linux 上脚本自己用 xvfb-run）；CI 里同样**尚未接线**（Gate job 已装 xvfb，接线成本 = 一个 step）。
#        非 Linux 平台：探针显式 SKIP（退出码 77）；`WASM_GATE_REQUIRE_COVERED_PLATFORM=1` 时
#        未覆盖平台一律 77 而不是"跑完给结论"。
# 环境变量（参数化，避免把本机路径写死 —— R2T-12）：
#   PG_DSN_TEST      定向测试的数据库（缺省 postgres://postgres:postgres@127.0.0.1:5432/picoaide_test）
#   PROBE_TIMEOUT    单探针超时秒数（缺省 180）
#   ELECTRON_BIN     Electron 可执行文件（缺省 packages/host/desktop/node_modules/.bin/electron）
#   WASM_CHANNELS_REPO  真实私有渠道仓检出（可选；给了就跑正式 tag dry-run；不给则该步骤计入 SKIP）
#   WASM_GATE_LOG_DIR   日志目录（缺省 temp/wasm-client-only/gate-logs）
#   WASM_GATE_GO_ENV    repo（缺省，Go 缓存钉在仓内且离线）/ host（继承宿主 GOCACHE/GOMODCACHE/GOPROXY）
#   WASM_GATE_REQUIRE_COVERED_PLATFORM=1  非 Linux 平台上探针按显式 SKIP（退出码 77）处理
#   WASM_GATE_EXPECT_HEAD  跑前锁定的期望 HEAD（7–40 位小写十六进制，按**前缀**比较）。
#                       不匹配即**跑前**失败（退出码 2）并说明「结论不可比」；CI 应传 `github.sha`。
#                       接线现状（2026-09-23，W-8 收口）：`.github/workflows/ci.yml` 的 gate job 里
#                       **两处**入口都设了它——`Full gate (packages + all root guards)`（经
#                       `check:wasm-client-only` 跑本脚本）与 `WASM protocol probes (group 6)`；
#                       两处由 `scripts/check-workflows.mjs` 的 [SK-12]③ 钉住，取值必须是
#                       `${{ github.sha }}`（写死字面量会在下一次提交后恒红）。
#                       `scripts/verify-ci-scripts.mjs` 另有动态判据：拿 ci.yml 里的**变量名**
#                       配一个不等于 HEAD 的 sha 实跑本脚本，必须以退出码 2 前置拒绝。
#   WASM_GATE_REQUIRE_CLEAN=1  等价于 --require-clean：工作树有改动即判失败（缺省只 WARN 并写进结论行）
#                       **刻意不接进 CI**（2026-09-23 拍板，理由见 ci.yml 该 step 的注释）：
#                       本仓共享工作树恒脏、门禁自身会产出被忽略的构建产物，"必须干净"容易变成
#                       假红，而假红的下场通常是整条判据被关掉；缺省口径不是静默的——脏树会以
#                       `WARN 工作树不干净（跑前 N → 跑后 M 个改动）` 写进结论行与绑定文件的
#                       `dirty-policy` 行。CI 的干净检出下它是绿的（副本仓实测）。
# 退出码：0 = 所选组全部通过（且每个被选中的组都至少有 1 条 PASS）；1 = 有失败项
#         （含"某组零断言"这条组级不变量）；2 = 用法/环境错误（含跑前期望 HEAD 与当前 HEAD 不一致）。

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PG_DSN_TEST="${PG_DSN_TEST:-postgres://postgres:postgres@127.0.0.1:5432/picoaide_test}"
PROBE_TIMEOUT="${PROBE_TIMEOUT:-180}"
ELECTRON_BIN="${ELECTRON_BIN:-$ROOT/packages/host/desktop/node_modules/.bin/electron}"
LOG_DIR="${WASM_GATE_LOG_DIR:-$ROOT/temp/wasm-client-only/gate-logs}"
PROBE_HOME="${PROBE_HOME:-${TMPDIR:-/tmp}/wasm-gate-home}"

# Go 缓存缺省固定落在仓库内（判据要求）：不写 ~/.cache，且**离线**（GOPROXY=off）——
# 门禁不允许在跑的中途去下载模块，那会让"同一 HEAD 两次结论不同"。
#
# WASM_GATE_GO_ENV=host（2026-09-23，W-4 接线的必要条件）：继承调用方/宿主的
# GOCACHE/GOMODCACHE/GOPROXY —— CI 的 server job 用宿主模块缓存（镜像里已装好依赖），
# 仓内缓存并不存在；硬钉 `GOPROXY=off` + 空仓内缓存只会得到 `go: download …: toolchain
# not available` 这种与代码无关的假红（W 泳道在 clone 上实测过）。缺省仍是 repo。
if [ "${WASM_GATE_GO_ENV:-repo}" = "host" ]; then
  GO_ENV_NOTE="host：继承 GOCACHE=${GOCACHE:-<unset>} GOMODCACHE=${GOMODCACHE:-<unset>} GOPROXY=${GOPROXY:-<unset>}"
else
  export GOCACHE="$ROOT/temp/go-build"
  export GOMODCACHE="$ROOT/temp/gomodcache"
  export GOPROXY=off
  GO_ENV_NOTE="repo：GOCACHE/GOMODCACHE 在仓内，GOPROXY=off（可用 WASM_GATE_GO_ENV=host 继承宿主）"
fi
export PG_DSN_TEST

mkdir -p "$LOG_DIR" "$PROBE_HOME"

# ── 探针证据协议（R4-A N2 / VERIFY.md §7-N2）──────────────────────────────────
#
# 现场：组级不变量是**计数**不变量（"该组 PASS ≥ 1"）。两种绕过都成立：
#   ① 早退分支把 `skip` 写成 `pass` ⇒ `group 6 pass=1 skip=0` + `全部通过 ✅` / EXIT=0；
#   ② 把探针换成 `exit 0` 桩并打印**伪造的** VERDICT 行 ⇒ 4 PASS / EXIT=0。
#
# 现在的口径（**集合**判定，不是计数）：
#   · 门禁每次运行生成随机 nonce 并经环境传给探针；真探针必须打印**恰好一行**
#     `PROBE-ATTEST probe=<basename> assertions=… pass=… fail=… skip=… platformCovered=… nonce=…`
#     （协议在 `scripts/wasm/probes/probe-attest.cjs`）；
#   · 每个被发现的探针都必须**有据可查**：`probe-attested:<name>`（rc=0 且证据自洽）
#     或 `probe-skipped:<name>`（rc=77 且证据里 platformCovered=0）；
#   · 组级不变量 = 「被发现的探针集合 == 有证据的探针集合」（缺一具名、多一具名都红）
#     且至少一条 `probe-attested`（全组 SKIP 仍红）；
#   · 自证样本（`PROBE_EVIDENCE_SELFTEST_CASES` + `GROUP6_SELFTEST_CASES`）把
#     "exit 0 桩"、"跳过却打 PASS"、"伪造 nonce"、"部分证据"四种形态逐条钉死，
#     由 `--self-check` 独立跑（不需要 Electron/显示器），并在组 6 里**强制先跑**。
PROBE_ATTEST_NONCE="${PROBE_ATTEST_NONCE:-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(8).toString("hex"))' 2>/dev/null || printf 'fallback-%s-%s' "$$" "$RANDOM")}"
export PROBE_ATTEST_NONCE

# 探针证据的**自证样本登记表**（`id|期望|rc|证据行模板`）。模板里 `@NONCE@` 由自证替换成
# 本次真 nonce；`@WRONG@` 替换成一个必然不等于本次 nonce 的串。
# 期望 `reject` = 该样本**必须**被 validator 拒（否则这条判据是空的）。
PROBE_EVIDENCE_SELFTEST_CASES=(
  "exit0-silent|reject|0|"
  "exit0-forged-static|reject|0|PROBE-ATTEST probe=@PROBE@ assertions=1 pass=1 fail=0 skip=0 platformCovered=1 nonce=deadbeefdeadbeef"
  "exit0-forged-nonce-echo|reject|0|PROBE-ATTEST probe=@PROBE@ assertions=0 pass=0 fail=0 skip=0 platformCovered=1 nonce=@NONCE@"
  "exit0-counts-inconsistent|reject|0|PROBE-ATTEST probe=@PROBE@ assertions=5 pass=1 fail=0 skip=0 platformCovered=1 nonce=@NONCE@"
  "wrong-probe-id|reject|0|PROBE-ATTEST probe=someone-else.cjs assertions=1 pass=1 fail=0 skip=0 platformCovered=1 nonce=@NONCE@"
  "duplicate-attest-lines|reject|0|PROBE-ATTEST probe=@PROBE@ assertions=1 pass=1 fail=0 skip=0 platformCovered=1 nonce=@NONCE@\nPROBE-ATTEST probe=@PROBE@ assertions=1 pass=1 fail=0 skip=0 platformCovered=1 nonce=@NONCE@"
  "skip-with-pass-attest|reject|77|PROBE-ATTEST probe=@PROBE@ assertions=1 pass=1 fail=0 skip=0 platformCovered=0 nonce=@NONCE@"
  "stub-exit0-nonzero-exit|reject|1|PROBE-ATTEST probe=@PROBE@ assertions=1 pass=1 fail=0 skip=0 platformCovered=1 nonce=@NONCE@"
  "valid-attested|accept|0|PROBE-ATTEST probe=@PROBE@ assertions=3 pass=3 fail=0 skip=0 platformCovered=1 nonce=@NONCE@"
  "valid-platform-skip|accept-skip|77|PROBE-ATTEST probe=@PROBE@ assertions=2 pass=0 fail=0 skip=2 platformCovered=0 nonce=@NONCE@"
)
# 组级不变量的自证样本（`id|期望|已发现探针|已有证据`；全部是纯数据 ⇒ 不需要真探针）。
GROUP6_SELFTEST_CASES=(
  "all-settled|ok|p1 p2|probe-attested:p1 probe-skipped:p2"
  "early-exit-pass-no-evidence|reject|p1|"
  "skip-printed-as-pass|reject|p1|"
  "partial-evidence|reject|p1 p2|probe-attested:p1"
  "unknown-evidence|reject|p1|probe-attested:p1 probe-attested:p9"
  "all-skipped|reject|p1 p2|probe-skipped:p1 probe-skipped:p2"
)

# 自证样本数的**下限**（棘轮：删样本必须同时改这里并进 diff）。删掉"exit 0 桩"这类
# 样本后，剩下的样本照样全部通过 —— 只看"跑到的 == 登记的"是抓不住缩面的。
PROBE_EVIDENCE_MIN_SAMPLES=10
GROUP6_MIN_SAMPLES=6

# 从证据行里取字段（`key=value`，空格分隔）。
attest_field() { # <line> <key>
  printf '%s\n' "$1" | tr ' ' '\n' | sed -n "s/^$2=//p" | head -n 1
}

# 校验一条探针证据。打印 `accept` / `accept-skip` / `reject:<原因>`，退出码 0=接受、1=拒绝。
# 参数：<探针 basename> <退出码> <日志文件>
probe_evidence_verdict() {
  local probe="$1" rc="$2" log="$3"
  if [ ! -f "$log" ]; then printf 'reject:日志不存在'; return 1; fi
  local count
  count="$(grep -c '^PROBE-ATTEST ' "$log" 2>/dev/null || true)"
  count="${count:-0}"
  if [ "$rc" = "77" ]; then
    if [ "$count" != "1" ]; then printf 'reject:显式 SKIP 但没有恰好一行证据（%s 行）' "$count"; return 1; fi
    local line
    line="$(grep -m1 '^PROBE-ATTEST ' "$log")"
    if [ "$(attest_field "$line" probe)" != "$probe" ]; then printf 'reject:证据行的 probe 不是本探针'; return 1; fi
    if [ "$(attest_field "$line" nonce)" != "$PROBE_ATTEST_NONCE" ]; then printf 'reject:证据行 nonce 不是本次运行'; return 1; fi
    if [ "$(attest_field "$line" platformCovered)" != "0" ]; then printf 'reject:显式 SKIP 的证据行必须标 platformCovered=0'; return 1; fi
    if [ "$(attest_field "$line" pass)" != "0" ]; then
      printf 'reject:显式 SKIP 的证据行不得声称有通过断言（pass=%s ⇒ "跳过却打 PASS"的形态）' "$(attest_field "$line" pass)"
      return 1
    fi
    printf 'accept-skip'; return 0
  fi
  if [ "$rc" != "0" ]; then printf 'reject:退出码 %s（只有 0 或 77 才算跑成）' "$rc"; return 1; fi
  if [ "$count" != "1" ]; then printf 'reject:证据行应为恰好 1 行，实得 %s ⇒ exit 0 桩/协议损坏' "$count"; return 1; fi
  local line a p f s
  line="$(grep -m1 '^PROBE-ATTEST ' "$log")"
  if [ "$(attest_field "$line" probe)" != "$probe" ]; then
    printf 'reject:证据行 probe=%s 与本探针 %s 不符' "$(attest_field "$line" probe)" "$probe"; return 1
  fi
  if [ "$(attest_field "$line" nonce)" != "$PROBE_ATTEST_NONCE" ]; then
    printf 'reject:nonce 不是本次运行（写死的伪造行/复制的旧日志）'; return 1
  fi
  a="$(attest_field "$line" assertions)"; p="$(attest_field "$line" pass)"
  f="$(attest_field "$line" fail)"; s="$(attest_field "$line" skip)"
  case "$a$p$f$s" in
    *[!0-9]*|"") printf 'reject:计数不是非负整数（assertions=%s pass=%s fail=%s skip=%s）' "$a" "$p" "$f" "$s"; return 1 ;;
  esac
  if [ "$a" -lt 1 ]; then printf 'reject:assertions=0（零断言不得当通过）'; return 1; fi
  if [ "$f" -ne 0 ]; then printf 'reject:fail=%s（探针自己报了失败）' "$f"; return 1; fi
  if [ "$p" -lt 1 ]; then printf 'reject:pass=0（零通过断言不得当通过）'; return 1; fi
  if [ "$p" -ne "$((a - s))" ]; then
    printf 'reject:计数自洽性失败（pass=%s + skip=%s ≠ assertions=%s）' "$p" "$s" "$a"; return 1
  fi
  printf 'accept'; return 0
}

# 组 6 的**集合**不变量。参数：<已发现探针清单文件> <证据清单文件>。
# 打印 `ok` 或 `reject:<原因>`；退出码 0=成立、1=不成立。
group6_invariant() {
  local discovered_file="$1" evidence_file="$2"
  local missing="" extra="" attested=0 settled=""
  while IFS= read -r probe; do
    [ -n "$probe" ] || continue
    if grep -qx "probe-attested:$probe" "$evidence_file"; then attested=$((attested + 1)); settled="$settled $probe"; continue; fi
    if grep -qx "probe-skipped:$probe" "$evidence_file"; then settled="$settled $probe"; continue; fi
    missing="$missing $probe"
  done <"$discovered_file"
  while IFS= read -r record; do
    [ -n "$record" ] || continue
    local id="${record#*:}"
    if ! grep -qx "$id" "$discovered_file"; then extra="$extra $id"; fi
  done <"$evidence_file"
  if [ -n "$missing" ]; then printf 'reject:这些被发现的探针没有任何可判定的证据（既非 attested 也非 skipped）:%s' "$missing"; return 1; fi
  if [ -n "$extra" ]; then printf 'reject:出现了不在发现集合里的证据:%s' "$extra"; return 1; fi
  if [ "$attested" -eq 0 ]; then printf 'reject:没有任何一条 probe-attested（全组 SKIP/桩 ⇒ 零断言）'; return 1; fi
  printf 'ok'; return 0
}

# 自证：证据 validator + 组级不变量。返回 0/1，并把结论写进 $1（可选）。
probe_evidence_selftest() {
  local report="${1:-}"
  local dir="$LOG_DIR/probe-evidence-selftest"
  rm -rf "$dir"; mkdir -p "$dir"
  local failures=0 observed_ids="" accepted=0 rejected=0
  local spec id expect rc template probe line verdict log
  for spec in "${PROBE_EVIDENCE_SELFTEST_CASES[@]}"; do
    IFS='|' read -r id expect rc template <<<"$spec"
    probe="probe-${id}.cjs"
    log="$dir/$id.log"
    : >"$log"
    if [ -n "$template" ]; then
      printf '%b\n' "$template" \
        | sed -e "s/@PROBE@/$probe/g" -e "s/@NONCE@/$PROBE_ATTEST_NONCE/g" >"$log"
    fi
    verdict="$(probe_evidence_verdict "$probe" "$rc" "$log")" || true
    observed_ids="$observed_ids $id"
    case "$verdict" in
      accept) accepted=$((accepted + 1)) ;;
      accept-skip) accepted=$((accepted + 1)) ;;
      *) rejected=$((rejected + 1)) ;;
    esac
    local matched=0
    case "$verdict" in
      "$expect"|"$expect":*) matched=1 ;;
    esac
    if [ "$matched" -ne 1 ]; then
      printf 'probe-evidence 自证: 样本 %s 期望 %s，实得 %s\n' "$id" "$expect" "$verdict" >&2
      failures=$((failures + 1))
    fi
  done
  # 组级不变量的样本（纯数据）
  local gspec gexpect gdiscovered gevidence
  for gspec in "${GROUP6_SELFTEST_CASES[@]}"; do
    IFS='|' read -r id gexpect gdiscovered gevidence <<<"$gspec"
    printf '%s\n' ${gdiscovered:-} >"$dir/$id.discovered"
    : >"$dir/$id.evidence"
    for record in $gevidence; do printf '%s\n' "$record" >>"$dir/$id.evidence"; done
    verdict="$(group6_invariant "$dir/$id.discovered" "$dir/$id.evidence")" || true
    if [ "$gexpect" = "ok" ]; then
      if [ "$verdict" != "ok" ]; then
        printf 'group6 不变量自证: 样本 %s 期望 ok，实得 %s\n' "$id" "$verdict" >&2
        failures=$((failures + 1))
      fi
    else
      case "$verdict" in
        reject:*) ;;
        *) printf 'group6 不变量自证: 样本 %s 期望 reject，实得 %s\n' "$id" "$verdict" >&2
           failures=$((failures + 1)) ;;
      esac
    fi
    observed_ids="$observed_ids group6:$id"
  done
  # 登记表双向对拍：跑到的样本必须恰好是登记的（少一条 = 自证被删/短路）。
  local expected_ids="" extra_ids=""
  for spec in "${PROBE_EVIDENCE_SELFTEST_CASES[@]}"; do expected_ids="$expected_ids ${spec%%|*}"; done
  for gspec in "${GROUP6_SELFTEST_CASES[@]}"; do expected_ids="$expected_ids group6:${gspec%%|*}"; done
  local required_count=0
  for id in $expected_ids; do required_count=$((required_count + 1)); done
  if [ "${#PROBE_EVIDENCE_SELFTEST_CASES[@]}" -lt "$PROBE_EVIDENCE_MIN_SAMPLES" ] \
    || [ "${#GROUP6_SELFTEST_CASES[@]}" -lt "$GROUP6_MIN_SAMPLES" ]; then
    printf 'probe-evidence 自证: 登记样本被删到没有判别力（validator %s < %s / 组级不变量 %s < %s）\n' \
      "${#PROBE_EVIDENCE_SELFTEST_CASES[@]}" "$PROBE_EVIDENCE_MIN_SAMPLES" \
      "${#GROUP6_SELFTEST_CASES[@]}" "$GROUP6_MIN_SAMPLES" >&2
    failures=$((failures + 1))
  fi
  local observed_count=0
  for id in $observed_ids; do observed_count=$((observed_count + 1)); done
  if [ "$observed_count" -ne "$required_count" ]; then
    printf 'probe-evidence 自证: 样本数不符（实跑 %s / 登记 %s）—— 自证被删/短路\n' \
      "$observed_count" "$required_count" >&2
    failures=$((failures + 1))
  fi
  if [ "$accepted" -lt 2 ] || [ "$rejected" -lt 1 ]; then
    printf 'probe-evidence 自证: 接受 %s 条 / 拒绝 %s 条 —— 两侧都要有样本（否则判据可能恒接受或恒拒绝）\n' \
      "$accepted" "$rejected" >&2
    failures=$((failures + 1))
  fi
  # 结论行（供 `--self-check` 与 CI 独立守卫消费；**不许**静默）
  local summary="probe-evidence self-check: samples=${observed_count}/${required_count} accepted=${accepted} rejected=${rejected} nonce=${PROBE_ATTEST_NONCE}"
  if [ -n "$report" ]; then printf '%s\n' "$summary" >"$report"; fi
  printf '%s\n' "$summary"
  if [ "$failures" -ne 0 ]; then return 1; fi
  return 0
}


# ---------------------------------------------------------------------------
# 参数
# ---------------------------------------------------------------------------
MODE="full"
GROUPS_SELECTED=""
# 「有没有显式点名分组」必须独立记账（2026-09-23 审计 W3-05）：用 `-z "$GROUPS_SELECTED"`
# 兼作"没传"的判据时，`--groups ""` 这个**显式空值**会被下面的缺省分支替换成
# `1 2 3 4 5 6 7 8` —— "什么都没选"被静默执行成"全选"，而紧随其后的
# "没有选中任何组 ⇒ exit 2" 在那条路径上永远不可达。
GROUPS_EXPLICIT=0
# W-8②：脏树的判定口径（缺省 WARN + 写进结论行；`--require-clean` / WASM_GATE_REQUIRE_CLEAN=1 时判失败）。
# 为什么默认不是失败：本仓有并发编辑史，把"脏树"一律判死会让门禁在共享工作目录里恒红，人就会学着忽略它；
# 但"只记录不断言"同样不行（结论会被当成干净 HEAD 的结论）⇒ 折中是**显式的、进结论行的 WARN**，
# 并把硬判据留给**显式调用**（--require-clean / WASM_GATE_REQUIRE_CLEAN=1）。
# **CI 刻意不接这个开关**（2026-09-23 拍板）：见脚本头「环境变量」一节与 ci.yml 里该 step 的注释 ——
# 共享工作树恒脏 + 门禁自身产出被忽略的构建产物 ⇒ "必须干净"容易变成假红，而假红的下场通常是关掉判据。
REQUIRE_CLEAN="${WASM_GATE_REQUIRE_CLEAN:-0}"
# 非法取值 fail-loud（不静默降级成 warn）：写 `=true`/`=yes` 是很自然的误用，而它一旦被当成
# "没开"，脏树就只剩 WARN —— 那正是 W-8② 要消灭的形态（CI 里静默失去这条判据）。
case "$REQUIRE_CLEAN" in
  0|1) ;;
  *) echo "verify-wasm-client-only: WASM_GATE_REQUIRE_CLEAN 取值非法（$REQUIRE_CLEAN）——" \
       "只接受 0 或 1（要开就用 1 或 --require-clean）" >&2
     exit 2 ;;
esac
while [ $# -gt 0 ]; do
  case "$1" in
    --portable) MODE="portable"; shift ;;
    --self-check) MODE="self-check"; shift ;;
    --require-clean) REQUIRE_CLEAN=1; shift ;;
    --groups)
      if [ $# -lt 2 ]; then
        echo "verify-wasm-client-only: --groups 缺参数（用法：--groups 2,6；可选组见 --list）" >&2
        exit 2
      fi
      GROUPS_SELECTED="$2"; GROUPS_EXPLICIT=1; shift 2 ;;
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
    sed -n '2,46p' "${BASH_SOURCE[0]}"
    exit 0 ;;
  list)
    printf '%s\n' "${GROUP_NAMES[@]}"
    exit 0 ;;
  self-check)
    # 探针证据协议的自证（R4-A N2）：不需要 Electron / 显示器 / PG —— 供 CI 与
    # `verify-ci-scripts.mjs` 独立驱动（"拆掉自证 ⇒ 红"要靠外部守卫跑它）。
    if probe_evidence_selftest; then
      echo "verify-wasm-client-only: 探针证据自证通过（--self-check）✅"
      exit 0
    fi
    echo "verify-wasm-client-only: 探针证据自证失败（--self-check）❌" >&2
    exit 1 ;;
  portable)
    # W5 文档判据（组 8）是纯 grep、无外部依赖 ⇒ 进便携组，`yarn check` 每次都跑（TST-15）。
    if [ "$GROUPS_EXPLICIT" -eq 0 ]; then GROUPS_SELECTED="1 2 7 8"; fi ;;
  full)
    # 缺省只在**没显式点名**时生效：`--groups 2` 不得被覆盖成全部八组，
    # `--groups ""` 更不得被"补成"全选（那是把"什么都没选"执行成"全选"）。
    if [ "$GROUPS_EXPLICIT" -eq 0 ]; then GROUPS_SELECTED="1 2 3 4 5 6 7 8"; fi ;;
esac

# `--groups 2,6` → `2 6`
GROUPS_SELECTED="${GROUPS_SELECTED//,/ }"
if [ -z "${GROUPS_SELECTED// /}" ]; then
  if [ "$GROUPS_EXPLICIT" -eq 1 ]; then
    echo "verify-wasm-client-only: --groups 传了空值 —— 「什么都没选」不等于「全选」。" \
      "显式点名分组时至少要给一个组（1–8，逗号分隔，如 --groups 2,6）；要跑全部就省略 --groups。" >&2
  else
    echo "verify-wasm-client-only: 没有选中任何组（模式 $MODE）—— 拒绝以空集当成通过。" >&2
  fi
  exit 2
fi
GROUP_COUNT=0
VALIDATED_GROUPS=()
for g in $GROUPS_SELECTED; do
  case "$g" in 1|2|3|4|5|6|7|8) ;; *) echo "verify-wasm-client-only: 未知组 '$g'（可选 1–8）" >&2; exit 2 ;; esac
  case " ${VALIDATED_GROUPS[*]-} " in *" $g "*) ;; *) VALIDATED_GROUPS+=("$g") ;; esac
done
GROUPS_SELECTED="${VALIDATED_GROUPS[*]}"
GROUP_COUNT="${#VALIDATED_GROUPS[@]}"
want() { case " $GROUPS_SELECTED " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# ---------------------------------------------------------------------------
# 报告原语
# ---------------------------------------------------------------------------
FAIL=0
PASS_COUNT=0
SKIP_COUNT=0
pass() { printf '  \033[32mPASS\033[0m %s\n' "$1"; PASS_COUNT=$((PASS_COUNT + 1)); GROUP_PASS=$((GROUP_PASS + 1)); }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; FAIL=$((FAIL + 1)); GROUP_FAIL=$((GROUP_FAIL + 1)); }
skip() {
  printf '  \033[33mSKIP\033[0m %s\n' "$1"
  SKIP_COUNT=$((SKIP_COUNT + 1)); GROUP_SKIP=$((GROUP_SKIP + 1))
  # SKIP 必须**可解析**（W-6 的协议，R4-A-15 把它推广到每个组）：每处跳过都写一行
  # `group-skip <组> <理由>`；收尾按这份**独立来源**复算计数，与内存计数不符即协议坏了。
  printf 'group-skip %s %s\n' "${GROUP_ID:-<未开始>}" "$1" >>"$GROUP_SKIP_FILE"
}
note() { printf '  %s\n' "$1"; }
# 组级**证据**记录（R4-A N2）：与 pass/skip 并列的第三条通道，写进绑定文件
# `group-evidence <组> <token>`。收尾按它复算"组 6 的集合不变量真的跑过"。
GROUP_EVIDENCE=0
evidence() {
  printf 'group-evidence %s %s\n' "${GROUP_ID:-<未开始>}" "$1" >>"$BINDING"
  GROUP_EVIDENCE=$((GROUP_EVIDENCE + 1))
}
step() { printf '\n== %s\n' "$1"; }

# ── 组级记账（R4-A-15，2026-09-23 四轮审计）───────────────────────────────────
# 旧实现把"全组 SKIP = 失败"**只**写在组 6 的 xvfb-run 分支内部（`probe_pass -eq 0 &&
# probe_skip -gt 0`），而组 6 在非 Linux 平台上走的是**探针循环之前**的早退分支
# （`skip "非 Linux…"`）⇒ 汇总打印 `PASS 0 ｜ FAIL 0 ｜ SKIP 1` + `全部通过 ✅` 且 EXIT=0，
# 零断言当通过。现在把"该组一条都没跑成 ⇒ 该组失败"做成**组级不变量**：每组开始时清零、
# 收尾时判定，所以它在**任何平台、任何分支**（早退 skip / 前置缺失 / 探针全 77 /
# 子脚本空转 / 将来新增的早退路径）上都成立 —— 规则不再依附于某条分支。
GROUP_ID=""
GROUP_PASS=0
GROUP_FAIL=0
GROUP_SKIP=0
GROUP_SKIP_FILE="$LOG_DIR/group-skips.txt"
: >"$GROUP_SKIP_FILE"
group_begin() { GROUP_ID="$1"; GROUP_PASS=0; GROUP_FAIL=0; GROUP_SKIP=0; }
group_settle() {
  local group="$GROUP_ID"
  local reason_lines=0
  reason_lines="$(grep -c "^group-skip ${group} " "$GROUP_SKIP_FILE" || true)"
  reason_lines="${reason_lines:-0}"
  {
    printf 'group %s pass=%s fail=%s skip=%s\n' "$group" "$GROUP_PASS" "$GROUP_FAIL" "$GROUP_SKIP"
    if [ "$reason_lines" != "$GROUP_SKIP" ]; then
      printf 'group-protocol-broken %s skip-count=%s skip-reason-lines=%s\n' "$group" "$GROUP_SKIP" "$reason_lines"
    fi
  } >>"$BINDING"
  if [ "$reason_lines" != "$GROUP_SKIP" ]; then
    fail "组 ${group} 的 SKIP 计数（$GROUP_SKIP）与可解析理由行数（$reason_lines）不符 —— SKIP 记账协议坏了（$GROUP_SKIP_FILE）"
  fi
  if [ "$GROUP_PASS" -eq 0 ]; then
    fail "组 ${group} 零断言（PASS 0 ｜ FAIL ${GROUP_FAIL} ｜ SKIP ${GROUP_SKIP}）：该组一条断言都没跑成 —— 全组 SKIP / 零 PASS 不得当通过（组级不变量，任何平台、任何分支都成立）"
  fi
  # 组 6 另有一条**集合**不变量（R4-A N2）：探针证据自证与"发现集合 == 证据集合"必须
  # 真的跑过（`evidence` 会落 `group-evidence` 行）。缺了它说明有人把这两条剪掉了 ——
  # 那时 PASS 计数仍可能 ≥1（正是"跳过却打 PASS"的形态）。
  if [ "$group" = "6" ]; then
    local selftest_lines=0 invariant_lines=0
    selftest_lines="$(grep -c "^group-evidence 6 probe-evidence-selftest:" "$BINDING" || true)"
    invariant_lines="$(grep -c "^group-evidence 6 group6-invariant:" "$BINDING" || true)"
    selftest_lines="${selftest_lines:-0}"; invariant_lines="${invariant_lines:-0}"
    if [ "$selftest_lines" -lt 1 ] || [ "$invariant_lines" -lt 1 ]; then
      fail "组 6 缺少证据链（自证记录 ${selftest_lines} / 集合不变量记录 ${invariant_lines}）：" \
        "探针证据自证与集合不变量必须**都跑过** —— 缺任一条，本组的"探针都跑过了"都不可信（R4-A N2）"
    fi
  fi
}


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
#
# 2026-09-23 三轮审计 W-8：「绑定 HEAD」此前只做**自洽**（跑前 == 跑后），不绑任何权威 ——
# 换 commit、带脏树都能拿到同一句"全部通过 ✅（绑定 HEAD …）"。现在补三件事：
#   ① **跑前**接受期望 HEAD（WASM_GATE_EXPECT_HEAD，CI 传 github.sha）：不匹配即退出码 2，
#      并明说"结论不可比"——这是前置失败，不是"判据没通过"；
#      **接线现状（W-8 收口）**：CI gate job 的两处入口（`yarn check` 那一步与组 6 探针那一步）
#      都已设它，由 `check-workflows.mjs` 的 [SK-12]③ 静态钉住（取值必须是 `${{ github.sha }}`），
#      `verify-ci-scripts.mjs` 另有"拿 ci.yml 的变量名 + 错 sha 实跑 ⇒ 必须前置拒绝"的动态判据；
#   ② 脏树有**显式判据**（缺省 WARN 写进结论行；--require-clean / WASM_GATE_REQUIRE_CLEAN=1 时红；
#      CI 刻意不接——理由见脚本头与环境变量一节）；
#   ③ residue.json 的 head 与本绑定文件在结论处**对拍**（同一门禁内部两个真源必须互校）。
# ---------------------------------------------------------------------------
HEAD_START="$(git rev-parse HEAD)"
BRANCH_START="$(git rev-parse --abbrev-ref HEAD)"
DIRTY_START="$(git status --porcelain | wc -l | tr -d ' ')"
BINDING="$ROOT/temp/wasm-client-only/HEAD-binding.txt"

EXPECT_HEAD_RAW="${WASM_GATE_EXPECT_HEAD:-}"
EXPECT_HEAD=""
if [ -n "$EXPECT_HEAD_RAW" ]; then
  case "$EXPECT_HEAD_RAW" in
    *[!0-9a-f]*)
      echo "verify-wasm-client-only: WASM_GATE_EXPECT_HEAD 形状非法（$EXPECT_HEAD_RAW）——" \
        "必须是 7–40 位小写十六进制 git sha（CI 传 github.sha）" >&2
      exit 2 ;;
  esac
  if [ "${#EXPECT_HEAD_RAW}" -lt 7 ] || [ "${#EXPECT_HEAD_RAW}" -gt 40 ]; then
    echo "verify-wasm-client-only: WASM_GATE_EXPECT_HEAD 长度非法（${#EXPECT_HEAD_RAW} 位）——" \
      "必须是 7–40 位小写十六进制 git sha（CI 传 github.sha）" >&2
    exit 2
  fi
  EXPECT_HEAD="$EXPECT_HEAD_RAW"
  case "$HEAD_START" in
    "$EXPECT_HEAD"*) : ;;
    *)
      echo "verify-wasm-client-only: 期望 HEAD $EXPECT_HEAD 与当前 HEAD $HEAD_START 不一致 ——" \
        "**结论不可比**（本门禁的结论只在它绑定的那个 HEAD 上成立），拒绝以别的 HEAD 出结论。" \
        "CI 请传 github.sha；本地确认无误后去掉 WASM_GATE_EXPECT_HEAD 重跑。" >&2
      exit 2 ;;
  esac
fi

{
  printf 'HEAD %s\n' "$HEAD_START"
  printf 'expect-head %s\n' "${EXPECT_HEAD:-<未锁定：本次结论只保证跑前==跑后自洽，不绑任何外部权威>}"
  printf 'branch %s\n' "$BRANCH_START"
  printf 'dirty-files %s\n' "$DIRTY_START"
  printf 'dirty-policy %s\n' "$([ "$REQUIRE_CLEAN" = "1" ] && echo 'require-clean（脏即失败）' || echo 'warn（脏只 WARN，写进结论行）')"
  printf 'groups %s\n' "$GROUPS_SELECTED"
  printf 'started %s\n' "$(date -Is)"
} >"$BINDING"

echo "WASM 客户端专属验收门禁（scripts/verify-wasm-client-only.sh）"
echo "HEAD $HEAD_START（$BRANCH_START；工作树 ${DIRTY_START} 个改动 —— 本仓并发编辑，结论按此 HEAD 归档）"
if [ -n "$EXPECT_HEAD" ]; then
  echo "期望 HEAD ${EXPECT_HEAD}（WASM_GATE_EXPECT_HEAD）：与当前 HEAD 一致 ✅"
else
  echo "期望 HEAD 未锁定：本次只保证跑前==跑后自洽（要绑权威请传 WASM_GATE_EXPECT_HEAD=<sha>，CI 传 github.sha）"
fi
if [ "${DIRTY_START:-0}" != "0" ]; then
  if [ "$REQUIRE_CLEAN" = "1" ]; then
    echo "WARN 工作树有 ${DIRTY_START} 个改动，而 --require-clean 已开启 ⇒ 结论会被判失败（见末尾）"
  else
    echo "WARN 工作树有 ${DIRTY_START} 个改动：结论对应的是「此 HEAD + 这些未提交改动」，不是干净 HEAD（CI 用 --require-clean 把它变成硬判据）"
  fi
fi
echo "组：$GROUPS_SELECTED（模式 $MODE；共 ${GROUP_COUNT} 组，可选 1–8）｜日志目录 $LOG_DIR"
echo "Go 环境：$GO_ENV_NOTE"

if [ "$MODE" = "portable" ]; then
  echo "portable 模式：只跑与构建产物 / PG / 显示器无关的组。**显式**不在本模式内（不是静默跳过）："
  echo "  · 组 3 服务端 go build/vet/定向测试 —— 需要真 PG；**CI 尚未接线**（server job 目前跑裸 go test，"
  echo "    没有 -json + check-go-test-json.mjs 这一步）⇒ 本地入口见脚本头『各组前置与接线现状』"
  echo "  · 组 4 客户端三包 check —— \`yarn check\` 的包任务已覆盖同一批命令"
  echo "  · 组 5 webadmin npm test —— 归 server job"
  echo "  · 组 6 协议探针 —— 需要 xvfb/显示器；**CI 尚未接线**（Gate job 已装 xvfb，缺一个 step）"
fi

# ---------------------------------------------------------------------------
if want 1; then
  group_begin 1
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
  group_settle
fi

# ---------------------------------------------------------------------------
if want 2; then
  group_begin 2
  step "2. 三方对拍 + 旧模型零残留（五桶 + 删除面/包清单/旧能力指纹；未跟踪文件也查）"
  log="$LOG_DIR/route-parity.log"
  if node scripts/wasm/check-route-parity.mjs >"$log" 2>&1; then
    # §5.2 与 §16.1 是**两条**独立的三方对拍：两条都打印，审计者一眼能看出各腿跑没跑
    # （旧实现只在成功路径打 §5.2，§16.1 的 ok() 行从不显示 —— 2026-09-23 W-2）。
    pass "三方对拍：OPEN_APP_PATH（§5.2）与渠道只读路由（§16.1）均三方一致（含前缀注册）"
    grep -E '^  PASS' "$log" | sed 's/^/      /' || true
  else
    fail "三方对拍失败（漂移即 404；命中文件与行号见 $log）"
    grep -E '^  (客户端常量|宿主路由|文档冻结串|§16.1|FAIL)' "$log" | sed 's/^/      /' || true
  fi

  # 零残留：脚本自己判定 + 退出码；五桶计数与命中逐条打印（--all 打印全部）。
  # 上限真源 = scripts/wasm/wasm-gate-inventory.json（环境变量只能收紧，非法取值 fail-loud）。
  log="$LOG_DIR/residue.log"
  if node scripts/wasm/check-old-model-residue.mjs --json "$LOG_DIR/residue.json" 2>&1 | tee "$log"; then
    pass "旧模型零残留：A 桶（业务代码）零命中，B/ANN/C/D 四桶在上限内（上限真源 = 仓内 inventory）"
  else
    fail "旧模型零残留：A 桶（业务代码）仍有命中（W4 删除波次未完成；五桶计数 A/B/ANN/C/D 见上，结构化报告 $LOG_DIR/residue.json）"
  fi

  # 删除面 / 包清单 / 旧能力指纹（W-1 的修法）：判据真源 = scripts/wasm/wasm-gate-inventory.json，
  # 逐条断言"删除面不存在 **且** 设计总纲 §8.4 里仍有该条 anchor"、"wasmapp 包清单双向一致"、
  # "旧能力结构指纹零未登记命中"。先 `node --check` 再跑：脚本解析失败时整段不执行，
  # 报出来的却只是"判据未通过"（2026-09-20 被这一点绕过一圈）。
  log="$LOG_DIR/deletion-surface.log"
  if ! node --check scripts/wasm/check-deletion-surface.mjs 2>"$log"; then
    sed 's/^/      /' "$log"
    fail "守卫脚本本身语法错误（scripts/wasm/check-deletion-surface.mjs 解析失败）"
  elif node scripts/wasm/check-deletion-surface.mjs >"$log" 2>&1; then
    pass "删除面 / 包清单 / 旧能力指纹（§8.4 真源驱动；清单+规则，不看路径在不在）"
    grep -E '^  PASS' "$log" | sed 's/^/      /' || true
  else
    fail "删除面判据未通过（日志 $log）"
    grep -E '^  FAIL' "$log" | head -n 12 | sed 's/^/      /' || true
  fi
  group_settle
fi

# ---------------------------------------------------------------------------
if want 3; then
  group_begin 3
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
    # 判定脚本的退出码契约（2026-09-23 W-4 补齐）：0 通过 / 1 报告不合格 / 2 前置缺失（报告不可读）。
    if (cd server && run_limited 1200 go test ./internal/wasmapp/... ./internal/router/... -count=1 -json) >"$log" 2>&1; then
      # 关键用例名单（**改上游/改名时同步这里**）：W1 把 `TestClientFrameUser_MatchesSessionProjection`
      # 改名为 `TestClientFrameUser_ProjectsUserRowAndPublisherFlag`（同一意图）。checker 会区分
      # "报告里不存在（多半被改名，给出候选）"与"存在但没通过"—— 见 2026-09-20 的 R1-L4-5。
      if node scripts/wasm/check-go-test-json.mjs "$log" \
          --require TestClientRequest_LoginRequiredWithoutIdentityIs401,TestCheckClientOrigin,TestClientFrameUser_ProjectsUserRowAndPublisherFlag; then
        pass "go test 定向包（真 PG；用例级 0 skip；三条关键用例确实 pass）"
      else
        fail "go test 报告不合格（用例级 skip / 关键用例缺失 / 有失败事件 / 报告路径没接上；报告 $log）"
      fi
    else
      fail "go test 失败（报告 $log）"
      grep -E '"Action":"fail"' "$log" | head -n 8 | sed 's/^/      /' || true
      tail -n 5 "$log" | sed 's/^/      /'
    fi
  else
    # **不静默跳过**：PG 不可达时本组是失败，不是通过。
    # 接线现状（2026-09-23 W-4）：CI 的 server job 目前跑的是**裸 `go test`**，没有
    # `-json` + 本判定这一步；本地入口 = `PG_DSN_TEST=… bash scripts/verify-wasm-client-only.sh --groups 3`
    # （宿主已有 Go 模块缓存时加 `WASM_GATE_GO_ENV=host`）。
    fail "PG 不可达（$PG_DSN_TEST）：定向测试无法执行 —— 本组不得当通过；本地入口见脚本头『接线现状』"
  fi
  group_settle
fi

# ---------------------------------------------------------------------------
if want 4; then
  group_begin 4
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
  group_settle
fi

# ---------------------------------------------------------------------------
if want 5; then
  group_begin 5
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
  group_settle
fi

# ---------------------------------------------------------------------------
if want 6; then
  group_begin 6
  step "6. 协议探针（探针自判定 + 退出码；不 grep 文本；xvfb-run -a 与探针同命令）"
  PROBES=()
  # 支持文件（协议库等，**不是**探针、不产出证据行）：逐条登记，未登记的支持文件会被
  # 当成探针 ⇒ 因"没有证据行"当场判红（这正是我们要的 fail-loud 方向）。
  PROBE_SUPPORT_FILES="probe-attest.cjs"
  while IFS= read -r probe; do
    # `if` 而不是 `[ … ] && …`：后者在 set -e 下，条件为假时整条列表非零 ⇒ 直接退出脚本。
    if [ -z "$probe" ]; then continue; fi
    case " $PROBE_SUPPORT_FILES " in
      *" $(basename "$probe") "*) continue ;;
    esac
    PROBES+=("$probe")
  done < <(find scripts/wasm/probes scripts/probes -maxdepth 1 -type f -name 'probe-*.cjs' 2>/dev/null | sort -u)

  # 组 6 的**强制自证**（R4-A N2）：证据协议自己先被证明能咬住"exit 0 桩"与
  # "跳过却打 PASS"两种形态。自证失败 ⇒ 本组直接红（拆掉/绕过自证都过不去）。
  PROBE_EVIDENCE_DISCOVERED="$LOG_DIR/probe-evidence-discovered.txt"
  PROBE_EVIDENCE_SETTLED="$LOG_DIR/probe-evidence-settled.txt"
  : >"$PROBE_EVIDENCE_DISCOVERED"
  : >"$PROBE_EVIDENCE_SETTLED"
  if probe_evidence_selftest "$LOG_DIR/probe-evidence-selftest.txt"; then
    evidence "probe-evidence-selftest:$(cat "$LOG_DIR/probe-evidence-selftest.txt")"
    pass "探针证据自证（$(cat "$LOG_DIR/probe-evidence-selftest.txt")）"
  else
    evidence "probe-evidence-selftest:FAILED"
    fail "探针证据自证失败：证据 validator / 组级不变量的自证样本没通过 ⇒ 本组的"探针都跑过了"不再可信（见 $LOG_DIR/probe-evidence-selftest.txt）"
  fi

  if [ "${#PROBES[@]}" -eq 0 ]; then
    fail "scripts/wasm/probes 下没有任何 probe-*.cjs —— 探针全丢等于本组没跑（拒绝空集通过）"
  elif [ ! -x "$ELECTRON_BIN" ] && [ ! -f "$ELECTRON_BIN" ]; then
    for probe in "${PROBES[@]}"; do printf '%s\n' "$(basename "$probe")" >>"$PROBE_EVIDENCE_DISCOVERED"; done
    fail "找不到 Electron（$ELECTRON_BIN）：先 corepack yarn install"
  elif ! command -v xvfb-run >/dev/null 2>&1; then
    if [ "$(uname -s)" = "Linux" ]; then
      fail "Linux 上缺少 xvfb-run（apt install xvfb）—— 无头环境下探针跑不起来，不得静默跳过"
    else
      # 早退分支（非 Linux）：**先把发现集合落盘**，再如实 skip。这样组级集合不变量
      # 依然要求"每个被发现的探针都有证据"——打印 PASS 也救不了它（R4-A N2 的形态①）。
      for probe in "${PROBES[@]}"; do printf '%s\n' "$(basename "$probe")" >>"$PROBE_EVIDENCE_DISCOVERED"; done
      # 这里是**早退分支**（探针循环之前就返回）：它正是 R4-A-15 的躲过路径 ——
      # 旧实现把"全组 SKIP = 失败"写在 else 分支里，本分支只 skip 一次，
      # 汇总遂打出 `PASS 0 ｜ FAIL 0 ｜ SKIP 1` + `全部通过 ✅` 且 EXIT=0。
      # 现在由收尾的 group_settle（组级不变量）负责判红，本分支保持"如实 skip"。
      skip "非 Linux（$(uname -s)）：本机不使用 xvfb-run；三平台探针属 §16 W6（§17 认账 1），请在 W6 用各平台原生方式跑"
    fi
  else
    # 组内计数：**全组 SKIP 必须红**（2026-09-23 W-5）。否则非 Linux 平台 / 前置不满足时
    # 只剩 `SKIP 4` 而汇总仍是"全部通过 ✅" —— 本组承载的是窗口/scheme/CSP/storage 这类
    # 只能靠真机运行证伪的判据，零 PASS 的 SKIP 集等于零断言（与"拒绝空集通过"同一口径）。
    probe_pass=0
    probe_skip=0
    probe_fail=0
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
      # 每个被发现的探针都必须**有据可查**（集合判定，不是数 PASS）。
      printf '%s\n' "$name" >>"$PROBE_EVIDENCE_DISCOVERED"
      verdict="$(probe_evidence_verdict "$name" "$rc" "$log")" || true
      case "$verdict" in
        accept)
          probe_pass=$((probe_pass + 1))
          printf 'probe-attested:%s\n' "$name" >>"$PROBE_EVIDENCE_SETTLED"
          evidence "probe-attested:$name"
          pass "$name（退出码 0 + 结构化证据行自洽：$(grep -m1 '^PROBE-ATTEST ' "$log" | cut -c1-160)）"
          grep -m1 'VERDICT' "$log" | sed 's/^/      /' || true ;;
        accept-skip)
          probe_skip=$((probe_skip + 1))
          printf 'probe-skipped:%s\n' "$name" >>"$PROBE_EVIDENCE_SETTLED"
          evidence "probe-skipped:$name"
          skip "$name 显式 SKIP（证据行 platformCovered=0；§17 认账 1 / W6 待补）" ;;
        *)
          probe_fail=$((probe_fail + 1))
          fail "$name（退出码 $rc ≠ 0；证据判定：${verdict#reject:}；日志 $log）"
          grep -m1 -E 'ASSERT|SKIP|fatal' "$log" | sed 's/^/      /' || true
          # W0-D 型探针的判定表（每条 required 的 PASS/FAIL/UNKNOWN + 汇总行）——
          # 没有它，失败只剩"退出码 1"，排障要翻整份日志。
          grep -E '^\[W0-D\] (FAIL|UNKNOWN) |^\[W0-D\] required=' "$log" | head -n 6 | sed 's/^/      /' || true
          grep -m1 '\[skip-note\]' "$log" | sed 's/^/      /' || true ;;
      esac
    done
  fi
  # **集合不变量**（R4-A N2 的修复本体）：被发现的探针集合 == 有证据的探针集合，
  # 且至少一条 probe-attested。它取代了旧的"PASS ≥ 1"计数判据 ——
  #   · "跳过却打 PASS"⇒ 没有 probe-attested 记录 ⇒ 红；
  #   · "exit 0 桩"⇒ validator 拒绝（无证据行/nonce 不符/计数不自洽）⇒ 红；
  #   · 部分探针没有证据 ⇒ 具名点名缺哪一条。
  # 它刻意放在 if/elif 链**之外**：早退（非 Linux）、缺 Electron、探针为空这些路径
  # 同样必须过这一关 —— 否则"打印一行 PASS 就绕过"的形态会从别的分支溜走。
  group6_verdict="$(group6_invariant "$PROBE_EVIDENCE_DISCOVERED" "$PROBE_EVIDENCE_SETTLED")" || true
  evidence "group6-invariant:${group6_verdict%%:*}"
  if [ "$group6_verdict" = "ok" ]; then
    pass "组 6 集合不变量：${#PROBES[@]} 个被发现的探针全部有据可查（attested ${probe_pass:-0} / skipped ${probe_skip:-0}）"
  else
    fail "组 6 集合不变量不成立：${group6_verdict#reject:}（日志 $LOG_DIR；探针清单 $PROBE_EVIDENCE_DISCOVERED）"
  fi
  # 组级不变量（R4-A-15）：覆盖上面**每一条**分支 —— 早退 skip、探针全 77、探针全失败、
  # 探针一条都没找到…… 只要本组没有任何 PASS，收尾就在这里判红并点名"组 6 零断言"。
  group_settle
fi

# ---------------------------------------------------------------------------
if want 7; then
  group_begin 7
  step "7. 渠道约束（§10：app_origin_scheme 必填 / 形状 / 跨渠道唯一；正式 tag dry-run；仓库 pin）"
  CHANNEL_ARGS=()
  CHANNELS_DRYRUN="skipped"
  if [ -n "${WASM_CHANNELS_REPO:-}" ]; then
    CHANNEL_ARGS+=(--channels-repo "$WASM_CHANNELS_REPO")
    CHANNELS_DRYRUN="ran"
  fi
  log="$LOG_DIR/channels.log"
  # 先语法检查再跑：这一段门禁的内容全在 `scripts/verify-wasm-channels.mjs` 里，
  # 而脚本解析失败时**整段代码根本不执行**，报出来的却只是"渠道约束未通过"——
  # 2026-09-20 实测被这一点绕了一圈（真正的病根是少了一个 `}`）。`node --check`
  # 只解析不执行，秒级成本换一个明确的失败原因。
  if ! node --check scripts/verify-wasm-channels.mjs 2>"$log"; then
    sed 's/^/  /' "$log"
    fail "守卫脚本本身语法错误（scripts/verify-wasm-channels.mjs 解析失败）"
  else
    channels_rc=0
    node scripts/verify-wasm-channels.mjs ${CHANNEL_ARGS[@]+"${CHANNEL_ARGS[@]}"} >"$log" 2>&1 || channels_rc=$?
    sed 's/^/  /' "$log"

    # W-6②：子脚本的跳过必须以**可解析形式**回报父脚本（`CHANNELS-SKIP-COUNT <n>` 一行 +
    # 每处跳过一行 `CHANNELS-SKIP <理由>`），父脚本据此计入 skip()。旧实现里子脚本只
    # `console.log('SKIP …')`，父脚本的 `SKIP 0` 与"有没有真的跳过"无关 —— 那是假计数。
    # 无论子脚本退出码如何都要记账（失败路径上也可能是"跳过 + 别处失败"）。
    skip_report_lines="$(grep -c '^CHANNELS-SKIP-COUNT ' "$log" || true)"
    child_skip_count="$(sed -n 's/^CHANNELS-SKIP-COUNT //p' "$log" | head -n1)"
    child_skip_reasons="$(sed -n 's/^CHANNELS-SKIP //p' "$log")"
    child_skip_reason_count=0
    if [ -n "$child_skip_reasons" ]; then
      child_skip_reason_count="$(printf '%s\n' "$child_skip_reasons" | wc -l | tr -d ' ')"
    fi
    skip_report_ok=1
    if [ "$skip_report_lines" != "1" ]; then
      fail "渠道约束的 SKIP 记账缺失（$log 里应有且仅有一行 CHANNELS-SKIP-COUNT，实得 $skip_report_lines 行）—— 子脚本的跳过没有回报父脚本，SKIP 计数不可信（W-6②）"
      skip_report_ok=0
    else
      case "$child_skip_count" in
        ''|*[!0-9]*)
          fail "渠道约束的 SKIP 计数不是非负整数（CHANNELS-SKIP-COUNT '$child_skip_count'）—— 报告协议坏了"
          skip_report_ok=0 ;;
        *)
          if [ "$child_skip_count" -ne "$child_skip_reason_count" ]; then
            fail "渠道约束的 SKIP 计数（$child_skip_count）与理由行数（$child_skip_reason_count）不符 —— 报告协议坏了"
            skip_report_ok=0
          elif [ "$child_skip_count" -gt 0 ]; then
            while IFS= read -r reason; do skip "渠道约束：$reason"; done <<<"$child_skip_reasons"
          fi ;;
      esac
    fi

    # W-6①：PASS 文案**按实际执行面动态生成** —— 真实渠道仓 dry-run 没跑就不得出现在 PASS 里。
    if [ "$channels_rc" -eq 0 ]; then
      if [ "$CHANNELS_DRYRUN" = "ran" ]; then
        pass "渠道约束：静态判据（冻结正则 / 仓库 pin / 合成夹具 tag→渠道集 / app_origin_scheme 五条负例 / 保留 scheme 契约）+ 真实渠道仓 dry-run 全部通过"
      else
        pass "渠道约束：静态判据（冻结正则 / 仓库 pin / 合成夹具 tag→渠道集 / app_origin_scheme 五条负例 / 保留 scheme 契约）通过"
        if [ "$skip_report_ok" = "1" ] && [ "$child_skip_count" = "0" ]; then
          # 子脚本说"0 处跳过"而父脚本没给 WASM_CHANNELS_REPO ⇒ 两边对跳过这件事的判断不一致
          fail "组 7 未提供 WASM_CHANNELS_REPO（真实渠道仓 dry-run 未执行），而子脚本回报 CHANNELS-SKIP-COUNT 0 —— 跳过没有被记账（W-6②）"
        fi
        # 显式可选步骤（W-6③）：下面这条不是 PASS 的必要条件，本次**确实**没跑，如实标注。
        note "真实渠道仓 dry-run 是**显式可选步骤**：本次未执行（要跑请设 WASM_CHANNELS_REPO=<渠道仓检出>，私有渠道仓不在公开仓内，也不联网）"
      fi
    else
      fail "渠道约束未通过（日志 $log）"
    fi
  fi
  group_settle
fi

# ---------------------------------------------------------------------------
if want 8; then
  # TST-15：W5 的判据此前只是"文本存在性、无命令"，且只在 gitignore 的 temp 脚本里
  # （`temp/wasm-client-only/l5-acceptance.sh`）—— CI 与 `yarn check` 都碰不到。本组把
  # 它们变成**可复跑的命令**，每条失败都指回总纲条号，让人知道"为什么这条不能松"。
  #
  # 2026-09-23 三轮审计 W-7/W-9 把五条纯 grep 换成模式判据实现
  # （`scripts/wasm/check-authoring-claims.mjs`）：
  #   · ④/⑤/① 是**模式**（照台账 R2-L5-2 的写法），豁免**按分句**（`，。；！？` 切分）而不是整行；
  #   · ②/③ 钉**结论**（Cache Storage 的可用性取值 / window.ratio 的区间 + 发布期错误码）；
  #   · 扫描面**目录驱动 + 通配**，根存在性/根下非空/读取失败三条 fail-loud
  #     （等价于残留扫描器那条"rc≥2 不得当通过"的纪律）；
  #   · 台账里那批"已闭合"的合成负例在同一次运行里当回归网实跑（正则被削弱即红）。
  # 子脚本用 `G8-PASS/G8-FAIL/G8-NOTE` 前缀回报，父脚本镜像进自己的组级计数
  # —— 避免"子脚本说通过、父脚本说另一套"。
  group_begin 8
  step "8. W5 文档与作者面判据（模式判据 + 按分句豁免 + 合成负例回归；便携）"
  log="$LOG_DIR/authoring-claims.log"
  if ! node --check scripts/wasm/check-authoring-claims.mjs 2>"$log"; then
    sed 's/^/      /' "$log"
    fail "守卫脚本本身语法错误（scripts/wasm/check-authoring-claims.mjs 解析失败）"
  else
    g8_rc=0
    node scripts/wasm/check-authoring-claims.mjs >"$log" 2>&1 || g8_rc=$?
    g8_fail_seen=0
    g8_pass_seen=0
    while IFS= read -r line; do
      case "$line" in
        'G8-PASS '*) pass "${line#G8-PASS }"; g8_pass_seen=$((g8_pass_seen + 1)) ;;
        'G8-FAIL '*) fail "${line#G8-FAIL }"; g8_fail_seen=$((g8_fail_seen + 1)) ;;
        'G8-NOTE '*) note "${line#G8-NOTE }" ;;
        *) note "$line" ;;
      esac
    done <"$log"
    # 报告协议自检：子脚本的退出码与它回报的 PASS/FAIL 行必须一致，否则"通过"这句话本身不可信。
    if [ "$g8_rc" -eq 2 ]; then
      fail "作者面判据**前置缺失**（退出码 2：扫描根不存在/读不出/扫描面为空 —— 判据无处可查不等于通过；日志 $log）"
    elif [ "$g8_rc" -ne 0 ] && [ "$g8_fail_seen" -eq 0 ]; then
      fail "作者面判据以退出码 $g8_rc 失败，却没有任何 G8-FAIL 行 —— 报告协议坏了（日志 $log）"
    elif [ "$g8_rc" -eq 0 ] && [ "$g8_fail_seen" -gt 0 ]; then
      fail "作者面判据回报了 $g8_fail_seen 条失败却以 0 退出 —— 报告协议不可信（日志 $log）"
    elif [ "$g8_pass_seen" -eq 0 ] && [ "$g8_fail_seen" -eq 0 ]; then
      fail "作者面判据一条 PASS/FAIL 都没回报（空集通过）—— 日志 $log"
    fi
  fi
  group_settle
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
  note "HEAD 未变（$HEAD_START）"
fi

# W-8③：同一门禁内部两个真源必须互校 —— 零残留扫描写的 residue.json 里有 head，
# 本绑定文件里也有 head；旧实现两处各记一份、没人对拍（"两端各自钉自己的字面量"的形态）。
if want 2; then
  residue_json="$LOG_DIR/residue.json"
  if [ ! -f "$residue_json" ]; then
    fail "残留扫描的结构化报告不存在（$residue_json）：本次选了组 2，却没有可与绑定文件对拍的 head"
  else
    residue_head=""
    if ! residue_head="$(node -e '
      const fs = require("node:fs")
      const report = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
      process.stdout.write(typeof report.head === "string" ? report.head : "")
    ' "$residue_json" 2>/dev/null)"; then
      residue_head=""
    fi
    if [ "$residue_head" != "$HEAD_START" ]; then
      fail "残留扫描报告的 head（${residue_head:-<不可读>}）与本绑定文件的 HEAD（$HEAD_START）不一致 —— 同一门禁的两个真源必须互校（陈旧报告/跑动中 HEAD 变化都会在这里暴露）"
    else
      note "residue.json 的 head 与绑定文件一致（$residue_head）"
    fi
  fi
else
  note "组 2 不在本次选择内：residue.json 的 head 不参与本次结论（**未选 ≠ 已对拍**）"
fi

# W-8②：脏树的显式判据（缺省 WARN 进结论行；--require-clean 时红）。旧实现只 note()，
# 于是"跑的是 HEAD + 一堆未提交改动"和"跑的是干净 HEAD"在结论里长得一模一样。
if [ "${DIRTY_START:-0}" != "0" ] || [ "${DIRTY_END:-0}" != "${DIRTY_START:-0}" ]; then
  if [ "$REQUIRE_CLEAN" = "1" ]; then
    fail "工作树不干净（跑前 ${DIRTY_START} → 跑后 ${DIRTY_END} 个改动），而 --require-clean / WASM_GATE_REQUIRE_CLEAN=1 要求干净树：本次结论不作为可归档的通过"
  else
    note "WARN 工作树不干净（跑前 ${DIRTY_START} → 跑后 ${DIRTY_END} 个改动）：本次结论对应「此 HEAD + 这些未提交改动」，不是干净 HEAD；要硬判据请加 --require-clean（CI 应加）"
  fi
else
  note "工作树干净（跑前跑后均 0 个改动）"
fi

if [ -n "$EXPECT_HEAD" ]; then
  note "期望 HEAD 已锁定并对上（WASM_GATE_EXPECT_HEAD=$EXPECT_HEAD）"
else
  note "WARN 期望 HEAD 未锁定：本次结论只保证「跑前 HEAD == 跑后 HEAD」自洽，不绑任何外部权威（CI 请传 WASM_GATE_EXPECT_HEAD=<github.sha>）"
fi

note "PASS ${PASS_COUNT} ｜ FAIL ${FAIL} ｜ SKIP ${SKIP_COUNT} ｜ 绑定文件 ${BINDING#"$ROOT/"}"

# 组级台账（R4-A-15 的可解析面）：逐组一行 `group <n> pass=… fail=… skip=…`，跳过逐条
# `group-skip <n> <理由>`（都在绑定文件里，与上面的 SKIP 计数同源复算）。
if grep -q '^group ' "$BINDING" 2>/dev/null; then
  note "组级台账（每组至少要有 1 条 PASS；零 PASS 的组在上面已被判红）："
  grep -E '^group ' "$BINDING" | sed 's/^/    /'
fi
if [ "$FAIL" -eq 0 ]; then
  echo "全部通过 ✅"
  exit 0
fi
echo "存在失败项 ❌（见上；日志在 ${LOG_DIR#"$ROOT/"}）"
exit 1
