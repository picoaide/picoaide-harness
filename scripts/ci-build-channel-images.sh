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

REPO_ROOT="${CI_IMAGE_BUILD_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
# CI_IMAGE_BUILD_ROOT 只给**本地回归门禁**用(把脚本指向临时目录,避免污染工作树里的
# client-assets/ channels-context/ image.tar);CI 里不设置,行为与之前完全一致。
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

# 客户端三平台交付面（清单键 / 产物通配 / 人读标签）的**唯一来源**：
# `packages/host/desktop/scripts/channel-build.ts` 的 `CLIENT_PLATFORM_ASSETS`。
# 不在 shell 里再抄一份 —— 两处各写一遍就是两个口径（2026-09-26 审计 Z3-2 的形态：
# 旧实现逐个 `[ -f … ] || return 0`，少一个平台的产物时**什么都不输出**，
# CLIENT-RELEASE.json 只是少一个键，流水线全绿）。同一份清单还被 R2 中转的
# "三平台齐全"判据与根守卫（与 ci.yml 三个平台 job 的 `--patterns` 对拍）消费。
#
# 路径取**本脚本所在仓库**，不是 `CI_IMAGE_BUILD_ROOT`：后者是给本地回归门禁用的
# 构建上下文覆盖（`client-assets`/`channels-context`/`image.tar` 的落点），平台清单
# 属于**正在执行的这份代码**，跟着构建上下文走会让清单随夹具目录消失（实测）。
SCRIPT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
platform_table() {
  node -e '
    import(require("node:url").pathToFileURL(process.argv[1]).href).then((mod) => {
      const assets = mod.CLIENT_PLATFORM_ASSETS
      if (!Array.isArray(assets) || assets.length === 0) throw new Error("CLIENT_PLATFORM_ASSETS 为空")
      for (const asset of assets) process.stdout.write(`${asset.key}\t${asset.glob}\t${asset.label}\n`)
    }).catch((error) => {
      console.error(`platform_table: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    })
  ' "$SCRIPT_ROOT/packages/host/desktop/scripts/channel-build.ts"
}
if ! PLATFORM_TABLE="$(platform_table)" || [ -z "$PLATFORM_TABLE" ]; then
  echo "::error::读不到客户端平台清单(packages/host/desktop/scripts/channel-build.ts 的 CLIENT_PLATFORM_ASSETS)" >&2
  echo "::error::镜像清单的「逐平台必需」判据靠它派生,读不到就不能假装三平台齐全" >&2
  exit 1
fi
# 供镜像内断言用:键列表(空格分隔),作为 sh -c 的位置参数传进去,内层脚本零插值。
PLATFORM_KEYS="$(printf '%s\n' "$PLATFORM_TABLE" | cut -f1 | tr '\n' ' ')"

INDEX=0
for channel in "${CHANNELS[@]}"; do
  INDEX=$((INDEX + 1))
  printf '::add-mask::%s\n' "$channel"

  # 1) 客户端资产:该渠道的三平台安装包 + 清单(镜像内携带)。
  #    目录必须存在:server/Dockerfile 用目录形式 COPY(缺目录会构建失败)。
  #
  #    **Linux 只放 AppImage,不放 .deb**(2026-09-10 定案):两者是同一个应用的两种
  #    打包,员工装一个就够;deb 常年没人下载,却给每个渠道的镜像白加 ~115MB。
  #    CI 仍会把 deb 作为构建产物上传(开发者本地/PR 可用),只是不进镜像。
  rm -rf client-assets
  mkdir -p client-assets/client
  if [ -d "$ARTIFACTS/$channel" ]; then
    cp -a "$ARTIFACTS/$channel/." client-assets/client/
    rm -f client-assets/client/*.deb
  fi
  if [ -z "$(ls -A client-assets/client)" ]; then
    # 只报序号,不回显渠道 id 与路径 —— 不依赖 ::add-mask:: 兜底(掩码是"从发出
    # 那一刻起"生效的,消息里少写一个 id 就少一层依赖)。
    echo "::error::渠道 ${INDEX}/${TOTAL} 没有任何客户端安装包(该渠道的 artifacts 目录为空)" >&2
    echo "::error::客户端随镜像分发是单包交付的核心;缺客户端说明桌面 job 没有产出" >&2
    exit 1
  fi

  # 2) 客户端清单:服务端据此生成 GET /api/client/v2/updates/manifest。
  #    必须是 client.version/client.assets 结构 —— 客户端解析器
  #    (packages/host/desktop/src/desktop-release.ts)只认这一种形状,
  #    且强制 url 绝对 https、sha256 为 64 位小写 hex。
  #    url 用发布基址占位;服务端对外下发时按自身地址重写。
  #
  #    **逐平台必需**(2026-09-26 审计 Z3-2):按 CLIENT_PLATFORM_ASSETS 逐个平台找产物,
  #    缺任一即 fail-loud 并点名平台 —— 旧实现是 `[ -f … ] || return 0`,缺平台时
  #    生成的清单只是少一个键:更新清单少一个平台、门户少一个下载入口、
  #    `/updates/client/<安装包名>` 404,而流水线全绿、镜像内校验也绿。
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
    while IFS=$'\t' read -r key glob label; do
      [ -n "$key" ] || continue
      # 通配在**目录不存在**时会原样返回模式串,所以先判 -f(而不是判字符串非空)。
      platform_file=""
      for candidate in client-assets/client/$glob; do
        if [ -f "$candidate" ]; then platform_file="$(basename "$candidate")"; break; fi
      done
      if [ -z "$platform_file" ]; then
        # 报错只报序号 + 平台标签 + 通配,不回显渠道 id 与文件名(公开日志纪律)。
        echo "::error::渠道 ${INDEX}/${TOTAL} 缺少 ${label} 的客户端安装包(通配 ${glob})。" >&2
        echo "::error::客户端交付面是三平台各一份安装包;缺平台的清单会让更新面/门户静默少一个平台," >&2
        echo "::error::必须核对三个 desktop job 的产物是否都归集到了本渠道的 artifacts 目录。" >&2
        exit 1
      fi
      add "$key" "$platform_file"
    done <<< "$PLATFORM_TABLE"
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
    # 内置技能资产的源头就在镜像构建上下文里（server/skills/<name>/，Dockerfile
    # 直接 COPY 进 /opt/picoaide/skills；服务端由 GET /api/client/v2/skills/builtin
    # 下发、客户端在能力中心按需安装）。2026-09-19 起源头归位服务端，不再需要
    # 指向客户端 vendored 插件包的 --build-context skillassets。
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
    # 三 tag:tar 里同时带 vX.Y.Z、X.Y.Z 与**渠道专属** `<channel>-X.Y.Z`。
    # CI 内部与 latest.json 的 image_tag 用带 v 的形式,部署文档 §3/§6 的示例用不带
    # v 的形式 —— 只打一个,照文档敲的人就会去 docker.io 拉取(隔离网/镜像代理下
    # 直接 403,2026-09-10 实测)。
    #
    # 渠道 tag 是**同机多栈**的唯一防线(2026-09-23 审计 K-02):渠道差异在**内容**
    # (/opt/picoaide/channel + 烘焙的渠道标识),不在 tag —— 归档内部 tag 恒为
    # `picoaide-harness-server:v<ver>`。同一台宿主机部署两个渠道时,后 `docker load`
    # 的会**覆盖**前者那个 tag,此后任一栈 `docker compose up -d server` 都会用
    # **另一渠道**的镜像重建(品牌、随包客户端全错,`.env` 里的 SERVER_IMAGE 看起来
    # 却完全正确)。带上渠道 tag 后,部署侧只要把该栈 `.env` 写成
    # `<channel>-<ver>` 就与别的栈彻底隔离(步骤见 docs/deploy/AI-DEPLOY.md §6.5)。
    #
    # 渠道 id 只在 tag 里(运行时变量,不进日志:渠道轮输出被重定向);产物 zip 的
    # 文件名保持中性,公开面不新增任何渠道身份。
    docker tag "${IMAGE}:v${VER}" "${IMAGE}:${VER}" || return 1
    docker tag "${IMAGE}:v${VER}" "${IMAGE}:${channel}-${VER}" || return 1
    docker save "${IMAGE}:v${VER}" "${IMAGE}:${VER}" "${IMAGE}:${channel}-${VER}" -o "$img_tar" || return 1
    ( cd "$OUT/$channel" && zip -1 -q "$ARCHIVE" "$img_tar" -j ) || return 1
    rm -f "$img_tar"
    ( cd "$OUT/$channel" && sha256sum "$ARCHIVE" | sed 's# .*/# #' > SHA256SUMS ) || return 1
  }

  # 5) 构建后**在镜像内**断言服务端契约:清单必须落在服务端读取的位置,且清单里的
  #    平台键**逐平台齐全**。
  #    2026-09-10 实测踩到:清单被 COPY 到上一级目录,LoadInfo 永远返回 nil,
  #    更新清单里没有 client 段、门户下载区全空 —— 链路整个死掉且零报错。
  #    这类"路径对不上"的错误只有真去镜像里看才能发现。
  #    2026-09-26 审计 Z3-2 的另一半:镜像内的判据只是 `ls | grep -q .`(目录非空),
  #    于是少平台的 CLIENT-RELEASE.json 照样绿。平台键从**同一份** PLATFORM_TABLE
  #    派生,作为 sh -c 的位置参数传进容器(内层脚本不插值)。
  verify_image() {
    docker run --rm --entrypoint sh "${IMAGE}:v${VER}" -c '
      set -e
      test -s /opt/picoaide/client/CLIENT-RELEASE.json || { echo "MISSING /opt/picoaide/client/CLIENT-RELEASE.json" >&2; exit 1; }
      test -s /opt/picoaide/channel/channel.json || { echo "MISSING /opt/picoaide/channel/channel.json" >&2; exit 1; }
      # 内置技能（服务端下发、客户端按需安装）：缺 SKILL.md 时清单会是空的，
      # 而"清单是空的"在客户端只表现为"能力中心里没有这条技能"，零报错。
      test -s /opt/picoaide/skills/app-builder/SKILL.md || { echo "MISSING /opt/picoaide/skills/app-builder/SKILL.md" >&2; exit 1; }
      test -s /opt/picoaide/skills/app-builder/references/publishing.md || { echo "MISSING builtin skill references/" >&2; exit 1; }
      test -s "/opt/picoaide/CHANNEL" || { echo "MISSING /opt/picoaide/CHANNEL" >&2; exit 1; }
      # 平台键齐全是硬判据:服务端只按这个清单下发更新地址,少一个键 = 该平台
      # 永远拿不到客户端(门户同样少一个下载入口),而镜像"看起来"是好的。
      for key in "$@"; do
        grep -q "\"$key\"" /opt/picoaide/client/CLIENT-RELEASE.json || { echo "MISSING client asset key $key in CLIENT-RELEASE.json" >&2; exit 1; }
      done
      ls /opt/picoaide/client/ | grep -q . || { echo "client dir empty" >&2; exit 1; }
    ' picoaide-platform-check $PLATFORM_KEYS
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
