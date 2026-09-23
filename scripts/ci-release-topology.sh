#!/usr/bin/env bash
#
# 发布 tag 的**拓扑判据**(2026-09-23 第五轮审计 R5-C-2 / M1)。
#
# 为什么要机器判据:2026-09-17 的真实事故 —— 上一个 tag 打在一条**旁支**上(与 master
# 是兄弟线),发版人直接从功能分支打新 tag。CI 全绿(Gate / 三平台 / Release 都过),
# 但那条旁支上的全部修复被**静默丢掉**:新版本里没有它们。全仓当时没有任何
# `merge-base --is-ancestor` / `rev-list --count` 判据,只能靠发版人"记得"核对。
#
# 两条判据(缺一不可):
#   ① 上一个"发布 tag"必须是本 tag 的祖先 —— 上一个 tag 在旁支 ⇒ 它的修复不在本版里。
#   ② 本 tag 必须在主线(origin/master)上 —— tag 打在未合并的提交上时,发布内容不
#      属于任何已评审的主线状态。
#
# "上一个发布 tag"的口径(白名单与 `scripts/ci-release-policy.sh` 同源):
#   - 只认 `vX.Y.Z` / `vX.Y.Z-(beta|rc|alpha)[.N…]`(其余历史 tag 如 `v26081402`
#     是另一条命名线,混进来会把判据变成假红);
#   - 取两个候选:「最近创建的」(creatordate 最大)与「版本序最大的」,两个都查 ——
#     前者抓"最新那条旁支"(2026-09-17 的形态),后者抓"比本版更高的那条旁支";
#   - 排除被检查的 tag 自身(支持"先本地自检、再打 tag")。
#
# 用法:
#   bash scripts/ci-release-topology.sh                          # 检查 HEAD(本地发版前自检)
#   bash scripts/ci-release-topology.sh --ref v2.8.2-beta.1       # 检查某个 tag
#   bash scripts/ci-release-topology.sh --ref HEAD --base v2.8.1  # 注入基线(单元验证用)
#   bash scripts/ci-release-topology.sh --ref HEAD --exclude-tag v2.8.2-beta.1   # CI 的用法
#   bash scripts/ci-release-topology.sh --no-mainline             # 只跑判据 ①
#   bash scripts/ci-release-topology.sh --mainline origin/main    # 换主线 ref
#
# 退出码:0 通过;1 拓扑违规;2 判据**无法执行**(缺发布 tag 历史 / 缺主线 ref / 用法错误)。
#   **2 不是通过** —— 本仓的纪律是"判据没跑成"必须如实报出来,不许伪装成绿
#   (同 `check-no-real-domains.mjs` 的 EXIT=2/3 语义)。
#
# 环境:CI 里由 gate 在 tag push 上执行;该 job 的 checkout 已是 `fetch-depth: 0`
#   (全历史 + 全 tag),判据所需的一切都在本地,不联网。
set -euo pipefail

REF="HEAD"
BASE=""
MAINLINE=""
EXCLUDE_TAG=""
USE_MAINLINE=1

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:-}"; shift 2 ;;
    --base) BASE="${2:-}"; shift 2 ;;
    --mainline) MAINLINE="${2:-}"; shift 2 ;;
    --exclude-tag) EXCLUDE_TAG="${2:-}"; shift 2 ;;
    --no-mainline) USE_MAINLINE=0; shift ;;
    *) echo "ci-release-topology: 未知参数 $1" >&2; exit 2 ;;
  esac
done

