/**
 * A REAL MCP stdio server used as the "ordinary npx/uvx-class connector" target
 * of the spawn regressions.
 *
 * It is a genuine `@modelcontextprotocol/sdk` server on a real stdio transport:
 * the test process connects to it with the SDK `Client` and calls `probe_echo`,
 * so the assertions cover the whole approve -> spawn -> tools/call path rather
 * than a mock.
 *
 * Two side channels make the child observable:
 *  - `PROBE_ENV_OUT`: the complete child environment is dumped there, so a test
 *    can read what the child ACTUALLY received (not what the config claimed);
 *  - `PROBE_LOAD_HOOK`: written by the `--import=data:` payload a poisoned
 *    `NODE_OPTIONS` would smuggle in — its existence is the code-execution proof.
 */
import { writeFileSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const out = process.env.PROBE_ENV_OUT
if (out) writeFileSync(out, JSON.stringify(process.env, null, 2))

const server = new Server({ name: 'probe-server', version: '1.0.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'probe_echo',
    description: 'echo back text',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  }],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => ({
  content: [{
    type: 'text',
    text: `echo:${String(request.params.arguments?.text ?? '')}|token:${String(process.env.CONNECTOR_PROBE_TOKEN ?? '')}`,
  }],
}))

await server.connect(new StdioServerTransport())
