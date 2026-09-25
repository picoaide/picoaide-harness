/**
 * 上游锚点②（网关出站头名）的**冻结件**。
 *
 * ## 为什么需要它
 *
 * 本仓有两类 CI job：
 * - `Gate (tests + workspace build)`：`actions/checkout` 带 `submodules: recursive` ⇒
 *   `deepseek-harness/` 在场；
 * - `Go server`：**不检 submodule**（省一次大检出）⇒ `deepseek-harness/**` 整棵不存在。
 *
 * 而 `opens-contract-parity.spec.ts` 的"归因链路三段锚点齐备"用例会在**两类 job 里都跑**
 * （它是 webadmin 的 vitest 用例）。第一版实现无条件是读活文件 ⇒ 在 `Go server` job 里报
 * `上游出站头名: 文件不存在 deepseek-harness/…/adapter.ts`，把必需的 `Go server` 检查打红
 * （第十三轮 PR #149 首跑实测）。**这是"判据依赖了本 job 不存在的输入"这一类缺陷**，
 * 不是上游问题。
 *
 * ## 口径（两条一起成立才判绿）
 *
 * 1. **submodule 在场时**：锚点必须出现在活文件里，**并且**活文件必须逐字包含下面的冻结行
 *    —— 后者是"上游漂移 ⇒ 红"的那一半（pin 换了、那一行改了，就必须同步这个冻结件）。
 * 2. **submodule 缺席时**：用冻结件判锚点是否存在，并在用例里**显式记录来源**
 *    （不静默降级成 skip：锚点这条判据在两类 job 里都必须真的判）。
 *
 * ## 更新方式
 *
 * 改 `deepseek-harness` 的 pin 或该适配器之后：从
 * `deepseek-harness/packages/llm/llm-deepseek/src/protocols/chat-completions/adapter.ts`
 * 复制那一行原文替换下面的常量，并在同一个 PR 里提交（判据会强制你做这件事）。
 */
export const UPSTREAM_SESSION_HEADER_LINE =
  "        ? { 'x-deepseek-harness-session-id': String(options.sessionId) }"
