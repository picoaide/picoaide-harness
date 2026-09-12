/**
 * P2-23 regression: the boot restore and every session change go through one
 * serialized lifecycle queue, and re-registering the same MCP server key
 * retires the previous registration. Before the fix, two entry points could
 * interleave — the previous user's restore registered its MCP servers after
 * the new user's teardown, leaking connections and duplicating tools.
 *
 * FIX-02: the stdio definitions used here now need a local confirmation before
 * their first spawn, which is orthogonal to the lifecycle ordering under test —
 * the harness therefore answers the confirmation programmatically (the same
 * "already approved" path an interactive user reaches after clicking 允许).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'

// The real MCP client factory imports an optional subprocess carrier that is
// not resolvable from this package's isolated node_modules; the fake ctx.plugin
// never executes it, but importing/executing it must not fail the test.
vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))
import { ConnectorStore } from '../src/store.ts'
import type { ConnectorDef } from '../src/types.ts'

function def(id: string, serverName: string): ConnectorDef {
  return {
    id,
    name: id,
    description: `${id} connector`,
    authMode: 'token',
    mcp: [{ serverName, transport: 'stdio', command: 'node', args: [] }],
  }
}

interface Fiber {
  readonly dispose: ReturnType<typeof vi.fn>
}

interface Harness {
  readonly plugin: ReturnType<typeof vi.fn>
  readonly fibers: Fiber[]
  readonly emitSession: (session: { username?: string; token?: string; serverURL?: string } | null) => void
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

function createHarness(connectors: ConnectorDef[], storeBaseDir: string): Harness {
  const fibers: Fiber[] = []
  const sessionHandlers: Array<(next: unknown) => void> = []
  const effectDisposers: Array<() => void> = []
  let username: string | null = 'user-a'
  const plugin = vi.fn(async () => {
    const fiber: Fiber = { dispose: vi.fn() }
    fibers.push(fiber)
    return fiber
  })
  const ctx = {
    get: (name: string) => name === 'picoSession'
      // No token/serverURL: syncServerDefs returns immediately (no network).
      ? { getSession: () => (username === null ? null : { username }) }
      : undefined,
    on: (event: string, handler: (next: unknown) => void) => {
      if (event === 'pico/session-changed') sessionHandlers.push(handler)
      return () => {}
    },
    plugin,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    effect: (register: () => (() => void) | undefined) => {
      const dispose = register()
      if (typeof dispose === 'function') effectDisposers.push(dispose)
      return () => {}
    },
    webServer: { register: () => () => {} },
  } as unknown as Context

  apply(ctx, { connectors, storeBaseDir, requestApproval: () => true })
  cleanups.push(async () => { for (const dispose of effectDisposers) dispose() })
  return {
    plugin,
    fibers,
    emitSession: (session) => {
      username = session?.username ?? null
      for (const handler of [...sessionHandlers]) handler(session)
    },
  }
}

async function seedStore(dir: string, ids: string[]): Promise<void> {
  const store = new ConnectorStore({ baseDir: dir })
  for (const id of ids) await store.writeCredential(id, { accessToken: `tok-${id}`, updatedAt: Date.now() })
}

describe('connectors lifecycle serialization (P2-23)', () => {
  it('supersedes an older session change instead of restoring twice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pico-conn-lifecycle-'))
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
    const harness = createHarness([def('demo', 'demo-server')], dir)
    // Let the boot restore settle before the credential exists (it registers
    // nothing), so the count below belongs to the session changes alone.
    await new Promise(resolve => setTimeout(resolve, 20))
    await seedStore(dir, ['demo'])

    harness.emitSession({ username: 'user-a' })
    harness.emitSession({ username: 'user-b' })

    await vi.waitFor(() => { expect(harness.plugin).toHaveBeenCalled() })
    await new Promise(resolve => setTimeout(resolve, 30))
    // Only the newest session change ran; the superseded one never registered.
    expect(harness.plugin).toHaveBeenCalledTimes(1)
    expect(harness.fibers).toHaveLength(1)
    expect(harness.fibers[0]!.dispose).not.toHaveBeenCalled()
  })

  it('disposes the previous registration when the same server key is registered again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pico-conn-rekey-'))
    cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
    // Two connectors exposing the SAME MCP server name: one restore pass
    // registers the key twice, so the old disposer must not be overwritten.
    const harness = createHarness([def('demo-a', 'shared-server'), def('demo-b', 'shared-server')], dir)
    await new Promise(resolve => setTimeout(resolve, 20))
    await seedStore(dir, ['demo-a', 'demo-b'])

    harness.emitSession({ username: 'user-a' })
    await vi.waitFor(() => { expect(harness.fibers).toHaveLength(2) })
    await new Promise(resolve => setTimeout(resolve, 30))

    expect(harness.fibers[0]!.dispose).toHaveBeenCalledTimes(1)
    const live = harness.fibers.filter(fiber => fiber.dispose.mock.calls.length === 0)
    expect(live).toHaveLength(1)
  })
})
