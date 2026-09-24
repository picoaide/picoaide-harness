#!/usr/bin/env node
/**
 * 「通过凭据」的**步骤绑定**检查器（第十二轮红队 R12-D-03 / C-P0-2② 的收口件）。
 *
 * ## 现场（为什么"流里出现过这句话"不算凭据）
 *
 * 第十一轮把判定权从被审进程上移到 CI：不看退出码，只认行首锚定的通过凭据
 * （`check-root-guards: VERDICT PASS guards=N` / `check-workspaces: VERDICT PASS planned=… executed=…`）。
 * 第十二轮红队实测三种形态都能让"这句凭据在场"而判据没跑或判决不可信：
 *
 *   ① **launcher 打印**：`.yarnrc.yml` 的插件在 yarn 进程内直接打这行（`yarn --version` 就会加载它）；
 *   ② **两个流各打半行**：`process.stdout.write('…VERDICT ')` + `process.stderr.write('PASS …\n')`，
 *      而 `2>&1 | tee` 会把它们拼成一行完整的凭据；
 *   ③ **前序步骤留下的进程追加**：tee 的目标是一个**可预测的固定路径**（旧实现是
 *      `/tmp/root-guards.log`），install 步留下的后台进程盯住它追加一行即可。
 *
 * ## 判据（本脚本做的事）
 *
 * 调用方（CI 步骤体）先建一个**步骤独占目录**（`mkdir -m 700 "$RUNNER_TEMP/verdict-$SRANDOM$SRANDOM$RANDOM"`
 * —— `mkdir` 是原子的：目录已存在即失败 ⇒ 前序步骤留下的进程无法预置它），把 nonce 写进这个目录
 * （`openssl rand -hex 16 > "$verdict_dir/nonce"`，**不进 argv、不进日志**），把判据进程的
 * stdout / stderr **分开**写进这个目录，然后调用本脚本。本脚本逐条判：
 *
 *   1. `--dir` 是 0700 的目录、属主是当前 euid、名字里带 ≥10 位随机数字（步骤独占：
 *      随机路径 + 只属于本步）；
 *   2. `stdout` 是常规文件（**不是符号链接**）、属主是当前 euid、`mtime >= --since`
 *      （本步开始时取的毫秒时间戳）—— 即"这个文件就是本步创建的"；
 *   3. `--status`（判据进程的退出码）必须是 `0`；
 *   4. `--pattern` 在 `stdout` 里**恰好命中一行**（多了 = 有人往这条流里补了一行；
 *      少了 = 判据没说出凭据）；
 *   5. 计数断言：`--min <key> <n>`（`key=<数字>` 抽取后 ≥ n）与 `--equal <keyA> <keyB>`
 *      （两者相等）—— 与两个 runner 的语义（`planned == executed > 0` / `guards ≥ 1`）同源；
 *   6. 全部成立时打印**回显本次 nonce** 的通过凭据
 *      `picoaide-verdict: PASS nonce=<nonce> …`，并把它追加进 `$GITHUB_STEP_SUMMARY`
 *      （平台侧产物）。步骤体再断言这行**恰好一条**。
 *
 * ## 诚实边界（认账）
 *
 *   · nonce 由**步骤体**生成并交给本脚本回显 —— 两个 runner（`check-workspaces.mjs` /
 *     `check-root-guards.mjs`）自己**不认** nonce（它们不在本泳道名下）。所以这条绑定是
 *     "本步的检查器回显了本步的一次性 nonce"，不是"runner 进程自己报了 nonce"。
 *   · 步骤内的一切都以同一个 uid 运行：能**实时监视**文件系统/`/proc` 的进程仍可伪造
 *     （随机目录名与 nonce 只挡住"预先布置"和"猜路径"这一类）。真正的结构性收口是
 *     `scripts/check-install-integrity.mjs`（判据本体在 install 期不可被改写）+ 判据执行体
 *     按 HEAD 字节恢复，本脚本只负责把凭据从"流属性"抬成"步骤独占文件 + 一次性 nonce"。
 *
 * 用法：
 * ```bash
 * node scripts/check-verdict-credential.mjs --dir "$verdict_dir" --nonce "$nonce" \
 *   --status "$status" --pattern '^check-workspaces: VERDICT PASS planned=[0-9]+ executed=[0-9]+' \
 *   --min planned 1 --equal planned executed
 * ```
 * 退出码：0 = 通过；1 = 断言失败；2 = 用法/输入错误（读不出目录或文件）。
 */

import { appendFileSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

/**
 * 允许出现在通过凭据里的**判据名**（pattern 至少要说清是哪一条判据在通过）。
 *
 * 这是一条"不要把断言写得太弱"的下限：`--pattern` 必须行首锚定、长度 ≥ 16 且命中这组里的
 * 一条 —— 否则 `--pattern '.'` 这种写法会把整个检查器变成恒真的空壳。
 */
const CREDENTIAL_ANCHORS = ['VERDICT PASS', ': OK — ']

/**
 * 解析 `key=<数字>`（从凭据行里抽）。
 * @param line - 凭据行。
 * @param key - 计数键名。
 * @returns 数字；抽不到 ⇒ `null`。
 */
function counterOf(line, key) {
  const pattern = new RegExp(`(?:^|[\\s(（])${key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}=(\\d+)`, 'u')
  const match = pattern.exec(line)
  return match === null ? null : Number(match[1])
}

/**
 * 判据主流程。
 * @param argv - 命令行参数。
 * @returns 退出码。
 */
function main(argv) {
  const options = { dir: null, nonce: null, 'nonce-file': null, status: null, pattern: null, since: null, mins: [], equals: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const take = count => {
      const values = argv.slice(index + 1, index + 1 + count)
      if (values.length !== count || values.some(value => value === undefined || value.startsWith('--'))) return null
      index += count
      return values
    }
    if (argument === '--dir' || argument === '--nonce' || argument === '--nonce-file' || argument === '--status'
      || argument === '--pattern' || argument === '--since') {
      const values = take(1)
      if (values === null) {
        process.stderr.write(`check-verdict-credential: \`${argument}\` 需要一个取值\n`)
        return 2
      }
      options[argument.slice(2)] = values[0]
      continue
    }
    if (argument === '--min' || argument === '--equal') {
      const values = take(2)
      if (values === null) {
        process.stderr.write(`check-verdict-credential: \`${argument}\` 需要两个取值\n`)
        return 2
      }
      if (argument === '--min') options.mins.push(values)
      else options.equals.push(values)
      continue
    }
    process.stderr.write(`check-verdict-credential: 未知参数 ${argument}\n`)
    return 2
  }

  const fail = message => {
    process.stderr.write(`check-verdict-credential: ${message}\n`)
    return 1
  }
  for (const [key, value] of Object.entries(options)) {
    if (key === 'mins' || key === 'equals') continue
    // `--nonce` 与 `--nonce-file` 二选一：步骤体更推荐后者（nonce 不进 argv / 不进日志）。
    if (key === 'nonce' && options['nonce-file'] !== null) continue
    if (key === 'nonce-file' && options.nonce !== null) continue
    // `--since` 可选：缺省取**独占目录自己的 mtime**（它由步骤体在起手处创建）。
    if (key === 'since') continue
    if (value === null) {
      process.stderr.write(`check-verdict-credential: 缺少 \`--${key}\`（凭据检查器的输入不完整 ⇒ 拒绝把"没得判"当成"通过"）\n`)
      return 2
    }
  }
  if (options['nonce-file'] !== null) {
    try {
      options.nonce = readFileSync(options['nonce-file'], 'utf8').trim()
    } catch (error) {
      process.stderr.write(`check-verdict-credential: 读不到 --nonce-file ${options['nonce-file']}：${error.message}\n`)
      return 2
    }
  }
  if (!/^[0-9a-f]{16,}$/u.test(options.nonce)) {
    process.stderr.write('check-verdict-credential: `--nonce` 必须是 ≥16 位的十六进制串'
      + '（它把凭据绑到**这一步**：不可预知、一次性）\n')
    return 2
  }
  if (typeof options.pattern !== 'string' || !options.pattern.startsWith('^')
    || options.pattern.length < 16 || !CREDENTIAL_ANCHORS.some(anchor => options.pattern.includes(anchor))) {
    process.stderr.write('check-verdict-credential: `--pattern` 太弱（必须 `^` 行首锚定、长度 ≥ 16、'
      + `且点名判据的通过凭据形态之一：${CREDENTIAL_ANCHORS.map(anchor => `\`${anchor}\``).join(' / ')}）`
      + '—— 否则这条断言会退化成恒真\n')
    return 2
  }

  // ① 步骤独占目录：0700 + 属主是本进程 euid。
  let dirStats
  try {
    dirStats = statSync(options.dir)
  } catch (error) {
    process.stderr.write(`check-verdict-credential: 读不到 --dir ${options.dir}：${error.message}\n`)
    return 2
  }
  if (!dirStats.isDirectory()) return fail(`--dir 不是目录：${options.dir}`)
  if ((dirStats.mode & 0o777) !== 0o700) {
    return fail(`--dir 的权限是 ${(dirStats.mode & 0o777).toString(8)}（必须是 700：这个目录属于本步独占，`
      + '同 job 里别的进程猜不到路径）')
  }
  if (typeof process.getuid === 'function' && dirStats.uid !== process.getuid()) {
    return fail(`--dir 的属主 uid=${dirStats.uid} 不是当前 euid=${process.getuid()}`)
  }
  // 名字里必须有**足够长的随机段**（步骤体用 `$SRANDOM$SRANDOM$RANDOM` 生成）：随机的
  // 目录名是"install 步留下的进程猜不到它"的全部依据，退化成一个可预测的名字就退回旧形态。
  const basename = options.dir.split('/').filter(part => part !== '').pop() ?? ''
  if (!/^[A-Za-z]+-\d{10,}$/u.test(basename)) {
    return fail(`--dir 的名字 ${JSON.stringify(basename)} 不像"步骤独占的随机目录"（要求 \`<前缀>-<≥10 位数字>\`）`
      + '—— 随机的名字是"前序步骤留下的进程猜不到它"这条判据的承重面')
  }

  // ② stdout 捕获文件：常规文件（不是符号链接）+ 属主 + mtime 属于本步。
  const stdoutPath = join(options.dir, 'stdout')
  let fileStats
  try {
    const linkStats = lstatSync(stdoutPath)
    if (linkStats.isSymbolicLink()) return fail(`${stdoutPath} 是一个**符号链接**（凭据文件必须是本步创建的常规文件）`)
    fileStats = statSync(stdoutPath)
  } catch (error) {
    process.stderr.write(`check-verdict-credential: 读不到 ${stdoutPath}：${error.message}\n`)
    return 2
  }
  if (!fileStats.isFile()) return fail(`${stdoutPath} 不是常规文件`)
  if (typeof process.getuid === 'function' && fileStats.uid !== process.getuid()) {
    return fail(`${stdoutPath} 的属主 uid=${fileStats.uid} 不是当前 euid=${process.getuid()}`)
  }
  // `--since` 缺省时取**目录**的 mtime：目录是步骤体在起手处创建的，它天然就是"本步起点"。
  const since = options.since === null ? dirStats.mtimeMs : Number(options.since)
  if (!Number.isFinite(since)) {
    process.stderr.write('check-verdict-credential: `--since` 必须是毫秒时间戳\n')
    return 2
  }
  {
    {
    // 2s 容差：容器/runner 上文件系统时间戳与 shell 取时的粒度不同，不放容差会偶发假红。
    if (fileStats.mtimeMs < since - 2000) {
      return fail(`${stdoutPath} 的 mtime(${Math.round(fileStats.mtimeMs)}) 早于本步起点(${Math.round(since)}) —— `
        + '这个文件不是本步创建的（前序步骤留下的进程预置了它）')
    }
    }
  }

  // ③ 退出码。
  if (String(options.status).trim() !== '0') {
    return fail(`判据进程的退出码是 ${JSON.stringify(options.status)}（通过凭据只在退出码 0 时有意义）`)
  }

  // ④ 凭据在**本步自己的 stdout 捕获**里恰好一行。
  const lines = readFileSync(stdoutPath, 'utf8').split('\n')
  const pattern = new RegExp(options.pattern, 'u')
  const matched = lines.filter(line => pattern.test(line))
  if (matched.length !== 1) {
    const sample = matched.slice(0, 2).map(line => JSON.stringify(line.slice(0, 120))).join(' / ') || '（无）'
    return fail(`凭据在 ${stdoutPath} 里命中了 ${matched.length} 行（必须**恰好一行**）：${sample}\n`
      + '      ⇒ 0 行 = 判据没说出凭据（被拒绝运行 / 零任务 / 判决不可信）；'
      + '多行 = 这条流里出现了**第二个**说凭据的进程（launcher 打印 / 别的进程追加）')
  }
  const credential = matched[0]

  // ⑤ 计数断言（键从凭据行里抽；抽不到即失败 —— 不假装"没数字就是通过"）。
  const counters = {}
  for (const [key, value] of options.mins) {
    const actual = counterOf(credential, key)
    counters[key] = actual
    if (actual === null) return fail(`凭据行里抽不到 \`${key}=\`（--min ${key} ${value}）`)
    if (actual < Number(value)) return fail(`凭据行的 \`${key}=${actual}\` 小于下限 ${value}`)
  }
  for (const [left, right] of options.equals) {
    const a = counterOf(credential, left)
    const b = counterOf(credential, right)
    counters[left] = a
    counters[right] = b
    if (a === null || b === null) return fail(`凭据行里抽不到 \`${left}=\` / \`${right}=\``)
    if (a !== b) return fail(`凭据行的 \`${left}=${a}\` 与 \`${right}=${b}\` 不相等`)
  }

  const summary = Object.entries(counters)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
  const line = `picoaide-verdict: PASS nonce=${options.nonce} status=0 lines=1${summary === '' ? '' : ` ${summary}`}`
  process.stdout.write(`${line}\n`)
  if (typeof process.env.GITHUB_STEP_SUMMARY === 'string' && process.env.GITHUB_STEP_SUMMARY.trim() !== '') {
    try {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- ${line}\n`)
    } catch (error) {
      process.stderr.write(`check-verdict-credential: 写 $GITHUB_STEP_SUMMARY 失败（不影响判决）：${error.message}\n`)
    }
  }
  return 0
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const code = main(process.argv.slice(2))
  process.removeAllListeners('exit')
  process.removeAllListeners('beforeExit')
  process.exit(code)
}
