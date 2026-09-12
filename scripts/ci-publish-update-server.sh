#!/usr/bin/env bash
#
# 把逐渠道的镜像包发布到更新服务器(R2)。
#
# 为什么是脚本而不是内联 YAML:`release.picoaide.com/<channel>/` 是**客户侧唯一**
# 的取包地址,这里的每一步出错都是静默的 —— 发到错目录、latest.json 少一个字段、
# 保留策略删多/删少、缓存头给错(新版本不生效)。这些只能在发版时才暴露,所以
# 逻辑必须能在本地用假的 `aws` 断言(见 scripts/verify-ci-scripts.mjs)。
#
# 布局(每个渠道一套,**互相独立**):
#   <channel>/releases/<version>/picoaide-server-<version>-amd64.zip   (immutable)
#   <channel>/releases/<version>/SHA256SUMS                            (immutable)
#   <channel>/latest.json                                              (no-cache)
#
# 用法:
#   R2_ACCOUNT_ID=... R2_BUCKET=... VERSION=v2.7.0 \
#     scripts/ci-publish-update-server.sh --list channels.list [--bundle release-bundle]
#
# 环境:
#   R2_ACCOUNT_ID / R2_BUCKET      缺任一项 → **跳过并告警**(不失败:GitHub
#                                  Release 本身仍应可用)
#   R2_ENDPOINT                    覆盖端点(本地测试用;缺省按 account id 拼)
#   VERSION                        版本(带不带 v 都接受)
#   PUBLIC_URL_BASE                清单里 image_asset 的基址(缺省 release.picoaide.com)
#
# 退出码:0 成功或按策略跳过;非 0 明确失败(缺文件/上传失败/清单写入失败)。
set -euo pipefail

# 公开日志里的品牌串脱敏:aws 失败信息会回显对象键。这里的 zip 名是中性的
# (picoaide-server-<ver>-amd64.zip),但渠道目录/清单字段仍带渠道身份,且
# 调用点的掩码一旦漏登记就是一次泄漏 —— 统一走共享库(scripts/ci-brand-mask.sh)。
# shellcheck source=scripts/ci-brand-mask.sh
. "$(dirname "$0")/ci-brand-mask.sh"

LIST="channels.list"
BUNDLE="release-bundle"
while [ $# -gt 0 ]; do
  case "$1" in
    --list) LIST="$2"; shift 2 ;;
    --bundle) BUNDLE="$2"; shift 2 ;;
    *) echo "ci-publish-update-server: 未知参数 $1" >&2; exit 2 ;;
  esac
done

VERSION="${VERSION:-}"
if [ -z "$VERSION" ]; then
  echo "::error::缺少 VERSION(发布到更新服务器必须知道版本)" >&2
  exit 2
fi
VER="${VERSION#v}"

if [ ! -f "$LIST" ]; then
  echo "::error::渠道列表不存在:${LIST}" >&2
  exit 2
fi

# 先看这次要发哪些渠道。品牌渠道**只能**从这里分发(R2 是它们唯一的分发面:
# 公开 artifact 与 GitHub Release 都不带它们),所以凭据缺失时不能静默跳过 ——
# 那等于"客户什么也拿不到,而流水线全绿"。官方/beta 缺凭据只告警(它们另有
# GitHub Release 兜底)。列表本身不回显渠道名。
BRAND_CHANNELS=0
while IFS= read -r channel; do
  [ -n "$channel" ] || continue
  case "$channel" in
    official|beta) ;;
    *) BRAND_CHANNELS=$((BRAND_CHANNELS + 1)) ;;
  esac
done < "$LIST"

if [ -z "${R2_ACCOUNT_ID:-}" ] || [ -z "${R2_BUCKET:-}" ]; then
  if [ "$BRAND_CHANNELS" -gt 0 ]; then
    echo "::error::本次发布含品牌渠道,但 R2 凭据未配置(R2_ACCOUNT_ID / R2_BUCKET)。" >&2
    echo "::error::品牌渠道的镜像只经更新服务器分发,跳过即客户零交付且无任何信号。" >&2
    echo "::error::请配置 R2 secrets,或不要把品牌渠道放进本次发布。" >&2
    exit 1
  fi
  echo "::warning::R2 secrets 未配置 —— 跳过更新服务器上传(不影响 GitHub Release)"
  exit 0
fi

ENDPOINT="${R2_ENDPOINT:-https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com}"
PUBLIC_BASE="${PUBLIC_URL_BASE:-https://release.picoaide.com}"
aws() { command aws --endpoint-url "$ENDPOINT" "$@"; }

IMMUTABLE='public, max-age=31536000, immutable'
NO_CACHE='no-cache'
# 保留最近 N 个版本(用户定案);版本序必须用 sort -V:字面序里 2.10.0 < 2.9.0。
# 留存**总数**是该口径(`$VER` + 次新的 KEEP-1 个,见下面 prune 段),不是"KEEP 个
# 之外再加本次版本"。
KEEP=3

