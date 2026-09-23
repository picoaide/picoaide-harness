/**
 * tests/coi-skills-sync-marker-gate.test.js — 独立复审 r3 **F2** 的回归：
 * 安装器标记（`.picoaide/release.json`）的读取**没有类型/体积闸门**。
 *
 * 复审实测（temp/verify-skill-r3，真磁盘）：
 *   - 普通文件（8/32MiB 垃圾）⇒ 101ms 内 refused（没问题）；
 *   - **FIFO** ⇒ `readFileSync` 的 `open(O_RDONLY)` 永久阻塞，开机同步
 *     `apply()` **永不返回**（12s 超时被杀，无返回）；
 *   - 512MiB 的符号链接目标 ⇒ 整份读进内存之后才 refused。
 * 本插件的同步挂在启动路径上（`lib/index.js` 的 `apply()` 与 `lib/coi/index.js`），
 * 所以"读标记"这一步必须**绝不阻塞、绝不无界读**。
 *
 * 判据（修复后）：读之前先 `lstat` 要求**普通文件**且 `size <= 64KiB`，否则按
 * "有标记但读不出可用来源"处理 —— `refused` + `SKILL_LOCAL_CONTENT`（**不是**
 * 走内容同一性采纳），原物逐字保留，且**在有界时间内返回**。
 *
 * 为什么每个形态都在子进程里跑：修复前 FIFO 那一档会让**测试进程自己**挂住；
 * 用 `spawnSync(..., { timeout })` 把"无界阻塞"变成"有界的失败"。
 *
 * 变异验证：把 `readMarkerText` 的 lstat/体积闸门去掉（退回裸 `readFileSync`）
 * ⇒ 本文件的 fifo / big / symlink 三例必红（fifo 档表现为子进程被 timeout 杀掉）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const CHILD = join(HERE, 'fixtures', 'child-skills-sync-marker.mjs')
/** 子进程预算：正常形态毫秒级返回；修复前 FIFO 档会一直阻塞到被杀。 */
const CHILD_TIMEOUT_MS = 15_000

/**
 * 在子进程里造一种标记形态并跑一次同步。
 * @param {string} mode - normal | fifo | big | dir | symlink。
 * @returns {object} 子进程打印的落点事实。
 */
function run(mode) {
  const result = spawnSync(process.execPath, [CHILD], {
    env: { ...process.env, SKILLS_SYNC_MODULE: join(PKG, 'lib', 'coi', 'skills-sync.js'), MARKER_MODE: mode },
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
  })
  assert.equal(
    result.signal,
    null,
    `标记形态 ${mode} 必须**有界时间**返回（修复前 FIFO 会阻塞启动同步）：signal=${result.signal} stderr=${result.stderr}`,
  )
  assert.equal(result.status, 0, `child failed (${mode}): ${result.stderr}`)
  const json = result.stdout.trim().split('\n').filter((line) => line.trim().startsWith('{')).pop()
  const out = JSON.parse(json ?? '{}')
  assert.equal(out.setupError, null, `夹具设置失败（${mode}）：${out.setupError}`)
  return out
}

/* ------------------------------------------- 1) 不是"小普通文件"的标记：一律拒收 */

test('F2 FIFO 标记：不阻塞、按"读不出可用来源"拒收，FIFO 原样保留', (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows 没有 FIFO（该形态本身不可构造）')
    return
  }
  const out = run('fifo')
  assert.equal(out.entry.action, 'refused', `FIFO 标记必须被拒（且不得阻塞）：${JSON.stringify(out.entry)}`)
  assert.equal(out.entry.code, 'SKILL_LOCAL_CONTENT')
  assert.match(String(out.entry.message), /读不出可用来源/u, '文案要说明是"标记读不出可用来源"这一档')
  assert.equal(out.marker.kind, 'fifo', '不得删除/替换那个 FIFO')
  assert.match(String(out.skill), /INSTALLED-OLD/u, '目标内容一字不动')
})

test('F2 超过体积上限的标记（内容本身合法）：不整份读入、不按 plugin 放行', () => {
  const out = run('big')
  assert.equal(
    out.entry.action,
    'refused',
    `>64KiB 的标记必须按"看不懂"处理（修复前会被整份读入并当成 plugin 而放行整树换入）：${JSON.stringify(out.entry)}`,
  )
  assert.equal(out.entry.code, 'SKILL_LOCAL_CONTENT')
  assert.match(String(out.skill), /INSTALLED-OLD/u, '目标内容不得被换入')
  assert.equal(out.marker.size > 64 * 1024, true)
  assert.match(String(out.markerBody), /"channel":\s*"plugin"/u, '原标记必须逐字保留（只是不再被信任）')
})

test('F2 标记是目录：拒收且不采纳（原物保留）', () => {
  const out = run('dir')
  assert.equal(out.entry.action, 'refused', `目录不是标记：${JSON.stringify(out.entry)}`)
  assert.equal(out.entry.code, 'SKILL_LOCAL_CONTENT')
  assert.equal(out.marker.kind, 'dir')
  assert.match(String(out.skill), /INSTALLED-OLD/u)
})

test('F2 标记是符号链接（即使指向合法溯源）：不跟随、拒收', () => {
  const out = run('symlink')
  assert.equal(out.entry.action, 'refused', `符号链接一律不算"普通文件"（不跟随读）：${JSON.stringify(out.entry)}`)
  assert.equal(out.entry.code, 'SKILL_LOCAL_CONTENT')
  assert.equal(out.marker.kind, 'symlink', '链接本身不得被删除/替换')
  assert.match(String(out.skill), /INSTALLED-OLD/u)
})

/* ------------------------------------------------- 2) 正常标记：闸门不得误伤 */

test('F2 反向用例：正常的小普通文件标记仍按 plugin 放行（x-version 正常更新）', () => {
  const out = run('normal')
  assert.equal(out.entry.action, 'synced', `正常标记不得被闸门误伤：${JSON.stringify(out.entry)}`)
  assert.match(String(out.skill), /# BUNDLED/u, '正常路径照旧整树换入')
  assert.equal(out.marker.kind, 'file', '标记仍在（A9 保留语义不变）')
})
