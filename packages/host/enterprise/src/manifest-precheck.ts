/**
 * 发布前的本地预检:与服务端 `internal/skillmanifest` **同一套规则的前 7 步**
 * (纯包内校验,不依赖数据库),在用户点「上传」之前就把问题指出来。
 *
 * 决策 docs/decisions/2026-09-01-skill-app-management.md §5.5:规则一份、两处
 * 执行,服务端始终是权威。此处只做「便宜且不查库」的部分——版本是否递增、
 * 名字是否被锁定这类需要服务端状态的判定不在这里。
 *
 * 错误码与服务端逐字一致,便于两端行为对齐与联调。
 *
 * 文案是**用户可见**的: `skill-install.ts` 的 `packSkill()` 抛出的消息最终经
 * `auth-gate.ts` 的 `{ error: message }` 回到能力中心面板。因此这里按宿主语言
 * 取文案(`{ zh, en }` 两份, zh 是原文逐字保留), 语言由调用方**按请求**解析
 * 后传入(见 `dsh-plugin-desktop/host-locale`)—— 绝不在模块级捕获。
 */
import { DEFAULT_HOST_LOCALE, hostCopy, type HostLocale } from 'dsh-plugin-desktop/host-locale'
import { parse as parseYaml } from 'yaml'
import { isWindowsReservedDeviceNameSegment, reservedDeviceNameInArchivePath } from './skill-name-rules.ts'

/** 与服务端 skillmanifest 相同的稳定错误码。 */
export const PrecheckCode = {
  MissingField: 'MISSING_FIELD',
  InvalidAppID: 'INVALID_APP_ID',
  InvalidVersion: 'INVALID_VERSION',
  FieldTooLong: 'FIELD_TOO_LONG',
  FieldTooShort: 'FIELD_TOO_SHORT',
  InvalidType: 'INVALID_TYPE',
  IdentityMismatch: 'IDENTITY_MISMATCH',
  BomDetected: 'BOM_DETECTED',
  FrontmatterInvalid: 'FRONTMATTER_INVALID',
  BodyEmpty: 'BODY_EMPTY',
  InvocationInvalid: 'INVOCATION_INVALID',
  ProvenanceForbidden: 'PROVENANCE_FORBIDDEN',
  /** 输入规模闸（R15B-03）：服务端 `checkManifestSize` 的 `INPUT_TOO_LARGE`。 */
  InputTooLarge: 'INPUT_TOO_LARGE',
} as const

/** 一条预检失败。 */
export interface PrecheckIssue {
  code: string
  field?: string | undefined
  message: string
}

/**
 * 与服务端一致的上限与解析预算（`server/internal/skillmanifest/manifest.go`）。
 *
 * **这份表不允许手抄**：`tests/audit-r15b-manifest-parity.spec.ts` 用 `node:fs`
 * 读 Go 源码逐值对拍（读不到真源即 fail-loud），并断言每个键都真的被规则体用到
 * （"声明了却没用的死常量"正是 R15B-03 的一半）。改数值必须改 Go。
 *
 * 键名 → Go 常量的映射写在那个对拍用例里（两边命名惯例不同，逐条登记才能避免
 * "看起来一致"）。
 *
 * 导出只给对拍用例读：生产代码请用包内引用（`LIMITS.maxTitle` 之类），
 * 不要在别处再抄一份。
 */
export const LIMITS = {
  minAppId: 2,
  maxAppId: 64,
  maxTitle: 100,
  minDescription: 10,
  maxDescription: 2000,
  maxAuthor: 64,
  maxCategory: 32,
  maxChangelog: 500,
  maxTags: 30,
  maxTagRunes: 32,
  minBody: 50,
  // R15B-03：服务端的三层解析闸门 + 列表项上限（Go 侧常量名：
  // MaxSkillMDBytes / MaxFrontmatterDepth / MaxFrontmatterCollections /
  // MaxFrontmatterIndicators / MaxFrontmatterReferences —— 数值在这里**不复述**，
  // 真值由 tests/audit-r15b-manifest-parity.spec.ts 读 Go 源码逐值对拍）。
  //
  // 它们此前在预检里**完全不存在** ⇒ 一份 >128 KiB 的 SKILL.md 或嵌套 40 层的
  // frontmatter 能显示"预检通过"、上传后被服务端 422 拒 —— 正是预检要消灭的
  // 那类"上传才知道"的失败。
  maxSkillMdBytes: 128 * 1024,
  maxFrontmatterDepth: 32,
  maxFrontmatterCollections: 256,
  maxFrontmatterIndicators: 256,
  maxFrontmatterReferences: 1024,
} as const

