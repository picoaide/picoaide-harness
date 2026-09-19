/**
 * 访问级别的**唯一前端口径**（2026-09-19 WASM「客户端专属」改造；契约 §3 F14 / §4.4
 * 不变量 I6 / §9 迁移 / §19 Q13）。
 *
 * 为什么必须收敛成一份实现：这一页上说错一句话，管理员就会以为"匿名还能访问"或
 * 反过来"历史应用的数据丢了"。三件事只允许一处真源：
 *   ① **可写值 = `login | whitelist` 两值**。服务端权威是
 *      `server/internal/wasmapp/appcfg` 的 `AccessWritableValues`（写侧 `WritableAccess`
 *      拒绝 `public`）；前端镜像它，免得管理员在界面上点出一个注定 400 的值。
 *   ② **历史值 `public` 的展示文案**。存量行（迁移 0074 之前写下的 picoaide.app.json）
 *      读出来仍可能是 `public`：它既不能再显示成"公开"（那会让管理员以为匿名仍可达），
 *      也不能显示裸 `public`（读不懂），更不能**从界面上抹掉** —— 抹掉等于让这些应用
 *      看起来"没有访问级别"，历史数据就真的丢了。统一渲染成「已退役（历史值）」，
 *      并把"服务端按 login 执行"写进悬浮说明。
 *   ③ **筛选匹配**。`login` 必须命中历史 `public` 行（服务端读侧把 public 当 login
 *      执行，契约 §9 第 0074 条）—— 这样"筛出历史 public"（§19 Q13）才成立，而筛选器
 *      本身仍然只有两值可选（`public` 不是可写值，不进选项）。
 *
 * 边界：前端只是**体验层**。真正的写侧拒绝在服务端（appcfg.WritableAccess +
 * APP_CONFIG_INVALID），这里收紧选项与文案是为了不误导人，不是安全边界。
 */

/** 登录后全员（契约里唯一的两值之一）。 */
export const ACCESS_LOGIN = 'login'
/** 白名单（名单由应用自判，平台只注入身份）。 */
export const ACCESS_WHITELIST = 'whitelist'
/**
 * 历史值：匿名公开。**已退役** —— 写侧拒绝、读侧按 `login` 执行。
 *
 * 保留这个常量是**有意**的：筛选、文案与"非法取值"提示都要能点名它，
 * 否则界面上无法解释"为什么我库里有一条 public"。
 */
export const ACCESS_LEGACY_PUBLIC = 'public'

/**
 * 可写访问级别 = **两值**（顺序即文档顺序）。
 *
 * 变异验证：往这里加回 `ACCESS_LEGACY_PUBLIC`（或任何第三值），
 * `access-level.test.ts` 的「只剩两值」用例必红。
 */
export const WRITABLE_ACCESS_LEVELS: readonly string[] = [ACCESS_LOGIN, ACCESS_WHITELIST]

/** 可写值的中文标签（界面文案唯一真源）。 */
export const ACCESS_LEVEL_LABELS: Record<string, string> = {
  [ACCESS_LOGIN]: '登录后全员',
  [ACCESS_WHITELIST]: '白名单',
}

/**
 * 历史值在界面上的唯一文案。
 *
 * 明确写"已退役"而不是"公开/登录"：它**不是**一个当前生效的访问级别，
 * 而是一个需要被收敛的存量值。
 */
export const LEGACY_ACCESS_LABEL = '已退役（历史值）'

/** 历史值的完整解释（badge 的 title / 公告模板 / 校验消息共用）。 */
export const LEGACY_ACCESS_EXPLAIN =
  '历史值 public：匿名公开已废除，服务端按「登录后全员」执行；不能再作为访问级别选择。'

export type AccessVariant = 'success' | 'secondary' | 'outline'

export interface AccessMeta {
  /** 界面文案。 */
  label: string
  variant: AccessVariant
  /** 是否历史（已退役）值。 */
  legacy: boolean
  /** 是否属于可写两值（false ⇒ 表单/筛选不得提供这个取值）。 */
  writable: boolean
  /** 悬浮/读屏解释（legacy 行必给；其它值不给）。 */
  title?: string
}

