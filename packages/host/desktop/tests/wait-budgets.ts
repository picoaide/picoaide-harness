/**
 * 桌面测试的**等待预算契约**（2026-09-24 第十轮审计 M-1 定案）。
 *
 * 覆盖**所有**等待型断言：`vi.waitFor(` 与 `expect.poll(` —— 两者在 vitest 4 里的缺省
 * `timeout` 都是 **1s**，所以同一份预算契约必须同时罩住它们。
 *
 * ## 契约：等待预算必须 ≥ 它要观察的现象的最坏时长
 *
 * 起因是一条**假红**：同一个 commit（`f36a9711ae`）的 master push run 红在
 * `tests/updates.spec.ts`（`assertion inside vi.waitFor`），同 commit 的 tag run 全绿 ——
 * 被审的树逐字节相同。机制是预算与现象的**量级错位**：`tests/**` 里 57 处
 * `vi.waitFor` 全吃 vitest 的缺省 `timeout = 1_000ms`（vitest 4.1.8
 * `dist/chunks/test.DNmyFkvJ.js` 的 `waitFor(callback, options = {})`：
 * `const { interval = 50, timeout = 1e3 } = options`），而它们观察的是
 * "清单请求 → 状态机 → 快照 / 托盘 / 对话框"这条跨若干异步边界的链 ——
 * CI（4 vCPU、13 个包并发）上 1s 不够，于是门禁随机红灯，团队被训练出
 * "rerun 一下就好"的习惯（第九轮的 `--body fileb://` 就是这样活到 tag 的）。
 *
 * 同族缺陷本仓已登记过一次：`packages/host/connectors/vitest.config.ts` 因
 * "缺省 5s `testTimeout` 短于用例自身预算"被抬到 30s。
 *
 * ## 第二类假红：等待条件钉死**墙钟现算**的毫秒值
 *
 * 预算只是这件事的一半。同一个 flake 的更深一半是：等待条件写成
 * `toHaveBeenCalledWith(objectContaining({ retryDelayMs: 10_000 }))`，而
 * `retryDelayMs` 是**墙钟现算**的（`beginRetryWait` 记绝对截止时刻，快照里是
 * `截止时刻 - Date.now()`）—— 置位与首次发布之间只隔两条语句，负载下墙钟越过
 * 1ms 就会发布成 **9_999**，而倒计时此后只减不增 ⇒ 条件**永不可满足**（给多少预算
 * 都红）。2026-09-24 四路并发实测捕获到的接收序列正是 `0 0 0 0 0 9999 9000 7997 …`。
 *
 * 规矩：这类字段只能用**比较/容差**断言（`toBeGreaterThan(9_900)`），不得用
 * `toBe`/`toEqual`/对象字面量钉精确值。判据由 `wait-budget-contract.spec.ts` 的一条
 * 静态用例强制（`CLOCK_DERIVED_FIELDS`）。
 *
 * ## 用法
 *
 * ```ts
 * // 现象：一次清单请求后状态机发起下载（状态传播档）。
 * await vi.waitFor(() => { expect(harness.downloadUpdate).toHaveBeenCalledOnce() },
 *   { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS })
 * // 现象：模型开始流之后活体会话可见（状态传播档）。
 * await expect.poll(() => ctx.sessions.get(id), { timeout: WAIT_BUDGETS.STATE_PROPAGATION_MS }).toBeDefined()
 * ```
 *
 * ## 硬约束（由 `tests/wait-budget-contract.spec.ts` 静态强制，可被变异打坏）
 *
 * 1. `tests/**` 里**每一个**等待型断言（`vi.waitFor(` / `expect.poll(`）都必须显式给 `timeout`；
 * 2. 该 `timeout` 必须引用本表（数值字面量、别的对象都不算）；
 * 3. 引用到的键必须真实存在；
 * 4. 本表每一项都必须 ≥ `WAIT_BUDGET_FLOORS` 里登记的现象下限 ——
 *    把预算改小不会让判据变绿，只会让判据变红；
 * 5. 每个调用点上方必须有一行"现象"理由注释（预算的来源要逐处可读）；
 * 6. 等待条件不得对**墙钟现算字段**钉精确值（第二类假红，见上）；
 * 7. 用例自己的预算（显式 `testTimeout` 或包缺省）必须 ≥ 它内部用到的等待预算 ——
 *    否则等待预算永远用不满（实测形态：`Error: Test timed out in 5000ms`）。
 *
 * @module dsh-plugin-desktop/tests/wait-budgets
 */

