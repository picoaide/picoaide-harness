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
 *   · 对账面是**整仓 `packages/`**（递归全扫），不是"某个登记项指名的那个文件"：任何 spec 里
 *     出现真跑 `mount --bind` 的调用、或用了挂载闸门，就必须逐条登记（未登记即红）；
 *   · 登记项指名的**用例名**必须逐字还在 spec 里（判据被删/改名就红）；
 *   · 每个 spec 里 {@link judgeMountGate} 与 {@link consumeMountGate} 的**调用点数**都必须
 *     等于该 spec 的登记条数（"绕过登记"与"忘了登记"是同一个口子）；
 *   · {@link judgeMountGate} 的语义有行为夹具（缺能力=如实自跳；声明了必须提供=硬红）；
 *   · **消费点也是可执行的**：`hardFailure` ⇒ 抛错（硬红）、缺省档 ⇒ 打出可检索的
 *     {@link MOUNT_SKIP_MARKER} 覆盖声明并返回 `mounted: false`。这两条以前只钉在 spec
 *     的文本上（删掉那两行消费代码门禁照样绿），现在由 {@link consumeMountGate} 一处实现，
 *     既被真实 spec 调用、又被行为夹具（用真探针结果驱动）判决 —— 删掉它就当场红。
 * 缺能力时那条判据还会在 CI 日志里打一行**覆盖声明**（见 `env-gated-criteria.spec.ts`）：
 * 门禁绿不再等于"挂载点判据通过"。
 *
 * ## 有权限的环境怎么跑
 *
 * 见 {@link EnvGatedCriterion.privilegedCommand}。把 `requiredEnv` 置成 `required`
 * （如 `PICOAI_MOUNT_TESTS=required`）时，缺能力**不再自跳而是硬红** —— 防"以为在测、
 * 其实一直在跳过"。缺省（不设该变量）保持"如实自跳"，因为无特权 runner 上硬红等于
 * 让整条门禁红在没有权限的机器上。
 *
 * ### 覆盖状态的**诚实台账**（2026-10-13 独立审计 P2-3）
 *
 * 本登记表**没有**为特权路径接上自动化执行者：`.github/workflows/` 里没有任何 job 设
 * `PICOAI_MOUNT_TESTS`，所以 GitHub 托管 runner（非 root）上 G1/G2/K-08 **一次都不执行**。
 * 这不是"忘了接"——是被显式认账的未覆盖项，理由与处置写在
 * `docs/decisions/2026-10-13-env-gated-mount-criteria.md`：托管 runner 上"能不能拿到
 * `CAP_SYS_ADMIN`"在本机无法实测，而把一个未经验证的 `sudo`/`setpriv` 步骤直接放进
 * 每次 PR 都跑的 `gate` job，赌错就是**全仓门禁永久变红**，代价大于收益。
 *
 * 因此本表能保证的是"自跳不可能被误读成通过"（覆盖声明 + 可检索标记 + 可按需硬红），
 * **不能**保证"这几条判据被执行过"。读到 CI 日志里的覆盖声明时，请按
 * {@link EnvGatedCriterion.privilegedCommand} 在有权限的机器上真跑一遍。
 */

/** 无能力时打印的**覆盖声明**标记（CI 日志里可检索；判据侧要求它必须出现）。 */
export const MOUNT_SKIP_MARKER = '[env-gated:mount/SKIP]'

/** 声明"本环境必须提供 `mount --bind`"的环境变量；取值见 {@link MOUNT_REQUIRED_VALUE}。 */
export const MOUNT_REQUIRED_ENV = 'PICOAI_MOUNT_TESTS'

/** {@link MOUNT_REQUIRED_ENV} 的"必须提供"取值（其余取值/未设 = 允许如实自跳）。 */
export const MOUNT_REQUIRED_VALUE = 'required'

