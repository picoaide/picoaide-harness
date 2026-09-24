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
#   CHANNELS_REPO_SSH_KEY="$(cat key)" scripts/ci-channels.sh [--dest channels] [--list channels.list]
#   CHANNELS_REPO_TOKEN=... scripts/ci-channels.sh [--dest channels] [--list channels.list]
#   CHANNELS_REPO_TOKEN=... scripts/ci-channels.sh --resolve-only      # 只解析 revision
#   CHANNELS_REPO_TOKEN=... scripts/ci-channels.sh --pin <sha> […]     # 按 pin 取
#
# 环境:
#   CHANNELS_REPO_SSH_KEY 读私有渠道仓的**只读 deploy key 私钥**（推荐：不过期、只对那一个仓；
#                         给了它就忽略 CHANNELS_REPO_TOKEN）
#   CHANNELS_REPO_TOKEN   读私有渠道仓的令牌(细粒度 PAT,Contents:Read 即可;兼容形态,会过期)
#   GITHUB_REF            GitHub 注入的完整 ref(`refs/tags/…` / `refs/heads/…` /
#                         `refs/pull/…`);**只有 `refs/tags/` 前缀才算 tag**,也是
#                         `ci-release-policy.sh` 判形态与渠道集的唯一依据
#   GITHUB_REF_NAME       tag 名(交给 ci-release-policy.sh 判定;形态不认识即中止)
#   CI_CHANNELS_SOURCE    已有检出目录(本地测试用;给了就跳过克隆)
#   CI_CHANNELS_REPO      渠道仓 slug(缺省 picoaide/channels)
#   CI_CHANNELS_PIN       渠道仓 commit SHA(40 位小写 hex)。**发布 tag 上必填**:
#                         gate 里 `ci-channels.sh --resolve-only` 解析一次,四处调用点
#                         共用同一个值 ⇒ 同一次 tag 的"包内客户端"与"镜像内渠道内容"
#                         必然同源;此前是四个 job 各自 clone origin/main HEAD,时间差
#                         数十分钟,中途任何 push 都会让两者不同源(且同一 tag 不可复现)
#   CI_CHANNELS_URL       覆盖克隆 URL(本地测试/自建镜像用;缺省带只读令牌的 GitHub URL)
#   channels.manifest.json 渠道仓**根目录**下的可选清单(私有仓自己声明"本仓应有哪些渠道",
#                         形状见下面"应有渠道集"一节) —— 它留在私有仓,公开仓零身份泄露
#
# 启动时会往 stderr 打一行 `channels credential form: url|ssh|token|source|none`
# (只报形态,不回显任何凭据内容):本次到底选了哪种凭据是排障的第一个问题,而它此前
# 没有任何出口(2026-09-24 第八轮审计 R8-D-11 现场:`CI_CHANNELS_URL=" "` 被判"已设置"、
# 可用的 deploy key 从未被尝试,日志里查不到)。
#
# 退出码:0 成功;非 0 失败(渠道仓不可读/结构不符/必需的渠道缺失/pin 校验失败/渠道集小于下限)。
set -euo pipefail

# git/ssh 的报错文本随 locale 变(本机 zh_CN 下 git 打的是「致命错误：无法访问 …」),
# 而失败分类按英文片段匹配 ⇒ 在非英文 runner 上**整条分类静默失效**(2026-09-24 第八轮
# 审计 R8-D-10 实测:汉字输出 → 症状未分类)。这里钉死 C locale:本脚本自己的输出全是写死的
# 中文,不受影响;外部命令(git/ssh)一律英文 ⇒ 词表只维护一套,也不再有语言依赖。
export LC_ALL=C

DEST="channels"
LIST="channels.list"
RESOLVE_ONLY=0
PIN="${CI_CHANNELS_PIN:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="$2"; shift 2 ;;
    --list) LIST="$2"; shift 2 ;;
    --pin) PIN="${2:-}"; shift 2 ;;
    --resolve-only) RESOLVE_ONLY=1; shift ;;
    *) echo "ci-channels: 未知参数 $1" >&2; exit 2 ;;
  esac
done

# pin 值**不做任何归一化**（2026-09-24 补轮 / V3-B P3 定案）：换行/回车一律由
# `require_pin_shape` 在**原始值**上 fail-loud（那里的注释写了为什么"先归一化再判形状"是错的）。
# 老写法是 `PIN="$(printf '%s' "$PIN" | tr -d '\r\n')"`：它把 `<39hex>\n0` 这类多行值
# 悄悄拼成恰好 40 位 hex ⇒ 判据被归一化绕过、值被静默接受（V3-B 实测）。
# 生产链的 pin 不带换行：它经 GitHub job output（`${{ needs.gate.outputs.channels_rev }}`，
# 平台会去掉尾随换行）或 `--pin <sha>` 传入。