/** 是否是可写访问级别（两值之一）。 */
export function isWritableAccessLevel(value: string): boolean {
  return WRITABLE_ACCESS_LEVELS.includes(value)
}

/**
 * 访问级别的展示元数据（**未知值不静默吞掉**：原样回显，方便服务端加新枚举时页面仍可读）。
 *
 * 历史 `public` 是唯一特例（见文件头 ②）。
 */
export function accessMeta(access: string): AccessMeta {
  if (access === ACCESS_LEGACY_PUBLIC) {
    return {
      label: LEGACY_ACCESS_LABEL,
      variant: 'secondary',
      legacy: true,
      writable: false,
      title: LEGACY_ACCESS_EXPLAIN,
    }
  }
  const label = ACCESS_LEVEL_LABELS[access]
  if (label !== undefined) {
    return {
      label,
      variant: access === ACCESS_LOGIN ? 'secondary' : 'outline',
      legacy: false,
      writable: true,
    }
  }
  return { label: access || '未知', variant: 'outline', legacy: false, writable: false }
}

/**
 * 写侧校验消息（**唯一一份**，两值口径）。
 *
 * 两个真实出口：①旧书签/深链把 `?access=public` 带进来时，页面必须**明说**
 * 为什么这个值不能用、以及历史行去哪里找（不能静默当成"全部"）；
 * ②公告模板里的口径说明。
 */
export function accessLevelRejectionMessage(value: string): string {
  const two = `${ACCESS_LOGIN}（${ACCESS_LEVEL_LABELS[ACCESS_LOGIN]}）或 ${ACCESS_WHITELIST}（${ACCESS_LEVEL_LABELS[ACCESS_WHITELIST]}）`
  if (value === ACCESS_LEGACY_PUBLIC) {
    return `访问级别只接受 ${two} 两值；public（匿名公开）已退役，不能再选。`
      + `存量行的 public 已按「${ACCESS_LEVEL_LABELS[ACCESS_LOGIN]}」执行，用该筛选值即可筛出。`
  }
  return `访问级别只接受 ${two} 两值；「${value}」不是合法取值。`
}

/** 筛选器里的「全部」取值（不是访问级别本身）。 */
export const ACCESS_FILTER_ALL = 'all'

export interface AccessFilterOption {
  value: string
  label: string
  /** 附加说明（渲染成选项后的浅色小字/悬浮说明）。 */
  hint?: string
}

/**
 * 访问级别筛选选项：**只有两值 + 全部**。
 *
 * `public` 刻意不进选项（它不是可选的访问级别）；历史行由 `login` 命中，
 * 选项文案里明说这一点，免得管理员以为"筛不出历史数据 = 数据没了"。
 */
export const ACCESS_FILTERS: AccessFilterOption[] = [
  { value: ACCESS_FILTER_ALL, label: '全部访问级别' },
  {
    value: ACCESS_LOGIN,
    label: ACCESS_LEVEL_LABELS[ACCESS_LOGIN],
    hint: '含历史已退役值 public',
  },
  { value: ACCESS_WHITELIST, label: ACCESS_LEVEL_LABELS[ACCESS_WHITELIST] },
]

/** 筛选值是否合法（非法值不能静默降级成"全部"）。 */
export function isAccessFilterValue(value: string): boolean {
  return ACCESS_FILTERS.some((f) => f.value === value)
}

/**
 * 筛选匹配（与服务端读侧同口径）。
 *
 * `login` **必须**命中历史 `public`：服务端读侧把 public 当 login 执行，
 * 若筛选只认字面值，存量行就永远筛不出来 —— 那正是 §19 Q13 要修的问题
 * （"历史 public 无运营动作"）。
 *
 * 变异验证：把 `login` 分支里的 `|| access === ACCESS_LEGACY_PUBLIC` 去掉，
 * `access-level.test.ts` 的「login 命中历史 public」用例必红。
 */
export function matchesAccessFilter(access: string, filter: string): boolean {
  if (filter === '' || filter === ACCESS_FILTER_ALL) return true
  if (filter === ACCESS_LOGIN) return access === ACCESS_LOGIN || access === ACCESS_LEGACY_PUBLIC
  return access === filter
}