/**
 * 客户端支持的 YAML merge key（`<<`）拒绝口径，与服务端 `reMergeKey` 逐字同形。
 *
 * 服务端拒它是因为 goccy 的解码器会对 merge 引用做逐键映射合并（嵌套时按
 * fanout^k 膨胀，2732 字节可烧 86~143 秒 CPU）。技能元数据是扁平键值清单，
 * 合法包含 0 个 merge key ⇒ 零误杀的硬拒绝。对拍用例把 Go 的 `regexp.MustCompile`
 * 字面量读出来在同一份语料上比对判定（不是两边各写一个"看起来一样"的正则）。
 */
export const MERGE_KEY_PATTERN = /<<[ ]*:/u

/** 与上游 `@deepseek-ai/dsh-skill` 的 SKILL_NAME 逐字一致。 */
const APP_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u/**
 * 上游 `frontmatterBoolean` 接受的布尔**字符串**字面量（小写比较，**不 trim**）。
 *
 * **不要**把它当成"我们自己的规则"：它是从 pinned 上游实现里逐字取出来的，
 * 由 `tests/skill-invocation-upstream-parity.spec.ts` **读上游源码**派生后对拍
 * （上游加/减一个字面量 ⇒ 用例红）。R13-B P1-1 的教训正是"两端各钉自己的
 * 字面量集合"，所以这里只留取值，判据与期望都在对拍用例里。
 */
export const INVOCATION_BOOLEAN_LITERALS: readonly string[] = ['0', '1', 'false', 'no', 'off', 'on', 'true', 'yes']
const BOOLEAN_LITERALS = new Set(INVOCATION_BOOLEAN_LITERALS)
const LEGACY_INVOCATION: Record<string, string> = {
  disableModelInvocation: 'disable-model-invocation',
  modelInvocable: 'disable-model-invocation',
  userInvocable: 'user-invocable',
}

/**
 * `disable-model-invocation` / `user-invocable` 取值的判定结果。
 * - `ok`：上游 `frontmatterBoolean` 接受；
 * - `empty`：键**存在**但取值为空（YAML 空值 / `null` / `~` / 空串）——上游 **throw**；
 * - `invalid`：其他任何取值（非法字符串、非 0/1 的数字、数组、映射）——上游同样 **throw**。
 *
 * 后两种在**产品后果上没有区别**（上游 `parseSkillFile` 的 catch 把整份技能
 * 丢弃），分开只为给作者一条可行动的文案。判定逐条对齐 pinned 上游
 * `skill-filesystem/src/index.ts` 的 `frontmatterBoolean`：
 *   `boolean` → 用它；`1`/`'1'` → true；`0`/`'0'` → false；字符串只做
 *   `toLowerCase()`（**不 trim**）后匹配 8 个字面量；其余一律 throw。
 * @param raw - frontmatter 里该键的取值（调用方须先确认键存在）。
 * @returns 判定结果（`ok` = 上游可加载）。
 */
export function invocationBooleanVerdict(raw: unknown): 'ok' | 'empty' | 'invalid' {
  if (typeof raw === 'boolean') return 'ok'
  if (typeof raw === 'number') return raw === 1 || raw === 0 ? 'ok' : 'invalid'
  if (typeof raw === 'string') {
    // 不 trim：上游对 `' true '` 一样抛错，trim 会让"装得上、加载不到"复现。
    if (BOOLEAN_LITERALS.has(raw.toLowerCase())) return 'ok'
    return raw.trim() === '' ? 'empty' : 'invalid'
  }
  if (raw === null || raw === undefined) return 'empty'
  return 'invalid'
}

const runes = (s: string): number => [...s].length
const issue = (code: string, message: string, field?: string): PrecheckIssue =>
  field === undefined ? { code, message } : { code, field, message }

