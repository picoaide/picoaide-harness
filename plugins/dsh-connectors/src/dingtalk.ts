import type { ConnectorDef } from './types.ts'

/**
 * 钉钉 (DingTalk) connector.
 *
 * Auth mirrors WorkBuddy's CLI device-flow: `dws auth login --device` prints
 * a verification URL + user code (parsed via uriPattern/codePattern and shown
 * in the UI), then keeps polling (5s / 900s) until the user authorizes and
 * exits 0. `dws auth status` short-circuits already-authenticated sessions.
 *
 * `dws` is the DingTalk Workspace CLI, installed from the official npm
 * package `dingtalk-workspace-cli` (bin `dws`; note the bare `dws` npm
 * package is an unrelated legacy GIS wrapper and must not be suggested).
 *
 * Tools come from DingTalk's hosted Streamable HTTP MCP services; each
 * `dws mcp url get <mcpId>` call returns the user-scoped endpoint URL for one
 * service (calendar, chat, doc, todo, contact...), registered through
 * mcp-client with the resolved URL.
 */

const MCP_IDS = ['calendar', 'chat', 'doc', 'todo', 'contact'] as const

export const dingTalkDef: ConnectorDef = {
  id: 'dingtalk',
  name: '钉钉',
  description: '钉钉：日历日程、群聊消息、文档、待办、通讯录（DingTalk Workspace CLI）',
  authMode: 'cli',
  auth: {
    command: 'dws',
    args: ['auth', 'login', '--device'],
    installCommand: 'npm install -g dingtalk-workspace-cli',
    deviceFlow: {
      uriPattern: 'https://login\\.dingtalk\\.com/oauth2/device/verify\\.htm[^\\s\\n\\r"\'<>]*',
      codePattern: '(?:授权码|user_code=|user_code：)\\s*:?\\s*([A-Z0-9][A-Z0-9-]*)',
    },
    authWaitForExit: true,
    suppressBrowser: true,
    timeoutMs: 900_000,
    statusCommand: 'dws',
    statusArgs: ['auth', 'status'],
  },
  examples: [
    '查询我明天的日程安排',
    '给张三发送一条钉钉消息',
    '列出我的待办事项',
    '查看团队通讯录里的同事',
  ],
  mcp: MCP_IDS.map((mcpId) => ({
    serverName: `dingtalk-${mcpId}`,
    transport: 'streamable-http',
    urlCommand: ['dws', 'mcp', 'url', 'get', mcpId],
  })),
}
