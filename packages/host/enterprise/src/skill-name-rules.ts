/**
 * Windows 保留设备名 —— **写侧名字闸门的单一真源**（R17 泳道 Z，R17B-05）。
 *
 * ## 缺陷形态（审计 R17B-05，实测）
 *
 * 两端（客户端 `SKILL_NAME_PATTERN`、服务端 `internal/skillmanifest` 的 `appIDRe`）
 * 都只要求 kebab-case，于是 `con` / `nul` / `aux` / `prn` / `com1` / `lpt1` 这类
 * **Win32 保留设备名**全被放行：
 *
 *  - `validateSkillName('con')` 不抛、`precheckSkillPackage(…, 'con', …)` 返回
 *    `issues: []` ⇒ 作者可以把它发布到市场；
 *  - Linux/macOS 上装得上、跑得起来（那里的文件系统不认 Win32 设备名语义）；
 *  - Windows 上在"建目录 / 落文件"那一步失败，而 `EINVAL` 不在
 *    `ERRNO_HINT`（`skill-install.ts`）里 ⇒ 落到 502 兜底文案，用户看不到任何
 *    可行动信息（既不知道是名字问题，也不知道该改什么）。
 *
 * 同一个洞也覆盖**归档内部条目名**（技能目录里放 `aux.txt` / `nul`）：解包在
 * Windows 上同样失败，而预检与安装前的 `assertArchiveSafe` 都不拦。
 *
 * ## 判据为什么写在这里、而不是塞进 `SKILL_NAME_PATTERN`
 *
 * `SKILL_NAME_PATTERN`（`skill-install.ts`）是**运行时**判据的镜像：上游
 * `@deepseek-ai/dsh-skill` 的 `SKILL_NAME` 用它决定"加载不加载"。`con` 在
 * Linux/macOS 上**确实会被加载**，所以"能不能加载"必须继续放行它 —— 否则
 * `listInstalledSkills` 会与运行时注册表出现差集（本仓反复消灭的那类缺陷），
 * 而且用户已有的 `con` 目录会连**卸载**都做不到（`uninstallSkill` 也走
 * `validateSkillName`）。
 *
 * 因此保留名是**写侧**闸门（安装 / 打包预检 / 归档扫描），与"运行时能不能加载"
 * 正交：装不上，但已经存在的照样看得见、删得掉。
 *
 * ## 判据细节（Windows 语义，逐条对齐 Microsoft 的命名文档）
 *
 *  - 大小写不敏感（`CON`/`Con`/`con` 都保留）；
 *  - 扩展名不豁免：`con.txt`、`nul.md` 同样命中（保留名看的是**第一段**）；
 *  - 结尾的点与空格被 Windows 忽略 ⇒ `con.` / `con ` 也命中。
 *
 * **文档边界（本机是 Linux，无法实测 Windows 行为）**：`COM0`/`LPT0`、上标写法
 * （`COM¹`）、`CONIN$`/`CONOUT$`、以及 `\\?\` 前缀形态不在本表内 —— 表里只放
 * Microsoft 文档明确列出的那一组（CON/PRN/AUX/NUL/COM1-9/LPT1-9），宁可少判
 * 也不误杀合法名字。
 */

/** Microsoft 文档列出的 Win32 保留设备名（判断一律走 {@link isWindowsReservedDeviceNameSegment}）。 */
export const WINDOWS_RESERVED_DEVICE_NAMES: readonly string[] = [
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]

const RESERVED_DEVICE_NAMES = new Set<string>(WINDOWS_RESERVED_DEVICE_NAMES)

/**
 * 单个路径段是不是 Win32 保留设备名。
 *
 * @param segment - 一个路径段（技能名、目录名、归档条目的某一段）。
 * @returns 命中保留名（写侧必须拒绝）为 true。
 */
export function isWindowsReservedDeviceNameSegment(segment: string): boolean {
  // 扩展名不豁免：`con.txt` 的第一段就是 `con`。
  const firstDot = segment.indexOf('.')
  const head = firstDot === -1 ? segment : segment.slice(0, firstDot)
  // Windows 忽略结尾的空格（点已在上面切掉）。
  return RESERVED_DEVICE_NAMES.has(head.replace(/[ ]+$/u, '').toLowerCase())
}

/**
 * 归档条目（posix 相对路径）里第一个命中保留名的段。
 *
 * 归档是 posix 形状，所以按 `/` 切；`\` 也当分隔符（zip 里两种都出现过，
 * `archive-util.ts` 的 `posixNormalize` 同样把 `\` 归一成 `/`）。
 *
 * @param entryPath - 归档条目路径（已 normalize 或原始形态都可）。
 * @returns 命中的段（用于错误文案）；没有命中时为 undefined。
 */
export function reservedDeviceNameInArchivePath(entryPath: string): string | undefined {
  for (const segment of entryPath.replace(/\\/gu, '/').split('/')) {
    if (segment === '' || segment === '.' || segment === '..') continue
    if (isWindowsReservedDeviceNameSegment(segment)) return segment
  }
  return undefined
}
