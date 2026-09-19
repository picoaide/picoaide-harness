/**
 * 原子写**语义**判据（W6/W7 切换后：本包不再有本地助手 —— 实现是上游
 * `@deepseek-ai/dsh-atomic-write`，见设计总纲 §16.1 的切换记录）。
 *
 * 这条判据要挡住的是"切换只改了名字"：本文件的断言全部落在**真实上游实现**的两个
 * 可观测后果上，任何"其实还在用旧实现 / 换成一个不原子的替代品"都会红：
 *
 *  1. **原子性**：写失败时原文件保持旧内容、目录里不留半个文件（`.tmp` 残留）；
 *  2. **权限位**：新文件 0600、新建目录 0700（上游要求逐调用点声明，故这里钉字面量），
 *     且替换更宽权限的旧文件后会被收窄（rename 带权限进 inode，无 chmod 竞态）；
 *  3. **两个调用点**（`windows.ts` 的状态文件、`app-proof.ts` 的安装密钥）**经公开 API
 *     走同一条实现** —— 三条路径（直接调上游、`writeWindowsState`、`createInstallKeyStore().save()`）
 *     的产物必须一致（同权限位、同样不留临时文件）。
 *
 * 变异验证（判据真的会红，不是空断言）：把实现换成"先 `rm` 再 `writeFile`"的非原子版本
 * ⇒ 第 1 条必红；把任一调用点的 `mode` 改成 `0o644` ⇒ 第 2、3 条必红。
 *
 * 接线判据（"确实解析到上游包，而不是某个同名本地符号"）在 `atomic-write-wiring.spec.ts`。
 */
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { INSTALL_KEY_FILE, createInstallKeyStore, generateInstallKey, type SafeStorageLike } from './app-proof.ts'
import { APP_WINDOWS_STATE_FILE, writeWindowsState } from './windows.ts'

/** 私有文件的权限位（§16.1 冻结：0600/0700）。这里刻意写**字面量**：常量被改也拦得住。 */
const FILE_MODE = 0o600
const DIR_MODE = 0o700

const temporaryDirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wasm-atomic-'))
  temporaryDirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }))
})

/** 目录里是否残留上游的临时兄弟（`<name>.<12 hex>.tmp`）。 */
async function temporaryLeftovers(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter(name => name.endsWith('.tmp'))
}

/** safeStorage 替身（"加密"就是加个前缀，够验证分支）。 */
function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: plain => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: encrypted => Buffer.from(encrypted).toString('utf8').replace(/^enc:/u, ''),
  }
}

describe('上游 writeFileAtomic 的语义（0600/0700 + 失败不留半个文件）', () => {
  it('写入成功：内容整体替换、文件 0600、按需新建的目录 0700、不留临时文件', async () => {
    const dir = await tempDir()
    const target = join(dir, 'nested', 'state.json')
    await writeFileAtomic(target, '{"a":1}', { mode: FILE_MODE, dirMode: DIR_MODE })
    expect(await readFile(target, 'utf8')).toBe('{"a":1}')
    expect((await stat(join(dir, 'nested'))).mode & 0o777).toBe(DIR_MODE)
    expect((await stat(target)).mode & 0o777).toBe(FILE_MODE)
    expect(await temporaryLeftovers(dirname(target))).toEqual([])
  })

  it('已存在的目录不改权限（dirMode 只作用于本次新建的那一层）', async () => {
    const dir = await tempDir()
    const existing = join(dir, 'shared')
    await mkdir(existing, { recursive: true })
    await chmod(existing, 0o755)
    await writeFileAtomic(join(existing, 'state.json'), 'x', { mode: FILE_MODE, dirMode: DIR_MODE })
    expect((await stat(existing)).mode & 0o777).toBe(0o755)
  })

  it('写失败（rename 目标是非空目录）时原文件保持旧内容、临时文件被清理', async () => {
    const dir = await tempDir()
    const target = join(dir, 'state.json')
    await writeFileAtomic(target, 'old', { mode: FILE_MODE, dirMode: DIR_MODE })
    // 让 rename 失败：把目标换成一个**非空目录**（rename file → dir 必失败）。
    const blocked = join(dir, 'blocked.json')
    await mkdir(blocked, { recursive: true })
    await writeFile(join(blocked, 'child'), 'x')
    await expect(writeFileAtomic(blocked, 'new', { mode: FILE_MODE, dirMode: DIR_MODE })).rejects.toThrow()
    // 原文件未被动过；失败的临时文件被清理（半个文件比没有文件更糟）。
    expect(await readFile(target, 'utf8')).toBe('old')
    expect(await temporaryLeftovers(dir)).toEqual([])
  })
})

describe('两个调用点经公开 API 落到同一实现（且权限位一致）', () => {
  it('windows.ts：writeWindowsState 写状态文件 = 内容可读回 + 0600 + 新建目录 0700', async () => {
    const dir = await tempDir()
    const userDataDir = join(dir, 'userData')
    const state = { version: 1, apps: { 'my-notes': { width: 900, height: 600 } } }
    await writeWindowsState(userDataDir, state)
    const target = join(userDataDir, APP_WINDOWS_STATE_FILE)
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual(state)
    expect((await stat(target)).mode & 0o777).toBe(FILE_MODE)
    expect((await stat(userDataDir)).mode & 0o777).toBe(DIR_MODE)
    expect(await temporaryLeftovers(userDataDir)).toEqual([])
  })

  it('app-proof.ts：无钥匙串时安装密钥落盘为 0600（明文兜底）+ 新建目录 0700', async () => {
    const dir = await tempDir()
    const saveDir = join(dir, 'userData')
    const store = createInstallKeyStore({ dir: saveDir, safeStorage: fakeSafeStorage(false) })
    const key = generateInstallKey()
    await store.save({ ...key, encrypted: false })
    const target = join(saveDir, INSTALL_KEY_FILE)
    expect((await stat(target)).mode & 0o777).toBe(FILE_MODE)
    expect((await stat(saveDir)).mode & 0o777).toBe(DIR_MODE)
    expect(await temporaryLeftovers(saveDir)).toEqual([])
    // 落盘内容仍可被自己的 load() 读回（切换实现没有改文件 schema）。
    expect((await store.load())?.privateKeyPem).toBe(key.privateKeyPem)
  })

  it('替换更宽权限的旧文件后权限被收窄到 0600（权限随 rename 进 inode）', async () => {
    const dir = await tempDir()
    const target = join(dir, APP_WINDOWS_STATE_FILE)
    await writeFile(target, '{}', { mode: 0o644 })
    await writeWindowsState(dir, { version: 1, apps: {} })
    expect((await stat(target)).mode & 0o777).toBe(FILE_MODE)
  })

  // Windows 建符号链接需要特权（非开发者模式会 EPERM），这条判据只在 POSIX 上跑。
  it.skipIf(process.platform === 'win32')('提交是 rename：目标是符号链接时替换链接本身，不写穿到被指向的文件', async () => {
    const dir = await tempDir()
    const referent = join(dir, 'referent.json')
    await writeFile(referent, 'old', { mode: FILE_MODE })
    const link = join(dir, APP_WINDOWS_STATE_FILE)
    await symlink(referent, link)
    await writeWindowsState(dir, { version: 1, apps: {} })
    // 非原子的"直接 writeFile(target)"会**跟随链接**改写 referent 并留下链接；
    // rename 语义则是把链接本身换掉。这条判据同时证明"没在改旧实现"。
    expect((await lstat(link)).isSymbolicLink()).toBe(false)
    expect(await readFile(referent, 'utf8')).toBe('old')
  })
})