# `--ref refs/tags/vX` 与 `--ref vX` 等价(GITHUB_REF 可直接传进来)。
TARGET="${REF#refs/tags/}"
TARGET_TAG=""
case "$REF" in
  refs/tags/*) TARGET_TAG="$TARGET" ;;
esac
# 本地自检常见写法是直接给 tag 名 ⇒ 只要检出里真有这个 tag,就把它从基线候选里排除。
if git rev-parse --verify --quiet "refs/tags/${TARGET}" >/dev/null 2>&1; then
  TARGET_TAG="$TARGET"
fi
# CI 的调用形态是 `--ref HEAD --exclude-tag "$GITHUB_REF_NAME"`:tag push 的检出是
# detached HEAD,本地不一定存在同名 tag ref ⇒ 这里显式指定要排除的名字。
if [ -n "$EXCLUDE_TAG" ]; then
  TARGET_TAG="$EXCLUDE_TAG"
fi

if ! TARGET_SHA="$(git rev-parse --verify --quiet "${TARGET}^{commit}")"; then
  echo "::error::拓扑判据无法执行:解析不出提交 ${TARGET}(检出里没有它?)—— 判据未完成不等于通过。" >&2
  exit 2
fi
TARGET_SHORT="$(git rev-parse --short "${TARGET_SHA}")"

# 发布 tag 白名单(与 ci-release-policy.sh 的 STABLE_RE / PRERELEASE_RE 同形)。
RELEASE_TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+(-(beta|rc|alpha)(\.[0-9A-Za-z]+)*)?$'

release_tags() {
  git for-each-ref --sort="$1" --format='%(refname:short)' refs/tags/ 2>/dev/null \
    | grep -E "$RELEASE_TAG_RE" || true
}
drop_target() {
  if [ -n "$TARGET_TAG" ]; then grep -vx -- "$TARGET_TAG" || true; else cat; fi
}

CANDIDATES=()
if [ -n "$BASE" ]; then
  CANDIDATES+=("$BASE")
else
  NEWEST="$(release_tags -creatordate | drop_target | head -n 1 || true)"
  HIGHEST="$(release_tags '-v:refname' | drop_target | head -n 1 || true)"
  [ -n "$NEWEST" ] && CANDIDATES+=("$NEWEST")
  if [ -n "$HIGHEST" ] && [ "$HIGHEST" != "$NEWEST" ]; then
    CANDIDATES+=("$HIGHEST")
  fi
fi

if [ "${#CANDIDATES[@]}" -eq 0 ]; then
  echo "::error::拓扑判据无法执行:检出里找不到任何发布 tag(vX.Y.Z / vX.Y.Z-<beta|rc|alpha>)。" >&2
  echo "::error::浅克隆 / 未取 tag 的检出上,这条判据不成立 —— 它不等于通过。" >&2
  echo "::error::处置:CI 用 fetch-depth: 0;本地先 git fetch origin --tags;确实要在无历史 tag 的仓库里跑,用 --base <ref> 显式指定基线。" >&2
  exit 2
fi

status=0

# ---- 判据 ①:上一个发布 tag 必须是本 tag 的祖先 ----
for base in "${CANDIDATES[@]}"; do
  if ! BASE_SHA="$(git rev-parse --verify --quiet "${base}^{commit}")"; then
    echo "::error::拓扑判据无法执行:解析不出基线 ${base} 的提交(检出里没有它?)。" >&2
    exit 2
  fi
  if git merge-base --is-ancestor "$BASE_SHA" "$TARGET_SHA"; then
    continue
  fi
  status=1
  echo "::error::发布 tag 拓扑违规:上一个发布 tag ${base} **不是** ${TARGET} 的祖先 ⇒ 它的修复不在本版里(2026-09-17 同形事故)。" >&2
  echo "::error::  基线 ${base} = $(git rev-parse --short "$BASE_SHA") $(git log -1 --format=%s "$BASE_SHA")" >&2
  echo "::error::  本版 ${TARGET} = ${TARGET_SHORT} $(git log -1 --format=%s "$TARGET_SHA")" >&2
  echo "::error::  差距:${base}..${TARGET} = $(git rev-list --count "${BASE_SHA}..${TARGET_SHA}") 个提交;${TARGET}..${base} = $(git rev-list --count "${TARGET_SHA}..${BASE_SHA}") 个提交(两侧都非零 = 旁支)" >&2
  echo "::error::处置:先把 ${base} 合并进主线(或把本 tag 挪到已包含它的提交上),跑全量门禁后再打 tag。" >&2
done

# ---- 判据 ②:本 tag 必须在主线上 ----
if [ "$USE_MAINLINE" -eq 1 ]; then
  if [ -z "$MAINLINE" ]; then
    for candidate in origin/master origin/main; do
      if git rev-parse --verify --quiet "refs/remotes/${candidate}" >/dev/null 2>&1; then
        MAINLINE="$candidate"
        break
      fi
    done
  fi
  if [ -z "${MAINLINE:-}" ]; then
    echo "::error::拓扑判据无法执行:解析不到主线 ref(先试 origin/master、origin/main 都没有)。" >&2
    echo "::error::处置:git fetch origin master:refs/remotes/origin/master 后重跑;或 --mainline <ref> 指定;确实只跑祖先判据用 --no-mainline。" >&2
    exit 2
  fi
  # 显式传入的 `--mainline` 同样要能解析 —— 否则 `git merge-base` 会以 128 退出,
  # 把"判据没跑成"伪装成别的失败形态。
  if ! git rev-parse --verify --quiet "${MAINLINE}^{commit}" >/dev/null 2>&1; then
    echo "::error::拓扑判据无法执行:解析不出主线 ref ${MAINLINE}(检出里没有它?)。" >&2
    echo "::error::处置:git fetch origin master:refs/remotes/origin/master 后重跑,或改用 --no-mainline。" >&2
    exit 2
  fi
  if git merge-base --is-ancestor "$TARGET_SHA" "$MAINLINE"; then
    MAINLINE_NOTE="; 且在主线 ${MAINLINE} 上"
  else
    status=1
    MAINLINE_NOTE=""
    echo "::error::发布 tag 拓扑违规:${TARGET} **不在主线 ${MAINLINE} 上** ⇒ 发布内容不属于任何已评审的主线状态。" >&2
    echo "::error::  本版 ${TARGET} = ${TARGET_SHORT} $(git log -1 --format=%s "$TARGET_SHA")" >&2
    echo "::error::  主线 ${MAINLINE} = $(git rev-parse --short "$MAINLINE") $(git log -1 --format=%s "$MAINLINE")" >&2
    echo "::error::  差距:${TARGET}..${MAINLINE} = $(git rev-list --count "${TARGET_SHA}..${MAINLINE}") 个提交;${MAINLINE}..${TARGET} = $(git rev-list --count "${MAINLINE}..${TARGET_SHA}") 个提交(后者非零 = tag 打在未合并的提交上)" >&2
    echo "::error::处置:先把发布提交合并到主线(本仓流程:版本与说明走 PR → 合并 → 在合并提交上打 tag),再重打 tag。" >&2
  fi
fi

if [ "$status" -eq 0 ]; then
  printf 'release-topology: OK — 基线 %s 是 %s 的祖先%s\n' "${CANDIDATES[*]}" "$TARGET" "${MAINLINE_NOTE:-}"
fi
exit "$status"
