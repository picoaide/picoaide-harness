/**
 * 分区名公式的**跨包对拍**（§7.2/R2S-8：`persist:agent-browser-<user>@<sha256(server)[:32]>`）。
 *
 * 为什么需要这个判据：公式在仓里被实现过两次（`@picoaide/dsh-browser/surface` 是权威，
 * `@picoaide/dsh-wasm-apps-host/partition` 是镜像 —— 该包不允许反向依赖 browser）。
 * 两份实现发散的症状是"应用窗口的协议 handler 注册在一个没人用的分区上 ⇒ 应用页面
 * 空白"，而**两边各自的单测都能是绿的**（各钉自己的字面量）。所以这里用**真实 Node**
 * 跑那份镜像（`node:child_process` + 动态 import，绕开 vitest 的转换管线），把两份实现
 * 的输出逐例对拍。
 *
 * 变异验证：
 *   · browser 侧去掉 `@<hash>` 后缀 ⇒ 对拍与"换服务端换分区"用例必红；
 *   · browser 侧把截断改成 16 位 / 用非归一化地址哈希 ⇒ 逐例对拍必红；
 *   · 镜像侧改公式（改编码表/归一化/截断）⇒ 对拍必红。
 *
 * 硬约束（对拍表里逐条钉住）：
 *   1. **匿名分区逐字节不变**：`persist:agent-browser-anonymous`（无后缀）；
 *   2. 换服务端 ⇒ 换分区；尾部斜杠 / 首尾空白 ⇒ **不**换分区。
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { browserPartitionFor, encodePartitionSegment, serverPartitionHash } from '../src/surface.ts'

/** 镜像实现（宿主包）的路径 —— 相对本包的 tests/ 目录。 */
const MIRROR = fileURLToPath(new URL('../../wasm-apps-host/src/partition.ts', import.meta.url))

/**
 * 用**真实 Node** 跑镜像实现（Node 24 直接支持 `.ts`）。
 *
 * 为什么不 `import()`：vitest 会把模块走自己的转换管线，跑到的可能是被处理过的副本；
 * 这里要的是"宿主运行时真正加载的那份代码"的行为。也不用仓库内的相对 import ——
 * 那会凭空造出一条 `browser → wasm-apps-host` 的构建依赖边（构建图守卫会红）。
 *
 * 跨进程只能传 JSON，而 `undefined` 在 JSON 里会变成 `null`（两者的语义差别正好是
 * "不带后缀" vs "`@null`"）⇒ 结果一律包成 `{value}` / `{undef:true}` 再比对，
 * 参数侧则在为 `undefined` 时**不传**该实参（走形参缺省）。
 * @param calls - 请求的求值列表。
 * @returns 镜像实现的结果（与请求同序，JSON 安全的封装）。
 */
