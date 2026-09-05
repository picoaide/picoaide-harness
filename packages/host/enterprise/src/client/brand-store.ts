// Client-side brand store: subscribes to the Host 'pico/brand-changed'
// event and exposes the current brand to slot components via a tiny
// external store (no context provider needed — slots are function components
// that call useBrand()).
import { useEffect, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { BrandConfig } from '../brand-sync.ts'

// 声明 Host 侧事件(客户端编译面不加载 brand-sync 的 module 声明)。
declare module '@deepseek-ai/cordis' {
  interface Events {
    'pico/brand-changed'(brand: BrandConfig | null): void
  }
}

let current: BrandConfig | null = null
let listeners = new Set<() => void>()
let started = false
let cancel: (() => void) | undefined

function set(brand: BrandConfig | null) {
  current = brand
  listeners.forEach((l) => l())
}

/**
 * Install the Host event subscription (re-entrant). 返回取消函数供调用方在
 * fiber 卸载时调用——旧实现把 `ctx.on` 的 disposer 丢弃且 started 永不复位,
 * HMR/插件重载后新一轮 apply 因 started===true 直接返回,品牌变更不再推送
 * (2026-09-01 深挖)。
 */
export function startBrandStore(ctx: ClientContext): () => void {
  if (started && cancel !== undefined) return cancel
  started = true
  cancel = ctx.on('pico/brand-changed', (brand) => {
    set(brand ?? null)
  })
  return () => {
    cancel?.()
    cancel = undefined
    started = false
  }
}

/** React hook: current brand (null = default). */
export function useBrand(): BrandConfig | null {
  const [b, setB] = useState<BrandConfig | null>(current)
  useEffect(() => {
    const l = () => setB(current)
    listeners.add(l)
    return () => { listeners.delete(l) }
  }, [])
  return b
}

/** 同步读取当前品牌(供 effect 初始化时用, 非 React)。 */
export function readBrandSync(): BrandConfig | null {
  return current
}
