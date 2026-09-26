#!/usr/bin/env bash
#
# 品牌渠道客户端产物的**私密中转**:让品牌安装包绕开公开的 GitHub artifact。
#
# 为什么需要:GitHub Actions 的 artifact 对**任何登录账号**可下载(公开仓尤其),
# 而渠道构建的产物目录与文件名都带客户品牌(`<channel>/Acme-AI-…-Setup.exe`),
# 安装包内部还带着客户品牌与 `defaults.server_url`。项目定策是"品牌渠道绝不
# 公开"(见 .github/workflows/ci.yml 的 artifact 中性命名注释),而把产物放进
# artifact 等于把这条定策作废 —— `::add-mask::` 只作用于**日志**,管不了产物。
#
# 做法:官方/beta 仍走 artifact(GitHub Release 上本来就公开,无所谓);
# **品牌渠道**在三平台 job 里上传到 R2 的临时前缀,由 release job 取回后立即删除:
#
#   s3://$R2_BUCKET/_transfer/<RUN>-<TOKEN>/ch-<index>/…
#
# `<RUN>` = **只有 `GITHUB_RUN_ID`**(不含 `GITHUB_RUN_ATTEMPT`:同一个 run 的所有
# attempt 必须共用前缀,理由见下面 `RUN` 那一段)。`<TOKEN>` =
# HMAC(R2_SECRET_ACCESS_KEY, RUN) 的前 16 位 —— 只有持有 R2 凭据的 job 能算出这个
# 前缀,因此**无法按 run id 猜出对象地址**(桶本身是公开读的:
# release.picoaide.com 的 R2 自定义域)。`<index>` 是 channels.list 里的行号:
# 中转路径不含渠道 id,渠道身份全程不出现在任何公开处。
#
# 用法(两组凭据都要给:aws CLI 认 AWS_*,R2_* 用于端点/桶名与 HMAC 种子):
#   R2_ACCOUNT_ID=… R2_BUCKET=… R2_SECRET_ACCESS_KEY=… \
#   AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… AWS_DEFAULT_REGION=auto \
#     ci-channel-transfer.sh push  --list channels.list --stage client-assets
#   … pull  --list channels.list --to release-artifacts
#   … clean --list channels.list
#
# 退出码:0 成功;非 0 失败(缺凭据且存在品牌渠道时必须失败 —— 静默跳过会让
# 品牌渠道"零交付"且没有任何信号)。
set -euo pipefail

# 公开日志里的品牌串脱敏:aws 的失败信息会回显对象键,而文件名带客户 slug
# (2026-09-11 v2.7.0 实测泄漏)。共享实现见 scripts/ci-brand-mask.sh ——
# 中转与发布两个脚本都用它,避免各写一份。
# shellcheck source=scripts/ci-brand-mask.sh
. "$(dirname "$0")/ci-brand-mask.sh"

MODE="${1:-}"
shift || true

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIST="channels.list"
STAGE="client-assets"
TO="release-artifacts"

while [ $# -gt 0 ]; do
  case "$1" in
    --list) LIST="$2"; shift 2 ;;
    --stage|--from) STAGE="$2"; shift 2 ;;
    --to) TO="$2"; shift 2 ;;
    *) echo "ci-channel-transfer: 未知参数 $1" >&2; exit 2 ;;
  esac
done

case "$MODE" in
  push|pull|clean) ;;
  *) echo "ci-channel-transfer: 用法: $0 <push|pull|clean> [--list …] [--stage …] [--to …]" >&2; exit 2 ;;
esac

[ -f "$LIST" ] || { echo "::error::渠道列表不存在:${LIST}" >&2; exit 2; }

# 读列表(去空行),保留顺序 —— index 就是行号,三个 job 用同一份 tag 的列表,天然一致。
CHANNELS=()
while IFS= read -r line; do
  [ -n "$line" ] || continue
  CHANNELS+=("$line")
done < "$LIST"
TOTAL="${#CHANNELS[@]}"
[ "$TOTAL" -gt 0 ] || { echo "::error::渠道列表为空:${LIST}" >&2; exit 2; }