/**
 * 登记表**自己的对账面**（`tests/env-gated-criteria.spec.ts`）。
 *
 * 它也被全扫面命中（`probeBindMount` 真跑一次 `mount --bind`），但它跑的是**量具**
 * 而不是受限判据：探针失败时它照样把语义判完，绝不"因为没权限就不判"。
 * 它是全扫面里**唯一**允许不登记的 spec —— 豁免是这一个具名常量，不是"扫描面只到
 * 某个登记项指名的文件"那种隐式收窄。
 */
export const REGISTRY_SELF_SPEC = 'env-gated-criteria.spec.ts'

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
  /**
   * 判据所在 spec。相对 `tests/` 解析（POSIX 分隔符）；跨包的判据用 `../` 相对路径登记
   * ——对账面按**绝对路径**对账（扫描面 = 整仓 `packages/`），两种写法都在面内。
   */
  spec: string
  /** 该 spec 里必须**逐字**存在的用例名（判据被删/改名 ⇒ 登记项失配 ⇒ 红）。 */
  titles: string[]
  /** 前置能力（人话）。 */
  precondition: string
  /** 声明"必须提供该能力"的环境变量名；置为 `required` 时缺能力 = 硬红。 */
  requiredEnv: string
  /**
   * 该 spec 里必须**逐字**存在的、证明"跳过带的是**真实原因**"的表达式。大小写敏感。
   *
   * 2026-10-13 审计 P2-2 后口径变了：原因**怎么用**（打标记、拼覆盖声明）由
   * {@link consumeMountGate} 一处实现，所以这个 token 现在钉的是 spec 侧的**取证动作**
   * ——`stderr`（探针把子进程的真实 stderr 读出来），而不是"某处引用了 `.reason`"。
   * 光有 token 当然不够，真实原因确实进了日志这一条由行为夹具判。
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
    reasonToken: 'stderr',
    why: '挂载点在 `lstat` 下就是**真实目录**、`realpath` 也原样返回 ⇒ 只有挂载表与 `st_dev` 认得出来。'
      + '换成夹具（伪造挂载表 / mock `lstat`）等于把判据换成它自己要验的那份假设：'
      + '这两条要证的正是"真实 mount 会被拒绝、库外唯一副本不被删"，只能靠真实 `mount --bind`。',
    privilegedCommand: 'cd packages/host/enterprise && PICOAI_MOUNT_TESTS=required '
      + './node_modules/.bin/vitest run tests/skill-library-anchor-escape.spec.ts',
  },
  {
    // 2026-10-13 独立审计 P1：同包还有**第三条**真 mount 判据，此前既没登记、也不读
    // `PICOAI_MOUNT_TESTS` —— 只扫"登记项指名的那个 spec"的对账面看不见它，整块删掉
    // 也照样绿（变异 M6 实测 3 passed EXIT=0）。现在它在面内。
    id: 'audit-r20-skill-library/cross-device',
    spec: 'audit-r20-skill-library.spec.ts',
    titles: [
      '跨设备（真 bind mount，需 CAP_SYS_ADMIN）：成因点名"另一个设备"；无权限时如实跳过',
    ],
    precondition: MOUNT_PRECONDITION,
    requiredEnv: MOUNT_REQUIRED_ENV,
    reasonToken: 'stderr',
    why: '"成因是另一个设备"是 `st_dev` 的**内核事实**：`/dev/shm`（tmpfs）与 `tmpdir()`（ext4）'
      + '天然不同设备，而只有真 bind mount 才能让 `.skill-tmp` 变成"库内路径、库外设备"。'
      + '伪造 `st_dev`/mock `lstat` 等于把判据换成它要验的那份假设 —— 这里要证的正是'
      + '"真实跨设备挂载被点名（不是被笼统读成符号链接）"。',
    privilegedCommand: 'cd packages/host/enterprise && PICOAI_MOUNT_TESTS=required '
      + './node_modules/.bin/vitest run tests/audit-r20-skill-library.spec.ts',
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

/** {@link consumeMountGate} 的返回：判据**是否真的执行**。 */
export interface MountGateUse {
  /** `true` = 能力可用，判据走真实路径；`false` = 已如实自跳（调用方必须 `return`）。 */
  mounted: boolean
  /** 自跳时打进日志的那一行（含 {@link MOUNT_SKIP_MARKER} 与真实原因）；执行时为 `undefined`。 */
  skipLine?: string
}

