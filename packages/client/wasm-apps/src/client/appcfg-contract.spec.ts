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
 *   - 把 `appcfg-contract.ts` 的 `ACCESS_MODES` 改回 `['public','login','whitelist']`
 *     （或漏掉 `whitelist`）⇒ 「access 只有两值」与「字段表对拍」两组红；
 *   - 把 `WHITELIST_MAX` 改成 1000 ⇒ 「白名单上限与 limits.go 一致」红；
 *   - 把 `APP_ID_PATTERN` 放宽成 `/^[a-z0-9-]+$/` ⇒ 同上红；
 *   - 把 `WASM_MAX_BYTES` 改成 64 MiB（或把 limits.go 的 `WasmMaxBytes` 改成 64<<20）
 *     ⇒ 「.wasm 体积上限与 limits.go 一致」红；
 *   - 把 `read.go` catalog 行的 `"app_id"` 改成 `"appId"`（P2-10 的场景）
 *     ⇒ 「目录行字段对拍」整组红（含一条对改写文本自证的用例）。
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
  CATALOG_ROW_AUTHOR_FIELDS,
  CATALOG_ROW_CONDITIONAL_FIELDS,
  WINDOW_FIELD_NAMES,
  CATALOG_ROW_FIELDS,
  DEFAULT_ACCESS,
  FIRST_RELEASE_REQUIRED_FIELDS,
  LIMITS_GO_REPO_PATH,
  READ_GO_REPO_PATH,
  REMOVED_APP_CONFIG_FIELDS,
  REMOVED_CATALOG_ROW_FIELDS,
  VERSION_PATTERN,
  WASM_MAX_BYTES,
  WHITELIST_MAX,
  WRITABLE_ACCESS_MODES,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_WIDTH,
  parseWindowRatio,
  parseWindowSpec,
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
 * 从 Go 源码里抠一个**可能写成左移**的字节常量（`32 << 20` / `2000`）。
 *
 * `limits.go` 的体积上限全部写作 `N << 20`，而 `goNumberConst` 只认裸数字 ——
 * 用它读 `WasmMaxBytes` 会得到 `32`，对拍就永远"相等"（把 32 当成 32 MiB）。
 * @param source - Go 源码。
 * @param name - 常量名。
 * @returns 数值；找不到返回 `null`。
 */
function goByteSizeConst(source: string, name: string): number | null {
  const match = new RegExp(`${name}\\s*=\\s*(\\d+)(?:\\s*<<\\s*(\\d+))?`, 'u').exec(source)
  if (match === null) return null
  const base = Number(match[1])
  const shift = match[2] === undefined ? 0 : Number(match[2])
  return base * 2 ** shift
}

/**
 * 抠出 `read.go` 里 **catalog 行**的字段名（`gin.H{…}` 字面量 + `row["…"] = ` 赋值）。
 *
 * 为什么用正则抠源码而不是跑 Go（P2-10）：这是客户端包唯一能对拍服务端字段集合的
 * 位置（客户端不能 import Go 包，也不该为一条契约断言引入代码生成）。抠法只依赖
 * "字段名写成字符串键"这一个稳定形状；抠不出来（函数改名/搬走）⇒ 返回 `null`，
 * 用例红 —— 而不是静默通过。
 * @param source - `server/internal/wasmapp/api/read.go` 的全文。
 * @returns 字面量键与赋值键；找不到 `catalog` 函数时返回 `null`。
 */