/**
 * `vi.waitFor` 的等待预算（毫秒）。
 *
 * 取值口径 = 该档**被观察现象的最坏时长**，不是"平时多快"。
 */
export const WAIT_BUDGETS = {
  /**
   * **状态传播档**：进程内的异步链（请求替身 → 状态机 → 发布快照 / 托盘标签 /
   * 原生对话框 / 宿主调用）。现象本身是毫秒级；预算买的是**调度余量**。
   *
   * 依据：1s 缺省在 CI 上已被实测打红（同一棵树一红一绿），10s 是"1s 不够"的
   * 最小可用档，也是主控在 M-1 里给定的下限。
   */
  STATE_PROPAGATION_MS: 10_000,
  /**
   * **重试退避档**：被观察的快照出现在**真实计时器上的 10s 退避窗口**内
   * （`updates.ts` 的传输重试：`transferRetryDelaysMs` 的自定义值 10_000）。
   * 等待预算必须覆盖**整个窗口**再加余量 —— 取 1s 缺省时预算只有窗口的 1/10。
   */
  RETRY_BACKOFF_WINDOW_MS: 12_000,
  /**
   * **真实 I/O 档**：现象要穿过真实磁盘（状态文件读写 / 安装包复用校验）或真实
   * 下载器与子进程句柄。比状态传播多一段真实 I/O 抖动，故留更大余量。
   */
  REAL_IO_MS: 15_000,
} as const

/** `WAIT_BUDGETS` 每一项的**现象下限**：预算低于它即违反契约（判据会红）。 */
export const WAIT_BUDGET_FLOORS = {
  /** CI 实测 1s 缺省不够；10s = "≥ 现象时长"的最小可用档。 */
  STATE_PROPAGATION_MS: 10_000,
  /** 退避窗口本身 10s ⇒ 预算 ≥ 12s（窗口 + 2s 余量）。 */
  RETRY_BACKOFF_WINDOW_MS: 12_000,
  /** 真实 I/O 至少不低于状态传播档（同一份调度余量之上再加 I/O 抖动）。 */
  REAL_IO_MS: 10_000,
} as const

/**
 * 单条用例的 `testTimeout` 预算（vitest 缺省 5_000ms）。
 *
 * 只给"工作量本身就有量级"的用例 —— 缺省值对绝大多数用例是对的，抬全局缺省会让
 * "真挂了要等多久才报"整体变长；反过来，工作量大的用例必须自己声明。
 */
export const TEST_BUDGETS = {
  /**
   * **真实打包产物上的清单派生**：`verify-packaged-runtime.spec.ts` 的反向 oracle
   * 要在真实产物目录上遍历 `node_modules/@picoaide/**` 并把派生出的每一条逐条
   * 反推。空闲机实测 911ms；三路套件并发时实测撞穿 5s 缺省
   * （`Test timed out in 5000ms`）⇒ 取 60s（≥10× 空闲耗时）。
   */
  ARTIFACT_DERIVATION_MS: 60_000,
} as const

/** `TEST_BUDGETS` 每一项的现象下限。 */
export const TEST_BUDGET_FLOORS = {
  /** 空闲 911ms / 并发 >5s ⇒ 下限 30s（与 connectors 的同族决定同档）。 */
  ARTIFACT_DERIVATION_MS: 30_000,
} as const
