/**
 * 「关于」页与侧边栏指示器的文案/状态派生。
 *
 * 这些函数是**唯一**判断"已下载可安装 / 下载中(含重试) / 各类失败"的地方:
 * 三个展示面(侧边栏、设置-关于、会话头部徽标)因此不会各写一套判断而给出
 * 互相矛盾的结论(2026-09-12 用户报"两处不同步")。
 */
import { describe, expect, it } from 'vitest'
import {
  downloadingStatusText,
  progressPercent,
  updateActionDisabled,
  updateActionLabel,
  updateStatusText,
  type UpdateState,
} from '../src/client/UpdateIndicator.tsx'

const base: UpdateState = {
  availableVersion: undefined,
  downloadingVersion: undefined,
  downloadProgress: undefined,
  isPackaged: true,
  canDownload: true,
  currentVersion: '2.7.2',
  readyVersion: undefined,
  readyPath: undefined,
  retryAttempt: 0,
  retryMaxAttempts: 5,
  retryDelayMs: 0,
  lastError: undefined,
}

describe('update status copy', () => {
  it('reports a downloaded installer as installable', () => {
    const state = { ...base, availableVersion: '2.8.0', readyVersion: '2.8.0', readyPath: '/tmp/i' }
    expect(updateStatusText(state)).toContain('已下载')
    expect(updateActionLabel(state, false)).toBe('安装更新')
    expect(updateActionDisabled(state, false)).toBe(false)
  })

  it('reports download progress and the retry countdown', () => {
    const downloading = {
      ...base,
      availableVersion: '2.8.0',
      downloadingVersion: '2.8.0',
      downloadProgress: { receivedBytes: 25, totalBytes: 100 },
      retryAttempt: 2,
    }
    expect(progressPercent(downloading)).toBe('25%')
    expect(updateStatusText(downloading)).toContain('25%')
    expect(updateActionLabel(downloading, false)).toBe('下载中…')
    expect(updateActionDisabled(downloading, false)).toBe(true)

    expect(downloadingStatusText({ ...downloading, retryDelayMs: 8_000 })).toContain('8 秒后重试')
    expect(downloadingStatusText({ ...downloading, retryDelayMs: 0 })).toContain('第 2/5 次')
  })

  it('explains every failure category instead of claiming the app is current', () => {
    expect(updateStatusText({ ...base, lastError: 'not-signed-in' })).toContain('请先登录')
    expect(updateStatusText({ ...base, lastError: 'network' })).toContain('网络不可达')
    expect(updateStatusText({ ...base, lastError: 'checksum-mismatch' })).toContain('校验不一致')
    expect(updateStatusText({ ...base, lastError: 'invalid-artifact' })).toContain('格式不正确')
    expect(updateStatusText({ ...base, lastError: 'server-unavailable' })).toContain('联系管理员')
    expect(updateStatusText({ ...base, lastError: 'release-missing' })).toContain('缺少可下载安装包')
    expect(updateStatusText(base)).toBe('已是最新版本')
  })

  it('treats a missing snapshot as up to date', () => {
    expect(updateStatusText(null)).toBe('已是最新版本')
    expect(updateActionLabel(null, false)).toBe('检查更新')
    expect(progressPercent(null)).toBeUndefined()
  })
})
