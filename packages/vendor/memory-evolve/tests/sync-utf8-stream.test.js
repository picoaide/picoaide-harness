/**
 * tests/sync-utf8-stream.test.js — 子进程输出「流式解码」回归（2026-09-15 U+FFFD 损坏根因）
 *
 * 缺陷：`runGit()` 曾用裸 `String(chunk)` 逐块解码子进程 stdout/stderr。Buffer 的
 * `String(chunk)` 等价于 `chunk.toString('utf8')`，即**每个管道分块各自独立解码**：
 * 任何跨分块边界的多字节字符（汉字 3 字节、emoji 4 字节）都会被切成两段无效序列、
 * 各解码成一个 U+FFFD。损坏文本再经 `readTreeFiles → parseEntries → mergeEntries
 * → 写回 → 提交` 落盘，于是每次同步都可能再生几处、静默累积（线上实证：MEMORY /
 * daily 日志 45 处替换符，损坏字节偏移恰好落在 32 KiB 分块边界；git 大对象正是按
 * 32 KiB 块写管道的）。同款问题还在 sync/index.js、search-docs.js、coi/scheduler.js。
 *
 * 本文件分两类：
 *   1. **确定性单元测试（主守卫）**：注入假 spawn + 手动 push 的 Readable，把多字节
 *      字符的 UTF-8 字节在**每一个内部切点**切成两次投递，两次之间 `await
 *      setImmediate`——分块边界由测试显式控制，不依赖 OS 管道时序（真实子进程 +
 *      定时分写的写法曾被外援复核证伪为可假绿：父进程稍慢，两段就被合并成一个
 *      data 事件，回归当场失效）。
 *   2. **集成冒烟**：PATH 前置「假 git」二进制走真实 spawn。OS 分块时机不受控，
 *      只验证真实子进程链路能正确拼接、不产生 U+FFFD，**不承担回归守卫职责**。
 *
 * 说明：修复后"不完整的多字节序列"会被 StringDecoder 留在解码器里、等下一块补齐，
 * 因此**不能用 data 事件条数**做前提断言。本文件改用"同一分块序列交给旧的逐块解码
 * 必然损坏"作前提自检——切点若没造成损坏，用例会直接失败而不是假绿。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit } from '../lib/sync/repo.js'

/** 假子进程：stdout/stderr 用可手动 push 的 Readable，测试精确控制分块边界。 */
class FakeChild extends EventEmitter {
  constructor() {
    super()
    // 空 read()：挂上 'data' 监听进入 flowing 模式后，push 的内容立即投递
    this.stdout = new Readable({ read() {} })
    this.stderr = new Readable({ read() {} })
    this.killed = false
  }

  kill() {
    this.killed = true
    return true
  }
}

/** 旧实现（缺陷版）的逐块解码：仅用于测试前提自检，不参与生产代码。 */
function legacyChunkDecode(chunks) {
  let text = ''
  for (const chunk of chunks) text += String(chunk) // 等价于 chunk.toString('utf8')
  return text
}

/**
 * 驱动 `runGit()`：把字符 ch 的 UTF-8 字节在 cut 处切成两次投递。
 * @param {string} ch - 被切的多字节字符。
 * @param {number} cut - 第一段字节数（1..byteLength-1）。
 * @param {'stdout'|'stderr'} which - 切哪一路输出。
 * @returns {Promise<object>} runGit 的结果对象。
 */
async function splitWrite(ch, cut, which) {
  const child = new FakeChild()
  const pending = runGit('/nonexistent-dir', ['show', 'HEAD:x'], { spawnFn: () => child })
  const buf = Buffer.from(ch, 'utf8')
  const segments = [buf.subarray(0, cut), buf.subarray(cut)]
  const stream = which === 'stdout' ? child.stdout : child.stderr
  // 前提自检：这两个分块交给旧解码必然产生 U+FFFD，否则本用例守不住回归
  assert.equal(
    legacyChunkDecode(segments).includes('\uFFFD'),
    true,
    `分块前提不成立：切点 ${cut} 未造成损坏，用例失去意义`,
  )
  stream.push(segments[0])
  await new Promise((resolve) => setImmediate(resolve))
  stream.push(segments[1])
  await new Promise((resolve) => setImmediate(resolve))
  stream.push(null)
  child.emit('close', 0)
  return pending
}

const CASES = [
  ['é', '2 字节字符'],
  ['记', '3 字节汉字'],
  ['😀', '4 字节 emoji'],
]

for (const which of ['stdout', 'stderr']) {
  for (const [ch, label] of CASES) {
    const width = Buffer.byteLength(ch, 'utf8')
    for (let cut = 1; cut < width; cut += 1) {
      test(`runGit 流式解码：${label}「${ch}」在第 ${cut}/${width} 字节处被切开（${which}）不得变成 U+FFFD`, async () => {
        const result = await splitWrite(ch, cut, which)
        assert.equal(result.ok, true)
        const text = which === 'stdout' ? result.stdout : result.stderr
        assert.equal(text.includes('\uFFFD'), false, `解码损坏：${JSON.stringify(text)}`)
        assert.equal(text, ch)
      })
    }
  }
}

test('runGit 流式解码：连续多字符逐字节投递（最坏分块）后完整无损', async () => {
  const child = new FakeChild()
  const pending = runGit('/nonexistent-dir', ['show', 'HEAD:x'], { spawnFn: () => child })
  const phrase = '记忆同步链路的中文内容'
  const buf = Buffer.from(phrase, 'utf8')
  const segments = []
  for (let i = 0; i < buf.length; i += 1) {
    segments.push(buf.subarray(i, i + 1))
    child.stdout.push(segments[i])
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(legacyChunkDecode(segments).includes('\uFFFD'), true, '分块前提不成立')
  child.stdout.push(null)
  child.emit('close', 0)
  const result = await pending
  assert.equal(result.stdout, phrase)
  assert.equal(result.stdout.includes('\uFFFD'), false, `逐字节分块被解码损坏：${JSON.stringify(result.stdout)}`)
})

test('集成冒烟：真实子进程链路（假 git 二进制）不产生 U+FFFD', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-git-utf8-'))
  const bin = mkdtempSync(join(tmpdir(), 'dsh-fakegit-'))
  const fake = join(bin, 'git')
  // 假 git：先写「记」+「忆」的首字节，60ms 后补写剩余两字节再退出（在 write 回调
  // 里退出，避免 process.exit 抢在 flush 之前把第二段截掉）。两段是否被 OS 合并成
  // 一个 data 事件不确定，故本用例只做冒烟：修复后无论怎么分块都必须无 U+FFFD。
  writeFileSync(fake, `#!/usr/bin/env node
const buf = Buffer.from('记忆', 'utf8')
process.stdout.write(buf.subarray(0, 4), () => {
  setTimeout(() => {
    process.stdout.write(buf.subarray(4), () => process.exit(0))
  }, 60)
})
`)
  chmodSync(fake, 0o755)

  const oldPath = process.env.PATH
  process.env.PATH = `${bin}:${oldPath}`
  try {
    const result = await runGit(dir, ['show', 'HEAD:x'])
    assert.equal(result.ok, true, `假 git 应正常退出：${result.stderr}`)
    assert.equal(result.stdout.includes('\uFFFD'), false, `解码损坏：${JSON.stringify(result.stdout)}`)
    assert.equal(result.stdout, '记忆')
  } finally {
    process.env.PATH = oldPath
    rmSync(dir, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
  }
})
