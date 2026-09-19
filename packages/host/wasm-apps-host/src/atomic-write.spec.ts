/**
 * 原子写助手（B1 裁决：唯一实现）：**写失败不留半个文件** + **权限位 0600/0700**。
 * 变异验证：改成"先 rm(path) 再 writeFile(path)"（非原子）⇒ "失败时保持原内容"必红。
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, atomicWriteFile, ensurePrivateDir } from './atomic-write.ts'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wasm-atomic-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }))
})

/**
 * 原子写助手（B1 裁决：唯一实现）的判据：**写失败不留半个文件** + **权限位 0600/0700**。
 * 变异验证：把 `atomicWriteFile` 改成先 `rm(path)` 再 `writeFile(path)`（非原子）⇒ 下面
 * "目标文件在失败时保持原内容"必红。
 */
describe('atomicWriteFile（唯一实现；待切换到 dsh-atomic-write）', () => {
  it('写入成功、目录 0700、文件 0600，且内容整体替换', async () => {
    const dir = await tempDir()
    const target = join(dir, 'nested', 'state.json')
    await atomicWriteFile(target, '{"a":1}')
    expect(await readFile(target, 'utf8')).toBe('{"a":1}')
    const dirMode = (await stat(join(dir, 'nested'))).mode & 0o777
    const fileMode = (await stat(target)).mode & 0o777
    expect(dirMode).toBe(PRIVATE_DIR_MODE)
    expect(fileMode).toBe(PRIVATE_FILE_MODE)
    // `ensurePrivateDir` 幂等（已存在的目录不改权限）。
    await ensurePrivateDir(join(dir, 'nested'))
    expect((await stat(join(dir, 'nested'))).mode & 0o777).toBe(PRIVATE_DIR_MODE)
    // 不放临时文件（提交点是 rename）。
    expect((await readdir(join(dir, 'nested'))).filter(name => name.includes('.tmp'))).toEqual([])
  })

  it('写失败（目标不可写）时保持原文件与目录干净：不留半个文件', async () => {
    const dir = await tempDir()
    const target = join(dir, 'state.json')
    await atomicWriteFile(target, 'old')
    // 让 rename 失败：把目标换成一个**非空目录**（rename file → dir 必失败）。
    const blocked = join(dir, 'blocked.json')
    await mkdir(blocked, { recursive: true })
    await writeFile(join(blocked, 'child'), 'x')
    await expect(atomicWriteFile(blocked, 'new')).rejects.toThrow()
    // 原文件未被动过；失败的临时文件被清理。
    expect(await readFile(target, 'utf8')).toBe('old')
    expect((await readdir(dir)).filter(name => name.includes('.tmp'))).toEqual([])
  })
})
