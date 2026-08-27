import type { ConnectorDef } from '../types.ts';
/**
 * GlitchTip 错误追踪连接器(审计新增 2026-08)。
 *
 * 通过官方社区 MCP server `glitchtip-mcp`(npm,stdio)接入——查询 issue /
 * 最新事件堆栈。认证方式 token,字段值经 connector store 的 fields 持久化,
 * 并原样注入 stdio MCP 进程的 env(env 渲染 = server.env ∪ credential.fields,
 * 见 index.ts registerConnectorMcp,用户填写值优先)。
 *
 * 注意(安全约束 2026-08):部署地址(BASE_URL)属于部署环境配置,一律由
 * 用户在连接时填写,不得写死在源码/默认值中——源码仓库不得包含任何
 * 自部署实例的主机名。
 */
export declare const glitchTipDef: ConnectorDef;
