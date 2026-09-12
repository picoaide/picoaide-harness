/**
 * 回归守卫：归档内路径的**分隔符适配**（2026-09-12，Windows 打包实测红灯）。
 *
 * 症状：Linux 门禁绿、Windows 门禁红 —— `verify-packaged-runtime` 报
 * `"build/web-brand/favicon.svg" was not found in this archive`，而同一个包在 Linux 上
 * 逐条都能读出来。
 *
 * 根因：`@electron/asar` v3 的 `Filesystem#getNode()` 用 `path.dirname()`/`basename()`
 * 拆输入，再用 `searchNodeFromDirectory()` 里的 `p.split(path.sep)` 逐级下钻。Windows 上
 * `path.sep === '\\'`，于是**用 `/` 分隔的归档内路径整串被当成一个目录名** → 查不到。
 * 同一份 `path.sep` 依赖也解释了"列举得到、却读不出来"：`listPackage()` 的回报是
 * `path.join()` 拼的平台原生形状（带前导分隔符）。
 *
 * 因此门禁两侧都必须适配：比较前 `normalizeAsarEntry()`，读取前 `toAsarEntryPath()`。
 * 本 spec 用**显式分隔符**锁住 Windows 行为（桌面测试只在 Linux 上跑，真机语义靠这里固定），
 * 并用真实 asar 归档做一次端到端读取。
 */
import { createPackage, extractFile, listPackage } from '@electron/asar'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { normalizeAsarEntry, toAsarEntryPath } from '../scripts/asar-entry-path.ts'

const ENTRY = 'build/web-brand/favicon.svg'
// 临时目录放在包内（沙箱下 /tmp 不可靠；与包内其它 spec 一致）。
const root = mkdtempSync(join(process.cwd(), 'tests', '.asar-entry-path-'))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('toAsarEntryPath', () => {
  it('Windows 分隔符：转成反斜杠（getNode 按 path.sep 切分，必须匹配）', () => {
    expect(toAsarEntryPath(ENTRY, '\\')).toBe('build\\web-brand\\favicon.svg')
  })

  it('POSIX 分隔符：原样保留', () => {
    expect(toAsarEntryPath(ENTRY, '/')).toBe(ENTRY)
  })

  it('去掉前导分隔符（extractFile 不接受前导斜杠）', () => {
    expect(toAsarEntryPath('/build/channel.json', '/')).toBe('build/channel.json')
    expect(toAsarEntryPath('\\build\\channel.json', '\\')).toBe('build\\channel.json')
  })

  it('缺省使用当前平台分隔符', () => {
    expect(toAsarEntryPath(ENTRY)).toBe(sep === '/' ? ENTRY : ENTRY.split('/').join(sep))
  })
})

describe('normalizeAsarEntry', () => {
  it('两种分隔符、前导与尾随分隔符都归一化成同一把键', () => {
    expect(normalizeAsarEntry('\\build\\channel.json')).toBe('build/channel.json')
    expect(normalizeAsarEntry('/build/channel.json')).toBe('build/channel.json')
    expect(normalizeAsarEntry('build/channel.json')).toBe('build/channel.json')
  })

  it('目录条目（尾随分隔符）也归一化', () => {
    expect(normalizeAsarEntry('\\build\\web-brand\\')).toBe('build/web-brand')
  })
})

describe('真实归档：列举与读取走同一套适配', () => {
  async function pack(): Promise<string> {
    const source = join(root, 'src')
    mkdirSync(join(source, 'build', 'web-brand'), { recursive: true })
    writeFileSync(join(source, 'build', 'web-brand', 'favicon.svg'), '<svg data-brand="app"/>')
    const archive = join(root, 'app.asar')
    // v3 的 createPackage 是异步的（不 await 会拿到尚未写出的归档）。
    await createPackage(source, archive)
    return archive
  }

  it('归一化后的列举键能匹配门禁里的常量，且能按平台路径读回内容', async () => {
    const archive = await pack()
    const listed = new Set(listPackage(archive, { isPack: false }).map(normalizeAsarEntry))
    // 门禁用的就是这种 '/' 分隔常量：Windows 上不归一化就会漏匹配。
    expect(listed.has(ENTRY)).toBe(true)
    expect(extractFile(archive, toAsarEntryPath(ENTRY)).toString('utf8')).toBe('<svg data-brand="app"/>')
  })

  it('分隔符不匹配就读不出来（这正是 Windows 上的现场）', async () => {
    const archive = await pack()
    const wrong = sep === '/' ? toAsarEntryPath(ENTRY, '\\') : ENTRY
    expect(() => extractFile(archive, wrong)).toThrow(/was not found in this archive/u)
  })
})
