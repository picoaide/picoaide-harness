#!/usr/bin/env node
/**
 * 「冻结启动器」的**行为探针**（第十三轮 R13-D-02 的收口件）。
 *
 * ## 现场（为什么静态判据不够）
 *
 * R13-D-02 的实测载荷**不碰 git、不改任何被跟踪文件**：只把假 `node` 目录写进
 * `$GITHUB_PATH`（那行写在某个 `.sh` 里 ⇒ 读 YAML 的静态判据看不见）⇒ 探针 / 编排器 /
 * **凭据检查器**三次 `node` 调用全部被替换，假 `node` 按 `--nonce-file` 自己把凭据回显回去，
 * 于是 `EXIT=0`、工作树干净、日志里凭据"齐全"。
 *
 * ## 收口（首选形态，本脚本证明它真的成立）
 *
 * **第一个执行体**（在任何仓内代码跑过之前）把 `command -v node/bash/git` 的**绝对路径**与
 * 当时的 `$PATH` 写进**步骤输出**（`$GITHUB_OUTPUT`）。步骤输出在步骤结束时被 runner 读走、
 * 存进 runner 自己的内存；后续步骤里的仓内进程**改不到**它 —— 于是：
 *   · 判据步一律用 `"${{ steps.frozen-launchers.outputs.node }}"`（runner 侧展开的绝对路径）调用 node；
 *   · 每个判据步体开头 `export PATH="${{ steps.frozen-launchers.outputs.path }}"`，
 *     让 `git`/`openssl`/`bash` 也回到冻结那一刻的解析面。
 *
 * 本脚本做的**不是**再写一遍静态判据（那是 `check-workflows.mjs` 的 [SK-20]），而是把上面
 * 两件事**真的跑一遍**，并带一个**正控**（把冻结点拆掉 ⇒ 同一个载荷必须能把判据换掉）——
 * 没有正控的探针只能证明"绿"，证明不了"它抓得住"。
 *
 * ## 残余边界（认账，不许写成"完全收口"）
 *
 * GitHub 托管 runner 上 runner 用户有**免密 sudo**（官方文档明说），同 job 内任意代码
 * 理论上仍可替换**任何主机侧路径**（`/usr/bin/node`、`/opt/hostedtoolcache/…`）。
 * 本判据收口的是 **`$PATH` 注入**这条**低成本**通道（一行 `echo … >> "$GITHUB_PATH"`，
 * 不需要任何权限提升、不改任何文件）；它不承诺"启动器不可被替换"。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-frozen-launchers.mjs --root "$PWD"      # CI：gate-guards 的一个判据步
 * ```
 *
 * `--workflow <path>`（缺省 `.github/workflows/ci.yml`）、`--freeze-step-id <id>`
 * （缺省 `frozen-launchers`）、`--json <path>`。
 * 退出码：0 = 通过；1 = 断言失败（冻结未生效 / 正控抓不到载荷）；2 = 输入不可用。
 */

import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 正控/反控共用的假 `node`：留下标记文件，并打印一条"看起来通过"的凭据。 */
const FAKE_NODE_SOURCE = `#!/bin/sh
printf '%s\\n' "$0 $*" >> "\${FAKE_NODE_MARKER:?}"
printf 'check-install-integrity: VERDICT PASS judge-bodies=99 manifests=99 head=deadbeefcafe github-sha=%s\\n' "\${GITHUB_SHA:-0}"
exit 0
`

/**
 * 从 workflow 文本里抽出某个步骤的 `run:` 块体（**缩进扫描**，不需要 YAML 解析器）。
 *
 * 为什么要自己抽：本探针要执行的正是 **ci.yml 里那一段真字节**（不是另写一份"等价"的），
 * 否则它证明的是探针自己而不是产线。步骤定位按 `- name:` 的**逐字**匹配。
 * @param text - workflow 文本。
 * @param stepName - 步骤名（逐字）。
 * @returns 步骤体的行数组（已去掉公共缩进）；找不到 ⇒ `null`。
 */