/** frontmatter 的结构预算（与服务端 `frontmatterBudget` 逐字段同形）。 */
export interface FrontmatterBudget {
  /** `[` / `{` / `]` / `}` 的出现次数。 */
  collections: number
  /** 块序列指示符（`- `/`-\t`/`-\n`/末尾 `-`）的出现次数。 */
  indicators: number
  /** 锚点/别名/标签（`&` / `*` / `!`）的出现次数。 */
  references: number
  /** 观测到的最大嵌套深度（启发式，只可能高估）。 */
  maxDepth: number
}

/**
 * 单遍扫描 frontmatter，统计交给 YAML 解析器之前的结构预算。
 *
 * **逐字符镜像**服务端 `scanFrontmatterComplexity`（`manifest.go`）：同样的开/闭
 * 括号计数、同样的块序列指示符判定（`-` 后跟空格/制表符/换行或位于末尾才算）、
 * 同样把引号内的括号一起计数（偏保守是故意的：低估会放过炸弹）。三个计数器是
 * **原始字符计数**，不依赖任何状态，所以骗不过引号或注释。
 *
 * 深度是启发式（遇到 `[`/`{`/块序列指示符 +1，遇到闭括号或行尾 -1）。
 * @param front - SKILL.md 的 frontmatter 原文（不含首尾 `---` 分隔行）。
 * @returns 四个计数。
 */
export function scanFrontmatterComplexity(front: string): FrontmatterBudget {
  let collections = 0
  let indicators = 0
  let references = 0
  let maxDepth = 0
  let depth = 0
  const bump = (): void => {
    depth += 1
    if (depth > maxDepth) maxDepth = depth
  }
  for (let i = 0; i < front.length; i++) {
    const ch = front[i]
    if (ch === '[' || ch === '{') {
      collections += 1
      bump()
    } else if (ch === ']' || ch === '}') {
      // 闭合括号同样进 collections：服务端实测单行 `]`×51200 也能让解析器多分配
      // 40 MiB。合法 frontmatter 的开/闭括号一一对应且总数 ≤ 2。
      collections += 1
      if (depth > 0) depth -= 1
    } else if (ch === '&' || ch === '*' || ch === '!') {
      references += 1
    } else if (ch === '-') {
      // 纯 `-`（kebab-case 的连字符、`---`）不计数：必须后跟空格/制表符/换行，
      // 或者就位于文本末尾。
      if (i + 1 === front.length) {
        indicators += 1
        bump()
      } else if (front[i + 1] === ' ' || front[i + 1] === '\t' || front[i + 1] === '\n') {
        indicators += 1
        bump()
      }
    } else if (ch === '\n') {
      depth = 0
    }
  }
  return { collections, indicators, references, maxDepth }
}

/**
 * Fill `{name}` placeholders in ONE pass.
 *
 * A chained replaceAll re-scans already-inserted values, so a user field
 * containing `{n}` would be rewritten while it is being reported (2026-09-16
 * audit R5). Same shape as the client `t()` implementations.
 * @param template - message template.
 * @param params - placeholder values; unknown placeholders stay literal.
 * @returns the filled message.
 */
function fill(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : match))
}

/** 预检文案：zh 为原文（逐字保留）, en 为镜像。 */
interface PrecheckMessages {
  missingField: (field: string) => string
  invalidType: (field: string) => string
  emptyField: (field: string) => string
  fieldTooLong: (field: string, max: number) => string
  bom: string
  frontmatterHead: string
  frontmatterEnd: string
  frontmatterNotMapping: string
  frontmatterNotYaml: string
  invalidAppId: (name: string) => string
  identityMismatch: (name: string, appId: string) => string
  missingVersion: string
  invalidVersion: (version: string) => string
  descriptionTooShort: (min: number) => string
  tagsNotArray: string
  tooManyTags: (max: number) => string
  tagNotString: string
  tagTooLong: (tag: string, max: number) => string
  bodyTooShort: (min: number) => string
  legacyInvocation: (legacy: string, canonical: string) => string
  invocationNotBoolean: (key: string) => string
  invocationEmpty: (key: string) => string
  inputTooLarge: (what: string, bytes: number, max: number) => string
  frontmatterDepth: (depth: number, max: number) => string
  frontmatterCollections: (count: number, max: number) => string
  frontmatterIndicators: (count: number, max: number) => string
  frontmatterReferences: (count: number, max: number) => string
  mergeKeyForbidden: (what: string) => string
  provenanceForbidden: string
  provenanceDirForbidden: string
  reservedDeviceName: (name: string) => string
  reservedArchiveEntry: (entry: string) => string
}

