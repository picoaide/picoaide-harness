/**
 * 打包版 `--inspect*` 家族的**结构性收口**判据：Electron fuse（第二十七轮 FIX-33）。
 *
 * ## 为什么这一组判据必须是**能力判据**（而不是又一组纯函数/AST 断言）
 *
 * 第二十六轮复审（`temp/r26/Z1-verify/REPORT.md` §B.1，P1）的结论是：`src/debug-switches.ts`
 * 的 27 条判据（纯函数判定 + AST 接线）**全绿**，而真机上 `--inspect-brk=<port>` 依然能在
 * 闸门运行**之前**拿到主进程任意代码执行（`execSync('id -un')` → `root`，3/3）。原因是结构性
 * 的：`--inspect-brk` 在应用主脚本执行之前挂起 V8，闸门那一行永远跑不到。
 *
 * 所以这里判的是**外部可观察的能力**：
 *   · 对照（stock 二进制 + `--inspect-brk`）：inspector **真的**监听了 —— 这就是被修的那条
 *     P1 本身（attach 后 `Runtime.evaluate` 在主进程里可用）；
 *   · 收口（同一份二进制、翻过 fuse 之后）：inspector **永远不监听**，stderr 里连
 *     `Debugger listening on` 都不出现；
 *   · 生产接线：`afterPack(context)` 真的把**这次构建的产物**翻掉了（不是"函数存在"）。
 * 真机产物级证据（`node scripts/package-dir.mjs` 打出来的 `dist/linux-unpacked`）在
 * `temp/r21/fix-33/REPORT.md`，本文件负责让它在 `yarn check` 里**不会退化**。
 *
 * ## 为什么用"改名 + 复制"的复刻件，而不是直接跑 `node_modules/electron`
 *
 * 翻转会**改写二进制**，绝不能碰仓库里那份 stock 二进制（开发态 `yarn dev` 与三个平台
 * 冒烟都用它）。所以每个用例都在临时目录里造一份复刻件：数据文件用符号链接（Electron 按
 * `/proc/self/exe` 目录找 `icudtl.dat` / `*.pak` / `locales`，符号链接足够），可执行文件
 * 用真副本，然后只对副本动手。证据等级如实标注：这些用例证明的是"fuse 一翻、能力就变"，
 * 产物级证据在 REPORT 里。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { FuseV1Options, getCurrentFuseWire } from '@electron/fuses'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  AFTER_PACK_SEAMS,
  applyPackagedInspectFuseHardening,
  afterPack,
  packagedFuseTargetCandidates,
  type PackagedRuntimeContext,
} from '../scripts/verify-packaged-runtime.ts'
import { packagedAppId } from '../scripts/channel-build.ts'

/** `@electron/fuses` 的 fuse-wire 状态字节（`dist/constants.js` 的 `FuseState`）。 */
const FUSE_DISABLE = 48
const FUSE_ENABLE = 49

/** LinuxPackager 给本产物钉的启动器名（`build.linux` 未覆盖 executableName）。 */
const LINUX_LAUNCHER = 'dsh-plugin-desktop'

const tempRoots: string[] = []

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true })
})

/**
 * 本仓安装的 Electron 可执行文件（`require('electron')` 在普通 Node 进程里返回二进制路径）。
 *
 * 缺二进制即 fail-loud：`yarn check` 本来就要跑真实产物冒烟（`verify-packaged-runtime.spec.ts`
 * 的 P-5 同款前置），拿不到二进制时这组判据会退化成空转 —— 那正是它要防的形态。
 */
function resolveElectronBinary(): string {
  const require = createRequire(import.meta.url)
  const binary = require('electron') as unknown
  if (typeof binary !== 'string' || !existsSync(binary)) {
    throw new Error(`electron binary not resolved (got ${JSON.stringify(binary)}); run yarn install first`)
  }
  return binary
}

interface Replica {
  /** 复刻件的 appOutDir（= 临时目录本身）。 */
  readonly appOutDir: string
  /** 复刻件里的启动器绝对路径。 */
  readonly launcher: string
}

