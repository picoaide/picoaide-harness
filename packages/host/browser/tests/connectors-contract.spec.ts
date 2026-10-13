/**
 * 窄接口契约的**判据**（2026-10-13，"去连接器耦合"）。
 *
 * 背景：`src/index.ts` 原先用 `as typeof import('@picoaide/dsh-connectors/store')`
 * 把连接器包的类型嵌进本包的编译期 —— 那是真边，代价是**连接器模块被关掉之后
 * 浏览器包连编译都过不去**（干净态实测：connectors/lib 不在时 tsc 报 2 条 TS2307）。
 * 现在契约在 `src/connectors-contract.ts` 本地声明（窄接口），编译期那层"对面的
 * 真实形状必须满足本包的期待"因此消失 —— 本文件把那条判据**接回来**，形式换成
 * 运行期。
 *
 * 分四组，各自独立承重：
 *   ① **正向**：真的 `ConnectorStore` 必须被 `connectorStoreCtorOf` 接受，且
 *      `dir` 是字符串、两个方法在原型上可调用 —— 契约没写窄，也没写宽；
 *   ② **契约成员逐条真用**：真 store 上 `credentialIds()` / `readCredential()`
 *      的**行为**（ENOENT → null）与契约声明的签名一致（不是只看 typeof）；
 *   ③ **反向（有牙的判据）**：形状漂移逐个形态都必须被拒 —— 少了 `ConnectorStore`、
 *      不是构造函数、少了 `readCredential` / `credentialIds`。少了这一组，① 就是
 *      一句"永远为真"的空断言；
 *   ④ **接线**：真模块经 `createCredentialResolver` 走通（解析器不是 undefined，
 *      列表逐条为真）—— 契约与插件装配线连在一起。
 *
 * 连接器包不在检出里时整组跳过（`describe.skipIf`），判据锚点与理由见
 * `tests/helpers/connectors-module.ts`。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connectorStoreContractViolation, connectorStoreCtorOf } from '../src/connectors-contract.ts'
import { createCredentialResolver } from '../src/index.ts'
import { connectorStoreModule, connectorsPackagePresent } from './helpers/connectors-module.ts'

// 包不在检出里时是 undefined：本文件全部用例都在 skipIf 里面（见 helper 文件头）。
const ConnectorStore = connectorStoreModule?.ConnectorStore

let home: string
let previousHome: string | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pico-browser-contract-'))
  previousHome = process.env['DSH_HOME']
  process.env['DSH_HOME'] = home
})

afterEach(() => {
  if (previousHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = previousHome
  rmSync(home, { recursive: true, force: true })
})

describe.skipIf(!connectorsPackagePresent)('连接器凭据契约：真 store 与窄接口一致', () => {
  it('① 真的 ConnectorStore 被契约接受，且实例面逐条对上', async () => {
    const module = connectorStoreModule!
    // 契约的入口判据：真模块必须过（否则浏览器会把自己的凭据功能整体关掉）。
    expect(connectorStoreCtorOf(module)).toBe(module.ConnectorStore)
    // 反向对照（防假绿）：判据对"明显不是它"的东西必须判否，否则上面那句无意义。
    expect(connectorStoreCtorOf({ ConnectorStore: class {} })).toBeUndefined()

    const store = new (ConnectorStore!)({ username: 'user-a', serverURL: 'https://harness.example' })
    // `dir` 是实例属性（原型上看不到）⇒ 由这里钉住：必须是字符串、且落在数据根下。
    expect(typeof store.dir).toBe('string')
    expect(store.dir.startsWith(home)).toBe(true)
    // 两个方法的**行为**（不只是 typeof）：空 store ⇒ 空枚举、ENOENT ⇒ null。
    expect(await store.credentialIds()).toEqual([])
    expect(await store.readCredential('absent')).toBeNull()
  })

  it('② 契约里声明的读语义就是真 store 的语义：只有 ENOENT 是 null', async () => {
    const store = new (ConnectorStore!)({ username: 'user-a', serverURL: 'https://harness.example' })
    await store.writeCredential('corp', { updatedAt: Date.now(), fields: { username: 'alice', password: 's3cret' } })
    const credential = await store.readCredential('corp')
    // 契约只声明 `fields`（浏览器只读这一项）：真值必须满足它。
    expect(credential?.fields).toEqual({ username: 'alice', password: 's3cret' })
    expect(await store.credentialIds()).toEqual(['corp'])
  })

  it('③ 形状漂移逐个形态都被拒（反向判据，缺了这一条①就是空断言）', () => {
    const real = new (ConnectorStore!)({ username: 'user-a' })
    const realCtor = connectorStoreModule!.ConnectorStore
    // 正常输入：接受（与①同源，但用类本身而不是模块对象）。
    expect(connectorStoreCtorOf({ ConnectorStore: realCtor })).toBe(realCtor)
    expect(connectorStoreContractViolation({ ConnectorStore: realCtor })).toBeNull()

    // 漂移形态 1：模块根本不是对象。
    expect(connectorStoreCtorOf(null)).toBeUndefined()
    expect(connectorStoreCtorOf('ConnectorStore')).toBeUndefined()
    // 漂移形态 2：没有导出 ConnectorStore / 它不再是构造函数。
    expect(connectorStoreCtorOf({})).toBeUndefined()
    expect(connectorStoreCtorOf({ ConnectorStore: {} })).toBeUndefined()
    // 漂移形态 3：`readCredential` 改名（真 store 上确实有这个方法 —— 逐条对照，
    // 不是凭"看起来该有"）。
    expect(typeof real.readCredential).toBe('function')
    const noRead = class { async credentialIds(): Promise<string[]> { return [] } }
    expect(connectorStoreCtorOf({ ConnectorStore: noRead })).toBeUndefined()
    expect(connectorStoreContractViolation({ ConnectorStore: noRead })).toContain('readCredential()')
    // 漂移形态 4：`credentialIds` 没了（枚举点消失 ⇒ 列表工具会抛裸 TypeError）。
    expect(typeof real.credentialIds).toBe('function')
    const noIds = class { async readCredential(): Promise<null> { return null } }
    expect(connectorStoreCtorOf({ ConnectorStore: noIds })).toBeUndefined()
    expect(connectorStoreContractViolation({ ConnectorStore: noIds })).toContain('credentialIds()')
    // 告警文案点名**具体**缺项（不是一句"契约不符"），两处都缺就两条都点名。
    const neither = class {}
    expect(connectorStoreContractViolation({ ConnectorStore: neither })).toContain('readCredential()')
    expect(connectorStoreContractViolation({ ConnectorStore: neither })).toContain('credentialIds()')
    // 非对象模块的文案也要可读（不是 `undefined`）。
    expect(connectorStoreContractViolation(null)).toBe('<module> is not an object')
  })

  it('④ 接线：真模块在 ⇒ 解析器真的构造出来（不是 undefined）', async () => {
    const resolver = createCredentialResolver({ currentUser: () => 'user-a' })
    expect(resolver).toBeTypeOf('function')
    await new (ConnectorStore!)({ username: 'user-a' }).writeCredential('corp', {
      updatedAt: Date.now(),
      fields: { username: 'alice' },
    })
    expect(await resolver!.list!()).toEqual([{ id: 'corp', username: 'alice' }])
    // 形状漂移的告警出口：真模块不触发。
    const warnings: string[] = []
    const ok = createCredentialResolver({ currentUser: () => 'user-a', onContractViolation: (message) => warnings.push(message) })
    expect(ok).toBeTypeOf('function')
    expect(warnings).toEqual([])
  })
})
