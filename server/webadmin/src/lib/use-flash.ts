import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 短暂提示(flash)hook —— P3 修复。
 *
 * 各页面此前直接 `setTimeout(() => setMsg(''), 3000)`:
 *  ① 定时器未在卸载时清理 → 组件已卸载仍 setState(React 警告/无意义渲染);
 *  ② 连续触发时旧定时器会把新提示提前清掉(竞态)。
 * 本 hook 统一持有定时器:重复触发先清旧定时器,卸载时清理。
 *
 * @param delay 自动清空延时(毫秒,默认 3000)
 * @returns [当前提示, 触发提示]
 */
export function useFlash(delay = 3000): [string, (msg: string) => void] {
  const [msg, setMsg] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const flash = useCallback((next: string) => {
    if (timer.current !== undefined) clearTimeout(timer.current)
    setMsg(next)
    timer.current = setTimeout(() => { setMsg(''); timer.current = undefined }, delay)
  }, [delay])

  useEffect(() => () => {
    if (timer.current !== undefined) clearTimeout(timer.current)
  }, [])

  return [msg, flash]
}
