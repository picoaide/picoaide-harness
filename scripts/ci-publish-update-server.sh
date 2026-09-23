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
# **上传后必须证明远端字节完整**(2026-09-23 审计 K-01):单请求 PUT + 存储侧
# `ChecksumSHA256`,然后 head-object 把 ContentLength 与 ChecksumSHA256 和本地
# `stat`/`sha256` 逐字对拍,任一条不符即 fail-loud(不写 latest.json)。
# 判据与"为什么不能用 s3 cp 的多段校验和"写在 verify_remote_object 的注释里。
#
# **校验覆盖面 = 三个对象都校**(2026-09-23 第六轮审计 R6-C-3):`<ver>/…zip`、
# `<ver>/SHA256SUMS`、`latest.json`(指针)—— 后两个此前分别只在"上传后"与
# "写指针前"被覆盖了一半,删掉任一处校验都没有任何回归会红。
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
# 退出码:0 成功或按策略跳过;非 0 明确失败(缺文件/上传失败/**完整性校验不过**/
#         清单写入失败)。
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

# base64(sha256(file)) —— S3/R2 的 `ChecksumSHA256` 是**摘要原始字节**的 base64,
# 不是 hex。优先 openssl(release job 与开发机都有;本仓 CI 不依赖 jq),没有则回落
# node(brand_sanitize 已经依赖它)。两个都没有时命令直接失败 ⇒ fail-loud。
sha256_b64() {
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 -binary "$1" | base64 | tr -d '\n'
  else
    node -e 'const c=require("node:crypto"),f=require("node:fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("base64"))' "$1"
  fi
}

