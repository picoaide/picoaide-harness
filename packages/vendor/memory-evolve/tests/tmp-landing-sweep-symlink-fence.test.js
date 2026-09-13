/**
 * tests/tmp-landing-sweep-symlink-fence.test.js — 同一根因族收口（R7 审计
 * me-1/me-2 的横向排查）。
 *
 * 缺陷族：手写的 `<file>.tmp.<process.pid>`（以及 `.bak.<Date.now()>`）落点
 * 从不经过断言。pid 在本机 /proc 可见、时间戳可枚举 —— 预置同名真符号链接
 * 即可让 `writeFileSync`/`copyFileSync` 跟随链接写穿到任意路径，而调用方仍
 * 报成功。me-1/me-2 修的是最危险的两处（PROVENANCE 与 drift 备份），但同一
 * 写法在 `lib/**` 里另有近 20 处（aliases / bookmarks / canvas / coi/*
 * 各状态存储 / skills / session-orch / notify-web / index 的运行时状态 …）。
 *
 * 本文件是**结构性哨兵 + 代表性行为探针**：
 *   - 结构：`${…}.tmp.${process.pid}` 只允许出现在唯一实现
 *     `lib/sync/filesets.js`（writeFileAtomicSafe / openExclusiveSafe）里；
 *     `.bak.${Date.now()}` 一律不得再手写；
 *   - 行为：对 5 个代表性存储预置 `<file>.tmp.<pid>` 符号链接，断言仓外受害
 *     文件逐字节未变（修复前：被写成 JSON 正文）。
 *
 * 「改前失败」证据（改前代码跑本文件）：结构哨兵命中 20 处手写落点；代表性
 * 探针里仓外受害者文件被写成存储 JSON（断言等于原文红）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AliasStore } from '../lib/aliases.js'
import { writeCanvas } from '../lib/canvas.js'
import { SessionOrchStore } from '../lib/session-orch.js'
import { SessionStore } from '../lib/coi/session-store.js'
import { NotificationStore } from '../lib/notify-web.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const LIB_DIR = join(HERE, '..', 'lib')
/** 唯一实现（写落点断言 + O_EXCL 原子写的家）。 */
const PRIMITIVE = join(LIB_DIR, 'sync', 'filesets.js')
/**
 * 裸 fs 写 + 第一个参数就是 tmp/备份落点（`writeFileAtomicSafe*` 不在其列：
 * 它们的落点参数同样由唯一实现断言）。
 */
const RAW_WRITE_TO_LANDING_RE = /\b(?:writeFileSync|copyFileSync|appendFileSync|writeFile)\s*\(\s*[^,)]*(?:tmp|backup|\.bak|corrupt)/i
const OUTSIDE_TEXT = 'ORIGINAL-OUTSIDE-CONTENT\n'

/** 递归收集 lib/**\/*.js。 */
function walkJs(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walkJs(full))
    else if (entry.endsWith('.js')) out.push(full)
  }
  return out
}

test('结构哨兵：临时/备份落点不得再由裸 fs 写（唯一实现 lib/sync/filesets.js 除外）', () => {
  const handRolledTmp = []
  const rawWritesToLanding = []
  for (const file of walkJs(LIB_DIR)) {
    const src = readFileSync(file, 'utf8')
    const rel = relative(LIB_DIR, file).split('\\').join('/')
    if (file !== PRIMITIVE && (/\.tmp[.-]?\$\{process\.pid\}/.test(src) || /\$\{process\.pid\}\.tmp/.test(src))) {
      handRolledTmp.push(rel)
    }
    // 裸 fs 写（writeFileSync / copyFileSync / appendFileSync / writeFile）的
    // 第一个参数就是临时/备份落点 → 落点未过断言，预置同名符号链接即跟随。
    for (const line of src.split('\n')) {
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue // 注释里的历史引用不算
      if (RAW_WRITE_TO_LANDING_RE.test(line)) rawWritesToLanding.push(`${rel}: ${line.trim().slice(0, 90)}`)
    }
  }
  assert.deepEqual(
    handRolledTmp,
    [],
    '仍存在手写 `${file}.tmp.${process.pid}` 落点：必须改用 writeFileAtomicSafe / writeFileAtomicSafeAt（预置同名符号链接即写穿目录外）',
  )
  assert.deepEqual(
    rawWritesToLanding,
    [],
    '仍存在裸 fs 写到临时/备份落点：必须改用安全原子写（writeFileAtomicSafe / writeFileAtomicSafeAt[Async]）',
  )
})

