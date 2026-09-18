/// <reference types="node" />
/**
 * **字段规格单一真源的对拍**（服务端 `appcfg.json` / `limits.go` ↔ 客户端镜像）。
 *
 * 背景：`picoaide.app.json` 的字段规格（access 三模式、白名单上限、首版必填名单）
 * 的权威定义在服务端。客户端为了在提交之前给出可读的报错，必须持有一份镜像常量
 * （`appcfg-contract.ts`）—— 于是就有了**两份可能漂移的规格**。本文件是防漂移的那道闸：
 * 用 `node:fs` 读服务端产物，逐项对拍客户端的镜像。
 *
 * 两条对拍（都相对**仓库根**解析路径，因为测试的 cwd 是包目录）：
 *
 *  1. `server/internal/wasmapp/appcfg/appcfg.json` —— 服务端生成的机器可读字段表，
 *     也就是字段规格的**唯一真源**。真源缺席（被删/改名/搬走）⇒ 用例**直接失败**，
 *     不是 skip（2026-09-18 审计 P1-2：skip 会让"两端契约漂移"这件事完全静默）。
 *  2. `server/internal/wasmapp/limits/limits.go` —— app_id 形态 / 版本号形态 /
 *     白名单上限三条规格在 Go 里**现在就有**唯一真源，字段表落地之前先靠它守。
 *
 * 两条都**不硬编码第二份规格**：期望值来自客户端镜像，实际值从服务端文件里读出来。
 *
 * ---- 变异验证 ----
 *   - 把 `appcfg-contract.ts` 的 `ACCESS_MODES` 改成 `['public','login']`（少一个模式）
 *     ⇒ 「access 三模式」红（`compareWithAppcfgJson` 自身的一致性用例）；
 *   - 把 `WHITELIST_MAX` 改成 1000 ⇒ 「白名单上限与 limits.go 一致」红；
 *   - 把 `APP_ID_PATTERN` 放宽成 `/^[a-z0-9-]+$/` ⇒ 同上红。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ACCESS_MODES,
  APPCFG_JSON_REPO_PATH,
  APP_ID_MAX_LENGTH,
  APP_CONFIG_FIELDS,
  APP_ID_PATTERN,
  DEFAULT_ACCESS,
  FIRST_RELEASE_REQUIRED_FIELDS,
  LIMITS_GO_REPO_PATH,
  REMOVED_APP_CONFIG_FIELDS,
  VERSION_PATTERN,
  WHITELIST_MAX,
  compareWithAppcfgJson,
} from './appcfg-contract.ts'

/** 仓库根：从本文件（`packages/client/wasm-apps/src/client/`）往上走四级。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')

/** 读一个仓库内文件；不存在返回 `null`（不抛：缺席是"尚未生效"，不是失败）。 */
function readRepoFile(relative: string): string | null {
  try {
    return readFileSync(join(REPO_ROOT, relative), 'utf8')
  } catch {
    return null
  }
}

/** 从 Go 源码里抠一个反引号字符串常量（找不到返回 `null`）。 */
function goBacktickConst(source: string, name: string): string | null {
  const match = new RegExp(`${name}\\s*=\\s*\`([^\`]+)\``, 'u').exec(source)
  return match === null ? null : match[1]!
}

/** 从 Go 源码里抠一个数字常量。 */
function goNumberConst(source: string, name: string): number | null {
  const match = new RegExp(`${name}\\s*=\\s*(\\d+)`, 'u').exec(source)
  return match === null ? null : Number(match[1])
}

/**
 * 加载 `appcfg.json`（服务端生成的字段表）。
 *
 * 参数化 `root` 是为了让"文件缺席"这条路径**本身可测** —— 否则"缺席时给出的可读
 * 原因"会变成一段永远没人跑过、也无法证明其存在的代码（另一种假绿）。
 * @param root - 仓库根。
 * @returns 存在性与内容；不存在时带上给复跑者看的原因。
 */
export function loadAppcfgJsonAt(root: string): { exists: boolean, path: string, json?: unknown, reason?: string } {
  const path = join(root, APPCFG_JSON_REPO_PATH)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {
      exists: false,
      path,
      reason: `${APPCFG_JSON_REPO_PATH} 不存在（服务端那一半尚未生成字段表）⇒ 对拍**未生效**，客户端镜像常量暂由 limits.go 对拍 + 显式常量守`,
    }
  }
  try {
    return { exists: true, path, json: JSON.parse(text) }
  } catch (cause) {
    return { exists: false, path, reason: `${APPCFG_JSON_REPO_PATH} 存在但不是合法 JSON：${cause instanceof Error ? cause.message : String(cause)}` }
  }
}

