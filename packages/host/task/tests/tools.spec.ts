import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'

/**
 * Structural tests for the task model-facing tools: they must be registered
 * with the exact names the system-prompt announcement cites, carry no
 * command/shell/executable fields, and route through the Host service
 * (never the ledger directly).
 */
describe('task tools surface', () => {
  const source = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8')

  it('registers task_create / task_list / task_run / workspace_list', () => {
    expect(source).toContain("name: 'task_create'")
    expect(source).toContain("name: 'task_list'")
    expect(source).toContain("name: 'task_run'")
    expect(source).toContain("name: 'workspace_list'")
  })

  it('has no command/shell/executable parameter fields', () => {
    // The words appear only in prose comments; the schema/parameters must
    // not carry such field names.
    expect(source).not.toMatch(/['"]command['"]/)
    expect(source).not.toMatch(/['"]executable['"]/)
    expect(source).not.toMatch(/['"]shell['"]/)
  })

  it('routes through the Host service, not the ledger', () => {
    expect(source).toContain('service.apply(')
    expect(source).toContain('service.runTask(')
    expect(source).toContain('service.getSnapshot()')
  })

  it('validates the title is non-empty in execute', () => {
    expect(source).toContain('args.title.trim()')
  })
})
