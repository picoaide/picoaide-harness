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
  // 有渠道包但字段空 = 注入链断了：中性占位，绝不用官方文案冒充渠道。
  const base = NEUTRAL_CHANNEL
  const login = brand.login
  const client = brand?.client
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