/**
 * 在临时目录里造一份"打包态形状"的 Electron 复刻件：数据文件符号链接 + 启动器真副本。
 *
 * 为什么要符号链接而不是 `cp -a`：整份 dist 是 250MB+，而这里只需要"能起来"。
 * Electron 的数据文件按可执行文件所在目录解析（`/proc/self/exe` 的目录）⇒ 同目录的
 * 符号链接等价；启动器必须是**真副本**（fuse 翻转要写它）。
 */
function makeReplica(launcherName: string, binary = resolveElectronBinary()): Replica {
  const appOutDir = makeTempRoot('dsh-inspect-fuse-')
  const distDir = dirname(binary)
  for (const entry of readdirSync(distDir)) {
    if (entry === 'electron') continue
    symlinkSync(join(distDir, entry), join(appOutDir, entry))
  }
  const launcher = join(appOutDir, launcherName)
  copyFileSync(binary, launcher)
  return { appOutDir, launcher }
}

/** afterPack 上下文（与真实构建同形；`appInfo.id` 取自本次构建声明的身份）。 */
function contextFor(
  appOutDir: string,
  electronPlatformName = 'linux',
  productFilename = LINUX_LAUNCHER,
): PackagedRuntimeContext {
  return {
    appOutDir,
    electronPlatformName,
    packager: { appInfo: { productFilename, id: packagedAppId() } },
  }
}

/** 一个当前空闲的 TCP 端口（inspector 由 Electron 自己绑定，先取一个再放掉）。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => { resolve(port) })
    })
  })
}

/**
 * 轮询 `--inspect*` 的 inspector 端点（不依赖任何 vitest 等待 API：这里判的是
 * "一个 TCP 服务在预算内**有没有**起来"，正/负两个方向都要，`vi.waitFor` 表达不了负方向）。
 * @returns `up` = `/json/list` 可读；`down` = 预算内从未可读。
 */
