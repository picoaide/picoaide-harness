import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { URL } from 'node:url'

/**
 * Structural tests for the cron model-facing tools: they must be registered
 * with the exact names the system-prompt announcement cites, carry no
 * command/shell/executable fields, and route through the Host service.
 */
describe('cron tools surface', () => {
  const source = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8')

  it('registers cron_create / cron_list / cron_set_enabled / cron_run', () => {
    expect(source).toContain("name: 'cron_create'")
    expect(source).toContain("name: 'cron_list'")
    expect(source).toContain("name: 'cron_set_enabled'")
    expect(source).toContain("name: 'cron_run'")
  })

  it('has no command/shell/executable parameter fields', () => {
    // The words appear only in prose comments; the schema/parameters must
    // not carry such field names.
    expect(source).not.toMatch(/['"]command['"]/)
    expect(source).not.toMatch(/['"]executable['"]/)
    expect(source).not.toMatch(/['"]shell['"]/)
  })

  it('validates the cron expression and requires a prompt in execute', () => {
    expect(source).toContain('isValidCron(args.cron)')
    expect(source).toContain(`prompt.trim() === ''`)
    expect(source).toContain('必须提供 prompt')
  })

  it('routes through the Host service', () => {
    expect(source).toContain('service.registerJob(')
    expect(source).toContain('service.apply(')
    // Reads go through the owner-filtered surface (multi-user isolation).
    expect(source).toContain('service.listVisibleJobs()')
  })
})
