/**
 * 应用配置的**字段规格**（`picoaide.app.json` 的 access 三模式契约）。
 *
 * 为什么单独立一个模块：这套常量有**两份消费者** —— 发布表单的前端预校验
 * （`validatePublishDraft`）与 `/api/pico/apps/wasm` 的目录解析（`AppCenterPanel`）。
 * 两份各写一遍就会漂移出"表单放行、服务端拒"或"面板认不出服务端字段"的分叉。
 *
 * ## 单一真源与它的过渡态
 *
 * 字段规格的**权威真源**是服务端生成的机器可读字段表
 * `server/internal/wasmapp/appcfg/appcfg.json`（由服务端那一半负责生成）。本模块的
 * 常量是它在客户端这一侧的**镜像**，并由两条测试钉住不许漂移：
 *
 *  1. `appcfg-contract.spec.ts` 用 `node:fs` 读那份 JSON 并**逐项对拍**（两张表的
 *     字段集合做**全集合相等**，不是"某几个名字在不在"）；文件不存在、或两张表被
 *     改名/搬走 ⇒ **直接失败**（独立审计 2026-09-18 P1-1/P1-2：skip 会让门禁静默失效）；
 *  2. 同一文件里另有一条对拍 `server/internal/wasmapp/limits/limits.go` 的用例：
 *     `app_id` 形态 / 版本号形态 / 白名单上限三条规格在 Go 里已经有唯一真源，
 *     在字段表落地之前先靠它守。
 *
 * ⚠️ 服务端仍是**唯一裁决者**：这里做的是"别让用户白等一次 90 s 的往返"，
 * 不是第二份准入规则。任何一条预校验放行的输入，服务端仍可能拒（保留字 app_id、
 * 企业既有主机名、版本号未严格递增、wasm 校验…），因此预校验**只做加法**：
 * 它拦下的必然是服务端也会拒的，绝不拦下服务端会接受的。
 *
 * @module @picoaide/dsh-wasm-apps/client/appcfg-contract
 */

/** `access` 的三个取值（帧内 `auth.mode` 同步取这三个值，§7.1）。 */
export const ACCESS_MODES = ['public', 'login', 'whitelist'] as const

/** `access` 的取值类型。 */
export type AccessMode = (typeof ACCESS_MODES)[number]

/**
 * `access` 的缺省值：`login`。
 *
 * 缺省取 `login` 而不是 `public`：写漏一个字段不该让应用意外变成匿名可达
 * （与旧 `login_required` 缺省 true 同一个方向的取舍，只是名字与取值都换了）。
 */
export const DEFAULT_ACCESS: AccessMode = 'login'

/** `app_id` 形态：小写字母/数字，单连字符分隔（首个/末个不得是连字符，无连续连字符）。 */
export const APP_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** `app_id` 长度上限（DNS label 上限 —— app_id 本身就是域名标签）。 */
export const APP_ID_MAX_LENGTH = 63

/** `app_id` 纯数字禁则（避免被误认成 IP 地址）。 */
export const APP_ID_ALL_DIGITS_PATTERN = /^[0-9]+$/u

/** `app_id` 的 punycode 前缀禁则（保留给国际化域名）。 */
export const APP_ID_PUNYCODE_PREFIX = 'xn--'

/** 版本号形态：`x.y.z`，可带 `-<prerelease>` 后缀（与服务端 `limits.VersionPattern` 逐字一致）。 */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u

/** 白名单条目上限。 */
export const WHITELIST_MAX = 2000

/** 首版必填的声明字段（`title` 是请求体字段，其余在 `picoaide.app.json` 里）。 */
export const FIRST_RELEASE_REQUIRED_FIELDS = ['title', 'purpose', 'data_sensitivity', 'owner'] as const

/** `picoaide.app.json` 的字段名集合（`access` 取代了 `visible` + `login_required`）。 */
export const APP_CONFIG_FIELDS = ['access', 'whitelist', 'purpose', 'data_sensitivity', 'owner'] as const

/**
 * 已删除的字段名。
 *
 * 服务端的字段集合是**封闭的**（多一个即拒），所以这两个名字必须从客户端消失：
 * 发出去等于发布必然失败（`APP_CONFIG_INVALID` 未知字段）。
 */
export const REMOVED_APP_CONFIG_FIELDS = ['visible', 'login_required'] as const

