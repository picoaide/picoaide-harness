/**
 * 应用窗口 chrome 文案的逐字断言（接缝 J12）。
 *
 * 这些串是设计总纲 §7.2/§19 Q3/Q9/Q12/Q15 冻结文案的落地形态：客户端包里各有一份
 * （应用中心/分享/空态），两侧**不共享模块**（跨 bundle import 在 tsdown 打包后会指向
 * 不存在的路径），所以每侧都必须有**独立**断言 —— 任一侧被改写，本用例必红。
 *
 * 变异验证：把 `frozenAppTitle` 改成"应用不存在" ⇒ 必红（两档文案必须可区分）。
 */
import { describe, expect, it } from 'vitest'
import {
  downloadStartedNotice,
  externalLinkNotice,
  frozenAppHint,
  frozenAppTitle,
  loadingSkeletonTitle,
  missingAppTitle,
  onboardingCard,
  retiredAppTitle,
  retryAction,
  signInAgainAction,
  versionUnverifiedBanner,
} from './app-window-copy.ts'

describe('应用窗口 chrome 文案（J12：设计总纲为唯一真源）', () => {
  it('外链提示条与下载反馈按 §19 Q9 的冻结口径给出', () => {
    expect(externalLinkNotice('zh', 'example.com')).toBe('已在浏览器窗口中打开 example.com')
    expect(externalLinkNotice('en', 'example.com')).toBe('Opened example.com in the browser window')
    expect(downloadStartedNotice('zh')).toBe('已开始下载，进度见浏览器窗口')
    expect(downloadStartedNotice('en')).toBe('Download started — see the browser window for progress')
  })

  it('骨架屏文案带上应用名（先开窗骨架屏 → 校验回来再加载，§19 Q12）', () => {
    expect(loadingSkeletonTitle('zh', '记事本')).toBe('正在打开 记事本…')
    expect(loadingSkeletonTitle('en', 'Notes')).toBe('Opening Notes…')
  })

  it('冻结 / 下架 / 不存在三档必须彼此可辨（§19 Q3：不说"应用不存在"）', () => {
    const frozen = frozenAppTitle('zh')
    expect(frozen).toBe('应用已被管理员停用')
    expect(frozenAppTitle('en')).toBe('This app has been disabled by an administrator')
    expect(retiredAppTitle('zh')).toBe('应用已下架')
    expect(missingAppTitle('zh')).toBe('应用不存在')
    expect(new Set([frozen, retiredAppTitle('zh'), missingAppTitle('zh')]).size).toBe(3)
    expect(frozenAppHint('zh')).toContain('管理员')
    expect(frozenAppHint('en')).toContain('administrator')
  })

  it('软闸门横幅与重试/重登动作与 §5.1b/§7.6 一致', () => {
    expect(versionUnverifiedBanner('zh')).toContain('无法确认最新版本')
    expect(versionUnverifiedBanner('en')).toContain('latest version')
    expect(retryAction('zh')).toBe('重试')
    expect(signInAgainAction('zh')).toBe('重新登录')
    expect(signInAgainAction('en')).toBe('Sign in again')
  })

  it('一次性引导卡三条齐全（§19 Q15），中英各自完整', () => {
    const zh = onboardingCard('zh')
    expect(zh).toHaveLength(3)
    expect(zh.map(item => item.title)).toEqual(['什么是应用', '怎么让 AI 做一个', '怎么分享'])
    for (const item of zh) expect(item.body.length).toBeGreaterThan(0)
    const en = onboardingCard('en')
    expect(en).toHaveLength(3)
    expect(en.every(item => item.title !== '' && item.body !== '')).toBe(true)
    // 语言**按调用**解析（同一进程内切换无需重新 apply）——本仓已记录两次模块级冻结的 bug。
    expect(onboardingCard('en')[0]?.title).not.toBe(zh[0]?.title)
  })
})
