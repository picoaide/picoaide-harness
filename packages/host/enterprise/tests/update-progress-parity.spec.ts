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
 * total = 0 / total 未知(显示已下载字节数)。
 */
import { describe, expect, it } from 'vitest'
import { progressPercent, downloadingStatusText, type UpdateState } from '../src/client/UpdateIndicator.tsx'
import { desktopUpdateBadgeView, updateProgressPercent } from '../../desktop/src/client/desktop-update.tsx'
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
})
