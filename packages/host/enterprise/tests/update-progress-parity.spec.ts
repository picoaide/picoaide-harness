/**
 * 跨包对拍:更新进度的显示文本只有一个语义。
 *
 * 三个展示面(侧边栏指示器 / 设置「关于」/ 会话头部徽标)读同一份快照,但
 * **公式有两份副本** —— enterprise 的 `progressPercent`(UpdateIndicator.tsx)
 * 与 desktop 的 `updateProgressPercent`(desktop-update.tsx)。跨包客户端 import
 * 被禁止(两个 client bundle 各自独立加载),所以无法物理共享实现;这份对拍
 * 就是那条护栏:同一组输入必须给出**逐字相同**的输出。
 *
 * 判据强度:只改一面(或只把一面改回旧的 `Math.min(99, …)` 单向封顶)即变红。
 *
 * 用例矩阵覆盖 0% / 未达最多 99% / 完成即 100% / received > total /
 * total = 0 / total 未知(显示已下载字节数) / ≥100 的 KB 值(进位分支) /
 * NaN·Infinity·负数(有限性守卫) / 退避倒计时的本地重算公式。
 */
import { describe, expect, it } from 'vitest'
import {
  downloadingStatusText,
  liveRetryDelayMs as enterpriseLiveRetryDelayMs,
  progressPercent,
  type UpdateState,
} from '../src/client/UpdateIndicator.tsx'
import {
  desktopUpdateBadgeView,
  liveRetryDelayMs as desktopLiveRetryDelayMs,
  updateProgressPercent,
} from '../../desktop/src/client/desktop-update.tsx'
import { setActiveLocale } from '../src/client/locales.ts'

/** 完整快照(两面类型同形;这里按共享契约构造)。 */
function snapshot(
  progress: { receivedBytes: number, totalBytes: number | undefined } | undefined,
  options: { readonly downloading?: boolean } = {},
): UpdateState {
  return {
    availableVersion: '9.9.9',
    downloadingVersion: options.downloading === false ? undefined : '9.9.9',
    downloadProgress: progress,
    isPackaged: true,
    canDownload: true,
    currentVersion: '9.0.0',
    readyVersion: undefined,
    readyPath: undefined,
    retryAttempt: 1,
    retryMaxAttempts: 6,
    retryDelayMs: 0,
    lastError: undefined,
  }
}

interface ProgressCase {
  readonly name: string
  readonly receivedBytes: number
  readonly totalBytes: number | undefined
  /** 两面必须逐字相同的输出;`undefined` = 不渲染进度。 */
  readonly expected: string | undefined
}

const cases: readonly ProgressCase[] = [
  { name: '未开始', receivedBytes: 0, totalBytes: 1024, expected: '0%' },
  { name: '三分之一', receivedBytes: 1, totalBytes: 3, expected: '33%' },
  { name: '未达但四舍五入到 99', receivedBytes: 1999, totalBytes: 2000, expected: '99%' },
  { name: '99.99% 也只能是 99%', receivedBytes: 999_999, totalBytes: 1_000_000, expected: '99%' },
  { name: '收满就是 100%', receivedBytes: 1_000_000, totalBytes: 1_000_000, expected: '100%' },
  { name: '收到多于分母(清单偏小)也是 100%', receivedBytes: 2_000_000, totalBytes: 1_600_000, expected: '100%' },
  { name: 'total = 0 ⇒ 显示已下载字节数', receivedBytes: 0, totalBytes: 0, expected: '0 B' },
  { name: 'total 未知且未开始', receivedBytes: 0, totalBytes: undefined, expected: '0 B' },
  { name: 'total 未知(几百字节)', receivedBytes: 812, totalBytes: undefined, expected: '812 B' },
  { name: 'total 未知(12 MiB)', receivedBytes: 12_582_912, totalBytes: undefined, expected: '12.0 MB' },
  { name: 'total 未知(1.5 GiB)', receivedBytes: 1_610_612_736, totalBytes: undefined, expected: '1.5 GB' },
  // ≥100 单位的进位分支:200 KB 在"≥100 取整"下是 `200 KB`,把这一支改成恒
  // `toFixed(1)` 就会与另一面分叉成 `200.0 KB` —— 矩阵里必须有 ≥100 的 KB 值
  // 才测得到(旧矩阵只有 B/MB/GB 三个量级,单边变异曾是绿的)。
  { name: 'total 未知(200 KB,≥100 进位分支)', receivedBytes: 204_800, totalBytes: undefined, expected: '200 KB' },
  { name: 'total 未知(1024 KB 边界)', receivedBytes: 1_048_576, totalBytes: undefined, expected: '1.0 MB' },
  // 有限性守卫:NaN/Infinity/负数都不得变成 `NaN KB` 这类输出,两面必须同源。
  { name: 'received = NaN ⇒ 0 B', receivedBytes: Number.NaN, totalBytes: undefined, expected: '0 B' },
  { name: 'received = Infinity,total 未知 ⇒ 0 B', receivedBytes: Number.POSITIVE_INFINITY, totalBytes: undefined, expected: '0 B' },
  { name: 'received = Infinity,total 有限 ⇒ 0%', receivedBytes: Number.POSITIVE_INFINITY, totalBytes: 1000, expected: '0%' },
  { name: 'received = NaN,total = NaN ⇒ 0 B', receivedBytes: Number.NaN, totalBytes: Number.NaN, expected: '0 B' },
  { name: 'received = -5 ⇒ 0%', receivedBytes: -5, totalBytes: 100, expected: '0%' },
  { name: 'total = Infinity ⇒ 已下载字节数', receivedBytes: 1_048_576, totalBytes: Number.POSITIVE_INFINITY, expected: '1.0 MB' },
]

