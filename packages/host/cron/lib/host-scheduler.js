import { nextRunAtMs } from "./cron.js";
//#region src/host-scheduler.ts
/**
* Host cron scheduler: a fixed-interval tick that fires due jobs exactly
* once, rolls their next-run instants forward, and never re-runs a missed
* trigger (unless the composition opts into catch-up for the last missed
* occurrence). Runs entirely in the Host process, so scheduled jobs execute
* while every browser page (or the desktop window) is closed.
*
* Recovery semantics: on first tick or after a long gap (suspend/restart),
* due instants are skipped and rolled forward — never queued for replay.
* With `catchUpMissed` enabled, the single most recent missed occurrence is
* fired instead of skipped.
*/
const DEFAULT_TICK_MS = 3e4;
const RESUME_GAP_MS = 45e3;
var HostCronScheduler = class {
	ledger;
	executor;
	tickMs;
	now;
	/** Live toggle: true fires the most recent missed occurrence after a gap. */
	catchUpMissed;
	timer;
	lastTickAt;
	tickInFlight = false;
	disposed = false;
	constructor(ledger, executor, options = {}) {
		this.ledger = ledger;
		this.executor = executor;
		this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
		this.now = options.now ?? Date.now;
		this.catchUpMissed = options.catchUpMissed ?? false;
	}
	start() {
		if (this.disposed || this.timer !== void 0) return;
		this.timer = setInterval(() => {
			this.tick(false);
		}, this.tickMs);
		this.tick(true);
	}
	/**
	* Stop ticking without disposing: a later `start()` resumes (used by
	* setConfiguration toggling). In-flight executions are left to settle.
	*/
	stop() {
		if (this.timer !== void 0) {
			clearInterval(this.timer);
			this.timer = void 0;
		}
	}
	async tick(first) {
		if (this.disposed || this.tickInFlight) return;
		this.tickInFlight = true;
		try {
			const now = this.now();
			const recovered = first || this.lastTickAt !== void 0 && now - this.lastTickAt > RESUME_GAP_MS;
			this.lastTickAt = now;
			this.ledger.setScheduler({
				lastTickAt: now,
				error: void 0
			});
			if (recovered) {
				if (this.catchUpMissed && this.lastTickAt !== void 0) this.catchUp(now);
				else this.ledger.skipMissed(now);
				return;
			}
			for (const job of this.ledger.state().jobs) {
				if (!job.enabled || job.nextRunAt === void 0 || job.nextRunAt > now) continue;
				const opened = this.ledger.openScheduled(job.id, `sched-${crypto.randomUUID()}`, now);
				if (opened !== void 0) this.fire(opened.job, opened.execution);
			}
		} catch (error) {
			console.error("[dsh-cron] scheduler tick failed", error);
			try {
				this.ledger.setScheduler({ error: error instanceof Error ? error.message : String(error) });
			} catch {}
		} finally {
			this.tickInFlight = false;
		}
	}
	/**
	* Catch-up path: for each due job, fire the single most recent matching
	* instant inside the missed window, then roll forward. Bounded: the window
	* scan walks at most 100 matches.
	*/
	catchUp(now) {
		const lastTick = this.lastTickAt ?? now;
		for (const job of this.ledger.state().jobs) {
			if (!job.enabled || job.nextRunAt === void 0 || job.nextRunAt > now) continue;
			const lastMatch = this.lastMatchAt(job, lastTick, now);
			if (lastMatch === void 0) continue;
			const opened = this.ledger.openScheduled(job.id, `catchup-${crypto.randomUUID()}`, lastMatch);
			if (opened !== void 0) this.fire(opened.job, opened.execution);
			this.ledger.skipMissedFor(job.id, now);
		}
	}
	lastMatchAt(job, windowStart, now) {
		let cursor = job.nextRunAt ?? windowStart;
		let last;
		for (let guard = 0; guard < 100; guard += 1) {
			if (cursor > now) break;
			last = cursor;
			const next = nextRunAtMs(job.cron, cursor);
			if (next === void 0) break;
			cursor = next;
		}
		return last;
	}
	/**
	* Execute one job action and settle its execution record (also used for
	* manual run/rerun actions). Resolves when the execution is settled; a
	* settlement failure is contained (never rejects into the tick loop).
	*/
	fire(job, execution) {
		return this.executor.execute(job, execution).then(({ result, error }) => {
			this.ledger.settle(job.id, execution.id, result, error);
		}).catch((error) => {
			try {
				this.ledger.settle(job.id, execution.id, "failed", error instanceof Error ? error.message : String(error));
			} catch (settleError) {
				console.error("[dsh-cron] execution settlement failed", settleError);
			}
		});
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.stop();
	}
};
//#endregion
export { HostCronScheduler };

//# sourceMappingURL=host-scheduler.js.map