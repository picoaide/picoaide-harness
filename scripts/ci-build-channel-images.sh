#!/usr/bin/env bash
#
# 逐渠道构建服务端镜像并导出交付压缩包。
#
# 每个渠道产出 `release-bundle/<channel>/picoaide-server-<ver>-amd64.zip` +
# `SHA256SUMS` —— 一张镜像内含该渠道的**三平台客户端**(客户端随镜像分发,
# 由服务端自己下发给员工)与该渠道的渠道内容(品牌/文案/logo)。
#
# 渠道 CI **不输出日志**(2026-09-10 用户定案):只有 official 保留完整构建输出,
# 其余渠道的输出重定向到 runner 临时文件;失败只报中性信息。渠道与官方跑同一套
# Dockerfile 与构建脚本,只换 --build-arg CHANNEL,排障看官方那一份。
#
# 用法:
#   VERSION=v2.7.0 scripts/ci-build-channel-images.sh \
#     --list channels.list --artifacts release-artifacts --out release-bundle
#
# 退出码:0 全部成功;非 0 有渠道失败。
set -euo pipefail

LIST=""
ARTIFACTS="release-artifacts"
OUT="release-bundle"
while [ $# -gt 0 ]; do
  case "$1" in
    --list) LIST="$2"; shift 2 ;;
    --artifacts) ARTIFACTS="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "ci-build-channel-images: 未知参数 $1" >&2; exit 2 ;;
  esac
done

