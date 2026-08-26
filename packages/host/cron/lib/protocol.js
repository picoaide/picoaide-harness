import { isValidCron, nextRunAtMs } from "./cron.js";
import { isCronJobAction } from "./jobs.js";
//#region src/protocol.ts
/**
* Same-origin action protocol for the cron job ledger.
*
* Every browser mutation is a versioned, strictly validated discriminated
* union. The Host re-validates each payload field (exact keys, types,
* enumerations) before touching the ledger; there are no command, shell, or
* executable fields anywhere in the union. The browser never writes
* scheduler-owned timestamps or execution results.
*/
const CRON_SCHEMA_VERSION = 2;
const CRON_API_PREFIX = "/api/cron";
function record(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function exactKeys(value, allowed) {
	return Object.keys(value).every((key) => allowed.includes(key));
}
function optionalBoolean(value) {
	return value === void 0 || typeof value === "boolean";
}
/**
* Host-side cron validation: the expression must parse AND have a reachable
* next instant within the five-year horizon (a calendar-impossible schedule
* such as `0 0 30 2 *` would otherwise produce a silently inert job).
*/
function validCron(value) {
	if (typeof value !== "string" || value === "") return false;
	if (!isValidCron(value)) return false;
	return nextRunAtMs(value, Date.now()) !== void 0;
}
function validInput(value) {
	const input = record(value);
	if (input === void 0 || !exactKeys(input, [
		"name",
		"cron",
		"action",
		"enabled"
	])) return false;
	if (typeof input.name !== "string" || input.name === "") return false;
	if (!validCron(input.cron)) return false;
	if (!optionalBoolean(input.enabled)) return false;
	return isCronJobAction(input.action);
}
function validPatch(value) {
	const patch = record(value);
	if (patch === void 0 || !exactKeys(patch, [
		"name",
		"cron",
		"enabled"
	])) return false;
	if (patch.name !== void 0 && (typeof patch.name !== "string" || patch.name === "")) return false;
	if (patch.cron !== void 0 && !validCron(patch.cron)) return false;
	return optionalBoolean(patch.enabled);
}
function parseActionEnvelope(value) {
	const envelope = record(value);
	if (envelope === void 0 || !exactKeys(envelope, ["requestId", "action"])) return void 0;
	if (typeof envelope.requestId !== "string" || envelope.requestId.trim() === "" || envelope.requestId.length > 256) return void 0;
	const action = record(envelope.action);
	if (action === void 0 || typeof action.kind !== "string") return void 0;
	const jobId = typeof action.jobId === "string" && action.jobId !== "" ? action.jobId : void 0;
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
				"jobId",
				"patch"
			])) return void 0;
			return jobId !== void 0 && validPatch(action.patch) ? {
				requestId: envelope.requestId,
				action
			} : void 0;
		case "delete":
		case "enable":
		case "disable":
		case "run":
		case "rerun":
			if (!exactKeys(action, ["kind", "jobId"])) return void 0;
			return jobId === void 0 ? void 0 : {
				requestId: envelope.requestId,
				action
			};
		default: return;
	}
}
//#endregion
export { CRON_API_PREFIX, CRON_SCHEMA_VERSION, parseActionEnvelope };

//# sourceMappingURL=protocol.js.map