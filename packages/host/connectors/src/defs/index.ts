import type { ConnectorDef } from '../types.ts'
import { def as beisen_cliDef } from './beisen-cli.ts'
import { def as feishuDef } from './feishu.ts'
import { def as mokaDef } from './moka.ts'
import { def as wecomDef } from './wecom.ts'

/** Curated marketplace connector definitions (wecom / feishu / moka / beisen-cli). */
export const marketplaceDefs: ConnectorDef[] = [
  beisen_cliDef,
  feishuDef,
  mokaDef,
  wecomDef,
]
