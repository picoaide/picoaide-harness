/**
 * Project-scoped group identity (v4.1, 2026-09-07 修正): the browser groups
 * by PROJECT (workspace), not by chat session — one project = one tab group;
 * the group name IS the project name. Sessions of the same project share the
 * group (parallel driving is serialized inside the group); different projects
 * are fully isolated (foreign-tab). Subagents inherit their parent session's
 * cwd (fork lineage), so project resolution needs no lineage walk.
 * @module @picoaide/dsh-browser
 */

/** Opaque session identity (DSH SessionId string). */
export type SessionId = string

/** Group key = project identity (canonical cwd, or a session fallback). */
export type GroupKey = string

/** Project key prefix for the session-level fallback (no cwd available). */
export const SESSION_KEY_PREFIX = 'session:'

/** The live agent shape we inspect for project info (structural, defensive —
 * the declared Agent interface carries `id`; session internals are reached
 * through runtime-augmented fields that vary across DSH versions). */
export interface AgentProjectInfo {
  id: SessionId
  session?: {
    header?: { cwd?: string }
    meta?: { cwd?: string }
    cwd?: string
  }
}

/** Canonicalize a cwd path into a stable group key (no trailing slash). */
export function canonicalProjectKey(cwd: string): string {
  let path = cwd
  try {
    path = path.trim().replace(/\\/g, '/')
  } catch {
    /* raw string fallback */
  }
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  return `proj:${path}`
}

/** Session-level fallback key (used only when no cwd is resolvable). */
export function sessionFallbackKey(sessionId: SessionId): GroupKey {
  return `${SESSION_KEY_PREFIX}${sessionId}`
}

/**
 * Resolve the project group key for a tool call: prefer the agent session's
 * working directory (the project); fall back to a per-session group when no
 * cwd exists. `undefined` when no agent identity is available (callers throw
 * `no-session`).
 */
export function projectKeyFrom(agent: AgentProjectInfo | undefined): GroupKey | undefined {
  if (agent === undefined || typeof agent.id !== 'string' || agent.id === '') return undefined
  const cwd = agent.session?.header?.cwd ?? agent.session?.meta?.cwd ?? agent.session?.cwd
  if (typeof cwd === 'string' && cwd.trim() !== '') return canonicalProjectKey(cwd)
  return sessionFallbackKey(agent.id)
}

/** Group display name: title first, then the directory name, then a default. */
export function projectLabelFrom(title: string | undefined, cwd: string | undefined): string {
  if (title !== undefined && title.trim() !== '') return title.trim()
  if (cwd !== undefined && cwd.trim() !== '') {
    const parts = cwd.trim().replace(/\\/g, '/').split('/').filter(Boolean)
    const last = parts.at(-1)
    if (last !== undefined && last !== '') return last
  }
  return '未命名项目'
}

/**
 * Lineage registry (kept for session-level bookkeeping and future use):
 * sessionId → top-level parent session id. Subagent project resolution does
 * NOT depend on this (cwd is inherited), but session/oplog attribution does.
 */
export class SessionLineage {
  private readonly parents = new Map<SessionId, SessionId>()
  private readonly roots = new Map<SessionId, SessionId>()

  registerLineage(child: SessionId, parent: SessionId): void {
    if (child === parent || child === '' || parent === '') return
    this.parents.set(child, parent)
    this.roots.delete(child)
    this.roots.delete(parent)
  }

  forget(sessionId: SessionId): void {
    this.parents.delete(sessionId)
    this.roots.delete(sessionId)
  }

  resolve(sessionId: SessionId): SessionId {
    const cached = this.roots.get(sessionId)
    if (cached !== undefined) return cached
    // Walk up the chain (cycle-safe); CACHE EVERY HOP so mutually-recursive
    // registrations resolve to one consistent root from either direction.
    const chain: SessionId[] = []
    let current: SessionId | undefined = sessionId
    while (current !== undefined) {
      if (chain.includes(current)) break
      chain.push(current)
      current = this.parents.get(current)
    }
    const root = chain.at(-1) ?? sessionId
    for (const hop of chain) this.roots.set(hop, root)
    return root
  }

  rootsOf(): Set<SessionId> {
    const keys = new Set<SessionId>(this.roots.values())
    for (const child of this.parents.keys()) keys.add(this.resolve(child))
    return keys
  }

  get size(): number {
    return this.parents.size + this.roots.size
  }
}

/** Legacy convenience kept for back-compat tests: resolve via lineage only. */
export function resolveGroupKey(lineage: SessionLineage, agentId: string | undefined): GroupKey | undefined {
  if (agentId === undefined || agentId === '') return undefined
  return sessionFallbackKey(lineage.resolve(agentId))
}
