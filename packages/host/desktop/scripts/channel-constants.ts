/**
 * 渠道化打包的**零依赖常量**：交付面平台清单、**功能模块声明**（`features`）与渠道素材文件名。
 *
 * `features` 那一族（{@link FEATURE_MODULES} / {@link normalizeChannelFeatures} /
 * {@link channelFeaturesVariant} / {@link featureSentinel}）是"渠道声明功能模块"的
 * **唯一真源**：校验层（`scripts/ci-channels.sh`）、构建期取值（`scripts/channel-build.ts`）
 * 与门禁（`scripts/verify-ci-scripts.mjs`）都从这里派生。契约见
 * `docs/decisions/2026-10-13-channel-feature-modules.md`。
 *
 * 为什么单独一个文件（2026-09-28 一次真实 tag 事故的收口）：
 * 这两份清单此前直接写在 `scripts/channel-build.ts` 里，而那个模块**顶端** import 了
 * `../src/desktop-home.ts`（后者 `export * from '@picoaide/dsh-host-home'`，一个需要
 * `node_modules` 链接 + 构建产物才能解析的工作区包）。于是三个 shell 侧探针
 * （`scripts/ci-channels.sh`、`scripts/ci-channel-transfer.sh`、
 * `scripts/ci-build-channel-images.sh`，它们用 `import(file://…/channel-build.ts)` 读这些常量）
 * **只在装了依赖、且工作区已构建的环境里能跑** —— Gate 与三个打包 job 都是这种环境，
 * 所以 PR/分支 CI 全绿；而 **release job 只 checkout、不 install 也不 build**
 * ⇒ `v2.8.2-beta.2` 的 tag 流水线红在 "Fetch channel packages"：
 * `Cannot find package '@picoaide/dsh-host-home' imported from …/src/desktop-home.ts`。
 * tag 之前没有任何 CI 能看到这一格（`release` job 只在 tag 上跑）。
 *
 * **不变量（改这个文件前先读）**：本文件必须**零 import**（相对、绝对、bare 一律不许）。
 * 它是"任何环境都能读到这两份清单"的基石；一旦有人在这里 import 了别的东西，
 * 三个探针就会重新依赖依赖树/构建产物，tag 事故会以同样的方式复发。
 * `tests/channel-constants.spec.ts` 钉住这条（含"三个探针都指向本文件"的接线判据）。
 *
 * `channel-build.ts` 仍然 re-export 这两个常量（打包链路的既有 import 面不变）。
 *
 * @module dsh-plugin-desktop/scripts/channel-constants
 */

/**
 * 客户端**三平台交付面**（清单键 → 产物通配 → 人读标签 → 渠道配置 token）——唯一真源。
 *
 * 四个消费方必须从这一份派生（各写一遍就是四个口径，一边少一个平台就会**静默少发**）：
 *   - `scripts/ci-build-channel-images.sh`：镜像内的 `CLIENT-RELEASE.json` 逐平台必需；
 *   - `scripts/ci-channel-transfer.sh`：R2 中转取回后逐平台判「齐全」；
 *   - `scripts/ci-channels.sh`：校验渠道配置 `desktop.platforms` 的取值集合；
 *   - `scripts/verify-ci-scripts.mjs`：与 `.github/workflows/ci.yml` 三个平台 job 的
 *     `--patterns` 对拍（发布链与交付面必须同形）。
 *
 * 键名的权威源是运行期读清单的 `src/desktop-release.ts`（`PLATFORM_ASSET_KEYS`：
 * `darwin/win32/linux → mac-universal/win-x64/linux-x64`）；通配逐字等于 CI 三个
 * 平台 job 归集产物用的 `--patterns`（mac = `*.dmg`、win = `*Setup*.exe`、
 * linux = `*.AppImage`）。2026-09-26 审计 Z3-2 的形态正是「少一个平台没有任何信号」：
 * 旧实现逐个 `[ -f … ] || return 0`，缺平台时生成的清单只是少一个键。
 *
 * `platform`（2026-10-13 新增）是渠道配置 `desktop.platforms` 里用的 token：渠道可以只
 * 声明自己实际交付的平台（销售侧常态是 Windows + macOS，Linux 包常年没人下载却占
 * ~350MB/版本），打包、镜像装配、R2 中转、门户下载区与更新清单**一起**按它收窄。
 * **不写 `desktop.platforms` = 三端全要**（向后兼容：既有渠道行为逐字节不变）。
 */
