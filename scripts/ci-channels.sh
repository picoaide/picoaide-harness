#!/usr/bin/env bash
#
# 拉取私有渠道仓(picoaide/channels)并决定**本次要构建哪些渠道**。
#
# 为什么是脚本而不是内联 YAML:这段逻辑(路径层数、非空目录、克隆失败残留、
# 渠道 id 掩码、tag→渠道集策略)出错都会静默发错镜像,必须能被本地测试。
#
# 渠道 id 处理原则(2026-09-10 用户定案):**渠道 CI 不输出日志**。
#   - 每个渠道 id 一读到就 `::add-mask::`,此后任何意外的 echo 都会被 GitHub
#     自动抹成 ***;
#   - 本脚本自身只打印中性的计数与进度,绝不回显渠道名;
#   - 构建失败只报中性信息 —— 官方构建跑的是同一套代码路径,排查看官方那份日志。
#
# 用法:
#   CHANNELS_REPO_TOKEN=... scripts/ci-channels.sh [--dest channels] [--list channels.list]
#
# 环境:
#   CHANNELS_REPO_TOKEN   读私有渠道仓的令牌(细粒度 PAT,Contents:Read 即可)
#   GITHUB_REF_NAME       tag 名(决定渠道集);非 tag 时留空
#   CI_CHANNELS_SOURCE    已有检出目录(本地测试用;给了就跳过克隆)
#   CI_CHANNELS_REPO      渠道仓 slug(缺省 picoaide/channels)
#
# 退出码:0 成功;非 0 失败(渠道仓不可读/结构不符/必需的渠道缺失)。
set -euo pipefail

DEST="channels"
LIST="channels.list"

while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="$2"; shift 2 ;;
    --list) LIST="$2"; shift 2 ;;
    *) echo "ci-channels: 未知参数 $1" >&2; exit 2 ;;
  esac
done

REPO="${CI_CHANNELS_REPO:-picoaide/channels}"
REF_NAME="${GITHUB_REF_NAME:-}"
SOURCE="${CI_CHANNELS_SOURCE:-}"

# 渠道 id 形状(与客户端 CHANNEL_ID_PATTERN / 服务端 IsChannelID 同源)。
ID_PATTERN='^[a-z0-9][a-z0-9-]{0,31}$'

# 掩码:让 GitHub 从此抹掉该字符串。测试环境(非 Actions)是 no-op。
mask() {
  printf '::add-mask::%s\n' "$1"
}

# 取工作区里的 channels/ 目录(渠道仓自身结构是 <repo>/channels/<id>/)。
stage_from() {
  local src="$1"
  if [ ! -d "$src/channels" ]; then
    echo "::error::渠道仓里没有 channels/ 目录(仓库结构不符)" >&2
    return 1
  fi
  # 先删再就位:目标是已存在目录时 `mv src dst` 会把源**移进去**(dst/src),
  # 而不是替换;仓库里还有个 channels/README.md 占位。
  rm -rf "$DEST"
  mkdir -p "$DEST"
  cp -a "$src/channels/." "$DEST/"
}

if [ -n "$SOURCE" ]; then
  stage_from "$SOURCE"
else
  if [ -z "${CHANNELS_REPO_TOKEN:-}" ]; then
    echo "::error::缺少 secret CHANNELS_REPO_TOKEN —— 无法读取私有渠道仓 ${REPO}" >&2
    echo "::error::请创建一个只读该仓 Contents 的 fine-grained PAT,并添加为仓库 secret" >&2
    exit 1
  fi
  # 克隆到临时目录再就位:直接 clone 到非空的 channels/ 会失败,而失败后残留的
  # 上一轮内容会让后续步骤照常跑完 —— 那正是"静默发错镜像"的来源。
  # 克隆失败即中止,不留可被误用的半成品。
  CLONE="$(mktemp -d)"
  trap 'rm -rf "$CLONE"' EXIT
  rm -rf "$DEST" "$CLONE/.git" 2>/dev/null || true
  if ! git clone --depth 1 --quiet \
    "https://x-access-token:${CHANNELS_REPO_TOKEN}@github.com/${REPO}.git" "$CLONE"; then
    echo "::error::无法克隆私有渠道仓 ${REPO}(检查 CHANNELS_REPO_TOKEN 是否有效/是否只读该仓)" >&2
    exit 1
  fi
  stage_from "$CLONE"
  # 刻意**不打印**私有仓的 commit SHA:它是私有仓的指纹(能对上"哪次改动进了哪个
  # 发布"),而这里的一切都会进公开仓的 Actions 日志。只需要知道取到了内容。
  echo "channel packages fetched"
