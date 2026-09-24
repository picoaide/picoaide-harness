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
# **`--body` 只能给纯路径**(2026-09-24 发布链阻断事故):`file://` / `fileb://` 前缀
# 在新 AWS CLI 上被 ParamValidation 直接拒绝 —— 见 abs_path 的注释(含实测证据)。
#
# **上传前先探测**(2026-09-24 事故加固):先拿 5 字节对象(`PROBE_PAYLOAD` / `PROBE_BYTES`)
# 把「CLI 参数形态对不对 / endpoint 与凭据通不通 / 校验和读不读得回」判死,再去推
# ~500MB —— 见循环里的第 0 步。**注释里的字节数、`PROBE_BYTES` 与 `PROBE_PAYLOAD`
# 三者由 scripts/verify-ci-scripts.mjs 逐字对拍**:这里此前写「1 字节」而实际是
# `printf 'probe'` = 5 字节(2026-09-24 审计 C-24),注释漂移属本项目登记的第 8 类假绿。
#
# **探测对象必须删掉并证明它真的没了**(2026-09-24 审计 C-21 / D-04):删除失败、或删除后
# `head-object` 仍能读到它 ⇒ fail-loud,绝不在 immutable 版本目录里留下探测残留;
# 收口用 EXIT trap,因为 verify_remote_object 的失败分支早于正常的删除点
# (探测 PUT 成功但读回校验失败那条路径此前连删除都不会尝试)。
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

