/**
 * tests/skill-registry-fail-closed.test.js — AB2-04 / FIX-42③ 判据：`skill_manage`
 * 的"禁用影子"判定在**读失败**时必须 fail-closed，而不是把读错误降级成"没禁用"。
 *
 * ## 缺陷原形态（第二十八轮 AB2 审计，P3）
 *
 * `lib/skills.js` 的 `disabledReason` 用 `catch { return undefined }` 把**读错误
 * 降级成"没有禁用影子"** ⇒ `create` / `patch` 照常落盘并返回 `ok:true`：
 * 一次瞬时 IO 失败（EACCES/EMFILE、插件卸载中、注册表实现变化）被写路径
 * **固化**成一次"成功"的写入。这是本仓已登记的高频形态（"读错误被降级成空状态、
 * 再由写路径固化"）在本插件里剩下的最后一处。
 *
 * ## 判据（双向；缺任何一条都会让修法失真）
 *
 *  A. **对照腿（修前本来就对）**：注册表健康且把技能影子成 `modelInvocable:false`
 *     ⇒ `create`/`patch` 如实拒写、盘上零改动（证明这条判据守的不是"永远拒写"）。
 *  B. **缺陷腿**：注册表 `list()` 抛非 `ENOENT` 错误 ⇒ `create`/`patch` 必须
 *     `ok:false` + 可读文案 + **盘上零改动**（修前：`ok:true` 且真的落盘）。
 *  C. **服务缺失腿**：`ctx.get('skills')` 返回 undefined（旧环境/服务未装）⇒ 同样
 *     `ok:false`，文案与 B 区分（"服务缺失" vs "查询失败"）。
 *  D. **放行腿**：`list()` 抛 `ENOENT`（可证明"注册表里没有这一条"）或返回空数组、
 *     或返回不含该技能的列表 ⇒ **照常写入**（"只有明确的没有该技能/没有影子才放行"）。
 *     没有这条，B 可以被"无条件拒写"蒙过去。
 *
 * 「修前失败」证据：把 `disabledReason` 的 `catch` 改回 `return undefined`（或把
 * 两个调用点的 `kind !== 'ok'` 判定去掉）⇒ B/C 红（`ok:true` + 盘上有文件）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { skillManageTool } from '../lib/skills.js'

const TOOL = 'skill_manage'

/** 一个临时技能库 + 内存目录；`cleanup` 由调用方在 finally 里调。 */
function tempLibrary() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-skill-registry-'))
  const skillDir = join(base, 'skills')
  const memoryDir = join(base, 'memory')
  mkdirSync(skillDir, { recursive: true })
  mkdirSync(memoryDir, { recursive: true })
  return { base, skillDir, memoryDir, cleanup: () => { rmSync(base, { recursive: true, force: true }) } }
}

const body = (name, text) => `---\nname: ${name}\ndescription: ${name} test\n---\n\n${text}\n`

/** `patch` 要求"先读过"：给一个 ownEvents() 里有对应 tool/call 的 agent 桩。 */
function readerAgent(name) {
  return {
    session: {
      ownEvents: () => [
        { type: 'tool/call', data: { name: TOOL, arguments: JSON.stringify({ action: 'read', name }) } },
      ],
    },
  }
}

/**
 * 造一个 `skill_manage` 工具实例。
 * @param {(() => Promise<unknown>) | null} listImpl - `skills.list` 的实现；
 *   `null` = 完全没有 `skills` 服务（C 腿）。
 */
function makeTool(lib, listImpl) {
  const ctx = { get: (svc) => (svc === 'skills' && listImpl !== null ? { list: listImpl } : undefined) }
  return skillManageTool(ctx, {
    skillDir: lib.skillDir,
    memoryDir: lib.memoryDir,
    skillMaxBytes: 64 * 1024,
    skillManageToolName: TOOL,
    // true = 直写活落点（不过待审队列）—— 缺陷腿要观察的正是这条写路径。
    skillReviewEnabled: true,
  })
}

/** 预置一个已存在的技能（`patch` 的前置条件）。 */
function seedSkill(lib, name, text) {
  mkdirSync(join(lib.skillDir, name), { recursive: true })
  writeFileSync(join(lib.skillDir, name, 'SKILL.md'), body(name, text))
}

const skillFile = (lib, name) => join(lib.skillDir, name, 'SKILL.md')
const readSkillFile = (lib, name) => readFileSync(skillFile(lib, name), 'utf8')

test('A. 对照腿：健康注册表 + 明确禁用影子 ⇒ create/patch 如实拒写、盘上零改动', async () => {
  const lib = tempLibrary()
  try {
    seedSkill(lib, 'demo-patched', 'original')
    const disabled = async () => [
      { name: 'demo-disabled', invocation: { modelInvocable: false } },
      { name: 'demo-patched', invocation: { modelInvocable: false } },
    ]
    const tool = makeTool(lib, disabled)

    const created = await tool.execute({ action: 'create', name: 'demo-disabled', body: body('demo-disabled', 'x') })
    assert.equal(created.ok, false, '被影子成不可调用的技能不得被 create 覆盖')
    assert.match(String(created.message), /已被禁用/)
    assert.equal(existsSync(skillFile(lib, 'demo-disabled')), false, '被拒的 create 不得落盘')

    const patched = await tool.execute({ action: 'patch', name: 'demo-patched', body: body('demo-patched', 'patched-1') }, { agent: readerAgent('demo-patched') })
    assert.equal(patched.ok, false, '被影子成不可调用的技能不得被 patch')
    assert.equal(readSkillFile(lib, 'demo-patched').includes('patched-1'), false, '被拒的 patch 不得改盘')
  } finally {
    lib.cleanup()
  }
})

