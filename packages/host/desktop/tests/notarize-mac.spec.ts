import { describe, expect, it } from 'vitest'
import { notarizeMacApp, type NotarizeMacOptions } from '../scripts/notarize-mac.ts'

interface CommandCall {
  readonly command: string
  readonly args: readonly string[]
}

/** Build a default options object with a scripted notarytool/stapler transcript. */
function makeOptions(overrides: Partial<NotarizeMacOptions> = {}): {
  options: NotarizeMacOptions
  calls: CommandCall[]
  responses: string[]
} {
  const appPath = '/app/PicoAide Harness.app'
  const calls: CommandCall[] = []
  const responses: string[] = []
  return {
    calls,
    responses,
    options: {
      appPath,
      env: { APPLE_API_KEY: '/private/AuthKey.p8', APPLE_API_KEY_ID: 'KEY123', APPLE_API_ISSUER: 'issuer-id' },
      pollIntervalMs: 1,
      deadlineMs: 200,
      retries: 2,
      backoffMs: 1,
      run: (command, args) => {
        calls.push({ command, args })
        const response = responses.shift()
        if (response === undefined) return ''
        if (response.startsWith('!')) throw new Error(response.slice(1))
        return response
      },
      sleep: async () => undefined,
      log: () => undefined,
      ...overrides,
    },
  }
}

describe('notarytool-resilient notarization', () => {
  it('submits, short-polls until Accepted, then staples and validates', async () => {
    const { options, calls, responses } = makeOptions()
    responses.push(
      'Submission ID: 00000000-0000-0000-0000-000000000001\n',
      'Submission Status: In Progress\n',
      'Status: Accepted\n',
    )

    const result = await notarizeMacApp(options)

    expect(result).toEqual({
      appPath: '/app/PicoAide Harness.app',
      submissionId: '00000000-0000-0000-0000-000000000001',
      status: 'Accepted',
    })
    expect(calls.map(call => [call.command, call.args[1]])).toEqual([
      ['xcrun', 'submit'],
      ['xcrun', 'info'],
      ['xcrun', 'info'],
      ['xcrun', 'staple'],
      ['xcrun', 'validate'],
    ])
    expect(calls[3]?.args).toEqual(['stapler', 'staple', '/app/PicoAide Harness.app'])
    expect(calls[4]?.args).toEqual(['stapler', 'validate', '/app/PicoAide Harness.app'])
  })

  it('retries a transient polling failure and still succeeds', async () => {
    const { options, calls, responses } = makeOptions()
    responses.push(
      'Submission ID: 00000000-0000-0000-0000-000000000002\n',
      '!the network connection was lost',
      'Status: Accepted\n',
    )

    await notarizeMacApp(options)

    const infoCalls = calls.filter(call => call.args[1] === 'info')
    expect(infoCalls).toHaveLength(2)
  })

  it('fails loudly when Apple rejects the submission and includes the log', async () => {
    const { options, responses } = makeOptions()
    responses.push(
      'Submission ID: 00000000-0000-0000-0000-000000000003\n',
      'Status: Invalid\n',
      'invalid-notarization-details',
    )

    await expect(notarizeMacApp(options)).rejects.toThrow(/rejected by Apple[\s\S]*invalid-notarization-details/u)
  })

  it('does not submit anything without credential material', async () => {
    const { options, calls } = makeOptions({ env: {} })

    await expect(notarizeMacApp(options)).rejects.toThrow(/notarization credentials are required/u)
    expect(calls).toEqual([])
  })

  it('fails when the deadline passes without Accepted', async () => {
    const { options, responses } = makeOptions({ deadlineMs: 5 })
    responses.push(
      'Submission ID: 00000000-0000-0000-0000-000000000004\n',
      'Status: In Progress\n',
      'Status: In Progress\n',
    )

    await expect(notarizeMacApp(options)).rejects.toThrow(/did not reach Accepted/u)
  })
})