REPO="${CI_CHANNELS_REPO:-picoaide/channels}"
# 原始名字留着只用于告警(见下);**渠道集判定不在这里**,交给唯一真源
# `scripts/ci-release-policy.sh`(它自己按 `GITHUB_REF` 的类型前缀判是不是 tag)。
RAW_REF_NAME="${GITHUB_REF_NAME:-}"
IS_TAG=0
case "${GITHUB_REF:-}" in
  refs/tags/*) IS_TAG=1 ;;
esac

# **只有真正的 tag 才决定渠道集**(2026-09-12 审计 P1-1)。
#
# 为什么不能只看 `GITHUB_REF_NAME` 的名字形状:分支 push 上它等于**分支名**,而
# 一个叫 `v2.7.2` 的分支会被"像 tag 就当正式版"的判据当成正式 tag ⇒ 选中**全部**
# 渠道(含品牌渠道);同一轮里把品牌产物搬出 `client-assets/` 的 transfer 步骤带
# `startsWith(github.ref,'refs/tags/v')` 守卫、分支上被跳过 ⇒ 客户品牌安装包进了一个
# **匿名可读**的公开 artifact。
#
# `GITHUB_REF` 由 GitHub 注入且带类型前缀,是唯一无歧义的判据;非 tag(分支/PR)
# 只发 official。缺 `GITHUB_REF`(本地直跑)按**非 tag** 处理:安全缺省是"只发
# official",绝不能因为名字像 tag 就把品牌渠道发出去。
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

# 去空白判空（2026-09-24 第八轮审计 R8-D-11）：`[ -n "${X:-}" ]` 把**纯空白**当成"已设置"。
# 现场形态是 `CI_CHANNELS_URL=" "`（secret 被写空、workflow 传了个空格）⇒ 脚本拿空白 URL 去跑
# git、**可用的 deploy key 从未被尝试**，而日志里既没有"本次选了哪种凭据"也没有任何线索。
# 只有空串（`CI_CHANNELS_URL=`）会正确回落 —— 补齐"纯空白 = 未设置"这一格。
non_blank() { [ -n "${1//[[:space:]]/}" ]; }

# 克隆 URL 与凭据（三选一，优先级从高到低）：
#   1. `CI_CHANNELS_URL`（本地测试/自建镜像，自带凭据）；
#   2. **SSH deploy key**（`CHANNELS_REPO_SSH_KEY`，2026-09-24 起支持）—— 组织内私有仓
#      读取的推荐形态：只读、只对那一个仓、**不会过期**（PAT 会过期，本次事故就是
#      单个人的细粒度 PAT 失效导致 tag 流水线在第一步静默失败）；
#   3. `CHANNELS_REPO_TOKEN`（HTTPS + x-access-token，历史形态，保留兼容）。
channels_url() {
  if non_blank "${CI_CHANNELS_URL:-}"; then
    printf '%s' "$CI_CHANNELS_URL"
    return 0
  fi
  if non_blank "${CHANNELS_REPO_SSH_KEY:-}"; then
    printf 'git@github.com:%s.git' "$REPO"
    return 0
  fi
  printf 'https://x-access-token:%s@github.com/%s.git' "${CHANNELS_REPO_TOKEN:-}" "$REPO"
}

# 本次选的是哪种凭据形态（url / ssh / token / source / none）—— **判定与使用必须同源**：
# `channels_url()`、缺凭据报错、启动日志三处都调它（本仓已有教训：判定键≠记账键会让闸门
# 静默失效）。只输出形态名字，**不含任何凭据内容**。
credential_form() {
  if [ -n "$SOURCE" ]; then printf 'source'; return 0; fi
  if non_blank "${CI_CHANNELS_URL:-}"; then printf 'url'; return 0; fi
  if non_blank "${CHANNELS_REPO_SSH_KEY:-}"; then printf 'ssh'; return 0; fi
  if non_blank "${CHANNELS_REPO_TOKEN:-}"; then printf 'token'; return 0; fi
  printf 'none'
}

# ---- 临时资源:集中登记 + **唯一**一处 EXIT trap -----------------------------
#
# 为什么必须是同一处（2026-09-24 第七轮审计 R7-D P3-5）：此前 SSH 准备与克隆路径**各设一次**
# `trap … EXIT`，而一个 shell 只有一个 EXIT trap —— 后者会**替换**前者。今天没出事只是因为
# 克隆路径的 trap 顺手把 `CHANNELS_SSH_DIR` 也带上了；那是巧合式的正确：任一处将来新增临时
# 资源（私钥、凭据文件、stderr 捕获文件）而忘了同步另一处，它就会滞留在 runner 上。
# 现在所有临时路径都进 TEMP_PATHS，清理只在这一处注册。
TEMP_PATHS=()
cleanup_temp_paths() {
  local path
  for path in "${TEMP_PATHS[@]:-}"; do
    [ -n "$path" ] || continue
    rm -rf "$path"
  done
  TEMP_PATHS=()
}
trap cleanup_temp_paths EXIT

# 注意 `NEW_TEMP` 这个**出参全局变量**的形状：写成 `X="$(new_temp_dir)"` 时函数在**子 shell**
# 里执行，`TEMP_PATHS+=` 跟着丢在子 shell（登记表恒空 ⇒ 清理什么都不删、私钥留在 runner 上；
# 第一版就这么错过一次，被"跑完 TMPDIR 必须为空"的用例抓住）。所以函数只写全局变量，
# 调用点写成 `new_temp_dir; X="$NEW_TEMP"`。
NEW_TEMP=""
new_temp_dir() {
  NEW_TEMP="$(mktemp -d)"
  TEMP_PATHS+=("$NEW_TEMP")
}

new_temp_file() {
  NEW_TEMP="$(mktemp)"
  TEMP_PATHS+=("$NEW_TEMP")
}

# 脱敏:URL 里的 userinfo（令牌 / 用户名）整段替换后再进日志。
#
# 为什么按 scheme 锚定、并**贪婪到最后一个 `@`**（2026-09-24 第七轮审计 R7-D P3-2）：
# 老写法只认 `x-access-token:` 字面形态、且 `[^@]*` 到**第一个** `@` 就停；而 git 自己的
# 匿名化在令牌含 `@` 时也只剥到第一个 `@`（实测报错文本里回显 `https://PART2@github.com/…`）
# ⇒ 该形态的尾部会原样进公开日志。现在覆盖 `https://<任意 userinfo>@host` 全形态。
#
# **字符集里绝不能再出现 `/`**（2026-09-24 第八轮审计 R8-D-9，已 REPRODUCED）：老字面是
# `[^/[:space:]]*`，而基本认证的密码**允许含 `/`** ⇒ `http://user:pa/ssWORD@host/x.git`
# 只擦到 `pa` 就停、`/ssWORD` 原样进了公开 Actions 日志（实测完整密码回显），而同一份日志
# 还在宣称「已脱敏；token 不会回显」——**假声明比不声明更糟**（排查者因此不会去查）。
# 现在按"从 scheme 起到本行最后一个 `@`"整段替换：userinfo 里的 `/`、`@`、标点都能吃掉。
# 代价是**可能过度脱敏**（同一行里 URL 之后若还有别的 `@` 也会被一起吃掉）—— 这是刻意选的：
# 公开仓里"少一段诊断文本"远好于"多一段凭据"。
redact_secrets() {
  sed -E \
    -e 's#(https?://)[^[:space:]]*@#\1<redacted>@#g' \
    -e 's#(x-access-token:)[^@[:space:]]*#\1<redacted>#g'
}

# openssh 在 `StrictHostKeyChecking=accept-new` + **首次连接**时必然往 stderr 打这一行
# （`prepare_channels_ssh` 每次都新建空的 known_hosts ⇒ 每次都是首次连接）。它是 TOFU 的
# 正常副作用、不是故障 ⇒ 失败诊断里按"信息"滤掉；其余 stderr **原文**照旧打进日志。
TOFU_NOISE_PATTERN="^Warning: Permanently added .* to the list of known hosts\.?$"

# ---- git 失败的**唯一**诊断出口:先捕获 → 脱敏 → 滤 TOFU 噪声 → 分类 ----------
#
# 为什么必须收成一个函数（2026-09-24 第八轮审计 R8-D-9 / D-10）：
#   - 脱敏与分类此前只加在 `--resolve-only`（gate 的第一步）上，而**生产**调用点
#     （ci.yml 里四个 job）走的是 clone 路径 ⇒ 同一条凭据在 clone/fetch 失败时**原文**
#     进 job log（实测 `mirroruser:pa/ssWORD` 完整回显，连脱敏函数都没调过）；
#   - 分类词表只认英文片段，而 git/ssh 的文案随 locale 变 ⇒ 本脚本已在上方钉 `LC_ALL=C`，
#     词表这里补齐传输失败的常见形态（`Network is unreachable` / `Connection refused` /
#     `kex_exchange_identification` / `ssh_exchange_identification` …），并把 4xx
#     （权限不足/仓不可见）单列一类 —— 它的处置是"换凭据/确认仓名"，不是"重试"
#     （R8-D-8：`unable to access` 会把 403/404 一并吞进网络臂、给出相反的建议）。
# 新增 git 调用点时**不要再裸调**：捕获 stderr 到临时文件,失败时调本函数。
report_git_failure() {
  local context="$1" errfile="$2"
  local errtext errlines noise
  # `tr -d '\r'`：真 ssh 的告警/错误是 **CRLF** 结尾（本机实测 od 可见 `hosts.\r\n`），
  # 不归一化的话 `^…$` 形状的过滤与判断都会静默失配（第一版就这么漏过）。
  errtext="$(redact_secrets < "$errfile" | tr -d '\r')"
  errlines="$(printf '%s\n' "$errtext" | grep -Ev "$TOFU_NOISE_PATTERN" || true)"
  noise="$(printf '%s\n' "$errtext" | grep -Ec "$TOFU_NOISE_PATTERN" || true)"
  echo "::error::${context}" >&2
  if [ -n "$errlines" ]; then
    printf '%s\n' "$errlines" | sed 's/^/  /' >&2
  else
    echo "  (git 没有输出可诊断的 stderr)" >&2
  fi
  if [ "${noise:-0}" -gt 0 ]; then
    echo "::notice::另已滤除 ${noise} 行 ssh 主机键 TOFU 告警（accept-new 首次连接的正常副作用,不是故障）" >&2
  fi
  case "$errlines" in
    *"Invalid username or token"*|*"鉴权失败"*|*"Authentication failed"*|*"could not read Username"*|*"Permission denied (publickey)"*)
      echo "::error::症状=凭据被拒 ⇒ 渠道仓凭据（CHANNELS_REPO_SSH_KEY 的 deploy key 是否仍在该仓 / CHANNELS_REPO_TOKEN 是否失效或权限不含 Contents:Read）——凭据值不回显；更新 secret 后重跑本 job" >&2
      ;;
    # 4xx 必须在网络臂**之前**（`unable to access` 是这些行共同的前缀，会先把它们吃掉）。
    *"The requested URL returned error: 403"*|*"The requested URL returned error: 404"*|*"error: 403"*|*"error: 404"*|*"Repository not found"*)
      echo "::error::症状=凭据权限不足或仓库不可见（HTTP 403/404）⇒ 核对渠道仓凭据是否仍属于该仓且含 Contents:Read、CHANNELS_REPO 指向的仓名是否正确（值不回显）；这一类的处置是换凭据/确认仓名,不是重试" >&2
      ;;
    # URL 本身不合法（典型：`CI_CHANNELS_URL` 里的凭据含未转义字符，如基本认证密码里的 `/`
    # —— 那会让 host/port 解析错位）。它同样带 `unable to access` 前缀，必须在网络臂之前判，
    # 否则会给出"重试"这种与真因无关的建议（2026-09-24 第八轮审计 R8-D-9 现场的形态）。
    *"URL rejected"*)
      echo "::error::症状=克隆 URL 形态非法 ⇒ 检查 CI_CHANNELS_URL 是否含需要百分号转义的字符（凭据里的 / 等；值不回显）；改用 deploy key（CHANNELS_REPO_SSH_KEY）可绕开 URL 转义问题" >&2
      ;;
    *"Could not resolve host"*|*"Connection timed out"*|*"Operation timed out"*|*"unable to access"*|*"The requested URL returned error: 5"*|*"Network is unreachable"*|*"Connection refused"*|*"Connection reset by peer"*|*"Could not connect to server"*|*"Failed to connect to"*|*"Connection closed by remote host"*|*"kex_exchange_identification"*|*"ssh_exchange_identification"*)
      echo "::error::症状=网络不可达/服务端 5xx ⇒ 先重跑本 job；持续失败再查 runner 出网与 GitHub 状态" >&2
      ;;
    *"Host key verification failed"*|*"REMOTE HOST IDENTIFICATION HAS CHANGED"*)
      echo "::error::症状=SSH 主机键校验失败 ⇒ 清理 runner 的 known_hosts 或检查 GIT_SSH_COMMAND（本脚本用临时 known_hosts + accept-new）" >&2
      ;;
    *)
      echo "::error::症状未分类 ⇒ 看上面的原始 stderr（已脱敏；凭据不会回显）" >&2
      ;;
  esac
}

# 把 deploy key 落成 600 的临时文件并装好 `GIT_SSH_COMMAND`（只在给了 key 时生效）。
# `IdentitiesOnly=yes` 防止 runner 上别的 key 抢先；`accept-new` 是 TOFU（首次记录
# github.com 的主机键），known_hosts 也落在临时目录里，不污染 runner 的 HOME。
CHANNELS_SSH_DIR=""
prepare_channels_ssh() {
  non_blank "${CHANNELS_REPO_SSH_KEY:-}" || return 0
  new_temp_dir; CHANNELS_SSH_DIR="$NEW_TEMP"
  chmod 700 "$CHANNELS_SSH_DIR"
  local key="$CHANNELS_SSH_DIR/id_ed25519"
  # 值形态归一化：`gh secret set < file` 会带结尾换行，Windows 复制粘贴 / `gh secret set
  # --body` 还可能带 CRLF。老写法只剥**一个**结尾 LF，留下 `\r` 会写出损坏的私钥、并且
  # 报错只落到"症状未分类"（2026-09-24 第七轮审计 R7-D P3-3）。现在先统一去掉 `\r`，
  # 再由命令替换吃掉全部结尾换行、补一个 `\n`。
  #
  # **落盘前先收 umask**（2026-09-24 第八轮审计 R8-D-12，已 REPRODUCED）：裸 `> "$key"`
  # 重定向按进程 umask(022) **创建**文件 ⇒ 私钥在 `chmod 600` 之前的那一瞬间是 0644
  # （fake chmod 实测 `premode=644`）。目录虽是 700、那只是兜底；私钥文件本身不允许有任何
  # 组/其他可读窗口（runner 上别的进程、日志采集、崩溃转储都在这个窗口里）。`umask 077`
  # 让文件**创建时**就是 600；后面的 `chmod 600` 保留为显式声明（门禁会同时钉住
  # "chmod 必须在写之后"与"chmod 之前不得是宽 mode"两条）。
  ( umask 077
    printf '%s\n' "$(printf '%s' "${CHANNELS_REPO_SSH_KEY}" | tr -d '\r')" > "$key" )
  chmod 600 "$key"
  export GIT_SSH_COMMAND="ssh -i $key -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$CHANNELS_SSH_DIR/known_hosts"
}
prepare_channels_ssh

# 本次用的是哪种凭据形态：只有形态名,没有凭据内容。放在这里是因为**任何**失败诊断
# 的第一个问题都是"脚本到底选了哪种凭据",而此前它没有任何出口（R8-D-11）。
echo "channels credential form: $(credential_form)" >&2

# pin 形状校验:只接受 40 位小写 hex(解析方给的就是 `git ls-remote` 的原样输出)。
# 失败信息**不回显收到的值**(它可能来自被污染的 workflow 变量)。
require_pin_shape() {
  local value="$1"
  # ① **先拒换行/回车，再谈形状**（2026-09-24 补轮 / V3-B P3，已 REPRODUCED）。
  #
  # 为什么顺序不能反：老写法先 `tr -d '\r\n'` 再判整值，于是 `<39hex>\n0`（以及任何
  # "归一化后恰好凑成 40 位 hex"的多行值）会被**静默接受**并继续走 git —— 判据被归一化绕过。
  # 现在在**原始值**上判：含 `\n` 或 `\r` 一律 fail-loud，且**文案与"形状非法"分开** ——
  # 两者的处置完全不同：换行 ⇒ 去掉 secret/job output 里的换行；形状 ⇒ 值本身取错了。
  # 生产链不产生换行（pin 经 GitHub job output 或 `--pin <sha>`），所以这条只对手工塞值发声。
  case "$value" in
    *$'\n'*|*$'\r'*)
      echo "::error::渠道仓 pin 含换行/回车（不是 40 位十六进制 commit SHA 的合法形态）—— 常见来源：secret 值里带了换行、或把文件内容整段塞进了 secret/job output。请去掉换行后重跑(值不回显)" >&2
      exit 1
      ;;
  esac
  # ② **整值**锚定（2026-09-24 第八轮审计 R8-D-13）：老字面 `grep -Eq '^[0-9a-f]{40}$'` 是
  # **按行**匹配 —— `<40hex>\nEVIL=1` 第一行就命中、照样过闸门，直到后面"渠道仓里没有 pin 的
  # commit"才失败（报错指向"pin 不存在"而**不是**"pin 非法"，排查被带偏）。注意 `grep -x`
  # **也锚不住整个值**（它只锚定"行"，实测 `printf '%s' "<40hex>\nEVIL=1" | grep -Eqx
  # '[0-9a-f]{40}'` 仍 EXIT=0），所以除了上面的换行拒绝，这里再显式要求单行 —— 纵深防御，
  # 也覆盖 `REV` 这类从 stdout 解析出来的调用点。
  if [ "$(printf '%s' "$value" | wc -l | tr -d ' ')" -ne 0 ] \
    || ! printf '%s' "$value" | grep -Eqx '[0-9a-f]{40}'; then
    echo "::error::渠道仓 pin 形状非法:必须是 40 位小写十六进制 commit SHA(值不回显)" >&2
    exit 1
  fi
}

# `--resolve-only`:只解析"这次要用的渠道仓 revision"并打印 `channels_rev=<sha>`。
# 供 gate 一次性解析、四处调用点共用(2026-09-23 第五轮审计 R5-C-2)。stdout 只放
# 那一行(`>> "$GITHUB_OUTPUT"` 直接消费),说明性文字一律走 stderr。
if [ "$RESOLVE_ONLY" -eq 1 ]; then
  if [ "$(credential_form)" = "none" ]; then
    echo "::error::缺少读渠道仓的凭据（CHANNELS_REPO_TOKEN 或 CHANNELS_REPO_SSH_KEY）—— 无法读取私有渠道仓 ${REPO}" >&2
    echo "::error::推荐形态是只读 SSH deploy key（secret CHANNELS_REPO_SSH_KEY，不过期、只对那一个仓）；" >&2
    echo "::error::兼容形态是细粒度 PAT（secret CHANNELS_REPO_TOKEN，需该仓 Contents:Read，会过期）" >&2
    exit 1
  fi
  # **失败不能沉默**（2026-09-23 现场）：secret 里的 token 失效时 `git ls-remote` 返回 128，
  # 而 `set -e` 会在赋值处直接终止脚本；旧写法还把 stderr 丢进 `/dev/null` ⇒ CI 日志里
  # 只剩一行 "exit code 128"，完全指不到病根（本次就是靠本机复现无效 token 的**同一返回码**
  # 才反推出是凭据问题）。现在把 git 的 stderr 捕下来、**脱敏后**打进日志，并按症状分类：
  # 凭据被拒 / 权限不足(4xx) / 网络不可达 / 主机键 / 未分类，各自给可行动的处置
  # （诊断与分类的唯一实现是 `report_git_failure`，三条 git 路径共用）。
  #
  # **stdout 与 stderr 必须分流**（2026-09-24 第七轮审计 R7-D P1-1）：revision **只从 stdout 取**
  # （`git ls-remote` 的 SHA 在 stdout），stderr 单独落文件、**只**用于失败诊断。旧写法
  # `REMOTE_OUT="$(… 2>&1)"` 把 git 的 stderr 并进被 `awk 'NR==1'` 解析的那条流，而 SSH
  # deploy key 形态（推荐形态）下 stderr **必然**有一行 openssh 的
  # `Warning: Permanently added 'github.com' …`（`prepare_channels_ssh` 每次新建空 known_hosts
  # + `accept-new` ⇒ 每次都是首次连接）⇒ `REV=Warning:` ⇒ `require_pin_shape` 判红并打印
  # 「pin 形状非法」—— 报错指向 pin，与真因（stderr 混进了被解析的流）毫无关系，且这一步是
  # 发布 tag 的 gate 第一步 ⇒ 三平台与 release 全部因 needs 跳过 ⇒ 零交付。
  new_temp_file; ERRFILE="$NEW_TEMP"
  if ! OUT="$(git ls-remote --quiet "$(channels_url)" HEAD 2>"$ERRFILE")"; then
    report_git_failure "读取私有渠道仓失败（git ls-remote 非零退出）：${REPO}" "$ERRFILE"
    exit 1
  fi
  # 只取 stdout 的第一列（SHA）；`tr -d '\r'` 与 pin 值同一归一化口径（CRLF 形态的 stdout
  # 会让 40-hex 形状判据失败，报成"pin 形状非法"而与真因无关）。
  REV="$(printf '%s\n' "$OUT" | awk 'NR==1 {print $1}' | tr -d '\r')"
  if [ -z "$REV" ]; then
    echo "::error::渠道仓返回空 revision（HEAD 不存在？）：${REPO}" >&2
    exit 1
  fi
  require_pin_shape "$REV"
  printf 'channels_rev=%s\n' "$REV"
  echo "channel packages revision resolved" >&2
  exit 0
fi

CHECKOUT_ROOT=""
# 内容来源：远端取源（clone / pin —— **生产链的形态**）还是本地检出（CI_CHANNELS_SOURCE）。
# 它决定"渠道目录数下限 / 静默缩小"这条判据适不适用（理由见 MIN_EXPECTED_CHANNELS 那段）。
CHANNELS_FROM_REMOTE=0
if [ -n "$SOURCE" ]; then
  CHECKOUT_ROOT="$SOURCE"
  stage_from "$SOURCE"
else
  if [ "$(credential_form)" = "none" ]; then
    echo "::error::缺少读渠道仓的凭据（CHANNELS_REPO_TOKEN 或 CHANNELS_REPO_SSH_KEY）—— 无法读取私有渠道仓 ${REPO}" >&2
    echo "::error::推荐形态是只读 SSH deploy key（secret CHANNELS_REPO_SSH_KEY，不过期、只对那一个仓）；" >&2
    echo "::error::兼容形态是细粒度 PAT（secret CHANNELS_REPO_TOKEN，需该仓 Contents:Read，会过期）" >&2
    exit 1
  fi
  # **发布 tag 上必须 pin**(2026-09-23 第五轮审计 R5-C-2):pin 由 gate 的
  # `--resolve-only` 解析一次,四个调用点(三平台 job + release job)共用 ⇒ 同一次 tag
  # 的包内客户端与镜像内渠道内容同源、同一源码 tag 可复现。缺 pin 时**不能静默退回**
  # "各自 clone origin/main HEAD"—— 那正是被审计的形态(四处克隆相差数十分钟)。
  case "${GITHUB_REF:-}" in
    refs/tags/v*)
      if [ -z "$PIN" ]; then
        echo "::error::发布 tag 构建缺少渠道仓 pin:必须由 gate 的 \`ci-channels.sh --resolve-only\` 解析一次并经 CI_CHANNELS_PIN 传给每个调用点" >&2
        echo "::error::(缺 pin 时四处调用点会各自取 origin/main HEAD ⇒ 同一次发布的包内客户端与镜像内渠道内容可能不同源,且同一 tag 不可复现)" >&2
        exit 1
      fi
      ;;
  esac
  # 取到临时目录再就位:直接 clone 到非空的 channels/ 会失败,而失败后残留的
  # 上一轮内容会让后续步骤照常跑完 —— 那正是"静默发错镜像"的来源。
  # 取失败即中止,不留可被误用的半成品。
  # 临时目录走统一登记（清理只在本文件顶部那一处 EXIT trap 里做 —— 这里**不再**重设 trap）。
  new_temp_dir; CLONE="$NEW_TEMP"
  rm -rf "$DEST" 2>/dev/null || true
  if [ -n "$PIN" ]; then
    require_pin_shape "$PIN"
    git init --quiet "$CLONE"
    git -C "$CLONE" remote add origin "$(channels_url)"
    # 先按 SHA 取(depth 1,只要一个提交);服务端不允许请求未 advertise 的对象时
    # 退回全量 fetch(二者都失败即中止)。
    #
    # **两次 fetch 的 stderr 都必须捕获**（2026-09-24 第八轮审计 R8-D-9）：pin 路径此前
    # 只有第一条带 `2>/dev/null`，而第二条（回退的全量 fetch）是裸调 —— **它才是真正会把
    # URL 连凭据一起回显的那条** ⇒ 失败时凭据原文进 job log（已 REPRODUCED）。两条共用
    # 一个捕获文件，失败时打印的是信息量更大的第二条。
    new_temp_file; FETCH_ERR="$NEW_TEMP"
    if ! git -C "$CLONE" fetch --quiet --depth 1 origin "$PIN" 2>"$FETCH_ERR"; then
      if ! git -C "$CLONE" fetch --quiet origin 2>"$FETCH_ERR"; then
        report_git_failure "无法取回渠道仓的 pin commit(检查渠道仓凭据 CHANNELS_REPO_SSH_KEY / CHANNELS_REPO_TOKEN 与网络)" "$FETCH_ERR"
        exit 1
      fi
    fi
    if ! git -C "$CLONE" checkout --quiet --detach "$PIN" 2>/dev/null; then
      echo "::error::渠道仓里没有 pin 的 commit(解析出的 revision 与仓库不一致)" >&2
      exit 1
    fi
    # 硬校验:检出的 commit 必须**逐字等于** pin(不能是"差不多")。
    ACTUAL="$(git -C "$CLONE" rev-parse HEAD 2>/dev/null || true)"
    if [ "$ACTUAL" != "$PIN" ]; then
      echo "::error::渠道仓 pin 校验失败:检出到的 commit 与传入的 pin 不一致(值不回显)" >&2
      exit 1
    fi
    stage_from "$CLONE"
    CHECKOUT_ROOT="$CLONE"
    CHANNELS_FROM_REMOTE=1
    # 打印 revision(2026-09-23 第五轮审计 R5-C-2 起):它是"这次交付用的是哪版渠道包"
    # 的唯一凭据,四处调用点必须打出同一个值;commit SHA 是私有仓的提交指纹,**不是**
    # 渠道身份(不含渠道 id/品牌/域名),可以进公开日志。
    echo "channel packages pinned at ${PIN}"
  else
    # **clone 路径必须捕获 + 脱敏**（2026-09-24 第八轮审计 R8-D-9，已 REPRODUCED）：
    # ci.yml 的四个**生产**调用点走的正是这条路径，而它此前把 git 的 stderr 直接放进
    # job log —— 基本认证密码里含 `/` 时完整凭据原样回显（脱敏只加在 `--resolve-only`
    # 那一半上，典型的"判据形态 ≠ 生产形态"）。现在三條 git 路径共用
    # `report_git_failure`（捕获 → 脱敏 → 滤 TOFU 噪声 → 分类）。
    new_temp_file; CLONE_ERR="$NEW_TEMP"
    if ! git clone --depth 1 --quiet "$(channels_url)" "$CLONE" 2>"$CLONE_ERR"; then
      report_git_failure "无法克隆私有渠道仓 ${REPO}(检查渠道仓凭据 CHANNELS_REPO_SSH_KEY / CHANNELS_REPO_TOKEN 是否有效/是否只读该仓)" "$CLONE_ERR"
      exit 1
    fi
    stage_from "$CLONE"
    CHECKOUT_ROOT="$CLONE"
    CHANNELS_FROM_REMOTE=1
    echo "channel packages fetched (revision $(git -C "$CLONE" rev-parse HEAD 2>/dev/null || echo unknown))"
  fi
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

# ---- "应有渠道集":下限 + 可选清单（identity-free 判据，2026-09-24 第八轮审计 R8-C-7）----
#
# 问题（已 REPRODUCED）：`channel_set=all`（正式 tag）的语义是"发一个正式版 = 所有渠道
# 都发布"，但"所有" = **渠道仓本次 revision 里恰好存在的那些目录**。删掉/改名一个渠道目录
# （或克隆不完整）之后流水线照样 EXIT=0，日志里只有一行读不出期望值的
# `channels selected: N of N` ⇒ 那个客户拿不到任何交付物（品牌渠道的**唯一**分发面是
# 更新服务器，GitHub Release 不含它们），而全程零红灯。
#
# 判据分两层，**两层都不在公开仓里写任何渠道身份**（铁律 0）：
#   1. 权威层（可选，推荐）：渠道仓**根目录**下的 `channels.manifest.json` —— 由私有仓
#      自己声明"本仓应有哪些渠道"，与枚举结果**双向**对拍：登记了却没有目录 = 红（正式
#      tag 会少发这个渠道）；有目录却没登记 = 红（未经评审的新渠道 → 它的消失将来无人
#      发现）。清单留在私有仓 ⇒ 公开仓零泄露，渠道上下线就是私有仓里一次可评审的 diff。
#      形状：{ "schema": 1, "channels": ["<channel-id>", …] }
#   2. 兜底层（始终生效）：`MIN_EXPECTED_CHANNELS` = 渠道目录数下限。它只是**一个数字**
#      （渠道数本来就已经打在公开日志里：`channels selected: N of M`），不含任何身份。
#      这是**棘轮**：新增渠道后目录数会**多于**下限 ⇒ 告警提示同步下限（不红，新渠道该发）；
#      下线渠道必须**显式**下调本常量（一次可评审的改动），否则删目录即跌破下限。
#      硬度按 ref 形态分档（判据在下面、CHANNEL_SET 之后）：**正式 tag（channel_set=all）
#      跌破下限 = 红**（那正是本次审计的现场）；其余 ref 只告警 —— PR/预发线上渠道正在
#      上下线时不该阻断无关构建，但必须在日志里看得见。
#      `verify-ci-scripts.mjs` 另有一条棘轮判据钉住"下限不得低于 4"，
#      防止有人把它调到 1 把闸门关掉。
MIN_EXPECTED_CHANNELS=4
if [ "$CHANNELS_FROM_REMOTE" -eq 1 ] && [ "${#FOUND[@]}" -gt "$MIN_EXPECTED_CHANNELS" ]; then
  echo "::warning::渠道仓里的渠道目录数(${#FOUND[@]})多于登记下限(${MIN_EXPECTED_CHANNELS})：新增渠道时请把 MIN_EXPECTED_CHANNELS 一起调高，否则将来少一个渠道不会被这条判据拦住(渠道名不打印)" >&2
fi

# 权威层：渠道仓根目录的可选清单（见上面注释）。不存在时不报错（向后兼容），
# 只留一行 notice 说明当前只有"目录数下限"在兜底。
MANIFEST_FILE="$CHECKOUT_ROOT/channels.manifest.json"
if [ -f "$MANIFEST_FILE" ]; then
  if ! FOUND_IDS="$(printf '%s\n' "${FOUND[@]}")" MANIFEST="$MANIFEST_FILE" node -e '
    const fs = require("node:fs")
    const found = (process.env.FOUND_IDS ?? "").split("\n").filter(Boolean)
    let cfg
    try {
      cfg = JSON.parse(fs.readFileSync(process.env.MANIFEST, "utf8"))
    } catch {
      console.error("::error::渠道仓的 channels.manifest.json 不是合法 JSON：它是发布面的**期望集合**，坏了就等于没有闸门(取值不回显)")
      process.exit(1)
    }
    const declared = Array.isArray(cfg?.channels)
      ? cfg.channels.filter(value => typeof value === "string" && value.trim() !== "").map(value => value.trim())
      : []
    if (declared.length === 0) {
      console.error("::error::渠道仓的 channels.manifest.json 没有非空 channels 数组：期望集合为空 ⇒ 闸门失效(取值不回显)")
      process.exit(1)
    }
    const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/
    const malformed = declared.filter(id => !ID_PATTERN.test(id))
    if (malformed.length > 0) {
      console.error("::error::渠道仓清单里有 " + malformed.length + " 个不符合渠道 id 形状的条目(取值不回显)")
      process.exit(1)
    }
    const declaredSet = new Set(declared)
    const foundSet = new Set(found)
    const missing = declared.filter(id => !foundSet.has(id))
    const unregistered = found.filter(id => !declaredSet.has(id))
    if (missing.length > 0 || unregistered.length > 0) {
      // 渠道 id **先登记掩码再打印**，而且两条都走 stderr：GitHub 的 workflow command
      // 在 stdout 与 stderr 上都会被解析，放在同一条流里才能保证"掩码一定先于取值出现"
      // （跨流写的先后顺序没有保证 ⇒ 可能先打出未掩码的 id）。本地终端则照旧可读，
      // 这是排查时唯一能看到"缺的是谁"的地方。
      for (const id of [...missing, ...unregistered]) console.error("::add-mask::" + id)
      if (missing.length > 0) {
        console.error("::error::渠道仓清单声明了 " + missing.length + " 个渠道但仓库里没有对应目录：正式 tag 会静默少发这些渠道(清单=期望集合，目录=实际集合)。缺失：" + missing.join(", "))
      }
      if (unregistered.length > 0) {
        console.error("::error::渠道仓里有 " + unregistered.length + " 个渠道目录未登记进 channels.manifest.json：新渠道必须先登记，否则它将来被删掉不会被任何判据发现。未登记：" + unregistered.join(", "))
      }
      process.exit(1)
    }
    console.error("channels manifest verified: " + declared.length + " channels (ids masked)")
  '; then
    exit 1
  fi
else
  echo "::notice::渠道仓没有 $MANIFEST_FILE ⇒ 期望集合只能用目录数下限(${MIN_EXPECTED_CHANNELS})兜底；渠道仓加了这份清单后，少发/未登记都会点名到具体渠道" >&2
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

# ref 形态 → 渠道集(用户定案):
#   beta 预发布 tag  → 只发 beta 渠道(beta 是独立渠道,复用官方品牌内容)
#   正式 tag vX.Y.Z  → 发**所有**渠道(发一个正式版 = 所有渠道都发布)
#   非 tag(PR/分支) → 只做 official(与现状一致)
#
# **判定不在这里**:唯一真源是 `scripts/ci-release-policy.sh`(2026-09-23 审计 K-04)。
# 这条规则曾经被写成两份(本文件的 bash glob + `ci.yml` 里 release job 的 `if:`),
# 两者对"名字带 `-` 但后缀不认识"的 tag 结论相反(这里当正式版全渠道构建、那边跳过
# 整个 release job)⇒ 40 分钟构建 + 零交付 + R2 中转前缀无人清理。现在本文件只消费
# 它的输出;形态不认识时它退出 1,`set -e` 让本步骤当场中止(不再"猜一个渠道集")。
POLICY="$(dirname "$0")/ci-release-policy.sh"
CHANNEL_SET="$(bash "$POLICY" --ref "${GITHUB_REF:-}" --ref-name "$RAW_REF_NAME" --field channel_set)"

# 兜底层判据（下限）：**只在"远端取源"的路径上生效**，且**正式 tag 跌破 = 红、其余 ref 只告警**
# （分档理由见上面那段注释）。
#
# **为什么本地检出（CI_CHANNELS_SOURCE）不参与**（2026-09-24 集成回归，实测）：这个模式是给
# 本地/合成夹具用的（本仓两个守卫 `scripts/verify-wasm-channels.mjs` 与 `verify-ci-scripts.mjs`
# 都用它），夹具的目录数（3 个）天然小于真实渠道仓的下限（4 个）。若在这里判红，**逐渠道字段
# 校验就永远看不到自己的错误** —— 实测组 7 的 7 条断言全红（`--list` 根本没写出、六条
# `desktop.app_origin_scheme` 负例拿到的是"渠道数不足"而不是"点名字段"）。判据形态必须等于
# 生产形态：生产链的四个调用点（ci.yml）**总是** clone/pin ⇒ 判据挂在远端取源这一支上，
# "静默缩小 ⇒ 红"的能力一点没少（`verify-ci-scripts.mjs` 的 C-07 用真 git 仓库 + pin 走生产
# 路径验它；另有一条静态判据断言**没有任何 workflow 设置 CI_CHANNELS_SOURCE**）。
if [ "$CHANNELS_FROM_REMOTE" -ne 1 ]; then
  echo "::notice::本次内容来自本地检出(CI_CHANNELS_SOURCE) ⇒ 跳过「渠道目录数下限」判定：该判据只针对**远端取源**（clone/pin，生产链的形态）—— 本地夹具/合成渠道仓的目录数天然小于真实渠道仓，在这里判红会让逐渠道字段校验看不到自己的错误" >&2
elif [ "${#FOUND[@]}" -lt "$MIN_EXPECTED_CHANNELS" ]; then
  if [ "$CHANNEL_SET" = "all" ]; then
    echo "::error::渠道仓里的渠道目录数(${#FOUND[@]})少于登记下限(${MIN_EXPECTED_CHANNELS})：正式 tag 的语义是「所有渠道都发布」，少一个目录就有一个渠道静默拿不到交付物(流水线却全绿)。先核对本次 pin 的 revision 与渠道仓目录是否完整；确属渠道下线时，必须在同一次改动里显式下调 scripts/ci-channels.sh 的 MIN_EXPECTED_CHANNELS" >&2
    exit 1
  fi
  echo "::warning::正式 tag 之外的 ref：渠道仓目录数(${#FOUND[@]})少于登记下限(${MIN_EXPECTED_CHANNELS})（本次只构建 ${CHANNEL_SET}）—— 正式 tag 上这会直接失败，请核对渠道仓目录是否完整(渠道名不打印)" >&2
fi

SELECTED=()
case "$CHANNEL_SET" in
  beta)
    SELECTED=("beta") ;;
  all)
    SELECTED=("${ALL[@]}") ;;
  *)
    SELECTED=("official") ;;
esac

# 名字像发布 tag、但 ref **不是** tag:最常见的来源是"把 tag 名当分支推了"
# (`git push origin v2.7.3` 少了 `refs/tags/`,或从 tag 建了同名分支)。按上面的
# 判据这里只发 official —— 这是**对的**(绝不能凭名字把品牌渠道发出去),但这种
# 输入几乎总是误操作,静默会让"发布渠道少了"在很久以后才被发现,所以给一条中性
# 告警。判据同样取自唯一真源(`looks_like_release_tag`),不在这里写第二份 glob。
# **不回显名字**:分支名可能带客户信息(本仓历史上有过渠道内容进公开日志的事故),
# 渠道 CI 一律不输出渠道侧字符串。
if [ "$IS_TAG" -ne 1 ] \
  && [ "$(bash "$POLICY" --ref "${GITHUB_REF:-}" --ref-name "$RAW_REF_NAME" --field looks_like_release_tag)" = "true" ]; then
  # 用中文引号,避免在双引号字符串里嵌套 ASCII 引号(实测会被 bash 拆成
  # 相邻词再拼回去,内容碰巧正确但读起来像 bug)。
  echo "::warning::当前 ref 不是 tag(缺 refs/tags/ 前缀)——已按「非 tag 只发 official」处理;若这是一次发布,请用 tag 触发(分支名不能决定渠道集)" >&2
fi

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
    // 官方正式版的数据目录名(desktop-home.ts 的 PRODUCT_DSH_HOME_DIR,编译期常量)。
    const OFFICIAL_HOME_DIR = ".picoaide-harness"
    const missing = []
    const invalid = []
    const warnings = []
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
    // 数据目录(2026-09-11;2026-09-12 两次修订):客户端里官方目录名是编译期常量,
    // 渠道不显式声明就只能共用官方目录 —— 两个渠道共用一个数据根会共享登录
    // token/settings/会话(跨租户),并互相顶掉 Electron 的单实例锁。只能在构建期拦:
    // 装到客户机器上时数据已经共享了。
    // **beta 相反(2026-09-12 用户定案)**:预发版是正式版的前置验证,必须与 official
    // 用同一个数据根,否则装预发版的用户升级后看不到既有会话与登录态 —— 当天早些
    // 时候改成独立目录 `.picoaide-harness-beta` 就是这么炸的(用户报"所有对话都没了":
    // 旧数据留在官方目录,新客户端读的是新目录)。这条**显式且唯一**:写别的目录(含
    // 派生兜底 `.picoaide-harness-<渠道>`)一律 fail-loud,免得哪天又静默漂移。
    if (str(cfg?.desktop?.home_dir) === undefined && id !== "official") missing.push("desktop.home_dir")
    // 数据目录名形状:`~` 下的**单段**目录名(点开头 + 小写字母/数字/连字符)。
    // 允许分隔符等于让渠道包把数据根挪到任意位置;大写会让同一个渠道在 Linux 与
    // Windows/macOS 上落进两个不同目录。
    const homeDir = str(cfg?.desktop?.home_dir)
    if (homeDir !== undefined && !/^\.[a-z0-9][a-z0-9-]{0,62}$/.test(homeDir)) {
      invalid.push("desktop.home_dir(须为点开头的单段小写目录名,如 .acme-harness)")
    }
    if (id === "beta" && homeDir !== OFFICIAL_HOME_DIR) {
      invalid.push("desktop.home_dir(预发布渠道必须与官方正式版一致,写别的目录会让预发版用户升级后看不到既有会话与登录态)")
    }
    // 品牌渠道(official/beta 之外)**不得**等于官方目录:渠道线与 official 的
    // 会话格式世代可能不同,共用会静默分叉数据;不同客户之间更不该共享数据根。
    if (id !== "official" && id !== "beta" && homeDir === OFFICIAL_HOME_DIR) {
      invalid.push("desktop.home_dir(不得与官方渠道共用数据目录:渠道线与 official 的会话格式世代可能不同,共用会静默分叉数据;请用 .picoaide-harness-<渠道>)")
    }
    // 非法字段**只报字段名,不回显取值** —— 渠道包里 slug/app_id/scheme 的值就是
    // 客户品牌(Acme-AI / com.acme.ai / acmeai),而这一步的输出进公开 Actions 日志。
    // 2026-09-10 审计当场发现:早先版本把值打进了错误信息,等于给品牌渠道装了条
    // 泄密通道(`::add-mask::` 只掩码渠道 id,掩不到这些值)。
    const slug = str(cfg?.desktop?.slug)
    if (slug !== undefined && !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(slug)) invalid.push("desktop.slug(须为 ASCII 字母/数字/连字符)")
    // product_name(2026-09-12 审计 P1-13):它是 Electron userData 目录名
    // (desktop-user-data.ts)与 mac `.app` 目录名(release-mac.ts)的输入,是这批
    // 字段里唯一没有形状校验的。`../evil` 会把数据根挪出 appData;两个渠道取同一个
    // 产品名(acme / acme-staging)会共用 userData(单实例锁互顶 + 状态互相污染)。
    // 与客户端 desktop-channel.ts 的 isSafeProductName 同款(运行时同样校验,
    // 这里只是把事故提前到构建期)。刻意与 slug/app_id 一样**只报字段名不回显取值**。
    const productName = str(cfg?.desktop?.product_name)
    if (productName !== undefined) {
      const safeProductName = /^[^\s/\\:*?"<>|\u0000-\u001F\u007F][^/\\:*?"<>|\u0000-\u001F\u007F]{0,63}$/.test(productName)
        && !/[. ]$/.test(productName)
      if (!safeProductName) invalid.push("desktop.product_name(须为路径安全的产品名:禁路径分隔符/控制字符/Windows 非法字符,不以点或空格结尾,1–64 字符)")
    }
    const appId = str(cfg?.desktop?.app_id)
    if (appId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(appId)) invalid.push("desktop.app_id(须为反向域名形状)")
    const scheme = str(cfg?.desktop?.deep_link_scheme)
    if (scheme !== undefined && !/^[a-z][a-z0-9+.-]{1,31}$/.test(scheme)) invalid.push("desktop.deep_link_scheme(须为小写 RFC 3986 scheme)")
    // app_origin_scheme(2026-09-19 设计 §10/§8.3):WASM 应用的**客户端协议 origin**。
    // 客户端按它注册特权 scheme、在合成请求里写 Origin;服务端按它校验来源。
    //   - **全部渠道必填**(含 official/beta,**不做 publicChannel 豁免**):字段缺失时
    //     两端各自回落(`<deep_link_scheme>-app` 派生值 / 服务端缺配置的中性 fallback),
    //     而"派生缺省"只允许存在于本地开发 —— 发行镜像里两侧取值不一致就是"应用打不开"
    //     且故障现象与配置毫无关系。所以进 missing,fail-loud。
    //   - 跨渠道唯一性**不在这里**判(逐渠道校验看不见别的渠道):见本脚本末尾的
    //     独立扫描 pass。
    const RESERVED_APP_ORIGIN_SCHEMES = new Set(["http", "https", "file", "data", "javascript", "about"])
    const appOriginScheme = str(cfg?.desktop?.app_origin_scheme)
    if (appOriginScheme === undefined) {
      missing.push("desktop.app_origin_scheme")
    } else {
      // 形状:与两端既有实现**逐字一致**的 RFC 3986 scheme 正则(总长 2–32,
      // **有上界**)—— 两端各写一份正则就会漂移,而漂移的后果是"服务端拒绝、客户端
      // 照发"(所有非幂等请求 403)。合法字段只报字段名,不回显取值。
      if (!/^[a-z][a-z0-9+.-]{1,31}$/.test(appOriginScheme)) {
        invalid.push("desktop.app_origin_scheme(须为小写 RFC 3986 scheme:小写字母开头,只含小写字母/数字/加号/点/连字符,2–32 字符)")
      }
      // 与同渠道 deep_link_scheme 同值:两者在客户端里是两个不同的注册项,
      // 同值会让"深链回调"与"应用页 origin"在协议栈层面撞在一起,必须不同。
      if (scheme !== undefined && appOriginScheme === scheme) {
        invalid.push("desktop.app_origin_scheme(不得与 desktop.deep_link_scheme 相同 —— 应用 origin 与深链回调必须用两个不同的 scheme)")
      }
      // 保留 scheme(§10 冻结名单):浏览器/系统已有既定语义,拿去当应用 origin 会让
      // 应用页与它们冲突,也过不了特权 scheme 注册。名单是固定常量,不涉渠道取值。
      if (RESERVED_APP_ORIGIN_SCHEMES.has(appOriginScheme)) {
        invalid.push("desktop.app_origin_scheme(不得使用保留 scheme:http/https/file/data/javascript/about)")
      }
    }
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
    //
    // 只校验**已知的素材字段**:渠道包里允许写 `_note` 这类注解(私有仓实际就这么
    // 用),也允许将来新增字段 —— 拿"所有非 accent 的键都是文件名"去套,
    // 会把注解误判成非法文件名而中止整条发布(2026-09-10 CI 实测踩到)。
    // 未知字段只告警(很可能是把 logo 拼错成 logoo),不拦发布。
    //
    // 2026-09-13 审计 R7(webadmin-branding-1)加严:SVG 素材**禁止脚本特征**。
    // 服务端与客户端都按图片消费素材(<img>),但顶层导航到素材 URL(钓鱼链接)
    // 时浏览器会把它当 SVG 文档执行 —— 内联 <script>/onload= 就在服务端源上跑,
    // 还能带上 HttpOnly 的会话 cookie 读同源管理接口。服务端运行时已按不可信
    // 输入加沙箱 CSP(server/internal/channel/handlers.go),但那只是纵深防御:
    // 内容本身必须在进入镜像**之前**拦掉,这里(渠道包校验)是唯一上游门禁。
    //
    // 2026-09-13 复核(R7-RV-4 / R7-RV-5)修正两处:
    //   - **按结构判定**,不再在整份正文上跑正则:注释、<desc>/文本节点、CDATA 里
    //     写 "导出时不要出现 onload= / javascript: URL" 只是说明文字,旧写法会把
    //     这类合法素材判成脚本素材、把整条渠道发布打回(fail-loud 误伤) 。现在先
    //     跳过注释/CDATA/处理指令,只在**标签内部**看事件处理属性与 URL 属性,只在
    //     元素名位置看 script/foreignObject。
    //   - **按内容嗅探**,不再只看扩展名:素材的 Content-Type 是按文件名定的,把带
    //     脚本的 SVG 命名成 logo.png 就能同时绕过扩展名检查与下发类型,所以凡
    //     "内容像 XML/SVG 文档"(或 UTF-16 编码的同名文档)的素材一律按 SVG 检查,
    //     不管扩展名;.svg 扩展名照旧必查。
    // 命中只报**字段名 + 特征种类**(元素/属性名),不回显文件内容与品牌取值。
    // 不引入第三方依赖:手写扫描器足够。
    const SVG_URL_ATTRS = /^(?:xlink:)?href$|^src$|^data$|^action$|^formaction$|^style$|^(?:values|from|to|by)$/
    // SVG 动画元素能把 script-ish 值"写"进别的属性(`<set attributeName="onload"
    // to="alert(1)"/>` 是已知的 SVG XSS 姿势),这一族按元素名 + attributeName 判定。
    const SVG_ANIM_TAGS = new Set(["set", "animate", "animatetransform", "animatemotion"])
    // XML 数字字符引用会被解析器还原(`&#106;avascript:` = `javascript:`),
    // 判定 URL 属性前先解码,否则换个写法就绕过了。
    const safeCodePoint = (code, fallback) => {
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return fallback
      try { return String.fromCodePoint(code) } catch { return fallback }
    }
    const decodeCharRefs = (v) => v
      .replace(/&#x([0-9a-f]{1,6});?/gi, (whole, hex) => safeCodePoint(parseInt(hex, 16), whole))
      .replace(/&#([0-9]{1,7});?/g, (whole, dec) => safeCodePoint(parseInt(dec, 10), whole))
      .replace(/&colon;/gi, ":")
    // scriptishSvg 返回命中的特征(元素名/属性名);空数组 = 未发现脚本特征。
    const scriptishSvg = (src) => {
      const hits = []
      const n = src.length
      let i = 0
      while (i < n) {
        const lt = src.indexOf("<", i)
        if (lt < 0) break
        // 注释 / CDATA / 处理指令 / DOCTYPE:其中的字样是文本,不是标记。
        if (src.startsWith("<!--", lt)) { const end = src.indexOf("-->", lt + 4); i = end < 0 ? n : end + 3; continue }
        if (src.startsWith("<![CDATA[", lt)) { const end = src.indexOf("]]>", lt + 9); i = end < 0 ? n : end + 3; continue }
        if (src.startsWith("<?", lt) || src.startsWith("<!", lt)) { const end = src.indexOf(">", lt + 2); i = end < 0 ? n : end + 1; continue }
        // 标签体扫到 `>` 为止,但尊重引号(属性值里可以出现 `>`)。
        let j = lt + 1
        let quote = ""
        while (j < n) {
          const ch = src[j]
          if (quote !== "") { if (ch === quote) quote = "" }
          else if (ch === "\"" || ch === "\x27") quote = ch
          else if (ch === ">") break
          j++
        }
        const body = src.slice(lt + 1, j)
        i = j + 1
        if (body.startsWith("/")) continue // 闭合标签
        // 元素名(允许命名空间前缀):只在标签名位置认 script/foreignObject。
        const nameMatch = /^(?:[A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)/.exec(body)
        const tag = (nameMatch === null ? "" : nameMatch[1]).toLowerCase()
        if (tag === "script" || tag === "foreignobject") { hits.push("<" + tag + ">"); continue }
        // 属性:事件处理属性(on*=)、动画写事件属性、URL 属性里的 javascript: 协议。
        const attrRe = /([A-Za-z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|\x27([^\x27]*)\x27|([^\s"\x27>]+))/g
        let m
        while ((m = attrRe.exec(body)) !== null) {
          const attr = m[1].toLowerCase()
          if (/^on[a-z]+$/.test(attr)) { hits.push(attr + "="); continue }
          const rawValue = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] === undefined ? "" : m[4]))
          if (SVG_ANIM_TAGS.has(tag) && attr === "attributename" && /^on[a-z]+$/i.test(rawValue.trim())) {
            hits.push(tag + "@" + rawValue.trim().toLowerCase())
            continue
          }
          if (SVG_URL_ATTRS.test(attr) && /javascript\s*:/i.test(decodeCharRefs(rawValue))) hits.push(attr + "=javascript:")
        }
      }
      return hits
    }
    // 内容像 XML/SVG 文档?跳过 BOM 与空白后第一个字节是 `<`。
    const looksLikeMarkup = (buf) => {
      let i = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0
      while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x09 || buf[i] === 0x0a || buf[i] === 0x0d)) i++
      return i < buf.length && buf[i] === 0x3c
    }
    // 素材文本:UTF-16 BOM 也要能扫(否则同一份恶意 SVG 换个编码就绕过嗅探)。
    const decodeAsset = (buf) => {
      if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le")
      if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff && buf.length % 2 === 0) {
        const swapped = Buffer.from(buf)
        swapped.swap16()
        return swapped.toString("utf16le")
      }
      return buf.toString("utf8")
    }
    const KNOWN_ASSET_KEYS = ["logo", "logo_dark", "favicon"]
    // 未知素材字段**只计数**（键名不回显，R8-D-14；理由见下面那条 warning）。
    let unknownAssetKeys = 0
    for (const [key, value] of Object.entries(cfg?.assets ?? {})) {
      if (key === "accent" || key.startsWith("_")) continue
      const name = str(value)
      if (name === undefined) continue
      if (!KNOWN_ASSET_KEYS.includes(key)) {
        unknownAssetKeys++
        continue
      }
      if (name.includes("/") || name.includes("\\")) { invalid.push("assets." + key + "(必须是单段文件名)"); continue }
      if (!fs.existsSync(path.join(dir, name))) { invalid.push("assets." + key + "(渠道目录里没有这个文件)"); continue }
      // 素材的脚本特征检查:先嗅探内容(不看扩展名),.svg 扩展名照旧必查。
      // 内容不进日志:只报字段名与特征种类(元素/属性名)。
      const assetBuf = fs.readFileSync(path.join(dir, name))
      const utf16 = assetBuf.length >= 2
        && ((assetBuf[0] === 0xff && assetBuf[1] === 0xfe) || (assetBuf[0] === 0xfe && assetBuf[1] === 0xff))
      if (looksLikeMarkup(assetBuf) || utf16 || /\.svg$/i.test(name)) {
        const hits = scriptishSvg(decodeAsset(assetBuf))
        if (hits.length > 0) {
          invalid.push("assets." + key + "(素材是 SVG/XML 文档且含脚本特征:" + [...new Set(hits)].slice(0, 3).join("/")
            + " —— 素材会被原样下发给浏览器,顶层打开即可执行脚本,请用图形工具重新导出为纯图形 SVG)")
        }
      }
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
    if (unknownAssetKeys > 0) {
      // **只报数量,不回显键名**（2026-09-24 第八轮审计 R8-D-14）：键名本身就是渠道包里的
      // 字符串，可能是品牌/渠道标识（实测 `assets.<品牌>_logo` 原样进了公开日志；老写法
      // 只对"非字段名形状"的键做了脱敏，而品牌标识恰好是字段名形状）。拼错的字段名靠
      // "对比私有仓的 assets 键"排查，不靠公开日志。
      console.error("::warning::渠道包里有 " + unknownAssetKeys + " 个未知素材字段(已忽略,可能是拼写错误;键名不回显): assets.<unknown>")
    }
    if (missing.length > 0 || invalid.length > 0) {
      if (missing.length > 0) {
        console.error("::error::渠道包缺少必需字段: " + missing.join(", ") + " —— 品牌字段缺失时客户端登录页/侧边栏在服务端不可达会回落中性占位/厂商名;desktop.app_origin_scheme 缺失时 WASM 应用的协议 origin 没有权威来源(服务端与客户端必须显式一致,派生缺省只允许存在于本地开发)。请补齐后重新发布")
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

# ---- 跨渠道唯一性:desktop.app_origin_scheme(2026-09-19 设计 §10,§8.3)--------
#
# 为什么必须单独一个 pass:上面的逐渠道循环只看**本渠道内部**(必填/形状/与深链不同/
# 非保留字),看不到"两个渠道取了同一个值" —— 而那正是最危险的形态:两个渠道的客户端
# 应用页同源,可以互相 fetch、读到彼此的应用数据,渠道隔离在协议层直接失效。
#
# 扫的是渠道仓里的**全部**渠道(不只本轮选中的):同一个发布面里的渠道可能被装到同一台
# 机器上,重复在任何一轮构建里都是配置事故,早一轮发现早一轮修。
#
# 公共渠道 official/beta 是**一个命名空间**(设计 §16 W3 / §8.3:两者取值同为
# `picoaide-app`):它们之间相同属预期,**唯一性豁免只给这一种形态**;品牌渠道必须
# 彼此不同,也不得取公共渠道的值(否则品牌客户端与官方客户端的应用页同源)。
#
# 输出纪律(同本脚本头部):扫的是渠道侧配置,输出**只允许出现字段名与中性词** ——
# 不回显 scheme 取值(渠道包里它就是客户品牌),也不回显渠道 id/目录名(公开 Actions
# 日志)。所以这里一次性用 node 扫完,失败只报"跨渠道重复"这一个事实。
if ! DEST="$DEST" node -e '
  const fs = require("node:fs")
  const path = require("node:path")
  const dest = process.env.DEST
  // 与上面枚举渠道时同一套 id 形状:不合规目录名连读都不读(它们可能是 README、
  // 备份目录之类,内容不可信)。
  const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/
  // 公共渠道共用一个命名空间;其余目录一律按"品牌渠道"计。
  const PUBLIC_CHANNELS = new Set(["official", "beta"])
  const holdersByScheme = new Map()
  for (const entry of fs.readdirSync(dest, { withFileTypes: true })) {
    if (!entry.isDirectory() || !ID_PATTERN.test(entry.name)) continue
    let cfg
    try {
      cfg = JSON.parse(fs.readFileSync(path.join(dest, entry.name, "channel.json"), "utf8"))
    } catch {
      // 缺文件/坏 JSON 不在这里报:那是逐渠道校验的职责(且未选中的渠道本轮本就不校验)。
      continue
    }
    const raw = cfg?.desktop?.app_origin_scheme
    if (typeof raw !== "string" || raw.trim() === "") continue
    const scheme = raw.trim()
    const holders = holdersByScheme.get(scheme) ?? { publicCount: 0, brandCount: 0 }
    if (PUBLIC_CHANNELS.has(entry.name)) holders.publicCount++
    else holders.brandCount++
    holdersByScheme.set(scheme, holders)
  }
  // 冲突 = 某个取值下有**品牌渠道**且该取值不是它独占:
  //   - 两个及以上品牌渠道同值;
  //   - 品牌渠道取了公共渠道的值(公共渠道之间同值是设计,与品牌同值不是)。
  // 两种都只记数量,不记是谁、也不记取值。
  let conflicts = 0
  for (const holders of holdersByScheme.values()) {
    if (holders.brandCount > 0 && holders.publicCount + holders.brandCount > 1) conflicts++
  }
  if (conflicts > 0) {
    console.error("::error::desktop.app_origin_scheme 跨渠道重复(共 " + conflicts + " 组):多个渠道取了同一个值 —— 该字段是 WASM 应用的协议 origin,重复会让两个渠道的客户端应用页同源、互相可达(渠道隔离失效);每个品牌渠道必须各用不同的值,且不得取公共渠道的值。取值与渠道名刻意不打印")
    process.exit(1)
  }
'; then
  exit 1
fi

printf '%s\n' "${SELECTED[@]}" > "$LIST"
# 写出的清单是一致性契约：下游四个 job（三平台 + release）**只**按它构建/搬运/发布，
# 少一行就是少一个渠道的交付物。这里做一次廉价的完整性复核（写盘失败/被截断/被并发
# 改写都会露头）；真正的"应有集合"判据在上面（下限 + 清单）。
LIST_LINES="$(grep -c . "$LIST" || true)"
if [ "${LIST_LINES:-0}" -ne "${#SELECTED[@]}" ]; then
  echo "::error::渠道清单写入不完整:选中 ${#SELECTED[@]} 个渠道,清单里只有 ${LIST_LINES:-0} 行(不打印渠道名) —— 下游 job 会少构建/少交付,必须中止" >&2
  exit 1
fi
# 只报数量与形态,不回显渠道名。
echo "channels selected: ${#SELECTED[@]} of ${#ALL[@]} (all channel ids masked)"
