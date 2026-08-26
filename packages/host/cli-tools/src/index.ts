/**
 * @picoaide/dsh-cli-tools: CLI binary auto-installer for skill-side tooling.
 *
 * 决策 2026-08-25:CLI 生命周期从连接器框架删除——CLI 就是 skill,AI 按技能
 * 市场里的 SKILL.md 引导操作。本包只做两件事:技能触发(requires.bins)时
 * 自动安装 pinned CLI 二进制(dws / wecom-cli / lark-cli / beisen-cli)与
 * 提供 CLI 凭证落盘环境(dwsEnv)。授权由 AI 跑 CLI 命令(auth login)自行
 * 完成,不做授权状态管理。
 */

export { ensureCliInstalled, CliInstaller, type CliInstallOptions, type CliInstallResult, type CliProgress } from './cli-installer.ts'
export { CLI_MANIFESTS, cliPlatformKey, type CliBinaryManifest, type CliPlatform } from './cli-manifest.ts'
export { dwsEnv, resolveDshHome, DSH_HOME_ENV, PRODUCT_DSH_HOME_DIR } from './home.ts'
