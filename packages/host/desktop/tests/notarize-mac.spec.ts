import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
      waitTimeoutMs: 15_000,
      pollIntervalMs: 1,
      deadlineMs: 200,
      retries: 2,
      backoffMs: 1,
      run: (command, args) => {
        calls.push({ command, args })
        // 只有 submit/info/log 消费脚本化响应;ditto/staple/validate 一律成功且无输出
        const sub = args[1] ?? ''
        if (sub !== 'submit' && sub !== 'wait' && sub !== 'log') return ''
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
    // 新式 notarytool 输出(Xcode 15+):'Submission ID received' + 'id:' 行
    responses.push(
      'Conducting pre-submission checks...\nSubmission ID received\n  id: 00000000-0000-0000-0000-000000000001\nSuccessfully uploaded file\n  id: 00000000-0000-0000-0000-000000000001\n',
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
      ['ditto', '-k'],
      ['xcrun', 'submit'],
      ['xcrun', 'wait'],
      ['xcrun', 'wait'],
      ['xcrun', 'staple'],
      ['xcrun', 'validate'],
    ])
    // 官方有限等待调用:wait <id> ... --timeout <秒>
    const waitArgs = calls.find(call => call.args[1] === 'wait')?.args ?? []
    expect(waitArgs[0]).toBe('notarytool')
    expect(waitArgs[1]).toBe('wait')
    expect(waitArgs[2]).toBe('00000000-0000-0000-0000-000000000001')
    expect(waitArgs.at(-2)).toBe('--timeout')
    // 提交的是 zip(notarytool 不收 .app 目录),点击目标是 .app
    expect(calls[0]?.args).toContain('PicoAide Harness.app')
    expect(calls[1]?.args[2]).toMatch(/\.zip$/u)
    // ditto 在 .app 父目录执行(keepParent 归档根为 .app 而非绝对路径)
    expect(calls[0]?.args).toContain('--keepParent')
    expect(calls[4]?.args).toEqual(['stapler', 'staple', '/app/PicoAide Harness.app'])
    expect(calls[5]?.args).toEqual(['stapler', 'validate', '/app/PicoAide Harness.app'])
  })

  it('accepts the legacy one-line Submission ID format too', async () => {
    const { options, calls, responses } = makeOptions()
    responses.push(
      'Submission ID: 00000000-0000-0000-0000-000000000005\n',
      'Status: Accepted\n',
    )

    await notarizeMacApp(options)

    expect(calls[1]?.args[2]).toMatch(/\.zip$/u)
  })

  it('retries a transient polling failure and still succeeds', async () => {
    const { options, calls, responses } = makeOptions()
    responses.push(
      'Submission ID: 00000000-0000-0000-0000-000000000002\n',
      '!the network connection was lost',
      'Status: Accepted\n',
    )

    await notarizeMacApp(options)

    const waitCalls = calls.filter(call => call.args[1] === 'wait')
    expect(waitCalls).toHaveLength(2)
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

  it('resumes a persisted submission instead of submitting again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-notary-resume-'))
    const resumeFile = join(dir, 'state.json')
    writeFileSync(
      resumeFile,
      JSON.stringify({ appPath: '/app/PicoAide Harness.app', submissionId: '00000000-0000-0000-0000-000000000009' }),
    )
    const { options, calls, responses } = makeOptions({ resumeFilePath: resumeFile })
    responses.push('Status: Accepted\n')

    await notarizeMacApp(options)

    expect(calls.map(call => call.args[1])).not.toContain('submit')
    expect(calls.some(call => call.args[1] === 'wait' && call.args[2] === '00000000-0000-0000-0000-000000000009')).toBe(true)
    // 完成即清除状态文件:同一构建的后续运行不误判为进行中。
    expect(existsSync(resumeFile)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps the persisted submission after a deadline failure for a later resume', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-notary-resume-deadline-'))
    const resumeFile = join(dir, 'state.json')
    const { options, responses } = makeOptions({ resumeFilePath: resumeFile, deadlineMs: 5 })
    responses.push(
      'Submission ID: 00000000-0000-0000-0000-00000000000a\n',
      'Status: In Progress\n',
    )

    await expect(notarizeMacApp(options)).rejects.toThrow(/did not reach Accepted/u)
    expect(JSON.parse(readFileSync(resumeFile, 'utf8'))).toEqual({
      appPath: '/app/PicoAide Harness.app',
      submissionId: '00000000-0000-0000-0000-00000000000a',
    })
    rmSync(dir, { recursive: true, force: true })
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