/**
 * 一个代表性存储的行为探针：在 `<target>.tmp.<pid>` 预置符号链接后触发一次
 * 落盘，断言仓外受害者文件逐字节未变。
 * @param {{name: string, target: string, trigger: () => unknown}} p
 */
function probeTmpLanding({ name, target, trigger }) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sweep-'))
  try {
    const outside = join(root, 'outside-victim.txt')
    writeFileSync(outside, OUTSIDE_TEXT)
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(outside, `${target}.tmp.${process.pid}`)
    try {
      const pending = trigger()
      // 落点被拒 → fail-loud（同步抛错或 async 返回 rejected promise）都是预期形态，
      // 另一形态是内部 catch 后告警。
      if (pending && typeof pending.then === 'function') pending.catch(() => {})
    } catch {
      /* 预期：落点被拒 */
    }
    assert.equal(readFileSync(outside, 'utf8'), OUTSIDE_TEXT, `${name}：落盘沿预置 tmp 符号链接写到了仓库外`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('代表性探针：aliases / session-orch / coi session-store / notify-web / canvas 的 tmp 落点都不得写穿', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sweep-all-'))
  try {
    probeTmpLanding({
      name: 'AliasStore',
      target: join(root, 'aliases', 'aliases.json'),
      trigger: () => new AliasStore(join(root, 'aliases')).set('session-1', '别名'),
    })
    probeTmpLanding({
      name: 'SessionOrchStore',
      target: join(root, 'orch', 'sessions.json'),
      trigger: () => new SessionOrchStore(join(root, 'orch')).add({ sessionId: 'child-1', spawnedBy: 'parent-1', prompt: 'hi' }),
    })
    probeTmpLanding({
      name: 'coi SessionStore',
      target: join(root, 'coi', 'sessions.json'),
      trigger: () => new SessionStore(join(root, 'coi', 'sessions.json')).upsert({ id: 'sess-1', scope: 'project' }),
    })
    probeTmpLanding({
      name: 'NotificationStore',
      target: join(root, 'notify', 'notifications', 'notifications.json'),
      trigger: () => new NotificationStore(join(root, 'notify')).add({ sender: 'session-1', semantic: 'notify', subject: 's', content: 'c' }),
    })
    probeTmpLanding({
      name: 'writeCanvas',
      target: join(root, 'canvas', 'canvas', 'boards.json'),
      trigger: () => writeCanvas({ memoryDir: join(root, 'canvas') }, { nodes: [] }, 0),
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('代表性探针：无预置链接时同一批存储照常落盘（对照组）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sweep-ok-'))
  try {
    const aliasDir = join(root, 'aliases')
    assert.equal(new AliasStore(aliasDir).set('session-1', '别名').ok, true)
    assert.match(readFileSync(join(aliasDir, 'aliases.json'), 'utf8'), /别名/)

    const orchDir = join(root, 'orch')
    new SessionOrchStore(orchDir).add({ sessionId: 'child-1', spawnedBy: 'parent-1', prompt: 'hi' })
    assert.match(readFileSync(join(orchDir, 'sessions.json'), 'utf8'), /child-1/)

    const coiFile = join(root, 'coi', 'sessions.json')
    assert.equal(new SessionStore(coiFile).upsert({ id: 'sess-1', scope: 'project' }).ok, true)
    assert.match(readFileSync(coiFile, 'utf8'), /sess-1/)

    const canvasDir2 = join(root, 'canvas')
    assert.equal(writeCanvas({ memoryDir: canvasDir2 }, { nodes: [] }, 0), 1)
    assert.match(readFileSync(join(canvasDir2, 'canvas', 'boards.json'), 'utf8'), /"rev": 1/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