# 上传后**完整性**校验(2026-09-23 审计 K-01)。判据两条,全过才放行:
#   1. 大小:`head-object` 的 ContentLength 必须等于本地 `stat -c%s`;
#   2. 哈希:`head-object` 的 ChecksumSHA256 必须等于 base64(本地 sha256)。
#
# 为什么必须做:旧实现唯一的检查是"对象存在"(`aws s3 ls` 有输出即可),于是
# **失败是静默的** —— 2026-09-22 现场实测过对象在 382,992,384B 处截断(宣告 522MB)
# 而全链路绿灯;审计探针里"只写入前 10 字节"的假 aws 也能让脚本 EXIT=0 并写出指向
# 损坏对象的 latest.json。`aws s3 cp` 的退出码只表示"请求成功",不表示"远端字节完整"。
#
# 为什么上传用 `s3api put-object`(而不是 `s3 cp --checksum-algorithm SHA256`):
# 500MB 的包在 `s3 cp` 下走**多段上传**,多段对象的校验和是"分片校验和的校验和"
# (带 `-<段数>` 后缀),与本地 sha256 不可直接对拍 —— 拿它当判据会在**每次正常发布**
# 上误报。单请求 PUT(带 `--checksum-sha256`)让存储端在写入时就校验整对象字节,
# 且 head-object 读回的就是本地那份 sha256,判据精确。R2 单次 PUT 上限 5 GiB,
# 镜像包 ~500MB,余量充足。
#
# 拿不到 ChecksumSHA256(存储端没留存 / CLI 太老)同样 fail-loud:**不**退化成
# "只校大小" —— 发布面宁可不发,也不能让"无法证明完整"的对象被 latest.json 引用。
verify_remote_object() { # $1=对象键 $2=本地文件 $3=中性标签(不含渠道名)
  local key="$1" file="$2" label="$3"
  local local_size local_b64 remote_size remote_sha status

  local_size="$(stat -c%s "$file")"
  local_b64="$(sha256_b64 "$file")"

  # head-object 的失败信息可能回显对象键(含渠道 id),先脱敏再打印。
  set +e
  remote_size="$(aws s3api head-object --bucket "$R2_BUCKET" --key "$key" \
    --query ContentLength --output text 2>&1)"
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    printf '%s\n' "$remote_size" | brand_sanitize >&2
    echo "::error::更新服务器校验失败(${label}:读不回远端对象元数据,无法证明上传完整;上方输出已脱敏)" >&2
    exit 1
  fi

  set +e
  remote_sha="$(aws s3api head-object --bucket "$R2_BUCKET" --key "$key" \
    --checksum-mode ENABLED --query ChecksumSHA256 --output text 2>&1)"
  status=$?
  if [ "$status" -ne 0 ]; then
    # 老版 aws CLI 不认 `--checksum-mode`:退回不带它再问一次(仍**要求**返回
    # ChecksumSHA256,拿不到就在下面 fail-loud)。
    remote_sha="$(aws s3api head-object --bucket "$R2_BUCKET" --key "$key" \
      --query ChecksumSHA256 --output text 2>&1)"
    status=$?
  fi
  set -e
  if [ "$status" -ne 0 ]; then
    printf '%s\n' "$remote_sha" | brand_sanitize >&2
    echo "::error::更新服务器校验失败(${label}:读不回远端对象校验和;上方输出已脱敏)" >&2
    exit 1
  fi

  if [ "$remote_size" != "$local_size" ]; then
    echo "::error::更新服务器校验失败(${label}:远端对象 ${remote_size:-?} 字节 != 本地 ${local_size} 字节)—— 上传被截断/写入不完整,拒绝写 latest.json(避免指针指向损坏对象)" >&2
    exit 1
  fi
  if [ -z "$remote_sha" ] || [ "$remote_sha" = "None" ]; then
    echo "::error::更新服务器校验失败(${label}:远端对象没有 SHA256 校验和,无法证明字节完整)" >&2
    echo "::error::上传带的是 --checksum-sha256;这里为空说明存储端/CLI 没有留存该校验和 —— 请先修通再发布(不以\"只校大小\"放行)" >&2
    exit 1
  fi
  if [ "$remote_sha" != "$local_b64" ]; then
    echo "::error::更新服务器校验失败(${label}:远端对象的 SHA256 与本地不一致)—— 远端存下的不是本地产物,拒绝写 latest.json" >&2
    exit 1
  fi
}

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
  zip_key="${channel}/releases/${VER}/picoaide-server-${VER}-amd64.zip"
  sums_key="${channel}/releases/${VER}/SHA256SUMS"

  # 本地自洽:SHA256SUMS 必须真的写着本包的 sha256。空文件/写错包名在客户侧表现
  # 为"校验永远不过",而这里能当场拦下(它跟着包一起进镜像与 R2)。
  zip_sha="$(sha256sum "$zip" | cut -d' ' -f1)"
  if ! grep -qF "$zip_sha" "$sums"; then
    echo "::error::本地产物不自洽(releases/${VER}/ 的 SHA256SUMS 里没有该镜像包的 SHA256)—— 拒绝发布" >&2
    exit 1
  fi

  # 1) 版本化资产:不可变 + 长缓存(同版本内容永不改)+ 存储侧校验和(见上方
  #    verify_remote_object 的注释:单请求 PUT 才能拿到可与本地对拍的整对象 sha256)。
  if ! brand_run_checked aws s3api put-object \
    --bucket "$R2_BUCKET" --key "$zip_key" --body "fileb://${zip}" \
    --content-type application/zip --cache-control "$IMMUTABLE" \
    --checksum-sha256 "$(sha256_b64 "$zip")"; then
    echo "::error::更新服务器发布失败(渠道 ${INDEX}:上传版本资产;上方输出已脱敏)" >&2
    exit 1
  fi
  verify_remote_object "$zip_key" "$zip" "版本资产"

  if ! brand_run_checked aws s3api put-object \
    --bucket "$R2_BUCKET" --key "$sums_key" --body "fileb://${sums}" \
    --content-type text/plain --cache-control "$IMMUTABLE" \
    --checksum-sha256 "$(sha256_b64 "$sums")"; then
    echo "::error::更新服务器发布失败(渠道 ${INDEX}:上传校验和;上方输出已脱敏)" >&2
    exit 1
  fi
  verify_remote_object "$sums_key" "$sums" "校验和文件"

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

  # 3) 写指针前再确认一次本轮资产**真的在远端**:指针指向空目录/损坏对象是最坏的
  #    一类静默故障(客户取包 404 或 `docker load` 失败,而流水线全绿)。
  #
  #    这一步在 2026-09-23 审计(K-01)后已升级:**不再是"对象存在"**,而是
  #    verify_remote_object 的"大小 + SHA256 双向对拍"(上传后第 1 步已经校过一次,
  #    这里在清理旧版本之后再校一次 —— 保留策略的删除动作同样会碰到对象键)。
  #    旧实现只断言 `aws s3 ls <键>` 有输出,截断的对象照样放行。
  verify_remote_object "$zip_key" "$zip" "版本资产(写指针前复检)"

  # 4) 版本指针**最后**写:先资产后指针,读者永远不会看到指向空目录的清单。
  #
  #    指针本身也要证明字节完整(2026-09-23 第六轮审计 R6-C-3):客户端更新链路的第一步
  #    就是读这份清单 —— 它被截断/写坏时连版本号都读不到,而 `aws s3 cp` 的退出码同样
  #    只表示"请求成功"。所以这里与资产走**同一条**单请求 PUT + 存储侧校验和的路径,
  #    写完再由 verify_remote_object 对拍大小与 SHA256。
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
  if ! brand_run_checked aws s3api put-object \
    --bucket "$R2_BUCKET" --key "${channel}/latest.json" --body "fileb://${manifest}" \
    --content-type application/json --cache-control "$NO_CACHE" \
    --checksum-sha256 "$(sha256_b64 "$manifest")"; then
    echo "::error::更新服务器发布失败(渠道 ${INDEX}:写版本指针;上方输出已脱敏)" >&2
    rm -f "$manifest"
    exit 1
  fi
  verify_remote_object "${channel}/latest.json" "$manifest" "版本指针"
  rm -f "$manifest"
  TOTAL=$((TOTAL + 1))
done < "$LIST"

echo "update server publish done (${TOTAL} channel(s))"