[ -n "$LIST" ] && [ -f "$LIST" ] || { echo "::error::缺少 --list <渠道列表>" >&2; exit 2; }
[ -n "${VERSION:-}" ] || { echo "::error::缺少 VERSION(如 v2.7.0)" >&2; exit 2; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 一切相对路径(client-assets / channels / channels-context / server 构建上下文)
# 都以仓库根为基准 —— 调用方的工作目录不影响结果。
cd "$REPO_ROOT"
VER="${VERSION#v}"
IMAGE="picoaide-harness-server"
LOG_DIR="$(mktemp -d)"
trap 'rm -rf "$LOG_DIR"' EXIT

CHANNELS=()
while IFS= read -r line; do
  [ -n "$line" ] || continue
  CHANNELS+=("$line")
done < "$LIST"
TOTAL="${#CHANNELS[@]}"
[ "$TOTAL" -gt 0 ] || { echo "::error::渠道列表为空" >&2; exit 2; }

INDEX=0
for channel in "${CHANNELS[@]}"; do
  INDEX=$((INDEX + 1))
  printf '::add-mask::%s\n' "$channel"

  # 1) 客户端资产:该渠道的三平台安装包 + 清单(镜像内携带)。
  #    目录必须存在:server/Dockerfile 用目录形式 COPY(缺目录会构建失败)。
  rm -rf client-assets
  mkdir -p client-assets/client
  if [ -d "$ARTIFACTS/$channel" ]; then
    cp -a "$ARTIFACTS/$channel/." client-assets/client/
  fi
  if [ -z "$(ls -A client-assets/client)" ]; then
    echo "::error::渠道 ${INDEX}/${TOTAL} 没有任何客户端安装包(artifacts/${channel} 为空)" >&2
    echo "::error::客户端随镜像分发是单包交付的核心;缺客户端说明桌面 job 没有产出" >&2
    exit 1
  fi

  # 2) 客户端清单:服务端据此生成 GET /api/client/v2/updates/manifest。
  #    必须是 client.version/client.assets 结构 —— 客户端解析器
  #    (packages/host/desktop/src/desktop-release.ts)只认这一种形状,
  #    且强制 url 绝对 https、sha256 为 64 位小写 hex。
  #    url 用发布基址占位;服务端对外下发时按自身地址重写。
  BASE="https://release.picoaide.com/${channel}/releases/${VER}"
  {
    echo '{'
    echo '  "schema": 1,'
    echo "  \"channel_id\": \"${channel}\","
    echo '  "client": {'
    echo "    \"version\": \"${VER}\","
    echo '    "assets": {'
    first=1
    add() { # $1=清单键 $2=文件名
      [ -f "client-assets/client/$2" ] || return 0
      [ "$first" = 1 ] || echo ','
      first=0
      printf '      "%s": { "file": "%s", "url": "%s/%s", "sha256": "%s", "size": %s }' \
        "$1" "$2" "$BASE" "$2" \
        "$(sha256sum "client-assets/client/$2" | cut -d' ' -f1)" \
        "$(stat -c%s "client-assets/client/$2")"
    }
    add mac-universal "$(basename "$(ls client-assets/client/*.dmg 2>/dev/null | head -1)" 2>/dev/null || echo -)"
    add win-x64       "$(basename "$(ls client-assets/client/*.exe 2>/dev/null | head -1)" 2>/dev/null || echo -)"
    add linux-x64     "$(basename "$(ls client-assets/client/*.AppImage 2>/dev/null | head -1)" 2>/dev/null || echo -)"
    echo
    echo '    }'
    echo '  }'
    echo '}'
  } > client-assets/CLIENT-RELEASE.json
  node -e "JSON.parse(require('fs').readFileSync('client-assets/CLIENT-RELEASE.json','utf8'))"

  # 3) 渠道内容:镜像构建的 channelassets 上下文必须**只含本渠道**的目录。
  rm -rf channels-context
  mkdir -p "channels-context/${channel}"
  cp -a "channels/${channel}/." "channels-context/${channel}/"

  # 4) 构建镜像 + 导出 zip。渠道轮静默。
  ARCHIVE="picoaide-server-${VER}-amd64.zip"
  mkdir -p "$OUT/$channel"
  # 每一步都显式 `|| return 1`:调用方在 `if ! build` 这类**条件语境**里调用时,
  # bash 会抑制函数体内的 set -e(条件语境的抑制会继承进函数/子 shell),于是
  # docker build 失败后还会继续跑 docker save / zip,并把最终状态伪装成成功。
  # 不能依赖 set -e,必须显式短路。
  build() {
    local img_tar="$REPO_ROOT/image.tar"
    docker buildx build \
      --platform linux/amd64 \
      --build-arg VERSION="$VER" \
      --build-arg CHANNEL="$channel" \
      --build-context clientassets=./client-assets \
      --build-context channelassets=./channels-context \
      --label "org.opencontainers.image.source=https://github.com/picoaide/picoaide-harness" \
      --label "org.opencontainers.image.version=$VER" \
      --tag "${IMAGE}:v${VER}" \
      --load \
      server || return 1
    docker save "${IMAGE}:v${VER}" -o "$img_tar" || return 1
    ( cd "$OUT/$channel" && zip -1 -q "$ARCHIVE" "$img_tar" -j ) || return 1
    rm -f "$img_tar"
    ( cd "$OUT/$channel" && sha256sum "$ARCHIVE" | sed 's# .*/# #' > SHA256SUMS ) || return 1
  }

  # 5) 构建后**在镜像内**断言服务端契约:清单必须落在服务端读取的位置。
  #    2026-09-10 实测踩到:清单被 COPY 到上一级目录,LoadInfo 永远返回 nil,
  #    更新清单里没有 client 段、门户下载区全空 —— 链路整个死掉且零报错。
  #    这类"路径对不上"的错误只有真去镜像里看才能发现。
  verify_image() {
    docker run --rm --entrypoint sh "${IMAGE}:v${VER}" -c '
      set -e
      test -s /opt/picoaide/client/CLIENT-RELEASE.json || { echo "MISSING /opt/picoaide/client/CLIENT-RELEASE.json" >&2; exit 1; }
      test -s /opt/picoaide/channel/channel.json || { echo "MISSING /opt/picoaide/channel/channel.json" >&2; exit 1; }
      test -s "/opt/picoaide/CHANNEL" || { echo "MISSING /opt/picoaide/CHANNEL" >&2; exit 1; }
      ls /opt/picoaide/client/ | grep -q . || { echo "client dir empty" >&2; exit 1; }
    '
  }

  if [ "$channel" = "official" ]; then
    echo "building image ${INDEX}/${TOTAL} (full log)"
    if ! build; then
      echo "::error::官方渠道镜像构建失败(日志见上)" >&2
      exit 1
    fi
  elif ! build > "$LOG_DIR/$INDEX.log" 2>&1; then
    echo "::error::渠道 ${INDEX}/${TOTAL} 镜像构建失败。" >&2
    echo "::error::渠道与官方共用同一套 Dockerfile 与构建脚本,只换 --build-arg CHANNEL;" >&2
    echo "::error::请用官方构建复现排障(本步骤按定策不输出渠道日志)" >&2
    exit 1
  else
    echo "building image ${INDEX}/${TOTAL} (quiet)"
  fi
  if ! verify_image; then
    echo "::error::渠道 ${INDEX}/${TOTAL} 的镜像缺少服务端契约要求的文件(见上)" >&2
    exit 1
  fi
  ls -lh "$OUT/$channel/$ARCHIVE"
done

# 供后续步骤读取的发布渠道:官方优先(公开 GitHub Release 只发这一个)。
if printf '%s\n' "${CHANNELS[@]}" | grep -qx official; then
  echo "public_channel=official" >> "${GITHUB_OUTPUT:-/dev/null}"
elif printf '%s\n' "${CHANNELS[@]}" | grep -qx beta; then
  echo "public_channel=beta" >> "${GITHUB_OUTPUT:-/dev/null}"
else
  echo "::error::渠道列表里既没有 official 也没有 beta —— 公开 Release 无从发布" >&2
  exit 1
fi

echo "server images built: ${TOTAL} channel(s)"
