/**
 * CLI-skill bridge: model-facing CLI tooling for the「CLI 即 skill」架构。
 *
 * 决策 2026-08-25:CLI 生命周期从连接器框架删除——官方 CLI(dws / wecom-cli /
 * lark-cli / beisen-cli)作为技能(SKILL.md)内置,AI 按技能市场引导操作;
 * 首次触发时经本插件自动安装二进制(cli-tools, npmmirror 镜像, sha256)。
 *
 * 模型工具:
 * - cli_install: 安装(或确认已装)一个受支持的 CLI,dws/wecom-cli/lark-cli/
 *   beisen-cli;返回二进制路径与提示。
 * - cli_list: 列出全部受支持 CLI 与安装状态(已装/未装),供模型感知。
 *
 * 技能目录: 桌面启动设置 $DSH_BUNDLED_SKILL_DIR 指向内置 CLI skill 包
 * (resources/cli-skills, 官方 SKILL.md),上游 skill-filesystem 自动发现。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CLI_MANIFESTS, ensureCliInstalled, dwsEnv } from '@picoaide/dsh-cli-tools'
import { join } from 'node:path'

export const name = 'pico-cli-skill-bridge'
export const inject = ['tools']

/** Cache root: product home cli-cache (cli-tools default uses it). */
function cliCacheDir(): string {
  return (process.env.DSH_HOME ?? join(process.env.HOME ?? '~', '.picoaide-harness')) + '/cli-cache'
}

/** Register the model-facing CLI tools; returns the disposer. */
export function apply(ctx: Context): void {
  const disposers: Array<() => void> = []

  disposers.push(ctx.tools.register(defineTool({
    name: 'cli_install',
    description: '安装(或确认已装)一个 CLI 命令工具(钉钉 dws / 企业微信 wecom-cli / 飞书 lark-cli / 北森 beisen-cli)。模型按 SKILL.md 指引操作前,若对应 CLI 未装,调用本工具自动安装(国内镜像,校验和验证,仅首次)。安装完成后即可用 bash 工具执行 cli 命令。',
    parameters: {
      name: { type: 'string', required: true, description: 'CLI 命令名: dws / wecom-cli / lark-cli / beisen-cli' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: `CLI ${(value as { name: string }).name} 就绪(${(value as { fromCache: boolean }).fromCache ? '已缓存' : '已安装'}): ${(value as { binaryPath: string }).binaryPath}` }],
    },
    async execute(args) {
      const name = (args.name ?? '').trim()
      if (!CLI_MANIFESTS.has(name)) {
        throw new Error(`不支持的 CLI: ${name}(支持: ${[...CLI_MANIFESTS.keys()].join(', ')})`)
      }
      const result = await ensureCliInstalled(name, { cacheDir: cliCacheDir() })
      return { name, ...result }
    },
  })))

  disposers.push(ctx.tools.register(defineTool({
    name: 'cli_list',
    description: '列出全部受支持的 CLI 命令工具与安装状态(已装/未装)。模型感知环境后决定是否调用 cli_install。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      return [...CLI_MANIFESTS.keys()].map((name) => ({ name, version: CLI_MANIFESTS.get(name)!.version }))
    },
  })))

  ctx.effect(() => () => { for (const d of disposers) d() }, 'pico cli-skill-bridge cleanup')
}

// Keep dwsEnv exported for consumers that need CLI credential home (dws login).
export { dwsEnv }
