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
} as const

/** 一条预检失败。 */
export interface PrecheckIssue {
  code: string
  field?: string | undefined
  message: string
}

/** 与服务端一致的上限(server/internal/skillmanifest/manifest.go)。 */
const LIMITS = {
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
} as const

/** 与上游 `@deepseek-ai/dsh-skill` 的 SKILL_NAME 逐字一致。 */
const APP_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u
const BOOLEAN_LITERALS = new Set(['true', 'yes', 'on', 'false', 'no', 'off', '1', '0'])
const LEGACY_INVOCATION: Record<string, string> = {
  disableModelInvocation: 'disable-model-invocation',
  modelInvocable: 'disable-model-invocation',
  userInvocable: 'user-invocable',
}

const runes = (s: string): number => [...s].length
const issue = (code: string, message: string, field?: string): PrecheckIssue =>
  field === undefined ? { code, message } : { code, field, message }

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
  provenanceForbidden: string
  provenanceDirForbidden: string
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
      c('字段 {key} 必须是布尔值(true/false)', 'Field {key} must be a boolean (true/false)'),
      { key },
    ),
    provenanceForbidden: c(
      'frontmatter 不得包含 metadata.picoaide:它由安装器写入,用于标记技能来源',
      'frontmatter must not contain metadata.picoaide: the installer writes it to record the skill origin',
    ),
    provenanceDirForbidden: c(
      '归档不得包含 .picoaide/ 目录:它由安装器写入,用于标记技能来源',
      'The archive must not contain a .picoaide/ directory: the installer writes it to record the skill origin',
    ),
  }
}

/** 是否合法应用 ID(与服务端 IsAppID 同规则)。 */
export function isAppId(value: string): boolean {
  return value.length >= LIMITS.minAppId && value.length <= LIMITS.maxAppId && APP_ID.test(value)
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
 * 预检一个技能包。
 * @param skillMd - SKILL.md 原始内容（**不要预先剥 BOM**，检测依赖它）。
 * @param appId - 目标应用 ID（技能目录名）。
 * @param entries - 归档内的条目路径（用于溯源禁止项检查）。
 * @param locale - 宿主语言（调用方按请求解析后传入；缺省中文，与历史行为一致）。
 * @returns 全部问题；空数组 = 通过前 7 步校验。
 */
export function precheckSkillPackage(
  skillMd: string, appId: string, entries: readonly string[] = [], locale: HostLocale = DEFAULT_HOST_LOCALE,
): PrecheckIssue[] {
  const m = precheckMessages(locale)
  const out: PrecheckIssue[] = []
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
  let data: Record<string, unknown>
  try {
    const parsed = parseYaml(rest.slice(0, end)) as unknown
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
    const raw = data[key]
    if (raw === undefined || raw === null || typeof raw === 'boolean') continue
    const text = scalar(raw)
    if (text === undefined || !BOOLEAN_LITERALS.has(text.trim().toLowerCase())) {
      out.push(issue(PrecheckCode.InvocationInvalid, m.invocationNotBoolean(key), key))
    }
  }

  const metadata = data.metadata
  if (typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
    && Object.hasOwn(metadata as Record<string, unknown>, 'picoaide')) {
    out.push(issue(PrecheckCode.ProvenanceForbidden, m.provenanceForbidden, 'metadata.picoaide'))
  }
  if (entries.some((e) => e.startsWith('.picoaide/'))) {
    out.push(issue(PrecheckCode.ProvenanceForbidden, m.provenanceDirForbidden))
  }
  return out
}