const appcfg = loadAppcfgJsonAt(REPO_ROOT)
if (!appcfg.exists) {
  // 打印而不是静默：vitest 输出里能直接看到"这条闸还没生效"以及为什么。
  console.warn(`[appcfg-contract] ${appcfg.reason ?? ''}`)
}

describe('单一真源对拍：appcfg.json（服务端生成的字段表）', () => {
  it('客户端镜像与字段表逐项一致（access 三模式 / 缺省 / 白名单上限 / 字段名 / 首版必填）', () => {
    // 单一真源缺席 = **红**，不是 skip（独立审计 2026-09-18 P1-2：原先
    // `it.skipIf(!appcfg.exists)` 让"文件被删/改名"表现成一条 skipped 用例、
    // `yarn check` 依旧绿 —— 那正是这道闸最该拦住的形态）。
    expect(appcfg.exists, `${APPCFG_JSON_REPO_PATH} 必须存在：${appcfg.reason ?? '它是本对拍的唯一真源'}`).toBe(true)
    const comparison = compareWithAppcfgJson(appcfg.json)
    // 差异必须为空；`unknown` 只打印不失败（形状换了名不该让门禁红，但必须看得见）。
    if (comparison.unknown.length > 0) console.warn(`[appcfg-contract] 未识别的维度：${comparison.unknown.join('；')}`)
    expect(comparison.mismatches).toEqual([])
    // 防假绿：字段表存在却一个维度都没认出来 ⇒ 红（要求维护者补候选路径），
    // 而不是报"0 差异"通过。
    expect(comparison.checked.length).toBeGreaterThan(0)
    // **两张表必须被认出来**：对自己的生成物不接受"认不出来所以跳过"
    // （审计 P1-1：整张表被改名时，旧实现只会静默降低覆盖）。
    expect(comparison.checked).toContain('config_fields_set')
    expect(comparison.checked).toContain('publish_fields_set')
    expect(comparison.unknown.filter(u => u.includes('_set'))).toEqual([])
  })

  it('字段表缺席时给出带路径的可读原因（失败信息可直接照做）', () => {
    // 这条用例与"文件在不在"无关：它直接驱动缺席路径，证明失败信息会**说明原因**。
    const missing = loadAppcfgJsonAt(join(REPO_ROOT, 'temp', 'definitely-not-a-repo-root'))
    expect(missing.exists).toBe(false)
    expect(missing.path).toContain(APPCFG_JSON_REPO_PATH)
    expect(missing.reason).toContain(APPCFG_JSON_REPO_PATH)
    expect(missing.reason).toContain('未生效')
  })

  it('本仓当前状态：字段表在读，或如实报告缺席（两者都不许是"静默通过"）', () => {
    if (appcfg.exists) {
      expect(appcfg.json).toBeDefined()
      return
    }
    expect(appcfg.reason).toContain(APPCFG_JSON_REPO_PATH)
  })
})

describe('单一真源对拍：limits.go（app_id / 版本号 / 白名单上限）', () => {
  const limits = readRepoFile(LIMITS_GO_REPO_PATH)

  /** 找不到常量时的失败信息：说清是真源迁移还是镜像错了。 */
  const missingHint = (name: string): string =>
    `${LIMITS_GO_REPO_PATH} 里找不到 ${name}。两种可能：①客户端镜像的常量改名了（改回来）；②这条规格的真源已迁移（把本文件的读取路径指向新位置，确认 appcfg.json 对拍已覆盖后也可以删掉这条用例）。`

  it('Go 侧的 limits.go 可读（读不到说明仓库布局变了，必须有人看一眼）', () => {
    expect(limits, `${LIMITS_GO_REPO_PATH} 读不到`).not.toBeNull()
  })

  it('app_id 形态 / 长度上限与 limits.go 逐字一致', () => {
    const pattern = goBacktickConst(limits ?? '', 'AppIDPattern')
    const maxLen = goNumberConst(limits ?? '', 'MaxAppIDLen')
    expect(pattern, missingHint('AppIDPattern')).not.toBeNull()
    expect(maxLen, missingHint('MaxAppIDLen')).not.toBeNull()
    expect(APP_ID_PATTERN.source).toBe(pattern)
    expect(APP_ID_MAX_LENGTH).toBe(maxLen)
  })

  it('版本号形态与 limits.go 逐字一致', () => {
    const pattern = goBacktickConst(limits ?? '', 'VersionPattern')
    expect(pattern, missingHint('VersionPattern')).not.toBeNull()
    expect(VERSION_PATTERN.source).toBe(pattern)
  })

  it('白名单上限与 limits.go 一致', () => {
    const max = goNumberConst(limits ?? '', 'AppConfigWhitelistMax')
    expect(max, missingHint('AppConfigWhitelistMax')).not.toBeNull()
    expect(WHITELIST_MAX).toBe(max)
  })
})

