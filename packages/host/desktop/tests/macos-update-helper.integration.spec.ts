/**
 * macOS 原地更新帮手的**真机**判据（只在 macOS 上跑）。
 *
 * 这里是整条链路上唯一能证明"替换真的发生了"的地方：真 `/bin/sh`、真 `ditto`、真
 * `codesign --verify --strict`、真 `mv`。单测里的命令替身证明不了：
 * - 脚本的位置参数顺序与引用方式（`"$10"` vs `$10` 这类错法在没有真 shell 时看不出来）；
 * - `ditto --noqtn` 出来的副本**仍然能通过签名校验**（少一个 `_CodeSignature` 就全废）；
 * - 落位/回滚两条 `mv` 顺序在真文件系统上的最终形态。
 *
 * 三处刻意的口径：
 * 1. **不挂载真影像**：本文件只喂"影像里的应用包"这个路径（帮手本身不关心它挂在哪）。
 *    `hdiutil` 需要设备权限，砂箱/CI 上未必可用，挂载由 `prepareMacosInPlaceUpdate`
 *    的判据（命令替身）覆盖。
 * 2. **重启命令换成 `/usr/bin/true`**：`writeMacosUpdateHelper` 的 `tuning` 是给测试
 *    用的（生产恒为 `/usr/bin/open`）——否则跑一次用例就会真的拉起一个假应用、并在
 *    LaunchServices 里留一条登记。
 * 3. **两个等待窗口按滴答缩到秒级**：改回生产值只是慢，判据不变。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  macosUpdatePaths,
  writeMacosUpdateHelper,
  type MacosInPlaceUpdatePlan,
} from '../src/macos-update-install.ts'

const temporary: string[] = []

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

/**
 * 造一个最小但**真能被 `codesign` 校验**的应用包。
 *
 * 标记必须写在 `Contents/Resources/` 里、且在签名**之前**写：写在包根是"unsealed
 * contents"，`codesign --verify --strict` 会直接失败（这正是第 3 条用例要用的性质）。
 * @param bundlePath - 目标 `.app` 路径。
 * @param version - `CFBundleShortVersionString`。
 * @param marker - 写进 `Contents/Resources/marker.txt` 的内容。
 */
