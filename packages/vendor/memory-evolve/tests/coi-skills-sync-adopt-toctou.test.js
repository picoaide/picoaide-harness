/**
 * tests/coi-skills-sync-adopt-toctou.test.js — 独立复审 r3 **F1** 的回归：
 * 「内容同一性采纳」把"判定"与"写溯源"做成了两段，中间那个窗口里落进目标目录的
 * 用户字节会被连同目录一起盖上 `channel: 'plugin'`。
 *
 * 复审实测（temp/verify-skill-r3，真磁盘）：目标 = 随包技能逐字副本 + 一个把比较
 * 窗口拉宽的大文件，在同步进行到 ~250–600ms 时写入 `MY-NOTES.md` ⇒ 5 次里 3 次
 * `{"action":"adopted","provenanceChannel":"plugin","stampedUserContent":true}`；
 * 下一轮随包升 `x-version` 时 `{"action":"synced","userFileSurvived":false}`
 * —— 用户文件被静默删除，这是数据丢失路径。
 *
 * 本用例把"撞窗口"换成**确定性注入**（`tests/fixtures/fs-toctou-hook.mjs`：在采纳
 * 分支唯一的那次 fd 写之后立刻写入用户文件），因此每次运行都落在同一个窗口里。
 *
 * 判据（修复后）：
 *   1. `refused` + `SKILL_LOCAL_CONTENT`（不是 adopted）；
 *   2. 用户文件一字不动；
 *   3. 自己刚写的 `.picoaide/`（+ `.install-version`）被收回 —— 既不留"溯源已写、
 *      内容被换"的中间态，也不能让下一次开机同步拿着刷出来的溯源去覆盖用户内容；
 *   4. 目录里**没有**任何 plugin 溯源。
 *
 * 变异验证：把"写后复检"去掉（回到"先比较、后写溯源"的两段式）⇒ 本文件第一例
 * 必红（复现为 `adopted` + `provenance=plugin`）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, '..')
const CHILD = join(HERE, 'fixtures', 'child-skills-sync-toctou.mjs')
const REGISTER = join(HERE, 'fixtures', 'register-toctou.mjs')

/**
 * 跑一次子进程并把最后一行 JSON 解析出来。
 * @param {{fault:boolean, injectAt?:number}} options - `fault` = 装上 TOCTOU 垫片。
 * @returns {object} 子进程打印的落点事实。
 */
function run({ fault, injectAt = 1 }) {
  const env = {
    ...process.env,
    SKILLS_SYNC_MODULE: join(PKG, 'lib', 'coi', 'skills-sync.js'),
  }
  if (fault) {
    // 注入落点在子进程里才算得出来（mkdtemp），所以这里只给"武装"开关：
    // 子进程把 TOCTOU_FILE 设成 <dest>/MY-NOTES.md（见 fixtures/child-skills-sync-toctou.mjs）。
    env.TOCTOU_ARM = '1'
    env.TOCTOU_ON = String(injectAt)
  }
  const result = spawnSync(process.execPath, fault ? ['--import', REGISTER, CHILD] : [CHILD], {
    env,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `child failed: ${result.stderr}`)
  const json = result.stdout.trim().split('\n').filter((line) => line.trim().startsWith('{')).pop()
  return JSON.parse(json ?? '{}')
}

/* ------------------------------------------------ 1) 对照组：正常采纳不受影响 */

test('F1 对照组：无注入 ⇒ adopted，正文一字未动、补写 channel: plugin', () => {
  const out = run({ fault: false })
  assert.equal(out.entry.action, 'adopted', `对照组必须采纳：${JSON.stringify(out.entry)}`)
  assert.equal(out.notes, null, '对照组不该有用户文件')
  assert.equal(JSON.parse(String(out.provenance)).channel, 'plugin')
  assert.match(String(out.skill), /# BUNDLED/u, '正文一字未动')
})

/* --------------------------------- 2) 注入：比较窗口里落入用户字节 ⇒ 必须拒收 */

test('F1 采纳窗口里落入用户文件 ⇒ refused（不采纳），用户文件保留、自己写的溯源收回', () => {
  // 注入点：采纳分支写 release.json 的那一次 fd 写**之后**（= 判定通过、溯源刚落地）。
  const out = run({ fault: true, injectAt: 1 })

  assert.equal(
    out.entry.action,
    'refused',
    `窗口里出现用户字节 ⇒ 不得采纳（会把用户内容标成 plugin 后在下一次升版时删掉）：${JSON.stringify(out.entry)}`,
  )
  assert.equal(out.entry.code, 'SKILL_LOCAL_CONTENT', '拒绝码要与"用户自制内容"同一档（可区分且不误导）')
  // **必须是被"写后复检"拒的**，不能是被前置的同一性判据拒的 —— 否则用例会因为
  // 注入点落错（例如落在取锁那一刻）而"因错误的原因变绿"，而真正的窗口没被覆盖。
  assert.match(String(out.entry.message), /补写溯源期间/u, '判据必须是"写后复检"，不是前置判定')
  // 用户字节必须原样在盘上。
  assert.match(String(out.notes), /我的笔记/u, '用户文件不得被删除或改写')
  // 自己刚写的标记必须收回：目录里不许留"内容没换、溯源是 plugin"的中间态。
  assert.equal(out.provenance, null, '写后复检不成立时必须收回自己写下的 release.json')
  assert.equal(out.installVersion, null, '同理收回 .install-version（本次才创建的）')
  assert.deepEqual(out.destEntries, ['MY-NOTES.md', 'SKILL.md', 'scripts'], '目录只该多出用户那一份文件')
})

test('F1 注入点=第 2 次 fd 写（补写 .install-version 时）⇒ 同样 refused 且标记全收回', () => {
  // 覆盖"复检必须晚于**全部**标记写入"：只盯着 release.json 那一次写还不够，
  // `.install-version` 是同一分支的第二次 fd 写（x-version 存在才会写）。
  const out = run({ fault: true, injectAt: 2 })
  assert.equal(out.entry.action, 'refused', `第二次 fd 写之后落进用户字节同样要拒：${JSON.stringify(out.entry)}`)
  assert.equal(out.entry.code, 'SKILL_LOCAL_CONTENT')
  assert.match(String(out.entry.message), /补写溯源期间/u, '同样是"写后复检"这一档')
  assert.match(String(out.notes), /我的笔记/u)
  assert.equal(out.provenance, null)
  assert.equal(out.installVersion, null)
})