/**
 * 发布请求体（`buildPublishBody`）的**字段集合**，与服务端 `appcfg.json` 的
 * `publish_fields` 逐字对拍。
 *
 * 为什么要单独列出来对拍（独立审计 2026-09-18 P1-1）：此前客户端只对拍了
 * `access`/`whitelist` 两个名字在不在，于是 `purpose`/`data_sensitivity`/`owner`
 * 乃至整张 `publish_fields` 表**被改名时客户端闸全绿** —— 最现实的漂移路径是
 * "服务端 + 宿主一起改名、忘了客户端"，结果客户端继续发旧字段名、每次发布被服务端
 * 按未知字段拒掉，而门禁一声不响。全集合相等才是这条契约的判据。
 */
export const PUBLISH_PAYLOAD_FIELDS = ['app_id', 'version', 'wasm_base64', 'config', 'title', 'changelog'] as const

/**
 * `appcfg.json` 里两张**必须存在**的表，以及各自的期望字段集合。
 *
 * 改名/搬走这两张表 ⇒ 直报 mismatch（而不是"认不出来所以跳过"）：认不出来的维度
 * 会让门禁静默失效，而失效的形态恰好是"发布时才炸"。期望集合各有自己的真源
 * （客户端表单字段 / 发布载荷字段），所以这里是引用而不是再抄一份字面量。
 */
const REQUIRED_TABLES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['config_fields', APP_CONFIG_FIELDS],
  ['publish_fields', PUBLISH_PAYLOAD_FIELDS],
]

/** 字段表 JSON 相对于仓库根的位置（对拍用；客户端运行时不读文件）。 */
export const APPCFG_JSON_REPO_PATH = 'server/internal/wasmapp/appcfg/appcfg.json'

/** `limits.go` 相对于仓库根的位置（app_id / 版本号 / 白名单上限的 Go 侧真源）。 */
export const LIMITS_GO_REPO_PATH = 'server/internal/wasmapp/limits/limits.go'

/** 一条对拍差异。 */
export interface AppcfgMismatch {
  /** 对拍的维度（`access_modes` / `access_default` / `whitelist_max` / `field_names`）。 */
  aspect: string
  /** 客户端镜像里的值。 */
  expected: string
  /** 字段表里的值。 */
  actual: string
  /** 从字段表里读到它的路径（供维护者定位）。 */
  path: string
}

/** 对拍结果。 */
export interface AppcfgComparison {
  /** 真的比对过的维度（空 = 字段表的形状没被认出来，`appcfg-contract.spec.ts` 会因此变红）。 */
  checked: string[]
  /** 比出来的差异。 */
  mismatches: AppcfgMismatch[]
  /** 认不出来的维度（打印出来供维护者补候选路径；不是失败）。 */
  unknown: string[]
}

/** 候选路径：字段表可能把这些值放在哪（先按候选路径找，找不到再深扫兜底）。 */
const ACCESS_MODES_PATHS = [
  // 服务端 appcfg.json 的实际写法（schema `picoaide-app-config/1`）。
  'access_values', 'config_fields.access.values', 'publish_fields.access.values',
  'access', 'access.values', 'access.enum', 'access.allowed', 'access.modes',
  'access_modes', 'access_modes.values', 'access_modes.enum',
  'fields.access', 'fields.access.values', 'fields.access.enum', 'fields.access.allowed',
  'permissions.access', 'permissions.access.values', 'config.access', 'config.access.values',
]

const ACCESS_DEFAULT_PATHS = [
  'access_default', 'access.default', 'access.default_value', 'access_default_value',
  'fields.access.default', 'fields.access.default_value', 'defaults.access', 'config.access.default',
]

const WHITELIST_MAX_PATHS = [
  // 服务端 appcfg.json：白名单上限挂在 `whitelist` 字段节点的 `max` 上。
  'config_fields.whitelist.max', 'config_fields.whitelist.max_items', 'config_fields.whitelist.max_entries',
  'whitelist_max', 'whitelist.max', 'whitelist.max_items', 'whitelist.max_entries',
  'limits.whitelist_max', 'limits.app_config_whitelist_max', 'limits.appconfig_whitelist_max',
  'fields.whitelist.max', 'fields.whitelist.max_items', 'fields.whitelist.max_entries',
]

const FIELD_TABLE_PATHS = ['config_fields', 'publish_fields', 'fields', 'field_names', 'app_config_fields', 'appcfg_fields', 'top_level_fields']

/** 字段表的节点里，用来放"字段名"的键。 */
const FIELD_NAME_KEYS = ['name', 'field', 'key', 'id']

/**
 * 字段表的节点里，用来放"首版必填"的键。
 *
 * 只认**显式的首版语义**（布尔键，或 `required_when: "first_release"`）：
 * 裸 `required: true` 是"永远必填"（如 `app_id`/`version`/`config`），
 * 把它当首版必填会让对拍报假差异。
 */
