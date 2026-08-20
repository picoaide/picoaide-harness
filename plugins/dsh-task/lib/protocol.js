import { isTaskPermission, isTaskStatus } from "./tasks.js";
//#region src/protocol.ts
/**
* Same-origin action protocol for the task ledger. Every browser mutation is
* a versioned, strictly validated discriminated union; the Host re-validates
* each payload (exact keys, types, enumerations) before touching the ledger.
* The union contains no command, executable, or shell fields — the task
* Prompt is data sent to an agent session, never a shell line.
*/
const TASK_SCHEMA_VERSION = 1;
const TASK_API_PREFIX = "/api/task";
function record(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function exactKeys(value, allowed) {
	return Object.keys(value).every((key) => allowed.includes(key));
}
function optionalString(value) {
	return value === void 0 || typeof value === "string";
}
function validInput(value) {
	const input = record(value);
	if (input === void 0 || !exactKeys(input, [
		"title",
		"description",
		"prompt",
		"workspaceId",
		"mode",
		"permission"
	])) return false;
	if (typeof input.title !== "string" || input.title === "") return false;
	if (typeof input.description !== "string" || typeof input.prompt !== "string") return false;
	if (!optionalString(input.workspaceId) || !optionalString(input.mode)) return false;
	return input.permission === void 0 || isTaskPermission(input.permission);
}
function validPatch(value) {
	const patch = record(value);
	if (patch === void 0 || !exactKeys(patch, [
		"title",
		"description",
		"prompt",
		"workspaceId",
		"mode",
		"permission"
	])) return false;
	for (const key of [
		"title",
		"description",
		"prompt",
		"workspaceId",
		"mode"
	]) if (!optionalString(patch[key])) return false;
	return patch.permission === void 0 || isTaskPermission(patch.permission);
}
function parseActionEnvelope(value) {
	const envelope = record(value);
	if (envelope === void 0 || !exactKeys(envelope, ["requestId", "action"])) return void 0;
	if (typeof envelope.requestId !== "string" || envelope.requestId.trim() === "" || envelope.requestId.length > 256) return void 0;
	const action = record(envelope.action);
	if (action === void 0 || typeof action.kind !== "string") return void 0;
	const taskId = typeof action.taskId === "string" && action.taskId !== "" ? action.taskId : void 0;
	switch (action.kind) {
		case "create":
			if (!exactKeys(action, [
				"kind",
				"id",
				"input"
			])) return void 0;
			return typeof action.id === "string" && action.id !== "" && validInput(action.input) ? {
				requestId: envelope.requestId,
				action
			} : void 0;
		case "update":
			if (!exactKeys(action, [
				"kind",
				"taskId",
				"patch"
			])) return void 0;
			return taskId !== void 0 && validPatch(action.patch) ? {
				requestId: envelope.requestId,
				action
			} : void 0;
		case "move":
			if (!exactKeys(action, [
				"kind",
				"taskId",
				"status"
			])) return void 0;
			return taskId !== void 0 && isTaskStatus(action.status) ? {
				requestId: envelope.requestId,
				action
			} : void 0;
		case "delete":
		case "archive":
		case "restore":
		case "run":
		case "rerun":
			if (!exactKeys(action, ["kind", "taskId"])) return void 0;
			return taskId === void 0 ? void 0 : {
				requestId: envelope.requestId,
				action
			};
		default: return;
	}
}
//#endregion
export { TASK_API_PREFIX, TASK_SCHEMA_VERSION, parseActionEnvelope };

//# sourceMappingURL=protocol.js.map