# 公开渠道:它们的品牌本来就是公开信息(GitHub Release / 官方站),不必中转。
is_public() { [ "$1" = "official" ] || [ "$1" = "beta" ]; }

# 本次要中转的渠道数(为 0 时不需要 R2 凭据)。
PRIVATE_COUNT=0
for id in "${CHANNELS[@]}"; do
  is_public "$id" || PRIVATE_COUNT=$((PRIVATE_COUNT + 1))
done

if [ "$PRIVATE_COUNT" -eq 0 ]; then
  echo "ci-channel-transfer: 本次渠道集里没有品牌渠道,无需中转"
  exit 0
fi

# R2 凭据:存在品牌渠道时是硬要求 —— 缺失即失败(而不是悄悄跳过)。
if [ -z "${R2_ACCOUNT_ID:-}" ] || [ -z "${R2_BUCKET:-}" ] || [ -z "${R2_SECRET_ACCESS_KEY:-}" ]; then
  echo "::error::存在品牌渠道,但 R2 凭据不完整(R2_ACCOUNT_ID / R2_BUCKET / R2_SECRET_ACCESS_KEY)。" >&2
  echo "::error::品牌渠道的客户端产物**不经过公开 artifact**,必须经 R2 私密中转;" >&2
  echo "::error::请配置 R2 secrets,或不要在本次发布里包含品牌渠道。" >&2
  exit 1
fi