const FIRST_RELEASE_KEYS = ['required_first_release', 'first_release_required', 'required_on_first_release', 'required_when']

/** `required_when` 表示"首版必填"的取值。 */
const FIRST_RELEASE_WHEN = 'first_release'

/**
 * 按点分路径取值。支持三种容器形态（字段表的常见写法都能吃下）：
 *   - 对象键：`{ access: [...] }`；
 *   - 数组下标：`{ access: { values: [...] } }` 里的 `values`；
 *   - **按名字索引的数组**：`{ fields: [{ name: 'access', … }] }` 里 `fields.access`。
 * @param root - 解析后的 JSON。
 * @param path - 点分路径。
 * @returns 取到的值，或 `undefined`。
 */
function readPath(root: unknown, path: string): unknown {
  let current: unknown = root
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    if (Array.isArray(current)) {
      const named = current.find(node => isNodeNamed(node, segment))
      if (named === undefined) return undefined
      current = named
      continue
    }
    const record = current as Record<string, unknown>
    if (!Object.hasOwn(record, segment)) return undefined
    current = record[segment]
  }
  return current
}

/** 数组元素是否是一个"名字等于 segment"的字段节点。 */
function isNodeNamed(node: unknown, segment: string): boolean {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return false
  const record = node as Record<string, unknown>
  return FIELD_NAME_KEYS.some(key => record[key] === segment)
}

/** 字符串数组 → 排序后的去重数组（对拍时忽略顺序与重复）。 */
function normalizeStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item === '') return null
    out.push(item)
  }
  if (out.length === 0) return null
  return [...new Set(out)].sort()
}

/**
 * 深扫兜底：在整份 JSON 里找"看起来就是 access 取值表"的字符串数组。
 *
 * 候选路径没命中时用。这样即使字段表换了键名，只要它**如实列出了三个取值**，
 * 对拍就仍然成立 —— 而不是静默退化成"什么都没查"。
 * @param root - 解析后的 JSON。
 * @returns 命中路径与取值。
 */
function deepFindAccessModes(root: unknown): { path: string, values: string[] } | null {
  const wanted = [...ACCESS_MODES].sort().join(',')
  const walk = (node: unknown, path: string): { path: string, values: string[] } | null => {
    if (Array.isArray(node)) {
      const list = normalizeStringList(node)
      if (list !== null && list.join(',') === wanted) return { path, values: list }
      for (let i = 0; i < node.length; i += 1) {
        const hit = walk(node[i], `${path}[${String(i)}]`)
        if (hit !== null) return hit
      }
      return null
    }
    if (node === null || typeof node !== 'object') return null
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const hit = walk(value, path === '' ? key : `${path}.${key}`)
      if (hit !== null) return hit
    }
    return null
  }
  return walk(root, '')
}

/**
 * 深扫兜底：找白名单上限。
 *
 * 覆盖两种形态：键名自带 whitelist + max 的数字；以及"名叫 `whitelist` 的字段节点"
 * 里的 `max`（服务端 `config_fields[].max` 就是这个形状 —— 那里键名只有 `max`，
 * 光看键名认不出来）。
 * @param root - 解析后的 JSON。
 * @returns 命中路径与取值。
 */
function deepFindWhitelistMax(root: unknown): { path: string, value: number } | null {
  const walk = (node: unknown, path: string, insideWhitelist: boolean): { path: string, value: number } | null => {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        const hit = walk(node[i], `${path}[${String(i)}]`, insideWhitelist)
        if (hit !== null) return hit
      }
      return null
    }
    if (node === null || typeof node !== 'object') return null
    const record = node as Record<string, unknown>
    const named = FIELD_NAME_KEYS.map(key => record[key]).find(value => typeof value === 'string')
    const here = insideWhitelist || named === 'whitelist'
    for (const [key, value] of Object.entries(record)) {
      const next = path === '' ? key : `${path}.${key}`
      if (typeof value === 'number' && /max|limit|cap/iu.test(key) && (here || /whitelist/iu.test(key))) {
        return { path: next, value }
      }
      const hit = walk(value, next, here)
      if (hit !== null) return hit
    }
    return null
  }
  return walk(root, '', false)
}

/**
 * 取字段表（字段名 → 节点）。
 *
 * 多张表会**合并**（服务端把配置字段放在 `config_fields`、请求体字段放在
 * `publish_fields`，首版必填名单横跨两者）；数组形态按节点里的 `name`/`field`/`key` 建索引。
 * @param root - 解析后的 JSON。
 * @returns 字段名 → 节点，以及命中过的表路径；认不出来时返回 `null`。
 */
