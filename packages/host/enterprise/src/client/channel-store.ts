// Client-side channel store: subscribes to the Host 'pico/channel-changed'
// event and exposes the current channel content to slot components via a tiny
// external store (no context provider needed — slots are function components
// that call useChannel()).
import { useEffect, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ChannelConfig } from '../channel-sync.ts'

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
