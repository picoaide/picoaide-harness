/**
 * tests/notify-web-read-failure-write-gate.test.js — FIX-48② 判据（第三十三轮）：
 * `notifications.json` 的**读失败**不得被"以空表整文件回写"固化。
 *
 * ## 缺陷原形态（第三十二轮 AE1-02，真 EACCES）
 *
 * `lib/notify-web.js` 的 `NotificationStore#load()` 是裸 catch + **赋值式**空基线
 * （`this.items = []`），而 `add()` 每次都先 `#load()` 再整表 `#save()` ⇒
 * `notifications.json` 一次瞬时读失败（EACCES/EIO/EISDIR，**非 ENOENT**）之后，
 * 下一条通知落盘时就把**盘上其它会话的通知整表换掉**，且 `add()` 回 **`{ok:true}`**
 * （发送内核据此认为通知已送达）。AE1 在 `setpriv --reuid=65534` 下实测：
 *
 *   A 格（文件 0600 root ⇒ nobody 侧 EACCES）
 *     `{ "add_ok": true, "after_ids": ["ntf-…-new"], "others_survived": false }`
 *   B 格（同一流程，只把文件权限改回 0666 —— 正向对照）
 *     `{ "add_ok": true, "after_ids": ["ntf-new","ntf-old-1","ntf-old-2"], "others_survived": true }`
 *
 * 与 AD1 判 P1 的 `session-overrides.json`、FIX-47① 的 `plugin-state.json` **逐条同形**
 * （读失败与"文件不存在"不可区分 + 整表回写 + 写成功回报），收口形态也与之相同。
 *
 * ## 口径（三条一起才闭环）
 *
 *  1. **只把 ENOENT 当空基线**（首次使用必须照常放行）；
 *  2. **写前闸门**：读失败的路径记进 `store.loadErrors`，`#save()` / `remove()`
 *     一致拒写 ⇒ `add()` 回 `{ok:false, message}`，API 层转 500 JSON 信封；
 *  3. **可检索日志**：读失败时打印 `notifications.json 不可读（CODE）` +
 *     `refuse to overwrite baseline`（排障时能一眼认出，而不是静默）。
 *
 * ## 判据
 *
 *  A. 读失败（ELOOP / EISDIR）⇒ `add()` **ok:false** + 盘上原字节**逐字节不变**
 *     （其它会话的通知全部存活）；
 *  B. 读失败 ⇒ `remove()` 也不得删正文/附件文件（不制造"半删除"），抛错由 API 层转 500；
 *  C. 正向对照：ENOENT = 首次使用 ⇒ 照常 `ok:true` 且文件被创建；
 *  D. 正向对照：健康文件 ⇒ `ok:true` 且**其它通知全部保留**（防"无条件拒写"蒙混）；
 *  E. 有意差异（既有契约，不改）：内容不可解析 ⇒ 照常空表复位且可继续写
 *     （字节已被看到，属声明式重置；读失败的字节**从未被看到**，所以只有它拒写）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NotificationStore } from '../lib/notify-web.js'

const FILE = 'notifications.json'

const tempDir = () => mkdtempSync(join(tmpdir(), 'dsh-fix48-notify-'))

/** 两格种子：模拟"别的会话已经发过的通知"（时间戳必须落在 30 天保留期内，否则 `#prune` 会先裁掉）。 */
const SEED = {
  items: [
    { id: 'ntf-old-1', sender: 'session-old-1', semantic: 'notify', subject: 'OLD-1', content: 'a', createdAt: Date.now() - 1000, read: false },
    { id: 'ntf-old-2', sender: 'session-old-2', semantic: 'notify', subject: 'OLD-2', content: 'b', createdAt: Date.now() - 2000, read: false },
  ],
}

/** 组装一条最小通知输入。 */
const input = (content) => ({ sender: 'session-new', semantic: 'notify', content })

/** 建"目录占位"（EISDIR）。 */
function seedDirPlaceholder(root) {
  const dir = join(root, 'notifications')
  mkdirSync(join(dir, FILE), { recursive: true })
  writeFileSync(join(dir, FILE, 'user-bytes.txt'), 'old')
  return join(dir, FILE)
}

