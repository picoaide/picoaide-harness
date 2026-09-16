/**
 * 凭据注入的站点绑定（2026-09-15 审计 BUG-03）。
 *
 * 背景：`browser_fill_credentials` 只按 connectorId 解析就把握着的用户名/口令
 * 写进**当前文档**。模型可以先把标签页开到任意站点（钓鱼页天然受益）再调用，
 * 凭据就落进了别人的登录框。tools.ts 里的闸门（`assertCredentialOrigin`）要求
 * 一个"该连接器自己的站点 origin"作为比对基准 —— 本模块是那个基准的**唯一**
 * 派生实现，由插件启动期（index.ts）接到凭证解析器上。
 *
 * 取值优先级（全部来自**部署侧/用户侧**的可信输入，绝无模型输入）：
 *  1. 显式配置 `credentialSites[connectorId]`（部署把它写进 profile 行配置，
 *     与登录页内置 server_url 同一层级）；
 *  2. 凭据自身字段里的 http(s) 地址 —— 自部署型连接器（例如 GLITCHTIP_BASE_URL
 *     "服务地址"）就是这样把站点告诉客户端的；键名像地址的优先，其余按字典序，
 *     保证同一份凭据每次得到同一个 origin（不随对象键序漂移）。
 *
 * 派生不出来就返回 `null`，闸门**拒绝注入**（fail-closed）：工具描述对外承诺的
 * 就是 "a connector record without a site URL is refused"。
 */

/** 凭据里可能是"站点地址"的字段名（决定同名多值时的优先级）。 */
const SITE_FIELD_HINT = /(?:^|_)(?:base_?)?(?:url|uri|site|host|origin|endpoint|address)(?:$|_)/iu

/** http/https 的 origin；其它一律 `null`（`about:blank` 的 origin 是字符串
 * `"null"`，不能当成可比对的站点）。裸主机名不在这里归一 —— 见
 * {@link bareHostOrigin}，它只用于键名明确像地址的字段。 */
export function httpOriginOf(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const url = new URL(value.trim())
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

/**
 * 裸主机名 / 主机名+端口 / 主机名+路径 → origin。
 *
 * 用户在"服务地址"类字段里经常只填 `app.glitchtip.com`（内置 GlitchTip 模板
 * 与 webadmin 提示都这么教），`httpOriginOf` 会判 null，站点绑定因此永远失败、
 * `browser_fill_credentials` 对这类连接器永久不可用（2026-09-16 审计 E1）。
 * 只对**键名像地址**的字段做这次归一（调用点决定），且要求主机名至少含一个点
 * 或是 localhost —— 免得把 `abc` 这类普通 token 值当主机。
 * @param value - 字段原值。
 * @returns 归一后的 origin，或 null。
 */
export function bareHostOrigin(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const match = /^(?<host>(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}|localhost)(?::(?<port>\d{1,5}))?(?:\/\S*)?$/iu.exec(value.trim())
  const host = match?.groups?.['host']?.toLowerCase()
  if (host === undefined) return null
  const port = match?.groups?.['port']
  const scheme = host === 'localhost' ? 'http' : 'https'
  try {
    return new URL(`${scheme}://${host}${port === undefined ? '' : `:${port}`}`).origin
  } catch {
    return null
  }
}

/**
 * 从连接器凭据的字段里挑出站点 origin。
 * @param fields - 凭据字段（`ConnectorCredential.fields`）。
 * @returns 第一个可用 origin，或 `null`。
 */
export function siteOriginFromFields(fields: Record<string, string> | undefined): string | null {
  if (fields === undefined) return null
  const entries = Object.entries(fields).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  // 键名像地址的排前面；同优先级按键名字典序（对象键序不参与，结果稳定）。
  const ranked = entries
    .map(([key, value]) => ({ key, value, hinted: SITE_FIELD_HINT.test(key) ? 0 : 1 }))
    .sort((a, b) => (a.hinted - b.hinted) || a.key.localeCompare(b.key))
  for (const entry of ranked) {
    // Bare hostnames are only normalized for address-shaped keys: a URL-looking
    // value under an unrelated key still has to carry an explicit scheme.
    const origin = httpOriginOf(entry.value)
      ?? (entry.hinted === 0 ? bareHostOrigin(entry.value) : null)
    if (origin !== null) return origin
  }
  return null
}

/**
 * 站点绑定的期望 origin：显式配置优先，其次凭据字段。
 * @param credentialFields - 已存凭据的字段表（可为空）。
 * @param configured - `credentialSites[connectorId]`（部署显式声明的站点地址）。
 */
export function credentialSiteOrigin(
  credentialFields: Record<string, string> | undefined,
  configured: string | null | undefined,
): string | null {
  return httpOriginOf(configured) ?? siteOriginFromFields(credentialFields)
}
