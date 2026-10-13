/**
 * 渠道化打包的**零依赖常量**：交付面平台清单与渠道素材文件名。
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
] as const


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
