/**
 * 渠道内容契约：**服务端下发**与**随包兜底**共用的那一份类型与内置值。
 *
 * 单独成文件不是为了好看，而是**依赖方向**：这份内容同时被 Host 面
 * （`channel-sync`，node 运行时）与 Client 面（`client/Channel.tsx`、
 * `client/channel-vars.ts`）消费。此前类型定义挂在 `channel-sync.ts` 上，
 * 客户端只能 `import type` —— 一旦哪天有人为了拿 `DEFAULT_CHANNEL` 改成值导入，
 * 就会把 `schemastery` / `node:http` / `session-service` 整条链拖进浏览器
 * bundle。这里只放纯数据，两个面都能安全值导入。
 *
 * **不要**在这个文件里 import 任何 `node:*`、cordis、schemastery。
 *
 * @module @picoaide/dsh-enterprise/channel-content
 */

/**
 * 客户端消费的渠道配置（与服务端 `GET /api/client/v2/channel` 同形）。
 *
 * 渠道内容总是生效——没有开关字段；每个字段都可能缺失（渠道未配置该项），
 * 消费方按字段自行兜底。
 */
export interface ChannelConfig {
  channel_id?: string
  title?: string
  login?: {
    logo_url?: string
    /** 暗色主题用的 logo（服务端只在渠道配了 `assets.logo_dark` 时下发）。 */
    logo_url_dark?: string
    display_name?: string
    tagline?: string
    welcome?: string
  }
  client?: { logo_url?: string; display_name?: string; short_name?: string; tagline?: string }
  favicon_url?: string
  accent?: string
}

/**
 * 把服务端渠道载荷里的**相对素材 URL 拼成绝对地址**（返回新对象，不改入参）。
 *
 * 服务端下发的 `logo_url` / `favicon_url` 是相对路径（如
 * `/api/client/v2/channel/logo`，命名空间真源在 `internal/router`）。谁消费谁负责
 * 拼服务端地址，而客户端本地端点 `/api/pico/channel` 的返回值**会被直接存进
 * store 交给 `<img>` 渲染** —— 相对路径在 Electron 渲染层会打到本地 webServer 而
 * 404，页面上就是一个裂图（2026-09-10 实测：服务端开始下发 `client.logo_url`
 * 之后暴露出来）。因此该端点在出口处统一绝对化。
 *
 * 已是绝对 http(s) URL 的原样保留；`serverURL` 为空时**丢弃**相对 URL ——
 * 宁可让消费方回落到内置品牌图形，也不要渲染一个必然 404 的相对地址。
 * @param channel - 待处理的渠道内容。
 * @param serverURL - 本会话的服务端地址（`scheme://host[:port]`）。
 * @returns 处理后的渠道内容。
 */
export function absolutizeChannelAssets(channel: ChannelConfig, serverURL: string): ChannelConfig {
  // 尾部斜杠剥离用无正则形式（CodeQL js/polynomial-redos，与 channel-sync 同款）。
  let server = serverURL
  while (server.endsWith('/')) server = server.slice(0, -1)
  const abs = (value: string | undefined): string | undefined => {
    const url = nonEmpty(value)
    if (url === undefined) return undefined
    // `data:`（随包内联 logo）本身就是完整的 URL：既不能拼服务端地址，也不能
    // 当作"相对路径"丢掉 —— 丢了等于白标 logo 在播种那一步被抹掉。
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) return url
    return server === '' ? undefined : server + url
  }
  // **先删后写**，不要写成 `{ ...client, ...(logo === undefined ? {} : { logo }) }`：
  // 素材被**丢弃**时那半截展开不会出现，原对象里的相对地址就被 spread 原样带回来了
  // —— 2026-09-10 实测踩到（"丢弃相对 URL" 实际一条都没丢，测试才发现）。
  const out: ChannelConfig = { ...channel }
  delete out.favicon_url
  const favicon = abs(channel.favicon_url)
  if (favicon !== undefined) out.favicon_url = favicon
  if (channel.login !== undefined) {
    const source = channel.login
    const login: NonNullable<ChannelConfig['login']> = { ...source }
    delete login.logo_url
    delete login.logo_url_dark
    const logo = abs(source.logo_url)
    const logoDark = abs(source.logo_url_dark)
    if (logo !== undefined) login.logo_url = logo
    if (logoDark !== undefined) login.logo_url_dark = logoDark
    out.login = login
  }
  if (channel.client !== undefined) {
    const source = channel.client
    const client: NonNullable<ChannelConfig['client']> = { ...source }
    delete client.logo_url
    const logo = abs(source.logo_url)
    if (logo !== undefined) client.logo_url = logo
    out.client = client
  }
  return out
}