/** 登记表里绑定到某个环境变量的**跑法**（去重；覆盖声明要把"怎么真跑"一起带出来）。 */
function privilegedCommandsFor(requiredEnv: string): string[] {
  return [...new Set(
    ENV_GATED_CRITERIA.filter(entry => entry.requiredEnv === requiredEnv).map(entry => entry.privilegedCommand),
  )]
}

/**
 * **消费**一份闸门判定 —— 环境受限判据唯一允许的收尾方式（2026-10-13 审计 P2-2）。
 *
 * ## 为什么要有这个函数（而不是让每个 spec 自己写两行 `if`）
 *
 * "自跳不可与通过混淆"靠的是两个**执行点**：声明了必须提供时**硬红**、缺省时**打出
 * 可检索的覆盖声明**。此前这两行散在各个 spec 里，判据侧只能用 `toContain` 数文本
 * ⇒ 把两行消费代码整段删掉，门禁**照样全绿**（审计变异 M5/M7 实测 13 passed EXIT=0）。
 * 文本面钉不住执行点：把它们提成这一个函数之后，函数被**真实 spec** 调用、又被行为
 * 夹具（用真探针结果驱动）判决 —— 删掉抛错或删掉打标记，夹具当场红。
 *
 * ## 三档（与 {@link judgeMountGate} 一一对应）
 *
 *   · `hardFailure` 非空 ⇒ **抛错**（不是返回一个没人看的字段）：那种环境下"跳过"不是
 *     可接受的结论，判据必须红。
 *   · `mounted` ⇒ `{ mounted: true }`，不打任何标记。
 *   · 否则 ⇒ 打**一行**含 {@link MOUNT_SKIP_MARKER}、真实原因与**跑法**的覆盖声明，
 *     返回 `{ mounted: false, skipLine }`；调用方据此 `return`。
 *
 * 探针失败却**没有原因**时抛错：`{ ok: false, reason: '' }` 意味着"跳过"又要退回静默
 * 那条路，而这正是本登记表存在的理由。
 * @param verdict - {@link judgeMountGate} 的判定。
 * @param attempt - 同一次探针的结果（自跳行要带它的真实 `reason`）。
 * @param context - 人话定位（用例名/组名；出现在硬红消息与覆盖声明里）。
 * @param log - 日志出口（缺省 `console.log`；夹具注入自己的出口取证据）。
 * @returns 见 {@link MountGateUse}。
 */
export function consumeMountGate(
  verdict: MountGateVerdict,
  attempt: MountAttempt,
  context: string,
  log: (message: string) => void = (message) => { console.log(message) },
): MountGateUse {
  if (verdict.hardFailure !== undefined) {
    throw new Error(`[env-gated] ${context}：${verdict.hardFailure}`)
  }
  if (verdict.mounted) return { mounted: true }
  const reason = attempt.reason.trim()
  if (reason === '') {
    throw new Error(
      `[env-gated] ${context}：\`mount --bind\` 判定为失败，但探针没有给出**真实原因** ——`
      + ' 自跳不得退回静默那条路（原因取自子进程 stderr 或 Error.message）。',
    )
  }
  const commands = privilegedCommandsFor(MOUNT_REQUIRED_ENV)
  const skipLine = `${MOUNT_SKIP_MARKER} ${context} 本环境无法建立 bind mount —— ${reason}`
    + `（本环境覆盖**不成立**：这条判据没有执行；真跑见登记表 ${commands.join(' / ')}）`
  log(skipLine)
  return { mounted: false, skipLine }
}

