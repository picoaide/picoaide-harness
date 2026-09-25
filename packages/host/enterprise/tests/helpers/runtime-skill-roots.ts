/**
 * 企业侧测试的**运行时技能根隔离**（R13-GH3 · H2「跨根」）。
 *
 * 为什么需要：卸载的"成功"语义现在是"**运行时再列一次看不到它**"，而运行时发现面是
 * **多根合并**的（pinned 上游 `skill-filesystem` 的 `roots()`）：
 *
 *	<dshHome>/skills（400，能力中心管的那个根）
 *	<agentsHome>/skills（500，默认 `$DSH_AGENTS_HOME` 或 **真实 `~/.agents`**）
 *	bundled（600，`$DSH_BUNDLED_SKILL_DIR`）
 *
 * 不隔离时，"卸载 `<name>`"的用例会去看**开发机/CI runner 上真实存在的
 * `~/.agents/skills/<name>`**：命中就（正确地）返回 422 `RESIDUE`，用例于是变成
 * "这台机器上装了哪些技能"的函数。本仓实测过完整形态（把 16 个常用夹具名放进一个
 * 临时的 `DSH_AGENTS_HOME` 后跑整包）：
 *
 *	FAIL auth-gate-local-write-proof.spec.ts   （卸载 codeql）
 *	FAIL r10f5-skill-pack-root.spec.ts         （卸载 linked）
 *	FAIL skill-install-runtime-parity.spec.ts  （卸载 alpha）
 *	FAIL skill-install.spec.ts ×2              （卸载 alpha / self-made）
 *
 * 隔离口径：把**两个非托管根**指到一个**空的临时目录** ⇒ "运行时全根集合"退化成
 * "只有能力中心管的那个根"，这正是这些用例写作时假定的世界（技能都在自己的临时
 * `DSH_HOME` 里）。要**故意**测跨根行为（`skill-uninstall-cross-root.spec.ts`）
 * 就在自己的用例里显式覆写这两个变量。
 *
 * 用法：在这些用例的 `beforeEach` 里调用（`vi.stubEnv` 会在每个用例后还原，
 * 所以放在 `beforeEach` 而不是模块顶层）。
 */
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'

/** 进程内共享的空根（内容为空是判据的一部分：跨根残留必须为空）。 */
const ISOLATED_ROOT = join(tmpdir(), 'pico-test-runtime-skill-roots')

/**
 * 把两个**非托管**运行时技能根（agent / bundled）指到确定的空目录。
 *
 * 必须在每个用例前调用（`vi.stubEnv` 的作用域是用例）。
 */
export function isolateRuntimeSkillRoots(): void {
  mkdirSync(ISOLATED_ROOT, { recursive: true })
  vi.stubEnv('DSH_AGENTS_HOME', join(ISOLATED_ROOT, 'agents'))
  vi.stubEnv('DSH_BUNDLED_SKILL_DIR', join(ISOLATED_ROOT, 'bundled'))
}