/**
 * 丢弃载荷里的**相对**素材 URL（绝对 http(s) 原样保留）。
 *
 * 给"手上没有服务端地址可比对"的消费方用：相对路径交给渲染层必然 404（打到本地
 * webServer），不如当作"渠道未配置"处理，让消费方回落到内置品牌图形。
 * @param channel - 待处理的渠道内容。
 * @returns 去掉相对素材 URL 的渠道内容。
 */
export function stripRelativeAssetURLs(channel: ChannelConfig): ChannelConfig {
  return absolutizeChannelAssets(channel, '')
}

/**
 * 组装期注入的品牌文案（`profile.ts` 从渠道包读取后写入插件行 config）。
 *
 * 字段名是驼峰的（配置走 schemastery），落地成 `ChannelConfig` 时转成服务端那套
 * snake_case —— 转换在 `brandChannel()` 一处完成。
 */
export interface BrandConfig {
  title?: string
  login?: { displayName?: string; shortName?: string; tagline?: string; welcome?: string }
  client?: { displayName?: string; shortName?: string; tagline?: string }
  /**
   * 随包 logo（`data:` URI，组装期由 desktop-channel 从渠道包内联进来）。
   *
   * 服务端可达时以服务端下发的 URL 为准；服务端不可达、或服务端还是旧版（没有
   * `/api/client/v2/channel`）时，登录页与侧边栏显示的就是它。没有它，客户端只能
   * 回落到编译期内置的**官方**花括号 mark —— 白标客户在登录页上看到厂商图形
   * （2026-09-11 在 moka 渠道的线上环境实测到）。
   */
  logoURL?: string
  /** 深色场景的随包 logo（`assets.logo_dark`），同一来源。 */
  logoDarkURL?: string
}

/**
 * 内置兜底内容 = **官方**渠道文案（没有渠道包时用：本地开发、web 组装）。
 *
 * 渠道构建下这份不会生效：`profile.ts` 从渠道包读出品牌注入 `channel-sync` 的
 * config，`brandChannel()` 给出的才是渠道客户在服务端不可达时看到的内容。
 * 刻意保留官方值而不是中性占位 —— 本地开发（`yarn dev`）与官方构建走的就是这一份。
 */
/** 官方渠道名字：内置兜底的唯一字面量来源。 */
const OFFICIAL_NAME = 'PicoAide'
/** 官方渠道标语。 */
const OFFICIAL_TAGLINE = 'Enterprise AI Gateway'
/** 未配置品牌时的中性名。 */
const NEUTRAL_NAME = 'Harness'
/** 官方渠道界面全名。 */
const OFFICIAL_PRODUCT_NAME = 'PicoAide Harness'

export const DEFAULT_CHANNEL: ChannelConfig = {
  login: { display_name: OFFICIAL_NAME, tagline: OFFICIAL_TAGLINE, welcome: '' },
  client: { display_name: OFFICIAL_PRODUCT_NAME, short_name: OFFICIAL_NAME, tagline: '' },
  title: OFFICIAL_PRODUCT_NAME,
}

/**
 * 渠道包没配品牌时的中性占位（与 `desktop-channel.ts` 的 `NEUTRAL_BRAND_NAME`
 * / 服务端 `fallbackBrandName` 同值）。
 *
 * **渠道构建必须用它，而不是 `DEFAULT_CHANNEL`**：渠道包存在但品牌字段为空，
 * 说明注入链断了；此刻显示厂商名正是白标要防的事故，显示中性名至少不冒充。
 */
export const NEUTRAL_CHANNEL: ChannelConfig = {
  login: { display_name: NEUTRAL_NAME, tagline: '', welcome: '' },
  client: { display_name: NEUTRAL_NAME, short_name: NEUTRAL_NAME, tagline: '' },
  title: NEUTRAL_NAME,
}

/**
 * 取非空字符串（'' 与纯空白都是"渠道没配这一项"，等同于缺失）。
 *
 * 导出给客户端编译面复用：`client/Channel.tsx` 曾自己写了一份**不 trim** 的版本，
 * 于是 `short_name: "   "` 会被当成有效值 → 侧边栏品牌名渲染成空白
 * （2026-09-11 测试发现）。判空口径只能有一份。
 */
