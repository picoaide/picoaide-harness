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
*/
function isExecutionResult(value) {
	return value === "succeeded" || value === "failed" || value === "cancelled";
}
function isCronJobAction(value) {
	if (typeof value !== "object" || value === null) return false;
	const action = value;
	const keys = Object.keys(action);
	if (action.kind === "task") {
		if (keys.length !== 2 || !keys.includes("kind") || !keys.includes("taskId")) return false;
		return typeof action.taskId === "string" && action.taskId !== "";
	}
	if (action.kind === "prompt") {
		if (keys.length !== 3 || !keys.includes("kind") || !keys.includes("sessionId") || !keys.includes("text")) return false;
		return typeof action.sessionId === "string" && action.sessionId !== "" && typeof action.text === "string" && action.text !== "";
	}
	return false;
}
/** Create an execution record for a pending trigger. */
function startExecution(id, now) {
	return {
		id,
		triggeredAt: now
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
function createJob(id, input, now) {
	return {
		id,
		name: input.name,
		cron: input.cron,
		action: input.action,
		enabled: input.enabled ?? false,
		executions: [],
		createdAt: now,
		updatedAt: now
	};
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
export { createJob, isCronJobAction, isExecutionResult, rollNextRun, settleExecution, startExecution, updateJob };

//# sourceMappingURL=jobs.js.map