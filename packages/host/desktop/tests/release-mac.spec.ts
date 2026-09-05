import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { releaseMac, type MacReleaseOptions } from '../scripts/release-mac.ts'

const DEVELOPER_ID_OUTPUT = `
  1) 0123456789ABCDEF "Developer ID Application: Mengxin Yang (TEAM123456)"
     1 valid identities found
`

interface CommandCall {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

function baseOptions(
  env: NodeJS.ProcessEnv,
  calls: CommandCall[],
  identityEnvironments: NodeJS.ProcessEnv[] = [],
  logs: string[] = [],
): MacReleaseOptions {
  return {
    env,
    platform: 'darwin',
    desktopRoot: '/repo/packages/host/desktop',
    outputDir: '/repo/packages/host/desktop/dist/mac-release',
    productName: 'PicoAide Harness',
    resetOutput: () => undefined,
    listCodeSigningIdentities: identityEnv => {
      identityEnvironments.push({ ...identityEnv })
      return DEVELOPER_ID_OUTPUT
    },
    run: (command, args, cwd, commandEnv) => {
      calls.push({ command, args: [...args], cwd, env: { ...commandEnv } })
    },
    notarize: async () => undefined,
    log: message => logs.push(message),
    prepareRuntime: () => undefined,
  }
}

describe('macOS release command boundary', () => {
  it('runs checks without credentials, then gives credentials only to the builders', async () => {
    const calls: CommandCall[] = []
    const identityEnvironments: NodeJS.ProcessEnv[] = []
    const logs: string[] = []
    const resetOutput = vi.fn()
    const appPassword = 'notary-password-that-must-not-be-logged'
    const notarized: Array<{ appPath: string; env: NodeJS.ProcessEnv }> = []

    await releaseMac({
      ...baseOptions({
        PATH: '/usr/bin',
        SAFE_BUILD_VALUE: 'kept',
        APPLE_ID: 'developer@example.test',
        APPLE_APP_SPECIFIC_PASSWORD: appPassword,
        APPLE_TEAM_ID: 'TEAM123456',
      }, calls, identityEnvironments, logs),
      resetOutput,
      notarize: async (appPath, env) => {
        notarized.push({ appPath, env: { ...env } })
      },
    })

    expect(resetOutput).toHaveBeenCalledOnce()
    expect(identityEnvironments).toEqual([{ PATH: '/usr/bin', SAFE_BUILD_VALUE: 'kept' }])
    expect(calls).toHaveLength(4)
    expect(calls[0]).toEqual({
      command: 'yarn',
      args: ['run', 'check'],
      cwd: resolve('/repo/packages/host/desktop', '..', '..'),
      env: { PATH: '/usr/bin', SAFE_BUILD_VALUE: 'kept' },
    })
    // 第一步:仅打包+签名(dir 目标,关闭公证)
    expect(calls[1]).toEqual({
      command: 'yarn',
      args: [
        'exec', 'electron-builder', '--mac', 'dir', '--arm64',
        '--config.publish=never',
        '--config.forceCodeSigning=true', '--config.mac.notarize=false',
        '--config.npmRebuild=false',
        '--config.directories.output=/repo/packages/host/desktop/dist/mac-release',
      ],
      cwd: '/repo/packages/host/desktop',
      env: {
        PATH: '/usr/bin',
        SAFE_BUILD_VALUE: 'kept',
        APPLE_ID: 'developer@example.test',
        APPLE_APP_SPECIFIC_PASSWORD: appPassword,
        APPLE_TEAM_ID: 'TEAM123456',
      },
    })
    expect(notarized).toHaveLength(1)
    expect(notarized[0]?.appPath).toBe(
      '/repo/packages/host/desktop/dist/mac-release/mac-arm64/PicoAide Harness.app',
    )
    expect(notarized[0]?.env.APPLE_ID).toBe('developer@example.test')
    // 第二步:用已公证 app 直接打 DMG(prepackaged,不再重新打包/签名 app)
    expect(calls[2]).toEqual({
      command: 'yarn',
      args: [
        'exec', 'electron-builder', '--mac', 'dmg', '--arm64',
        '--prepackaged', '/repo/packages/host/desktop/dist/mac-release/mac-arm64/PicoAide Harness.app',
        '--config.publish=never',
        '--config.forceCodeSigning=true', '--config.mac.notarize=false',
        '--config.npmRebuild=false',
        '--config.directories.output=/repo/packages/host/desktop/dist/mac-release',
      ],
      cwd: '/repo/packages/host/desktop',
      env: {
        PATH: '/usr/bin',
        SAFE_BUILD_VALUE: 'kept',
        APPLE_ID: 'developer@example.test',
        APPLE_APP_SPECIFIC_PASSWORD: appPassword,
        APPLE_TEAM_ID: 'TEAM123456',
      },
    })
    expect(calls[3]).toEqual({
      command: process.execPath,
      args: [
        'scripts/verify-mac-release.ts',
        '/repo/packages/host/desktop/dist/mac-release',
      ],
      cwd: '/repo/packages/host/desktop',
      env: { PATH: '/usr/bin', SAFE_BUILD_VALUE: 'kept' },
    })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('signing via keychain; notarization via apple-id')
    expect(logs[0]).not.toContain(appPassword)
  })

  it('adapts the existing P12 variables only for electron-builder', async () => {
    const calls: CommandCall[] = []
    const p12Password = 'p12-password-that-must-not-be-logged'
    const p12 = Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00]).toString('base64')
    const notarized: NodeJS.ProcessEnv[] = []
    const options: MacReleaseOptions = {
      ...baseOptions({
        PATH: '/usr/bin',
        APPLE_API_KEY: '/private/AuthKey.p8',
        APPLE_API_KEY_ID: 'KEY123',
        APPLE_API_ISSUER: 'issuer-id',
        CSC_KEY_PASSWORD: p12Password,
        MAC_CERT_P12_BASE64: p12,
        MACOS_SIGN_IDENTITY: 'Developer ID Application: Mengxin Yang (TEAM123456)',
      }, calls),
      listCodeSigningIdentities: () => {
        throw new Error('P12 signing must not depend on a Keychain identity')
      },
      notarize: async (_appPath, env) => {
        notarized.push({ ...env })
      },
    }

    await releaseMac(options)

    expect(calls).toHaveLength(4)
    expect(calls[0]?.env).toEqual({ PATH: '/usr/bin' })
    expect(calls[1]?.env.CSC_LINK).toBe(`data:application/x-pkcs12;base64,${p12}`)
    expect(calls[1]?.env.CSC_NAME).toBe('Mengxin Yang (TEAM123456)')
    expect(calls[1]?.env.CSC_KEY_PASSWORD).toBe(p12Password)
    expect(calls[1]?.env.MAC_CERT_P12_BASE64).toBeUndefined()
    expect(calls[1]?.env.MACOS_SIGN_IDENTITY).toBeUndefined()
    expect(calls[2]?.env.CSC_LINK).toBe(`data:application/x-pkcs12;base64,${p12}`)
    // 公证步骤拿到的是原始(已适配)环境 API Key 三件套,用于 notarytool 认证
    expect(notarized[0]?.APPLE_API_KEY).toBe('/private/AuthKey.p8')
    expect(notarized[0]?.APPLE_API_KEY_ID).toBe('KEY123')
    expect(notarized[0]?.APPLE_API_ISSUER).toBe('issuer-id')
    expect(calls[3]?.env).toEqual({ PATH: '/usr/bin' })
  })

  it('rejects development signing before running any command', async () => {
    const calls: CommandCall[] = []
    const options = baseOptions({
      APPLE_KEYCHAIN_PROFILE: 'dsh-notary',
      CSC_NAME: 'Apple Development: Developer (TEAM123456)',
    }, calls)

    await expect(releaseMac(options)).rejects.toThrow('Developer ID Application')
    expect(calls).toEqual([])
  })

  it('does not invoke electron-builder after a failed credential-free check', async () => {
    const calls: CommandCall[] = []
    const resetOutput = vi.fn()
    const options: MacReleaseOptions = {
      ...baseOptions({
        APPLE_KEYCHAIN_PROFILE: 'dsh-notary',
      }, calls),
      resetOutput,
      run: (command, args, cwd, commandEnv) => {
        calls.push({ command, args: [...args], cwd, env: { ...commandEnv } })
        throw new Error('headless check failed')
      },
    }

    await expect(releaseMac(options)).rejects.toThrow('headless check failed')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual(['run', 'check'])
    expect(calls[0]?.cwd).toBe(resolve('/repo/packages/host/desktop', '..', '..'))
    expect(resetOutput).not.toHaveBeenCalled()
  })
})