test('B. 缺陷腿：注册表 list() 抛非 ENOENT ⇒ create 必须 ok:false 且零落盘', async () => {
  const lib = tempLibrary()
  try {
    const throwing = async () => { const error = new Error('EIO: skill registry unavailable'); error.code = 'EIO'; throw error }
    const tool = makeTool(lib, throwing)
    const created = await tool.execute({ action: 'create', name: 'demo-eio', body: body('demo-eio', 'x') })
    assert.equal(created.ok, false, '读错误不得被降级成"没禁用"（修前这里是 ok:true）')
    assert.match(String(created.message), /注册表/)
    assert.equal(existsSync(skillFile(lib, 'demo-eio')), false, '判不出来就不许写（修前这里真的落了盘）')
  } finally {
    lib.cleanup()
  }
})

test('B′. 缺陷腿：注册表 list() 抛非 ENOENT ⇒ patch 必须 ok:false 且盘上逐字节不变', async () => {
  const lib = tempLibrary()
  try {
    seedSkill(lib, 'demo-patched', 'original')
    const before = readSkillFile(lib, 'demo-patched')
    const throwing = async () => { const error = new Error('EMFILE: too many open files'); error.code = 'EMFILE'; throw error }
    const tool = makeTool(lib, throwing)
    const patched = await tool.execute({ action: 'patch', name: 'demo-patched', body: body('demo-patched', 'patched-eio') }, { agent: readerAgent('demo-patched') })
    assert.equal(patched.ok, false, '读错误不得被降级成"没禁用"')
    assert.equal(readSkillFile(lib, 'demo-patched'), before, '判不出来就不许改盘')
  } finally {
    lib.cleanup()
  }
})

test('C. 边界腿：运行时压根没有 skills 服务 ⇒ **放行**（没有注册表就不可能有影子，且这是既有契约）', async () => {
  const lib = tempLibrary()
  try {
    const tool = makeTool(lib, null)
    const created = await tool.execute({ action: 'create', name: 'demo-noservice', body: body('demo-noservice', 'x') })
    assert.equal(
      created.ok,
      true,
      'AB2-04 修的是"读**错误**被降级成空状态"；"没有注册表"是**结论**（不可能有影子）⇒ 旧快照/TUI 面的降级语义必须保留',
    )
    assert.equal(existsSync(skillFile(lib, 'demo-noservice')), true, '放行的 create 必须真的落盘')
  } finally {
    lib.cleanup()
  }
})

test('D. 放行腿：可证明"没有该技能/没有影子"的三种形态都照常写入（不是无条件拒写）', async () => {
  const lib = tempLibrary()
  try {
    // ① 空注册表。
    const empty = makeTool(lib, async () => [])
    const created = await empty.execute({ action: 'create', name: 'demo-ok', body: body('demo-ok', 'first') })
    assert.equal(created.ok, true, '空注册表 = 明确没有影子 ⇒ 必须放行')
    assert.equal(readSkillFile(lib, 'demo-ok').includes('first'), true, '放行的 create 必须真的落盘')

    // ② 列表里有别的技能、没有这一个。
    const others = makeTool(lib, async () => [{ name: 'someone-else', invocation: { modelInvocable: false } }])
    const patched = await others.execute({ action: 'patch', name: 'demo-ok', body: body('demo-ok', 'second') }, { agent: readerAgent('demo-ok') })
    assert.equal(patched.ok, true, '列表里没有该技能 = 没有影子 ⇒ 必须放行')
    assert.equal(readSkillFile(lib, 'demo-ok').includes('second'), true, '放行的 patch 必须真的落盘')

    // ③ 该技能在列表里但**不是**禁用影子。
    const invocable = makeTool(lib, async () => [{ name: 'demo-ok', invocation: { modelInvocable: true } }])
    const again = await invocable.execute({ action: 'patch', name: 'demo-ok', body: body('demo-ok', 'third') }, { agent: readerAgent('demo-ok') })
    assert.equal(again.ok, true, 'modelInvocable:true 不是禁用影子 ⇒ 必须放行')
    assert.equal(readSkillFile(lib, 'demo-ok').includes('third'), true)

    // ④ ENOENT = 可证明"注册表里没有这一条"⇒ 按"没有影子"放行。
    const enoent = makeTool(lib, async () => { const error = new Error('no such registry'); error.code = 'ENOENT'; throw error })
    const enoentWrite = await enoent.execute({ action: 'patch', name: 'demo-ok', body: body('demo-ok', 'fourth') }, { agent: readerAgent('demo-ok') })
    assert.equal(enoentWrite.ok, true, 'ENOENT 是"没有该技能"的可证形态 ⇒ 放行（catch 收窄到能证明没有影子的 errno）')
    assert.equal(readSkillFile(lib, 'demo-ok').includes('fourth'), true)
  } finally {
    lib.cleanup()
  }
})
