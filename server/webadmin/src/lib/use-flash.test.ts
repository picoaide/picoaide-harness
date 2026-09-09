import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useFlash } from './use-flash'

// P3: flash 提示的定时器必须清理,且连续触发不得被旧定时器提前清空。
describe('useFlash(P3 flash 定时器清理)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('到点自动清空', () => {
    const { result } = renderHook(() => useFlash(3000))
    act(() => result.current[1]('已保存'))
    expect(result.current[0]).toBe('已保存')
    act(() => { vi.advanceTimersByTime(2999) })
    expect(result.current[0]).toBe('已保存')
    act(() => { vi.advanceTimersByTime(1) })
    expect(result.current[0]).toBe('')
  })

  it('连续触发以最后一次为准(旧定时器不提前清空)', () => {
    const { result } = renderHook(() => useFlash(1000))
    act(() => result.current[1]('第一次'))
    act(() => { vi.advanceTimersByTime(900) })
    act(() => result.current[1]('第二次'))
    act(() => { vi.advanceTimersByTime(900) })
    expect(result.current[0]).toBe('第二次') // 若旧定时器未清,这里会被清空
    act(() => { vi.advanceTimersByTime(100) })
    expect(result.current[0]).toBe('')
  })

  it('卸载后不残留定时器', () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    const { result, unmount } = renderHook(() => useFlash(1000))
    act(() => result.current[1]('提示'))
    unmount()
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })
})