/** 建"符号链接自环"（ELOOP）。 */
function seedLoop(root) {
  const dir = join(root, 'notifications')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, FILE)
  symlinkSync(`${file}.loop-b`, file)
  symlinkSync(file, `${file}.loop-b`)
  return file
}

test('FIX-48② / notifications：读失败（EISDIR 目录占位）⇒ add() 回 ok:false，不产生新文件', async () => {
  const root = tempDir()
  try {
    const file = seedDirPlaceholder(root)
    const store = new NotificationStore(root)
    const result = await store.add(input('NEW'))
    assert.equal(result.ok, false, `读失败时必须以空基线回写被拒（修前：ok:true 且通知表被换掉），实得 ${JSON.stringify(result)}`)
    assert.match(String(result.message ?? ''), /不可读|拒绝写入/u, `错误信息必须可判别，实得 ${JSON.stringify(result)}`)
    assert.equal(existsSync(file), true, '原路径的目录占位不得被换成新文件')
    assert.equal(readFileSync(join(file, 'user-bytes.txt'), 'utf8'), 'old', '原字节必须逐字节不变')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('FIX-48② / notifications：读失败（ELOOP）⇒ add() 回 ok:false，落点原样未被换掉', async () => {
  const root = tempDir()
  try {
    const file = seedLoop(root)
    const store = new NotificationStore(root)
    const result = await store.add(input('NEW'))
    assert.equal(result.ok, false, `读失败必须拒写，实得 ${JSON.stringify(result)}`)
    assert.equal(lstatSync(file).isSymbolicLink(), true, '落点必须原样保留（既没被换成新文件，也没被删）')
    assert.equal(readlinkSync(file), `${file}.loop-b`, '符号链接目标不得被改写')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('FIX-48② / notifications：读失败 ⇒ remove() 拒删（不得先删正文文件再失败）', async () => {
  const root = tempDir()
  try {
    const file = seedDirPlaceholder(root)
    const store = new NotificationStore(root)
    assert.throws(
      () => store.remove('ntf-old-1'),
      /不可读|拒绝写入/u,
      '读失败时 remove() 必须 fail-closed（它会先删正文/附件再落盘 ⇒ 半删除比拒删更糟）',
    )
    assert.equal(existsSync(join(file, 'user-bytes.txt')), true, '正文占位文件不得被删')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('FIX-48② / notifications（正向对照）：ENOENT = 首次使用 ⇒ 照常 ok:true 并落盘', async () => {
  const root = tempDir()
  try {
    const store = new NotificationStore(root)
    const result = await store.add(input('FIRST'))
    assert.equal(result.ok, true, `首次使用必须照常放行，实得 ${JSON.stringify(result)}`)
    const written = JSON.parse(readFileSync(join(root, 'notifications', FILE), 'utf8'))
    assert.equal(written.items.length, 1)
    assert.equal(written.items[0].content, 'FIRST')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('FIX-48② / notifications（正向对照）：健康文件 ⇒ ok:true 且其它通知全部保留', async () => {
  const root = tempDir()
  try {
    const dir = join(root, 'notifications')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, FILE), `${JSON.stringify(SEED, null, 2)}\n`)
    const store = new NotificationStore(root)
    const result = await store.add(input('NEW'))
    assert.equal(result.ok, true, `健康基线必须照常放行，实得 ${JSON.stringify(result)}`)
    const ids = JSON.parse(readFileSync(join(dir, FILE), 'utf8')).items.map((i) => i.id)
    assert.equal(ids.includes('ntf-old-1') && ids.includes('ntf-old-2'), true, `其它会话的通知必须全部保留，实得 ${JSON.stringify(ids)}`)
    assert.equal(ids.length, 3)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('FIX-48② / notifications（有意差异）：内容不可解析 ⇒ 照常空表复位且可继续写', async () => {
  const root = tempDir()
  try {
    const dir = join(root, 'notifications')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, FILE), '{ 坏 JSON')
    const store = new NotificationStore(root)
    assert.equal(store.list('all').length, 0)
    const result = await store.add(input('AFTER-CORRUPT'))
    assert.equal(result.ok, true, `字节已读到的解析失败属声明式重置（既有契约），实得 ${JSON.stringify(result)}`)
    assert.equal(store.unreadCount(), 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