export function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined
}

/**
 * 随包品牌 → `ChannelConfig`（渠道构建下的内置兜底内容）。
 *
 * 与 `DEFAULT_CHANNEL` 的分工：那份是**官方**文案，这份是**本渠道**文案。
 * 服务端可达时两者都不生效 —— 以服务端下发的 `GET /api/client/v2/channel` 为准。
 * @param brand - 组装期注入的品牌配置（可缺，缺省即官方文案）。
 * @returns 与 `GET /api/client/v2/channel` 同形的对象。
 */
export function brandChannel(brand: BrandConfig | undefined): ChannelConfig {
  // 没有渠道包 = 官方构建（本地开发/官方渠道），逐个字段就是官方内容 ——
  // 直接返回，不走下面的推导（推导会把 client 名收敛成 login 名，官方渠道
  // 界面名是 "PicoAide Harness" 而登录页是 "PicoAide"，两者本就不同）。
  if (brand === undefined) return DEFAULT_CHANNEL
  // "是渠道品牌吗"的判据 = **至少有一个非空名字**。
  //
  // 为什么不用"对象是否存在":schemastery 会把未注入的 `brand` 物化成 `{}`
  // (补出空对象),把空对象当成渠道会让**官方**构建改名成中性占位
  // (2026-09-10 实测:官方 E2E 标题变成 "Harness")。
  // 反过来,真正的渠道品牌必然带非空名字 —— desktop-channel.ts 在解析渠道包时
  // 就用中性名兜底了(`NEUTRAL_BRAND_NAME`),不会漏出空串。
  const login = brand.login
  const client = brand.client
  if (nonEmpty(login?.displayName) === undefined
    && nonEmpty(brand.title) === undefined
    && nonEmpty(client?.displayName) === undefined) {
    return DEFAULT_CHANNEL
  }
  // 渠道模式的基座是**中性**内容:名字缺失时给中性占位,而不是官方名;
  // 标语/欢迎语缺失时留空,绝不继承官方文案(那是把厂商宣传语塞给渠道客户)。
  const base = NEUTRAL_CHANNEL
  const loginName = nonEmpty(login?.displayName) ?? nonEmpty(brand.title) ?? base.login?.display_name ?? ''
  const clientName = nonEmpty(client?.displayName) ?? loginName
  // 随包 logo（data: URI）：登录页与界面在"服务端不可达/旧版服务端"时靠它显示
  // **客户自己的**标识，而不是内置的官方图形。
  const logoURL = nonEmpty(brand.logoURL)
  const logoDarkURL = nonEmpty(brand.logoDarkURL)
  return {
    title: nonEmpty(brand.title) ?? loginName,
    login: {
      display_name: loginName,
      tagline: nonEmpty(login?.tagline) ?? base.login?.tagline ?? '',
      welcome: nonEmpty(login?.welcome) ?? '',
      ...(logoURL === undefined ? {} : { logo_url: logoURL }),
      ...(logoDarkURL === undefined ? {} : { logo_url_dark: logoDarkURL }),
    },
    client: {
      display_name: clientName,
      // 侧边栏空间窄，用的是短名；服务端不下发这一项（没有可对账的第二来源），
      // 所以缺省直接回落到显示名 —— 宁可长一点，也不显示一个对不上的名字。
      short_name: nonEmpty(client?.shortName) ?? nonEmpty(login?.shortName) ?? clientName,
      tagline: nonEmpty(client?.tagline) ?? '',
      ...(logoURL === undefined ? {} : { logo_url: logoURL }),
    },
  }
}

/**
 * 逐字段把服务端下发的内容**叠在随包品牌之上**（服务端有值即胜出）。
 *
 * 为什么需要:客户端在渠道构建下**已经带着**一份随包品牌,而服务端下发是
 * 另一个来源。若服务端那份缺字段(旧服务端、渠道配置没打进镜像、字段被清空),
 * 消费方就会回落到内置的**厂商**文案 —— 渠道客户于是看到 PicoAide。
 * 叠一层之后,缺口由随包品牌补上:两边本来就是同一个渠道包构建的,内容一致。
 *
 * 语义:
 *   - 服务端字段非空 → 用服务端的(管理员在服务端改了内容仍然生效);
 *   - 服务端字段缺失/空 → 用随包品牌的;
 *   - 官方渠道下 base 就是官方内置内容,叠加结果与改造前逐字节一致。
 * @param base - 随包品牌(`brandChannel()` 的结果)。
 * @param override - 服务端下发的内容(已经过 URL 绝对化)。
 * @returns 补齐后的渠道内容。
 */
