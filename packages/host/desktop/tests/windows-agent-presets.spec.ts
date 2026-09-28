import { Context } from '@deepseek-ai/cordis'
import { createVolatile } from '@deepseek-ai/cosmokit'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WindowsAgentPresets,
  WINDOWS_SAFE_PRESET,
  WINDOWS_UNSUPPORTED_PRESET,
} from '../src/windows-agent-presets.ts'

const contexts: Context[] = []

/**
 * Build the Windows registry with the shipped preset ids declared.
 *
 * Upstream 0.1.7 made presets **declarative**: each one is a
 * `@deepseek-ai/dsh-agent-preset` row that registers its definition with this
 * registry, so the test declares them the same way instead of writing
 * `agent.cordis.yml` files into a filesystem root (that roster is gone).
 * @param ids - preset ids to declare.
 * @param defaultId - deployment default for the next session.
 * @returns an activated registry.
 */
async function createRegistry(ids: readonly string[], defaultId: string): Promise<WindowsAgentPresets> {
  const ctx = new Context()
  // The 0.1.7 registry resolves composition-relative plugin names under a base
  // URL and registers a session projection in its constructor; a bare test
  // context carries neither, so both are supplied here.
  ;(ctx as unknown as { baseUrl?: string }).baseUrl = new URL('../', import.meta.url).href
  ;(ctx as unknown as { sessionProjections?: { register: () => void } }).sessionProjections = { register: () => {} }
  contexts.push(ctx)
  const registry = new WindowsAgentPresets(ctx, {
    default: defaultId,
    selectedDefault: createVolatile<string | undefined>(undefined),
  })
  for (const id of ids) await registry.register({ id, plugins: [] })
  return registry
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('Windows agent preset guard', () => {
  it('hides the unsupported minimal preset from discovery', async () => {
    const presets = await createRegistry(['standard', WINDOWS_UNSUPPORTED_PRESET, 'code'], WINDOWS_SAFE_PRESET)

    expect((await presets.list()).map(preset => preset.id)).toEqual([
      'code',
      WINDOWS_SAFE_PRESET,
    ])
  })

  it('falls back to standard when minimal was saved as the default', async () => {
    const presets = await createRegistry([WINDOWS_SAFE_PRESET, WINDOWS_UNSUPPORTED_PRESET], WINDOWS_UNSUPPORTED_PRESET)

    expect(presets.defaultId).toBe(WINDOWS_SAFE_PRESET)
    await expect(presets.resolve()).resolves.toMatchObject({ id: WINDOWS_SAFE_PRESET })
  })

  it('preserves exact resolution for legacy sessions that recorded minimal', async () => {
    const presets = await createRegistry([WINDOWS_SAFE_PRESET, WINDOWS_UNSUPPORTED_PRESET], WINDOWS_SAFE_PRESET)

    await expect(presets.resolve(WINDOWS_UNSUPPORTED_PRESET))
      .resolves.toMatchObject({ id: WINDOWS_UNSUPPORTED_PRESET })
  })

  it('rejects switching a blank session to the hidden minimal preset', async () => {
    const presets = await createRegistry([WINDOWS_SAFE_PRESET, WINDOWS_UNSUPPORTED_PRESET], WINDOWS_SAFE_PRESET)
    const agentCtx = new Context()
    contexts.push(agentCtx)

    await expect(presets.recompose(agentCtx, WINDOWS_UNSUPPORTED_PRESET))
      .rejects.toBeInstanceOf(RemoteError)
  })
})
