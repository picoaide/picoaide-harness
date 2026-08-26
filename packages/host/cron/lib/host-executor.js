//#region src/host-executor.ts
function request(payload) {
	return {
		rpcId: `cron-${crypto.randomUUID()}`,
		payload
	};
}
function failure(error) {
	return /* @__PURE__ */ new Error(`${error.code}: ${error.message}`);
}
var HostCronExecutor = class {
	deps;
	constructor(deps) {
		this.deps = deps;
	}
	/**
	* Execute one job action. Resolves when the execution is settled (the
	* caller records sessionId/prompt onto the execution record via the
	* returned launch info; a session that was created then failed to launch
	* is reported through `error` so the ledger can settle as failed).
	*/
	async execute(job) {
		if (job.action.kind !== "agent") return {
			result: "failed",
			error: `unsupported action kind: ${String(job.action.kind)}`
		};
		const prompt = job.action.prompt;
		try {
			if (job.action.workspaceId !== void 0) {
				const workspaces = await this.deps.api.workspace.list(request({}));
				if (!workspaces.result.ok) throw failure(workspaces.result.error);
				if (!workspaces.result.value.items.some((item) => item.workspaceId === job.action.workspaceId)) throw new Error(`workspace not found: ${job.action.workspaceId}`);
			}
			if (job.action.agentPreset !== void 0) {
				const presets = await this.deps.api.agentPresets.list(request({}));
				if (!presets.result.ok) throw failure(presets.result.error);
				const preset = presets.result.value.presets.find((item) => item.id === job.action.agentPreset);
				if (preset === void 0) throw new Error(`agent preset not found: ${job.action.agentPreset}`);
				if (preset.broken !== void 0) throw new Error(`agent preset is unavailable: ${preset.broken}`);
			}
			const created = await this.deps.api.sessions.create(request({
				...job.action.workspaceId === void 0 ? {} : { workspaceId: job.action.workspaceId },
				...job.action.agentPreset === void 0 ? {} : { agentPreset: job.action.agentPreset }
			}));
			if (!created.result.ok) throw failure(created.result.error);
			const sessionId = created.result.value.sessionId;
			try {
				const renamed = await this.deps.api.sessions.rename(request({
					sessionId,
					title: job.name
				}));
				if (!renamed.result.ok) throw failure(renamed.result.error);
				if (job.action.permission !== void 0) {
					const command = await this.deps.api.sessions.prompt(request({
						sessionId,
						mode: "queue",
						content: [{
							type: "text",
							text: `/permission ${job.action.permission}`
						}]
					}));
					if (!command.result.ok) throw failure(command.result.error);
					if (command.result.value.command?.kind !== "success") throw new Error("permission command was not acknowledged");
				}
				const prompted = await this.deps.api.sessions.prompt(request({
					sessionId,
					mode: "queue",
					content: [{
						type: "text",
						text: prompt
					}]
				}));
				if (!prompted.result.ok) throw failure(prompted.result.error);
			} catch (error) {
				return {
					result: "failed",
					error: error instanceof Error ? error.message : String(error),
					sessionId,
					prompt
				};
			}
			return {
				result: "succeeded",
				sessionId,
				prompt
			};
		} catch (error) {
			return {
				result: "failed",
				error: error instanceof Error ? error.message : String(error),
				prompt
			};
		}
	}
};
//#endregion
export { HostCronExecutor };

//# sourceMappingURL=host-executor.js.map