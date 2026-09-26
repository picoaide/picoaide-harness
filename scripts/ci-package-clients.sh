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
#     --patterns '*.AppImage' --verify-app-dir dist/linux-unpacked \
#     -- yarn workspace dsh-plugin-desktop dist:linux --no-prebuild
#
# 参数:
#   --verify-app-dir <dir>  每个渠道打包后拆开 <dir>/resources/app.asar 做端到端
#                           白标校验(linux/win 的解包目录;mac 无此布局则省略)。
#                           相对路径先按 `--dist` 的父目录解析(打包产物的真实布局:
#                           `<桌面包根>/dist/<platform>-unpacked`),再按仓库根(历史语义);
#                           两种基线都解析不到即**失败**,绝不静默把该参数丢掉
#                           —— 静默丢弃会让 app.asar 那组断言看起来在跑其实没跑
#                           (2026-09-26 第二十五轮审计 Y4-02)。
#
# 环境:
#   DSH_BUILD_CHANNEL  由本脚本按渠道注入(不要外部预设)
#
# 退出码:0 全部成功;非 0 有渠道失败(渠道名不打印,只报序号)。
set -euo pipefail

LIST=""
STAGE="client-assets"
PATTERNS=""
OFFICIAL_LAST=0
SKIP_OFFICIAL=0
DIST_OVERRIDE=""
VERIFY_APP_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --list) LIST="$2"; shift 2 ;;
    --stage-dir) STAGE="$2"; shift 2 ;;
    --patterns) PATTERNS="$2"; shift 2 ;;
    --dist) DIST_OVERRIDE="$2"; shift 2 ;;
    --verify-app-dir) VERIFY_APP_DIR="$2"; shift 2 ;;
    --official-last) OFFICIAL_LAST=1; shift ;;
    --skip-official) SKIP_OFFICIAL=1; shift ;;
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
# 白标门禁脚本(可用 CI_CHANNEL_VERIFY_SCRIPT 覆盖:本地回归测试用它注入桩)。
VERIFY_SCRIPT="${CI_CHANNEL_VERIFY_SCRIPT:-packages/host/desktop/scripts/verify-channel-package.ts}"
# 产物目录(缺省 electron-builder 的标准输出;macOS 签名发布走 mac-release)。
case "$DIST_OVERRIDE" in
  "") DIST="$REPO_ROOT/packages/host/desktop/dist" ;;
  /*) DIST="$DIST_OVERRIDE" ;;
  *) DIST="$REPO_ROOT/$DIST_OVERRIDE" ;;
esac
LOG_DIR="$(mktemp -d)"
trap 'rm -rf "$LOG_DIR"' EXIT

# 读入列表(去掉空行,保持 ci-channels.sh 给的顺序)。
CHANNELS=()
while IFS= read -r line; do
  [ -n "$line" ] || continue
  CHANNELS+=("$line")
done < "$LIST"
if [ "${#CHANNELS[@]}" -eq 0 ]; then
  echo "::error::渠道列表为空(${LIST})" >&2
  exit 2
fi
# --official-last:官方**最后**构建,于是 dist/ 里留下的是官方产物 ——
# 打包后的 E2E 与人工排查都对着官方那一份(渠道产物已归集到 client-assets/)。
# --skip-official:官方由调用方的专门步骤构建(macOS 的签名/公证链有自己的重试
# 结构),本脚本只负责渠道。
if [ "$SKIP_OFFICIAL" -eq 1 ]; then
  FILTERED=()
  for channel in "${CHANNELS[@]}"; do
    [ "$channel" = "official" ] || FILTERED+=("$channel")
  done
  CHANNELS=("${FILTERED[@]}")
fi
if [ "$OFFICIAL_LAST" -eq 1 ]; then
  REORDERED=()
  for channel in "${CHANNELS[@]}"; do
    [ "$channel" = "official" ] || REORDERED+=("$channel")
  done
  for channel in "${CHANNELS[@]}"; do
    [ "$channel" = "official" ] && REORDERED+=("$channel")
  done
  CHANNELS=("${REORDERED[@]}")
fi
if [ "${#CHANNELS[@]}" -eq 0 ]; then
  echo "no channels to package (only official was selected, and it is built by the caller)"
  exit 0
fi

INDEX=0
TOTAL="${#CHANNELS[@]}"
for channel in "${CHANNELS[@]}"; do
  [ -n "$channel" ] || continue
  INDEX=$((INDEX + 1))
  printf '::add-mask::%s\n' "$channel"

  # 每个渠道从干净的 dist/ 开始:上一轮的产物若残留,会被误当归集对象。
  rm -rf "$DIST"
  mkdir -p "$DIST"

  if [ "$channel" = "official" ]; then
    # 官方是**排障基准**:保留完整日志。渠道构建跑同一套代码路径,出问题看这一份。
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

  # 白标门禁:本渠道的包必须**自带渠道配置**且图标是**按本渠道派生**的
  # (见 packages/host/desktop/scripts/verify-channel-package.ts)。官方与渠道走
  # 同一条门禁:官方构建的 build/ 里不该残留上一次渠道构建的 channel.json。
  #
  # `--verify-app-dir`(linux/win 的解包目录)**存在时**,再拆开 `resources/app.asar`
  # 做端到端确认(`verify-channel-package.ts:195-234`:包内 `build/channel.json` 的存在性、
  # 包内 `channel_id` 等于本次渠道、包内图标与 `build/` 逐字节一致、官方包不得残留渠道
  # 配置)。**这个参数绝不允许被静默丢弃**——2026-09-26 第二十五轮审计 Y4-02 实测:CI 的
  # 两处调用点写的是 `--verify-app-dir dist/linux-unpacked`,而本脚本只按**仓库根**解析成
  # `<repoRoot>/dist/linux-unpacked`(真实布局在 `packages/host/desktop/dist/…`),
  # `[ -d ]` 不成立就把参数吞掉 ⇒ 上面整组断言**在 CI 里从未执行过一次**,而文档与通过行
  # 都在宣称它生效。"门禁看起来在跑其实没跑"正是必须 fail-loud 的形态,所以:
  #   ① 相对路径两种基线都认(先 `$DIST` 的父目录=打包产物真实布局,再仓库根=历史语义);
  #   ② 解析后仍不存在 ⇒ 当场失败,绝不降级;
  #   ③ 通过行如实说明这一组断言本轮**是否**参与(见下面的 white-label gate 行)。
  verify_app=""
  if [ -n "$VERIFY_APP_DIR" ]; then
    case "$VERIFY_APP_DIR" in
      /*) verify_app="$VERIFY_APP_DIR" ;;
      *)
        if [ -d "$(dirname "$DIST")/$VERIFY_APP_DIR" ]; then
          # 打包产物的真实布局(`<桌面包根>/dist/<platform>-unpacked`);`--dist` 覆盖时
          # 同样按覆盖值的父目录解析,与缺省布局保持同一口径。
          verify_app="$(dirname "$DIST")/$VERIFY_APP_DIR"
        else
          verify_app="$REPO_ROOT/$VERIFY_APP_DIR"
        fi
        ;;
    esac
    if [ ! -d "$verify_app" ]; then
      echo "::error::--verify-app-dir 指向的目录不存在:$verify_app" >&2
      echo "::error::存在该参数时 app.asar 端到端断言是本门禁的一部分,解析不到就是门禁残缺,因此这里直接失败" >&2
      echo "::error::相对路径按 dist 的父目录(打包产物真实布局)或仓库根解析;确实没有解包目录(mac 冒烟)请省略该参数" >&2
      exit 1
    fi
  fi
  verify_args=()
  [ -n "$verify_app" ] && verify_args+=(--app-dir "$verify_app")
  if [ "$channel" = "official" ]; then
    if ! (cd "$REPO_ROOT" && DSH_BUILD_CHANNEL="$channel" \
      node "$VERIFY_SCRIPT" "${verify_args[@]+"${verify_args[@]}"}"); then
      echo "::error::官方渠道的白标门禁未通过(日志见上)" >&2
      exit 1
    fi
  elif ! (cd "$REPO_ROOT" && DSH_BUILD_CHANNEL="$channel" \
    node "$VERIFY_SCRIPT" "${verify_args[@]+"${verify_args[@]}"}") \
    > "$LOG_DIR/$INDEX.verify.log" 2>&1; then
    echo "::error::渠道 ${INDEX}/${TOTAL} 的白标门禁未通过(随包渠道配置/图标与所选渠道不自洽)。" >&2
    echo "::error::渠道构建与官方构建走同一套门禁;请用官方构建复现排障" >&2
    exit 1
  fi
  # 通过行如实说明 app.asar 断言这一轮到底跑没跑(2026-09-26 审计 Y4-02 的第③条):
  # 路径是构建布局,不含渠道身份,可以进公开日志。
  if [ -n "$verify_app" ]; then
    echo "  white-label gate: app.asar assertions included ($verify_app)"
  else
    echo "  white-label gate: app.asar assertions skipped (no --verify-app-dir; build/ 侧断言照常执行)"
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
done

echo "client packaging done: ${TOTAL} channel(s)"