TOTAL=0
INDEX=0
while IFS= read -r channel; do
  [ -n "$channel" ] || continue
  INDEX=$((INDEX + 1))
  # 本步骤自己再掩码一次:掩码"从发出那一刻起"生效,跨步骤不假设。
  # brand_register_channel 额外登记 slug/显示名/产品名与产物文件名(2026-09-11
  # 泄漏事故:只掩渠道 id 掩不到由 slug 派生的文件名)。
  brand_register_channel "$channel" "$BUNDLE/$channel"

  zip="$BUNDLE/$channel/picoaide-server-${VER}-amd64.zip"
  sums="$BUNDLE/$channel/SHA256SUMS"
  if [ ! -f "$zip" ] || [ ! -f "$sums" ]; then
    echo "::error::渠道构建产物缺失(zip 或 SHA256SUMS)—— 拒绝发布不完整的版本" >&2
    exit 1
  fi

  base="s3://${R2_BUCKET}/${channel}"

  # 1) 版本化资产:不可变 + 长缓存(同版本内容永不改)
  if ! brand_run_checked aws s3 cp "$zip" "$base/releases/${VER}/" \
    --content-type application/zip --cache-control "$IMMUTABLE"; then
    echo "::error::更新服务器发布失败(渠道 ${INDEX}:上传版本资产;上方输出已脱敏)" >&2
    exit 1
  fi
  if ! brand_run_checked aws s3 cp "$sums" "$base/releases/${VER}/SHA256SUMS" \
    --content-type text/plain --cache-control "$IMMUTABLE"; then
    echo "::error::更新服务器发布失败(渠道 ${INDEX}:上传校验和;上方输出已脱敏)" >&2
    exit 1
  fi

  # 2) 清理到最近 KEEP 个版本
  #
  # `$VER`(本次刚上传)**永不参与淘汰**(2026-09-12 审计 P1-2):它在上一行刚进
  # 这个远端目录,而旧实现只按排序位次截断,从不排除自己 —— 被删掉之后紧接着
  # 写出的 `latest.json` 就指向一个空目录(客户按 `server.version` 取包 404,
  # 而流水线全绿)。`sort -rV` 的语义让这件事在**正常发布序列**下就会发生:
  # GNU version sort 把预发布排在正式版**之前**(`2.7.2-beta.6` > `2.7.2`),
  # 正式版一出就被自己的预发布挤到第 KEEP+1 位。
  #
  # 保留口径不变(仍是最近 KEEP 个):淘汰集合 = 除 `$VER` 外按版本序排在
  # 第 KEEP 位及以后的版本 ⇒ 留存 = `$VER` + 次新的 (KEEP-1) 个。这样留存
  # **个数**与预发布/正式版的相对次序无关,`$VER` 也恒定在留存集合里。
  # 排除用 `grep -xF`(整行精确匹配):`2.7.2` 不能误伤 `2.7.20`/`2.7.2-beta.1`。
  #
  # `|| true` 是必需的:排除 `$VER` 之后"没有更老的版本"是**正常**结果,而
  # `grep -v` 无匹配时退出码为 1 —— 开头的 `set -o pipefail` 会把整条管道判成
  # 失败,让"某渠道的第一次发布"直接中止。`||` 只兜住管道本身的退出码,stdout
  # 仍是管道输出(`true` 不产生输出),所以版本列表照常拿到。
  versions="$(aws s3 ls "$base/releases/" | awk '{print $2}' | sed 's#/##' \
    | grep -E '^[0-9]' | grep -vxF "$VER" || true)"
  printf '%s\n' "$versions" | sort -rV | tail -n +"$KEEP" \
    | while IFS= read -r old; do
        [ -n "$old" ] || continue
        # 中性日志:渠道名不打印(只报版本号)。
        echo "prune old release (version ${old})"
        brand_run_best_effort aws s3 rm "$base/releases/$old/" --recursive
      done

  # 3) 写指针前先确认本轮资产**真的在远端**:指纹向空目录是最坏的一类静默
  # 故障(客户取包 404 而流水线全绿)。`aws s3 ls <对象键>` 对不存在的键
  # **退出码为 0 且无输出**(按前缀列举),所以断言的是"有输出",不是退出码。
  # 失败原因经 brand_sanitize 脱敏(对象键里带渠道 id)。
  asset_key="$base/releases/${VER}/picoaide-server-${VER}-amd64.zip"
  set +e
  asset_listing="$(aws s3 ls "$asset_key" 2>&1)"
  asset_status=$?
  set -e
  if [ "$asset_status" -ne 0 ] || [ -z "$asset_listing" ]; then
    [ -z "$asset_listing" ] || printf '%s\n' "$asset_listing" | brand_sanitize >&2
    echo "::error::本轮上传的镜像包在更新服务器上不存在(releases/${VER}/),拒绝写 latest.json(避免指针指向 404)" >&2
    exit 1
  fi

  # 4) 版本指针**最后**写:先资产后指针,读者永远不会看到指向空目录的清单。
  manifest="$(mktemp)"
  cat > "$manifest" <<JSON
{
  "schema": 1,
  "channel_id": "${channel}",
  "server": {
    "version": "${VER}",
    "image_tag": "v${VER}",
    "image_asset": "${PUBLIC_BASE}/${channel}/releases/${VER}/picoaide-server-${VER}-amd64.zip"
  },
  "client": { "version": "${VER}" },
  "published_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON
  if ! brand_run_checked aws s3 cp "$manifest" "$base/latest.json" \
    --content-type application/json --cache-control "$NO_CACHE"; then
    echo "::error::更新服务器发布失败(渠道 ${INDEX}:写版本指针;上方输出已脱敏)" >&2
    rm -f "$manifest"
    exit 1
  fi
  rm -f "$manifest"
  TOTAL=$((TOTAL + 1))
done < "$LIST"

echo "update server publish done (${TOTAL} channel(s))"
