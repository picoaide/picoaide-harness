/**
 * `@picoaide/dsh-connectors` 的**窄接口**（本插件唯一一条可选跨包依赖的契约）。
 *
 * ## 为什么这里不 import 连接器包的类型
 *
 * 连接器模块是**可选**的：关掉它（包不在检出里 / 没构建）之后，浏览器插件必须
 * 照常编译、照常启动 —— 只是 `browser_fill_credentials` 与
 * `browser_credentials_list` 变成 fail-closed 拒绝。而 `as typeof import(...)`
 * 是**编译期硬边**：connecors 的 `lib/types` 不在，`tsc` 直接 TS2307，整个浏览器
 * 包连编译都过不去（2026-10-10 干净态实测 2 条）。所以契约在这里**本地声明**，
 * 需求侧（本包）不再依赖连接器包的产物形态。
 *
 * ## 契约的真源在对面，不在本文件
 *
 * 真源是 `packages/host/connectors/src/store.ts` 的 `ConnectorStore`：
 *
 *   · `readonly dir: string`                     —— 作用域目录本身（不是某个凭据文件）
 *   · `credentialIds(): Promise<string[]>`       —— 目录枚举（排序后的 id）
 *   · `readCredential(id): Promise<Credential|null>` —— 只有 ENOENT 返回 `null`，
 *     其余读失败抛 `CredentialReadError`（第二十六轮 FIX-31 的语义，见
 *     `index.ts` 的 `credentialReadReason`）。
 *
 * 本文件**只声明浏览器真正用到的这三项**，一项不多 —— 声明得越宽，越容易把
 * "连接器包的内部形状"变成浏览器的负担。
 *
 * ## 为什么漂移由运行期判据兜住（而不是编译期）
 *
 * 换了窄接口，编译期那层 "连接器的真实形状必须满足浏览器的期待" 的检查就没了。
 * 收口方式是**运行期形状校验**（{@link connectorStoreCtorOf}）：`require` 拿到
 * 的模块必须先通过校验才会被使用，否则**整个解析器不构造**（等价于"连接器不可
 * 用"⇒ 两条工具 fail-closed 拒绝，并给出一条可读的告警）。
 *
 * 这比"读一半崩一半"强：`readCredential` 改名的话，旧形态下 `store.readCredential`
 * 是 `undefined`，`.list` 会抛一个裸 TypeError（没分类、没前缀），`fill_credentials`
 * 则把它包装成一句与事实无关的"读不出来"。现在两种形态都收敛到同一条明确的
 * 拒绝路径。
 *
 * 契约与真实实现的一致**另有正向判据**（`tests/connectors-contract.spec.ts`）：
 * 真的 `ConnectorStore` 必须被 {@link connectorStoreCtorOf} 接受。那条用例在
 * 连接器包存在时**必然运行**（不是可以静默跳过的 advisory）。
 */

/**
 * 浏览器从一份凭据里读到的**全部**内容（第二十六轮 FIX-31 起 `fields` 是
 * `Record<string, string>`：非字符串的值在连接器包的读入侧就被剔掉了）。
 *
 * 只有 `fields` —— `accessToken` / `refreshToken` 等 OAuth 字段浏览器从不读，
 * 不在这里声明就不会有人顺手去读。
 */
export interface ConnectorCredentialLike {
  readonly fields?: Record<string, string>
}

/**
 * 浏览器用到的 `ConnectorStore` 实例面（真源见文件头）。
 *
 * `dir` 是**作用域目录本身**：`assertScopeListable` 用它复核"空列表是真没有凭据，
 * 还是目录读不出来"，所以它必须是 `store` 自己解析出来的那一个（本包不自己拼布局
 * 路径 —— 拼第二处就是第二个会把作用域弄错的地方）。
 */
export interface ConnectorStoreLike {
  readonly dir: string
  credentialIds(): Promise<string[]>
  readCredential(id: string): Promise<ConnectorCredentialLike | null>
}

/**
 * 构造参数：与连接器插件**逐字相同**的作用域解析输入（账号 + 服务端地址）。
 *
 * 两项都显式传（不靠对面的缺省值）：`username: null` 与 `serverURL: null` 分别
 * 落到 `anonymous` / `unscoped` 段，是"不知道是谁 / 不知道哪个服务端"的 fail-closed
 * 落点，不能因为对面改了缺省就被静默换掉。
 */
export interface ConnectorStoreOptionsLike {
  username: string | null
  serverURL: string | null
}

/** `ConnectorStore` 的构造面。 */
export interface ConnectorStoreCtorLike {
  new (options: ConnectorStoreOptionsLike): ConnectorStoreLike
}

/**
 * 运行时形状校验：把 `require` 到的**未知**模块收成 {@link ConnectorStoreCtorLike}，
 * 形状不符返回 `undefined`（调用方据此走"连接器不可用"的 fail-closed 路径）。
 *
 * 判据只覆盖**浏览器会碰的那些成员**，且只判"存在且是函数"：
 *
 *   · `ConnectorStore` 是函数（可 `new`）；
 *   · `ConnectorStore.prototype.readCredential` 是函数；
 *   · `ConnectorStore.prototype.credentialIds` 是函数。
 *
 * `dir` 是**实例属性**（构造函数里赋值），原型上看不到，因此不在这里判 —— 它由
 * 上面那份"真源 ↔ 契约"的正向用例钉住（真 `ConnectorStore` 实例的 `dir` 必须是
 * 字符串），而不是让本函数去构造一个实例（那会把一个纯形状判据变成有副作用的调用）。
 *
 * @param candidate - `require('@picoaide/dsh-connectors/store')` 的返回值（未知形状）。
 * @returns 通过校验的构造函数，或 `undefined`。
 */
export function connectorStoreCtorOf(candidate: unknown): ConnectorStoreCtorLike | undefined {
  if (candidate === null || typeof candidate !== 'object') return undefined
  const ctor = (candidate as { ConnectorStore?: unknown }).ConnectorStore
  if (typeof ctor !== 'function') return undefined
  const prototype: unknown = (ctor as { prototype?: unknown }).prototype
  if (prototype === null || typeof prototype !== 'object') return undefined
  const members = prototype as Record<string, unknown>
  if (typeof members['readCredential'] !== 'function') return undefined
  if (typeof members['credentialIds'] !== 'function') return undefined
  return ctor as ConnectorStoreCtorLike
}

/**
 * 形状不符时给**人**看的一句话（不含路径、不含任何凭据字节）。
 *
 * 报错文案里点名具体缺了哪一项：改造连接器包的人看到这条日志就知道该对齐什么，
 * 而不是只看到"凭据填充不工作"。
 *
 * @param candidate - 同一份未知模块。
 * @returns 具体缺失的成员清单；形状正常时返回 `null`。
 */
export function connectorStoreContractViolation(candidate: unknown): string | null {
  if (candidate === null || typeof candidate !== 'object') return '<module> is not an object'
  const ctor = (candidate as { ConnectorStore?: unknown }).ConnectorStore
  if (typeof ctor !== 'function') return 'ConnectorStore is not a constructor'
  const prototype: unknown = (ctor as { prototype?: unknown }).prototype
  if (prototype === null || typeof prototype !== 'object') return 'ConnectorStore.prototype is not an object'
  const members = prototype as Record<string, unknown>
  const missing: string[] = []
  if (typeof members['readCredential'] !== 'function') missing.push('readCredential()')
  if (typeof members['credentialIds'] !== 'function') missing.push('credentialIds()')
  return missing.length === 0 ? null : `${missing.join(' / ')} missing`
}