describe('update progress parity across the two client bundles', () => {
  it('derives the identical text from the same snapshot matrix', () => {
    for (const testCase of cases) {
      const state = snapshot({ receivedBytes: testCase.receivedBytes, totalBytes: testCase.totalBytes })
      const enterprise = progressPercent(state)
      const desktop = updateProgressPercent(state)
      expect(desktop, `desktop 面 / ${testCase.name}`).toBe(testCase.expected)
      expect(enterprise, `enterprise 面 / ${testCase.name}`).toBe(testCase.expected)
      // 会话头部徽标的按钮文字里也必须出现同一个字符串(第三面同源)。
      if (testCase.expected !== undefined) {
        expect(desktopUpdateBadgeView(state)?.label).toBe(`9.9.9 ${testCase.expected}`)
        expect(downloadingStatusText(state)).toContain(testCase.expected)
      }
    }
  })

  it('renders no progress text without a downloading version or progress snapshot', () => {
    for (const state of [snapshot({ receivedBytes: 10, totalBytes: 100 }, { downloading: false }), snapshot(undefined)]) {
      expect(progressPercent(state)).toBeUndefined()
      expect(updateProgressPercent(state)).toBeUndefined()
      expect(desktopUpdateBadgeView(state)?.label).toBe('9.9.9')
    }
  })

  it('stays byte-identical under both UI locales', () => {
    // 百分比与"已下载字节数"都不含语言相关文案;两侧字典切换后必须仍逐字相同。
    for (const locale of ['zh', 'en']) {
      setActiveLocale(locale)
      for (const testCase of cases) {
        const state = snapshot({ receivedBytes: testCase.receivedBytes, totalBytes: testCase.totalBytes })
        expect(progressPercent(state), `${locale} / ${testCase.name}`).toBe(testCase.expected)
        expect(updateProgressPercent(state), `${locale} / ${testCase.name}`).toBe(testCase.expected)
      }
    }
    setActiveLocale('zh')
  })

  it('counts the retry backoff down with the same formula on both sides', () => {
    // 退避倒计时的公式同样是两份副本:快照只给"发布那一刻的剩余量",两个显示面
    // 都要按锚点现算。任何一面改回"直接用快照值"都会与另一面分叉。
    const countdownCases: ReadonlyArray<{ readonly name: string, readonly delayMs: number, readonly anchoredAtMs: number, readonly nowMs: number, readonly expected: number }> = [
      { name: '刚到达', delayMs: 30_000, anchoredAtMs: 0, nowMs: 0, expected: 30_000 },
      { name: '11 秒后', delayMs: 30_000, anchoredAtMs: 0, nowMs: 11_000, expected: 19_000 },
      { name: '锚点不是 0', delayMs: 30_000, anchoredAtMs: 1_000, nowMs: 1_000, expected: 30_000 },
      { name: '刚好归零', delayMs: 30_000, anchoredAtMs: 0, nowMs: 30_000, expected: 0 },
      { name: '超过截止时刻不为负', delayMs: 30_000, anchoredAtMs: 0, nowMs: 45_000, expected: 0 },
      { name: '没有退避', delayMs: 0, anchoredAtMs: 0, nowMs: 5, expected: 0 },
      { name: 'delay NaN', delayMs: Number.NaN, anchoredAtMs: 0, nowMs: 5, expected: 0 },
      { name: 'delay Infinity', delayMs: Number.POSITIVE_INFINITY, anchoredAtMs: 0, nowMs: 5, expected: 0 },
      { name: '锚点未知 ⇒ 按原值', delayMs: 30_000, anchoredAtMs: Number.NaN, nowMs: 5, expected: 30_000 },
      { name: '当前时刻未知 ⇒ 按原值', delayMs: 30_000, anchoredAtMs: 0, nowMs: Number.NaN, expected: 30_000 },
    ]
    for (const testCase of countdownCases) {
      const desktop = desktopLiveRetryDelayMs(testCase.delayMs, testCase.anchoredAtMs, testCase.nowMs)
      const enterprise = enterpriseLiveRetryDelayMs(testCase.delayMs, testCase.anchoredAtMs, testCase.nowMs)
      expect(desktop, `desktop / ${testCase.name}`).toBe(testCase.expected)
      expect(enterprise, `enterprise / ${testCase.name}`).toBe(testCase.expected)
    }

    // 文案真的会动:锚点后 11 秒,两个面都必须显示 19 秒(而不是永远显示 30)。
    setActiveLocale('zh')
    const anchored = { ...snapshot({ receivedBytes: 1024, totalBytes: 4096 }), retryAttempt: 2, retryMaxAttempts: 6, retryDelayMs: 30_000 }
    const later = { ...anchored, retryDelayMs: enterpriseLiveRetryDelayMs(30_000, 0, 11_000) }
    expect(desktopUpdateBadgeView(anchored)?.title).toContain('30 秒后继续')
    expect(desktopUpdateBadgeView(later)?.title).toContain('19 秒后继续')
    expect(downloadingStatusText(anchored)).toContain('30 秒后重试')
    expect(downloadingStatusText(later)).toContain('19 秒后重试')
  })
})
