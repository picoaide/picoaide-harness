//#region src/task-prompt.ts
/** Build the model-facing task context block (stable, deterministic prose). */
function buildTaskPrompt(task) {
	const lines = [];
	lines.push(`【任务看板执行】任务：${task.title}`);
	if (task.description !== "") lines.push(`任务描述：${task.description}`);
	if (task.workspaceId !== void 0) lines.push(`项目（工作区）：${task.workspaceId}`);
	if (task.permission !== void 0) lines.push(`权限预设：${task.permission}`);
	lines.push(`创建时间：${new Date(task.createdAt).toLocaleString()}`);
	const action = task.prompt !== "" ? task.prompt : task.title;
	lines.push("");
	lines.push(`请完成以下任务：${action}`);
	return lines.join("\n");
}
//#endregion
export { buildTaskPrompt as t };

//# sourceMappingURL=task-prompt-B98YMf_9.js.map