import { afterEach, describe, expect, it } from 'vitest'
import { CONNECTOR_ERROR_CODES, connectorErrorCodeOf, withConnectorErrorCode } from '../src/connector-error.ts'
import { friendlyConnectorError } from '../src/client/friendly-error.ts'
import { setActiveLocale, t } from '../src/client/locales.ts'
import { statusLabel } from '../src/client/status-label.ts'

afterEach(() => { setActiveLocale('zh') })

/**
 * 2026-09-16 i18n 契约：friendly-error 只认**语言无关**的信号 —— Host 下发的稳定
 * code，加上 OS 级的 `ENOENT`。旧实现按中文字串匹配，Host 文案一旦随语言走就会
 * 在英文界面下全部落空（具体错误退化成通用兜底）。
 */
describe('friendlyConnectorError：稳定 code 契约', () => {
  it('auth-required 原样透出（Host 的授权类文案本身已说明该做什么）', () => {
    const raw = '需要先完成授权：当前凭据被服务端拒绝（点击「连接」重新授权）'
    expect(friendlyConnectorError(raw, 'auth-required')).toBe(raw)
    // 英文界面下同样透出（不再因为文案里没有「授权」二字而退化成兜底）
    setActiveLocale('en')
    const english = 'Authorization is required first: the server rejected the current credential'
    expect(friendlyConnectorError(english, 'auth-required')).toBe(english)
  })

  it('command-missing / download 原样透出（Node 侧已带安装命令等具体信息）', () => {
    const missing = '未找到命令 beisen-cli，请先安装：npm install -g beisen-cli'
    expect(friendlyConnectorError(missing, 'command-missing')).toBe(missing)
    expect(friendlyConnectorError('下载失败：连接超时', 'download')).toBe('下载失败：连接超时')
  })

  it('exit-code 映射到友好文案，且跟随客户端语言', () => {
    expect(friendlyConnectorError('登录命令退出码 1', 'exit-code')).toBe('登录命令失败：请确认已安装对应命令行工具并完成登录，然后重试')
    setActiveLocale('en')
    expect(friendlyConnectorError('login exited with code 1', 'exit-code'))
      .toBe('Login command failed: make sure the corresponding CLI is installed and signed in, then retry')
  })

  it('ENOENT 是与语言无关的兜底判据（不带 code 也认）', () => {
    expect(friendlyConnectorError('spawn dws ENOENT')).toBe('未找到登录命令：请先安装对应命令行工具')
    setActiveLocale('en')
    expect(friendlyConnectorError('spawn dws ENOENT')).toBe('Login command not found: install the corresponding CLI first')
  })

  it('什么都不匹配的原始信息回落到通用兜底，且信息不丢', () => {
    expect(friendlyConnectorError('boom')).toBe('连接失败：boom')
    setActiveLocale('en')
    expect(friendlyConnectorError('boom')).toBe('Connection failed: boom')
    // code 契约优先：带 code 的消息永远走 code。没有 code 的**新式本地化文案**
    // 仍然走兜底（英文里没有下文这些 legacy 中文标记）。
    expect(friendlyConnectorError('Login command exited with code 1')).toBe('Connection failed: Login command exited with code 1')
    // 旧 Host / 外部 CLI 的 legacy 中文标记在兜底顺序最末仍被识别（回退即用户
    // 可见退化），但这不再是新生产者的契约。
    expect(friendlyConnectorError('登录命令退出码 1')).toBe('Login command failed: make sure the corresponding CLI is installed and signed in, then retry')
  })

  it('raw 文本里的 $ 序列不被替换语义吞掉（远端/CLI 文本直插 error.generic）', () => {
    expect(friendlyConnectorError("boom $& $' $$HOME")).toBe("连接失败：boom $& $' $$HOME")
  })
})

describe('connector-error：code 的读取形状', () => {
  it('接受 ConnectorError 实例、带 code/errorCode 的普通对象与裸 code', () => {
    const error = withConnectorErrorCode(new Error('x'), 'auth-required')
    expect(connectorErrorCodeOf(error)).toBe('auth-required')
    expect(connectorErrorCodeOf({ errorCode: 'download' })).toBe('download')
    expect(connectorErrorCodeOf('exit-code')).toBe('exit-code')
    expect(connectorErrorCodeOf({ code: 'ABORT_ERR' })).toBeUndefined()
    expect(connectorErrorCodeOf(new Error('plain'))).toBeUndefined()
  })

  it('枚举里没有拼写错误（Host 与 client 共用同一份定义）', () => {
    expect([...CONNECTOR_ERROR_CODES]).toEqual(['auth-required', 'exit-code', 'command-missing', 'download'])
  })
})

describe('2026-09-15 BUG-07：英文界面下不再残留中文', () => {
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
