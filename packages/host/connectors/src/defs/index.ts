import type { ConnectorDef } from '../types.ts'
import { def as mokaDef } from './moka.ts'
import { glitchTipDef } from './glitchtip.ts'

/**
 * Marketplace connector definitions (决策 2026-08-25:CLI 连接器已移除——
 * CLI 即 skill,由技能市场承载;连接器只保留 MCP 类)。
 */
export const marketplaceDefs: ConnectorDef[] = [
  mokaDef,
  glitchTipDef,
]
