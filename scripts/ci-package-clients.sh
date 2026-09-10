#!/usr/bin/env bash
#
# 逐个渠道打包客户端,并把产物归到 `client-assets/<channel>/`。
#
# 渠道 CI **不输出日志**(2026-09-10 用户定案):
#   - 官方渠道(列表里的第一个)保留完整输出 —— 排障看这一份,渠道构建跑的是
#     同一套代码路径与同一套打包脚本;
#   - 其余渠道的输出全部重定向到 runner 内的日志文件(不发布),失败只报一句
#     中性信息,不回显渠道名、不回显命令输出;
#   - 每个渠道 id 都被 `::add-mask::`,任何意外的 echo 都会被 GitHub 抹掉。
#
# 用法:
#   scripts/ci-package-clients.sh --list channels.list --stage-dir client-assets \
#     --patterns '*.AppImage *.deb' -- yarn workspace dsh-plugin-desktop dist:linux --no-prebuild
#
# 环境:
#   DSH_BUILD_CHANNEL  由本脚本按渠道注入(不要外部预设)
#
# 退出码:0 全部成功;非 0 有渠道失败(渠道名不打印,只报序号)。
set -euo pipefail

LIST=""
STAGE="client-assets"
PATTERNS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --list) LIST="$2"; shift 2 ;;
    --stage-dir) STAGE="$2"; shift 2 ;;
    --patterns) PATTERNS="$2"; shift 2 ;;
    --) shift; break ;;
    *) echo "ci-package-clients: 未知参数 $1" >&2; exit 2 ;;
  esac
done

if [ -z "$LIST" ] || [ ! -f "$LIST" ]; then
  echo "::error::缺少 --list <渠道列表文件>(由 scripts/ci-channels.sh 产出)" >&2
  exit 2
fi
if [ "$#" -eq 0 ]; then
  echo "::error::缺少打包命令(-- <cmd...>)" >&2
  exit 2
fi
if [ -z "$PATTERNS" ]; then
  echo "::error::缺少 --patterns(需要从 dist/ 归集的产物通配)" >&2
  exit 2
fi

# 打包命令在仓库根执行(yarn workspace 需要根 workspace)。
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO_ROOT/packages/host/desktop/dist"
LOG_DIR="$(mktemp -d)"
trap 'rm -rf "$LOG_DIR"' EXIT

INDEX=0
TOTAL="$(grep -c . "$LIST" || true)"
while IFS= read -r channel; do
  [ -n "$channel" ] || continue
  INDEX=$((INDEX + 1))
  printf '::add-mask::%s\n' "$channel"

  # 每个渠道从干净的 dist/ 开始:上一轮的产物若残留,会被误当归集对象。
  rm -rf "$DIST"
  mkdir -p "$DIST"

  if [ "$INDEX" -eq 1 ]; then
    # 官方:完整日志(排障基准)。
    echo "packaging channel ${INDEX}/${TOTAL} (full log)"
    if ! (cd "$REPO_ROOT" && DSH_BUILD_CHANNEL="$channel" "$@"); then
      echo "::error::官方渠道打包失败(日志见上)" >&2
      exit 1
    fi
  else
    # 渠道:输出不发布。失败只报序号。
    echo "packaging channel ${INDEX}/${TOTAL} (quiet)"
    if ! (cd "$REPO_ROOT" && DSH_BUILD_CHANNEL="$channel" "$@") > "$LOG_DIR/$INDEX.log" 2>&1; then
      echo "::error::渠道 ${INDEX}/${TOTAL} 打包失败。" >&2
      echo "::error::渠道构建与官方构建走同一套代码路径与打包脚本;请用官方构建复现排障" >&2
      echo "::error::(本步骤按定策不输出渠道日志;日志仅留在 runner 临时目录,运行结束即销毁)" >&2
      exit 1
    fi
  fi

  # 归集产物到 client-assets/<channel>/;一个都没有 = 打包其实没产出,必须失败。
  # 相对路径一律相对**仓库根**(不是当前工作目录),绝对路径原样使用。
  case "$STAGE" in
    /*) stage_root="$STAGE" ;;
    *) stage_root="$REPO_ROOT/$STAGE" ;;
  esac
  target="$stage_root/$channel"
  mkdir -p "$target"
  found=0
  for pattern in $PATTERNS; do
    for file in "$DIST"/$pattern; do
      [ -f "$file" ] || continue
      cp -a "$file" "$target/"
      found=$((found + 1))
    done
  done
  if [ "$found" -eq 0 ]; then
    echo "::error::渠道 ${INDEX}/${TOTAL} 没有产出任何安装包(通配:${PATTERNS})" >&2
    exit 1
  fi
  echo "  staged ${found} artifact(s)"
done < "$LIST"

echo "client packaging done: ${TOTAL} channel(s)"
