//#region src/invariant.ts
/**
* Package invariants for @picoaide/dsh-task.
*
* The Host ledger is the only writer of task state and the only owner of
* execution settlement; the browser submits actions and projects snapshots.
* The task Prompt is data sent to an agent session — never a shell line —
* and the action protocol contains no command/executable/shell fields.
*/
function assertTaskInvariant(condition, message) {
	if (!condition) throw new Error(`[dsh-task] invariant violation: ${message}`);
}
//#endregion
export { assertTaskInvariant };

//# sourceMappingURL=invariant.js.map