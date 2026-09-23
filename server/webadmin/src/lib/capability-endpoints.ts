/**
 * 能力(技能 / 智能体)管理动作的**命名空间真源**。
 *
 * ## 为什么有这个模块(2026-09 现场 P1)
 *
 * 市场页与智能体页会把**组织共享库(员工上传、审批通过)** 的行并进同一张列表
 * (打 `channel:'org'` + 「员工上传」徽标),但卡片上每个按钮此前仍打**市场命名
 * 空间**的接口(`${ADMIN_API}/skills/<name>…`)。服务端两个命名空间各有**渠道
 * 守卫**,对越渠道的行**正确**返回 404「技能不存在」:
 *   - 市场:`serverstore.GetSkill` 要求 `apps.channel='market'`
 *     (`internal/serverstore/skills.go`;`DELETE|POST enable` 另有 marketplace-8 守卫);
 *   - 组织:`sharedskills.orgSkillApp` 要求 `apps.channel='org'`
 *     (`internal/sharedskills/channel.go`;智能体侧 `agentshare.orgAgentApp`)。
 * 现场 20 次 404 全部落在市场命名空间,而正确的 `/shared-skills/...` **零请求**。
 *
 * ## 契约(本模块的三条硬规则)
 *
 * 1. **按行的 `channel` 选命名空间**,绝不允许"没有 org 端点就退回市场端点"——
 *    那正是本次 P1 的形态(必然 404)。
 * 2. 两个渠道的**路径形状不同**,不得照抄对方的形状:
 *    - 市场技能:`/skills/:name`(按名寻址,上下架是 `POST /enable` 与 `DELETE /:name`);
 *    - 组织技能:`/shared-skills/:name/:version`(预览/单文件/归档**按 name@version
 *      寻址**),上下架是 `PUT /shared-skills/:name/enabled`(请求体 `{enabled}`)。
 *    市场智能体同理:`/agents/:name` ↔ 组织 `/agent-presets/:name/:version`。
 * 3. `null` = 该渠道**没有**这个端点(如组织库没有 规范化 / 元数据编辑 / 上传新版)。
 *    调用方必须**不渲染或禁用**该入口并给出明确文案,不得留必然 404 的入口。
 *
 * 路径与动词的**唯一真源**是 `server/internal/router/router.go` 的路由声明;
 * 本模块的每一条都被 `capability-endpoints.spec.ts` **读服务端源码**逐条对拍
 * (路径不存在 / 动词不符 / 命名空间拿错 ⇒ 红)。
 */
import { ADMIN_API } from './api-paths'

/** 能力种类(与服务端 apps.kind 同口径)。 */
export type CapabilityKind = 'skill' | 'agent'

/**
 * 来源渠道(与服务端 `apps.channel` 同口径):
 *   - `market`:管理端在市场直上架的官方/精选内容;
 *   - `org`   :员工上传、审批通过后进入组织共享库的内容。
 */
export type CapabilityChannel = 'market' | 'org'

/** 一行能力的定位信息(channel 决定命名空间;org 的多数动作用到 version)。 */
export interface CapabilityRef {
  channel: CapabilityChannel
  name: string
  /** 组织渠道按 name@version 寻址(预览/单文件/归档);市场渠道忽略该值。 */
  version?: string | null
}

/** 一次管理动作的服务端请求(URL + 动词 + 可选 JSON 请求体)。 */
export interface CapabilityRequest {
  url: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** JSON 请求体:仅组织渠道的上下架需要(`PUT …/:name/enabled`)。 */
  body?: string
}

/** 市场命名空间的动作(含组织库没有的 新建 / 规范化)。 */
export type SkillAction =
  | 'list'
  | 'create'
  | 'preview'
  | 'grants'
  | 'file'
  | 'archive'
  | 'enable'
  | 'disable'
  | 'updateMeta'
  | 'uploadVersion'
  | 'normalize'

/** 智能体命名空间的动作(无 规范化 —— 服务端两渠道都没有该端点)。 */
export type AgentAction =
  | 'list'
  | 'create'
  | 'preview'
  | 'grants'
  | 'file'
  | 'archive'
  | 'enable'
  | 'disable'
  | 'updateMeta'
  | 'uploadVersion'

/** 某一渠道下的请求构造器;返回 `null` = 该渠道没有这个端点。 */
type Builder = (ref: CapabilityRef) => CapabilityRequest | null

interface ChannelBuilders {
  market: Builder
  org: Builder
}

/** 两个渠道的根路径(命名空间真源;CHANNEL 决定用哪一个)。 */
export const CAPABILITY_ROOTS: Record<CapabilityKind, Record<CapabilityChannel, string>> = {
  skill: { market: `${ADMIN_API}/skills`, org: `${ADMIN_API}/shared-skills` },
  agent: { market: `${ADMIN_API}/agents`, org: `${ADMIN_API}/agent-presets` },
}