export const CLIENT_PLATFORM_ASSETS = [
  { key: 'mac-universal', glob: '*.dmg', label: 'macOS(.dmg)', platform: 'mac' },
  { key: 'win-x64', glob: '*Setup*.exe', label: 'Windows(Setup.exe)', platform: 'win' },
  { key: 'linux-x64', glob: '*.AppImage', label: 'Linux(AppImage)', platform: 'linux' },
] as const

/**
 * `desktop.platforms` 的合法 token（顺序 = 上面交付面的顺序）——唯一真源。
 *
 * 消费方：`scripts/ci-channels.sh`（形状/取值校验）、构建期与运行期两侧的"本渠道是否
 * 交付这个平台"判定。**不要**在别处再写一份字面量：三处各写一遍就会漂移成"校验放行、
 * 装配却拒绝"这种半通状态。
 */
export const CHANNEL_PLATFORMS = ['mac', 'win', 'linux'] as const

/**
 * 官方渠道**必须逐键显式声明**的配置键（点分路径）——「官方渠道 = 新增渠道的模板」。
 *
 * 为什么（2026-10-13 用户定案）：后续新增渠道的动作是"拷贝官方目录 → 改身份字段 →
 * 裁剪交付面"。只要官方渠道的配置里**缺键**，那几个键就藏在代码兜底值里 —— 复制出来
 * 的渠道会带着看不见的继承行为（少写 slug 就回落厂商包名、少写 home_dir 就共用数据根），
 * 而且要翻源码才知道有哪些键存在。所以官方渠道的 channel.json 必须是一份**完整清单**，
 * 值等于现行兜底值（因此显式化本身不改变任何行为）。
 *
 * 判据形态：`scripts/ci-channels.sh --require-template`（CI 的取渠道包步骤带上它）逐键
 * 检查**官方**渠道；缺任一键即 fail-loud 并点名键名。合成夹具不带这个旗标，所以局部
 * 夹具不需要构造完整模板（判据形态 = 生产形态：CI 调用点必须真的带旗标，由
 * `scripts/verify-ci-scripts.mjs` 的接线判据钉住）。
 *
 * **刻意不在表里的键**：`desktop.speech_model_dir` / `desktop.speech_vad_path` /
 * `desktop.speech_model_origin` —— 它们是"**覆盖**型"：不写 = 用随包模型（现行为），
 * 写了就把路径钉成硬编码（各平台布局还不同）。写进模板等于把"随包默认"固定死，
 * 反而更脆。它们在文档里单列为可选覆盖项。
 */
export const CHANNEL_TEMPLATE_KEYS = [
  'schema',
  'channel_id',
  'meta.description',
  'meta.updated',
  'identity.display_name',
  'identity.short_name',
  'identity.tagline',
  'identity.title',
  'copy.login_display_name',
  'copy.login_tagline',
  'copy.login_welcome',
  'copy.client_display_name',
  'copy.client_tagline',
  'copy.portal_welcome',
  'assets.logo',
  'assets.logo_dark',
  'assets.favicon',
  'assets.accent',
  'defaults.server_url',
  'defaults.telemetry_channel',
  'desktop.product_name',
  'desktop.slug',
  'desktop.app_id',
  'desktop.home_dir',
  'desktop.deep_link_scheme',
  'desktop.app_origin_scheme',
  'desktop.platforms',
  // 功能模块声明（2026-10-13）。**刻意逐模块列叶键**、不写裸 `features`：
  // 只要对象存在就满足裸键，于是 `"features": {}` 能通过模板判据 —— 而拷贝这份模板的
  // 新渠道会**看不到有哪些模块可关**，正是这张表要防的形态（"藏在代码兜底值里"）。
  // 叶键把"官方渠道 = 完整模板"这条语义落成可判的事实：新增模块时这里跟着加一行。
  //
  // **往这张表里加键 = 跨仓动作**（2026-10-13 独立审计 P0）：`--require-template` 的三个
  // 调用点是**非 tag** 的打包 job（每次非 docs-only 的 PR/push 都跑），所以"harness 先合并、
  // 私有渠道仓随后补官方渠道的键"这段窗口里 master 会一路红，而 tag 期的 gate 拦不住它。
  // 正确顺序：**私有仓先补键 → 再合并引入新键的 harness 改动**（补键对合并前的 harness
  // 无害）。决策记录 §4 有完整说明。
  'features.skills',
  'features.apps',
  'features.connectors',
] as const


