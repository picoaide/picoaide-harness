#!/usr/bin/env node
/**
 * Workflow gate: every `run:` shell block in `.github/workflows/*.yml` must parse.
 *
 * 为什么需要这个门禁(2026-09-10 审计教训):
 *   重写 CI 时往 `.github/workflows/ci.yml` 的 release job 里写进了两处未闭合的
 *   双引号(一处 `echo "…" "`、一处 escape 了引号却漏掉收尾引号)。YAML 本身
 *   是合法的(它们都在块标量里),所以 `yaml.safe_load` 结构校验、"CI 能不能
 *   跑"这类检查全都看不见;而 bash 解析整段脚本时才发现 EOF,step 直接 exit 2。
 *   两个 bug 都只在 tag 触发的 job 里,PR/分支 CI 全绿,直到发版才炸。
 *
 *   这类错误的唯一有效拦截点是 `bash -n`(只解析不执行)——本脚本把每个
 *   shell run 块拆出来逐个过一遍。
 *
 * 实现取舍:不引入 YAML 依赖(与 scripts/verify-layout.mjs 一致,根脚本只用
 * Node 内建模块)。这里只需要识别 GitHub Actions 用到的 YAML 子集:
 *
 *     jobs:
 *       <job>:                         # 缩进 2
 *         defaults:
 *           run:
 *             shell: pwsh              # job 级默认 shell
 *         steps:
 *           - name: …                  # 缩进 6
 *             shell: bash              # step 级 shell 覆盖
 *             run: |                   # 块标量,内容缩进更深
 *               set -euo pipefail
 *             run: single command      # 单行内联
 *
 * 防退化:任何 workflow 解析出 0 个 run 块都会被判为失败 —— 扫描器一旦失效
 * (格式变化/正则走样),门禁必须响,而不是静默放行。
 *
 * 用法:node scripts/check-workflows.mjs
 * 退出码:0 = 全部通过;1 = 有块解析失败或扫描器退化。
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const workflowDirectory = join(root, '.github', 'workflows')

/** shell 家族中本门禁不认识、因而跳过的那些(不是 sh/bash 方言)。 */
const NON_POSIX_SHELLS = /^(pwsh|powershell|cmd|python|node)\b/iu

/** 块标量头:`run: |` / `run: |-` / `run: >-` 等。 */
const BLOCK_SCALAR = /^(\s*)run:\s*([|>])[-+]?\s*$/u
/** 内联 `run: <命令>`。 */
const INLINE_RUN = /^(\s*)run:\s*(\S.*)$/u
/** `shell: <名字>`。 */
const SHELL_KEY = /^(\s*)shell:\s*(\S+)\s*$/u
/** `defaults:` 下的 `run:` 分组(job 级默认 shell 的父键)。 */
const JOB_KEY = /^ {2}([A-Za-z_][\w-]*):\s*$/u
const STEP_KEY = /^ {6}- /u

/**
 * 从一个 workflow 文本里抽出全部 shell run 块。
 * @param text - workflow 文件内容。
 * @returns 块列表,每项含 shell、内容与起始行号(1-based)。
 */
export function extractRunBlocks(text) {
  const lines = text.split(/\r?\n/u)
  const blocks = []
  let jobDefaultShell
  let currentJob

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]

    const jobMatch = JOB_KEY.exec(line)
    if (jobMatch !== null) {
      currentJob = jobMatch[1]
      jobDefaultShell = undefined
    }
    if (STEP_KEY.test(line) && currentJob !== undefined) {
      // 新 step:step 级 shell 覆盖在下面按行就近读取
      continue
    }

    // job 级默认 shell:`defaults.run.shell`
    const shellMatch = SHELL_KEY.exec(line)
    if (shellMatch !== null) {
      const indent = shellMatch[1].length
      if (indent >= 8 && indent <= 12) jobDefaultShell = shellMatch[2]
      continue
    }

    const blockMatch = BLOCK_SCALAR.exec(line)
    if (blockMatch !== null) {
      const parentIndent = blockMatch[1].length
      const startLine = index + 2 // 块内容从下一行开始
      const body = []
      let cursor = index + 1
      for (; cursor < lines.length; cursor += 1) {
        const candidate = lines[cursor]
        if (candidate.trim() === '') {
          body.push('')
          continue
        }
        const indent = candidate.length - candidate.trimStart().length
        if (indent <= parentIndent) break
        body.push(candidate)
      }
      // 去掉块标量自身的缩进(YAML 取块内最小缩进)
      const content = dedent(body)
      blocks.push({
        shell: nearestShell(lines, index, jobDefaultShell),
        content: content.join('\n'),
        line: startLine,
      })
      index = cursor - 1
      continue
    }

    const inlineMatch = INLINE_RUN.exec(line)
    if (inlineMatch !== null) {
      blocks.push({
        shell: nearestShell(lines, index, jobDefaultShell),
        content: inlineMatch[2],
        line: index + 1,
      })
    }
  }

  return blocks
}