/** 按语言取一份消息表（每次调用重建, 不缓存 —— 语言可能随时变）。 */
function precheckMessages(locale: HostLocale): PrecheckMessages {
  const c = <T>(zh: T, en: T): T => hostCopy(locale, zh, en)
  return {
    missingField: (field) => fill(c('缺少必填字段 {field}', 'Missing required field {field}'), { field }),
    invalidType: (field) => fill(c('字段 {field} 必须是单值字符串', 'Field {field} must be a single string value'), { field }),
    emptyField: (field) => fill(c('必填字段 {field} 不能为空', 'Required field {field} must not be empty'), { field }),
    fieldTooLong: (field, max) => fill(
      c('字段 {field} 超长(上限 {n} 字)', 'Field {field} is too long (max {n} characters)'),
      { field, n: max },
    ),
    bom: c(
      'SKILL.md 含 UTF-8 BOM,会导致技能被运行时忽略;请另存为「UTF-8 无 BOM」',
      'SKILL.md contains a UTF-8 BOM, which makes the runtime ignore the skill; save it as "UTF-8 without BOM"',
    ),
    frontmatterHead: c(
      'SKILL.md 缺少 YAML frontmatter:文件必须以 --- 开头',
      'SKILL.md is missing its YAML frontmatter: the file must start with ---',
    ),
    frontmatterEnd: c(
      'SKILL.md 的 frontmatter 没有结束分隔符 ---',
      'SKILL.md frontmatter has no closing --- delimiter',
    ),
    frontmatterNotMapping: c(
      'SKILL.md 的 frontmatter 不是合法 YAML 映射',
      'SKILL.md frontmatter is not a valid YAML mapping',
    ),
    frontmatterNotYaml: c(
      'SKILL.md 的 frontmatter 不是合法 YAML',
      'SKILL.md frontmatter is not valid YAML',
    ),
    invalidAppId: (name) => fill(
      c('技能名 "{name}" 不合法:必须是小写 kebab-case(如 my-skill)', 'Skill name "{name}" is invalid: it must be lowercase kebab-case (for example my-skill)'),
      { name },
    ),
    identityMismatch: (name, appId) => fill(
      c('SKILL.md 的 name("{name}")必须等于应用 ID("{appId}");中文展示名请写在 title', 'SKILL.md name ("{name}") must equal the app id ("{appId}"); put the display name in title'),
      { name, appId },
    ),
    missingVersion: c('缺少必填字段 version(如 1.0.0)', 'Missing required field version (for example 1.0.0)'),
    invalidVersion: (version) => fill(
      c('version "{version}" 不是合法版本号:必须是 x.y.z;写成 1.0 请补足三段并加引号', 'Version "{version}" is invalid: it must be x.y.z; write 1.0 as three segments and quote it'),
      { version },
    ),
    descriptionTooShort: (min) => fill(
      c('description 过短(至少 {n} 字),它决定模型何时加载本技能', 'description is too short (at least {n} characters); it decides when the model loads this skill'),
      { n: min },
    ),
    tagsNotArray: c('字段 tags 必须是数组', 'Field tags must be an array'),
    tooManyTags: (max) => fill(c('标签过多(上限 {n} 个)', 'Too many tags (max {n})'), { n: max }),
    tagNotString: c('标签必须是字符串', 'Tags must be strings'),
    tagTooLong: (tag, max) => fill(
      c('标签 "{tag}" 超长(上限 {n} 字)', 'Tag "{tag}" is too long (max {n} characters)'),
      { tag, n: max },
    ),
    bodyTooShort: (min) => fill(
      c('技能正文过短(至少 {n} 字):只有 frontmatter 的空壳技能对模型没有价值', 'Skill body is too short (at least {n} characters): a frontmatter-only shell is worthless to the model'),
      { n: min },
    ),
    legacyInvocation: (legacy, canonical) => fill(
      c('frontmatter 字段 {legacy} 已废弃,请改用 {canonical}(保留旧键会让技能被运行时忽略)', 'frontmatter field {legacy} is deprecated; use {canonical} instead (keeping the old key makes the runtime ignore the skill)'),
      { legacy, canonical },
    ),
    invocationNotBoolean: (key) => fill(
      c('字段 {key} 必须是布尔字面量(true/false、yes/no、on/off、1/0):其他取值会让运行时丢弃**整份技能**', 'Field {key} must be a boolean literal (true/false, yes/no, on/off, 1/0); any other value makes the runtime discard the whole skill'),
      { key },
    ),
    invocationEmpty: (key) => fill(
      c('字段 {key} 存在但取值为空:运行时会因此丢弃**整份技能**(装上了也永远加载不到)。请写 true/false(或 yes/no、on/off、1/0),或整行删掉', 'Field {key} is present but has an empty value, which makes the runtime discard the whole skill (installed but never loaded). Write true/false (or yes/no, on/off, 1/0), or remove the line'),
      { key },
    ),
    inputTooLarge: (what, bytes, max) => fill(
      c('{what} 过大({bytes} 字节,上限 {max} 字节):技能元数据应当只有几十行 frontmatter', '{what} is too large ({bytes} bytes, max {max} bytes): skill metadata should be a few dozen lines of frontmatter'),
      { what, bytes, max },
    ),
    frontmatterDepth: (depth, max) => fill(
      c('frontmatter 嵌套过深(深度 {depth},上限 {max}):技能元数据必须是扁平映射', 'frontmatter is nested too deeply (depth {depth}, max {max}): skill metadata must be a flat mapping'),
      { depth, max },
    ),
    frontmatterCollections: (count, max) => fill(
      c('frontmatter 的流式集合过多([ { ] } 共 {count} 个,上限 {max})', 'frontmatter has too many flow collections ([ { ] } × {count}, max {max})'),
      { count, max },
    ),
    frontmatterIndicators: (count, max) => fill(
      c('frontmatter 的列表项过多(- 共 {count} 个,上限 {max})', 'frontmatter has too many sequence indicators (- × {count}, max {max})'),
      { count, max },
    ),
    frontmatterReferences: (count, max) => fill(
      c('frontmatter 的锚点/别名/标签过多(& * ! 共 {count} 个,上限 {max})', 'frontmatter has too many anchors/aliases/tags (& * ! × {count}, max {max})'),
      { count, max },
    ),
    mergeKeyForbidden: (what) => fill(
      c('{what} 不允许 YAML merge key(<<):它会在解码期对映射做逐键合并,是最容易被滥用的指数构造;技能元数据必须是扁平键值清单,请把被合并的字段直接写全', '{what} must not use the YAML merge key (<<): it merges mappings key by key at decode time and is the most abusable exponential construct; skill metadata must be a flat key/value list, so write the merged fields out in full'),
      { what },
    ),
    provenanceForbidden: c(
      'frontmatter 不得包含 metadata.picoaide:它由安装器写入,用于标记技能来源',
      'frontmatter must not contain metadata.picoaide: the installer writes it to record the skill origin',
    ),    provenanceDirForbidden: c(
      '归档不得包含 .picoaide/ 目录:它由安装器写入,用于标记技能来源',
      'The archive must not contain a .picoaide/ directory: the installer writes it to record the skill origin',
    ),
    reservedDeviceName: (name) => fill(
      c(
        '技能名 "{name}" 是 Windows 保留设备名(CON/PRN/AUX/NUL/COM1-9/LPT1-9,带扩展名也算):'
        + '它在 Linux/macOS 装得上,在 Windows 上永远建不出来;请改名(例如 {name}-skill)后重新发布',
        'Skill name "{name}" is a reserved device name on Windows (CON/PRN/AUX/NUL/COM1-9/LPT1-9, '
        + 'with or without an extension): it installs on Linux/macOS but can never be created on Windows; '
        + 'rename it (for example {name}-skill) and publish again',
      ),
      { name },
    ),
    reservedArchiveEntry: (entry) => fill(
      c(
        '归档条目 "{entry}" 是 Windows 保留设备名:Windows 上解包会失败;请改名后重新打包',
        'Archive entry "{entry}" is a reserved device name on Windows: unpacking fails there; rename it and repack',
      ),
      { entry },
    ),
  }
}

