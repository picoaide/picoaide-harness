import { defineTool } from "@deepseek-ai/dsh-tools";
import { CLI_MANIFESTS, dwsEnv, ensureCliInstalled } from "@picoaide/dsh-cli-tools";
import { join } from "node:path";
//#region src/index.ts
const name = "pico-cli-skill-bridge";
const inject = ["tools"];
/** Cache root: product home cli-cache (cli-tools default uses it). */
function cliCacheDir() {
	return (process.env.DSH_HOME ?? join(process.env.HOME ?? "~", ".picoaide-harness")) + "/cli-cache";
}
/** Register the model-facing CLI tools; returns the disposer. */
function apply(ctx) {
	const disposers = [];
	disposers.push(ctx.tools.register(defineTool({
		name: "cli_install",
		description: "安装(或确认已装)一个 CLI 命令工具(钉钉 dws / 企业微信 wecom-cli / 飞书 lark-cli / 北森 beisen-cli)。模型按 SKILL.md 指引操作前,若对应 CLI 未装,调用本工具自动安装(国内镜像,校验和验证,仅首次)。安装完成后即可用 bash 工具执行 cli 命令。",
		parameters: { name: {
			type: "string",
			required: true,
			description: "CLI 命令名: dws / wecom-cli / lark-cli / beisen-cli"
		} },
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{
				type: "text",
				text: `CLI ${value.name} 就绪(${value.fromCache ? "已缓存" : "已安装"}): ${value.binaryPath}`
			}]
		},
		async execute(args) {
			const name = (args.name ?? "").trim();
			if (!CLI_MANIFESTS.has(name)) throw new Error(`不支持的 CLI: ${name}(支持: ${[...CLI_MANIFESTS.keys()].join(", ")})`);
			return {
				name,
				...await ensureCliInstalled(name, { cacheDir: cliCacheDir() })
			};
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "cli_list",
		description: "列出全部受支持的 CLI 命令工具与安装状态(已装/未装)。模型感知环境后决定是否调用 cli_install。",
		parameters: {},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value)
			}]
		},
		async execute() {
			return [...CLI_MANIFESTS.keys()].map((name) => ({
				name,
				version: CLI_MANIFESTS.get(name).version
			}));
		}
	})));
	ctx.effect(() => () => {
		for (const d of disposers) d();
	}, "pico cli-skill-bridge cleanup");
}
//#endregion
export { apply, dwsEnv, inject, name };

//# sourceMappingURL=index.js.map