export function extractStepRunBody(text, stepName) {
  const lines = String(text).split('\n')
  const anchor = lines.findIndex(line => /^\s*-\s*name:\s*/u.test(line) && line.includes(stepName))
  if (anchor < 0) return null
  let runIndex = -1
  for (let index = anchor + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s*-\s*(name|uses|id):/u.test(line)) break
    if (/^\s*(?:-\s*)?run:\s*\|/u.test(line)) { runIndex = index; break }
    if (/^\s*(?:-\s*)?run:\s*\S/u.test(line)) { runIndex = index; break }
  }
  if (runIndex < 0) return null
  const runIndent = /^(\s*)/u.exec(lines[runIndex])[1].length
  const inline = /^\s*(?:-\s*)?run:\s*(\S.*)$/u.exec(lines[runIndex])
  // `run: |` / `run: >` 是块标量指示符，不是内联脚本（`|` 也是 `\S` ⇒ 必须先排掉）。
  if (inline !== null && !/^[|>]/u.test(inline[1])) return [inline[1]]
  const body = []
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() !== '' && /^(\s*)/u.exec(line)[1].length <= runIndent) break
    body.push(line)
  }
  const indents = body.filter(line => line.trim() !== '').map(line => /^(\s*)/u.exec(line)[1].length)
  const common = indents.length === 0 ? 0 : Math.min(...indents)
  return body.map(line => line.slice(common))
}

/**
 * 抽出一个**顶层** `key:` 标量（用于取步骤的 `id:`）。只用于自检与提示，不参与判决。
 * @param text - workflow 文本。
 * @param stepName - 步骤名。
 * @param key - 键名。
 * @returns 取值；找不到 ⇒ `null`。
 */
export function stepScalar(text, stepName, key) {
  const lines = String(text).split('\n')
  const anchor = lines.findIndex(line => /^\s*-\s*name:\s*/u.test(line) && line.includes(stepName))
  if (anchor < 0) return null
  for (let index = anchor; index < lines.length; index += 1) {
    if (index > anchor && /^\s*-\s*(name|uses):/u.test(lines[index])) break
    const value = scalarOnLine(lines[index], key)
    if (value !== null) return value
  }
  return null
}

/**
 * 读一行里的**顶层 `key: 取值`** 标量。
 *
 * **不要**改回 `new RegExp(\`^\\s*${key}:…\`)`：`key` 与待比较的取值都来自调用方 /
 * 命令行参数，动态构造 RegExp 会被 CodeQL 判为 `js/regex-injection`（high）——
 * 本仓的 Code Scanning 门禁会因此变红（第十三轮 PR #149 实测两条）。
 * 这里用**字面量正则 + 纯字符串比较**，语义与原来逐字相同：
 * 只认「可选前导空白 + 可选的 `- ` + `键:` + 非空取值」。
 *
 * @param line - 一行文本。
 * @param key - 键名（与捕获到的键做**字符串**比较，不进正则）。
 * @returns 取值（已 trim）；该行不是这个键 / 取值为空 ⇒ `null`。
 */
function scalarOnLine(line, key) {
  const match = /^\s*(?:-\s*)?([A-Za-z0-9_-]+):\s*(\S.*)?$/u.exec(line)
  if (match === null || match[1] !== key) return null
  if (match[2] === undefined) return null
  const value = match[2].trim()
  return value === '' ? null : value
}

/**
 * 跑判据主流程。
 * @param argv - 命令行参数。
 * @returns 退出码。
 */