fi

# 枚举渠道目录并**逐个掩码**。
FOUND=()
SKIPPED=0
for dir in "$DEST"/*/; do
  [ -d "$dir" ] || continue
  id="$(basename "$dir")"
  if ! printf '%s' "$id" | grep -Eq "$ID_PATTERN"; then
    # 刻意**不回显**这个名字:不合规的目录名可能是别的东西(README、.git 等),
    # 也可能是写错的渠道名 —— 两种都不该进公开日志。
    SKIPPED=$((SKIPPED + 1))
    continue
  fi
  mask "$id"
  FOUND+=("$id")
done

if [ "$SKIPPED" -gt 0 ]; then
  echo "::warning::已跳过 ${SKIPPED} 个不符合渠道 id 形状的目录(名字不打印)" >&2
fi

if [ "${#FOUND[@]}" -eq 0 ]; then
  echo "::error::渠道仓里没有任何渠道目录" >&2
  exit 1
fi

# 定序:official 最先(主产物),其余字典序 —— 顺序稳定才能让"哪个渠道失败了"
# 可复现。用显式两段拼接,避免空数组在 set -u 下的展开陷阱。
ALL=()
for id in "${FOUND[@]}"; do
  if [ "$id" = "official" ]; then ALL+=("$id"); fi
done
while IFS= read -r id; do
  [ -n "$id" ] || continue
  [ "$id" = "official" ] && continue
  ALL+=("$id")
done < <(printf '%s\n' "${FOUND[@]}" | LC_ALL=C sort)

# tag → 渠道集(用户定案):
#   beta 预发布 tag  → 只发 beta 渠道(beta 是独立渠道,复用官方品牌内容)
#   正式 tag vX.Y.Z  → 发**所有**渠道(发一个正式版 = 所有渠道都发布)
#   非 tag(PR/分支) → 只做 official(与现状一致)
SELECTED=()
case "$REF_NAME" in
  *-beta|*-beta.*|*-rc|*-rc.*|*-alpha|*-alpha.*)
    SELECTED=("beta") ;;
  v[0-9]*.[0-9]*.[0-9]*)
    SELECTED=("${ALL[@]}") ;;
  *)
    SELECTED=("official") ;;
esac

# 断言:要发的渠道必须在渠道仓里真实存在(缺失 = 配置事故,不是"跳过"),
# 且**必须带品牌内容**。
#
# 为什么品牌是硬性要求(2026-09-10):客户端在登录之前就要显示品牌(登录页标题、
# 品牌区、侧边栏),那一刻问不到服务端 —— 文案只能随包。包里没写品牌时,
# 客户端回落的是中性占位(Harness),交付出去就是"渠道客户看到中性名/厂商名"
# 的观感事故。这类事故在构建期可拦,且**只能**在构建期拦:装到客户机器上之后
# 再发现就晚了。缺字段的报错刻意不回显渠道名(渠道 CI 不输出渠道信息)。
for id in "${SELECTED[@]}"; do
  manifest="$DEST/$id/channel.json"
  if [ ! -f "$manifest" ]; then
    echo "::error::渠道仓里缺少该渠道的 channel.json(渠道目录或配置缺失)" >&2
    exit 1
  fi
  # 用 node 解析而不是 grep:channel.json 允许任意缩进/键序,正则匹配字段名会在
  # 嵌套结构上误判(例如 copy.login_display_name 与别处的同名键)。
  #
  # 2026-09-10 审计后加严的部分:
  #   - 品牌渠道(official/beta 之外)**必须**给 desktop.slug / desktop.app_id:
  #     缺 slug 时安装包名回落 `PicoAide-Harness-…`,缺 app_id 时 bundle id /
  #     AppUserModelId 回落厂商值 —— 前者是交付物上的厂商品牌,后者会让两个渠道的
  #     客户端在系统里变成"同一个 app";
  #   - deep_link_scheme 必须是合法 scheme(它进浏览器确认框,还会与 electron-builder
  #     的 protocols 以及服务端 OIDC 回调三处联动);
  #   - assets 里声明的素材文件必须真的存在,且 app-icon.png 必须符合 mac 图标
  #     管线要求(1024×1024 RGBA16 + ICC):这两个在打包时才炸,而打包要跑三平台。
  if ! CHANNEL_ID="$id" node -e '
    const fs = require("node:fs")
    const path = require("node:path")
    const dir = path.dirname(process.argv[1])
    const id = process.env.CHANNEL_ID
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const str = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined)
    const publicChannel = id === "official" || id === "beta"
    const missing = []
    const invalid = []
    // identity.display_name 是客户端**所有**名字的最终兜底(登录页/界面/门户),
    // short_name 是登录页与服务端 applyDefaults 的直接来源:两者缺一,渠道构建
    // 就会在某个可见位置显示中性占位。
    if (str(cfg?.identity?.display_name) === undefined) missing.push("identity.display_name")
    if (str(cfg?.identity?.short_name) === undefined) missing.push("identity.short_name")
    if (!publicChannel) {
      if (str(cfg?.desktop?.slug) === undefined) missing.push("desktop.slug")
      if (str(cfg?.desktop?.app_id) === undefined) missing.push("desktop.app_id")
      if (str(cfg?.desktop?.deep_link_scheme) === undefined) missing.push("desktop.deep_link_scheme")
    }
    const slug = str(cfg?.desktop?.slug)
    if (slug !== undefined && !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(slug)) invalid.push("desktop.slug(" + slug + ")")
    const appId = str(cfg?.desktop?.app_id)
    if (appId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(appId)) invalid.push("desktop.app_id(" + appId + ")")
    const scheme = str(cfg?.desktop?.deep_link_scheme)
    if (scheme !== undefined && !/^[a-z][a-z0-9+.-]{1,31}$/.test(scheme)) invalid.push("desktop.deep_link_scheme(" + scheme + ")")
    const serverUrl = str(cfg?.defaults?.server_url)
    if (serverUrl !== undefined) {
      let parsed
      try { parsed = new URL(serverUrl) } catch { invalid.push("defaults.server_url(不是合法 URL)") }
      if (parsed !== undefined && parsed.protocol !== "https:") {
        const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname)
        if (!loopback) invalid.push("defaults.server_url(必须 https,只有回环地址允许 http)")
      }
    }
    // 声明的素材文件必须存在(否则客户端/服务端会拿到死链或被忽略的配置)。
    for (const [key, value] of Object.entries(cfg?.assets ?? {})) {
      if (key === "accent") continue
      const name = str(value)
      if (name === undefined) continue
      if (name.includes("/") || name.includes("\\")) { invalid.push("assets." + key + "(必须是单段文件名)"); continue }
      if (!fs.existsSync(path.join(dir, name))) invalid.push("assets." + key + "(渠道目录里没有这个文件)")
    }
    // mac 图标管线要求:1024×1024、RGBA16、带 ICC(见 generate-mac-app-icon.mjs)。
    const iconPath = path.join(dir, "app-icon.png")
    if (fs.existsSync(iconPath)) {
      const buf = fs.readFileSync(iconPath)
      const png = buf.length > 33 && buf.readUInt32BE(0) === 0x89504e47
      if (!png) invalid.push("app-icon.png(不是 PNG)")
      else {
        const width = buf.readUInt32BE(16)
        const height = buf.readUInt32BE(20)
        const bitDepth = buf[24]
        const colorType = buf[25]
        if (width !== 1024 || height !== 1024) invalid.push("app-icon.png(必须是 1024×1024,实际 " + width + "×" + height + ")")
        if (bitDepth !== 16 || colorType !== 6) invalid.push("app-icon.png(必须是 16 位 RGBA,实际 depth=" + bitDepth + " colorType=" + colorType + ")")
        // iCCP chunk:扫描 PNG 块目录(不引入 sharp 依赖)。
        let offset = 8
        let hasIcc = false
        while (offset + 8 <= buf.length) {
          const length = buf.readUInt32BE(offset)
          const type = buf.toString("ascii", offset + 4, offset + 8)
          if (type === "iCCP") { hasIcc = true; break }
          if (type === "IEND") break
          offset += 12 + length
        }
        if (!hasIcc) invalid.push("app-icon.png(必须内嵌 ICC 色彩配置)")
      }
    }
    if (missing.length > 0 || invalid.length > 0) {
      if (missing.length > 0) {
        console.error("::error::渠道包缺少品牌字段: " + missing.join(", ") + " —— 客户端登录页/侧边栏在服务端不可达时会回落中性占位/厂商名,请补齐后重新发布")
      }
      if (invalid.length > 0) {
        console.error("::error::渠道包字段不合法: " + invalid.join(", "))
      }
      console.error("::error::这些字段错在客户机器上才发现就晚了,因此构建期硬拦(字段清单见 docs/planning/2026-09-10-channel-package-reference.md)")
      process.exit(1)
    }
  ' "$manifest"; then
    exit 1
  fi
done

printf '%s\n' "${SELECTED[@]}" > "$LIST"
# 只报数量与形态,不回显渠道名。
echo "channels selected: ${#SELECTED[@]} of ${#ALL[@]} (all channel ids masked)"
