/**
 * 发布前的本地预检:与服务端 `internal/skillmanifest` **同一套规则的前 7 步**
 * (纯包内校验,不依赖数据库),在用户点「上传」之前就把问题指出来。
 *
 * 决策 docs/decisions/2026-09-01-skill-app-management.md §5.5:规则一份、两处
 * 执行,服务端始终是权威。此处只做「便宜且不查库」的部分——版本是否递增、
 * 名字是否被锁定这类需要服务端状态的判定不在这里。
 *
 * 错误码与服务端逐字一致,便于两端行为对齐与联调。
 */
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
  data: Record<string, unknown>, field: string, maxRunes: number,
): { value: string } | { issue: PrecheckIssue } {
  const raw = data[field]
  if (raw === undefined || raw === null) {
    return { issue: issue(PrecheckCode.MissingField, `缺少必填字段 ${field}`, field) }
  }
  const text = scalar(raw)
  if (text === undefined) {
    return { issue: issue(PrecheckCode.InvalidType, `字段 ${field} 必须是单值字符串`, field) }
  }
  const trimmed = text.trim()
  if (trimmed === '') return { issue: issue(PrecheckCode.MissingField, `必填字段 ${field} 不能为空`, field) }
  if (runes(trimmed) > maxRunes) {
    return { issue: issue(PrecheckCode.FieldTooLong, `字段 ${field} 超长(上限 ${maxRunes} 字)`, field) }
  }
  return { value: trimmed }
}

/**
 * 预检一个技能包。
 * @param skillMd - SKILL.md 原始内容（**不要预先剥 BOM**，检测依赖它）。
 * @param appId - 目标应用 ID（技能目录名）。
 * @param entries - 归档内的条目路径（用于溯源禁止项检查）。
 * @returns 全部问题；空数组 = 通过前 7 步校验。
 */
export function precheckSkillPackage(skillMd: string, appId: string, entries: readonly string[] = []): PrecheckIssue[] {
  const out: PrecheckIssue[] = []
  if (skillMd.startsWith('\ufeff')) {
    return [issue(PrecheckCode.BomDetected, 'SKILL.md 含 UTF-8 BOM,会导致技能被运行时忽略;请另存为「UTF-8 无 BOM」')]
  }
  const normalized = skillMd.replace(/\r\n/gu, '\n')
  if (!normalized.startsWith('---\n')) {
    return [issue(PrecheckCode.FrontmatterInvalid, 'SKILL.md 缺少 YAML frontmatter:文件必须以 --- 开头')]
  }
  const rest = normalized.slice(4)
  const end = rest.indexOf('\n---')
  if (end < 0) {
    return [issue(PrecheckCode.FrontmatterInvalid, 'SKILL.md 的 frontmatter 没有结束分隔符 ---')]
  }
  let data: Record<string, unknown>
  try {
    const parsed = parseYaml(rest.slice(0, end)) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return [issue(PrecheckCode.FrontmatterInvalid, 'SKILL.md 的 frontmatter 不是合法 YAML 映射')]
    }
    data = parsed as Record<string, unknown>
  } catch {
    return [issue(PrecheckCode.FrontmatterInvalid, 'SKILL.md 的 frontmatter 不是合法 YAML')]
  }
  const body = rest.slice(end + 4)

  const name = requireField(data, 'name', LIMITS.maxAppId)
  if ('issue' in name) out.push(name.issue)
  else if (!isAppId(name.value)) {
    out.push(issue(PrecheckCode.InvalidAppID,
      `技能名 "${name.value}" 不合法:必须是小写 kebab-case(如 my-skill)`, 'name'))
  } else if (name.value !== appId) {
    out.push(issue(PrecheckCode.IdentityMismatch,
      `SKILL.md 的 name("${name.value}")必须等于应用 ID("${appId}");中文展示名请写在 title`, 'name'))
  }

  const version = scalar(data.version)?.trim()
  if (version === undefined || version === '') {
    out.push(issue(PrecheckCode.MissingField, '缺少必填字段 version(如 1.0.0)', 'version'))
  } else if (!isVersion(version)) {
    out.push(issue(PrecheckCode.InvalidVersion,
      `version "${version}" 不是合法版本号:必须是 x.y.z;写成 1.0 请补足三段并加引号`, 'version'))
  }

  const title = requireField(data, 'title', LIMITS.maxTitle)
  if ('issue' in title) out.push(title.issue)

  const description = requireField(data, 'description', LIMITS.maxDescription)
  if ('issue' in description) out.push(description.issue)
  else if (runes(description.value) < LIMITS.minDescription) {
    out.push(issue(PrecheckCode.FieldTooShort,
      `description 过短(至少 ${LIMITS.minDescription} 字),它决定模型何时加载本技能`, 'description'))
  }

  const author = requireField(data, 'author', LIMITS.maxAuthor)
  if ('issue' in author) out.push(author.issue)
  const category = requireField(data, 'category', LIMITS.maxCategory)
  if ('issue' in category) out.push(category.issue)

  const tags = data.tags
  if (tags !== undefined && tags !== null) {
    if (!Array.isArray(tags)) out.push(issue(PrecheckCode.InvalidType, '字段 tags 必须是数组', 'tags'))
    else if (tags.length > LIMITS.maxTags) {
      out.push(issue(PrecheckCode.FieldTooLong, `标签过多(上限 ${LIMITS.maxTags} 个)`, 'tags'))
    } else {
      for (const tag of tags) {
        const text = scalar(tag)
        if (text === undefined) { out.push(issue(PrecheckCode.InvalidType, '标签必须是字符串', 'tags')); break }
        if (runes(text) > LIMITS.maxTagRunes) {
          out.push(issue(PrecheckCode.FieldTooLong, `标签 "${text}" 超长(上限 ${LIMITS.maxTagRunes} 字)`, 'tags'))
          break
        }
      }
    }
  }

  if (runes(body.trim()) < LIMITS.minBody) {
    out.push(issue(PrecheckCode.BodyEmpty,
      `技能正文过短(至少 ${LIMITS.minBody} 字):只有 frontmatter 的空壳技能对模型没有价值`))
  }

  for (const [legacy, canonical] of Object.entries(LEGACY_INVOCATION)) {
    if (Object.hasOwn(data, legacy)) {
      out.push(issue(PrecheckCode.InvocationInvalid,
        `frontmatter 字段 ${legacy} 已废弃,请改用 ${canonical}(保留旧键会让技能被运行时忽略)`, legacy))
    }
  }
  for (const key of ['disable-model-invocation', 'user-invocable']) {
    const raw = data[key]
    if (raw === undefined || raw === null || typeof raw === 'boolean') continue
    const text = scalar(raw)
    if (text === undefined || !BOOLEAN_LITERALS.has(text.trim().toLowerCase())) {
      out.push(issue(PrecheckCode.InvocationInvalid, `字段 ${key} 必须是布尔值(true/false)`, key))
    }
  }

  const metadata = data.metadata
  if (typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
    && Object.hasOwn(metadata as Record<string, unknown>, 'picoaide')) {
    out.push(issue(PrecheckCode.ProvenanceForbidden,
      'frontmatter 不得包含 metadata.picoaide:它由安装器写入,用于标记技能来源', 'metadata.picoaide'))
  }
  if (entries.some((e) => e.startsWith('.picoaide/'))) {
    out.push(issue(PrecheckCode.ProvenanceForbidden,
      '归档不得包含 .picoaide/ 目录:它由安装器写入,用于标记技能来源'))
  }
  return out
}