export function mergeChannel(base: ChannelConfig, override: ChannelConfig): ChannelConfig {
  const login = {
    display_name: nonEmpty(override.login?.display_name) ?? base.login?.display_name ?? '',
    tagline: nonEmpty(override.login?.tagline) ?? base.login?.tagline ?? '',
    welcome: nonEmpty(override.login?.welcome) ?? base.login?.welcome ?? '',
  }
  const client = {
    display_name: nonEmpty(override.client?.display_name) ?? base.client?.display_name ?? '',
    short_name: nonEmpty(override.client?.short_name) ?? base.client?.short_name ?? '',
    tagline: nonEmpty(override.client?.tagline) ?? base.client?.tagline ?? '',
  }
  // logo_url / favicon_url / accent 只可能来自服务端(随包素材不进这个端点),
  // 因此原样保留:有值就带上,没有就不产生 undefined 属性。
  const loginLogo = nonEmpty(override.login?.logo_url)
  // 暗色 logo 与亮色同源(服务端配了 assets.logo_dark 才下发):同样原样保留 ——
  // 此前这里只带亮色,通道被静默掐断(2026-09-10 与 logo_url 绝对化同一轮发现)。
  const loginLogoDark = nonEmpty(override.login?.logo_url_dark)
  const clientLogo = nonEmpty(override.client?.logo_url)
  const favicon = nonEmpty(override.favicon_url)
  const accent = nonEmpty(override.accent)
  const channelId = nonEmpty(override.channel_id) ?? nonEmpty(base.channel_id)
  return {
    ...(channelId === undefined ? {} : { channel_id: channelId }),
    title: nonEmpty(override.title) ?? base.title ?? '',
    login: {
      ...login,
      ...(loginLogo === undefined ? {} : { logo_url: loginLogo }),
      ...(loginLogoDark === undefined ? {} : { logo_url_dark: loginLogoDark }),
    },
    client: { ...client, ...(clientLogo === undefined ? {} : { logo_url: clientLogo }) },
    ...(favicon === undefined ? {} : { favicon_url: favicon }),
    ...(accent === undefined ? {} : { accent }),
  }
}

/**
 * 窗口/页面标题用的渠道名(上游 DocumentTitle 归一化与页面标题共用)。
 * @param channel - 当前渠道内容(可为空)。
 * @returns 非空标题:渠道 title → 界面名 → 内置官方标题。
 */
export function channelTitle(channel: ChannelConfig | null | undefined): string {
  return nonEmpty(channel?.title)
    ?? nonEmpty(channel?.client?.display_name)
    ?? DEFAULT_CHANNEL.title
    ?? ''
}

/**
 * 判断一份载荷是否**长得像**渠道内容。
 *
 * 为什么需要:客户端把 `/api/pico/channel` 的响应直接当渠道内容用,而服务端
 * 可能回一个结构完全不同的 body(旧服务端没有这个路由时的兜底对象、网关错误
 * 体、代理的 `{ok:true}`…)。一旦这种载荷进了 store,消费方每个字段都取不到值,
 * 于是回落到内置的**厂商**文案 —— 渠道客户看到 PicoAide,链路零报错。
 *
 * 判据刻意宽松(至少要有一个非空的品牌字符串字段),只拦"根本不是渠道内容"的
 * 载荷;真正的合并语义由 `mergeChannel` 负责(缺字段用随包品牌补)。
 * @param value - 已解析的响应体。
 * @returns 像渠道内容时返回规范化后的对象;否则 undefined。
 */
export function asChannelPayload(value: unknown): ChannelConfig | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const login = typeof record.login === 'object' && record.login !== null ? record.login as Record<string, unknown> : {}
  const client = typeof record.client === 'object' && record.client !== null ? record.client as Record<string, unknown> : {}
  const hasBrandField = [record.title, login.display_name, login.logo_url, client.display_name, client.logo_url]
    .some(field => nonEmpty(typeof field === 'string' ? field : undefined) !== undefined)
  return hasBrandField ? value as ChannelConfig : undefined
}
