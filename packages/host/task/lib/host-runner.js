import { t as buildTaskPrompt } from "./task-prompt-B98YMf_9.js";
//#region src/host-runner.ts
function request(payload) {
	return {
		rpcId: `task-${crypto.randomUUID()}`,
		payload
	};
}
function failure(error) {
	return /* @__PURE__ */ new Error(`${error.code}: ${error.message}`);
}
/** A post-create launch failure that still identifies the session to the ledger. */
var SessionLaunchError = class extends Error {
	sessionId;
	constructor(sessionId, cause) {
		super(`execution session ${sessionId} failed during launch: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
		this.sessionId = sessionId;
		this.name = "SessionLaunchError";
	}
};
function isErrorTurnEnd(data) {
	if (typeof data !== "object" || data === null) return false;
	const reason = data.reason;
	return typeof reason === "object" && reason !== null && reason.kind === "error";
}
var HostExecutionRunner = class {
	api;
	constructor(api) {
		this.api = api;
	}
	async launch(task) {
		if (task.workspaceId !== void 0) {
			const workspaces = await this.api.workspace.list(request({}));
			if (!workspaces.result.ok) throw failure(workspaces.result.error);
			if (!workspaces.result.value.items.some((item) => item.workspaceId === task.workspaceId)) throw new Error(`workspace not found: ${task.workspaceId}`);
		}
		if (task.mode !== void 0) {
			const presets = await this.api.agentPresets.list(request({}));
			if (!presets.result.ok) throw failure(presets.result.error);
			const preset = presets.result.value.presets.find((item) => item.id === task.mode);
			if (preset === void 0) throw new Error(`agent preset not found: ${task.mode}`);
			if (preset.broken !== void 0) throw new Error(`agent preset is unavailable: ${preset.broken}`);
		}
		const created = await this.api.sessions.create(request({
			...task.workspaceId === void 0 ? {} : { workspaceId: task.workspaceId },
			...task.mode === void 0 ? {} : { agentPreset: task.mode }
		}));
		if (!created.result.ok) throw failure(created.result.error);
		const sessionId = created.result.value.sessionId;
		try {
			const renamed = await this.api.sessions.rename(request({
				sessionId,
				title: task.title
			}));
			if (!renamed.result.ok) throw failure(renamed.result.error);
			if (task.permission !== void 0) {
				const command = await this.api.sessions.prompt(request({
					sessionId,
					mode: "queue",
					content: [{
						type: "text",
						text: `/permission ${task.permission}`
					}]
				}));
				if (!command.result.ok) throw failure(command.result.error);
				if (command.result.value.command?.kind !== "success") throw new Error("permission command was not acknowledged");
			}
			const assembled = buildTaskPrompt(task);
			const prompt = await this.api.sessions.prompt(request({
				sessionId,
				mode: "queue",
				content: [{
					type: "text",
					text: assembled
				}]
			}));
			if (!prompt.result.ok) throw failure(prompt.result.error);
		} catch (error) {
			throw new SessionLaunchError(sessionId, error);
		}
		return sessionId;
	}
	async listRunning() {
		try {
			const response = await this.api.sessions.list(request({}));
			return response.result.ok ? {
				known: true,
				count: response.result.value.items.filter((item) => item.running).length,
				items: response.result.value.items
			} : { known: false };
		} catch {
			return { known: false };
		}
	}
	/**
	* P0-3: ask the running session to stop. Best-effort — the ledger already
	* settles the execution as cancelled; if the session is gone or the stop
	* command fails, the settlement poll converges the state anyway.
	*/
	async cancelSession(sessionId) {
		try {
			const response = await this.api.sessions.prompt(request({
				sessionId,
				mode: "queue",
				content: [{
					type: "text",
					text: "/stop"
				}]
			}));
			if (!response.result.ok) return;
			const accepted = response.result.value.command;
			if (accepted !== void 0 && accepted.kind !== "success") {}
		} catch {}
	}
	/**
	* Resolve one execution's outcome from the shared session list (one list
	* RPC per poll tick, not 1 + E).
	*/
	async inspect(sessionId, startedAt = 0, sessions) {
		let items;
		if (sessions !== void 0) items = sessions;
		else {
			const response = await this.api.sessions.list(request({}));
			if (!response.result.ok) return { outcome: "pending" };
			items = response.result.value.items;
		}
		const summary = items.find((item) => item.sessionId === sessionId);
		if (summary === void 0) return {
			outcome: "cancelled",
			error: "execution session no longer exists"
		};
		if (summary.running) return { outcome: "pending" };
		const events = [];
		let beforeSeq;
		let reachedExecutionBoundary = false;
		for (let page = 0; page < 100; page += 1) {
			const history = await this.api.sessions.history(request({
				sessionId: summary.sessionId,
				maxMessages: 100,
				...beforeSeq === void 0 ? {} : { beforeSeq }
			}));
			if (!history.result.ok) return { outcome: "pending" };
			events.push(...history.result.value.events);
			const oldestTime = history.result.value.events.reduce((oldest, entry) => {
				const time = entry.event.time;
				return typeof time !== "number" ? oldest : oldest === void 0 ? time : Math.min(oldest, time);
			}, void 0);
			if (!history.result.value.hasMore || oldestTime !== void 0 && oldestTime <= startedAt) {
				reachedExecutionBoundary = true;
				break;
			}
			const oldestSeq = history.result.value.events.reduce((oldest, entry) => {
				const seq = entry.event.seq;
				return typeof seq !== "number" ? oldest : oldest === void 0 ? seq : Math.min(oldest, seq);
			}, void 0);
			if (oldestSeq === void 0 || oldestSeq === beforeSeq) return { outcome: "pending" };
			beforeSeq = oldestSeq;
		}
		if (!reachedExecutionBoundary) return { outcome: "pending" };
		const turnEnd = events.filter((entry) => entry.event.type === "turn/end" && (startedAt <= 0 || typeof entry.event.time === "number" && entry.event.time >= startedAt)).sort((a, b) => (a.event.seq ?? Number.MAX_SAFE_INTEGER) - (b.event.seq ?? Number.MAX_SAFE_INTEGER))[0];
		if (turnEnd === void 0) return { outcome: "pending" };
		return isErrorTurnEnd(turnEnd.event.data) ? {
			outcome: "failed",
			error: "agent turn ended with an error"
		} : { outcome: "succeeded" };
	}
};
//#endregion
export { HostExecutionRunner, SessionLaunchError };

//# sourceMappingURL=host-runner.js.map