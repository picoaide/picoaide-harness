import { t as HostTaskLedger } from "./host-ledger-DTX-3KpF.js";
import { HostExecutionRunner, SessionLaunchError } from "./host-runner.js";
//#region src/host-service.ts
const SESSION_POLL_MS = 5e3;
var HostTaskService = class {
	ledger;
	runner;
	listeners = /* @__PURE__ */ new Set();
	pollMs;
	timer;
	pollInFlight = false;
	active = true;
	disposed = false;
	constructor(api, options = {}) {
		this.ledger = options.ledger ?? new HostTaskLedger();
		this.runner = options.runner ?? new HostExecutionRunner(api);
		this.pollMs = options.pollMs ?? SESSION_POLL_MS;
		this.ledger.subscribe(() => this.emit());
	}
	start() {
		if (this.disposed || this.timer !== void 0) return;
		this.timer = setInterval(() => {
			this.schedulePoll();
		}, this.pollMs);
		this.schedulePoll();
	}
	setActive(active) {
		const resumed = !this.active && active;
		this.active = active;
		if (resumed) this.start();
		if (!active && this.timer !== void 0) {
			clearInterval(this.timer);
			this.timer = void 0;
		}
		this.emit();
	}
	snapshot() {
		const state = this.ledger.state();
		return {
			schemaVersion: 1,
			revision: state.revision,
			tasks: state.tasks
		};
	}
	getSnapshot() {
		return this.snapshot();
	}
	getTask(taskId) {
		return this.ledger.state().tasks.find((task) => task.id === taskId);
	}
	subscribe(listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	apply(requestId, action) {
		if (!this.active) throw new Error("task board is disabled");
		const result = this.ledger.applyRequest(requestId, action);
		if (result.run !== void 0) this.scheduleLaunch(result.run.task, result.run.execution.id);
		if (result.cancelled !== void 0) for (const sessionId of result.cancelled) this.runner.cancelSession(sessionId).catch(() => {});
		return this.snapshot();
	}
	async runTask(taskId) {
		if (!this.active) return {
			ok: false,
			error: "task board is disabled"
		};
		const task = this.getTask(taskId);
		if (task === void 0) return {
			ok: false,
			error: `task not found: ${taskId}`
		};
		if (task.archivedAt !== void 0) return {
			ok: false,
			error: "task is archived"
		};
		const result = this.ledger.applyRequest(`internal-run-${crypto.randomUUID()}`, {
			kind: "run",
			taskId
		});
		if (result.run === void 0) return {
			ok: false,
			error: "task already running"
		};
		this.scheduleLaunch(result.run.task, result.run.execution.id);
		return { ok: true };
	}
	async launch(task, executionId) {
		try {
			const sessionId = await this.runner.launch(task);
			this.ledger.attachSession(task.id, executionId, sessionId);
		} catch (error) {
			if (error instanceof SessionLaunchError) this.ledger.attachSession(task.id, executionId, error.sessionId);
			this.ledger.settle(task.id, executionId, "failed", error instanceof Error ? error.message : String(error));
		}
	}
	scheduleLaunch(task, executionId) {
		this.launch(task, executionId).catch((error) => {
			console.error("[dsh-task] execution launch settlement failed", error);
		});
	}
	async pollSessions() {
		if (this.disposed) return;
		if (!this.active && !this.hasOpenExecutions()) return;
		const running = await this.runner.listRunning();
		if (running.known) await this.reconcileExecutions(running.items);
	}
	async reconcileExecutions(sessions) {
		for (const task of this.ledger.state().tasks) for (const execution of task.executions) {
			if (execution.sessionId === void 0 || execution.endedAt !== void 0) continue;
			try {
				const result = await this.runner.inspect(execution.sessionId, execution.startedAt, sessions);
				if (result.outcome === "pending") continue;
				this.ledger.settle(task.id, execution.id, result.outcome, "error" in result ? result.error : void 0);
			} catch {}
		}
	}
	hasOpenExecutions() {
		return this.ledger.state().tasks.some((task) => task.executions.some((execution) => execution.endedAt === void 0));
	}
	schedulePoll() {
		if (this.pollInFlight || this.disposed) return;
		this.pollInFlight = true;
		this.pollSessions().catch((error) => {
			console.error("[dsh-task] session polling failed", error);
		}).finally(() => {
			this.pollInFlight = false;
		});
	}
	emit() {
		for (const listener of [...this.listeners]) listener();
	}
	dispose() {
		this.disposed = true;
		if (this.timer !== void 0) {
			clearInterval(this.timer);
			this.timer = void 0;
		}
		this.ledger.dispose();
		this.listeners.clear();
	}
};
//#endregion
export { HostTaskService };

//# sourceMappingURL=host-service.js.map