async function inspectorWithin(port: number, budgetMs: number): Promise<'up' | 'down'> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/json/list`)
      if (response.ok) return 'up'
    } catch {
      // 连接被拒 = inspector 还没（或不会）监听。
    }
    if (Date.now() >= deadline) return 'down'
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

interface Launched {
  readonly child: ChildProcess
  readonly stderr: () => string
  readonly exit: () => number | null
  readonly stop: () => Promise<void>
}

/** 起一个 Electron 进程（HOME/XDG 重定向到临时目录，避免污染真实用户目录）。 */
function launchElectron(binary: string, args: readonly string[], cwd: string): Launched {
  const home = makeTempRoot('dsh-inspect-fuse-home-')
  const child = spawn(binary, [...args], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'),
      DSH_HOME: join(home, 'dsh'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  let exitCode: number | null = null
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  child.stdout?.on('data', () => {})
  child.once('exit', (code) => { exitCode = code })
  return {
    child,
    stderr: () => stderr,
    exit: () => exitCode,
    stop: async () => {
      if (exitCode === null) {
        child.kill('SIGKILL')
        await new Promise<void>((resolve) => { child.once('exit', () => { resolve() }); setTimeout(resolve, 5_000) })
      }
    },
  }
}

const MARKER_SCRIPT = `import { writeFileSync } from 'node:fs'
writeFileSync(process.env.MARKER ?? 'marker.txt', 'ran\\n')
process.exit(0)
`

describe('打包版 inspect fuse 收口（FIX-33）', () => {
  it('候选 fuse 载体镜像 electron-builder 的平台映射', () => {
    const base = join(tmpdir(), 'dsh-fuse-candidates')
    // darwin：先 `.app`（@electron/fuses 内部再定位 framework 二进制），再真实 Mach-O。
    expect(packagedFuseTargetCandidates(contextFor(base, 'darwin', 'PicoAide Harness'))).toEqual([
      join(base, 'PicoAide Harness.app'),
      join(base, 'PicoAide Harness.app', 'Contents', 'MacOS', 'PicoAide Harness'),
    ])
    // win32：`<product>.exe`（不带目录扫描出的杂项）。
    expect(packagedFuseTargetCandidates(contextFor(base, 'win32', 'PicoAide Harness')))
      .toEqual([join(base, 'PicoAide Harness.exe')])
    // linux：executableName 优先（LinuxPackager 的 `dsh-plugin-desktop`）。
    expect(packagedFuseTargetCandidates({
      ...contextFor(base, 'linux', 'PicoAide Harness'),
      packager: { appInfo: { productFilename: 'PicoAide Harness', id: packagedAppId() }, executableName: LINUX_LAUNCHER },
    })[0]).toBe(join(base, LINUX_LAUNCHER))
  })

  it('能力对照：未翻 fuse 的同一份二进制上，--inspect-brk 真的把主进程 inspector 挂在墙上', async () => {
    const replica = makeReplica(LINUX_LAUNCHER)
    const port = await freePort()
    const script = join(replica.appOutDir, 'marker.mjs')
    writeFileSync(script, MARKER_SCRIPT)
    expect(
      (await getCurrentFuseWire(replica.launcher))[FuseV1Options.EnableNodeCliInspectArguments],
      'stock 二进制的 inspect fuse 必须是开的，否则下面这条"反例"不成立',
    ).toBe(FUSE_ENABLE)
    const launched = launchElectron(replica.launcher, ['--no-sandbox', `--inspect-brk=${String(port)}`, script], replica.appOutDir)
    try {
      // 现象：inspector 在应用主脚本之前监听（就是被修的 P1 本身）。
      expect(await inspectorWithin(port, 15_000), '--inspect-brk 未监听 ⇒ 本对照失效，先查 Electron 二进制').toBe('up')
      expect(launched.stderr()).toContain('Debugger listening on')
      // 而且进程**没有**退出（挂起在第一个脚本之前）——"闸门跑不到"的可观察形态。
      expect(launched.exit()).toBeNull()
    } finally {
      await launched.stop()
    }
  })

  it('收口：翻过 fuse 之后同一条命令永不监听（同一颗二进制，能力对照的一半）', async () => {
    const replica = makeReplica(LINUX_LAUNCHER)
    const port = await freePort()
    const script = join(replica.appOutDir, 'marker.mjs')
    writeFileSync(script, MARKER_SCRIPT)
    const report = await applyPackagedInspectFuseHardening(contextFor(replica.appOutDir))
    expect(report?.target).toBe(replica.launcher)
    expect(report?.changed).toBe(true)
    // 回读判据：三颗 fuse 的实际状态（0 = DISABLE、1 = ENABLE）。
    expect(report?.before[FuseV1Options.EnableNodeCliInspectArguments]).toBe(FUSE_ENABLE)
    expect(report?.after[FuseV1Options.EnableNodeCliInspectArguments]).toBe(FUSE_DISABLE)
    expect(report?.after[FuseV1Options.RunAsNode]).toBe(FUSE_ENABLE)
    expect(report?.after[FuseV1Options.OnlyLoadAppFromAsar]).toBe(FUSE_ENABLE)
    // 幂等：再翻一次不写盘，状态不变。
    expect((await applyPackagedInspectFuseHardening(contextFor(replica.appOutDir)))?.changed).toBe(false)
    const launched = launchElectron(replica.launcher, ['--no-sandbox', `--inspect-brk=${String(port)}`, script], replica.appOutDir)
    try {
      expect(await inspectorWithin(port, 6_000), 'inspect fuse 关了但 inspector 仍然监听 ⇒ 收口无效').toBe('down')
      expect(launched.stderr()).not.toContain('Debugger listening on')
    } finally {
      await launched.stop()
    }
  })

  it('生产接线：afterPack(context) 真的翻转了这次构建的产物', async () => {
    const replica = makeReplica(LINUX_LAUNCHER)
    // 五个既有接缝给替身（合成目录永远过不了静态门禁），被测的那一步走**生产代码**：
    // 它不在缝表里，而是 afterPack 末尾无条件调用 ⇒ 删掉那行本用例即红。
    const spies = [
      vi.spyOn(AFTER_PACK_SEAMS, 'verify').mockImplementation(() => {}),
      vi.spyOn(AFTER_PACK_SEAMS, 'smoke').mockImplementation(async () => {}),
      vi.spyOn(AFTER_PACK_SEAMS, 'flockSmoke').mockImplementation(() => {}),
      vi.spyOn(AFTER_PACK_SEAMS, 'errorReportingSmoke').mockImplementation(() => {}),
      vi.spyOn(AFTER_PACK_SEAMS, 'asarBigintSmoke').mockImplementation(() => {}),
    ]
    try {
      await afterPack(contextFor(replica.appOutDir))
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
    const wire = await getCurrentFuseWire(replica.launcher)
    expect(
      wire[FuseV1Options.EnableNodeCliInspectArguments],
      'afterPack 跑完产物里 inspect fuse 仍开着 ⇒ 生产接线没接上（--inspect* 家族照旧能进主进程）',
    ).toBe(FUSE_DISABLE)
    expect(wire[FuseV1Options.RunAsNode], 'RunAsNode 必须保持开启（subprocess-local 的 runner 依赖它）').toBe(FUSE_ENABLE)
  })

  it('翻转载荷必须带 macOS 的 ad-hoc 重签开关（否则未签名 arm64 冒烟产物打不开）', () => {
    // 这条判据只能做到**源码级**：本机是 Linux、无法验证 macOS 的真实行为 ——
    // 所以它防的不是"行为写错了"，而是"下一个人优化时把这行删掉而没人发现"。
    //
    // 为什么必须有：翻 fuse 改的是 Mach-O 字节 ⇒ 作废 Electron 自带的 ad-hoc 签名。
    // 已签名路径没事（electron-builder 的签名步在 afterPack **之后**盖真签名）；
    // 但 `scripts/package-mac.ts` 的冒烟构建是 `CSC_IDENTITY_AUTO_DISCOVERY=false`（不签名），
    // 事后无人重签，而 arm64 上签名无效的二进制不会执行（"Killed: 9"），
    // 偏偏 `verify-mac-smoke.ts` 明确不做签名检查 ⇒ **CI 看不见**。
    const source = readFileSync(join(import.meta.dirname, '..', 'scripts', 'verify-packaged-runtime.ts'), 'utf8')
    const call = source.slice(source.indexOf('flipFuses(target, {'))
    const payload = call.slice(0, call.indexOf('})'))
    expect(
      payload,
      'flipFuses 载荷缺 resetAdHocDarwinSignature ⇒ 未签名的 macOS 冒烟产物会失去可执行的 ad-hoc 签名（smoke 不查签名，所以不会红）',
    ).toContain('resetAdHocDarwinSignature: true')
  })

  it('原生启动器在但不是 Electron 构建 ⇒ fail-loud（不静默放过被掉包的产物）', async () => {
    const appOutDir = makeTempRoot('dsh-inspect-fuse-mangled-')
    // 真原生二进制，但没有 Electron 的 fuse sentinel（node 自己就是最省事的样本）。
    copyFileSync(process.execPath, join(appOutDir, LINUX_LAUNCHER))
    await expect(applyPackagedInspectFuseHardening(contextFor(appOutDir)))
      .rejects.toThrow(/carries no Electron fuse wire/u)
  })

  it('启动器是包装脚本（合成夹具的既有形状）⇒ 跳过，不误伤别的 spec', async () => {
    const appOutDir = makeTempRoot('dsh-inspect-fuse-wrapper-')
    writeFileSync(join(appOutDir, LINUX_LAUNCHER), '#!/bin/sh\nexec /bin/true "$@"\n')
    await expect(applyPackagedInspectFuseHardening(contextFor(appOutDir))).resolves.toBeUndefined()
  })

  it('appOutDir 里没有任何启动器 ⇒ 跳过（合成夹具），不误伤既有单测', async () => {
    const appOutDir = makeTempRoot('dsh-inspect-fuse-fixture-')
    mkdirSync(join(appOutDir, 'resources'), { recursive: true })
    await expect(applyPackagedInspectFuseHardening(contextFor(appOutDir))).resolves.toBeUndefined()
  })
})
