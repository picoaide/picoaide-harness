import { describe, expect, it } from 'vitest'
import { DESKTOP_CLI_HELP, parseDesktopCli } from '../src/bin.ts'

describe('desktop npm launcher', () => {
  it('launches with no arguments', () => {
    expect(parseDesktopCli([])).toBe('launch')
  })

  it.each([
    ['--help', 'help'],
    ['-h', 'help'],
    ['--version', 'version'],
    ['-V', 'version'],
  ] as const)('parses %s', (argument, action) => {
    expect(parseDesktopCli([argument])).toBe(action)
  })

  it('rejects arguments that belong to the profile app', () => {
    expect(() => parseDesktopCli(['--port', '3000'])).toThrow('unknown arguments')
  })

  it('names the installed product and selected profile behavior', () => {
    expect(DESKTOP_CLI_HELP).toContain('DSH Desktop')
    expect(DESKTOP_CLI_HELP).toContain('selected Web-capable profile')
  })
})
