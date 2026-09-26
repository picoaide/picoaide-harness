/**
 * FIX-31（第二十六轮审计发现项 Z2-2 / Z2-3，2026-09-26）: a credential READ
 * failure is not "there is no credential".
 *
 * ## 缺陷
 *
 * `readCredential` swallowed EVERY failure into `null` — transient
 * `EACCES`/`EMFILE`/`EIO`, a file above the 64 KiB read limit, an unparseable
 * document — and `updateCredential` then started from `{updatedAt: 0}` and wrote
 * `{...current, ...patch}` back over the file. accessToken / refreshToken /
 * clientId / clientSecret (and every `fields` entry not in the patch) were
 * destroyed with no exception, no log and no way back (the same shape as the
 * cron ledger's CR-1: a read error degraded into an empty state, then made
 * permanent by the write path). The write side had no size limit at all, so it
 * could also create the very file the read side refuses — a credential that
 * `credentialIds()` still lists but `readCredential()` reports as absent.
 *
 * ## 判据（红/绿同一句）
 *
 * ① 瞬时读失败（EACCES/EMFILE）⇒ `updateCredential` **拒绝写**、原文件 sha256 逐
 *    字节不变、错误如实抛出（`CredentialReadError`）且日志出口收到一条；
 * ② 超长文件与"文件不存在"分开：读面报 `too-large`、写面拒写、原文件不变；
 * ③ 正向：ENOENT 仍然是"没有凭据"（首次写入照常），正常读/写/CAS 语义逐字不变；
 * ④ 面板面：不可读凭据上的 auth-submit 如实落到行错误上，且 Host 日志里有一行。
 *
 * ---- 变异验证（本次实跑，见 temp/r21/fix-31/probe）----
 *   - 非 ENOENT 也返回 null（修前形态）⇒ 用例①/②红；
 *   - 写面把读异常 catch 成 null 继续覆盖写 ⇒ 用例①红。
 */
import { createHash } from 'node:crypto'
import { existsSync, promises as fsPromises } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-mcp-client', () => ({ apply: () => {} }))

import { ConnectorStore, CredentialReadError, type CredentialReadFault } from '../src/store.ts'
import {
  callRoute,
  createHarness,
  scopeDir,
  seedCredential,
  waitFor,
  type Harness,
} from './helpers/connector-harness.ts'
import type { ConnectorDef } from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  while (cleanups.length > 0) await cleanups.pop()?.()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(async () => { await rm(dir, { recursive: true, force: true }) })
  return dir
}

const sha256 = async (file: string): Promise<string> =>
  createHash('sha256').update(await readFile(file)).digest('hex')

const realReadFile = fsPromises.readFile.bind(fsPromises)

/** Fail the NEXT `readFile` of `basename` with `code` (everything else passes through). */
function failNextReadOf(basename: string, code: string, times = 1): { seen: number } {
  const state = { seen: 0 }
  vi.spyOn(fsPromises, 'readFile').mockImplementation(((file: string, options?: unknown) => {
    if (state.seen < times && String(file).endsWith(basename)) {
      state.seen += 1
      return Promise.reject(Object.assign(new Error(`${code}: injected`), { code }))
    }
    return (realReadFile as unknown as (f: string, o?: unknown) => Promise<unknown>)(file, options)
  }) as never)
  return state
}

const SEEDED = {
  accessToken: 'ACCESS-1',
  refreshToken: 'REFRESH-1',
  clientId: 'client-1',
  clientSecret: 'SECRET-1',
  fields: { API_KEY: 'KEY-1', EXTRA: 'EXTRA-1' },
  updatedAt: 1_000,
}

