/**
 * **环境受限判据的登记表**（唯一真源）+ 缺能力时的闸门判定。
 *
 * ## 为什么需要它
 *
 * 本包有判据的前置条件是**内核能力**而不是代码：R19A-S2-03 的挂载点保护要求
 * `mount --bind`（Linux + `CAP_SYS_ADMIN`），无特权 runner（CI 的 gate job 就是）
 * 拿不到 ⇒ 判据**自跳**。而自跳与通过在门禁输出里同为绿，极易被读成"这条判据咬到了"：
 * 2026-10-13 的独立审计记下的就是这个形态 —— `skill-library-anchor-escape.spec.ts`
 * 的 G1/G2 在 CI 上一次都没执行，而 `CI 全绿` 被当成覆盖。
 *
 * 所以把"哪几条受限、前置是什么、为什么不能换成夹具、有权限时怎么跑"写成**数据**，
 * 由 `tests/env-gated-criteria.spec.ts`（跑在 `yarn check` 的同一套件里）逐项对账：
 *   · 登记项指名的**用例名**必须逐字还在 spec 里（判据被删/改名就红）；
 *   · spec 里 {@link judgeMountGate} 的**调用点数**必须等于登记条数（新加一条未登记的
 *     受限判据就红 —— "绕过登记"与"忘了登记"是同一个口子）；
 *   · 自跳必须打登记的 {@link MOUNT_SKIP_MARKER} **并带上真实原因**（跳过不是静默的一条路）；
 *   · {@link judgeMountGate} 的语义有行为夹具（缺能力=如实自跳；声明了必须提供=硬红）。
 * 缺能力时那条判据还会在 CI 日志里打一行**覆盖声明**（见 `env-gated-criteria.spec.ts`）：
 * 门禁绿不再等于"挂载点判据通过"。
 *
 * ## 有权限的环境怎么跑
 *
 * 见 {@link EnvGatedCriterion.privilegedCommand}。把 `requiredEnv` 置成 `required`
 * （如 `PICOAI_MOUNT_TESTS=required`）时，缺能力**不再自跳而是硬红** —— 防"以为在测、
 * 其实一直在跳过"。缺省（不设该变量）保持"如实自跳"，因为无特权 runner 上硬红等于
 * 让整条门禁红在没有权限的机器上。
 */

/** 无能力时打印的**覆盖声明**标记（CI 日志里可检索；判据侧要求它必须出现）。 */
export const MOUNT_SKIP_MARKER = '[env-gated:mount/SKIP]'

/** 声明"本环境必须提供 `mount --bind`"的环境变量；取值见 {@link MOUNT_REQUIRED_VALUE}。 */
export const MOUNT_REQUIRED_ENV = 'PICOAI_MOUNT_TESTS'

/** {@link MOUNT_REQUIRED_ENV} 的"必须提供"取值（其余取值/未设 = 允许如实自跳）。 */
export const MOUNT_REQUIRED_VALUE = 'required'

/** 挂载点判据的前置能力（人话；登记表与硬红消息共用同一份措辞）。 */
export const MOUNT_PRECONDITION = 'Linux 内核 + CAP_SYS_ADMIN（`mount --bind`；非特权容器/runner 没有）'

/**
 * 一条**环境受限判据**的登记项。
 *
 * 字段全部是"判据侧可机检"的：{@link EnvGatedCriterion.spec} 与
 * {@link EnvGatedCriterion.titles} 对账"判据本体还在不在"，
 * {@link EnvGatedCriterion.requiredEnv} 对账"登记的环境变量就是闸门读的那个"。
 */
export interface EnvGatedCriterion {
  /** 稳定 id（`<spec 去后缀>/<组名>`），登记项唯一键。 */
  id: string
  /** 判据所在 spec（相对 `tests/` 的路径，POSIX 分隔符）。 */
  spec: string
  /** 该 spec 里必须**逐字**存在的用例名（判据被删/改名 ⇒ 登记项失配 ⇒ 红）。 */
  titles: string[]
  /** 前置能力（人话）。 */
  precondition: string
  /** 声明"必须提供该能力"的环境变量名；置为 `required` 时缺能力 = 硬红。 */
  requiredEnv: string
  /**
   * 该 spec 里必须**逐字**存在的"真实原因"表达式（自跳要把探针的 stderr 带出来，
   * 而不是只写一句"跳过"）。大小写敏感 —— 逐字对账。
   */
  reasonToken: string
  /** 为什么它不在缺省门禁的覆盖里（**必须**回答"为什么不换成夹具"）。 */
  why: string
  /** 有权限环境下的跑法（必须指名 {@link EnvGatedCriterion.spec}）。 */
  privilegedCommand: string
}

