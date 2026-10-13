/**
 * 连接器包（`@picoaide/dsh-connectors`）在测试里的**唯一**取用点（2026-10-13）。
 *
 * ## 为什么需要一个 helper
 *
 * 连接器模块是**可选**的：它被关掉之后，浏览器插件仍要能编译、能启动（凭据功能
 * fail-closed，见 `src/connectors-contract.ts`）。但本包有两条回归用例要用**真的**
 * `ConnectorStore` 造夹具（`credential-site.spec.ts` /
 * `audit-r27-credential-read-faults.spec.ts`）—— 静态 `import` 在包不在检出里时
 * 会让整个文件在**收集阶段**就炸，`yarn test` 直接失败。所以取用收口到这里：
 * 包在就照常真身加载，包不在就交给调用点 `describe.skipIf(...)` 跳过。
 *
 * ## 判据锚点是「包在不在」，不是「lib 建没建」
 *
 * `existsSync(<connectors>/package.json)`。**故意不判 `lib/`**：包在、而模块加载
 * 不出来（`lib/` 没建 / 构建坏了 / 调度顺序错了）必须**红**，不许静默跳过 ——
 * 那正是"本地绿、CI 红"的一类形态。`needs` 边（`scripts/check-workspaces.mjs`）
 * 保证包在时 `lib/` 一定先于本包建好。
 *
 * ## skip 不是"关掉判据"
 *
 * 连接器包在（今天的全部环境，包括 CI）时，`connectorsPackagePresent` 为真 ⇒
 * `describe.skipIf(false)` 等价于原来的 `describe`，两个 spec **逐字照跑**。
 * 只有包真的不在检出里（那条路径今天不可达，是给"关掉连接器模块"准备的）才跳过，
 * 且跳过的形态是 **reporter 里可见的 skipped**，不是"悄悄少跑几条断言"。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * 连接器包是否在这个检出里（=<repo>/packages/host/connectors/package.json 存在）。
 */
export const connectorsPackagePresent: boolean = existsSync(
  fileURLToPath(new URL('../../../connectors/package.json', import.meta.url)),
)

/**
 * 真 `ConnectorStore` 模块，或 `null`（包不在检出里）。
 *
 * `null` 时调用点**不得**真的去用它：`import()` 被跳过了，所以这里也不会抛；
 * 调用点都写在 `describe.skipIf(!connectorsPackagePresent)` 里。
 */
export const connectorStoreModule: typeof import('@picoaide/dsh-connectors/store') | null =
  connectorsPackagePresent ? await import('@picoaide/dsh-connectors/store') : null

/**
 * 真 user-scope 模块（作用域布局的唯一真源），或 `null`（包不在检出里）。
 */
export const connectorUserScopeModule: typeof import('@picoaide/dsh-connectors/user-scope') | null =
  connectorsPackagePresent ? await import('@picoaide/dsh-connectors/user-scope') : null