/**
 * 找与 `run:` 同一 step 的 shell 覆盖(块之前的最近一个更浅缩进的 shell:)。
 * @param lines - 文件所有行。
 * @param runIndex - `run:` 所在行下标。
 * @param fallback - job 级默认 shell(可能为 undefined)。
 * @returns 生效的 shell 名。
 */
function nearestShell(lines, runIndex, fallback) {
  const runIndent = lines[runIndex].length - lines[runIndex].trimStart().length
  for (let cursor = runIndex - 1; cursor >= 0; cursor -= 1) {
    const line = lines[cursor]
    if (line.trim() === '') continue
    const indent = line.length - line.trimStart().length
    if (indent < runIndent) break // 越过了本 step 的起点
    const match = SHELL_KEY.exec(line)
    if (match !== null && match[1].length === runIndent) return match[2]
  }
  return fallback ?? 'bash'
}

/**
 * 去掉块标量的公共缩进(YAML 块标量语义)。
 * @param body - 块内的原始行。
 * @returns 去缩进后的行。
 */
function dedent(body) {
  const indents = body
    .filter(line => line.trim() !== '')
    .map(line => line.length - line.trimStart().length)
  if (indents.length === 0) return []
  const common = Math.min(...indents)
  return body.map(line => (line.trim() === '' ? '' : line.slice(common)))
}

/**
 * 用 `bash -n` 解析一段脚本(不执行)。
 * @param content - 脚本内容。
 * @param file - 临时文件名(只为错误信息可读)。
 * @returns 解析错误信息;通过时为 null。
 */
function parseShell(content, file) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-workflow-check-'))
  const scriptPath = join(directory, file)
  try {
    writeFileSync(scriptPath, content)
    execFileSync('bash', ['-n', scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    return null
  } catch (cause) {
    const stderr = cause.stderr?.toString?.() ?? ''
    return stderr.trim() === '' ? String(cause.message ?? cause) : stderr.trim()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/**
 * 检查一个 workflow 文件。
 * @param name - 文件名。
 * @returns 失败项列表。
 */
export function checkWorkflow(name) {
  const path = join(workflowDirectory, name)
  const text = readFileSync(path, 'utf8')
  const failures = []

  // YAML 缩进不允许 tab;这类错误会让整个文件失效,先单独拦一道。
  if (/^\t|:\s*\t|\s\t/u.test(text)) {
    failures.push({ name, line: 0, detail: 'YAML 缩进中不允许出现 tab 字符' })
  }

  const blocks = extractRunBlocks(text)
  if (blocks.length === 0) {
    // 扫描器退化保护:一个 workflow 不可能没有任何 run 块。
    failures.push({ name, line: 0, detail: '未解析出任何 run 块 —— 扫描器可能已失效,请检查 extractRunBlocks' })
    return { failures, checked: 0 }
  }

  let checked = 0
  for (const block of blocks) {
    if (NON_POSIX_SHELLS.test(block.shell)) continue
    if (block.content.trim() === '') continue
    checked += 1
    const error = parseShell(block.content, `${name}.run.sh`)
    if (error !== null) failures.push({ name, line: block.line, detail: error })
  }

  return { failures, checked }
}

function main() {
  const names = readdirSync(workflowDirectory)
    .filter(entry => entry.endsWith('.yml') || entry.endsWith('.yaml'))
    .sort()
  if (names.length === 0) {
    process.stderr.write('check-workflows: .github/workflows 下没有找到任何 workflow\n')
    process.exit(1)
  }

  const failures = []
  let total = 0
  for (const name of names) {
    const result = checkWorkflow(name)
    failures.push(...result.failures)
    total += result.checked
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      const where = failure.line === 0 ? failure.name : `${failure.name}:${failure.line}`
      process.stderr.write(`\ncheck-workflows: ${where} 的 run 块无法解析\n`)
      process.stderr.write(`${failure.detail.split('\n').map(line => `  ${line}`).join('\n')}\n`)
    }
    process.stderr.write(`\ncheck-workflows: ${failures.length} 个 run 块未通过(共检查 ${total} 个)\n`)
    process.exit(1)
  }

  process.stdout.write(`check-workflows: OK — ${names.length} 个 workflow,${total} 个 shell run 块全部通过 bash -n\n`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main()
}