# aws CLI 的凭据是**另一组**环境变量:上面那三个 R2_* 只喂端点、桶名与中转前缀的
# HMAC 种子,aws 自己不认它们。
# 2026-09-11 v2.7.0 首次正式 tag 实测:调用点只传了 R2_* → 三个平台 job 全部在
# 这一步以 aws 的 "Unable to locate credentials" 失败(报错还指不到病根),
# 品牌渠道零交付、release job 因 needs 失败被跳过。这里提前 fail-loud,
# 让"缺凭据"自己说明缺什么。
if [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
  echo "::error::存在品牌渠道,但 aws 凭据不完整(AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)。" >&2
  echo "::error::调用点须传 AWS_ACCESS_KEY_ID=secrets.R2_ACCESS_KEY_ID 与" >&2
  echo "::error::AWS_SECRET_ACCESS_KEY=secrets.R2_SECRET_ACCESS_KEY(AWS_DEFAULT_REGION=auto);" >&2
  echo "::error::R2_* 那组只用于端点/桶名/HMAC 种子,aws CLI 不认。" >&2
  exit 1
fi

# 工具依赖:aws CLI 与 node 都必须有(后者用于派生不可猜的中转前缀 token)。
# 缺了就明说 —— 这条链失败意味着品牌渠道零交付,不能含糊。
if ! command -v aws >/dev/null 2>&1; then
  echo "::error::缺少 aws CLI —— 品牌渠道产物经 R2 中转需要它(ubuntu/macos 镜像自带;Windows 用 choco install awscli)" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "::error::缺少 node —— 中转前缀 token 由 HMAC 派生,需要 node" >&2
  exit 1
fi

# 中转前缀的 run 段:**只有 GITHUB_RUN_ID,不含 GITHUB_RUN_ATTEMPT**(2026-09-26 审计
# Z3-1 修复)。旧实现是 `${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}`,两个后果都是静默的:
#   ① **孤儿**:失败/重跑的 attempt 推到 `<run>-<attempt>-<token>/` 的客户安装包**永久**
#      留在公开读的桶里 —— 销毁步(ci.yml 的 Destroy the R2 transfer prefix)只按
#      **当前** attempt 计算前缀,没有任何代码路径、也没有桶生命周期规则会去删旧
#      attempt 的前缀(文档承诺的"取回后立即销毁"对这一类不成立);
#   ② **半套交付**:`gh run rerun --failed` **不重跑已成功的 job**(本仓的标准处置:
#      2026-09-17 docs-only CI 与 2026-09-23 全量审计都写着靠它过关)⇒ attempt 2 的
#      前缀里只有**失败那个平台**的产物,已成功平台的在 attempt 1 的前缀里,
#      而 `pull` 的判据只是"目录非空" ⇒ 三平台缺两个也全绿出厂。
# 同一个 run 的所有 attempt 共用前缀后,rerun 补推的产物与首次 attempt 的产物落在
# 一起;`pull` 侧再逐平台判"齐全"(见下面 PLATFORM_TABLE),两条路一起收口。
# 旧格式(`<run>-<attempt>-<token>`)的**历史残留**由 `clean` 的前缀清扫负责(见下)。
RUN="${GITHUB_RUN_ID:-local}"
# 前缀 token:HMAC(R2 密钥, RUN)。桶是公开读的,没有这个 token 就猜不到对象地址。
TOKEN="$(K="$R2_SECRET_ACCESS_KEY" M="$RUN" node -e '
const { createHmac } = require("node:crypto")
process.stdout.write(createHmac("sha256", process.env.K).update(process.env.M).digest("hex").slice(0, 16))
')"
printf '::add-mask::%s\n' "$TOKEN"
BASE="s3://${R2_BUCKET}/_transfer/${RUN}-${TOKEN}"
aws_cmd() { aws --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" "$@"; }

# 客户端三平台交付面(清单键 / 产物通配 / 人读标签)的**唯一来源**:
# `packages/host/desktop/scripts/channel-build.ts` 的 `CLIENT_PLATFORM_ASSETS`。
# 不在 shell 里再抄一份 —— 两处各写一遍就是两个口径,一边少一个平台就会静默少发
# (`pull` 侧正是靠它判"三平台齐全")。清单键与运行期读清单的
# `src/desktop-release.ts` 同源,通配与 ci.yml 三个平台 job 的 `--patterns` 同形。
platform_table() {
  node -e '
    import(process.argv[1]).then((mod) => {
      const assets = mod.CLIENT_PLATFORM_ASSETS
      if (!Array.isArray(assets) || assets.length === 0) throw new Error("CLIENT_PLATFORM_ASSETS 为空")
      for (const asset of assets) process.stdout.write(`${asset.key}\t${asset.glob}\t${asset.label}\n`)
    }).catch((error) => {
      console.error(`platform_table: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    })
  ' "$REPO_ROOT/packages/host/desktop/scripts/channel-build.ts"
}
if ! PLATFORM_TABLE="$(platform_table)" || [ -z "$PLATFORM_TABLE" ]; then
  echo "::error::读不到客户端平台清单(packages/host/desktop/scripts/channel-build.ts 的 CLIENT_PLATFORM_ASSETS)" >&2
  echo "::error::中转的「三平台齐全」判据靠它派生,读不到就不能假装产物齐全" >&2
  exit 1
fi

aws_checked() {  # 输出先捕获、经脱敏后再打印(公开日志里不得出现品牌)
  if ! brand_run_checked aws_cmd "$@"; then
    echo "::error::R2 中转 ${MODE} 失败(渠道 ${INDEX}/${TOTAL})" >&2
    exit 1
  fi
}

# 捕获一条外部命令的输出(**脱敏后**返回给调用方),失败也不抛。
#
# ci-brand-mask.sh 只有两个包装:成功静默/失败脱敏打印(`brand_run_checked`)与
# 忽略失败的版本(`brand_run_best_effort`)—— 都不给调用方输出。前缀枚举需要先
# **读**列表再过滤,所以就地实现这一条,纪律与共享库一致:先捕获、脱敏、再用,
# 绝不把外部命令的输出直接透传(aws 的报文会回显对象键)。
brand_run_capture() {
  local output status
  set +e
  output="$("$@" 2>&1)"
  status=$?
  set -e
  printf '%s' "$output" | brand_sanitize
  return "$status"
}

INDEX=0
for id in "${CHANNELS[@]}"; do
  INDEX=$((INDEX + 1))
  if is_public "$id"; then continue; fi
  brand_register_channel "$id" "$STAGE"
  case "$MODE" in
    push)
      [ -d "$STAGE/$id" ] || { echo "::error::渠道 ${INDEX}/${TOTAL} 没有可中转的产物目录" >&2; exit 1; }
      [ -n "$(ls -A "$STAGE/$id" 2>/dev/null)" ] || { echo "::error::渠道 ${INDEX}/${TOTAL} 的产物目录为空" >&2; exit 1; }
      # --only-show-errors:aws 默认会回显每个对象的 key(含品牌文件名)。
      # 路径形态一律用**规范写法**:本地目录源不带 `/.`,S3 侧统一尾斜杠前缀。
      # 反例是 `s3://bucket/prefix/.` —— 真实 aws CLI 把它当字面前缀列出、匹配不到
      # 任何对象(桩会"好心"修正,于是本地全绿、正式发布才炸),回归门禁因此连
      # 命令形态一起断言(见 verify-ci-scripts.mjs)。
      aws_checked s3 cp --recursive --only-show-errors "$STAGE/$id" "$BASE/ch-$INDEX/" 
      # 从公开 artifact 的暂存目录里删掉 —— 后面的 upload-artifact 就看不到品牌产物了。
      rm -rf "$STAGE/$id"
      ;;
    pull)
      mkdir -p "$TO/$id"
      aws_checked s3 cp --recursive --only-show-errors "$BASE/ch-$INDEX/" "$TO/$id/" 
      [ -n "$(ls -A "$TO/$id" 2>/dev/null)" ] || { echo "::error::渠道 ${INDEX}/${TOTAL} 的中转产物为空(上传失败?)" >&2; exit 1; }
      # 逐平台判"齐全"(2026-09-26 审计 Z3-1 的第 2 条):只判"目录非空"会让
      # "少一个平台"以全绿出厂 —— CLIENT-RELEASE.json 少一个 assets 键、
      # /api/client/v2/updates/manifest 少一个平台、门户少一个下载入口、
      # /updates/client/<安装包名> 404,而流水线全绿。平台清单与镜像装配同源
      # (见上面的 PLATFORM_TABLE),缺任一即 fail-loud 并点名平台。
      # 报错只报平台标签与序号,不回显渠道 id / 文件名(公开日志纪律)。
      missing_platforms=""
      while IFS=$'\t' read -r key glob label; do
        [ -n "$key" ] || continue
        found=0
        for candidate in "$TO/$id"/$glob; do
          [ -f "$candidate" ] && found=1 && break
        done
        [ "$found" -eq 1 ] || missing_platforms="${missing_platforms}${missing_platforms:+, }${label}"
      done <<< "$PLATFORM_TABLE"
      if [ -n "$missing_platforms" ]; then
        echo "::error::渠道 ${INDEX}/${TOTAL} 的中转产物缺少平台:${missing_platforms}" >&2
        echo "::error::客户端交付面是三平台各一份安装包;少平台的包装到客户机上就是「没有对应平台的安装包」," >&2
        echo "::error::而镜像清单/门户/更新清单只会静默少一个入口。请核对该渠道三平台 job 是否都产出了产物。" >&2
        exit 1
      fi
      ;;
    clean)
      # clean 是尽力而为:失败不阻断发布,但输出同样脱敏。
      brand_run_best_effort aws_cmd s3 rm --recursive --only-show-errors "$BASE/ch-$INDEX/"
      ;;
  esac
done

# 旧格式前缀的清扫(2026-09-26 审计 Z3-1 的第 3 条)。
#
# 2026-09-26 之前本脚本把 `GITHUB_RUN_ATTEMPT` 编进中转前缀(`<run>-<attempt>-<token>`),
# 而销毁步只按**当前** attempt 计算 BASE ⇒ 早先 attempt 推上去的客户安装包没有任何人删。
# 那些对象在本 run 内仍然可枚举,这里按前缀列出、一并删掉:
#   · 只匹配 `_transfer/<run id>-` 开头的**一级前缀**(`-` 保证 run id 不会前缀匹配到别的
#     run:run `424` 不会命中 `4242-…`);
#   · 前缀里只有 run id 与 HMAC token,不含渠道身份 —— 即便如此,输出仍走脱敏包装;
#   · **没有 GITHUB_RUN_ID 时整段跳过**并打印一行(见函数体:那时 RUN 是占位值 `local`,
#     按它枚举会删掉别的本地调用留下的 `local-*` 前缀);clean 的其余部分不受影响;
#   · 仍然是尽力而为:clean 的失败不阻断发布(它的语义是"取回后销毁",不是发布判据)。
#
# 说明(历史残留,要认账):**本次改动之前**那些已经结束的 run 留下的 attempt 前缀,
# 没有任何代码路径会再枚举到它们(脚本只清理**本 run** 的前缀)。它们不可猜测、但桶是
# 公开读的,处置只能靠运维从桶侧按 `_transfer/<run id>-<attempt>-` 形态人工清理
# (R2 控制台按前缀列 + 删;或在部署机跑一次
#  `aws s3 ls s3://$R2_BUCKET/_transfer/` 找带第二段数字的旧前缀)。
legacy_prefix_sweep() {
  [ "$MODE" = clean ] || return 0
  # **缺 GITHUB_RUN_ID 就跳过**(2026-09-27 第二十七轮 FIX-37)。
  #
  # `RUN` 的回退值 `local` **不是一个 run**:它是"没有 run id 时也能算出稳定前缀"的占位,
  # 让 push 与 pull 在本机自洽(两条都用同一个 RUN 派生 BASE,所以 `local-<token>` 只会是
  # 同一份配置自己建的前缀)。但**清扫是按前缀枚举后删除**,唯一的锚就是 RUN —— 用 `local`
  # 当锚等于把**所有** `local-*` 前缀(别的本地调用留下的)一起删掉,而它们没有任何证据
  # 属于本次运行(2026-09-27 假 aws 真跑:预置 `local-1-old`/`local-2-old` 时被一并删除)。
  #
  # 处置取"显式跳过"而不是 fail-loud:clean 是**尽力而为的收尾步**(见上面 clean 分支与
  # 本函数的注释),它的失败不该因为缺一个 CI 变量让整条发布链变红;但它**必须说出来** ——
  # 静默跳过就等于"以为清干净了"。口径与本仓其它显式 SKIP 一致。
  #
  # 只改这一处:push/pull **不受影响**(它们的目标是 BASE 本身,`local` 回退在它们那里
  # 是有意义的稳定前缀;把这里的修法套过去会平白让本机 push/pull 失效)。
  if [ -z "${GITHUB_RUN_ID:-}" ]; then
    echo "ci-channel-transfer: skipped: no GITHUB_RUN_ID —— 旧格式(<run>-<attempt>-<token>)中转前缀的清扫以 run id 为锚,"
    echo "ci-channel-transfer:   缺它只能退化成删掉所有 local-* 前缀(没有证据属于本次运行)⇒ 本次不清扫;要清请从桶侧人工删。"
    return 0
  fi
  local listing prefix
  # `aws s3 ls <前缀>/` 的输出形如 `                           PRE <name>/`;
  # 输出先捕获(经脱敏)再过滤 —— 与其余外部命令同一纪律。
  listing="$(brand_run_capture aws_cmd s3 ls "s3://${R2_BUCKET}/_transfer/" || true)"
  [ -n "$listing" ] || return 0
  while IFS= read -r prefix; do
    [ -n "$prefix" ] || continue
    [ "${prefix#"${RUN}-"}" != "$prefix" ] || continue   # 不是本 run 的前缀
    [ "$prefix" != "${RUN}-${TOKEN}" ] || continue       # 当前前缀已在循环里删过
    brand_run_best_effort aws_cmd s3 rm --recursive --only-show-errors "s3://${R2_BUCKET}/_transfer/${prefix}/"
  done < <(printf '%s\n' "$listing" | awk '$1 == "PRE" { sub(/\/$/, "", $2); print $2 }')
}
legacy_prefix_sweep

echo "ci-channel-transfer: ${MODE} 完成(${PRIVATE_COUNT} 个品牌渠道经 R2 中转,渠道名与路径均未进入公开面)"