describe('FIX-31 / store: a READ failure is not "no credential"', () => {
  it.each(['EACCES', 'EMFILE'])('① a transient %s read failure aborts the write and leaves the file byte-identical', async (code) => {
    const dir = await tempDir('fix31-store-fault-')
    const faults: Array<{ id: string; fault: CredentialReadFault }> = []
    const store = new ConnectorStore({ baseDir: dir, onReadFault: (id, error) => { faults.push({ id, fault: error.fault }) } })
    const file = join(dir, 'example-mcp.json')
    await store.writeCredential('example-mcp', { ...SEEDED })
    const before = await sha256(file)

    failNextReadOf('example-mcp.json', code)
    await expect(
      store.updateCredential('example-mcp', { fields: { API_KEY: 'KEY-2' } }),
      'a read failure must refuse the write, never overwrite from {updatedAt: 0}',
    ).rejects.toBeInstanceOf(CredentialReadError)

    expect(await sha256(file), 'the stored credential must be untouched').toBe(before)
    const onDisk = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    expect(onDisk.accessToken).toBe(SEEDED.accessToken)
    expect(onDisk.refreshToken).toBe(SEEDED.refreshToken)
    // 写面如实报错（异常已断言）+ 日志出口恰好一条，内容与异常同源。
    expect(faults).toEqual([{ id: 'example-mcp', fault: { kind: 'unreadable', cause: expect.anything() } }])
  })

  it('② an oversized file is a read fault, not "no credential" — and the write path never creates one', async () => {
    const dir = await tempDir('fix31-store-size-')
    const store = new ConnectorStore({ baseDir: dir })
    const file = join(dir, 'big.json')
    const blob = 'x'.repeat(70 * 1024)

    // (a) 写面拒写超限文档：写出去就是"自己刚写的凭据读不回来"。
    await expect(
      store.writeCredential('big', { updatedAt: 2_000, fields: { BLOB: blob } }),
    ).rejects.toThrow(/above the 65536-byte limit/u)
    expect(existsSync(file), 'the refused write must not leave a file behind').toBe(false)

    // (b) 手工放一份超限文件（旧版本写下的）：读面必须报 fault，写面必须拒绝覆盖。
    await writeFile(file, `${JSON.stringify({ updatedAt: 2_000, accessToken: 'ACCESS-BIG', fields: { BLOB: blob } })}\n`)
    const before = await sha256(file)
    await expect(store.readCredential('big')).rejects.toMatchObject({ fault: { kind: 'too-large' } })
    await expect(store.updateCredential('big', { fields: { API_KEY: 'KEY' } })).rejects.toBeInstanceOf(CredentialReadError)
    expect(await sha256(file)).toBe(before)
  })

  it('③ ENOENT still means "no credential": first use works and normal read/write/CAS behaviour is unchanged', async () => {
    const dir = await tempDir('fix31-store-normal-')
    const store = new ConnectorStore({ baseDir: dir })
    const file = join(dir, 'example-mcp.json')

    // 首次使用：文件不存在 ⇒ null，且 updateCredential 从零建起（不能把首次使用挡掉）。
    expect(await store.readCredential('example-mcp')).toBeNull()
    const first = await store.updateCredential('example-mcp', { ...SEEDED })
    expect(first.accessToken).toBe(SEEDED.accessToken)

    // 常规读-改-写合并语义逐字不变。
    const merged = await store.updateCredential('example-mcp', { fields: { API_KEY: 'KEY-2' } })
    expect(merged.accessToken).toBe(SEEDED.accessToken)
    expect(merged.refreshToken).toBe(SEEDED.refreshToken)
    expect(merged.clientId).toBe(SEEDED.clientId)
    expect(merged.clientSecret).toBe(SEEDED.clientSecret)
    // `patch` is a SHALLOW merge over the stored document (`{...current, ...patch}`):
    // a `fields` patch replaces the whole map — the plugin is the layer that
    // merges it (`submitAuth`). Pinned here so the fail-closed change cannot
    // quietly alter the write semantics.
    expect(merged.fields).toEqual({ API_KEY: 'KEY-2' })
    expect((await store.readCredential('example-mcp'))?.accessToken).toBe(SEEDED.accessToken)

    // CAS 语义不变：快照过期 ⇒ 不写；期望快照仍成立 ⇒ 写；断开 ⇒ 不复活。
    expect(await store.updateCredentialIfUnchanged('example-mcp', first, { accessToken: 'STALE' })).toBeNull()
    const current = (await store.readCredential('example-mcp'))!
    expect((await store.updateCredentialIfUnchanged('example-mcp', current, { accessToken: 'ACCESS-2' }))?.accessToken).toBe('ACCESS-2')
    const second = (await store.readCredential('example-mcp'))!
    expect(await store.clearCredentialIfUnchanged('example-mcp', first)).toBe(false)
    expect(await store.clearCredentialIfUnchanged('example-mcp', second)).toBe(true)
    expect(await store.readCredential('example-mcp')).toBeNull()
    expect(await store.updateCredentialIfUnchanged('example-mcp', second, { accessToken: 'RESURRECT' })).toBeNull()
    expect(existsSync(file)).toBe(false)
  })

  it('④ an unparseable document is refused too (never silently replaced)', async () => {
    const dir = await tempDir('fix31-store-malformed-')
    const store = new ConnectorStore({ baseDir: dir })
    const file = join(dir, 'example-mcp.json')
    await writeFile(file, '{ this is not json')
    const before = await sha256(file)
    await expect(store.readCredential('example-mcp')).rejects.toMatchObject({ fault: { kind: 'malformed' } })
    await expect(store.updateCredential('example-mcp', { fields: { API_KEY: 'K' } })).rejects.toBeInstanceOf(CredentialReadError)
    expect(await sha256(file)).toBe(before)
  })

  it('⑤ the panel write face reports the fault on the row and logs, and "disconnect then authorize again" recovers', async () => {
    const home = await tempDir('fix31-store-panel-')
    vi.stubEnv('DSH_HOME', home)
    const SERVER = 'https://harness.example.com'
    const USER = 'user-a'
    const def: ConnectorDef = {
      id: 'example-mcp',
      name: 'Example',
      description: '',
      authMode: 'token',
      tokenFields: [{ key: 'API_KEY', label: 'API key', required: true }],
      mcp: [{ serverName: 'example-mcp-srv', transport: 'stdio', command: process.execPath, args: ['-e', ''] }],
    } as unknown as ConnectorDef
    await seedCredential(scopeDir(USER, SERVER), 'example-mcp', { fields: { API_KEY: 'KEY-1' }, updatedAt: Date.now() })
    const harness: Harness = createHarness([def], home, {
      storeBaseDir: undefined,
      refreshSweepIntervalMs: 0,
      requestApproval: () => true,
    })
    cleanups.push(async () => { harness.dispose() })
    harness.emitSession({ username: USER, serverURL: SERVER, token: 'token-a' })
    await waitFor(() => harness.configs.length === 1)

    const file = join(scopeDir(USER, SERVER), 'example-mcp.json')
    const before = await sha256(file)
    failNextReadOf('example-mcp.json', 'EACCES', 99)
    const res = await callRoute(harness, '/api/pico/connectors/example-mcp/auth-submit', 'POST', { fields: { API_KEY: 'KEY-2' } })
    // 路由是 fire-and-forget（OAuth 流程可长达数分钟），成败落在行上。
    expect(res.status).toBe(200)
    const list = await (async () => {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const body = JSON.parse((await callRoute(harness, '/api/pico/connectors', 'GET')).body) as {
          connectors: Array<{ status: string; error?: string }>
        }
        if (body.connectors[0]?.status === 'error') return body
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      throw new Error('the row never reported the failure')
    })()
    expect(list.connectors[0]?.error, '写面必须如实报错').toContain('could not be read')
    expect(harness.warns.join('\n'), 'Host 日志里必须有一行可检索的记录').toContain('read-fault')
    expect(await sha256(file), '凭据文件必须逐字节不变').toBe(before)

    // 恢复路径（用户侧，不需要重启）：断开只 unlink、不读凭据 ⇒ 一定成功；之后重新
    // 授权从"没有凭据"（ENOENT）重新写一份。fail-closed 的前提是**有出路**。
    vi.restoreAllMocks()
    expect((await callRoute(harness, '/api/pico/connectors/example-mcp/disconnect', 'POST')).status).toBe(200)
    expect(existsSync(file), 'disconnect 清掉了读不出来的那份凭据').toBe(false)
    expect((await callRoute(harness, '/api/pico/connectors/example-mcp/auth-submit', 'POST', { fields: { API_KEY: 'KEY-3' } })).status).toBe(200)
    await waitFor(() => existsSync(file))
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ fields: { API_KEY: 'KEY-3' } })
  })
})
