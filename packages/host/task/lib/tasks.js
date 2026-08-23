//#region src/tasks.ts
/** The permission presets a task may pin (upstream dsh-task-board whitelist). */
const TASK_PERMISSIONS = [
	"read-only",
	"workspace-write",
	"danger-full-access"
];
function isTaskPermission(value) {
	return typeof value === "string" && TASK_PERMISSIONS.includes(value);
}
/** The five board columns. */
const COLUMNS = [
	{
		status: "todo",
		labelKey: "board.column.todo"
	},
	{
		status: "doing",
		labelKey: "board.column.doing"
	},
	{
		status: "done",
		labelKey: "board.column.done"
	},
	{
		status: "failed",
		labelKey: "board.column.failed"
	}
];
function isTaskStatus(value) {
	return value === "todo" || value === "doing" || value === "done" || value === "failed";
}
/** Which statuses may a task move to manually? */
function canMoveManually(from, to) {
	return from !== to;
}
/** When an execution starts, the task moves to 'doing'. */
function withStatus(task, status) {
	return {
		...task,
		status,
		updatedAt: Date.now()
	};
}
/** Whether a task is archived. */
function isArchived(task) {
	return task.archivedAt !== void 0;
}
/** Create a new task record. */
function createTask(id, input, now, owner) {
	return {
		id,
		title: input.title,
		description: input.description,
		prompt: input.prompt,
		status: "todo",
		executions: [],
		createdAt: now,
		updatedAt: now,
		...owner === void 0 || owner.length === 0 ? {} : { owner },
		...input.workspaceId === void 0 ? {} : { workspaceId: input.workspaceId },
		...input.mode === void 0 ? {} : { mode: input.mode },
		...input.permission === void 0 ? {} : { permission: input.permission }
	};
}
/** Whether a task is visible to (and executable by) the given account. */
function taskVisibleTo(task, username) {
	if (task.owner === void 0) return true;
	return username !== void 0 && username !== null && username.length > 0 && task.owner === username;
}
/** Apply a validated patch (immutable update). */
function updateTask(task, patch, now) {
	return {
		...task,
		...patch.title === void 0 ? {} : { title: patch.title },
		...patch.description === void 0 ? {} : { description: patch.description },
		...patch.prompt === void 0 ? {} : { prompt: patch.prompt },
		...patch.workspaceId === void 0 ? {} : { workspaceId: patch.workspaceId },
		...patch.mode === void 0 ? {} : { mode: patch.mode },
		...patch.permission === void 0 ? {} : { permission: patch.permission },
		updatedAt: now
	};
}
/** Open a run: append a pending execution and flip the task to 'doing'. */
function startExecution(task, executionId, now, prompt) {
	const execution = {
		id: executionId,
		startedAt: now,
		...prompt === void 0 || prompt === "" ? {} : { prompt }
	};
	return {
		task: {
			...task,
			status: "doing",
			executions: [...task.executions, execution],
			updatedAt: now
		},
		execution
	};
}
/** Settle a pending execution (task-board semantics; result can be failed). */
function settleExecution(task, executionId, result, now, error) {
	const target = task.executions.find((execution) => execution.id === executionId);
	if (target === void 0 || target.endedAt !== void 0) return task;
	return {
		...task,
		executions: task.executions.map((execution) => execution.id === executionId ? {
			...execution,
			endedAt: now,
			result,
			...error === void 0 ? {} : { error }
		} : execution),
		...result === "succeeded" ? { status: "done" } : {},
		...result === "failed" ? { status: "failed" } : {},
		...result === "cancelled" && task.status === "doing" ? { status: "todo" } : {},
		updatedAt: now
	};
}
/** Attach the created session id to a pending execution. */
function attachSession(task, executionId, sessionId) {
	return {
		...task,
		executions: task.executions.map((execution) => execution.id === executionId ? {
			...execution,
			sessionId
		} : execution),
		updatedAt: Date.now()
	};
}
/** Archive (or restore) a task. */
function setArchived(task, archived, now) {
	return {
		...task,
		...archived ? { archivedAt: now } : {},
		...!archived ? { archivedAt: void 0 } : {},
		updatedAt: now
	};
}
/** Whether the task has an execution still in flight. */
function hasOpenExecution(task) {
	return task.executions.some((execution) => execution.endedAt === void 0);
}
//#endregion
export { COLUMNS, TASK_PERMISSIONS, attachSession, canMoveManually, createTask, hasOpenExecution, isArchived, isTaskPermission, isTaskStatus, setArchived, settleExecution, startExecution, taskVisibleTo, updateTask, withStatus };

//# sourceMappingURL=tasks.js.map