export function catalogRowKeysFromReadGo(source: string): { literal: string[], assigned: string[] } | null {
  const start = source.indexOf('func (h *Handlers) catalog(')
  if (start < 0) return null
  const nextFunc = source.indexOf('\nfunc ', start)
  const body = source.slice(start, nextFunc < 0 ? undefined : nextFunc)
  // 去掉行注释：注释里的大括号会让下面的花括号配对跑偏。
  const stripped = body.replace(/\/\/[^\n]*/gu, '')
  const literal: string[] = []
  const marker = 'row := gin.H{'
  const blockStart = stripped.indexOf(marker)
  if (blockStart >= 0) {
    let depth = 0
    let end = stripped.length - 1
    for (let i = blockStart + marker.length - 1; i < stripped.length; i += 1) {
      if (stripped[i] === '{') depth += 1
      else if (stripped[i] === '}') {
        depth -= 1
        if (depth === 0) { end = i; break }
      }
    }
    for (const match of stripped.slice(blockStart, end + 1).matchAll(/"([A-Za-z_]+)":/gu)) literal.push(match[1]!)
  }
  const assigned = [...stripped.matchAll(/row\["([A-Za-z_]+)"\]/gu)].map(match => match[1]!)
  return { literal, assigned }
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

  /**
   * 窗口声明（F3/§6，R1-L3-9 的数据源）在**服务端生成物**里必须存在且**子字段名一致**。
   *
   * 变异验证：把 `appcfg.go` 的 `window.ratio` 改名（或删掉 `window` 字段）⇒ 本条红；
   * 客户端 `WINDOW_FIELD_NAMES` 少一个 ⇒ 同样红（两侧任一侧漂移都拦得住）。
   */
  it('window 子字段与服务端生成物逐项一致（window.ratio / window.width / window.height）', () => {
    expect(appcfg.exists).toBe(true)
    const fields = (appcfg.json as { config_fields?: unknown }).config_fields
    expect(Array.isArray(fields)).toBe(true)
    const windowField = (fields as Array<Record<string, unknown>>).find(field => field.key === 'window')
    expect(windowField, 'appcfg.json 的 config_fields 里必须有 window（F3/§6）').toBeTruthy()
    const subKeys = (windowField!.sub_fields as Array<{ key?: unknown }> | undefined ?? [])
      .map(field => String(field.key))
      .sort()
    expect(subKeys).toEqual([...WINDOW_FIELD_NAMES].sort())
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

  /**
   * P1-10：体积上限的跨端契约。
   *
   * 变异验证：把 `appcfg-contract.ts` 的 `WASM_MAX_BYTES` 改成 `64 * 1024 * 1024`
   * ⇒ 本条红；把 `limits.go` 的 `WasmMaxBytes` 改成 `64 << 20` ⇒ 同样红。
   */
  it('.wasm 体积上限与 limits.go 的 WasmMaxBytes 一致（发新版时的本地闸门用它）', () => {
    const max = goByteSizeConst(limits ?? '', 'WasmMaxBytes')
    expect(max, missingHint('WasmMaxBytes')).not.toBeNull()
    expect(WASM_MAX_BYTES).toBe(max)
    // 顺带钉住"确实是 32 MiB"：`<< 20` 的读法错了会得到 32（对拍会假绿）。
    expect(WASM_MAX_BYTES).toBe(32 * 1024 * 1024)
  })
})

/**
 * P2-10：**目录行的字段契约**对拍（服务端 `read.go` 的 catalog 行 ↔ 客户端解析）。
 *
 * 为什么这条闸必须存在：目录面刚经历过一次字段改名（`visible`/`login_required`
 * → `access`），而两侧只有各自手写的夹具在守。字段一改名，客户端 `parseCatalog`
 * 会把**每一行**都跳过（没有合法 `app_id`），面板显示"还没有可用的应用" ——
 * 一个把契约漂移说成"你没有应用"的假答案，没有任何错误提示。
 *
 * 变异验证（改回旧实现/改坏服务端必红）：
 *   - 把 `read.go` catalog 行的 `"app_id"` 改成 `"appId"` ⇒ 本组第 1 条红
 *     （第 2 条用合成的改写文本自证这条闸真的会红）；
 *   - 客户端 `CATALOG_ROW_FIELDS` 少一个字段（或服务端多一个）⇒ 第 1 条红。
 */
describe('单一真源对拍：目录行字段（read.go 的 catalog ↔ 客户端解析）', () => {
  const readGo = readRepoFile(READ_GO_REPO_PATH)

  /**
   * **迁移白名单（有期限）**：服务端侧的删除清单（C2）落地前，`read.go` 可能仍带
   * `entry_url`；而客户端**已经不认识它**（`CATALOG_ROW_CONDITIONAL_FIELDS` 已按
   * 冻结契约 §4.5 删除）。白名单只影响"服务端多出来的键"，不影响下面任何一条真实
   * 判据：改名、字段集合、发布者字段的归属照旧逐条对拍。
   *
   * 收口方式：C2 删掉 `read.go` 的 `row["entry_url"]` 之后，把这里清空即可 ——
   * 清空后 `entry_url` 再出现就是一条红（与 `REMOVED_CATALOG_ROW_FIELDS` 同效）。
   */
  const TRANSITIONAL_SERVER_ONLY_KEYS = ['entry_url'] as const

  /** 客户端声明的**全部可能键**（无条件 + 仅发布者；有条件字段已于 2026-09-19 删除）。 */
  const expectedKeys = [
    ...CATALOG_ROW_FIELDS,
    ...CATALOG_ROW_AUTHOR_FIELDS,
    // 有条件字段（作者声明才有；`window` 是 F3/§6 的那三个子字段的载体）。
    ...CATALOG_ROW_CONDITIONAL_FIELDS,
  ].slice().sort()

  /** 把服务端源码里的键集合抠出来（抠不出来 ⇒ 抛，用例红）。 */
  const actualKeys = (source: string): string[] => {
    const keys = catalogRowKeysFromReadGo(source)
    if (keys === null) throw new Error(`${READ_GO_REPO_PATH} 里找不到 catalog 的 row 构造（函数被改名/搬走了？）`)
    return [...new Set([...keys.literal, ...keys.assigned])].sort()
  }

  /** 服务端键集合里**客户端认识的部分**（迁移白名单不算客户端认识）。 */
  const actualKnownKeys = (source: string): string[] =>
    actualKeys(source).filter(key => !(TRANSITIONAL_SERVER_ONLY_KEYS as readonly string[]).includes(key))

  /** 只在 **catalog 函数体内**做替换（整文件第一处 `"app_id":` 在 diagnostics 里）。 */
  const mutateCatalog = (source: string, from: string, to: string): string => {
    const start = source.indexOf('func (h *Handlers) catalog(')
    expect(start, 'read.go 里必须还有 catalog 函数').toBeGreaterThanOrEqual(0)
    const nextFunc = source.indexOf('\nfunc ', start)
    const body = source.slice(start, nextFunc < 0 ? undefined : nextFunc)
    expect(body, `catalog 函数体里必须有 ${from}`).toContain(from)
    return source.slice(0, start) + body.replace(from, to) + source.slice(nextFunc < 0 ? source.length : nextFunc)
  }

  it('read.go 可读，且 catalog 行的键集合与客户端声明的完全相等（迁移字段除外）', () => {
    expect(readGo, `${READ_GO_REPO_PATH} 读不到`).not.toBeNull()
    expect(actualKnownKeys(readGo ?? '')).toEqual(expectedKeys)
    // 迁移白名单必须真的只覆盖"客户端不认识的服务端键"：出现在客户端声明里就是自欺。
    for (const key of TRANSITIONAL_SERVER_ONLY_KEYS) {
      expect(expectedKeys, `${key} 已从客户端契约删除，不得再出现在客户端声明里`).not.toContain(key)
    }
  })

  it('已删除的字段名不得复活（visible / login_required 两侧都不许有）', () => {
    const keys = actualKeys(readGo ?? '')
    for (const removed of REMOVED_CATALOG_ROW_FIELDS) {
      expect(keys, `目录行不得再有 ${removed}（2026-09-18 收敛为 access）`).not.toContain(removed)
    }
  })

  it('这份对拍真的会因改名变红（对改写后的 read.go 自证）', () => {
    const source = readGo ?? ''
    // 模拟"服务端把 app_id 改成 appId"这一次改名：键集合必须因此不等。
    const mutated = mutateCatalog(source, '"app_id":', '"appId":')
    expect(mutated).not.toBe(source)
    expect(actualKnownKeys(mutated)).not.toEqual(expectedKeys)
    // 反向自证：原文件必须**相等** —— 否则上面那条"不等"可能只是因为抠不出来。
    expect(actualKnownKeys(source)).toEqual(expectedKeys)
  })

  it('发布者专有字段确实只写在 `if isOwner` 里（名单不下发给所有人）', () => {
    const source = readGo ?? ''
    const keys = catalogRowKeysFromReadGo(source)
    expect(keys).not.toBeNull()
    // 字面量（无条件）里不许出现 author 字段 —— 它们只能走 `row["…"] =` 赋值。
    for (const field of CATALOG_ROW_AUTHOR_FIELDS) {
      expect(keys!.literal, `${field} 不得是无条件下发的字面量键`).not.toContain(field)
      expect(keys!.assigned, `${field} 必须按调用者赋值下发`).toContain(field)
    }
    // 自证：把 `whitelist` 挪成 gin.H 的字面量键（= 对所有人下发），这条判据变红。
    const leaked = mutateCatalog(source, '"enabled":    a.Enabled,', '"enabled": a.Enabled,\n\t\t\t"whitelist": cfg.Whitelist,')
    expect(catalogRowKeysFromReadGo(leaked)!.literal).toContain('whitelist')
  })
})

describe('窗口声明解析（F3/§6，R1-L3-9）：比例区间与尺寸', () => {
  it('ratio 接受 "W:H" 与浮点，归一化成数值；越界/非法一律 null', () => {
    expect(parseWindowRatio('16:9')).toBeCloseTo(16 / 9, 6)
    expect(parseWindowRatio('4:3')).toBeCloseTo(4 / 3, 6)
    expect(parseWindowRatio('1.7778')).toBeCloseTo(1.7778, 6)
    expect(parseWindowRatio(0.25)).toBe(0.25)
    expect(parseWindowRatio(4)).toBe(4)
    // 越界（§6：0.25–4.0）与非数字。
    for (const bad of [0.2, 4.1, 0, -1, '0:1', '9', 'x', '', null, undefined, {}, NaN]) {
      expect(parseWindowRatio(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('window 规格三项各自独立解析；一个可用字段都没有 ⇒ null（不是"缺省 1280×720"）', () => {
    expect(parseWindowSpec({ ratio: '16:9', width: 1280, height: 720 })).toEqual({ ratio: 16 / 9, width: 1280, height: 720 })
    // 尺寸写坏不废掉比例。
    expect(parseWindowSpec({ ratio: 1.5, width: 0, height: -3 })).toEqual({ ratio: 1.5 })
    expect(parseWindowSpec({ ratio: 9 })).toBeNull()
    expect(parseWindowSpec({})).toBeNull()
    expect(parseWindowSpec(null)).toBeNull()
    expect(parseWindowSpec([1, 2])).toBeNull()
    // 缺省尺寸常量只描述"客户端会怎么做"，**不是**解析结果。
    expect(DEFAULT_WINDOW_WIDTH).toBe(1280)
    expect(DEFAULT_WINDOW_HEIGHT).toBe(720)
  })
})

describe('客户端镜像自身的内部一致性（不依赖任何服务端文件）', () => {
  it('access 只有两值 login / whitelist（I6：public 彻底退场），缺省是其中之一', () => {
    expect([...ACCESS_MODES]).toEqual(['login', 'whitelist'])
    expect(ACCESS_MODES).toContain(DEFAULT_ACCESS)
    expect(DEFAULT_ACCESS).toBe('login')
    // `public` 不在字段表镜像里；历史取值的读取兼容由 resolveAccess 的原始字符串分支承担
    // （用例见 app-center.spec.tsx：`access:'public'` 渲染成"登录后使用"）。
    expect([...ACCESS_MODES]).not.toContain('public')
    expect([...WRITABLE_ACCESS_MODES]).toEqual([...ACCESS_MODES])
  })

  it('字段名集合与"已删除字段"互不重叠（visible / login_required 必须不在集合里）', () => {
    expect([...APP_CONFIG_FIELDS]).toEqual(['access', 'whitelist', 'purpose', 'data_sensitivity', 'owner', 'window'])
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
      access: ['login', 'whitelist'],
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
        access: { enum: ['login', 'whitelist'], default: 'login' },
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
        { name: 'access', values: ['login', 'whitelist'], default_value: 'login' },
        { name: 'whitelist', max: 2000 },
        { name: 'visible' },
      ],
    })
    expect(comparison.checked).toContain('access_modes')
    // `visible` 还在字段表里 ⇒ 必须报差异（契约要求它已删除）。
    expect(comparison.mismatches.map(m => m.aspect)).toContain('field_names')
    expect(comparison.mismatches.some(m => m.actual === 'still present')).toBe(true)
  })

  it('深扫兜底：键名不认识时仍能按"取值表"认出 access 两值', () => {
    const comparison = compareWithAppcfgJson({ someUnknownKey: { permissions: ['whitelist', 'login'] } })
    expect(comparison.checked).toContain('access_modes')
    expect(comparison.mismatches).toEqual([])
  })

  it('真的不一致时逐项报出来（少一个模式 / 上限不同 / login_required 还在）', () => {
    const comparison = compareWithAppcfgJson({
      access: ['login'],
      access_default: 'whitelist',
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