function runMirror(calls: Array<{ fn: 'hash' | 'partition' | 'encode', args: unknown[] }>): unknown[] {
  const script = `
    const mod = await import(${JSON.stringify(MIRROR)})
    const calls = ${JSON.stringify(calls)}
    const enc = (v) => v === undefined ? { undef: true } : { value: v }
    const out = calls.map((call) => {
      if (call.fn === 'hash') return enc(mod.serverPartitionHash(call.args[0]))
      if (call.fn === 'encode') return enc(mod.encodePartitionSegment(call.args[0]))
      return enc(mod.browserPartitionFor(...call.args))
    })
    process.stdout.write(JSON.stringify(out))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`mirror implementation failed to run (status=${String(result.status)}): ${result.stderr}`)
  }
  return JSON.parse(result.stdout) as unknown[]
}

/** 与镜像同形的封装（两侧用同一份编码，`undefined` 的语义差别不会被 JSON 抹掉）。 */
const enc = (value: unknown): unknown => value === undefined ? { undef: true } : { value }

const SERVER_A = 'https://harness-a.example.com'
const SERVER_B = 'https://harness-b.example.com'

/** 对拍表：用户名 × 服务端地址（含尾部斜杠/空白/未登录/非 ASCII）。 */
const USERNAMES: Array<string | null | undefined> = [null, undefined, '', 'alice', 'alice.1', 'a/b', '张三', 'a b']
const SERVERS: Array<string | null | undefined> = [null, undefined, '', SERVER_A, `${SERVER_A}/`, `  ${SERVER_A}/  `, SERVER_B]

describe('分区名公式与宿主镜像逐例对拍（TST-14）', () => {
  it('镜像实现存在（缺失即红 —— 不允许静默跳过对拍）', () => {
    expect(existsSync(MIRROR), `mirror implementation missing: ${MIRROR}`).toBe(true)
  })

  it('browserPartitionFor 与宿主镜像对全部（用户 × 服务端）组合给出同一结果', () => {
    const calls: Array<{ fn: 'partition', args: unknown[] }> = []
    const ours: unknown[] = []
    for (const username of USERNAMES) {
      for (const server of SERVERS) {
        const hash = serverPartitionHash(server)
        // `undefined` 的形参在 JSON 里会变 `null`（语义不同）⇒ 不传这个实参。
        calls.push({ fn: 'partition', args: hash === undefined ? [username ?? null] : [username ?? null, hash] })
        ours.push(enc(browserPartitionFor(username, hash)))
      }
    }
    const theirs = runMirror(calls) as string[]
    expect(theirs).toEqual(ours)
  })

  it('serverPartitionHash 与镜像逐例一致（同一归一化 + 同一截断）', () => {
    const calls = SERVERS.map(server => ({ fn: 'hash' as const, args: [server ?? null] }))
    const theirs = runMirror(calls)
    expect(theirs).toEqual(SERVERS.map(server => enc(serverPartitionHash(server))))
  })

  it('encodePartitionSegment 与镜像逐例一致（编码表单射）', () => {
    const calls = USERNAMES.map(username => ({ fn: 'encode' as const, args: [username ?? ''] }))
    const theirs = runMirror(calls)
    expect(theirs).toEqual(USERNAMES.map(username => enc(encodePartitionSegment(username ?? ''))))
  })
})

describe('分区名公式的硬约束', () => {
  it('匿名分区逐字节不变（未登录没有租户可隔离 ⇒ 不带哈希）', () => {
    expect(browserPartitionFor(null)).toBe('persist:agent-browser-anonymous')
    expect(browserPartitionFor(undefined)).toBe('persist:agent-browser-anonymous')
    expect(browserPartitionFor('')).toBe('persist:agent-browser-anonymous')
    // 即便拿到了哈希，匿名也不带后缀（否则启动分区会在登录后"换一个"，让
    // 应用窗口与浏览器落在两个 session 上）。
    expect(browserPartitionFor(null, serverPartitionHash(SERVER_A))).toBe('persist:agent-browser-anonymous')
  })

  it('登录用户的分区形如 persist:agent-browser-<user>@<sha256[:32]>', () => {
    const expected = createHash('sha256').update(SERVER_A, 'utf8').digest('hex').slice(0, 32)
    expect(serverPartitionHash(SERVER_A)).toBe(expected)
    expect(browserPartitionFor('alice', expected)).toBe(`persist:agent-browser-alice@${expected}`)
  })

  it('换服务端 ⇒ 换分区（同机测试/正式并存时不能共用持久分区）', () => {
    const a = browserPartitionFor('alice', serverPartitionHash(SERVER_A))
    const b = browserPartitionFor('alice', serverPartitionHash(SERVER_B))
    expect(a).not.toBe(b)
  })

  it('尾部斜杠 / 首尾空白不换分区（地址写法不该换一个空分区）', () => {
    const hash = serverPartitionHash(SERVER_A)
    expect(serverPartitionHash(`${SERVER_A}/`)).toBe(hash)
    expect(serverPartitionHash(`  ${SERVER_A}/  `)).toBe(hash)
    expect(browserPartitionFor('alice', serverPartitionHash(`${SERVER_A}/`))).toBe(browserPartitionFor('alice', hash))
  })

  it('未知服务端（未登录/空串）⇒ 不带后缀（与旧版逐字节兼容）', () => {
    expect(serverPartitionHash(null)).toBeUndefined()
    expect(serverPartitionHash(undefined)).toBeUndefined()
    expect(serverPartitionHash('')).toBeUndefined()
    expect(serverPartitionHash('   ')).toBeUndefined()
    expect(serverPartitionHash('///')).toBeUndefined()
    expect(browserPartitionFor('alice', undefined)).toBe('persist:agent-browser-alice')
  })
})