function main(argv) {
  const options = { root: process.cwd(), workflow: '.github/workflows/ci.yml', freezeStepId: 'frozen-launchers', json: null }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = argv[index + 1]
    if (!['--root', '--workflow', '--freeze-step-id', '--json'].includes(argument)) {
      process.stderr.write(`check-frozen-launchers: 未知参数 ${argument}\n`)
      return 2
    }
    if (value === undefined || value.startsWith('--')) {
      process.stderr.write(`check-frozen-launchers: \`${argument}\` 需要一个取值\n`)
      return 2
    }
    index += 1
    if (argument === '--root') options.root = value
    else if (argument === '--workflow') options.workflow = value
    else if (argument === '--freeze-step-id') options.freezeStepId = value
    else options.json = value
  }

  const root = resolve(options.root)
  const workflowPath = resolve(root, options.workflow)
  if (!existsSync(workflowPath)) {
    process.stderr.write(`check-frozen-launchers: 读不到 workflow ${workflowPath}\n`)
    return 2
  }
  if (!existsSync(join(root, '.git'))) {
    process.stderr.write(`check-frozen-launchers: ${root} 不是 git 检出（判据步体会用 \`git show HEAD:\` 取探针）\n`)
    return 2
  }
  const workflowText = readFileSync(workflowPath, 'utf8')

  // 冻结步：按 `id:` 定位（名字可以改，id 是契约）。
  const freezeBody = extractStepRunBody(workflowText, `${options.freezeStepId}`) ?? null
  const freezeById = (() => {
    const lines = workflowText.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      if (scalarOnLine(lines[index], 'id') !== options.freezeStepId) continue
      // 往回找最近的 `- name:`，再用它抽 run 体。
      for (let back = index; back >= 0; back -= 1) {
        const match = /^\s*-\s*name:\s*(\S.*)$/u.exec(lines[back])
        if (match !== null) return extractStepRunBody(workflowText, match[1].trim())
      }
    }
    return null
  })()
  const freeze = freezeById ?? freezeBody
  if (freeze === null) {
    process.stderr.write(`check-frozen-launchers: ci.yml 里找不到 id 为 \`${options.freezeStepId}\` 的冻结步`
      + '（它是"第一个执行体把 node/bash/git 的绝对路径写进 $GITHUB_OUTPUT"那一步）\n')
    return 2
  }
  const judgeName = 'Judge execution bodies are pristine (runs before any yarn command)'
  const judgeBody = extractStepRunBody(workflowText, judgeName)
  if (judgeBody === null) {
    process.stderr.write(`check-frozen-launchers: ci.yml 里抽不出「${judgeName}」的步骤体\n`)
    return 2
  }

  const failures = []
  const notes = []

  // 冻结步必须是**第一个执行体**：它之前不得有别的 `run:` 步骤（`uses:` 不跑仓内代码）。
  {
    const lines = workflowText.split('\n')
    const idLine = lines.findIndex(line => scalarOnLine(line, 'id') === options.freezeStepId)
    let jobStart = 0
    for (let index = idLine; index >= 0; index -= 1) {
      if (/^ {2}[A-Za-z0-9_-]+:\s*$/u.test(lines[index])) { jobStart = index; break }
    }
    if (idLine < 0) failures.push(`找不到 \`id: ${options.freezeStepId}\` 的行`)
    else {
      // 只统计**执行仓内代码**的更早步骤（纯 `echo`/`exit` 的链路步不算：它跑不到仓内代码，
      // 也就不可能改写 PATH/环境）。判据与 [SK-20] 的同一份口径。
      const earlierRunSteps = []
      let cursor = jobStart
      while (cursor < idLine) {
        const start = lines.findIndex((line, index) => index >= cursor && index < idLine && /^\s*(?:-\s*)?run:/u.test(line))
        if (start < 0) break
        const indent = /^(\s*)/u.exec(lines[start])[1].length
        let stop = start + 1
        while (stop < idLine && (lines[stop].trim() === '' || /^(\s*)/u.exec(lines[stop])[1].length > indent)) stop += 1
        const body = lines.slice(start, stop).join('\n')
        if (/(?:^|[\s;&|(])(?:node|yarn|corepack|bash|sh)\s|(?:^|[\s;&|(])"?\.?\/?(?:scripts|packages)\//u.test(body)) {
          earlierRunSteps.push(start + 1)
        }
        cursor = stop
      }
      if (earlierRunSteps.length > 0) {
        failures.push(`冻结步之前还有 ${earlierRunSteps.length} 个**执行仓内代码**的步骤（行 ${earlierRunSteps.join('、')}）——`
          + '冻结必须是第一个执行体（在那之前跑过的东西都可以改写 `$PATH`/`$GITHUB_ENV`，冻结出来的就是被污染的值）')
      } else notes.push('冻结步之前没有任何执行仓内代码的步骤')
    }
  }

  const scratch = mkdtempSync(join(tmpdir(), 'frozen-launcher-'))
  const work = join(scratch, 'work')
  const fakebin = join(scratch, 'fakebin')
  mkdirSync(work, { recursive: true })
  mkdirSync(fakebin, { recursive: true })
  const fakeNode = join(fakebin, 'node')
  writeFileSync(fakeNode, FAKE_NODE_SOURCE)
  chmodSync(fakeNode, 0o755)
  // 判据步体会在 `$RUNNER_TEMP` 下 `mkdir` 自己的独占目录 ⇒ 父目录必须先存在
  // （GitHub runner 上它本来就在；本地探针要自己建）。
  mkdirSync(join(scratch, 'runner-temp'), { recursive: true })

  const runShell = (script, env, cwd = work) => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
    cwd,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { HOME: scratch, ...env },
  })

  // 平台锚值：CI 上必须用 `$GITHUB_SHA`（runner 注入、仓内代码改不到）；本地没有它时
  // 退回本地 HEAD —— 否则把**空串**喂给判据步体会让 `check-install-integrity` 判
  // 「平台锚缺席」而 exit 2，探针在本地永远红（第十三轮修复批自测时踩到）。
  const headRev = runShell('git rev-parse HEAD', { PATH: process.env.PATH ?? '/usr/bin:/bin' }, root)
  const anchorSha = (process.env.GITHUB_SHA ?? '').trim() !== ''
    ? String(process.env.GITHUB_SHA).trim()
    : String(headRev.stdout ?? '').trim()

  try {
    // ① 跑**冻结步体本身**（未做任何替换：它的形态就是产线形态）。
    const outputFile = join(scratch, 'github-output')
    writeFileSync(outputFile, '')
    const freezeRun = runShell(String(freeze.join('\n')), {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      GITHUB_OUTPUT: outputFile,
      GITHUB_PATH: join(scratch, 'github-path'),
      GITHUB_ENV: join(scratch, 'github-env'),
      RUNNER_TEMP: join(scratch, 'runner-temp'),
      GITHUB_SHA: anchorSha,
    })
    if (freezeRun.status !== 0) {
      process.stderr.write(`check-frozen-launchers: 冻结步体 EXIT=${freezeRun.status}\n${freezeRun.stdout}\n${freezeRun.stderr}\n`)
      return 2
    }
    const outputs = {}
    for (const line of readFileSync(outputFile, 'utf8').split('\n')) {
      const match = /^([A-Za-z_][A-Za-z0-9_-]*)=(.*)$/u.exec(line)
      if (match !== null) outputs[match[1]] = match[2]
    }
    for (const key of ['node', 'interp', 'git', 'path']) {
      if (typeof outputs[key] !== 'string' || outputs[key].trim() === '') {
        failures.push(`冻结步没有写出 \`${key}\` 输出（步骤输出是"后续步骤改不到"的那份值）`)
      }
    }
    for (const key of ['node', 'interp', 'git']) {
      const value = outputs[key] ?? ''
      if (value !== '' && !value.startsWith('/')) failures.push(`冻结输出 \`${key}=${value}\` 不是绝对路径`)
    }

    // ② 攻击侧：把假 `node` 目录 prepend 到 PATH（复刻 `$GITHUB_PATH` 注入的效果），
    //    再跑**同一段判据步体**（把 runner 展开的 `${{ … }}` 换成冻结值）。
    const judgeTemplate = judgeBody.join('\n')
    if (!judgeTemplate.includes(`steps.${options.freezeStepId}.outputs.node`)) {
      failures.push(`判据步体里没有出现 \`steps.${options.freezeStepId}.outputs.node\` ——`
        + '判据的启动器必须是 runner 侧展开的冻结值（用裸 `node` 就等于把启动器交给 PATH）')
    }
    const substituted = judgeTemplate
      .replaceAll(`\${{ steps.${options.freezeStepId}.outputs.node }}`, outputs.node ?? 'node')
      .replaceAll(`\${{ steps.${options.freezeStepId}.outputs.bash }}`, outputs.bash ?? 'bash')
      .replaceAll(`\${{ steps.${options.freezeStepId}.outputs.git }}`, outputs.git ?? 'git')
      .replaceAll(`\${{ steps.${options.freezeStepId}.outputs.path }}`, outputs.path ?? '')
    const marker = join(scratch, 'fake-node-used')
    const judgeRun = runShell(substituted, {
      PATH: `${fakebin}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
      RUNNER_TEMP: join(scratch, 'runner-temp'),
      FAKE_NODE_MARKER: marker,
      GITHUB_SHA: anchorSha,
    }, root)
    const fakeUsed = existsSync(marker)
    const stdout = judgeRun.stdout ?? ''
    if (fakeUsed) {
      failures.push(`**冻结启动器没有生效**：判据步仍然执行了被注入的假 \`node\`（标记文件 ${marker} 存在）\n`
        + `      ⇒ 假 node 会自己回显凭据：\`${readFileSync(marker, 'utf8').split('\n')[0]}\``)
    } else {
      const passed = stdout.includes('check-install-integrity: VERDICT PASS')
      // 「真判据在跑」的证据 = 它自己的输出前缀出现在两个流里。**不能**只看 PASS 行：
      // 本地脏树（工作树 ≠ HEAD）上真判据会红，而那恰恰证明跑的是真判据而不是假 node。
      const judgeRan = /check-install-integrity:/u.test(stdout) || /check-install-integrity:/u.test(judgeRun.stderr ?? '')
      const platformAnchor = (process.env.GITHUB_SHA ?? '').trim() !== ''
      if (!judgeRan) {
        failures.push('判据步既没用假 node，也没跑到真判据 ⇒ 它什么都没跑（EXIT='
          + `${judgeRun.status}）\n      stdout: ${JSON.stringify(stdout.slice(0, 400))}\n`
          + `      stderr: ${JSON.stringify((judgeRun.stderr ?? '').slice(0, 400))}`)
      } else if (!passed && platformAnchor) {
        // CI 语境（平台给了 GITHUB_SHA）：检出树应当等于 HEAD ⇒ 判据必须 PASS。
        failures.push('判据步跑到了真判据但**没有通过凭据**（EXIT='
          + `${judgeRun.status}）—— CI 上检出树应当等于 HEAD，这里必须 PASS\n`
          + `      stderr: ${JSON.stringify((judgeRun.stderr ?? '').slice(0, 400))}`)
      } else if (!passed) {
        notes.push(`冻结启动器生效：PATH 前置了假 \`node\`（${fakebin}）之后，判据步仍跑**真**判据`
          + `（EXIT=${judgeRun.status}，本地脏树上判据本身会红，属预期；CI 上要求 PASS）`)
      } else {
        notes.push(`冻结启动器生效：PATH 前置了假 \`node\`（${fakebin}）之后，判据步仍跑真判据并打印通过凭据（EXIT=${judgeRun.status}）`)
      }
    }

    // ③ **正控**：把冻结拆掉（裸 `node` + 不重置 PATH），同一个载荷必须能把判据换掉。
    //    没有这一格的探针只能证明"绿"，证明不了"它抓得住"。
    //    正控把**所有**冻结表达式换回裸命令名（node/interp→bash/git）—— 只换 node 会让
    //    `"${{ …git }}" show HEAD:` 变成"命令找不到"，正控就测不到"载荷能不能换掉启动器"。
    const plain = { node: 'node', interp: 'bash', git: 'git' }
    const controlBody = judgeTemplate.replace(
      /"\$\{\{\s*steps\.[A-Za-z0-9_-]+\.outputs\.([A-Za-z0-9_-]+)\s*\}\}"/gu,
      (match, key) => plain[key] ?? match,
    )
    const controlMarker = join(scratch, 'fake-node-used-control')
    const controlRun = runShell(controlBody, {
      PATH: `${fakebin}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
      RUNNER_TEMP: join(scratch, 'runner-temp'),
      FAKE_NODE_MARKER: controlMarker,
      GITHUB_SHA: anchorSha,
    }, root)
    if (!existsSync(controlMarker)) {
      failures.push('**正控失败**：把冻结拆除之后，假 `node` 仍然没有被执行 ⇒ 本探针抓不到"PATH 注入换启动器"'
        + '这条载荷（它测不出任何东西：绿是恒绿）\n'
        + `      正控 EXIT=${controlRun.status}`)
    } else {
      notes.push('正控成立：拆除冻结后同一个载荷确实替换掉了启动器（假 node 被调用）'
        + `⇒ 上面的"绿"有判别力（正控 EXIT=${controlRun.status}）`)
    }

    if (options.json !== null) {
      writeFileSync(options.json, `${JSON.stringify({
        freezeOutputs: outputs,
        judgeExit: judgeRun.status,
        fakeLauncherUsedUnderFreeze: fakeUsed,
        fakeLauncherUsedWithoutFreeze: existsSync(controlMarker),
        failures,
        notes,
      }, null, 2)}\n`)
    }

    if (failures.length > 0) {
      for (const detail of failures) process.stderr.write(`\ncheck-frozen-launchers: ${detail}\n`)
      process.stderr.write(`\ncheck-frozen-launchers: ${failures.length} 项未通过\n`)
      return 1
    }
    process.stdout.write(`check-frozen-launchers: VERDICT PASS frozen=${options.freezeStepId}`
      + ` node=${outputs.node} probes=2\n`)
    for (const note of notes) process.stdout.write(`check-frozen-launchers: ${note}\n`)
    process.stdout.write('check-frozen-launchers: 诚实边界 — 本判据收口的是 `$PATH` 注入这条**低成本**通道；'
      + 'GitHub 托管 runner 上 runner 用户有免密 sudo，同 job 内任意代码理论上仍可替换任何主机侧路径'
      + '（本判据不承诺"启动器不可被替换"，只承诺"PATH 注入换不掉判据的启动器"）。\n')
    return 0
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const code = main(process.argv.slice(2))
  process.removeAllListeners('exit')
  process.removeAllListeners('beforeExit')
  process.exit(code)
}
