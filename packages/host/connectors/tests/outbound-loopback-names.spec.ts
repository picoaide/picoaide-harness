/**
 * R3(2026-09-13 审计):出站策略与 Go 侧 `connectorURLAllowed` 的口径必须一致。
 *
 * 修复前 `classifyHost('localhost')` 在 isIP()==0 分支直接返回 'name',于是
 * 下面的"http 但主机不是回环"把 `http://localhost:PORT/mcp` 判掉——管理员能在
 * webadmin 保存这条连接器(Go 侧把 localhost 当回环),客户端却静默丢弃。
 * 同一轮还归一了 FQDN 根点(`host.` 与 `host` 解析到同一目标)。
 * 这里同时确认:名字型元数据主机(含带根点写法)仍被拦、非回环 http 仍被拦。
 */
import { describe, expect, it } from 'vitest'
import { assertOutboundUrlAllowed, OutboundUrlBlockedError } from '../src/outbound.ts'

describe('出站主机分类:回环名单与 Go 侧同口径', () => {
  it('localhost / *.localhost / 带根点的 http 视为回环,放行', () => {
    for (const url of [
      'http://localhost:3000/mcp',
      'http://LOCALHOST:3000/mcp',
      'http://localhost.:3000/mcp',
      'http://mcp.localhost:8080/mcp',
      'http://127.0.0.1:3000/mcp',
      'http://[::1]:3000/mcp',
    ]) {
      expect(assertOutboundUrlAllowed(url, 'MCP 端点').host, url).toBeTruthy()
    }
  })

  it('非回环主机的 http 仍被拒(策略未放宽)', () => {
    for (const url of ['http://example.com/mcp', 'http://10.0.0.5:3000/mcp', 'http://192.168.1.9/mcp']) {
      expect(() => assertOutboundUrlAllowed(url, 'MCP 端点'), url).toThrow(OutboundUrlBlockedError)
    }
  })

  it('名字型元数据主机被拦,带根点写法同样被拦', () => {
    for (const url of [
      'https://metadata.google.internal/computeMetadata/v1/',
      'https://metadata.google.internal./computeMetadata/v1/',
      'https://instance-data/latest/meta-data/',
      'https://metadata.goog/',
    ]) {
      expect(() => assertOutboundUrlAllowed(url, 'MCP 端点'), url).toThrow(OutboundUrlBlockedError)
    }
    // `localhost` 不是元数据主机名 —— 防止分支顺序被改成"先回环判定后名单"。
    expect(assertOutboundUrlAllowed('https://localhost:8443/mcp', 'MCP 端点').host).toBe('localhost:8443')
  })
})
