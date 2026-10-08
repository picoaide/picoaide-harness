/**
 * 随包 agent 运行时（node + pnpm + python）的四层判据。
 *
 * ## 为什么需要这一层
 *
 * 客户端此前**不带包管理器**，于是上游文档里的作者化路径（「把能力打成 bundle，
 * 再用 `plugin_manager` 装」）在客户端上必然 `ENOENT`；agent 写代码/跑脚本时也没有
 * node/python 可用。2026-10-08 起三套官方预编译运行时随包分发（打包期由
 * `scripts/fetch-bundled-runtimes.mjs` 按 `runtimes.json` 钉死的版本/字节/sha256 就位，
 * `extraResources` 进 `resources/runtimes/`，启动时把 `runtimes/bin` 前置到 PATH）。
 *
 * 这条链路上每一环都能**静默失效**，所以四层各自有牙：
 *
 *  1. **客户端解析**（{@link describe} 第 1 块）：载荷缺失/清单坏/目标平台不符/入口不在
 *     ⇒ 返回 `undefined`（当作"没有随包运行时"），绝不返回指向不存在文件的路径；
 *     命中时 PATH 前置必须**幂等**、python 的两个"别写应用包"变量必须落位、
 *     `packageManager` 必须指向随包 pnpm（这才是 `install_bundle` 能跑的原因）。
 *  2. **afterPack 门禁**（第 2 块）：声明了载荷 ⇒ 产物里必须有，而且三个 shim 各**真跑
 *     一次**、版本逐字对、node 自报的 platform/arch 与清单一致 —— "文件在但跑不起来"
 *     （拿错平台、被截断、丢了可执行位、macOS 没重签）在存在性判据下全绿。
 *  3. **打包配置**（第 3 块）：`extraResources` 必须带载荷；Linux 的 `build.linux.files`
 *     必须显式排除 `build/runtimes` 整棵子树（Linux 的应用根匹配器会落回兜底全匹配，不排除就是
 *     "载荷进 asar 再来一份"的双份，240MiB 级别）。
 *  4. **接线**（第 4 块）：`src/main.ts` 必须在 **boot 之前**就位（PATH 只对之后 spawn 的
 *     子进程生效），并把结果交给 `desktopProfileContext`（内联字面量 = 冒烟测的不是生产路径）。
 *
 * 载荷本身（GB 级第三方二进制）不在仓库里：本文件里的"载荷"都是**合成夹具**（几个
 * 打印固定版本号的 shell 脚本），所以这套判据在任何机器上都能跑，也不依赖网络。
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BUNDLED_RUNTIMES_DIR,
  BUNDLED_RUNTIMES_MANIFEST,
  BUNDLED_RUNTIMES_SHIM_DIR,
  applyBundledRuntimeEnvironment,
  bundledPackageManager,
  bundledRuntimesLogLine,
  bundledRuntimeTarget,
  installBundledRuntimes,
  installBundledRuntimePath,
  resolveBundledRuntimes,
} from '../src/bundled-runtimes.ts'
import {
  BUNDLED_RUNTIMES_PAYLOAD_DIR,
  assertBundledRuntimesPackaged,
  bundledRuntimesBuildDir,
  normalizeProbedRuntimeTarget,
} from '../scripts/verify-packaged-runtime.ts'
import {
  assertRuntimeBudget,
  materializeBundledRuntimes,
  normalizeRuntimePlatform,
  prunePackagerSkippedNames,
  readRuntimePin,
  resolveRuntimeTarget,
  runtimeTreeDigest,
} from '../scripts/fetch-bundled-runtimes.mjs'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(packageRoot, '..', '..', '..')
// 宿主机的载荷目标键。**刻意不调用被测函数**（用它算期望值就等于没判据）：
// 这里只把 `win32 → win` 这条键名规则**独立写一遍**（Windows 上才会走到）。
const hostTarget = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`
const versions = { node: '99.1.2', pnpm: '98.3.4', python: '97.5.6' }

const temporaryDirs: string[] = []

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temporaryDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporaryDirs.push(dir)
  return dir
}

/** 写一个可执行的 POSIX 假命令。 */
function writeScript(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!/bin/sh\n${body}`, { mode: 0o755 })
  chmodSync(path, 0o755)
}

/**
 * 造一份**合成载荷**（三个入口是打印固定版本的 shell 脚本，行为按参数分派）。
 *
 * 布局与 `fetch-bundled-runtimes.mjs` 写出的那份一致：`<resources>/runtimes/`
 * 下有 `node/`、`pnpm/`、`python/`、`bin/`（shim）与 `manifest.json`（含树摘要）。
 * 合成夹具的好处：判据在任何机器上都能跑、不依赖网络，也不需要 GB 级真载荷。
 * @param options - 目标平台、省略某个入口、或改某个版本的输出。
 * @returns 载荷根、它的父目录（= `resourcesPath`）与清单。
 */
function syntheticPayload(options: {
  target?: string
  omit?: 'node' | 'pnpm' | 'python'
  versionOverride?: Partial<typeof versions>
  /**
   * 假 node 自报的 platform / arch（缺省 = 从 `target` 反推，`win` → `win32` 与真 node 同形）。
   * 用来构造"node 自报值与清单不符"的坏包。
   */
  reports?: { platform?: string, arch?: string }
} = {}): { root: string, resources: string, manifest: Record<string, unknown> } {
  const target = options.target ?? hostTarget
  const pinned = { ...versions, ...options.versionOverride }
  // 真 node 的 `process.platform` 在 Windows 上是 `win32`，而载荷键写 `win` —— 夹具也照这个
  // 形状自报，否则门禁的归一那一半在夹具上根本走不到。
  const targetPlatform = target.slice(0, target.lastIndexOf('-'))
  const targetArch = target.slice(target.lastIndexOf('-') + 1)
  const reportedPlatform = options.reports?.platform ?? (targetPlatform === 'win' ? 'win32' : targetPlatform)
  const reportedArch = options.reports?.arch ?? targetArch
  const resources = temporaryDir('dsh-payload-')
  const root = join(resources, BUNDLED_RUNTIMES_DIR)
  mkdirSync(root, { recursive: true })
  const commands = {
    node: 'node/bin/node',
    pnpm: 'pnpm/bin/pnpm.mjs',
    python: 'python/bin/python3',
  }
  // 真 node 的行为按参数分派：`-v` 报版本、`-p <表达式>` 按表达式报平台或架构
  //（门禁三条都跑，而且**表达式逐字**决定回答 —— 单参数硬编码会让"问平台"与"问架构"
  // 拿到同一个值，门禁的归一与比对就变成走过场）。
  const nodeScript = `case "$1" in\n`
    + `  -v) echo v${pinned.node} ;;\n`
    + `  -p) case "$2" in\n`
    + `    process.platform) echo ${reportedPlatform} ;;\n`
    + `    process.arch) echo ${reportedArch} ;;\n`
    + `    *) echo ${reportedPlatform} ;;\n`
    + `  esac ;;\n`
    + `  *) echo v${pinned.node} ;;\nesac\n`
  writeScript(join(root, commands.node), nodeScript)
  writeScript(join(root, commands.pnpm), `echo ${pinned.pnpm}\n`)
  writeScript(join(root, commands.python), `echo "Python ${pinned.python}"\n`)
  for (const key of ['node', 'pnpm', 'python'] as const) {
    if (options.omit === key) rmSync(join(root, commands[key]), { force: true })
  }
  // 再分发许可文本（三套运行时各一份：载荷里必须有、清单里必须记）。
  const licenses = (['node', 'pnpm', 'python'] as const).map(key => {
    const relative = `${key}/LICENSE`
    writeScript(join(root, relative), '')
    writeFileSync(join(root, relative), `license text for ${key}\n`)
    return { runtime: key, path: relative, bytes: statSync(join(root, relative)).size }
  })
  const bin = join(root, BUNDLED_RUNTIMES_SHIM_DIR)
  writeScript(join(bin, 'node'), nodeScript)
  writeScript(join(bin, 'pnpm'), `echo ${pinned.pnpm}\n`)
  writeScript(join(bin, 'python3'), `echo "Python ${pinned.python}"\n`)
  const manifest = {
    schema: 1,
    target,
    platform: target.slice(0, target.lastIndexOf('-')),
    arch: target.slice(target.lastIndexOf('-') + 1),
    versions: pinned,
    commands,
    shims: ['bin/node', 'bin/pnpm', 'bin/python3'],
    licenses,
    critical: [],
    tree: runtimeTreeDigest(root),
  }
  writeFileSync(join(root, BUNDLED_RUNTIMES_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
  // 清单写出后树摘要变了（清单自己也被排除在摘要之外），重算成自洽的那一份 ——
  // 与生产实现用的**同一份算法**（`runtimeTreeDigest` 从 .mjs 直接 import）。
  const tree = runtimeTreeDigest(root, [join(root, BUNDLED_RUNTIMES_MANIFEST)])
  const manifestWithTree = { ...manifest, tree }
  writeFileSync(join(root, BUNDLED_RUNTIMES_MANIFEST), `${JSON.stringify(manifestWithTree, null, 2)}\n`)
  return { root, resources, manifest: manifestWithTree }
}

describe('随包运行时的客户端解析与接线（src/bundled-runtimes.ts）', () => {
  it('载荷缺席（无 resourcesPath / 无清单 / 清单坏 / 目标不符 / 入口不在）一律返回 undefined', () => {
    expect(resolveBundledRuntimes({ resourcesPath: undefined })).toBeUndefined()
    expect(resolveBundledRuntimes({ resourcesPath: '' })).toBeUndefined()
    const empty = temporaryDir('dsh-empty-')
    expect(resolveBundledRuntimes({ resourcesPath: empty })).toBeUndefined()

    const broken = temporaryDir('dsh-broken-')
    mkdirSync(join(broken, BUNDLED_RUNTIMES_DIR), { recursive: true })
    writeFileSync(join(broken, BUNDLED_RUNTIMES_DIR, BUNDLED_RUNTIMES_MANIFEST), '{ not json')
    expect(resolveBundledRuntimes({ resourcesPath: broken })).toBeUndefined()

    const wrongTarget = syntheticPayload({ target: hostTarget === 'linux-x64' ? 'win-x64' : 'linux-x64' })
    expect(resolveBundledRuntimes({ resourcesPath: wrongTarget.resources })).toBeUndefined()

    const missingEntry = syntheticPayload({ omit: 'pnpm' })
    expect(resolveBundledRuntimes({ resourcesPath: missingEntry.resources })).toBeUndefined()
  })

  it('载荷齐备时给出三个入口的绝对路径、目标平台与版本', () => {
    const payload = syntheticPayload()
    const resolved = resolveBundledRuntimes({ resourcesPath: payload.resources })
    expect(resolved).toBeDefined()
    expect(resolved?.binDir).toBe(join(payload.root, BUNDLED_RUNTIMES_SHIM_DIR))
    expect(resolved?.node).toBe(join(payload.root, 'node/bin/node'))
    expect(resolved?.pnpm).toBe(join(payload.root, 'pnpm/bin/pnpm.mjs'))
    expect(resolved?.python).toBe(join(payload.root, 'python/bin/python3'))
    expect(resolved?.target).toBe(hostTarget)
    expect(resolved?.versions).toEqual(versions)
    expect(bundledRuntimeTarget(process.platform, process.arch)).toBe(hostTarget)
    expect(bundledRuntimesLogLine(resolved!)).toContain(versions.node)
  })

  it('PATH 前置幂等，并接上 pip 用户脚本目录；载荷缺席时一个字节都不改', () => {
    const payload = syntheticPayload()
    const resolved = resolveBundledRuntimes({ resourcesPath: payload.resources })!
    const home = temporaryDir('dsh-home-')
    const env: NodeJS.ProcessEnv = { PATH: ['/usr/bin', '/bin'].join(delimiter) }

    const first = installBundledRuntimePath(env, resolved, home)
    const second = installBundledRuntimePath(env, resolved, home)
    expect(second).toEqual(first)
    const parts = (env.PATH ?? '').split(delimiter)
    expect(parts[0]).toBe(resolved.binDir)
    expect(parts.filter(part => part === resolved.binDir)).toHaveLength(1)
    expect(parts.filter(part => part === '/usr/bin')).toHaveLength(1)
    // pip 装出来的命令行工具目录追加在最后（不遮蔽随包解释器与既有 PATH）。
    expect(parts[parts.length - 1]).toBe(join(home, 'python-user', 'bin'))

    const values = applyBundledRuntimeEnvironment(env, resolved, home)
    expect(values).toEqual({
      PYTHONPYCACHEPREFIX: join(home, 'python-cache'),
      PYTHONUSERBASE: join(home, 'python-user'),
    })
    expect(env.PYTHONUSERBASE).toBe(join(home, 'python-user'))

    // 载荷缺席：env 必须原样（不是"改成空"）。
    const untouched: NodeJS.ProcessEnv = { PATH: ['/usr/bin'].join(delimiter) }
    expect(installBundledRuntimes({ resourcesPath: temporaryDir('dsh-nothing-'), env: untouched })).toBeUndefined()
    expect(untouched).toEqual({ PATH: '/usr/bin' })
  })

  it('packageManager 指向随包 pnpm（node + pnpm.mjs 绝对路径）', () => {
    const payload = syntheticPayload()
    const resolved = resolveBundledRuntimes({ resourcesPath: payload.resources })!
    expect(bundledPackageManager(resolved)).toEqual({
      command: resolved.node,
      args: [resolved.pnpm],
      env: {},
    })
  })

  it('src 与门禁脚本的载荷目录名逐字一致（两侧各写一份字面量，漂移即静默失效）', () => {
    // 客户端按 `src/bundled-runtimes.ts` 的名字解析；afterPack 门禁按
    // `scripts/verify-packaged-runtime.ts` 的名字断言。两侧漂移时：客户端找不到载荷
    // （静默没有运行时），或门禁找不到载荷（拒包）—— 两种都只有在真机/打包时才现形。
    expect(BUNDLED_RUNTIMES_DIR).toBe(BUNDLED_RUNTIMES_PAYLOAD_DIR)
    expect(BUNDLED_RUNTIMES_PAYLOAD_DIR).toBe('runtimes')
    const source = readFileSync(join(packageRoot, 'src/bundled-runtimes.ts'), 'utf8')
    expect(source).toContain(`export const BUNDLED_RUNTIMES_DIR = '${BUNDLED_RUNTIMES_PAYLOAD_DIR}'`)
  })

  it('src/main.ts 在 boot 之前就位，并把结果交给 desktopProfileContext（不内联字面量）', () => {
    const source = readFileSync(join(packageRoot, 'src/main.ts'), 'utf8')
    const install = source.indexOf('installBundledRuntimes({ home: homeDir })')
    expect(install, 'src/main.ts 必须调用 installBundledRuntimes（否则 PATH 上没有随包运行时）').toBeGreaterThan(0)
    const boot = source.indexOf('await boot(')
    expect(boot, 'src/main.ts 必须仍然 await boot(...)').toBeGreaterThan(0)
    expect(install, 'PATH 前置必须早于 boot（晚于它就会漏掉启动期 spawn 的子进程）').toBeLessThan(boot)
    expect(
      source,
      'desktopProfileContext 必须收到随包运行时（packageManager 才有值）',
    ).toContain('desktopProfileContext(prepared, bundledRuntimes)')
    // 反向：不得把 packageManager 内联在 main.ts 里（那会让冒烟测的不是生产路径）。
    expect(source).not.toContain('packageManager:')
  })
})

describe('平台名归一（`win32` → `win`）：三处实现必须同形（2026-10-08 CI 实测踩到）', () => {
  it('打包期（fetch 脚本）与运行期（bundledRuntimeTarget）在完整矩阵上给出同一个键', () => {
    // 载荷键在两处各有一份实现：`scripts/fetch-bundled-runtimes.mjs`（写清单 target）与
    // `src/bundled-runtimes.ts`（读清单时算目标键）。两侧不同形不会报错，只会让
    // Windows 客户端"看到清单却不是自己那份" ⇒ 静默退回系统 PATH。
    for (const platform of ['win32', 'linux', 'darwin', 'freebsd'] as NodeJS.Platform[]) {
      for (const arch of ['x64', 'arm64']) {
        expect(bundledRuntimeTarget(platform, arch)).toBe(`${normalizeRuntimePlatform(platform)}-${arch}`)
      }
    }
    expect(normalizeRuntimePlatform('win32')).toBe('win')
    expect(normalizeRuntimePlatform('linux')).toBe('linux')
    expect(bundledRuntimeTarget('win32', 'x64')).toBe('win-x64')
  })

  it('Windows runner 上 resolveRuntimeTarget 解析出 win-x64（不归一 ⇒ 打包当场 fail-loud）', () => {
    const pin = readRuntimePin()
    expect(pin.targets).toContain('win-x64')
    expect(resolveRuntimeTarget('win32', 'x64', pin)).toBe('win-x64')
    // 负向：清单里没有的目标仍须 fail-loud（归一不得把未知目标一起放过）。
    expect(() => resolveRuntimeTarget('win32', 'ia32', pin)).toThrow(/不支持的目标平台 win-ia32/u)
  })

  it('afterPack 的 node 自报值按同一规则归一再比清单（否则 Windows 恒红）', () => {
    expect(normalizeProbedRuntimeTarget('win32', 'x64')).toBe('win-x64')
    expect(normalizeProbedRuntimeTarget('linux', 'x64')).toBe('linux-x64')
    expect(normalizeProbedRuntimeTarget('darwin', 'arm64')).toBe('darwin-arm64')
  })
})

describe('afterPack 门禁：随包运行时必须在、且真跑得起来（assertBundledRuntimesPackaged）', () => {
  /** 把合成载荷摆成"源树里的 build/runtimes + 产物里的 resources/runtimes"。 */
  function packagedFixture(options: Parameters<typeof syntheticPayload>[0] = {}): {
    packageRoot: string
    resourcesRoot: string
  } {
    const payload = syntheticPayload(options)
    const root = temporaryDir('dsh-pack-')
    mkdirSync(join(root, 'build'), { recursive: true })
    const resources = join(root, 'resources')
    mkdirSync(resources, { recursive: true })
    for (const target of [join(root, 'build', BUNDLED_RUNTIMES_PAYLOAD_DIR), join(resources, BUNDLED_RUNTIMES_PAYLOAD_DIR)]) {
      const copied = spawnSync('cp', ['-a', payload.root, target], { encoding: 'utf8' })
      if (copied.status !== 0) throw new Error(`fixture copy failed: ${copied.stderr}`)
    }
    return { packageRoot: root, resourcesRoot: resources }
  }

  it('载荷在位且三个命令都能跑 ⇒ 通过', () => {
    const fixture = packagedFixture()
    expect(() => assertBundledRuntimesPackaged(fixture.resourcesRoot, fixture.packageRoot)).not.toThrow()
  })

  it('源树没声明载荷 ⇒ 拒包并点名"没走打包脚本"', () => {
    const fixture = packagedFixture()
    rmSync(bundledRuntimesBuildDir(fixture.packageRoot), { recursive: true, force: true })
    expect(() => assertBundledRuntimesPackaged(fixture.resourcesRoot, fixture.packageRoot))
      .toThrow(/declares no bundled agent runtimes/u)
  })

  it('产物里没有载荷目录 ⇒ 拒包并点名 extraResources', () => {
    const fixture = packagedFixture()
    rmSync(join(fixture.resourcesRoot, BUNDLED_RUNTIMES_PAYLOAD_DIR), { recursive: true, force: true })
    expect(() => assertBundledRuntimesPackaged(fixture.resourcesRoot, fixture.packageRoot))
      .toThrow(/no runtimes\/ payload/u)
  })

  it('目标平台与源树不一致 ⇒ 拒包（拿错平台的载荷不能进包）', () => {
    const fixture = packagedFixture()
    const manifestPath = join(fixture.resourcesRoot, BUNDLED_RUNTIMES_PAYLOAD_DIR, BUNDLED_RUNTIMES_MANIFEST)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, target: 'plan9-mips' }, null, 2)}\n`)
    expect(() => assertBundledRuntimesPackaged(fixture.resourcesRoot, fixture.packageRoot))
      .toThrow(/does not match the build input/u)
  })

  it('产物载荷被改动（拷贝截断/打包后重建）⇒ 树摘要不符即拒包', () => {
    const fixture = packagedFixture()
    writeFileSync(join(fixture.resourcesRoot, BUNDLED_RUNTIMES_PAYLOAD_DIR, 'node', 'bin', 'node'), '#!/bin/sh\necho v0\n')
    expect(() => assertBundledRuntimesPackaged(fixture.resourcesRoot, fixture.packageRoot))
      .toThrow(/do not match the build input/u)
  })

  it('命令能起但版本与清单不符 ⇒ 拒包（"文件在、跑错了"也是一种坏包）', () => {
    const fixture = packagedFixture()
    // 只改**产物侧清单**钉的版本，文件与树摘要都不动：这正是"清单说 A、载荷实际是 B"
    // 那一类坏包（拷贝来源换了、或 payload 被换成了另一个版本）。摘要判据不该抓它，
    // 抓它的是"真跑一次并逐字比版本"。
    const manifestPath = join(fixture.resourcesRoot, BUNDLED_RUNTIMES_PAYLOAD_DIR, BUNDLED_RUNTIMES_MANIFEST)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { versions: typeof versions }
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, versions: { ...manifest.versions, node: '77.0.0' } }, null, 2)}\n`)
    expect(() => assertBundledRuntimesPackaged(fixture.resourcesRoot, fixture.packageRoot))
      .toThrow(/bundled node reports/u)
  })

  it('Windows 载荷：node 自报 `win32` 也必须认（否则 Windows 包永远过不了门禁）', () => {
    // 判据跑在 Linux 上，但被测行为是 Windows 的键形态：清单 target 是 `win-x64`，
    // node 自报 `win32` + `x64`。少了平台名归一这一步，这条会以
    // `runs on "win32-x64" … claims "win-x64"` 拒包 —— 2026-10-08 的 Windows job 正是如此。
    const fixture = packagedFixture({ target: 'win-x64', reports: { platform: 'win32', arch: 'x64' } })
    expect(() => assertBundledRuntimesPackaged(fixture.resourcesRoot, fixture.packageRoot)).not.toThrow()
  })

  it('node 自报的平台与清单不符 ⇒ 拒包，并同时打印自报值与归一后的键', () => {
    const fixture = packagedFixture({ target: 'win-x64', reports: { platform: 'linux', arch: 'x64' } })
    expect(() => assertBundledRuntimesPackaged(fixture.resourcesRoot, fixture.packageRoot))
      .toThrow(/runs on "linux-x64" \(payload target key "linux-x64"\) but the payload claims "win-x64"/u)
  })

  it('打包器按名字跳过的文件不进摘要，也不留在载荷里（.gitkeep/.DS_Store）', () => {
    // 机制：`builder-util/out/fs.js:68` 的目录遍历**按名字跳过** `.DS_Store` 与
    // `.gitkeep` ⇒ 它们留在载荷里会让产物比清单少一个文件，被 afterPack 门禁读成
    // "拷贝截断"（本机 Linux 打包实测：pnpm 里 undici 的 `.gitkeep` 就是那一个）。
    // 处置是"摘要两边都跳过 + 载荷里删掉"，**不是**让门禁容忍少文件（那会连真正的
    // 截断一起放过）。
    const payload = syntheticPayload()
    const before = runtimeTreeDigest(payload.root, [join(payload.root, BUNDLED_RUNTIMES_MANIFEST)])
    for (const name of ['.gitkeep', '.DS_Store']) {
      writeFileSync(join(payload.root, 'node', name), '')
    }
    const after = runtimeTreeDigest(payload.root, [join(payload.root, BUNDLED_RUNTIMES_MANIFEST)])
    expect(after).toEqual(before)
    const removed = prunePackagerSkippedNames(payload.root, () => {})
    expect([...removed].sort()).toEqual(['node/.DS_Store', 'node/.gitkeep'])
    expect(existsSync(join(payload.root, 'node', '.gitkeep'))).toBe(false)
    expect(runtimeTreeDigest(payload.root, [join(payload.root, BUNDLED_RUNTIMES_MANIFEST)])).toEqual(before)
  })

  it('载荷目录名与 shim 名是外部契约（改名字必须同时改 fetch 脚本与客户端）', () => {
    expect(BUNDLED_RUNTIMES_PAYLOAD_DIR).toBe('runtimes')
    expect(BUNDLED_RUNTIMES_SHIM_DIR).toBe('bin')
    const fetchScript = readFileSync(join(packageRoot, 'scripts/fetch-bundled-runtimes.mjs'), 'utf8')
    expect(fetchScript).toContain("export const RUNTIME_SHIM_DIR = 'bin'")
    expect(fetchScript).toContain("export const RUNTIME_MANIFEST_FILE = 'manifest.json'")
  })
})

describe('打包配置：载荷的随包方式与 Linux 侧的双份排除', () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    build: {
      extraResources: { from: string, to: string }[]
      linux: { files: string[] }
      files: string[]
    }
  }

  it('extraResources 把 build/runtimes 带到 resources/runtimes（不进 asar，裸二进制才可执行）', () => {
    expect(manifest.build.extraResources).toEqual(expect.arrayContaining([
      { from: 'build/runtimes', to: 'runtimes' },
    ]))
    // 反向：载荷**不得**被全局正向清单收进 asar（`asar.smartUnpack: false`，裸 `node`
    // 没有扩展名，asarUnpack 的 glob 匹配不到 ⇒ 进了归档就永远不可执行）。
    const positiveIncludingPayload = manifest.build.files
      .filter(pattern => !pattern.startsWith('!'))
      .filter(pattern => pattern.includes('runtimes'))
    expect(positiveIncludingPayload).toEqual([])
  })

  it('Linux 侧显式排除载荷与缓存（该平台的应用根匹配器会落回兜底全匹配）', () => {
    // 机制（`tests/verify-packaged-runtime.spec.ts` 的 `build/*` 判据里逐字记录）：
    // `build.linux.files` 全是 `!` ⇒ `getMainFileMatchers` 给它补兜底全匹配 ⇒ 整个 build/
    // 进 asar。不排除就是"240MiB 载荷进归档，resources 里再来一份"。
    expect(manifest.build.linux.files).toEqual(expect.arrayContaining([
      '!build/runtimes/**',
      '!build/runtimes-cache/**',
      // 语音模型载荷同理：它经 extraResources 进 resources/speech-model，而 Linux 的
      // asar 兜底匹配会把 231MiB 再收一份（2026-10-08 在本机 --dir 产物上实测：
      // asar 里确有 7 个 build/speech-model 条目，而 resources/ 里另有一份）。
      '!build/speech-model/**',
    ]))
    expect(manifest.build.linux.files.every(pattern => pattern.startsWith('!'))).toBe(true)
  })

  it('Windows runner 的默认目标归一成 win-x64（不是 win32-x64）', () => {
    const pin = readRuntimePin()
    // 载荷键在 runtimes.json / 发布清单 / artifact 名里一律是 `win-x64`，而 Node 报的平台名
    // 是 `win32`。2026-10-08 CI 实测：不归一 ⇒ 默认目标算成 win32-x64 ⇒ 声明表里没有 ⇒
    // 打包 fail-loud、Windows job 一分半即红、整条发布链卡住。
    expect(resolveRuntimeTarget('win32', 'x64', pin)).toBe('win-x64')
    expect(resolveRuntimeTarget('linux', 'x64', pin)).toBe('linux-x64')
    expect(resolveRuntimeTarget('darwin', 'arm64', pin)).toBe('darwin-arm64')
    // 归一**只**改平台名拼写：真正没声明的目标仍然 fail-loud（不许悄悄放过）。
    expect(() => resolveRuntimeTarget('win32', 'arm64', pin)).toThrowError(/不支持的目标平台 win-arm64/u)
    expect(() => resolveRuntimeTarget('freebsd', 'x64', pin)).toThrowError(/不支持的目标平台/u)
  })

  it('钉死清单（runtimes.json）覆盖三平台且每个平台三个运行时都齐', () => {
    const pin = JSON.parse(readFileSync(join(packageRoot, 'runtimes.json'), 'utf8')) as {
      schema: number
      targets: string[]
      node: { version: string, base: string, targets: Record<string, { asset: string, bytes: number, sha256: string }> }
      pnpm: { version: string, entry: string, targets: Record<string, { asset: string }> }
      python: { version: string, targets: Record<string, { asset: string, sha256: string }> }
    }
    expect(pin.schema).toBe(1)
    expect(pin.targets).toEqual(expect.arrayContaining(['linux-x64', 'darwin-arm64', 'win-x64']))
    for (const target of pin.targets) {
      for (const runtime of [pin.node, pin.pnpm, pin.python]) {
        const artifact = runtime.targets[target]
        expect(artifact, `${target} 缺一个运行时制品`).toBeDefined()
        expect(artifact?.asset).not.toBe('')
      }
      expect(pin.node.targets[target]?.sha256).toMatch(/^[0-9a-f]{64}$/u)
      expect(pin.node.targets[target]?.bytes).toBeGreaterThan(1_000_000)
      expect(pin.python.targets[target]?.sha256).toMatch(/^[0-9a-f]{64}$/u)
    }
    // 三个运行时都必须有非空 prune 列表或显式空数组（形状统一，避免"忘了写"）。
    expect(pin.pnpm.entry).toBe('bin/pnpm.mjs')
    // 版本号出现在制品名里：钉版本而没改制品名，是最容易漏的一处漂移。
    expect(pin.node.targets['linux-x64']?.asset).toContain(pin.node.version)
    expect(pin.python.targets['darwin-arm64']?.asset).toContain(pin.python.version)
    expect(pin.pnpm.targets['win-x64']?.asset).toContain(pin.pnpm.version)
  })

  it('载荷目录与缓存目录都被 gitignore（公开仓里 `git add -A` 会提交 GB 级第三方二进制）', () => {
    const ignore = readFileSync(join(repoRoot, '.gitignore'), 'utf8')
    expect(ignore).toContain('packages/host/desktop/build/runtimes/')
    expect(ignore).toContain('packages/host/desktop/build/runtimes-cache/')
  })

  it('本机已有的载荷（若拉过）与门禁读取的目录一致（存在性判据，缺则跳过）', () => {
    const buildDir = bundledRuntimesBuildDir(packageRoot)
    if (!existsSync(join(buildDir, BUNDLED_RUNTIMES_MANIFEST))) return
    // 拉过载荷的机器上顺带证一次"目录名对得上"；没拉过的机器不因它变红。
    expect(statSync(join(buildDir, BUNDLED_RUNTIMES_SHIM_DIR)).isDirectory()).toBe(true)
  })
})

describe('体积预算：载荷不得悄悄变胖（runtimes.json 的 budget 是棘轮）', () => {
  const pin = JSON.parse(readFileSync(join(packageRoot, 'runtimes.json'), 'utf8')) as {
    targets: string[]
    budget: { targets: Record<string, { bytes: number, files: number }> }
    node: { targets: Record<string, { bytes: number }> }
    pnpm: { targets: Record<string, { bytes: number }> }
    python: { targets: Record<string, { bytes: number }> }
  }

  /**
   * 造一份可被 `readRuntimePin` 接受的钉死清单（体积预算是参数）。
   *
   * 只服务这一类判据：不解包、不校验制品哈希，所以制品字段填占位值。
   * @param options - 目标平台与预算数字。
   * @returns 清单文件路径。
   */
  function syntheticPin(options: { target?: string, budget?: { bytes?: number, files?: number } } = {}): string {
    const target = options.target ?? hostTarget
    const artifact = { asset: 'placeholder.tar.gz', kind: 'tar.gz', bytes: 1, sha256: '0'.repeat(64) }
    const document = {
      schema: 1,
      targets: [target],
      budget: {
        targets: {
          [target]: { bytes: options.budget?.bytes ?? 1 << 30, files: options.budget?.files ?? 1 << 20 },
        },
      },
      node: {
        version: '1.0.0',
        base: 'https://example.com/',
        targets: { [target]: artifact },
        prune: [],
        commands: { posix: { node: 'bin/node' }, win: { node: 'node.exe' } },
      },
      pnpm: {
        version: '1.0.0',
        base: 'https://example.com/',
        entry: 'bin/pnpm.mjs',
        targets: { [target]: artifact },
        prune: [],
      },
      python: {
        version: '1.0.0',
        base: 'https://example.com/',
        targets: { [target]: artifact },
        prune: [],
        commands: { posix: { python: 'bin/python3' }, win: { python: 'python.exe' } },
      },
    }
    const path = join(temporaryDir('dsh-pin-'), 'runtimes.json')
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`)
    return path
  }

  it('三个目标各有预算，且数字既"打得到"又"打不烂"', () => {
    // 上限硬顶：防止把红门禁"改绿"成 10 GiB —— 那样的预算不判任何东西（门禁静默失效）。
    const ceilingBytes = 384 * 1024 * 1024
    const ceilingFiles = 16_384
    for (const target of pin.targets) {
      const budget = pin.budget.targets[target]
      expect(budget, `${target} 缺体积预算（新增目标必须显式给出上限）`).toBeDefined()
      expect(Number.isSafeInteger(budget?.bytes)).toBe(true)
      expect(Number.isSafeInteger(budget?.files)).toBe(true)
      expect(budget?.bytes).toBeGreaterThan(0)
      expect(budget?.files).toBeGreaterThan(0)
      expect(budget?.bytes).toBeLessThanOrEqual(ceilingBytes)
      expect(budget?.files).toBeLessThanOrEqual(ceilingFiles)
      // 下界：解包后的载荷不可能小于三份**压缩**制品之和 —— 比它还小就是"永远红"。
      const compressed = pin.node.targets[target]!.bytes + pin.pnpm.targets[target]!.bytes + pin.python.targets[target]!.bytes
      expect(budget?.bytes).toBeGreaterThan(compressed)
    }
  })

  it('本机已就位载荷时，预算必须贴着实测值（变胖即红；缩了要把数字收紧）', () => {
    const manifestPath = join(bundledRuntimesBuildDir(packageRoot), BUNDLED_RUNTIMES_MANIFEST)
    if (!existsSync(manifestPath)) return // 没拉过载荷的机器不因它变红
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      target: string
      tree: { bytes: number, files: number }
    }
    const budget = pin.budget.targets[manifest.target]
    if (budget === undefined) return // 非三平台目标（本机另拉的载荷）不判
    expect(manifest.tree.bytes).toBeLessThanOrEqual(budget.bytes)
    expect(manifest.tree.files).toBeLessThanOrEqual(budget.files)
    // 反向：预算不得比实测松 —— 松 20% 就等于"悄悄胖一圈也不会红"，棘轮就没牙了。
    expect(budget.bytes).toBeLessThanOrEqual(Math.ceil(manifest.tree.bytes * 1.02))
    expect(budget.files).toBeLessThanOrEqual(Math.ceil(manifest.tree.files * 1.02))
  })

  it('超预算即抛（点名目标与两个数字）；恰好等于上限算通过', () => {
    const manifest = {
      schema: 1,
      target: hostTarget,
      platform: hostTarget.slice(0, hostTarget.lastIndexOf('-')),
      arch: hostTarget.slice(hostTarget.lastIndexOf('-') + 1),
      versions,
      commands: { node: 'node/bin/node', pnpm: 'pnpm/bin/pnpm.mjs', python: 'python/bin/python3' },
      shims: [],
      critical: [],
      tree: { bytes: 100, files: 10, digest: '0'.repeat(64) },
    }
    expect(() => assertRuntimeBudget(manifest, readRuntimePin(syntheticPin({ budget: { bytes: 99, files: 10 } }))))
      .toThrow(/超出体积预算（bytes 100 > 99）/u)
    expect(() => assertRuntimeBudget(manifest, readRuntimePin(syntheticPin({ budget: { bytes: 100, files: 9 } }))))
      .toThrow(/超出体积预算（files 10 > 9）/u)
    expect(assertRuntimeBudget(manifest, readRuntimePin(syntheticPin({ budget: { bytes: 100, files: 10 } }))))
      .toMatchObject({ bytes: 100, files: 10 })
  })

  it('预算缺席即拒（新增目标/新清单不得绕过体积门禁）', () => {
    const document = JSON.parse(readFileSync(syntheticPin(), 'utf8')) as Record<string, unknown>
    delete (document.budget as { targets: Record<string, unknown> }).targets[hostTarget]
    const path = join(temporaryDir('dsh-pin-'), 'runtimes.json')
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`)
    expect(() => readRuntimePin(path)).toThrow(/budget\.targets\..* is required/u)
  })

  // 接线判据：`--check`（CI/打包入口用的那条）必须走同一份预算。变异：删掉
  // `verifyRuntimePayload` 里的 `assertRuntimeBudget` 调用 ⇒ 本条红。
  it('就位/校验路径（--check）真的判体积', async () => {
    const payload = syntheticPayload()
    await expect(materializeBundledRuntimes({
      check: true,
      out: payload.root,
      target: hostTarget,
      pinFile: syntheticPin({ budget: { bytes: 1, files: 1 } }),
      log: () => {},
    })).rejects.toThrow(/超出体积预算/u)
    const verified = await materializeBundledRuntimes({
      check: true,
      out: payload.root,
      target: hostTarget,
      pinFile: syntheticPin(),
      log: () => {},
    })
    expect(verified.manifest.target).toBe(hostTarget)
  })

  // 接线判据：afterPack 判据落在**产物**上（用户拿到的安装包背的就是那份载荷）。
  // 变异：删掉 `assertBundledRuntimesPackaged` 里的 `assertRuntimeBudget` 调用 ⇒ 本条红。
  it('afterPack 门禁（产物侧）也判体积', () => {
    const payload = syntheticPayload()
    const root = temporaryDir('dsh-pack-')
    mkdirSync(join(root, 'build'), { recursive: true })
    const resources = join(root, 'resources')
    mkdirSync(resources, { recursive: true })
    for (const target of [join(root, 'build', BUNDLED_RUNTIMES_PAYLOAD_DIR), join(resources, BUNDLED_RUNTIMES_PAYLOAD_DIR)]) {
      const copied = spawnSync('cp', ['-a', payload.root, target], { encoding: 'utf8' })
      if (copied.status !== 0) throw new Error(`fixture copy failed: ${copied.stderr}`)
    }
    expect(() => assertBundledRuntimesPackaged(resources, root, readRuntimePin(syntheticPin({ budget: { bytes: 1, files: 1 } }))))
      .toThrow(/超出体积预算/u)
    expect(() => assertBundledRuntimesPackaged(resources, root, readRuntimePin(syntheticPin()))).not.toThrow()
  })
})
