#!/usr/bin/env bash
#
# 「ref 形态 → 渠道集 / 是否发布」的**唯一真源**(2026-09-23 审计 K-04)。
#
# 为什么必须只有一处:这条规则原先被写成两份独立实现 —— `ci-channels.sh` 里的 bash
# glob 与 `ci.yml` 里 release job 的 `if:` 表达式。两者对"名字带 `-` 但后缀不认识"
# 的 tag 给出**相反**结论:前者被 `v[0-9]*.[0-9]*.[0-9]*` 前缀命中 ⇒ 构建**全部**
# 渠道(含品牌渠道);后者的兜底是 `!contains(github.ref_name, '-')` ⇒ 整个 release
# job 被跳过。于是一个 `v2.8.2-hotfix`(合法 semver,`scripts/version.mjs check`
# 也会放行)会跑满三平台构建、**一个产物也不交付**:GitHub Release 与 R2 都没有新
# 版本,客户侧零信号;同一轮里品牌渠道产物经 R2 中转前缀上传后无人取回、也无人销毁
# (销毁步骤在 release job 内部)。
#
# 现在这份判定只在这里,三处都读它:
#   1. `gate` job 的第一步 —— 形态不认识时**在 1 分钟内**红,下游 job 因 `needs: gate`
#      全部跳过 ⇒ 不会再有"构建了却不发布"的空转,也不会留下孤儿中转前缀;
#   2. `release` job 的 `if:` 只判"是不是 v 开头的 tag"(**不再**判形态);
#   3. `scripts/ci-channels.sh` 取 `channel_set` 决定本轮构建哪些渠道。
#
# 形态是**白名单**,不接受"猜":
#   vX.Y.Z                        正式版 → 全部渠道 + 发布
#   vX.Y.Z-(beta|rc|alpha)[.N…]   预发版 → 只构建 beta + 发布
#   其它 `refs/tags/v…`           **fail-loud**(退出 1):名字像发布 tag 却不认识时,
#                                 宁可让人当场改 tag 名,也不要"构建一半、发布零"
#   非 tag(分支 / PR)             只构建 official、不发布
#
# 为什么不回显 tag 名:tag 名可能带渠道/客户信息(本仓是公开仓,`gate` 的日志公开),
# 与 `ci-channels.sh` 的既有纪律一致 —— 只报"形态不认识",名字在 GITHUB_REF_NAME 里。
#
# 用法:
#   bash scripts/ci-release-policy.sh [--ref "$GITHUB_REF"] [--ref-name "$GITHUB_REF_NAME"]
#   bash scripts/ci-release-policy.sh --field channel_set        # 只打印取值
#
# 输出(缺省形态:逐行 `key=value`,可直接追加进 `$GITHUB_OUTPUT`):
#   release_kind=none|prerelease|stable
#   channel_set=official|beta|all
#   publish_release=true|false
#   looks_like_release_tag=true|false
#
# 退出码:0 解析成功;1 名字像发布 tag 但形态不认识;2 用法错误。
set -euo pipefail

REF="${GITHUB_REF:-}"
REF_NAME="${GITHUB_REF_NAME:-}"
FIELD=""

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:-}"; shift 2 ;;
    --ref-name) REF_NAME="${2:-}"; shift 2 ;;
    --field) FIELD="${2:-}"; shift 2 ;;
    *) echo "ci-release-policy: 未知参数 $1" >&2; exit 2 ;;
  esac
done

# 版本形态与 `scripts/version.mjs` 的口径对齐(它接受的 semver 就是
# `<major>.<minor>.<patch>` 或同形再带 `-<prerelease>`)。这里额外把预发标识白名单化:
# **不认识的后缀一律拒绝**,而不是"按最宽的那条 glob 当正式版"。
STABLE_RE='^v[0-9]+\.[0-9]+\.[0-9]+$'
PRERELEASE_RE='^v[0-9]+\.[0-9]+\.[0-9]+-(beta|rc|alpha)(\.[0-9A-Za-z]+)*$'

# "名字像发布 tag"(v + 数字开头):只用于两件事 ——
#   ① tag 上是未知形态时 fail-loud 的判据;
#   ② 非 tag 上给"把 tag 名当分支推了"的中性告警(既有行为,判据不变宽)。
looks_like=false
case "$REF_NAME" in
  v[0-9]*) looks_like=true ;;
esac

kind="none"
channel_set="official"
publish="false"

# **只有真正的 tag 才决定渠道集**(2026-09-12 审计 P1-1):分支名/PR 名可能长得像
# tag(甚至有 `refs/heads/v2.7.2` 这种分支),`GITHUB_REF` 的类型前缀是唯一无歧义
# 判据。缺 `GITHUB_REF`(本地直跑)按非 tag 处理:安全缺省是"只发 official"。
case "$REF" in
  refs/tags/*)
    if printf '%s' "$REF_NAME" | grep -Eq "$STABLE_RE"; then
      kind="stable"; channel_set="all"; publish="true"
    elif printf '%s' "$REF_NAME" | grep -Eq "$PRERELEASE_RE"; then
      kind="prerelease"; channel_set="beta"; publish="true"
    elif [ "$looks_like" = true ]; then
      echo "::error::发布 tag 形态不认识:名字像发布 tag(v 开头)但不匹配任何允许的形态。" >&2
      echo "::error::允许的形态只有两种:vX.Y.Z(正式版,全渠道)与 vX.Y.Z-(beta|rc|alpha)[.N](预发版,只发 beta)。" >&2
      echo "::error::未知后缀会让「构建哪些渠道」与「是否发布」给出相反结论(全渠道构建 + 零交付),因此这里直接中止。" >&2
      echo "::error::请改成允许的形态(或改打正式版 tag);名字见 GITHUB_REF_NAME(刻意不回显:tag 名可能带渠道/客户信息)。" >&2
      exit 1
    fi
    ;;
esac

emit() { printf '%s=%s\n' "$1" "$2"; }

# `--field <名>`:只打印**取值**(供 `$( … )` 直接捕获);缺省打印 `key=value`,
# 可直接追加进 `$GITHUB_OUTPUT`。
if [ -n "$FIELD" ]; then
  case "$FIELD" in
    release_kind) printf '%s\n' "$kind" ;;
    channel_set) printf '%s\n' "$channel_set" ;;
    publish_release) printf '%s\n' "$publish" ;;
    looks_like_release_tag) printf '%s\n' "$looks_like" ;;
    *) echo "ci-release-policy: 未知字段 $FIELD" >&2; exit 2 ;;
  esac
  exit 0
fi

emit release_kind "$kind"
emit channel_set "$channel_set"
emit publish_release "$publish"
emit looks_like_release_tag "$looks_like"