/**
 * 登记表本体。
 *
 * **新增一条环境受限判据 = 在这里加一条**（判据侧的调用点数对账会让"没登记"当场红）。
 */
export const ENV_GATED_CRITERIA: EnvGatedCriterion[] = [
  {
    id: 'skill-library-anchor-escape/mount-point',
    spec: 'skill-library-anchor-escape.spec.ts',
    titles: [
      'G1 换入自愈：`.skill-tmp/install-x` 是库外目录的 bind mount',
      'G2 陈旧 staging 清扫：条目本身是挂载点 ⇒ 拒绝清扫且留痕',
    ],
    precondition: MOUNT_PRECONDITION,
    requiredEnv: MOUNT_REQUIRED_ENV,
    reasonToken: 'mountAttempt.reason',
    why: '挂载点在 `lstat` 下就是**真实目录**、`realpath` 也原样返回 ⇒ 只有挂载表与 `st_dev` 认得出来。'
      + '换成夹具（伪造挂载表 / mock `lstat`）等于把判据换成它自己要验的那份假设：'
      + '这两条要证的正是"真实 mount 会被拒绝、库外唯一副本不被删"，只能靠真实 `mount --bind`。',
    privilegedCommand: 'cd packages/host/enterprise && PICOAI_MOUNT_TESTS=required '
      + './node_modules/.bin/vitest run tests/skill-library-anchor-escape.spec.ts',
  },
]

/** `mount --bind` 探针的结果（`{ ok, reason }`；reason 只在失败时有意义）。 */
export interface MountAttempt {
  /** 是否成功建立 bind mount。 */
  ok: boolean
  /** 失败原因（**真实** stderr，不是猜的）。 */
  reason: string
}

/** {@link judgeMountGate} 的判定。 */
export interface MountGateVerdict {
  /** 本环境的 `mount --bind` 是否可用（决定判据走真实路径还是自跳）。 */
  mounted: boolean
  /** 环境是否**声明**"必须提供该能力"（{@link MOUNT_REQUIRED_ENV} = `required`）。 */
  required: boolean
  /** 非 `undefined` = **必须硬红**（声明了必须提供，实际却拿不到）。 */
  hardFailure?: string
}

/**
 * 缺能力时的闸门判定（纯函数：探针结果与环境都从外面给 ⇒ 判据侧可以逐档做行为夹具）。
 *
 * 三档语义（缺一档都会让"在测"与"跳过"不可区分）：
 *   · 能力可用 ⇒ `mounted: true`，判据走真实路径；
 *   · 能力不可用 + 未声明必须提供 ⇒ `mounted: false` 且**无** `hardFailure`：
 *     调用方**必须**打 {@link MOUNT_SKIP_MARKER} + 真实原因（如实自跳，不是静默）；
 *   · 能力不可用 + 声明了必须提供 ⇒ `hardFailure` 是给人看的硬红理由 —— 那种环境下
 *     "跳过"是不可接受的结论。
 * @param attempt - bind mount 探针结果（真实 stderr 在 `reason` 里）。
 * @param env - 环境变量（判据侧注入；缺省 `process.env`）。
 * @returns 判定（见 {@link MountGateVerdict}）。
 */
export function judgeMountGate(
  attempt: MountAttempt,
  env: Record<string, string | undefined> = process.env,
): MountGateVerdict {
  const required = env[MOUNT_REQUIRED_ENV] === MOUNT_REQUIRED_VALUE
  if (attempt.ok) return { mounted: true, required }
  if (!required) return { mounted: false, required }
  return {
    mounted: false,
    required: true,
    hardFailure: `本环境声明必须提供「${MOUNT_PRECONDITION}」（${MOUNT_REQUIRED_ENV}=${MOUNT_REQUIRED_VALUE}），`
      + `但 \`mount --bind\` 失败：${attempt.reason}`
      + ' —— 要么给足权限，要么去掉这个环境变量（缺省形态是"如实自跳 + 打覆盖声明"）。',
  }
}
