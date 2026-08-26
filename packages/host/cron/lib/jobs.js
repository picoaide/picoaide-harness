import { nextRunAtMs } from "./cron.js";
//#region src/jobs.ts
/**
* Cron job domain model: the durable record shape, the action discriminated
* union, and the pure state transitions. Shared by the Host ledger, the
* scheduler, the executor, and the browser view.
*
* A job is an independent scheduled unit. The scheduler owns the "when"
* (cron + next-run roll-forward), the executor owns the "what" (the action).
* Actions are a closed discriminated union with no command, executable, or
* shell fields: the prompt text is data sent to an agent session, never a
* shell line.
*
* v2: only one action kind remains — `agent` (spawn a fresh agent session
* for a task prompt, optionally pinned to a workspace / agent preset /
* permission). The legacy `task` (dsh-task board reference) and `prompt`
* (send a message to an existing session) kinds were removed when the task
* board was merged into the scheduler.
*/
function isExecutionResult(value) {
	return value === "succeeded" || value === "failed" || value === "cancelled";
}
function isCronJobAction(value) {
	if (typeof value !== "object" || value === null) return false;
	const action = value;
	if (action.kind !== "agent") return false;
	const allowed = /* @__PURE__ */ new Set([
		"kind",
		"prompt",
		"workspaceId",
		"agentPreset",
		"permission"
	]);
	if (!Object.keys(action).every((key) => allowed.has(key))) return false;
	if (typeof action.prompt !== "string" || action.prompt.trim() === "") return false;
	if (action.workspaceId !== void 0 && typeof action.workspaceId !== "string") return false;
	if (action.agentPreset !== void 0 && typeof action.agentPreset !== "string") return false;
	if (action.permission !== void 0 && typeof action.permission !== "string") return false;
	return true;
}
/** Create an execution record for a pending trigger. */
function startExecution(id, now) {
	return {
		id,
		triggeredAt: now,
		startedAt: now
	};
}
/** Settle a pending execution with a result and optional error. */
function settleExecution(execution, result, now, error) {
	return {
		...execution,
		endedAt: now,
		...result === void 0 ? {} : { result },
		...error === void 0 ? {} : { error }
	};
}
/** Build a new job record from validated input. */
function createJob(id, input, now, owner) {
	return {
		id,
		name: input.name,
		cron: input.cron,
		action: input.action,
		enabled: input.enabled ?? false,
		...owner === void 0 || owner.length === 0 ? {} : { owner },
		executions: [],
		createdAt: now,
		updatedAt: now
	};
}
/** Whether a job is visible to (and executable by) the given account. */
function jobVisibleTo(job, username) {
	if (job.owner === void 0) return true;
	return username !== void 0 && username !== null && username.length > 0 && job.owner === username;
}
/** Apply a validated patch to an existing job record (immutable update). */
function updateJob(job, patch, now) {
	return {
		...job,
		...patch.name === void 0 ? {} : { name: patch.name },
		...patch.cron === void 0 ? {} : { cron: patch.cron },
		...patch.enabled === void 0 ? {} : { enabled: patch.enabled },
		updatedAt: now
	};
}
/**
* Roll the job's next-run instant strictly past `fromMs`. When the job has
* no nextRunAt yet (freshly created or just re-enabled), seed it from
* `fromMs`.
*/
function rollNextRun(job, fromMs) {
	const base = job.nextRunAt === void 0 ? fromMs : Math.max(job.nextRunAt, fromMs);
	return nextRunAtMs(job.cron, base);
}
//#endregion
export { createJob, isCronJobAction, isExecutionResult, jobVisibleTo, rollNextRun, settleExecution, startExecution, updateJob };

//# sourceMappingURL=jobs.js.map