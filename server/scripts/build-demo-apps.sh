#!/usr/bin/env bash
#
# 本地构建内置演示应用：**与 Dockerfile 的那一段逐条对应**，供开发机上跑通
# "编译 → 打包前端资源 → 假宿主预览"整条链，不必每次都构建镜像。
#
# 为什么要有这个脚本：演示应用的前端资源要打进 wasm 的自定义段，而打包脚本是
# Node 写的（`skills/app-builder/scripts/pack-assets.mjs`）—— Dockerfile 里为此
# 专门加了一个 node 阶段。本脚本是同一套步骤的本地版本，产物落 `/tmp/demo-<app>-packed.wasm`。
#
# 用法：
#   bash server/scripts/build-demo-apps.sh              # 全部三个
#   bash server/scripts/build-demo-apps.sh forum        # 只构建一个
#
# 之后可以用假宿主看效果：
#   node server/skills/app-builder/examples/go/preview.mjs /tmp/demo-forum-packed.wasm \
#     --config server/demoapps/forum/picoaide.app.json --path / --user zhangwei
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVER="$ROOT/server"
PACK="$SERVER/skills/app-builder/scripts/pack-assets.mjs"

# 演示应用清单（与 Dockerfile 的 `for app in ...` 必须一致）。
ALL_APPS=(showcase forum board)
APPS=("$@")
if [ ${#APPS[@]} -eq 0 ]; then APPS=("${ALL_APPS[@]}"); fi

# Go 的缓存目录：**必须在工作区内**（本机 $HOME 下的缓存在沙箱里可能只读）。
export GOCACHE="${GOCACHE:-$ROOT/temp/demo-gocache}"
export GOMODCACHE="${GOMODCACHE:-/root/go/pkg/mod}"
export GOPROXY="${GOPROXY:-off}"
mkdir -p "$GOCACHE"

fail() { echo "✗ $*" >&2; exit 1; }

for app in "${APPS[@]}"; do
  src="$SERVER/demoapps/$app"
  [ -d "$src" ] || fail "没有这个演示应用：$src"
  [ -f "$src/web/index.html" ] || fail "$app 缺 web/index.html"
  [ -f "$src/web/app.css" ] || fail "$app 缺 web/app.css"
  [ -f "$src/web/app.js" ] || fail "$app 缺 web/app.js"
  [ -f "$src/picoaide.app.json" ] || fail "$app 缺 picoaide.app.json（本地预览要读它；平台侧由 demos.json 播种）"

  # 产物落在工作区的 temp/ 下（`/tmp` 在本机沙箱里不跨命令保留，跨步骤复核会踩空）。
  out_dir="$ROOT/temp/demo-build"
  mkdir -p "$out_dir"
  raw="$out_dir/$app.wasm"
  packed="$out_dir/$app-packed.wasm"

  echo "→ 编译 $app（wasm32-wasip1）"
  ( cd "$SERVER" && GOOS=wasip1 GOARCH=wasm go build -trimpath -ldflags "-s -w" -o "$raw" "./demoapps/$app" )

  echo "→ 打包前端资源 $app"
  node "$PACK" --in "$raw" --out "$packed.$$" \
    "$src/web/index.html=index.html" \
    "$src/web/app.css=static/app.css" \
    "$src/web/app.js=static/app.js"
  mv "$packed.$$" "$packed"
  echo "✓ $packed"
done

echo
echo "预览（假宿主，按平台路由规则直出 /static/*、入口 / 走 wasm）："
for app in "${APPS[@]}"; do
  echo "  node server/skills/app-builder/examples/go/preview.mjs temp/demo-build/$app-packed.wasm \\"
  echo "    --config server/demoapps/$app/picoaide.app.json --path / --user zhangwei"
done
