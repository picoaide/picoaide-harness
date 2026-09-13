/**
 * tests/sync-provenance-tmp-landing-symlink.test.js — me-1 回归（P1，R7 审计）。
 *
 * 缺陷：`updateGlobalTracks` / `updateGlobalEnabled` 把 PROVENANCE 的**最终**
 * 落点过了 `resolveSafeRepoTarget`，但手写的
 *   `const tmp = `${provPath}.tmp.${process.pid}`; writeFileSync(tmp, …); renameSync(tmp, provPath)`
 * 里 **tmp 从未被断言**。预置一个同名真符号链接（pid 在本机 /proc 可见，
 * 无需猜测）后：
 *   - `writeFileSync(tmp, …)` 跟随链接，把 PROVENANCE JSON 覆盖到**仓库外**
 *     的任意文件；
 *   - `renameSync(tmp, provPath)` 再把那个符号链接搬到 PROVENANCE 上——
 *     git 会把它记成 120000 条目并同步到其它设备；
 *   - 命令仍然返回 `{"kind":"success"}`。
 *
 * 「改前失败」证据（改前代码跑本文件，两个用例都红）：
 *   - 仓外受害者文件被写成 `{"projectId":"global","tracks":{…},"enabled":true}`；
 *   - `PROVENANCE` 变成指向仓外的符号链接；
 *   - 命令返回 `kind: "success"`（断言 `notEqual(outcome.kind,'success')` 红）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleCommand, installMemorySync } from '../lib/sync/index.js'

const OUTSIDE_TEXT = 'ORIGINAL-OUTSIDE-CONTENT\n'

function provText(tracks = {}, enabled = true) {
  return `${JSON.stringify({ projectId: 'global', tracks, enabled })}\n`
}

/**
 * 记忆根：真 PROVENANCE + 仓外受害者文件 + 在 `<PROVENANCE>.tmp.<pid>`
 * 预置的真符号链接（本进程 pid 即写入方 pid，与攻击者在本机可观测一致）。
 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-me1-prov-'))
  const memoryDir = join(root, 'memories')
  mkdirSync(memoryDir, { recursive: true })
  const outside = join(root, 'outside-victim.txt')
  writeFileSync(outside, OUTSIDE_TEXT)
  const provPath = join(memoryDir, 'PROVENANCE')
  writeFileSync(provPath, provText())
  const tmpLink = join(memoryDir, `PROVENANCE.tmp.${process.pid}`)
  symlinkSync(outside, tmpLink)
  return { root, memoryDir, outside, provPath, tmpLink }
}

test('me-1：全局轨开关不得沿 PROVENANCE.tmp.<pid> 预置符号链接写出仓外', async (t) => {
  const { root, memoryDir, outside, provPath, tmpLink } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const before = readFileSync(provPath, 'utf8')

  const outcome = await handleCommand('global', ['on', 'user'], root, {
    config: { memoryDir },
    getRuntime: () => undefined,
    applyRuntimePatch: () => {},
  })

  assert.notEqual(
    outcome.kind,
    'success',
    `预置 tmp 符号链接时命令不得报成功（实际 ${JSON.stringify(outcome)}）`,
  )
  assert.equal(readFileSync(outside, 'utf8'), OUTSIDE_TEXT, '仓外受害者文件被写穿')
  assert.equal(lstatSync(provPath).isSymbolicLink(), false, 'PROVENANCE 被换成了指向仓外的符号链接')
  assert.equal(readFileSync(provPath, 'utf8'), before, 'PROVENANCE 内容被改写')
  assert.equal(lstatSync(tmpLink).isSymbolicLink(), true, '预置的符号链接不应被写穿/改名')
})

test('me-1：无预置链接时同一命令照常成功（对照组，证明修复没有把正常路径修死）', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-me1-ok-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const memoryDir = join(root, 'memories')
  mkdirSync(memoryDir, { recursive: true })
  writeFileSync(join(memoryDir, 'PROVENANCE'), provText())

  const outcome = await handleCommand('global', ['on', 'user'], root, {
    config: { memoryDir },
    getRuntime: () => undefined,
    applyRuntimePatch: () => {},
  })

  assert.equal(outcome.kind, 'success', `正常路径应当成功：${JSON.stringify(outcome)}`)
  const prov = join(memoryDir, 'PROVENANCE')
  assert.equal(lstatSync(prov).isSymbolicLink(), false)
  assert.equal(JSON.parse(readFileSync(prov, 'utf8')).tracks.user, true, '轨位未落盘')
})

test('me-1：enabled 位写入（共享记忆库停用）同样拒绝预置 tmp 符号链接', async (t) => {
  const { root, memoryDir, outside, provPath, tmpLink } = fixture()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const before = readFileSync(provPath, 'utf8')

  const ops = installMemorySync(
    { get: () => undefined },
    { config: { memoryDir }, getRuntime: () => undefined, applyRuntimePatch: () => {} },
  ).ops
  const outcome = await ops.setGlobalRemote('', false)

  assert.notEqual(outcome.kind, 'success', `停用操作不得报成功：${JSON.stringify(outcome)}`)
  assert.equal(readFileSync(outside, 'utf8'), OUTSIDE_TEXT, '仓外受害者文件被写穿')
  assert.equal(lstatSync(provPath).isSymbolicLink(), false, 'PROVENANCE 被换成了符号链接')
  assert.equal(readFileSync(provPath, 'utf8'), before, 'PROVENANCE 内容被改写')
  assert.equal(lstatSync(tmpLink).isSymbolicLink(), true, '预置的符号链接不应被写穿/改名')
})
