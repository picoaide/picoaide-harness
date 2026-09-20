/**
 * 原子写**接线**判据（防"改了个名字但其实还在用旧实现"）。
 *
 * W6/W7 切换（设计总纲 §16.1）把包内本地 `atomicWriteFile` 助手换成了上游
 * `@deepseek-ai/dsh-atomic-write`。语义判据在 `atomic-write.spec.ts`（真实实现），
 * 本文件只回答一个问题：**两个调用点的字节是不是真的经过上游模块**。
 *
 * 三条独立判据（任何一条单独都能造出假绿，所以三条都要）：
 *  1. **模块解析**：`@deepseek-ai/dsh-atomic-write` 解析到本包 `node_modules` 下的上游包
 *     （不是包内同名模块），且本包 `package.json` 声明的版本与 desktop 的取值一致
 *     （同一 workspace 里出现两份 atomic-write 是语义漂移源）；
 *  2. **调用链**：用 `vi.mock` 把上游模块换成替身 ⇒ 两个调用点（`writeWindowsState`、
 *     安装密钥 `save`）必须调用它，且带上 `{ mode: 0o600, dirMode: 0o700 }`
 *     —— 本地实现存在时这个替身永远不会被调用，用例必红；
 *  3. **本地符号已消失**：`src/atomic-write.ts` 不存在，两个调用点的源码里没有
 *     `from './atomic-write`。
 *
 * 变异验证：把任一调用点改回 `./atomic-write.ts` 的本地符号 ⇒ 第 2 条必红（替身计数 0）；
 * 把 `mode` 改成 `0o644` ⇒ 第 2 条的参数断言必红。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

const writeFileAtomicSpy = vi.fn(async () => undefined)

vi.mock('@deepseek-ai/dsh-atomic-write', () => ({ writeFileAtomic: writeFileAtomicSpy }))

const { INSTALL_KEY_FILE, createInstallKeyStore, generateInstallKey } = await import('./app-proof.ts')
const { APP_WINDOWS_STATE_FILE, writeWindowsState } = await import('./windows.ts')

const sourceDir = dirname(fileURLToPath(import.meta.url))
const packageDir = dirname(sourceDir)
/**
 * 本包对上游 atomic-write 的依赖取值（与 desktop 对齐，见判据 1）。
 * 取自 `upstream.json` 的 pin（唯一真源）而不是字面量 —— 写死会让每次升级都手改
 * 这里，改漏就是假红（2026-09-20 升级审计 P1-8）。
 */
const DECLARED_VERSION = (JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../upstream.json', import.meta.url)), 'utf8'),
) as { runtimePackageVersion: string }).runtimePackageVersion

afterEach(() => {
  writeFileAtomicSpy.mockClear()
})

function readSource(name: string): string {
  return readFileSync(join(sourceDir, name), 'utf8')
}

describe('调用点确实走上游 @deepseek-ai/dsh-atomic-write', () => {
  it('模块解析到本包 node_modules 里的上游包（不是包内同名模块）', () => {
    const require = createRequire(import.meta.url)
    const resolved = require.resolve('@deepseek-ai/dsh-atomic-write')
    expect(resolved).toContain(`node_modules/@deepseek-ai/dsh-atomic-write/`)
    // 反向判据：不能解析到本包的 src/lib（那说明又长出了本地实现或路径别名）。
    expect(resolved).not.toContain(`${join(packageDir, 'src')}`)
    expect(resolved).not.toContain(`${join(packageDir, 'lib')}`)

    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(manifest.dependencies?.['@deepseek-ai/dsh-atomic-write']).toBe(DECLARED_VERSION)

    // 与 desktop 的取值一致：同一 workspace 里两份 atomic-write 语义会漂移。
    const desktopManifest = JSON.parse(
      readFileSync(join(packageDir, '..', 'desktop', 'package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> }
    expect(desktopManifest.dependencies?.['@deepseek-ai/dsh-atomic-write']).toBe(DECLARED_VERSION)
  })

  it('windows.ts：writeWindowsState 经上游 writeFileAtomic（0600/0700），不是本地符号', async () => {
    const dir = '/tmp/wasm-atomic-wiring-windows'
    await writeWindowsState(dir, { version: 1, apps: {} })
    expect(writeFileAtomicSpy).toHaveBeenCalledTimes(1)
    const [target, body, options] = writeFileAtomicSpy.mock.calls[0] as unknown as [string, string, unknown]
    expect(target).toBe(join(dir, APP_WINDOWS_STATE_FILE))
    expect(JSON.parse(body)).toEqual({ version: 1, apps: {} })
    expect(options).toEqual({ mode: 0o600, dirMode: 0o700 })
  })

  it('app-proof.ts：安装密钥 save 经上游 writeFileAtomic（0600/0700）', async () => {
    const dir = '/tmp/wasm-atomic-wiring-key'
    const store = createInstallKeyStore({ dir, safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' } })
    const key = generateInstallKey()
    await store.save({ ...key, encrypted: false })
    expect(writeFileAtomicSpy).toHaveBeenCalledTimes(1)
    const [target, body, options] = writeFileAtomicSpy.mock.calls[0] as unknown as [string, string, unknown]
    expect(target).toBe(join(dir, INSTALL_KEY_FILE))
    expect((JSON.parse(body) as { install_id: string }).install_id).toBe(key.installId)
    expect(options).toEqual({ mode: 0o600, dirMode: 0o700 })
  })
})

describe('本地助手确实已删除', () => {
  /** 包内非测试源码（动态枚举：并行泳道新增的调用点自动纳入判据，不写死文件名）。 */
  const sourceFiles = readdirSync(sourceDir).filter(name => name.endsWith('.ts') && !name.endsWith('.spec.ts'))

  it('src/atomic-write.ts 不存在，且 src/ 下没有任何文件再引用它', () => {
    expect(existsSync(join(sourceDir, 'atomic-write.ts'))).toBe(false)
    expect(sourceFiles.length).toBeGreaterThan(10)
    for (const file of sourceFiles) {
      const source = readSource(file)
      expect(source, file).not.toContain(`from './atomic-write`)
      expect(source, file).not.toContain('atomicWriteFile(')
    }
  })

  it('凡是用 writeFileAtomic 的模块都必须从上游包 import（没有本地同名符号）', () => {
    const writers = sourceFiles.filter(file => readSource(file).includes('writeFileAtomic('))
    // 两个已知调用点 + 并行泳道新增的调用点；一个都没有说明枚举坏了（防假绿）。
    expect(writers).toContain('windows.ts')
    expect(writers).toContain('app-proof.ts')
    for (const file of writers) {
      expect(readSource(file), file).toContain(`from '@deepseek-ai/dsh-atomic-write'`)
    }
  })
})
