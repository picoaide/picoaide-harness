import { fetchJSON } from './auth.ts'
import type { BootstrapConfig, Session } from './config.ts'

export const EMPTY: BootstrapConfig = { default_model: '', models: [], skills: [], mcp: [], web: { allow_private: false, search_endpoint: '' } }

export function validateBootstrap(cfg: BootstrapConfig | null | undefined): { config: BootstrapConfig; fellBack: boolean } {
  if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.models) || cfg.models.length === 0) {
    return { config: EMPTY, fellBack: true }
  }
  if (cfg.models.some((m) => m.id === cfg.default_model)) {
    return { config: cfg, fellBack: false }
  }
  return { config: { ...cfg, default_model: cfg.models[0]!.id }, fellBack: true }
}

export async function getBootstrap(session: Session): Promise<{ config: BootstrapConfig; fellBack: boolean }> {
  const data = (await fetchJSON(session.serverURL, '/api/client/v2/config/bootstrap', { token: session.token })) as BootstrapConfig
  return validateBootstrap(data)
}
