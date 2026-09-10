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
# `<TOKEN>` = HMAC(R2_SECRET_ACCESS_KEY, RUN) 的前 16 位 —— 只有持有 R2 凭据的
# job 能算出这个前缀,因此**无法按 run id 猜出对象地址**(桶本身是公开读的:
# release.picoaide.com 的 R2 自定义域)。`<index>` 是 channels.list 里的行号:
# 中转路径不含渠道 id,渠道身份全程不出现在任何公开处。
#
# 用法:
#   R2_ACCOUNT_ID=… R2_BUCKET=… ci-channel-transfer.sh push  --list channels.list --stage client-assets
#   R2_ACCOUNT_ID=… R2_BUCKET=… ci-channel-transfer.sh pull  --list channels.list --to release-artifacts
#   R2_ACCOUNT_ID=… R2_BUCKET=… ci-channel-transfer.sh clean --list channels.list
#
# 退出码:0 成功;非 0 失败(缺 R2 凭据且存在品牌渠道时必须失败 —— 静默跳过会让
# 品牌渠道"零交付"且没有任何信号)。
set -euo pipefail

MODE="${1:-}"
shift || true

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

RUN="${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}"
# 前缀 token:HMAC(R2 密钥, RUN)。桶是公开读的,没有这个 token 就猜不到对象地址。
TOKEN="$(K="$R2_SECRET_ACCESS_KEY" M="$RUN" node -e '
const { createHmac } = require("node:crypto")
process.stdout.write(createHmac("sha256", process.env.K).update(process.env.M).digest("hex").slice(0, 16))
')"
printf '::add-mask::%s\n' "$TOKEN"
BASE="s3://${R2_BUCKET}/_transfer/${RUN}-${TOKEN}"
aws_cmd() { aws --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" "$@"; }

INDEX=0
for id in "${CHANNELS[@]}"; do
  INDEX=$((INDEX + 1))
  if is_public "$id"; then continue; fi
  printf '::add-mask::%s\n' "$id"
  case "$MODE" in
    push)
      [ -d "$STAGE/$id" ] || { echo "::error::渠道 ${INDEX}/${TOTAL} 没有可中转的产物目录" >&2; exit 1; }
      [ -n "$(ls -A "$STAGE/$id" 2>/dev/null)" ] || { echo "::error::渠道 ${INDEX}/${TOTAL} 的产物目录为空" >&2; exit 1; }
      # --only-show-errors:aws 默认会回显每个对象的 key(含品牌文件名)。
      aws_cmd s3 cp --recursive --only-show-errors "$STAGE/$id" "$BASE/ch-$INDEX" >/dev/null
      # 从公开 artifact 的暂存目录里删掉 —— 后面的 upload-artifact 就看不到品牌产物了。
      rm -rf "$STAGE/$id"
      ;;
    pull)
      mkdir -p "$TO/$id"
      aws_cmd s3 cp --recursive --only-show-errors "$BASE/ch-$INDEX/." "$TO/$id/" >/dev/null
      [ -n "$(ls -A "$TO/$id" 2>/dev/null)" ] || { echo "::error::渠道 ${INDEX}/${TOTAL} 的中转产物为空(上传失败?)" >&2; exit 1; }
      ;;
    clean)
      aws_cmd s3 rm --recursive --only-show-errors "$BASE/ch-$INDEX" >/dev/null 2>&1 || true
      ;;
  esac
done

echo "ci-channel-transfer: ${MODE} 完成(${PRIVATE_COUNT} 个品牌渠道经 R2 中转,渠道名与路径均未进入公开面)"
