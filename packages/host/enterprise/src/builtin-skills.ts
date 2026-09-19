/**
 * 平台内置技能（服务端下发、客户端按需安装）的**共享事实**。
 *
 * 用户要求：「skill 应该是内置到服务端，客户端可以按需安装」。链路的三个落点：
 *   - 服务端：`server/internal/wasmapp/skillseed` 把镜像内 `/opt/picoaide/skills`
 *     打包下发（`GET /api/client/v2/skills/builtin[/:name/archive]`）；
 *   - 客户端安装：`auth-gate.ts` 的 `/api/pico/skills/builtin*` 两条分支 →
 *     `installSkillArchive()` → `<dshHome>/skills/<name>`（复用市场那条链路）；
 *   - 入口：能力中心的「平台内置技能」区（`client/BuiltinSkillsStrip.tsx`）。
 *
 * 这个模块只放**跨模块共享的常量与判定**，避免同一个名字/路径在三处各写一遍：
 * 工具面（`wasm-app-tools.ts`）要用它判断"作者手册装了没有"，并据此给出指路
 * 提示 —— 用户明确要求过：**技能没装时，`wasm_app_*` 工具报错必须告诉模型
 * "先让用户去能力中心装这个技能"**，否则模型只会对着工具报错空转。
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveSkillsDir } from './skill-install.ts'
import { DEFAULT_HOST_LOCALE, hostCopy, type HostLocale } from 'dsh-plugin-desktop/host-locale'

/**
 * 平台内置的 WASM 应用作者手册技能名（服务端资产目录名 = 技能运行时名）。
 *
 * 名字必须与 `server/skills/app-builder/` 的**目录名**和 SKILL.md frontmatter 的
 * `name` 逐字一致（2026-09-19 由 `picoaide-app-builder` 改名而来）：服务端
 * `skillseed` 用目录名当 declaredAppID 调 `skillmanifest.Parse`，不一致会让整条
 * 技能在启动扫描时被静默丢弃（接口 200 + 空数组），客户端这里也就永远提示"未安装"。
 */
export const APP_BUILDER_SKILL = 'app-builder'

/**
 * 该内置技能是否已装到本机（`<dshHome>/skills/<name>/SKILL.md` 存在）。
 *
 * 判定刻意只看磁盘事实，不查能力中心目录 —— 工具报错路径要的是"这台机器上
 * 到底能不能用"，而不是"服务端提供了没有"。
 * @param name - 技能名（缺省 = 应用作者手册）。
 * @param skillsDir - 技能根（缺省 `resolveSkillsDir()`，测试可注入）。
 * @returns 已装为 true；未装或读不到为 false（保守：宁可不提示，也不谎报已装）。
 */
export async function isBuiltinSkillInstalled(
  name: string = APP_BUILDER_SKILL,
  skillsDir?: string,
): Promise<boolean> {
  try {
    await stat(join(skillsDir ?? resolveSkillsDir(), name, 'SKILL.md'))
    return true
  } catch {
    return false
  }
}

/**
 * 「去装内置技能」的指路文案（走宿主语言，与仓库既有口径一致）。
 *
 * 用在 `wasm_app_*` 工具的失败 hints 里：技能没装时，模型拿到的不是一句
 * "工具失败"，而是"让用户在能力中心点一下安装"这一条可执行的下一步。
 * @param locale - 宿主语言（调用方按请求解析后传入）。
 * @param name - 技能名（缺省 = 应用作者手册）。
 * @returns 用户可读的一句话（客户端把它展示在工具结果里）。
 */
export function builtinSkillInstallHint(locale: HostLocale = DEFAULT_HOST_LOCALE, name: string = APP_BUILDER_SKILL): string {
  return hostCopy(
    locale,
    `平台内置技能「${name}」尚未安装到本机：请在客户端「能力中心 → 平台内置技能」里点一次「安装」（服务端随镜像下发，装完立即生效，不需要管理员）。`,
    `The built-in skill "${name}" is not installed on this machine yet: open the client's Capability Hub → Built-in skills and click Install once (the server ships it with its image; it takes effect immediately and needs no admin).`,
  )
}