/** 是否合法应用 ID(与服务端 IsAppID 同规则)。 */
export function isAppId(value: string): boolean {
  return value.length >= LIMITS.minAppId && value.length <= LIMITS.maxAppId && APP_ID.test(value)
}

/**
 * 名字是不是 Windows 保留设备名（R17B-05；判据真源 = `skill-name-rules.ts`）。
 *
 * `isAppId` **故意**不把保留名算作非法：`con` 在 Linux/macOS 上运行时确实会加载，
 * 并进"合法 ID"会让盘上已有的 `con` 技能被预检/卸载路径拒掉（"看得见删不掉"）。
 * 保留名只在**写侧**（这里 + 安装器 + 归档扫描）拒绝，错误码复用既有的
 * `INVALID_APP_ID` —— 不新造码：`tests/audit-r15b-manifest-parity.spec.ts` 要求
 * 客户端用到的每个码在服务端 `skillmanifest` 都存在，而服务端那一半不在本泳道。
 * @param value - the skill id / app id.
 * @returns 命中 Win32 保留设备名为 true。
 */
export function isWindowsReservedName(value: string): boolean {
  return isWindowsReservedDeviceNameSegment(value)
}

/** 是否合法 semver(与服务端 IsVersion 同规则)。 */
export function isVersion(value: string): boolean {
  return SEMVER.test(value)
}