# `--body` 只能给**纯路径** —— 2026-09-24 发布链阻断事故的修复。
#
# 现场:tag 发布流水线的 Release job 在「上传版本资产」这一步失败:
#   aws: [ERROR]: An error occurred (ParamValidation):
#     Error parsing parameter '--body': Blob values must be a path to a file.
# 根因是这里原先把 `--body` 写成了带 `fileb://` 前缀的形态。用 AWS CLI 2.37.1
# 本地实测(`--endpoint-url http://127.0.0.1:1` 只做参数形态验证,不连任何远端):
#   --body 带 `fileb://` 前缀(相对/绝对路径都一样)→ 上面那条 ParamValidation,退出 252
#   --body 带 `file://`  前缀(相对/绝对路径都一样)→ 同一条 ParamValidation,退出 252
#   --body 纯路径(绝对/相对)                  → 通过参数解析,**走到网络层**
#   --body 纯路径但文件不存在                  → 同一条 ParamValidation(所以必须真实存在)
# 即:新 CLI **不再接受** `file://` / `fileb://` 前缀形态。**不要"修回" `fileb://`** ——
# 门禁里的假 aws 已与真 CLI 同形(见 scripts/verify-ci-scripts.mjs,遇这两个前缀即报
# 同一条错误并非零退出),另有静态判据扫 scripts/*.sh 与 .github/workflows/*.yml 的
# 每一个 `--body` 取值。
#
# 规则比"两个前缀"更宽(2026-09-24 审计 C-19 的补测,同一条报文 + 退出 252):
#   `FILEB://` `Fileb://` `FILE://`(大小写) · `foo://` `s3://` `http://` `C://`(任意 scheme)
#   · `file:/x` `fileb:/x`(无斜杠形态) · `foo:bar`(冒号形态) · `./real.txt`(不存在的相对路径)
#   ⇒ 判据的取向是 **fail-closed**:凡不能证明是「纯字面量绝对路径」的形态一律红。
#   静态判据因此按"任意 scheme 前缀 + 变量拼接 / 命令替换 / 引号拆分 / 前导空白"判定,
#   并把 workflow 的 run 文本纳入扫描面(经包装函数调用的等价上传此前完全不在判据面内,
#   2026-09-24 审计 C-18)。
#
# 为什么不直接 `realpath`:`realpath` 在精简 runner(Git Bash / busybox)上不保证存在,
# 而本文件不许引入新依赖 ⇒ 用 dirname/basename + `cd … && pwd` 自己归一。
abs_path() { # $1=文件 → 绝对路径;不存在即 fail-loud(真 CLI 也会拒)
  local path="$1" dir base
  if [ ! -f "$path" ]; then
    echo "::error::内部错误:--body 只能给真实存在的文件,实际不存在:${path}" >&2
    return 1
  fi
  case "$path" in
    /*) printf '%s' "$path" ;;
    *)
      dir="$(dirname "$path")"
      base="$(basename "$path")"
      printf '%s/%s' "$(cd "$dir" && pwd)" "$base"
      ;;
  esac
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

# 删除一个对象并**证明它真的没了**(2026-09-24 审计 C-21)。`s3 rm` 的退出码只说明
# "删除请求被接受",不说明"对象已不存在" —— 权限不足 / 瞬断 / 对象锁都可能让它看起来
# 成功。判据 = 删除后 `head-object` **必须报 404**(真 CLI 2.37.1 的形态:
# `An error occurred (404) when calling the HeadObject operation: Not Found`,退出 254);
# 能读到对象、或读回来的不是 404(例如根本连不上端点)都 fail-loud —— `<ver>/` 是
# immutable 的客户取包面,宁可中止发布,也不能留一个不可枚举的探测残留。
# **匹配的是那条报文本身,不是 `404` 这个子串**(成因与实测见函数体里的注释)。
verify_remote_object_absent() { # $1=对象键 $2=中性标签(不含渠道名)
  local key="$1" label="$2"
  local output status
  if ! brand_run_checked aws s3 rm "s3://${R2_BUCKET}/${key}"; then
    echo "::error::更新服务器发布失败(${label}:删除对象失败 —— 拒绝把残留留在版本目录里;上方输出已脱敏)" >&2
    return 1
  fi
  set +e
  output="$(aws s3api head-object --bucket "$R2_BUCKET" --key "$key" 2>&1)"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "::error::更新服务器发布失败(${label}:删除后对象仍能被读到(head-object 成功)—— 拒绝把残留留在版本目录里)" >&2
    return 1
  fi
  # 判据必须是**真 CLI 的 404 报文本身**,不能是"输出里出现过 404 这个子串"
  # (2026-09-24 现场,CI 因此红在探测对象用例上而且归因错误):
  # aws 的失败信息**自身会回显对象键** —— `Could not connect to the endpoint URL:
  # "http://…/<channel>/releases/<ver>/.probe-<RANDOM><RANDOM>-<pid>"` —— 而键里带两段
  # `$RANDOM` 数字。只要那串数字里恰好出现 `404`,裸 `grep -q '404'` 就会把"端点不可达"
  # 判成"对象已消失" ⇒ 收尾静默放行(实测发生率 1.0%:400 次里 4 次,`$RANDOM` 模拟
  # 1.048%)。真 CLI 2.37.1 的形态是固定报文(见上面注释),按它匹配既精确又不看运气。
  if ! printf '%s\n' "$output" | grep -qE '\((404|NoSuchKey)\)[[:space:]]+when calling the HeadObject operation'; then
    printf '%s\n' "$output" | brand_sanitize >&2
    echo "::error::更新服务器发布失败(${label}:删除后无法确认对象已消失(head-object 既不是 404 也不是成功);上方输出已脱敏)" >&2
    return 1
  fi
}

IMMUTABLE='public, max-age=31536000, immutable'
NO_CACHE='no-cache'
# 保留最近 N 个版本(用户定案);版本序必须用 sort -V:字面序里 2.10.0 < 2.9.0。
# 留存**总数**是该口径(`$VER` + 次新的 KEEP-1 个,见下面 prune 段),不是"KEEP 个
# 之外再加本次版本"。
KEEP=3

# 探测负载与它声明的字节数(见脚本头注释 C-24):
#   * `PROBE_PAYLOAD` 是唯一真源,写对象时用它(`printf '%s' "$PROBE_PAYLOAD"`);
#   * `PROBE_BYTES` 在写盘后当场复算(`wc -c`),不一致即 fail-loud —— "注释说的"
#     与"实际写的"不许各说一套;
#   * 注释里的字节数由 scripts/verify-ci-scripts.mjs 与 PROBE_BYTES 逐字对拍。
# 负载内容本身与判据无关(只证明 PUT/HEAD 往返与校验和读回),所以保持 5 字节的
# 'probe' 不动:改负载只会让"注释 / 声明 / 实际"三者的对拍失去历史基线。
PROBE_PAYLOAD='probe'
PROBE_BYTES=5

# 探测对象的收尾(2026-09-24 审计 D-04):`verify_remote_object` 有多条 `exit 1`
# 失败分支(读不回元数据 / 大小不符 / SHA256 不符),它们都**早于**正常删除点 ——
# "探测 PUT 成功但读回校验失败"这条路径此前连删除都不会尝试,5 字节对象就这样永久
# 留在 `<ver>/` 里(而 `$VER` 在保留窗口内永不参与淘汰)。所以删除收口在 EXIT trap:
# 任何退出路径都尝试删除**并校验**,删除/校验失败时显式 exit 1(不让原来的退出码
# 把它盖成"只是校验失败")。
#
# **`trap … EXIT` 是覆盖语义,而本脚本不是唯一的安装者**:`scripts/ci-brand-mask.sh`
# 的 `brand_mask_init` 在首次登记渠道时也会装一个 EXIT trap(清理掩码临时文件,里面
# 装着品牌串)。所以这里必须**链**在它后面 —— 记下安装时刻已有的 EXIT trap,在自己的
# 收尾里回放它(回放的**时机**见 cleanup_probe_object:脱敏要用的掩码文件必须活到收尾
# 之后)。若直接 `trap cleanup_probe_object EXIT`,
# 脱敏库的清理会被顶掉(临时文件里的品牌串留在 /tmp),而且**这个覆盖是静默的**:
# 只有真跑失败路径才看得见(本泳道实测:先写的一版 trap 从未执行过)。
probe_object_live=''
probe_tmp_file=''
# 版本指针的**临时键**(第十一轮审计 C2-B-01):先写临时键 → 校验 → 服务端 copy 覆盖正式键。
# 失败路径(含被 trap 捕获的中断)必须把这个键收干净,否则渠道根目录会留一个 `.latest-next-*`
# 残件(它不是 `releases/` 下的版本目录 ⇒ 保留策略管不到它,只能靠这里收)。
manifest_tmp_key_live=''
probe_previous_exit_trap=''
probe_exit_trap_installed=0
# 读出"当前 EXIT trap 的命令体"(trap -p 的形态:`trap -- 'cmd' EXIT`)。
capture_exit_trap() {
  local current
  current="$(trap -p EXIT)"
  current="${current#trap -- }"
  current="${current% EXIT}"
  case "$current" in
    \'*\') current="${current#\'}"; current="${current%\'}" ;;
    \"*\") current="${current#\"}"; current="${current%\"}" ;;
  esac
  printf '%s' "$current"
}
cleanup_probe_object() {
  local status=$? cleanup_status=0
  if [ -n "$probe_tmp_file" ]; then rm -f "$probe_tmp_file"; fi
  if [ -n "$manifest_tmp_key_live" ]; then
    local tmp_key="$manifest_tmp_key_live"
    manifest_tmp_key_live=''
    # 与探测对象同一条纪律:删除 + **证明它真的没了**(读不回 404 即 fail-loud)。
    if ! verify_remote_object_absent "$tmp_key" "指针临时键(收尾)"; then cleanup_status=1; fi
  fi
  if [ -n "$probe_object_live" ]; then
    local key="$probe_object_live"
    probe_object_live=''
    if ! verify_remote_object_absent "$key" "上传前探测(收尾)"; then cleanup_status=1; fi
  fi
  # **最后**才回放被我们"接管"的那个 trap(脱敏库的临时文件清理):它删掉的
  # `$BRAND_MASK_FILE` 正是 `brand_sanitize` 的输入。此前"先回放、后收尾"⇒ 上面两次
  # `verify_remote_object_absent` 的失败报文在脱敏那一步以 `node ENOENT` 崩掉,失败
  # 路径上只剩一段 node 栈迹、看不到脱敏后的真实报文(2026-09-24 实测,探测对象用例 (c)
  # 的现场证据就是这么被吃掉的)。放在最后既保住清理,又让掩码活到不再需要它为止;
  # 下面两个 `exit` 都在它之后 ⇒ 任何退出路径都不会把掩码临时文件留在 /tmp。
  if [ -n "$probe_previous_exit_trap" ]; then eval "$probe_previous_exit_trap"; fi
  # 两个临时键的收尾**都要跑**(此前前一个失败就 `exit 1`,把后一个的残留留在远端);
  # 原退出码不为 0 时保持它,收尾自身失败则一律 1(不让原退出码把它盖成"只是校验失败")。
  if [ "$cleanup_status" -ne 0 ]; then exit 1; fi
  exit "$status"
}
# 在**渠道登记之后**安装(那时脱敏库的 trap 才存在):链在它后面,而不是顶掉它。
install_probe_exit_trap() {
  [ "$probe_exit_trap_installed" = "0" ] || return 0
  probe_exit_trap_installed=1
  probe_previous_exit_trap="$(capture_exit_trap)"
  trap cleanup_probe_object EXIT
}

TOTAL=0
INDEX=0
while IFS= read -r channel; do
  [ -n "$channel" ] || continue
  INDEX=$((INDEX + 1))
  # 本步骤自己再掩码一次:掩码"从发出那一刻起"生效,跨步骤不假设。
  # brand_register_channel 额外登记 slug/显示名/产品名与产物文件名(2026-09-11
  # 泄漏事故:只掩渠道 id 掩不到由 slug 派生的文件名)。
  brand_register_channel "$channel" "$BUNDLE/$channel"
  # 脱敏库在上面的登记里装好了它的 EXIT trap ⇒ 现在把探测对象的收尾链上去。
  install_probe_exit_trap

  zip="$BUNDLE/$channel/picoaide-server-${VER}-amd64.zip"
  sums="$BUNDLE/$channel/SHA256SUMS"
  if [ ! -f "$zip" ] || [ ! -f "$sums" ]; then
    echo "::error::渠道构建产物缺失(zip 或 SHA256SUMS)—— 拒绝发布不完整的版本" >&2
    exit 1
  fi

  base="s3://${R2_BUCKET}/${channel}"
  zip_key="${channel}/releases/${VER}/picoaide-server-${VER}-amd64.zip"
  sums_key="${channel}/releases/${VER}/SHA256SUMS"

  # 本地产物不自洽:SHA256SUMS 必须真的写着本包的 sha256。空文件/写错包名在客户侧表现
  # 为"校验永远不过",而这里能当场拦下(它跟着包一起进镜像与 R2)。
  zip_sha="$(sha256sum "$zip" | cut -d' ' -f1)"
  if ! grep -qF "$zip_sha" "$sums"; then
    echo "::error::本地产物不自洽(releases/${VER}/ 的 SHA256SUMS 里没有该镜像包的 SHA256)—— 拒绝发布" >&2
    exit 1
  fi

  # `--body` 只给**纯路径**(绝对):见上方 abs_path 的注释 —— `fileb://` / `file://`
  # 前缀在新 AWS CLI 上被 ParamValidation 拒绝,那是本脚本 2026-09-24 阻断发布的原因。
  zip_body="$(abs_path "$zip")"
  sums_body="$(abs_path "$sums")"

  # 0) 上传前探测(2026-09-24 事故加固)。真正要推的是 ~500MB,而"能不能推"其实
  #    取决于三件与包大小无关的事:①CLI 参数形态对不对(本次事故正是形态问题:
  #    `--body fileb://…` 在真 CLI 上连参数解析都过不去)②endpoint / 凭据 / 桶权限
  #    通不通 ③`--checksum-sha256` 写进去之后能不能被 head-object 读回(下面
  #    verify_remote_object 的判据面)。用一个 5 字节的对象(PROBE_PAYLOAD /
  #    PROBE_BYTES,见脚本头注释)先把这三件事判死,失败就在**推大件之前**报错,
  #    而不是传了 500MB 才在复查阶段倒下。
  #    对象键带 `$RANDOM`/pid 后缀(不引新依赖),校验完立刻删除并**校验它真的没了**
  #    (verify_remote_object_absent):它落在 `<ver>/` 目录内,而保留策略只看
  #    `releases/` 下的版本目录,不会被误当成一个版本,也因此不会被自己清理 ——
  #    残留只能靠这里收干净。
  probe="$(mktemp)"
  printf '%s' "$PROBE_PAYLOAD" > "$probe"
  probe_tmp_file="$probe"
  probe_actual_bytes="$(wc -c < "$probe" | tr -d ' ')"
  if [ "$probe_actual_bytes" != "$PROBE_BYTES" ]; then
    echo "::error::内部错误:探测负载声明 ${PROBE_BYTES} 字节、实际 ${probe_actual_bytes} 字节(注释 / PROBE_BYTES / PROBE_PAYLOAD 必须一致)" >&2
    exit 1
  fi
  probe_key="${channel}/releases/${VER}/.probe-${RANDOM}${RANDOM}-$$"
  # 从这一行起 trap 接管这个键:**PUT 报失败也要收尾**(请求可能已经落到远端)。
  probe_object_live="$probe_key"
  if ! brand_run_checked aws s3api put-object \
    --bucket "$R2_BUCKET" --key "$probe_key" --body "$(abs_path "$probe")" \
    --content-type application/octet-stream --cache-control "$NO_CACHE" \
    --checksum-sha256 "$(sha256_b64 "$probe")"; then
    echo "::error::更新服务器发布失败(渠道 ${INDEX}:上传前探测 —— CLI 形态/endpoint/凭据在真正上传之前就不可用;上方输出已脱敏)" >&2
    exit 1
  fi
  verify_remote_object "$probe_key" "$probe" "上传前探测"
  # 正常路径:先从 trap 手里取走这个键,再做"删除 + 存在性校验"。
  # 删除失败 / 删除后仍读得到 / 读不回 404 ⇒ fail-loud(不让探测残留污染版本目录)。
  probe_object_live=''
  if ! verify_remote_object_absent "$probe_key" "上传前探测"; then
    exit 1
  fi
  rm -f "$probe"
  probe_tmp_file=''

  # 1) 版本化资产:不可变 + 长缓存(同版本内容永不改)+ 存储侧校验和(见上方
  #    verify_remote_object 的注释:单请求 PUT 才能拿到可与本地对拍的整对象 sha256)。
  if ! brand_run_checked aws s3api put-object \
    --bucket "$R2_BUCKET" --key "$zip_key" --body "$zip_body" \
    --content-type application/zip --cache-control "$IMMUTABLE" \
    --checksum-sha256 "$(sha256_b64 "$zip")"; then
    echo "::error::更新服务器发布失败(渠道 ${INDEX}:上传版本资产;上方输出已脱敏)" >&2
    exit 1
  fi
  verify_remote_object "$zip_key" "$zip" "版本资产"

  if ! brand_run_checked aws s3api put-object \
    --bucket "$R2_BUCKET" --key "$sums_key" --body "$sums_body" \
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
  #
  # **但 `|| true` 只能兜"下游 grep 无匹配",不能连 `s3 ls` 自身的失败一起吞**
  # (2026-09-24 审计 C-22 第二重影响):`set -o pipefail` 下管道里任何一段失败都会
  # 让整体非 0,旧写法于是把"列表读不回来"也判成"没有更老的版本" ⇒ 保留策略静默
  # 不执行、旧版本无限累积,而流水线全绿。所以列表这一步单独捕获 + 判失败 fail-loud。
  #
  # 这一行也是本脚本**唯一**不走 `brand_run_checked` 的 aws 调用点:aws 的失败信息
  # 自身会回显对象键,而这里的前缀含渠道 id(只有 `::add-mask::` 一层兜底,漏登记
  # 一次就是一次泄漏)⇒ stderr 必须自己过 `brand_sanitize`(2026-09-24 审计 C-22)。
  set +e
  listing="$(aws s3 ls "$base/releases/" 2>&1)"
  listing_status=$?
  set -e
  if [ "$listing_status" -ne 0 ]; then
    printf '%s\n' "$listing" | brand_sanitize >&2
    echo "::error::更新服务器发布失败(渠道 ${INDEX}:列出版本目录失败 —— 保留策略无法执行,旧版本会无限累积;上方输出已脱敏)" >&2
    exit 1
  fi
  versions="$(printf '%s\n' "$listing" | awk '{print $2}' | sed 's#/##' \
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
  # 同资产:`--body` 只给纯路径(mktemp 一般已是绝对路径,这里一并归一)。
  manifest_body="$(abs_path "$manifest")"
  # **先写临时键,校验通过再原子替换正式键**(第十一轮审计 C2-B-01,P2)。
  #
  # 现场:旧实现直接 PUT `${channel}/latest.json` 再校验 —— 报错文案说"拒绝写 latest.json",
  # 但**写已经发生**:PUT 被截断/写坏时,上一版**可用的**指针已经被残件覆盖,客户端更新
  # 链路的第一步(读 latest.json)当场坏掉,直到下一次成功发布。资产(zip/SHA256SUMS)侧
  # 没有这个问题(它们在写指针之前校验),只有指针自身的校验天然是"写后校验"。
  #
  # 现在:临时键(`.latest-next-<rand>`,与探测对象同一命名纪律 ⇒ 不进任何版本目录)
  # → `verify_remote_object` 对拍大小+SHA256 → `s3api copy-object` 服务端**原子替换**
  # 正式键(元数据走 COPY,缓存头/内容类型随临时对象继承,仍是 no-cache) → 再对拍正式键。
  # 任一步失败,正式指针**一个字节都没动**;临时键由 EXIT trap 收尾。
  manifest_tmp_key="${channel}/.latest-next-${RANDOM}${RANDOM}-$$.json"
  manifest_tmp_key_live="$manifest_tmp_key"
  if ! brand_run_checked aws s3api put-object \
    --bucket "$R2_BUCKET" --key "$manifest_tmp_key" --body "$manifest_body" \
    --content-type application/json --cache-control "$NO_CACHE" \
    --checksum-sha256 "$(sha256_b64 "$manifest")"; then
    echo "::error::更新服务器发布失败(渠道 ${INDEX}:写版本指针临时键;上方输出已脱敏)" >&2
    rm -f "$manifest"
    exit 1
  fi
  verify_remote_object "$manifest_tmp_key" "$manifest" "版本指针(临时键)"
  # 服务端 copy = 单对象原子替换(不经过本地字节,R2 侧同一个 PUT 语义)。
  # 元数据用 `REPLACE` **显式重述**缓存头与内容类型:**不依赖"继承"** —— 否则临时对象的
  # 缓存头一旦被改错(或将来有人把它换成别的前缀/别的写法),正式指针会静默继承一个错值,
  # 而"逐对象缓存头断言"看到的仍是临时对象那一行。REPLACE + 逐字段重述让正式键的
  # 缓存头**在写它的那一行**上可被判据读到(判据见 verify-ci-scripts 的 6b 节)。
  if ! brand_run_checked aws s3api copy-object \
    --bucket "$R2_BUCKET" --key "${channel}/latest.json" \
    --copy-source "${R2_BUCKET}/${manifest_tmp_key}" \
    --metadata-directive REPLACE --content-type application/json --cache-control "$NO_CACHE"; then
    echo "::error::更新服务器发布失败(渠道 ${INDEX}:用临时键替换版本指针;上方输出已脱敏)" >&2
    rm -f "$manifest"
    exit 1
  fi
  verify_remote_object "${channel}/latest.json" "$manifest" "版本指针"
  # 正式键已就位 ⇒ 临时键的收尾职责从 trap 手里取走,并立刻收干净。
  manifest_tmp_key_live=''
  if ! verify_remote_object_absent "$manifest_tmp_key" "版本指针(临时键)"; then
    rm -f "$manifest"
    exit 1
  fi
  rm -f "$manifest"
  TOTAL=$((TOTAL + 1))
done < "$LIST"

echo "update server publish done (${TOTAL} channel(s))"