describe('客户端镜像自身的内部一致性（不依赖任何服务端文件）', () => {
  it('access 三模式就是 public / login / whitelist，缺省是其中之一', () => {
    expect([...ACCESS_MODES]).toEqual(['public', 'login', 'whitelist'])
    expect(ACCESS_MODES).toContain(DEFAULT_ACCESS)
    expect(DEFAULT_ACCESS).toBe('login')
  })

  it('字段名集合与"已删除字段"互不重叠（visible / login_required 必须不在集合里）', () => {
    expect([...APP_CONFIG_FIELDS]).toEqual(['access', 'whitelist', 'purpose', 'data_sensitivity', 'owner'])
    for (const removed of REMOVED_APP_CONFIG_FIELDS) {
      expect(APP_CONFIG_FIELDS).not.toContain(removed)
    }
    expect([...REMOVED_APP_CONFIG_FIELDS]).toEqual(['visible', 'login_required'])
  })

  it('首版必填四条含 title（请求体字段，不在 appcfg 里）', () => {
    expect([...FIRST_RELEASE_REQUIRED_FIELDS]).toEqual(['title', 'purpose', 'data_sensitivity', 'owner'])
  })
})

describe('compareWithAppcfgJson：形状识别与差异检出（对着自造字段表跑）', () => {
  it('对象形态：access/fields.* 两种常见写法都能认出并判定一致', () => {
    const flat = compareWithAppcfgJson({
      access: ['public', 'login', 'whitelist'],
      access_default: 'login',
      whitelist_max: 2000,
      fields: {
        access: { name: 'access' },
        whitelist: { name: 'whitelist' },
        purpose: { required_first_release: true },
        data_sensitivity: { required_first_release: true },
        owner: { required_first_release: true },
      },
    })
    expect(flat.mismatches).toEqual([])
    expect(flat.checked).toEqual(['access_modes', 'access_default', 'whitelist_max', 'field_names', 'first_release_required'])

    const nested = compareWithAppcfgJson({
      fields: {
        access: { enum: ['public', 'login', 'whitelist'], default: 'login' },
        whitelist: { max_items: 2000 },
      },
      limits: { app_config_whitelist_max: 2000 },
    })
    expect(nested.mismatches).toEqual([])
    expect(nested.checked).toContain('access_modes')
  })

  it('数组形态（字段节点带 name）也能认出', () => {
    const comparison = compareWithAppcfgJson({
      fields: [
        { name: 'access', values: ['login', 'whitelist', 'public'], default_value: 'login' },
        { name: 'whitelist', max: 2000 },
        { name: 'visible' },
      ],
    })
    expect(comparison.checked).toContain('access_modes')
    // `visible` 还在字段表里 ⇒ 必须报差异（契约要求它已删除）。
    expect(comparison.mismatches.map(m => m.aspect)).toContain('field_names')
    expect(comparison.mismatches.some(m => m.actual === 'still present')).toBe(true)
  })

  it('深扫兜底：键名不认识时仍能按"取值表"认出 access 三模式', () => {
    const comparison = compareWithAppcfgJson({ someUnknownKey: { permissions: ['whitelist', 'public', 'login'] } })
    expect(comparison.checked).toContain('access_modes')
    expect(comparison.mismatches).toEqual([])
  })

  it('真的不一致时逐项报出来（少一个模式 / 上限不同 / login_required 还在）', () => {
    const comparison = compareWithAppcfgJson({
      access: ['public', 'login'],
      access_default: 'public',
      whitelist_max: 100,
      fields: { access: {}, whitelist: {}, login_required: {} },
    })
    const aspects = comparison.mismatches.map(m => m.aspect)
    expect(aspects).toContain('access_modes')
    expect(aspects).toContain('access_default')
    expect(aspects).toContain('whitelist_max')
    expect(aspects).toContain('field_names')
  })

  it('完全认不出来时 checked 为空（调用方据此变红，而不是静默通过）', () => {
    const comparison = compareWithAppcfgJson({ nothing: 'useful', nested: { deep: [1, 2, 3] } })
    expect(comparison.checked).toEqual([])
    expect(comparison.unknown.length).toBeGreaterThan(0)
  })
})
