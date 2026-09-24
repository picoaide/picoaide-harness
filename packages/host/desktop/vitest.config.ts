/**
 * 桌面包测试配置。
 *
 * ## 等待预算契约（2026-09-24 第十轮审计 M-1 定案，**成文**）
 *
 * **任何"等一个现象出现"的预算都必须 ≥ 该现象的最坏时长；用例自己的预算必须 ≥
 * 它内部用到的等待预算** —— 后一条是前一条的前提，否则预算根本用不满。
 *
 * 起因是一条假红：同一个 commit（`f36a9711ae`）的 master push run 红在
 * `tests/updates.spec.ts`（`assertion inside vi.waitFor`），而**同一棵树**的 tag run
 * 全绿 —— 机制是预算与现象的量级错位：`vi.waitFor` 的缺省 `timeout` 是 **1_000ms**
 * （vitest 4.1.8 `dist/chunks/test.DNmyFkvJ.js`：`const { interval = 50, timeout = 1e3 } = options`），
 * 而桌面用例观察的是"清单请求 → 状态机 → 快照 / 托盘 / 对话框"这类跨若干异步边界的链，
 * CI（4 vCPU × 13 个包并发）上 1s 不够 ⇒ 门禁随机红灯。同族缺陷本仓已登记过一次
 * （`packages/host/connectors/vitest.config.ts` 把缺省 `testTimeout` 抬到 30s）。
 *
 * ### 为什么这里也抬 `testTimeout`（而不是只补 `vi.waitFor` 的预算）
 *
 * 只补等待预算在本机 4 路负载下被实测证伪：`for i in 1 2 3 4; do vitest run
 * tests/updates.spec.ts & done; wait` 连续 24 次里红 2 次，红的都是
 * `keeps the download state and the countdown visible during the backoff wait`，
 * 形态是 **`Error: Test timed out in 5000ms`**（用例级缺省先掐死）——它内部那条
 * `vi.waitFor` 已经给了 12s（退避窗口档），但那 12s **永远用不满**：用例在 5s 就被
 * 判失败，而且报错变成"超时"，看不出挂在哪一条断言上。**等待预算 > 用例预算 = 预算
 * 不可达**，所以两者必须一起满足。
 *
 * `testTimeout: 30_000` 的本机依据：该用例在负载下越过 5s（实测两次红都在 5001ms），
 * 30s 同时 ≥ 本包最大的等待预算（真实 I/O 档 15s）与退避档（12s）；与 connectors 的
 * 同族决定同档。代价只有"真挂了要等多久才报"（5s → 30s），断言强度不变。
 *
 * ### 三条规矩
 *
 * 1. **每个等待型断言（`vi.waitFor` / `expect.poll`，两者缺省都是 1s）都必须显式给预算**，
 *    且预算只能取自 `tests/wait-budgets.ts`
 *    的 `WAIT_BUDGETS`（数值字面量不算）—— 取值口径 = 该档被观察现象的最坏时长，
 *    每个调用点上方留一行"现象"理由。
 * 2. **工作量本身有量级的用例自己声明 `testTimeout`**（`TEST_BUDGETS`）：例如在真实
 *    打包产物上逐条派生清单的 `verify-packaged-runtime.spec.ts` 反向 oracle（空闲
 *    911ms、三路并发时撞穿 5s 缺省 ⇒ 显式 60s）。缺省值对该类用例不够，靠上面的
 *    30s 只是兜底，显式声明才是"这条用例知道自己要多久"。
 * 3. 契约由 `tests/wait-budget-contract.spec.ts` **静态强制**（AST 判据：显式预算、
 *    引用集中表、键存在、预算 ≥ 登记的现象下限、逐处理由注释、**用例预算 ≥ 内部等待
 *    预算**、扫描面不空转），并且判据自身可被变异打坏（把任一调用点改回缺省即红）。
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    // 见文件头：每个显式等待预算都必须可达（等待预算 > 用例预算时预算不可达），
    // 本机 4 路负载实测该用例越过 5s 缺省后由此档兜住。
    testTimeout: 30_000,
    // Profile integration tests create a full package-junction closure; higher
    // Windows file concurrency makes their latency depend on NTFS/Defender load.
    maxWorkers: process.platform === 'win32' ? 2 : undefined,
  },
})