function readFieldTable(root: unknown): { path: string, fields: Map<string, unknown> } | null {
  const fields = new Map<string, unknown>()
  const paths: string[] = []
  for (const path of FIELD_TABLE_PATHS) {
    const value = readPath(root, path)
    if (value === null || typeof value !== 'object') continue
    const before = fields.size
    if (Array.isArray(value)) {
      for (const node of value) {
        if (node === null || typeof node !== 'object') continue
        const record = node as Record<string, unknown>
        for (const key of FIELD_NAME_KEYS) {
          const name = record[key]
          if (typeof name === 'string' && name !== '') { fields.set(name, node); break }
        }
      }
    } else {
      for (const [name, node] of Object.entries(value as Record<string, unknown>)) fields.set(name, node)
    }
    if (fields.size > before) paths.push(path)
  }
  if (fields.size === 0) return null
  return { path: paths.join('+'), fields }
}

/**
 * 读**某一张具名表**的字段名集合（`config_fields` / `publish_fields`）。
 *
 * 与 {@link readFieldTable} 的区别：那个把多张候选表**合并**成一个集合（用于兼容
 * 未知形状），而全集合对拍必须逐表进行 —— 合并之后就分不清"哪个名字属于哪张表"，
 * 也就做不了相等判定。
 * @param root - `appcfg.json` 的解析结果。
 * @param path - 具名表的点分路径（如 `config_fields`）。
 * @returns 字段名集合；该表不存在或不是"字段表"形态时为 null。
 */
function readTableNames(root: unknown, path: string): Set<string> | null {
  const value = readPath(root, path)
  if (value === null) return null
  const names = new Set<string>()
  if (Array.isArray(value)) {
    for (const node of value) {
      if (node === null || typeof node !== 'object') continue
      const record = node as Record<string, unknown>
      for (const key of FIELD_NAME_KEYS) {
        const name = record[key]
        if (typeof name === 'string' && name !== '') { names.add(name); break }
      }
    }
  } else if (typeof value === 'object') {
    for (const name of Object.keys(value as Record<string, unknown>)) names.add(name)
  }
  return names.size === 0 ? null : names
}

/**
 * 字段节点是否把"首版必填"标成了真。
 *
 * 认两种写法：布尔键（`required_first_release: true`）与 `required_when: "first_release"`
 * （服务端 appcfg.json 的实际写法）。
 * @param node - 字段节点。
 * @returns `true` / `false`（节点明确标了）、`null`（没标，不猜）。
 */
function firstReleaseRequired(node: unknown): boolean | null {
  if (node === null || typeof node !== 'object') return null
  const record = node as Record<string, unknown>
  for (const key of FIRST_RELEASE_KEYS) {
    const value = record[key]
    if (value === FIRST_RELEASE_WHEN) return true
    if (typeof value === 'boolean') return value
    // `required_when` 的其它取值（如 `non_first_release`）不代表首版必填。
    if (key === 'required_when' && typeof value === 'string') return false
  }
  return null
}

/**
 * 把 `appcfg.json` 与本模块的镜像常量逐项对拍（**纯函数**，读文件由测试负责）。
 *
 * 认不出来的维度进 `unknown`（打印出来，不失败）；认出来且不一致的进 `mismatches`
 * （测试据此变红）。`checked` 为空说明字段表的形状完全没被认出来 —— 测试会因此
 * 失败并要求维护者补候选路径，而不是静默"全绿"。
 * @param json - `JSON.parse` 之后的字段表。
 * @returns 对拍结果。
 */