/** GrantDialog 对 basePath 的追加(与 `components/grant-dialog.tsx` 一致)。 */
export const GRANT_SUFFIXES = { list: '/grants', single: '/grant' } as const

/** ArchivePreviewDialog 对 fileBase 的追加(与 `components/archive-preview-dialog.tsx` 一致)。 */
export const FILE_SUFFIXES = { file: '/file', archive: '/archive' } as const

const seg = (v: string): string => encodeURIComponent(v)

function req(
  method: CapabilityRequest['method'],
  url: string,
  body?: string,
): CapabilityRequest {
  return body === undefined ? { url, method } : { url, method, body }
}

/**
 * 组织渠道的 name@version 端点:缺版本时**没有任何可用 URL** —— 组织库的
 * 预览/单文件/归档都是版本级资源(name-only 会 404,不是"最新版本")。
 */
function orgVersioned(ref: CapabilityRef, build: (name: string, version: string) => string): CapabilityRequest | null {
  if (!ref.version) return null
  return { url: build(seg(ref.name), seg(ref.version)), method: 'GET' }
}

const skillOrg = CAPABILITY_ROOTS.skill.org
const skillMarket = CAPABILITY_ROOTS.skill.market
const agentOrg = CAPABILITY_ROOTS.agent.org
const agentMarket = CAPABILITY_ROOTS.agent.market

/**
 * 组织渠道上下架(两 kind 对称):`PUT …/:name/enabled` + 体 `{enabled}`。
 *
 * 根路径由各自的 kind 闭包注入 —— Builder 只拿到"行"的 ref,而根路径是
 * kind 的属性,不该塞进 ref。
 */
const skillEnabled = (enabled: boolean): Builder => (ref) =>
  req('PUT', `${skillOrg}/${seg(ref.name)}/enabled`, JSON.stringify({ enabled }))

const agentEnabled = (enabled: boolean): Builder => (ref) =>
  req('PUT', `${agentOrg}/${seg(ref.name)}/enabled`, JSON.stringify({ enabled }))

/** 技能:每个动作在两个渠道下的真实请求。 */
export const SKILL_ENDPOINTS: Record<SkillAction, ChannelBuilders> = {
  list: {
    market: () => req('GET', skillMarket),
    org: () => req('GET', skillOrg),
  },
  // 新建/上架是**页面级**动作(不属于任何行):只有市场命名空间有。
  // 组织共享技能由员工上传(员工面 `POST /api/client/v2/shared-skills`),
  // 管理端没有新建入口 ⇒ org 恒 null。
  create: {
    market: () => req('POST', skillMarket),
    org: () => null,
  },
  preview: {
    market: (ref) => req('GET', `${skillMarket}/${seg(ref.name)}/preview`),
    org: (ref) => orgVersioned(ref, (name, version) => `${skillOrg}/${name}/${version}/preview`),
  },
  grants: {
    market: (ref) => req('GET', `${skillMarket}/${seg(ref.name)}/grants`),
    org: (ref) => req('GET', `${skillOrg}/${seg(ref.name)}/grants`),
  },
  file: {
    market: (ref) => req('GET', `${skillMarket}/${seg(ref.name)}/file`),
    org: (ref) => orgVersioned(ref, (name, version) => `${skillOrg}/${name}/${version}/file`),
  },
  // 归档下载(预览弹窗里「文件过大 → 下载归档」用得到):**两个渠道都有**。
  // 市场是 name 级(`GET /skills/:name/archive`,2026-09-23 补齐 —— 此前该命名
  // 空间只有 `POST …/archive`(上传新版),市场行点「下载归档」必 404);组织侧是
  // 版本级资源(`GET /shared-skills/:name/:version/archive`)。
  archive: {
    market: (ref) => req('GET', `${skillMarket}/${seg(ref.name)}/archive`),
    org: (ref) => orgVersioned(ref, (name, version) => `${skillOrg}/${name}/${version}/archive`),
  },
  // 上下架:市场用动词表达(POST /enable 与 DELETE /:name),
  // 组织用同一 PUT /:name/enabled + 请求体。两条路径的 RBAC 权限点也不同
  // (market:write ↔ capability:write),那是服务端的事,前端只需照着打。
  enable: {
    market: (ref) => req('POST', `${skillMarket}/${seg(ref.name)}/enable`),
    org: skillEnabled(true),
  },
  disable: {
    market: (ref) => req('DELETE', `${skillMarket}/${seg(ref.name)}`),
    org: skillEnabled(false),
  },
  // 组织库没有这三个端点:新版本只能由**员工**重新上传(employee Bearer 面
  // POST /api/client/v2/shared-skills),管理端不代传;规范化只针对市场技能。
  updateMeta: {
    market: (ref) => req('PUT', `${skillMarket}/${seg(ref.name)}`),
    org: () => null,
  },
  uploadVersion: {
    market: (ref) => req('POST', `${skillMarket}/${seg(ref.name)}/archive`),
    org: () => null,
  },
  normalize: {
    market: (ref) => req('POST', `${skillMarket}/${seg(ref.name)}/normalize`),
    org: () => null,
  },
}

