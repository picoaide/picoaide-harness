/**
 * 管理后台的渠道内容（服务端 `/api/client/v2/channel`，公开端点）。
 *
 * 为什么 webadmin 也要读渠道内容：管理后台是**渠道客户的管理员**每天面对的
 * 界面，标签页标题、侧边栏名称与 logo、登录页文案都必须与该渠道一致 ——
 * 在此之前这些全是编译期硬编码的厂商品牌（审计 2026-09-10）。
 *
 * 服务端下发的是**同一份**渠道配置（镜像内 `/opt/picoaide/channel/`），
 * 与客户端登录页、员工客户端、公开门户同源；渠道配置缺失时字段为空，
 * 界面回落中性文案（绝不回落厂商品牌）。
 *
 * @module webadmin/lib/channel
 */

import { useEffect, useState } from 'react'
import { CLIENT_API } from './api-paths'

/** 服务端下发的渠道内容（与服务端 internal/channel.Response 对齐）。 */
export interface ChannelContent {
  readonly channel_id?: string
  readonly title?: string
  readonly login?: {
    readonly display_name?: string
    readonly tagline?: string
    readonly welcome?: string
    readonly logo_url?: string
  }
  readonly client?: {
    readonly display_name?: string
    readonly tagline?: string
  }
  readonly favicon_url?: string
}

/** 渠道内容缺失时的中性文案（刻意不含厂商品牌）。 */
export const NEUTRAL_ADMIN_TITLE = '管理后台'

let cached: ChannelContent | null | undefined
let inflight: Promise<ChannelContent | null> | undefined

/**
 * 拉取渠道内容（同一页面生命周期内只请求一次）。
 * @returns 渠道内容；不可达时为 null。
 */
async function loadChannel(): Promise<ChannelContent | null> {
  if (cached !== undefined) return cached
  inflight ??= fetch(`${CLIENT_API}/channel`, { headers: { accept: 'application/json' }, cache: 'no-store' })
    .then(async (response) => (response.ok ? await response.json() as ChannelContent : null))
    .catch(() => null)
    .then((value) => {
      cached = value
      return value
    })
  return await inflight
}

/**
 * 订阅渠道内容。
 * @returns 渠道内容；加载中或不可达时为 null（调用方用中性文案兜底）。
 */
export function useChannel(): ChannelContent | null {
  const [channel, setChannel] = useState<ChannelContent | null>(cached ?? null)
  useEffect(() => {
    let active = true
    void loadChannel().then((value) => {
      if (active) setChannel(value)
    })
    return () => { active = false }
  }, [])
  return channel
}

/** 渠道未配置时使用的中性站点名。 */
export function adminSiteName(channel: ChannelContent | null): string {
  const name = channel?.client?.display_name ?? channel?.title ?? channel?.login?.display_name
  return name !== undefined && name.trim() !== '' ? name.trim() : ''
}

/** 渠道 logo 地址（相对路径，浏览器同源直接可用）。 */
export function adminLogoURL(channel: ChannelContent | null): string {
  return channel?.login?.logo_url ?? channel?.favicon_url ?? ''
}
