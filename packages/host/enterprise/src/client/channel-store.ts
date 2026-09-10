// Client-side channel store: subscribes to the Host 'pico/channel-changed'
// event and exposes the current channel content to slot components via a tiny
// external store (no context provider needed — slots are function components
// that call useChannel()).
import { useEffect, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ChannelConfig } from '../channel-content.ts'

// 声明 Host 侧事件(客户端编译面不加载 channel-sync 的 module 声明)。
declare module '@deepseek-ai/cordis' {
  interface Events {
    'pico/channel-changed'(channel: ChannelConfig | null): void
  }
}

let current: ChannelConfig | null = null
let listeners = new Set<() => void>()
let started = false
let cancel: (() => void) | undefined

function set(channel: ChannelConfig | null) {
  current = channel
  listeners.forEach((l) => l())
}

/**
 * Seed the store with the **packaged** channel content（随包分发的渠道品牌）。
 *
 * 服务端下发要等会话建立，而客户端界面对品牌的第一次渲染更早 —— 中间那段
 * （以及服务端不可达时）显示什么，决定了渠道客户会不会看到厂商名。这里从本地
 * 端点 `/api/pico/channel` 取随包品牌：auth-gate 在未登录/服务端不可达时返回
 * 的正是它。
 *
 * **只在 store 仍为空时写入**：这个请求与登录后的服务端请求并发，若它后到就会
 * 用随包内容盖掉服务端的权威内容（渠道改了服务端配置，客户端却还显示旧名）。
 * 失败静默 —— 拿不到就沿用 `DEFAULT_CHANNEL`，不阻塞界面。
 */
async function seedFromPackagedBrand(): Promise<void> {
  try {
    const res = await fetch('/api/pico/channel', { headers: { accept: 'application/json' } })
    if (!res.ok) return
    const data = await res.json() as ChannelConfig | null
    if (current === null && data !== null && typeof data === 'object' && Object.keys(data).length > 0) {
      set(data)
    }
  } catch { /* endpoint absent / offline: keep DEFAULT_CHANNEL */ }
}

/**
 * Install the Host event subscription (re-entrant). 返回取消函数供调用方在
 * fiber 卸载时调用——旧实现把 `ctx.on` 的 disposer 丢弃且 started 永不复位,
 * HMR/插件重载后新一轮 apply 因 started===true 直接返回,渠道变更不再推送
 * (2026-09-01 深挖)。
 */
export function startChannelStore(ctx: ClientContext): () => void {
  if (started && cancel !== undefined) return cancel
  started = true
  cancel = ctx.on('pico/channel-changed', (channel) => {
    set(channel ?? null)
  })
  void seedFromPackagedBrand()
  return () => {
    cancel?.()
    cancel = undefined
    started = false
  }
}

/** React hook: current channel content (null = built-in default). */
export function useChannel(): ChannelConfig | null {
  const [b, setB] = useState<ChannelConfig | null>(current)
  useEffect(() => {
    const l = () => setB(current)
    listeners.add(l)
    return () => { listeners.delete(l) }
  }, [])
  return b
}

/** 同步读取当前渠道配置(供 effect 初始化时用, 非 React)。 */
export function readChannelSync(): ChannelConfig | null {
  return current
}
