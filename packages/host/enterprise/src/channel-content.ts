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
  login?: { logo_url?: string; display_name?: string; tagline?: string; welcome?: string }
  client?: { logo_url?: string; display_name?: string; short_name?: string; tagline?: string }
  favicon_url?: string
  accent?: string
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

/** 取非空字符串（'' 是"渠道没配这一项"，等同于缺失）。 */
function nonEmpty(value: string | undefined): string | undefined {
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
  return {
    title: nonEmpty(brand.title) ?? loginName,
    login: {
      display_name: loginName,
      tagline: nonEmpty(login?.tagline) ?? base.login?.tagline ?? '',
      welcome: nonEmpty(login?.welcome) ?? '',
    },
    client: {
      display_name: clientName,
      // 侧边栏空间窄，用的是短名；服务端不下发这一项（没有可对账的第二来源），
      // 所以缺省直接回落到显示名 —— 宁可长一点，也不显示一个对不上的名字。
      short_name: nonEmpty(client?.shortName) ?? nonEmpty(login?.shortName) ?? clientName,
      tagline: nonEmpty(client?.tagline) ?? '',
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
  const clientLogo = nonEmpty(override.client?.logo_url)
  const favicon = nonEmpty(override.favicon_url)
  const accent = nonEmpty(override.accent)
  const channelId = nonEmpty(override.channel_id) ?? nonEmpty(base.channel_id)
  return {
    ...(channelId === undefined ? {} : { channel_id: channelId }),
    title: nonEmpty(override.title) ?? base.title ?? '',
    login: { ...login, ...(loginLogo === undefined ? {} : { logo_url: loginLogo }) },
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
