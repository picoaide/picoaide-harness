/**
 * Session → group identity resolution (v4 §3): every browser tool resolves
 * the calling session's group key before touching tabs. Subagents inherit
 * their top-level parent session's group through an explicit lineage table
 * (fed by session-creation events; a missing entry falls back to the agent's
 * own id — safe, never privileges-crossing).
 * @module @picoaide/dsh-browser
 */

/** Opaque session identity (DSH SessionId string). */
export type SessionId = string

/** Group key = top-level session id. */
export type GroupKey = SessionId

/** Badge/label source priority: explicit rename > session title > short id. */
export function groupLabelFrom(title: string | undefined, sessionId: SessionId): string {
  if (title !== undefined && title.trim() !== '') return title.trim()
  return `会话 ${sessionId.slice(0, 6)}`
}

/**
 * Lineage registry: sessionId → top-level parent session id. Populated from
 * session-creation metadata (meta.parentSession + origin:'subagent'); the
 * resolver walks the chain to the root and caches every hop.
 */
export class SessionLineage {
  private readonly parents = new Map<SessionId, SessionId>()
  private readonly roots = new Map<SessionId, GroupKey>()

  /** Record a parent link (non-authoritative: unknown parents are ignored). */
  registerLineage(child: SessionId, parent: SessionId): void {
    if (child === parent || child === '' || parent === '') return
    this.parents.set(child, parent)
    this.roots.delete(child)
    this.roots.delete(parent)
  }

  /** Remove a session's entries (session destroyed / group recycled). */
  forget(sessionId: SessionId): void {
    this.parents.delete(sessionId)
    this.roots.delete(sessionId)
  }

  /** Resolve a session id to its top-level group key; returns the id itself
   * when it is a root or no lineage is known (safe fallback: own group). */
  resolve(sessionId: SessionId): GroupKey {
    const cached = this.roots.get(sessionId)
    if (cached !== undefined) return cached
    const chain: SessionId[] = []
    let current = sessionId
    const seen = new Set<SessionId>()
    while (true) {
      if (seen.has(current)) break // defensive: cycle guard
      seen.add(current)
      chain.push(current)
      const parent = this.parents.get(current)
      if (parent === undefined || seen.has(parent)) break
      current = parent
    }
    const root = current
    for (const hop of chain) this.roots.set(hop, root)
    return root
  }

  /** All known root keys (for registry cleanup). */
  rootsOf(): Set<GroupKey> {
    const keys = new Set<GroupKey>(this.roots.values())
    for (const [child, parent] of this.parents) {
      keys.add(this.resolve(child))
      void parent
    }
    return keys
  }

  /** Size diagnostics (tests). */
  get size(): number {
    return this.parents.size + this.roots.size
  }
}

/**
 * Resolve the group key for a tool call. `agentId` is the calling session
 * (`exec.agent.id`); missing it (non-agent context) is an error at the tool
 * layer (no-session), handled by callers — this resolver never throws.
 */
export function resolveGroupKey(lineage: SessionLineage, agentId: string | undefined): GroupKey | undefined {
  if (agentId === undefined || agentId === '') return undefined
  return lineage.resolve(agentId)
}
