/**
 * 「本模块是不是被当作 CLI 直接执行」判据的门禁（2026-09-23 独立复审 N-2）。
 *
 * 现场形态（复审实测，本文件把它固化成判据）：
 *
 *     node <symlink-to-repo>/packages/host/desktop/scripts/package-linux.mjs
 *     # argv[1]         = <symlink-to-repo>/…/package-linux.mjs（Node **不**做 realpath）
 *     # import.meta.url = file:///<real-repo>/…/package-linux.mjs（Node 对主模块做了 realpath）
 *
 * 只比 `resolve(argv[1]) === fileURLToPath(import.meta.url)` 的判据在这种情况下判为
 * 假 ⇒ 脚本**静默 exit 0、什么都没做**（`yarn dist:linux` 会"成功但没有产物"）。
 * 本项目把这种失败模式登记为不可接受，所以这里有四层判据：
 *
 *   1. **场景可构造**（校准）：最小探针经符号链接目录调用时，旧判据确实输出
 *      "静默跳过" —— 否则下面的用例都是空转；
 *   2. **新判据认得出**：同一个探针改用 `isDirectInvocation()` 时判为直接执行；
 *   3. **真脚本端到端**：真入口 `package-linux.mjs` 经符号链接目录调用时必须**真的
 *      跑起来**（用一个非法的渠道 id 当信标：修前是静默 exit 0、零输出）；
 *   4. **判据与证据矛盾时 fail-loud**（`import.meta.main` 说明本模块就是主模块，
 *      路径判据却说不直接执行 ⇒ 抛错，不静默）。
 *
 * 外加一条**静态接线守卫**：scripts 下任何脚本都不许再写旧形态的比较，且
 * `package.json` 里以 `node scripts/...` 调用的每个入口都必须用共享判据 ——
 * 否则下一个人复制粘贴就把这个 bug 带回来。
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { canonicalFilePath, isDirectInvocation } from '../scripts/direct-invocation.mjs'

const desktopRoot = fileURLToPath(new URL('../', import.meta.url))
const scriptsDir = join(desktopRoot, 'scripts')
const repoRoot = resolve(desktopRoot, '..', '..', '..')
const helperPath = join(scriptsDir, 'direct-invocation.mjs')

/** 造一个"目录级符号链接"调用现场：`<work>/linked-repo -> repoRoot`。 */
function symlinkedRepo(): { work: string, linkedRepo: string } {
  const work = mkdtempSync(join(tmpdir(), 'dsh-symlink-'))
  const linkedRepo = join(work, 'linked-repo')
  symlinkSync(repoRoot, linkedRepo, 'dir')
  return { work, linkedRepo }
}

