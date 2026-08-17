import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { CommandUiContract } from '@deepseek-ai/dsh-client-ui-commands/client'
import { ConnectorsList } from './ConnectorsSection.tsx'

/**
 * Connectors client half: exports the connector list surface for the
 * connector center (rendered by the enterprise sidebar panel), and registers
 * one slash command per CONNECTED connector (`/<connector-id>`) so the `/`
 * menu only shows connectors you can act on. Picking an example prompt sends
 * it to the session — the model then calls the connector's injected MCP tools.
 */
export const name = 'pico-connectors-client'

export const inject = ['commandUi', 'sessions']

interface ConnectorEntry {
  id: string
  name: string
  status: string
  examples: string[]
}

const POLL_INTERVAL_MS = 3000

export function apply(ctx: ClientContext): void {
  const commandUi = ctx.get('commandUi') as CommandUiContract
  const sessions = ctx.get('sessions') as { binding(sessionId: string): { session?: { prompt(content: Array<{ type: 'text'; text: string }>, mode: 'queue'): Promise<unknown> } } | undefined }
  const commandDisposers = new Map<string, () => void>()

  const syncCommands = (connectors: ConnectorEntry[]): void => {
    const connected = new Set(connectors.filter((c) => c.status === 'connected').map((c) => c.id))
    for (const [id, dispose] of commandDisposers) {
      if (!connected.has(id)) {
        dispose()
        commandDisposers.delete(id)
      }
    }
    for (const connector of connectors) {
      if (connector.status !== 'connected' || commandDisposers.has(connector.id)) continue
      commandDisposers.set(connector.id, commandUi.register({
        name: connector.id,
        description: `${connector.name}（已连接）`,
        available: () => true,
        ui: {
          kind: 'popupSelect',
          options: async () => {
            const examples = connector.examples ?? []
            return [
              ...examples.map((example, index) => ({ id: `example-${index}`, label: example })),
              { id: 'info', label: '查看连接器信息' },
            ]
          },
          onSelect: async (option, session) => {
            const live = sessions.binding(session.sessionId)?.session
            if (live === undefined) return
            const text = option.id === 'info'
              ? `${connector.name}（已连接）。模型可直接调用其注入工具（mcp__*），例如：${(connector.examples ?? []).join('、')}`
              : option.label
            await live.prompt([{ type: 'text', text }], 'queue')
          },
        },
      }))
    }
  }

  ctx.effect(() => {
    let cancelled = false
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch('/api/pico/connectors')
        if (!res.ok) return
        const data = (await res.json()) as { connectors?: ConnectorEntry[] }
        if (!cancelled) syncCommands(data.connectors ?? [])
      } catch {
        /* host not ready yet; keep polling */
      }
    }
    void poll()
    const timer = setInterval(() => { void poll() }, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
      for (const dispose of commandDisposers.values()) dispose()
    }
  }, 'pico-connectors-client: per-connector slash commands')
}

export { ConnectorsList }
