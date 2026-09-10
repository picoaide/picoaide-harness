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

if [ -z "${R2_ACCOUNT_ID:-}" ] || [ -z "${R2_BUCKET:-}" ]; then
  echo "::warning::R2 secrets 未配置 —— 跳过更新服务器上传(不影响 GitHub Release)"
  exit 0
fi

if [ ! -f "$LIST" ]; then
  echo "::error::渠道列表不存在:${LIST}" >&2
  exit 2
fi

ENDPOINT="${R2_ENDPOINT:-https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com}"
PUBLIC_BASE="${PUBLIC_URL_BASE:-https://release.picoaide.com}"
aws() { command aws --endpoint-url "$ENDPOINT" "$@"; }

IMMUTABLE='public, max-age=31536000, immutable'
NO_CACHE='no-cache'
# 保留最近 N 个版本(用户定案);版本序必须用 sort -V:字面序里 2.10.0 < 2.9.0。
KEEP=3

TOTAL=0
while IFS= read -r channel; do
  [ -n "$channel" ] || continue
  # 本步骤自己再掩码一次:掩码"从发出那一刻起"生效,跨步骤不假设。
  printf '::add-mask::%s\n' "$channel"

  zip="$BUNDLE/$channel/picoaide-server-${VER}-amd64.zip"
  sums="$BUNDLE/$channel/SHA256SUMS"
  if [ ! -f "$zip" ] || [ ! -f "$sums" ]; then
    echo "::error::渠道构建产物缺失(zip 或 SHA256SUMS)—— 拒绝发布不完整的版本" >&2
    exit 1
  fi

  base="s3://${R2_BUCKET}/${channel}"

  # 1) 版本化资产:不可变 + 长缓存(同版本内容永不改)
  aws s3 cp "$zip" "$base/releases/${VER}/" \
    --content-type application/zip --cache-control "$IMMUTABLE" >/dev/null
  aws s3 cp "$sums" "$base/releases/${VER}/SHA256SUMS" \
    --content-type text/plain --cache-control "$IMMUTABLE" >/dev/null

  # 2) 清理到最近 KEEP 个版本
  aws s3 ls "$base/releases/" | awk '{print $2}' | sed 's#/##' | grep -E '^[0-9]' \
    | sort -rV | tail -n +$((KEEP + 1)) | while IFS= read -r old; do
        [ -n "$old" ] || continue
        # 中性日志:渠道名不打印(只报版本号)。
        echo "prune old release (version ${old})"
        aws s3 rm "$base/releases/$old/" --recursive >/dev/null
      done

  # 3) 版本指针**最后**写:先资产后指针,读者永远不会看到指向空目录的清单。
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
  aws s3 cp "$manifest" "$base/latest.json" \
    --content-type application/json --cache-control "$NO_CACHE" >/dev/null
  rm -f "$manifest"
  TOTAL=$((TOTAL + 1))
done < "$LIST"

echo "update server publish done (${TOTAL} channel(s))"
