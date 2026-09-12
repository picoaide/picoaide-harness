/**
 * 补丁守卫：`@deepseek-ai/dsh-subprocess-local` 的 **runner 环境必须带
 * `ELECTRON_RUN_AS_NODE=1`**（见 `patches/dsh-subprocess-local@0.1.5-rc.2.patch`）。
 *
 * 背景（2026-09-12，真实故障）：打包后的 Electron 宿主里 `process.execPath` 是
 * **GUI 二进制**而不是 Node。上游按 `spawn(process.execPath, [runnerEntry, …])`
 * 启动它的 Windows Job runner / Linux scope runner —— 不带 `ELECTRON_RUN_AS_NODE`
 * 时子进程按"应用模式"启动（单实例锁 → 立刻退出码 0），runner 入口（`lib/runner.js`，
 * 以 `import.meta.main` 守卫）根本不会执行。父进程要求 runner 经 IPC 回传结果，
 * 于是判为基础设施故障并 fail-closed：
 *
 *   `subprocess-local: Windows Job runner exited with exit code 0 before proving
 *    its managed range empty`
 *
 * 现场表现：Windows 客户端上 `pwsh` 100% 失败、`glob`（ripgrep 子进程）同样失败
 * （用户会话包 dsh-session-session-a623b2dc…：78 次调用 51 次失败，其中该错误 8 次）。
 *
 * 这个 spec 钉住两件事，防止下次升级上游时补丁被静默丢掉：
 *  1. runner 环境在 Electron 下必须含 `ELECTRON_RUN_AS_NODE=1`；
 *  2. 它**不能**泄漏到用户命令的环境里（`targetEnvironment()` 是另一条路径，
 *     否则用户跑 `code .` 这类 Electron CLI 会被当成 Node 启动）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
const pkgDir = dirname(require_.resolve('@deepseek-ai/dsh-subprocess-local/package.json'))

/**
 * 载入上游内部 chunk(`runner-launch-<hash>.js`)。文件名带内容哈希,导出名也被
 * 打包器压成单字母(`runnerEnvironment as o`),所以这里从 chunk 末尾的
 * `export { … }` 语句反解"原名 → 导出名",再按原名取函数 —— 既不依赖哈希文件名,
 * 也不依赖压缩后的字母名;上游若改名/删函数,本 spec 会明确失败(这正是补丁守卫该做的)。
 */
async function loadRunnerLaunch(): Promise<Record<string, any>> {
  const file = readdirSync(join(pkgDir, 'lib')).find(name => /^runner-launch-.*\.js$/u.test(name))
  expect(file, 'runner-launch chunk 未找到').toBeTruthy()
  const path = join(pkgDir, 'lib', file!)
  const mod = await import(pathToFileURL(path).href) as Record<string, any>
  const exported = /export\s*\{([^}]*)\}/u.exec(readFileSync(path, 'utf8'))?.[1] ?? ''
  const alias = new Map<string, string>()
  for (const part of exported.split(',')) {
    const [orig, as] = part.trim().split(/\s+as\s+/u)
    if (orig !== undefined && orig !== '') alias.set(orig, as ?? orig)
  }
  return {
    runnerEnvironment: mod[alias.get('runnerEnvironment') ?? 'runnerEnvironment'],
    targetEnvironment: mod[alias.get('targetEnvironment') ?? 'targetEnvironment'],
  }
}

const originalElectron = process.versions.electron
afterEach(() => {
  if (originalElectron === undefined) delete (process.versions as Record<string, unknown>).electron
  else Object.defineProperty(process.versions, 'electron', { value: originalElectron, configurable: true })
})

describe('subprocess-local runner 环境（补丁守卫）', () => {
  it('Electron 宿主下 runner 环境注入 ELECTRON_RUN_AS_NODE=1', async () => {
    const mod = await loadRunnerLaunch()
    Object.defineProperty(process.versions, 'electron', { value: '43.4.0', configurable: true })
    const env = mod.runnerEnvironment('windows', [process.execPath, '/tmp/runner.js'])
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
    // 上游自身的协议变量不能被补丁挤掉(键名是包内私有常量,按值断言)
    expect(Object.values(env)).toContain('windows')
  })

  it('纯 Node 运行时不注入（不改变 CLI/服务端宿主行为）', async () => {
    const mod = await loadRunnerLaunch()
    delete (process.versions as Record<string, unknown>).electron
    const env = mod.runnerEnvironment('windows', [process.execPath, '/tmp/runner.js'])
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })

  it('不泄漏给用户命令：targetEnvironment 是另一条路径', async () => {
    const mod = await loadRunnerLaunch()
    Object.defineProperty(process.versions, 'electron', { value: '43.4.0', configurable: true })
    const target = mod.targetEnvironment({
      argv: [process.execPath, '-e', 'echo hi'],
      cwd: process.cwd(),
      env: { DSH_PROBE: '1' },
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    })
    expect(target.ELECTRON_RUN_AS_NODE).toBeUndefined()
  })
})