/**
 * 渠道可以**声明**的功能模块 —— 唯一真源（`channel.json` 的 `features` 键）。
 *
 * 语义（2026-10-13 定案，契约见 `docs/decisions/2026-10-13-channel-feature-modules.md`）：
 *   - **缺省全开**：不写 `features` = 三个模块都要 —— 基础功能恒开，既有渠道逐字节不变；
 *   - 写了的键才可能关掉，**只能关掉自己声明的那个模块**（没有"全关"的语法糖：
 *     那会让"忘了写"与"故意关"长得一样）。
 *
 * 顺序是**契约的一部分**：`channelFeaturesVariant()` 按这里的顺序拼变体标识，
 * `none` 只在三个都关时出现。
 *
 * 消费方（新增第四个之前先想清楚"为什么不是从这一份派生"）：
 *   - `scripts/ci-channels.sh`：校验 `features` 的形状/取值（键集合取自本清单）；
 *   - `scripts/channel-build.ts`：构建期取值 → 变体标识 → 随包 `build/channel.json`；
 *   - `scripts/verify-ci-scripts.mjs`：正/负例与变异证明。
 */
export const FEATURE_MODULES = ['skills', 'apps', 'connectors'] as const

/** 一个功能模块名（{@link FEATURE_MODULES} 的成员）。 */
export type FeatureModule = (typeof FEATURE_MODULES)[number]

/** 规范化后的功能开关（三个键**全在**，取值一律是布尔）。 */
export type ChannelFeatures = Readonly<Record<FeatureModule, boolean>>

/**
 * `features` 不是合法形状时抛这个（未知模块名 / 非布尔取值 / 不是对象）。
 *
 * 为什么是**抛错**而不是"忽略坏键、其余照旧"：`features` 是**裁剪交付面**的声明 ——
 * 静默忽略一个拼错的键，方向永远是"多交付一个模块"（客户拿到他明确不想发的东西），
 * 而且从配置上完全看不出来。误读的另一侧（把 `"false"` 当 true）同理：字符串
 * `"false"` 在 JS 里是真值，按"忽略非布尔"处理就是**开着**，与写配置的人的意图
 * 正好相反。所以这里 fail-loud，由校验层给出可执行的报错。
 *
 * `problems` 只放**字段路径与原因**：未知键名一律不回报（键名可能本身就是渠道/
 * 品牌标识，而这条报错会进公开 CI 日志 —— 与 `ci-channels.sh` 的素材键纪律同一口径）。
 */
export class ChannelFeaturesError extends Error {
  /** 逐条问题（字段路径 + 原因；不含任何取值与未知键名）。 */
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(`channel.json 的 features 非法：${problems.join('；')}`)
    this.name = 'ChannelFeaturesError'
    this.problems = problems
  }
}