/** 智能体:每个动作在两个渠道下的真实请求(无 规范化)。 */
export const AGENT_ENDPOINTS: Record<AgentAction, ChannelBuilders> = {
  list: {
    market: () => req('GET', agentMarket),
    org: () => req('GET', agentOrg),
  },
  // 新建登记同样是页面级动作:只有市场命名空间;组织智能体由员工上传。
  create: {
    market: () => req('POST', agentMarket),
    org: () => null,
  },
  preview: {
    market: (ref) => req('GET', `${agentMarket}/${seg(ref.name)}/preview`),
    org: (ref) => orgVersioned(ref, (name, version) => `${agentOrg}/${name}/${version}/preview`),
  },
  grants: {
    market: (ref) => req('GET', `${agentMarket}/${seg(ref.name)}/grants`),
    org: (ref) => req('GET', `${agentOrg}/${seg(ref.name)}/grants`),
  },
  file: {
    market: (ref) => req('GET', `${agentMarket}/${seg(ref.name)}/file`),
    org: (ref) => orgVersioned(ref, (name, version) => `${agentOrg}/${name}/${version}/file`),
  },
  // 市场智能体**有**归档下载端点(2026-09-23 补齐):路由
  // `GET /agents/:name/archive`。此前该命名空间只有 `POST /agents/:name/archive`
  // (上传新版)⇒ 预览弹窗「文件过大 → 下载归档」在市场智能体上必 404。
  // 组织侧对应端点是版本级 `GET /agent-presets/:name/:version/archive`。
  archive: {
    market: (ref) => req('GET', `${agentMarket}/${seg(ref.name)}/archive`),
    org: (ref) => orgVersioned(ref, (name, version) => `${agentOrg}/${name}/${version}/archive`),
  },
  enable: {
    market: (ref) => req('POST', `${agentMarket}/${seg(ref.name)}/enable`),
    org: agentEnabled(true),
  },
  disable: {
    market: (ref) => req('DELETE', `${agentMarket}/${seg(ref.name)}`),
    org: agentEnabled(false),
  },
  updateMeta: {
    market: (ref) => req('PUT', `${agentMarket}/${seg(ref.name)}`),
    org: () => null,
  },
  uploadVersion: {
    market: (ref) => req('POST', `${agentMarket}/${seg(ref.name)}/archive`),
    org: () => null,
  },
}

/** 技能动作 → 请求(按行 channel 选命名空间)。 */
export function skillRequest(action: SkillAction, ref: CapabilityRef): CapabilityRequest | null {
  return SKILL_ENDPOINTS[action][ref.channel](ref)
}

/** 智能体动作 → 请求(按行 channel 选命名空间)。 */
export function agentRequest(action: AgentAction, ref: CapabilityRef): CapabilityRequest | null {
  return AGENT_ENDPOINTS[action][ref.channel](ref)
}

/** 归属转移是 **(kind, name) 级**资源(apps.owner),与渠道/版本无关 ⇒ 单一端点。 */
export function ownerTransferRequest(kind: CapabilityKind, name: string): CapabilityRequest {
  return req('PUT', `${ADMIN_API}/apps/${kind}/${seg(name)}/owner`)
}

/**
 * GrantDialog 的 `basePath`(= 授权资源基路径)。
 *
 * 组件在该基路径后追加 `/grants`(读/整组替换)与 `/grant`(单条增删)——
 * 组织渠道的授权是 name-only(同名多版本共享),**不是** version 级,
 * 所以这里必须用 grants 端点而不是 preview/file 的 version 路径。
 */
export function grantsBase(kind: CapabilityKind, ref: CapabilityRef): string | null {
  const r = kind === 'skill' ? skillRequest('grants', ref) : agentRequest('grants', ref)
  if (r === null) return null
  if (!r.url.endsWith(GRANT_SUFFIXES.list)) {
    throw new Error(`授权基路径推导失败:${r.url} 不以 ${GRANT_SUFFIXES.list} 结尾`)
  }
  return r.url.slice(0, -GRANT_SUFFIXES.list.length)
}

/** ArchivePreviewDialog 的 `fileBase`(组件追加 `/file?path=` 与 `/archive`)。 */
export function previewFileBase(kind: CapabilityKind, ref: CapabilityRef): string | null {
  const r = kind === 'skill' ? skillRequest('file', ref) : agentRequest('file', ref)
  if (r === null) return null
  if (!r.url.endsWith(FILE_SUFFIXES.file)) {
    throw new Error(`文件基路径推导失败:${r.url} 不以 ${FILE_SUFFIXES.file} 结尾`)
  }
  return r.url.slice(0, -FILE_SUFFIXES.file.length)
}
