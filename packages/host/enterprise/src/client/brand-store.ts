// Client-side brand store: subscribes to the Host 'pico/brand-changed'
// event and exposes the current brand to slot components via a tiny
// external store (no context provider needed — slots are function components
// that call useBrand()).
import { useEffect, useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
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

function set(brand: BrandConfig | null) {
  current = brand
  listeners.forEach((l) => l())
}

/** Install the Host event subscription (idempotent). */
export function startBrandStore(ctx: ClientContext): void {
  if (started) return
  started = true
  ctx.on('pico/brand-changed', (brand) => {
    set(brand ?? null)
  })
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

/** Reset for tests. */
export function _resetBrandStoreForTest(): void {
  current = null
  listeners = new Set()
  started = false
}