/** 是不是"普通对象"（数组/`null`/标量都不算）。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 把 `channel.json` 的 `features` 规范化成**三个键全在**的布尔表 —— 唯一真源。
 *
 * 规则（`undefined` 是唯一合法的"缺省"）：
 *   - `undefined`（没写这个键）⇒ 三个模块**全开**（基础功能恒开，向后兼容）；
 *   - 不是对象（`null` / 数组 / 字符串 / 数字…）⇒ 抛 {@link ChannelFeaturesError}；
 *   - 未知键 ⇒ 抛（不静默吞掉；报**数量**与合法集合，不回报键名）；
 *   - 已知键的取值不是布尔 ⇒ 抛（`"false"` 不是 `false`）；
 *   - 写了 `true` 与不写等价（缺省即开），写 `false` 才关闭。
 *
 * **本函数不做"部分通过"**：只要有一处非法就整体抛错。这样校验层（`ci-channels.sh`）
 * 与构建期拿到的是同一条判据，不会出现"CI 放行、构建按另一套读"的半通状态。
 * @param raw - `channel.json` 的 `features` 原文（**不可信输入**）。
 * @returns 三个模块的开关（缺省全 `true`）。
 * @throws {ChannelFeaturesError} 形状/键集合/取值非法时。
 */
export function normalizeChannelFeatures(raw: unknown): ChannelFeatures {
  if (raw === undefined) {
    return Object.fromEntries(FEATURE_MODULES.map(module => [module, true])) as ChannelFeatures
  }
  if (!isPlainRecord(raw)) {
    throw new ChannelFeaturesError([
      'features(必须是对象，如 {"skills": false}；不写这个键 = 全部开启)',
    ])
  }
  const problems: string[] = []
  const keys = Object.keys(raw)
  const unknown = keys.filter(key => !(FEATURE_MODULES as readonly string[]).includes(key))
  if (unknown.length > 0) {
    problems.push(
      `features 里有 ${unknown.length} 个未登记的模块名（键名不回显；合法模块名只有 `
      + `${FEATURE_MODULES.join(' / ')}，见 packages/host/desktop/scripts/channel-constants.ts 的 FEATURE_MODULES）`,
    )
  }
  for (const module of FEATURE_MODULES) {
    const value = raw[module]
    if (value === undefined) continue
    if (typeof value !== 'boolean') {
      problems.push(`features.${module}(必须是布尔 true/false；字符串 "false" 不是 false，取值不回显)`)
    }
  }
  if (problems.length > 0) throw new ChannelFeaturesError(problems)
  return Object.fromEntries(
    FEATURE_MODULES.map(module => [module, raw[module] === undefined ? true : raw[module]]),
  ) as ChannelFeatures
}

/**
 * 规范化后的开关 → **稳定变体标识**（唯一真源；消费者**不得**自己拼这个串）。
 *
 * 形态：按 {@link FEATURE_MODULES} 的顺序取**开启**的模块名，逗号分隔；三个全关 = `none`。
 * 例：`skills,apps,connectors`（缺省）/ `apps` / `apps,connectors` / `none`。
 *
 * 为什么要有这个"第二次投影"（而不是让消费者各读各的布尔）：
 *   - 它是**编译期标签**：Go 的 `-tags` 语法就是逗号分隔（`-tags skills,apps`）、
 *     docker `--build-arg` 与客户端组装清单也是同一个串 —— 三处必须是**同一个**标识，
 *     否则"镜像里有 apps、客户端里没有"这种半通状态不会有任何红灯；
 *   - 顺序固定 ⇒ 同一个开关集合永远同一个串（可直接用于缓存键/变体目录名）；
 *   - `none` 是**显式**取值，不用空串（空串在 shell/CI 里到处都是"没设置"的歧义）。
 * @param features - {@link normalizeChannelFeatures} 的结果（三个键全在）。
 * @returns 变体标识（`skills,apps,connectors` / `apps` / `none` …）。
 */
export function channelFeaturesVariant(features: ChannelFeatures): string {
  const on = FEATURE_MODULES.filter(module => features[module] === true)
  return on.length === 0 ? 'none' : on.join(',')
}

/**
 * 变体标识的**消费键名** —— 构建期给 Go `-tags` / docker `--build-arg` /
 * 客户端组装清单的赋值形态是 `FEATURES=<变体标识>`。
 */
export const CHANNEL_FEATURES_VARIANT_KEY = 'FEATURES'

