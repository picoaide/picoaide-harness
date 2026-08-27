import type { ConnectorDef } from '../types.ts'

/**
 * GlitchTip 错误追踪连接器(审计新增 2026-08):
 * 自托管 GlitchTip(https://GLITCHTIP_DEPLOY_HOST)通过官方社区 MCP server
 * `glitchtip-mcp`(npm,stdio)接入——查询 issue / 最新事件堆栈。
 *
 * 认证方式 token:用户填 API token(GlitchTip 管理面板 Auth Tokens 创建,
 * 需 org/project/event read 权限)+ 组织 slug;字段值经 connector store 的
 * fields 持久化,并原样注入 stdio MCP 进程的 env(env 渲染 =
 * server.env ∪ credential.fields,见 index.ts registerConnectorMcp,
 * 用户填写值优先)。
 */
export const glitchTipDef: ConnectorDef = {
  id: 'glitchtip',
  name: 'GlitchTip',
  description: 'GlitchTip(Sentry 兼容错误追踪):查询 issue 与最新事件堆栈,用于错误排查与监控告警',
  authMode: 'token',
  tokenFields: [
    { key: 'GLITCHTIP_TOKEN', label: 'API Token(Auth Tokens 页创建,需 org:read / project:read / event:read)', type: 'password', required: true },
    { key: 'GLITCHTIP_ORGANIZATION', label: '组织 slug(如 picoaide)', type: 'text', required: true },
  ],
  examples: [
    '查询当前未解决的错误 issue',
    '查看最近一次异常的堆栈详情',
    '列出错误追踪中的高优先级问题',
  ],
  mcp: [
    {
      serverName: 'glitchtip',
      transport: 'stdio',
      // 官方社区 MCP server: npx -y glitchtip-mcp(见 vltansky/glitchtip-mcp)
      command: 'npx',
      args: ['-y', 'glitchtip-mcp'],
      // 静态默认:自部署地址;用户若在设置中填 GLITCHTIP_BASE_URL 可覆盖
      env: {
        GLITCHTIP_BASE_URL: 'https://GLITCHTIP_DEPLOY_HOST',
      },
    },
  ],
}
