import { afterEach, describe, expect, it } from 'vitest'
import { friendlyConnectorError } from '../src/client/friendly-error.ts'
import { setActiveLocale, t } from '../src/client/locales.ts'
import { statusLabel } from '../src/client/status-label.ts'

afterEach(() => { setActiveLocale('zh') })

describe('friendlyConnectorError', () => {
  it('passes through the node-side missing-command hint with the install command', () => {
    expect(friendlyConnectorError('未找到命令 beisen-cli，请先安装：npm install -g beisen-cli'))
      .toBe('未找到命令 beisen-cli，请先安装：npm install -g beisen-cli')
    expect(friendlyConnectorError('未找到命令 dws，请确认已安装该命令行工具并加入 PATH'))
      .toBe('未找到命令 dws，请确认已安装该命令行工具并加入 PATH')
  })

  it('keeps the generic fallback for bare ENOENT errors', () => {
    expect(friendlyConnectorError('spawn dws ENOENT')).toBe('未找到登录命令：请先安装对应命令行工具')
  })

  it('maps non-zero CLI exits and passes through auth errors', () => {
    expect(friendlyConnectorError('登录命令退出码 1')).toBe('登录命令失败：请确认已安装对应命令行工具并完成登录，然后重试')
    expect(friendlyConnectorError('登录命令超时（300s）')).toBe('登录命令超时（300s）')
    expect(friendlyConnectorError('boom')).toBe('连接失败：boom')
  })
})

describe('2026-09-15 BUG-07：英文界面下不再残留中文', () => {
  it('friendlyConnectorError 的两条兜底文案跟随 locale', () => {
    setActiveLocale('en')
    expect(friendlyConnectorError('spawn dws ENOENT')).toBe('Login command not found: install the corresponding CLI first')
    expect(friendlyConnectorError('登录命令退出码 1')).toBe('Login command failed: make sure the corresponding CLI is installed and signed in, then retry')
    expect(friendlyConnectorError('boom')).toBe('Connection failed: boom')
    // 透传分支不受语言影响
    expect(friendlyConnectorError('未找到命令 dws')).toBe('未找到命令 dws')
  })

  it('中文界面保持原文案（默认语言不回归）', () => {
    expect(friendlyConnectorError('boom')).toBe('连接失败：boom')
    expect(t('status.connected')).toBe('已连接')
  })
})

describe('2026-09-15 BUG-07：状态列文案在渲染期取（判别力用例）', () => {
  it('切语言后状态标签立刻跟随（回退成模块级常量即红）', () => {
    setActiveLocale('zh')
    expect(statusLabel('connected')).toBe('已连接')
    expect(statusLabel('unauthorized')).toBe('需要授权')
    setActiveLocale('en')
    // 旧实现的根因就在这里：标签在模块求值期被捕获，切 en 后仍是中文。
    expect(statusLabel('connected')).toBe('Connected')
    expect(statusLabel('unauthorized')).toBe('Authorization required')
    expect(statusLabel('connecting')).toBe('Connecting…')
  })

  it('未知状态原样透出（不吞信息）', () => {
    setActiveLocale('en')
    expect(statusLabel('brand-new-state')).toBe('brand-new-state')
  })
})