/**
 * `FEATURES=<变体标识>` 的赋值行（消费者要打印/传参时的唯一拼法）。
 * @param features - {@link normalizeChannelFeatures} 的结果。
 * @returns 形如 `FEATURES=skills,apps,connectors` / `FEATURES=none` 的一行。
 */
export function channelFeaturesVariantAssignment(features: ChannelFeatures): string {
  return `${CHANNEL_FEATURES_VARIANT_KEY}=${channelFeaturesVariant(features)}`
}

/** 哨兵串的固定前缀/后缀（见 {@link featureSentinel}）。 */
export const FEATURE_SENTINEL_PREFIX = 'picoaide.feature.'
export const FEATURE_SENTINEL_VERSION = 'v1'

/**
 * 一个功能模块的**端到端哨兵串**：`picoaide.feature.<module>.v1`。
 *
 * 用途（**只是副证**，见 `docs/decisions/2026-10-13-channel-feature-modules.md`）：
 * 裁剪实现落地后，用来对产物做一次廉价的存在性抽查 —— 关闭的模块其哨兵不应出现在
 * 产物里，开启的模块其哨兵**必须**出现。
 *
 * 两条硬约束（写进契约，因为踩过）：
 *   1. 哨兵串必须位于**该模块真正被使用的那条路径上**（模块注册/装配时写入日志或登记表
 *      的那一处），不能只躺在一个常量模块里 —— 没被引用的字符串会被打包器/链接器
 *      **一起丢掉**（Go 侧实测：未被引用的函数、以及"被调用但返回值被丢弃"的路径都会掉串），
 *      于是"产物里没有这个串"既可能是"模块被裁掉了"、也可能只是"串被优化掉了"；
 *   2. 判据**必须双侧**：只在"关闭变体里没有"上判是**恒真**的（一个空产物也满足），
 *      必须同时判"开启变体里**存在**"，这个量具才算数。
 *
 * 承重判据永远是**依赖图/文件清单**（模块是否真的没被打进去），哨兵只回答
 * "这条链路上我至少还看得见它"。
 * @param module - 模块名（{@link FEATURE_MODULES} 的成员）。
 * @returns 哨兵串。
 */
export function featureSentinel(module: FeatureModule): string {
  return `${FEATURE_SENTINEL_PREFIX}${module}.${FEATURE_SENTINEL_VERSION}`
}

/** 三个模块的哨兵串（由 {@link featureSentinel} 派生，顺序同 {@link FEATURE_MODULES}）。 */
export const FEATURE_SENTINELS: Readonly<Record<FeatureModule, string>> =
  Object.fromEntries(FEATURE_MODULES.map(module => [module, featureSentinel(module)])) as
    Readonly<Record<FeatureModule, string>>

/**
 * 渠道目录里打包管线**按文件名**消费的两件素材 —— 唯一真源。
 *
 * 三个消费方必须同名：
 *   - `brand-prepare.mjs`：托盘位图与随包 `web-brand/favicon.svg` 的输入；
 *   - `scripts/ci-channels.sh`：品牌渠道的素材必需集（输入侧独立判一次）；
 *   - `inlineChannelAssets()`：`assets.logo` 声明的名字必须与它一致，否则随包内联的
 *     logo 与派生出的托盘位图是两个文件 ⇒ **同一个包里两套品牌**（登录页是声明的那个、
 *     托盘与 favicon 是另一个；2026-09-26 审计 Z3-3 的第 3 个触发形态）。
 *
 * 安装器/Dock/任务栏图标由 `appIcon` 派生（mac 图标管线要求 1024² RGBA16 + ICC，
 * 见 `generate-mac-app-icon.mjs`）。改这两个名字要同时改上面三个消费方。
 */
export const CHANNEL_ASSET_FILES = {
  /** 品牌几何源（托盘位图 + 随包 favicon 的输入）。 */
  logo: 'logo.svg',
  /** 安装器 / Dock / 任务栏图标（mac 图标管线的输入）。 */
  appIcon: 'app-icon.png',
} as const
