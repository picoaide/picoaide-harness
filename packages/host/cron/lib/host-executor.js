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
	* Execute one job action. Resolves when the execution is settled.
	* @returns the settle result for tests.
	*/
	async execute(job, _execution) {
		switch (job.action.kind) {
			case "task": {
				const taskService = this.deps.taskService();
				if (taskService === void 0) return {
					result: "failed",
					error: "task service unavailable (dsh-task plugin not loaded)"
				};
				try {
					const outcome = await taskService.runTask(job.action.taskId);
					if (outcome.ok) return { result: "succeeded" };
					return {
						result: "failed",
						error: outcome.error
					};
				} catch (error) {
					return {
						result: "failed",
						error: error instanceof Error ? error.message : String(error)
					};
				}
			}
			case "prompt": try {
				const response = await this.deps.api.sessions.prompt(request({
					sessionId: job.action.sessionId,
					mode: "queue",
					content: [{
						type: "text",
						text: job.action.text
					}]
				}));
				if (!response.result.ok) throw failure(response.result.error);
				return { result: "succeeded" };
			} catch (error) {
				return {
					result: "failed",
					error: error instanceof Error ? error.message : String(error)
				};
			}
		}
	}
};
//#endregion
export { HostCronExecutor };

//# sourceMappingURL=host-executor.js.map