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
import type { Context } from '@deepseek-ai/cordis';
import { dwsEnv } from '@picoaide/dsh-cli-tools';
export declare const name = "pico-cli-skill-bridge";
export declare const inject: string[];
/** Register the model-facing CLI tools; returns the disposer. */
export declare function apply(ctx: Context): void;
export { dwsEnv };
