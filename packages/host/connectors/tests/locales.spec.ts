import { describe, expect, it } from 'vitest'
import { friendlyConnectorError } from '../src/client/locales.ts'

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