function makeSignedBundle(bundlePath: string, version: string, marker: string): void {
  mkdirSync(join(bundlePath, 'Contents', 'MacOS'), { recursive: true })
  mkdirSync(join(bundlePath, 'Contents', 'Resources'), { recursive: true })
  writeFileSync(join(bundlePath, 'Contents', 'MacOS', 'App'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(join(bundlePath, 'Contents', 'Resources', 'marker.txt'), marker, 'utf8')
  writeFileSync(join(bundlePath, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>ai.test.integration</string>
<key>CFBundleExecutable</key><string>App</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>`, 'utf8')
  const signed = spawnSync('codesign', ['--force', '-s', '-', bundlePath], { encoding: 'utf8' })
  if (signed.status !== 0) throw new Error(`codesign failed: ${signed.stderr}`)
}

/** 同步跑一条命令（只在造夹具/断言时用，被测流程一律走真 spawn）。 */
function verifySignature(bundlePath: string): number | null {
  return spawnSync('codesign', ['--verify', '--strict', bundlePath], { encoding: 'utf8' }).status
}

interface Runner {
  /** 帮手进程的退出码。 */
  readonly exited: Promise<number | null>
  readonly plan: MacosInPlaceUpdatePlan
  readonly root: string
  readonly logPath: string
  readonly resultPath: string
  readonly bootMarkerPath: string
  /** 负向标记：新版报告致命启动失败时写（审计复核 P1）。 */
  readonly bootFailurePath: string
}

/**
 * 搭一个"旧版本已安装、影像里是新版本"的现场并把帮手真的跑起来。
 * @param options - `keepHostAlive` = 宿主替身不退出；`sourceIsTampered` = 让影像里的包签名失效。
 */
function runHelper(options: {
  readonly keepHostAlive?: boolean
  readonly nextVersion?: string
  readonly sourceIsTampered?: boolean
} = {}): Runner {
  const root = mkdtempSync(join(tmpdir(), 'dsh-macos-update-it-'))
  temporary.push(root)
  const target = join(root, 'Applications', 'PicoAide Harness.app')
  const source = join(root, 'Volume', 'PicoAide Harness.app')
  const userDataPath = join(root, 'userData')
  makeSignedBundle(target, '1.0.0', 'OLD-BUILD')
  makeSignedBundle(source, options.nextVersion ?? '2.0.0', 'NEW-BUILD')
  if (options.sourceIsTampered === true) {
    // 签名之后再改内容 ⇒ 密封资源失效（帮忙手在落位前发现）。
    writeFileSync(join(source, 'Contents', 'Resources', 'marker.txt'), 'TAMPERED', 'utf8')
  }
  const version = options.nextVersion ?? '2.0.0'

  // 宿主替身：帮手的 $1 就是它的 pid。`keepHostAlive` 用本进程（用例期间一直活着）。
  const hostPid = options.keepHostAlive === true
    ? process.pid
    : (() => {
        const child = spawn('/bin/sleep', ['0.4'], { stdio: 'ignore' })
        return child.pid ?? 1
      })()

  const plan: MacosInPlaceUpdatePlan = {
    bundlePath: target,
    mountPoint: join(root, 'mount'),
    sourcePath: source,
    stagingPath: join(root, 'Applications', '.PicoAide Harness.app.update-2.0.0.app'),
    backupPath: join(root, 'Applications', '.PicoAide Harness.app.backup-2.0.0.app'),
    bundleIdentifier: 'ai.test.integration',
  }
  mkdirSync(plan.mountPoint, { recursive: true })
  const helper = writeMacosUpdateHelper({
    plan,
    userDataPath,
    version,
    pid: hostPid,
    fromVersion: '1.0.0',
    tuning: { relaunchCommand: '/usr/bin/true', exitWaitTicks: 4, bootWaitTicks: 4 },
  })
  const child = spawn(helper.command, [...helper.args], { detached: true, stdio: 'ignore' })
  const exited = new Promise<number | null>((resolve) => { child.on('exit', (code) => { resolve(code) }) })
  const paths = macosUpdatePaths(userDataPath)
  return {
    exited,
    plan,
    root,
    logPath: paths.logPath,
    resultPath: paths.resultPath,
    bootMarkerPath: paths.bootMarkerPath,
    bootFailurePath: paths.bootFailurePath,
  }
}

describe.skipIf(process.platform !== 'darwin')('macOS update helper (real /bin/sh, ditto and codesign)', () => {
  it('replaces the installed bundle, confirms the new version and drops the backup', async () => {
    const runner = runHelper()
    // 扮演"新版本启动"：真应用在启动路径上写同一个文件（`writeMacosUpdateBootMarker`）。
    // 帮手在重新打开应用之前会删一次这个文件，所以这里持续写，直到帮手退出。
    const marker = setInterval(() => {
      // 标记必须**同时**带版本与 bundle（审计复核 P1）：只写版本号的标记会被判否。
      writeFileSync(
        runner.bootMarkerPath,
        `version=2.0.0\nbundle=${runner.plan.bundlePath}\n`,
        'utf8',
      )
    }, 50)
    const code = await runner.exited
    clearInterval(marker)
    expect(code).toBe(0)

    expect(readFileSync(join(runner.plan.bundlePath, 'Contents', 'Resources', 'marker.txt'), 'utf8')).toBe('NEW-BUILD')
    expect(readFileSync(join(runner.plan.bundlePath, 'Contents', 'Info.plist'), 'utf8')).toContain('2.0.0')
    // 替换后的包必须仍然能通过签名校验：`ditto` 不能把签名/资源叉丢掉。
    expect(verifySignature(runner.plan.bundlePath)).toBe(0)
    // 暂存件清掉、启动标记被删掉（旧标记绝不能骗过下一次替换）。
    expect(existsSync(runner.plan.stagingPath)).toBe(false)
    // **备份留着**（审计复核 P1）：脚本侧不再删它 —— `pgrep -f` 只是命令行文本匹配，
    // 分不清"新版本在跑"与"旧实例还活着"，删错就是删掉正在运行的那份文件。
    // 删除点收敛到宿主侧 `settleMacosUpdate → removeMacosUpdateBackup`（fail-closed）。
    expect(existsSync(runner.plan.backupPath)).toBe(true)
    expect(readFileSync(runner.resultPath, 'utf8')).toContain('status=ok')
    expect(readFileSync(runner.logPath, 'utf8')).toContain('left for the host to reclaim')
    expect(readdirSync(join(runner.plan.bundlePath, '..')).sort()).toEqual([
      '.PicoAide Harness.app.backup-2.0.0.app',
      'PicoAide Harness.app',
    ])
  })

  it('rolls back when the new version never starts', async () => {
    const runner = runHelper()
    expect(await runner.exited).toBe(1)

    // 一个文件都不能变：标记、版本、签名都还是旧的那一份。
    expect(readFileSync(join(runner.plan.bundlePath, 'Contents', 'Resources', 'marker.txt'), 'utf8')).toBe('OLD-BUILD')
    expect(readFileSync(join(runner.plan.bundlePath, 'Contents', 'Info.plist'), 'utf8')).toContain('1.0.0')
    expect(verifySignature(runner.plan.bundlePath)).toBe(0)
    expect(existsSync(runner.plan.backupPath)).toBe(false)
    expect(existsSync(runner.plan.stagingPath)).toBe(false)
    expect(existsSync(runner.plan.stagingPath + '.broken')).toBe(false)
    const result = readFileSync(runner.resultPath, 'utf8')
    expect(result).toContain('status=failed')
    expect(result).toContain('reason=application-did-not-start')
    expect(readFileSync(runner.logPath, 'utf8')).toContain('rolling back')
  })

  it('does not mistake a stale boot marker from before the swap for the new version starting', async () => {
    // 关键判据：帮手必须在重新打开应用之前删掉启动标记。否则**上一次**（或旧版本）
    // 留下的同名标记会让它把"新版根本没起来"误判成成功，然后删掉唯一的备份。
    const runner = runHelper()
    writeFileSync(
      runner.bootMarkerPath,
      `version=2.0.0\nbundle=${runner.plan.bundlePath}\n`,
      'utf8',
    )
    expect(await runner.exited).toBe(1)

    expect(readFileSync(join(runner.plan.bundlePath, 'Contents', 'Resources', 'marker.txt'), 'utf8')).toBe('OLD-BUILD')
    expect(existsSync(runner.plan.backupPath)).toBe(false)
    expect(readFileSync(runner.resultPath, 'utf8')).toContain('reason=application-did-not-start')
  })

  it('does not accept a boot marker whose version merely extends the target (audit A1)', async () => {
    // 目标 `2.0.0`、标记写的是 `2.0.0-beta.1`。子串匹配（`grep -q "version=2.0.0"`）会命中，
    // 于是帮手承认"新版起来了"、删掉唯一的备份 —— 而真正起来的是**别的版本**。
    // 本仓的版本号形态天然互为前缀（beta.1 vs beta.10、预发 vs 正式），所以这条不是假想。
    const runner = runHelper()
    const marker = setInterval(() => {
      writeFileSync(
        runner.bootMarkerPath,
        `version=2.0.0-beta.1\nbundle=${runner.plan.bundlePath}\n`,
        'utf8',
      )
    }, 50)
    const code = await runner.exited
    clearInterval(marker)

    expect(code).toBe(1)
    expect(readFileSync(join(runner.plan.bundlePath, 'Contents', 'Resources', 'marker.txt'), 'utf8')).toBe('OLD-BUILD')
    expect(readFileSync(runner.resultPath, 'utf8')).toContain('reason=application-did-not-start')
    // 备份已经换回原位（回滚成功），不是被当成"成功"删掉。
    expect(existsSync(runner.plan.backupPath)).toBe(false)
    expect(readFileSync(runner.logPath, 'utf8')).toContain('rolling back')
  })

  it('does not accept a boot marker written by a different copy of the same version', async () => {
    // 审计复核 P1：只认版本号的话，**同版本的另一份副本**（DMG 里那份、下载目录里的拷贝）
    // 或 `yarn dev` 都能写出一条"看起来对"的标记。标记必须点名 bundle。
    const runner = runHelper()
    const marker = setInterval(() => {
      writeFileSync(runner.bootMarkerPath, 'version=2.0.0\nbundle=/Volumes/Other/PicoAide Harness.app\n', 'utf8')
    }, 50)
    const code = await runner.exited
    clearInterval(marker)

    expect(code).toBe(1)
    expect(verifySignature(runner.plan.bundlePath)).toBe(0)
    expect(readFileSync(runner.resultPath, 'utf8')).toContain('reason=application-did-not-start')
  })

  it('rolls back immediately when the new version reports a fatal startup failure', async () => {
    // 审计复核 P1：新版可能"起来了但根本不是应用"（启动路径上的致命错误会弹**同步**对话框，
    // 进程带着目标主程序活很久）。它在弹窗之前写负向标记，帮手必须据此回滚 ——
    // 否则唯一备份会被删掉，用户既没有可用的新版、也没有可退回的旧版。
    const runner = runHelper()
    const marker = setInterval(() => {
      writeFileSync(
        runner.bootFailurePath,
        `version=2.0.0\nbundle=${runner.plan.bundlePath}\n`,
        'utf8',
      )
    }, 50)
    const code = await runner.exited
    clearInterval(marker)

    expect(code).toBe(1)
    // 回滚完成：目标还是旧的那一份，备份已换回原位（不是被当成成功删掉）。
    expect(readFileSync(join(runner.plan.bundlePath, 'Contents', 'Resources', 'marker.txt'), 'utf8')).toBe('OLD-BUILD')
    expect(existsSync(runner.plan.backupPath)).toBe(false)
    const result = readFileSync(runner.resultPath, 'utf8')
    expect(result).toContain('status=failed')
    expect(result).toContain('reason=application-did-not-start')
    expect(readFileSync(runner.logPath, 'utf8')).toContain('reported a fatal startup failure')
  })

  it('refuses to move anything when the staged copy fails code signature verification', async () => {
    const runner = runHelper({ sourceIsTampered: true })
    expect(await runner.exited).toBe(1)

    expect(readFileSync(join(runner.plan.bundlePath, 'Contents', 'Resources', 'marker.txt'), 'utf8')).toBe('OLD-BUILD')
    expect(existsSync(runner.plan.backupPath)).toBe(false)
    expect(existsSync(runner.plan.stagingPath)).toBe(false)
    const result = readFileSync(runner.resultPath, 'utf8')
    expect(result).toContain('status=failed')
    expect(result).toContain('reason=verification-failed')
  })

  it('touches nothing while the host process is still running', async () => {
    const runner = runHelper({ keepHostAlive: true })
    expect(await runner.exited).toBe(1)

    expect(readFileSync(join(runner.plan.bundlePath, 'Contents', 'Resources', 'marker.txt'), 'utf8')).toBe('OLD-BUILD')
    expect(existsSync(runner.plan.stagingPath)).toBe(false)
    expect(existsSync(runner.plan.backupPath)).toBe(false)
    const result = readFileSync(runner.resultPath, 'utf8')
    expect(result).toContain('status=failed')
    expect(result).toContain('reason=application-still-running')
  })
})