function scalar(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function requireField(
  data: Record<string, unknown>, field: string, maxRunes: number, m: PrecheckMessages,
): { value: string } | { issue: PrecheckIssue } {
  const raw = data[field]
  if (raw === undefined || raw === null) {
    return { issue: issue(PrecheckCode.MissingField, m.missingField(field), field) }
  }
  const text = scalar(raw)
  if (text === undefined) {
    return { issue: issue(PrecheckCode.InvalidType, m.invalidType(field), field) }
  }
  const trimmed = text.trim()
  if (trimmed === '') return { issue: issue(PrecheckCode.MissingField, m.emptyField(field), field) }
  if (runes(trimmed) > maxRunes) {
    return { issue: issue(PrecheckCode.FieldTooLong, m.fieldTooLong(field, maxRunes), field) }
  }
  return { value: trimmed }
}

/**
 * 可选字段的长度校验（与服务端 `optionalString` 同口径）。
 *
 * 与服务端一样：**缺失与 null 都算没声明**（返回 null），非单值类型报
 * INVALID_TYPE，取值 trim 后超限报 FIELD_TOO_LONG。空串不是错误（可选字段没有
 * 下限）。
 * @param data - frontmatter 映射。
 * @param field - 字段名。
 * @param maxRunes - 上限（按码点计）。
 * @param m - 该语言的文案表。
 * @returns 取值 / 一条问题 / null（未声明）。
 */
function optionalField(
  data: Record<string, unknown>, field: string, maxRunes: number, m: PrecheckMessages,
): { value: string } | { issue: PrecheckIssue } | null {
  const raw = data[field]
  if (raw === undefined || raw === null) return null
  const text = scalar(raw)
  if (text === undefined) return { issue: issue(PrecheckCode.InvalidType, m.invalidType(field), field) }
  const trimmed = text.trim()
  if (runes(trimmed) > maxRunes) {
    return { issue: issue(PrecheckCode.FieldTooLong, m.fieldTooLong(field, maxRunes), field) }
  }
  return { value: trimmed }
}

/**
 * 预检一个技能包。
 * @param skillMd - SKILL.md 原始内容（**不要预先剥 BOM**，检测依赖它）。
 * @param appId - 目标应用 ID（技能目录名）。
 * @param entries - 归档内的条目路径（用于溯源禁止项检查）。
 * @param locale - 宿主语言（调用方按请求解析后传入；缺省中文，与历史行为一致）。
 * @returns 全部问题；空数组 = 通过预检覆盖的全部规则。
 */
export function precheckSkillPackage(
  skillMd: string, appId: string, entries: readonly string[] = [], locale: HostLocale = DEFAULT_HOST_LOCALE,
): PrecheckIssue[] {
  const m = precheckMessages(locale)
  const out: PrecheckIssue[] = []
  // 规模闸放在最前（与服务端 Parse 的顺序一致，也是最便宜的一层 O(1)）：
  // 先按**字节**判，与 Go 的 `len(raw)` 同口径（不是码点数）。
  const bytes = Buffer.byteLength(skillMd, 'utf8')
  if (bytes > LIMITS.maxSkillMdBytes) {
    return [issue(PrecheckCode.InputTooLarge, m.inputTooLarge('SKILL.md', bytes, LIMITS.maxSkillMdBytes))]
  }
  if (skillMd.startsWith('\ufeff')) {
    return [issue(PrecheckCode.BomDetected, m.bom)]
  }
  const normalized = skillMd.replace(/\r\n/gu, '\n')
  if (!normalized.startsWith('---\n')) {
    return [issue(PrecheckCode.FrontmatterInvalid, m.frontmatterHead)]
  }
  const rest = normalized.slice(4)
  const end = rest.indexOf('\n---')
  if (end < 0) {
    return [issue(PrecheckCode.FrontmatterInvalid, m.frontmatterEnd)]
  }
  const front = rest.slice(0, end)
  // 解析前的结构闸门（服务端 parseManifestYAML 的第 2、3 层）：深度炸弹与
  // merge key 必须在**把文本交给 YAML 解析器之前**拒掉 —— 那两者能烧掉几十秒
  // CPU 或几百 MiB 内存，等解析完再报错就已经付过代价了。
  const budget = scanFrontmatterComplexity(front)
  if (budget.maxDepth > LIMITS.maxFrontmatterDepth) {
    return [issue(PrecheckCode.FrontmatterInvalid, m.frontmatterDepth(budget.maxDepth, LIMITS.maxFrontmatterDepth))]
  }
  if (budget.collections > LIMITS.maxFrontmatterCollections) {
    return [issue(PrecheckCode.FrontmatterInvalid, m.frontmatterCollections(budget.collections, LIMITS.maxFrontmatterCollections))]
  }
  if (budget.indicators > LIMITS.maxFrontmatterIndicators) {
    return [issue(PrecheckCode.FrontmatterInvalid, m.frontmatterIndicators(budget.indicators, LIMITS.maxFrontmatterIndicators))]
  }
  if (budget.references > LIMITS.maxFrontmatterReferences) {
    return [issue(PrecheckCode.FrontmatterInvalid, m.frontmatterReferences(budget.references, LIMITS.maxFrontmatterReferences))]
  }
  if (front.includes('<<') && MERGE_KEY_PATTERN.test(front)) {
    return [issue(PrecheckCode.FrontmatterInvalid, m.mergeKeyForbidden('SKILL.md 的 frontmatter'))]
  }
  let data: Record<string, unknown>
  try {
    const parsed = parseYaml(front) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return [issue(PrecheckCode.FrontmatterInvalid, m.frontmatterNotMapping)]
    }
    data = parsed as Record<string, unknown>
  } catch {
    return [issue(PrecheckCode.FrontmatterInvalid, m.frontmatterNotYaml)]
  }
  const body = rest.slice(end + 4)

  const name = requireField(data, 'name', LIMITS.maxAppId, m)
  if ('issue' in name) out.push(name.issue)
  else if (!isAppId(name.value)) {
    out.push(issue(PrecheckCode.InvalidAppID, m.invalidAppId(name.value), 'name'))
  } else if (isWindowsReservedName(name.value)) {
    // R17B-05：合法的 kebab-case，但是 Win32 保留设备名 —— 写侧必须拒（错误码复用
    // INVALID_APP_ID，与 Go 侧同码；保留名**不**并进 isAppId，见该函数注释）。
    out.push(issue(PrecheckCode.InvalidAppID, m.reservedDeviceName(name.value), 'name'))
  } else if (name.value !== appId) {
    out.push(issue(PrecheckCode.IdentityMismatch, m.identityMismatch(name.value, appId), 'name'))
  }

  const version = scalar(data.version)?.trim()
  if (version === undefined || version === '') {
    out.push(issue(PrecheckCode.MissingField, m.missingVersion, 'version'))
  } else if (!isVersion(version)) {
    out.push(issue(PrecheckCode.InvalidVersion, m.invalidVersion(version), 'version'))
  }

  const title = requireField(data, 'title', LIMITS.maxTitle, m)
  if ('issue' in title) out.push(title.issue)

  const description = requireField(data, 'description', LIMITS.maxDescription, m)
  if ('issue' in description) out.push(description.issue)
  else if (runes(description.value) < LIMITS.minDescription) {
    out.push(issue(PrecheckCode.FieldTooShort, m.descriptionTooShort(LIMITS.minDescription), 'description'))
  }

  const author = requireField(data, 'author', LIMITS.maxAuthor, m)
  if ('issue' in author) out.push(author.issue)
  const category = requireField(data, 'category', LIMITS.maxCategory, m)
  if ('issue' in category) out.push(category.issue)

  // R15B-03：`changelog` 此前是**声明了却从没被用到**的死常量 —— 服务端
  // `optionalString(data, "changelog", MaxChangelogRunes)` 会 422 拒掉 600 字的
  // changelog，而客户端预检一路放行。现在两边同一条规则。
  const changelog = optionalField(data, 'changelog', LIMITS.maxChangelog, m)
  if (changelog !== null && 'issue' in changelog) out.push(changelog.issue)

  const tags = data.tags
  if (tags !== undefined && tags !== null) {
    if (!Array.isArray(tags)) out.push(issue(PrecheckCode.InvalidType, m.tagsNotArray, 'tags'))
    else if (tags.length > LIMITS.maxTags) {
      out.push(issue(PrecheckCode.FieldTooLong, m.tooManyTags(LIMITS.maxTags), 'tags'))
    } else {
      for (const tag of tags) {
        const text = scalar(tag)
        if (text === undefined) { out.push(issue(PrecheckCode.InvalidType, m.tagNotString, 'tags')); break }
        if (runes(text) > LIMITS.maxTagRunes) {
          out.push(issue(PrecheckCode.FieldTooLong, m.tagTooLong(text, LIMITS.maxTagRunes), 'tags'))
          break
        }
      }
    }
  }

  if (runes(body.trim()) < LIMITS.minBody) {
    out.push(issue(PrecheckCode.BodyEmpty, m.bodyTooShort(LIMITS.minBody)))
  }

  for (const [legacy, canonical] of Object.entries(LEGACY_INVOCATION)) {
    if (Object.hasOwn(data, legacy)) {
      out.push(issue(PrecheckCode.InvocationInvalid, m.legacyInvocation(legacy, canonical), legacy))
    }
  }
  for (const key of ['disable-model-invocation', 'user-invocable']) {
    // 键**存在**就必须是合法布尔字面量：`raw === null` 不是"没声明"，而是
    // "声明成了空值" —— 上游 frontmatterBoolean 对它 throw，整份技能被丢弃
    // （R13-B P1-1：客户端预检/服务端校验/安装器三关全绿而模型永远看不到）。
    if (!Object.hasOwn(data, key)) continue
    const verdict = invocationBooleanVerdict(data[key])
    if (verdict === 'ok') continue
    out.push(issue(
      PrecheckCode.InvocationInvalid,
      verdict === 'empty' ? m.invocationEmpty(key) : m.invocationNotBoolean(key),
      key,
    ))
  }

  const metadata = data.metadata
  if (typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
    && Object.hasOwn(metadata as Record<string, unknown>, 'picoaide')) {
    out.push(issue(PrecheckCode.ProvenanceForbidden, m.provenanceForbidden, 'metadata.picoaide'))
  }
  if (entries.some((e) => e.startsWith('.picoaide/'))) {
    out.push(issue(PrecheckCode.ProvenanceForbidden, m.provenanceDirForbidden))
  }
  // R17B-05（归档条目面）：技能目录里放 `aux.txt` / `nul` 这类名字，在 Windows 上
  // 解包同样失败 —— 预检在**上传之前**就拦下来（安装侧还有 `archive-util` 的第二道）。
  const reservedEntry = entries.map(entry => reservedDeviceNameInArchivePath(entry)).find(entry => entry !== undefined)
  if (reservedEntry !== undefined) {
    out.push(issue(PrecheckCode.InvalidAppID, m.reservedArchiveEntry(reservedEntry)))
  }
  return out
}