export function compareWithAppcfgJson(json: unknown): AppcfgComparison {
  const checked: string[] = []
  const mismatches: AppcfgMismatch[] = []
  const unknown: string[] = []

  // ---- access 取值表 ----
  let modes: { path: string, values: string[] } | null = null
  for (const path of ACCESS_MODES_PATHS) {
    const list = normalizeStringList(readPath(json, path))
    if (list !== null) { modes = { path, values: list }; break }
  }
  modes ??= deepFindAccessModes(json)
  if (modes === null) {
    unknown.push(`access_modes（试过 ${ACCESS_MODES_PATHS.join(' / ')} 与深扫）`)
  } else {
    checked.push('access_modes')
    const expected = [...ACCESS_MODES].sort()
    if (modes.values.join(',') !== expected.join(',')) {
      mismatches.push({ aspect: 'access_modes', expected: expected.join('|'), actual: modes.values.join('|'), path: modes.path })
    }
  }

  // ---- access 缺省值 ----
  let defaultPath: string | null = null
  let defaultRaw: unknown
  for (const path of ACCESS_DEFAULT_PATHS) {
    const value = readPath(json, path)
    if (typeof value === 'string') { defaultPath = path; defaultRaw = value; break }
  }
  if (defaultPath === null) {
    unknown.push(`access_default（试过 ${ACCESS_DEFAULT_PATHS.join(' / ')}）`)
  } else {
    checked.push('access_default')
    if (defaultRaw !== DEFAULT_ACCESS) {
      mismatches.push({ aspect: 'access_default', expected: DEFAULT_ACCESS, actual: String(defaultRaw), path: defaultPath })
    }
  }

  // ---- 白名单上限 ----
  let max: { path: string, value: number } | null = null
  for (const path of WHITELIST_MAX_PATHS) {
    const value = readPath(json, path)
    if (typeof value === 'number') { max = { path, value }; break }
  }
  max ??= deepFindWhitelistMax(json)
  if (max === null) {
    unknown.push(`whitelist_max（试过 ${WHITELIST_MAX_PATHS.join(' / ')} 与深扫）`)
  } else {
    checked.push('whitelist_max')
    if (max.value !== WHITELIST_MAX) {
      mismatches.push({ aspect: 'whitelist_max', expected: String(WHITELIST_MAX), actual: String(max.value), path: max.path })
    }
  }

  // ---- 字段名集合（含"visible / login_required 已删除"）----
  const table = readFieldTable(json)
  if (table === null) {
    unknown.push(`field_names（试过 ${FIELD_TABLE_PATHS.join(' / ')}）`)
  } else {
    checked.push('field_names')
    for (const field of ['access', 'whitelist'] as const) {
      if (!table.fields.has(field)) {
        mismatches.push({ aspect: 'field_names', expected: `has ${field}`, actual: 'missing', path: table.path })
      }
    }
    // **全集合相等**（审计 P1-1）：只查"某几个名字在不在"会让改名静默溜过。
    // 两张表的名字集合各有自己的真源（客户端配置字段 / 发布载荷字段）。
    for (const [tablePath, expectedFields] of REQUIRED_TABLES) {
      const names = readTableNames(json, tablePath)
      if (names === null) {
        // 认不出这张表（换了名字/换了形状）：记进 `unknown` 而不是 mismatch ——
        // 兼容未知形状是这里既有的取舍，且"认不出来"必须**看得见**。
        // 但对自己的生成物（服务端 appcfg.json）不能停在"认不出来"：
        // `appcfg-contract.spec.ts` 另外要求这两张表**必须被认出来**。
        unknown.push(`${tablePath}_set（缺 ${tablePath} 表或形状不认识）`)
        continue
      }
      checked.push(`${tablePath}_set`)
      const expected = [...expectedFields].slice().sort()
      const actual = [...names].sort()
      if (expected.join('|') !== actual.join('|')) {
        mismatches.push({
          aspect: 'field_names',
          expected: `${tablePath} = ${expected.join('|')}`,
          actual: actual.join('|'),
          path: tablePath,
        })
      }
    }
    for (const removed of REMOVED_APP_CONFIG_FIELDS) {
      if (table.fields.has(removed)) {
        mismatches.push({ aspect: 'field_names', expected: `${removed} removed`, actual: 'still present', path: `${table.path}.${removed}` })
      }
    }
    // 首版必填名单：只对"字段表里真的出现了"的字段对拍（没出现就不猜）。
    const declared: string[] = []
    const contradicted: string[] = []
    for (const field of FIRST_RELEASE_REQUIRED_FIELDS) {
      const node = table.fields.get(field)
      if (node === undefined) continue
      const required = firstReleaseRequired(node)
      if (required === true) declared.push(field)
      if (required === false) contradicted.push(field)
    }
    if (declared.length > 0 || contradicted.length > 0) {
      checked.push('first_release_required')
      const expected = FIRST_RELEASE_REQUIRED_FIELDS.filter(f => table.fields.has(f)).slice().sort()
      if (declared.slice().sort().join(',') !== expected.join(',') || contradicted.length > 0) {
        mismatches.push({
          aspect: 'first_release_required',
          expected: expected.join('|'),
          actual: `required=[${declared.slice().sort().join('|')}] not_required=[${contradicted.sort().join('|')}]`,
          path: table.path,
        })
      }
    } else {
      unknown.push('first_release_required（字段表里没有任何字段标了首版必填）')
    }
  }

  return { checked, mismatches, unknown }
}
