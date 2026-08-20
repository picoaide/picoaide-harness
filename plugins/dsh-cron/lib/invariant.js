//#region src/invariant.ts
/**
* Package invariants for @picoaide/dsh-cron.
*
* The host scheduler is the only writer of the job ledger and the only
* trigger of scheduled executions; the browser is an asynchronous view over
* the same-origin API. Any code path that mutates ledger state must go
* through the serialized applyRequest seam so revision monotonicity and
* request idempotency hold.
*/
function assertCronInvariant(condition, message) {
	if (!condition) throw new Error(`[dsh-cron] invariant violation: ${message}`);
}
//#endregion
export { assertCronInvariant };

//# sourceMappingURL=invariant.js.map