describe('isDirectInvocation（N-2 判据本体）', () => {
  it('同一路径判为真、无关路径判为假、没有 argv[1]（REPL/-e/stdin）判为假', () => {
    const self = pathToFileURL(helperPath).href
    expect(isDirectInvocation({ url: self }, helperPath)).toBe(true)
    expect(isDirectInvocation({ url: self }, join(scriptsDir, 'package-linux.mjs'))).toBe(false)
    expect(isDirectInvocation({ url: self }, undefined)).toBe(false)
    expect(isDirectInvocation({ url: self }, '')).toBe(false)
  })

  it('路径不存在时也给出确定性结果（回落到 resolve，而不是抛错）', () => {
    const missing = join(tmpdir(), 'dsh-does-not-exist-direct-invocation.mjs')
    expect(isDirectInvocation({ url: pathToFileURL(helperPath).href }, missing)).toBe(false)
    expect(canonicalFilePath(missing)).toBe(resolve(missing))
  })

  it('经符号链接目录调用时，两种写法指向同一文件（realpath 生效）', () => {
    const { work, linkedRepo } = symlinkedRepo()
    try {
      const viaLink = join(linkedRepo, 'packages', 'host', 'desktop', 'scripts', 'direct-invocation.mjs')
      // 前置：两条路径的**字面量**不同，否则这条用例空转。
      expect(viaLink).not.toBe(helperPath)
      expect(canonicalFilePath(viaLink)).toBe(canonicalFilePath(helperPath))
      expect(isDirectInvocation({ url: pathToFileURL(helperPath).href }, viaLink)).toBe(true)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('判据说"否"而证据说"argv[1] 就是本文件"时 fail-loud（不静默放过）', () => {
    // 形态：Node 的 import.meta.main 为真（本模块就是主模块），但路径判据给出"否"。
    // 这正是"判据被改坏"（例如有人把 realpath 拆掉）时会出现的组合。
    const self = pathToFileURL(helperPath).href
    expect(() => isDirectInvocation({ url: self, main: true }, join(scriptsDir, 'package-dir.mjs')))
      .toThrow(/fail-loud|文件身份/u)
    // 反向保证：证据为假时正常返回 false —— 被 import 的场景不会被误判成错误。
    expect(isDirectInvocation({ url: self, main: false }, join(scriptsDir, 'package-dir.mjs'))).toBe(false)
  })
})

describe('符号链接调用现场（先证明场景可构造，再验新判据）', () => {
  /** 旧判据的最小复刻：只比 resolve()，不比 realpath。 */
  const legacyProbe = [
    "import { resolve } from 'node:path'",
    "import { fileURLToPath } from 'node:url'",
    'const invoked = process.argv[1]',
    'const direct = invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)',
    "console.log(direct ? 'RAN' : 'SILENT-SKIP')",
    '',
  ].join('\n')

  /** 新判据的探针：同样打印判定结果。 */
  const currentProbe = [
    `import { isDirectInvocation } from ${JSON.stringify(pathToFileURL(helperPath).href)}`,
    "console.log(isDirectInvocation(import.meta) ? 'RAN' : 'SILENT-SKIP')",
    '',
  ].join('\n')

  /** 把探针写成 `<work>/probe/probe.mjs`，再经 `<work>/probe-link`（目录符号链接）跑一次。 */
  function runProbe(work: string, source: string): { direct: string, viaLink: string } {
    const dir = join(work, 'probe')
    const link = join(work, 'probe-link')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'probe.mjs'), source)
    symlinkSync(dir, link, 'dir')
    const direct = spawnSync(process.execPath, [join(dir, 'probe.mjs')], { encoding: 'utf8' })
    const linked = spawnSync(process.execPath, [join(link, 'probe.mjs')], { encoding: 'utf8' })
    return { direct: direct.stdout.trim(), viaLink: linked.stdout.trim() }
  }

  it('旧判据在符号链接目录下判为假（= 静默 exit 0 的现场，即修前的失败形态）', () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-probe-'))
    try {
      const result = runProbe(work, legacyProbe)
      // 直接调用正常、经链接调用"静默跳过"—— 这个差异就是 N-2 的全部机制。
      expect(result.direct).toBe('RAN')
      expect(result.viaLink).toBe('SILENT-SKIP')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('共享判据在两种调用形态下都判为直接执行', () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-probe-'))
    try {
      const result = runProbe(work, currentProbe)
      expect(result.direct).toBe('RAN')
      expect(result.viaLink).toBe('RAN')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('真入口经符号链接目录调用时必须真的跑起来（修前：静默 exit 0、零输出）', () => {
    // 非法渠道 id 是"确实跑到业务代码"的信标：判定为"非直接执行"时脚本什么都不做
    // （exit 0、零输出），判定为直接执行时渠道解析 fail-loud。
    const { work, linkedRepo } = symlinkedRepo()
    try {
      const script = join(linkedRepo, 'packages', 'host', 'desktop', 'scripts', 'package-linux.mjs')
      const result = spawnSync(process.execPath, [script, '--no-prebuild'], {
        encoding: 'utf8',
        env: { ...process.env, DSH_BUILD_CHANNEL: 'NOT_A_VALID_ID' },
      })
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
      expect(output, '经符号链接调用时脚本什么都没做（静默 exit 0）').not.toBe('')
      expect(result.status).not.toBe(0)
      expect(output).toMatch(/不是合法渠道 id/u)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})

describe('scripts 下不得再出现旧形态的直接执行判据（静态接线守卫）', () => {
  const scriptFiles = readdirSync(scriptsDir)
    .filter(name => (name.endsWith('.mjs') || name.endsWith('.ts')) && !name.endsWith('.d.mts'))
    .sort()

  /** 去掉注释再匹配：旧写法会出现在"说明它为什么错"的文档注释里。 */
  function codeOnly(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^[ \t]*\/\/.*$/gmu, '')
  }

  it('没有任何脚本再写 resolve(argv[1]) === fileURLToPath(import.meta.url) 这类比较', () => {
    const legacy = /(?:resolve\(invokedPath\)|resolve\(process\.argv\[1\]\)|invokedPath)\s*===\s*(?:resolve\()?fileURLToPath\(import\.meta\.url\)/u
    const offenders = scriptFiles.filter(name => legacy.test(codeOnly(readFileSync(join(scriptsDir, name), 'utf8'))))
    // 判据是"名单为空"，不是"至少没全在"：旧形态一律红。
    expect(offenders).toEqual([])
  })

  it('引用 process.argv[1] 的脚本必须用共享判据', () => {
    // `direct-invocation.mjs` 自己是判据实现（argv[1] 是它的缺省参数），排除。
    const offenders = scriptFiles
      .filter(name => name !== 'direct-invocation.mjs')
      .filter(name => readFileSync(join(scriptsDir, name), 'utf8').includes('process.argv[1]'))
      .filter(name => !readFileSync(join(scriptsDir, name), 'utf8').includes('isDirectInvocation(import.meta)'))
    expect(offenders).toEqual([])
  })

  it('package.json 里带直接执行守卫的入口都用共享判据', () => {
    const manifest = JSON.parse(readFileSync(join(desktopRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    const entries = new Set<string>()
    for (const command of Object.values(manifest.scripts ?? {})) {
      for (const match of command.matchAll(/node\s+(scripts\/[\w./-]+)/gu)) entries.add(match[1]!)
    }
    // 前置：确实从 package.json 解析到了 CLI 入口，否则这条判据空转。
    expect(entries.size).toBeGreaterThan(5)
    const offenders = [...entries].filter((rel) => {
      const source = readFileSync(join(desktopRoot, rel), 'utf8')
      // 无条件执行的入口（没有守卫）本来就安全；有守卫的必须用共享判据。
      if (!source.includes('process.argv[1]')) return false
      return !source.includes('isDirectInvocation(import.meta)')
    })
    expect(offenders).toEqual([])
  })
})
