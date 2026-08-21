import { attachSession, createTask, hasOpenExecution, setArchived, settleExecution, startExecution, updateTask, withStatus } from "./tasks.js";
import { t as buildTaskPrompt } from "./task-prompt-B98YMf_9.js";
import "./protocol.js";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
//#region ../../dsh-plugin-desktop/lib/desktop-home.js
/**
* Product home resolution for DSH Desktop.
*
* The product owns its data directory: the default Harness home under the
* OS home is `~/.picoaide-harness` instead of the upstream `~/.dsh`.
*
* The resolution contract mirrors the official `@deepseek-ai/dsh-home-paths`
* (packages/util/home-paths): precedence, highest first — an explicit
* configured path, `$DSH_HOME`, then the product default. An empty or
* whitespace-only `$DSH_HOME` is treated as unset. Every official package
* (settings-file, credentials-local, app-boot, …) resolves the home through
* that one shared package; this module is the product's equivalent single
* source of truth, and sibling plugins re-export it instead of copying the
* default-directory constant.
*
* The desktop launcher also writes the resolved home back into `DSH_HOME`
* at startup (main.ts), so every downstream consumer that reads the
* environment agrees on one location.
*/
/** Environment variable that overrides the product home. */
const DSH_HOME_ENV = "DSH_HOME";
/** Expand a leading ~ (or ~user) in a path, platform-style. */
function expandHomePath(path, home = homedir()) {
	if (path === "~") return home;
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
	return path;
}
/**
* Resolve the single-root product Harness home.
*
* Precedence, highest first: an explicit configured path, `$DSH_HOME`, then
* `~/.picoaide-harness`. The product keeps all user data under one root. An
* empty or whitespace-only `$DSH_HOME` is treated as unset.
* @param configured - explicit harness-home override, highest precedence.
* @param env - environment mapping used to read `DSH_HOME`.
* @param home - platform home directory fallback (test seam).
* @returns the normalized absolute product home path.
*/
function resolveDshHome(configured, env = process.env, home = homedir()) {
	const fromEnv = env[DSH_HOME_ENV];
	return resolve(expandHomePath(configured ?? (fromEnv !== void 0 && fromEnv.trim().length > 0 ? fromEnv : join(home, ".picoaide-harness")), home));
}
/** Resolve the product home from the live environment. */
function dshHome() {
	return resolveDshHome();
}
//#endregion
//#region src/host-ledger.ts
/**
* Host-authoritative task ledger. All mutations serialize through
* {@link HostTaskLedger.applyRequest}: full-document atomic persistence
* (temp + rename, 0600), monotonic revision, and request-id idempotency via
* a bounded SHA-256 fingerprint cache. Design ported from dsh-web-ui
* (Apache-2.0) packages/dsh-task-board src/host-ledger.ts.
*/
const MAX_REQUEST_CACHE = 256;
/** A lock file without a parseable owner pid is reclaimed once older than this. */
const STALE_LOCK_AGE_MS = 45e3;
/**
* P0-3: an execution left open long enough without any settlement (crash
* before the first turn completed, or a vanished session) is stale. On Host
* restart it is settled as cancelled so the task never pins 'doing' forever.
*/
const STALE_EXECUTION_MS = 360 * 60 * 1e3;
function cloneTasks(tasks) {
	return JSON.parse(JSON.stringify(tasks));
}
function fingerprintOf(requestId, action) {
	return createHash("sha256").update(JSON.stringify({
		requestId,
		action
	})).digest("hex");
}
var HostTaskLedger = class {
	current;
	cache = /* @__PURE__ */ new Map();
	listeners = /* @__PURE__ */ new Set();
	lockPath;
	filePath;
	lockFd;
	disposed = false;
	constructor(options = {}) {
		const dir = join(options.dshHomeDir ?? dshHome(), "task");
		mkdirSync(dir, {
			recursive: true,
			mode: 448
		});
		this.filePath = join(dir, "ledger.json");
		this.lockPath = join(dir, "ledger.lock");
		this.now = options.now ?? Date.now;
		this.acquireLock();
		this.current = this.load();
	}
	now;
	acquireLock() {
		for (let attempt = 0; attempt < 2; attempt += 1) try {
			const fd = openSync(this.lockPath, "wx", 384);
			this.lockFd = fd;
			writeFileSync(fd, `${process.pid}\n`);
			fsyncSync(fd);
			return;
		} catch (error) {
			if (error.code !== "EEXIST") throw new Error(`dsh-task: cannot acquire ledger lock: ${String(error)}`);
			if (attempt === 1) throw new Error("dsh-task: another Host process owns the task ledger (ledger.lock exists and its owner is alive)");
			if (this.reclaimStaleLock()) continue;
			throw new Error("dsh-task: another Host process owns the task ledger (ledger.lock exists and its owner is alive)");
		}
		throw new Error("dsh-task: cannot acquire ledger lock");
	}
	/** Reclaim a lock file whose recorded owner pid is no longer alive. */
	reclaimStaleLock() {
		try {
			const raw = readFileSync(this.lockPath, "utf8").trim();
			const pid = Number(raw);
			if (!Number.isInteger(pid) || pid <= 0) {
				const mtime = statSync(this.lockPath).mtimeMs;
				if (Date.now() - mtime > STALE_LOCK_AGE_MS) {
					unlinkSync(this.lockPath);
					return true;
				}
				return false;
			}
			try {
				process.kill(pid, 0);
				return false;
			} catch (error) {
				if (error.code === "EPERM") return false;
			}
			unlinkSync(this.lockPath);
			return true;
		} catch {
			return false;
		}
	}
	load() {
		let raw;
		try {
			raw = readFileSync(this.filePath, "utf8");
		} catch {
			return {
				revision: 0,
				tasks: []
			};
		}
		try {
			const parsed = JSON.parse(raw);
			if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.tasks)) throw new Error("unexpected schema");
			const state = {
				revision: parsed.revision,
				tasks: parsed.tasks
			};
			for (const entry of Array.isArray(parsed.recentRequests) ? parsed.recentRequests : []) if (typeof entry?.requestId === "string" && typeof entry?.fingerprint === "string") this.cache.set(entry.requestId, { fingerprint: entry.fingerprint });
			this.reconcileInterruptedStarts(state);
			return state;
		} catch {
			try {
				renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
			} catch {}
			return {
				revision: 0,
				tasks: []
			};
		}
	}
	persist() {
		const document = {
			schemaVersion: 1,
			revision: this.current.revision,
			tasks: this.current.tasks,
			recentRequests: [...this.cache.entries()].map(([requestId, entry]) => ({
				requestId,
				fingerprint: entry.fingerprint
			}))
		};
		const tmp = `${this.filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
		const fd = openSync(tmp, "w", 384);
		try {
			writeFileSync(fd, JSON.stringify(document));
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		chmodSync(tmp, 384);
		renameSync(tmp, this.filePath);
		while (this.cache.size > MAX_REQUEST_CACHE) {
			const oldest = this.cache.keys().next().value;
			if (oldest === void 0) break;
			this.cache.delete(oldest);
		}
	}
	state() {
		return {
			revision: this.current.revision,
			tasks: cloneTasks(this.current.tasks)
		};
	}
	/**
	* Reconcile executions left pending by a crashed Host: a start that was
	* interrupted before the session was recorded (no sessionId, no endedAt)
	* is settled as cancelled so the task is not pinned in 'doing' forever and
	* reruns are allowed again. Never re-fires the interrupted start.
	* P0-3: an execution WITH a sessionId whose session never produced a
	* turn/end (crash before the first turn completed) would otherwise stay
	* 'pending' forever and block every edit/delete/rerun (hasOpenExecution).
	* Age it out: anything older than STALE_EXECUTION_MS settles as cancelled.
	*/
	reconcileInterruptedStarts(state) {
		const now = this.now();
		state.tasks = state.tasks.map((task) => {
			const open = task.executions.filter((execution) => execution.endedAt === void 0);
			let next = task;
			for (const execution of open) if (execution.sessionId === void 0) next = settleExecution(next, execution.id, "cancelled", now, "host restarted before the execution session was recorded");
			else if (execution.startedAt > 0 && now - execution.startedAt > STALE_EXECUTION_MS) next = settleExecution(next, execution.id, "cancelled", now, "执行超时未完成（可能已损坏），已自动取消");
			return next;
		});
	}
	summary() {
		return { revision: this.current.revision };
	}
	subscribe(listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	emit() {
		for (const listener of [...this.listeners]) listener();
	}
	mutate(mutator) {
		if (!mutator(this.current)) return;
		this.current.revision += 1;
		this.persist();
		this.emit();
	}
	applyRequest(requestId, action) {
		const fingerprint = fingerprintOf(requestId, action);
		const cached = this.cache.get(requestId);
		if (cached !== void 0) {
			if (cached.fingerprint !== fingerprint) throw new Error(`dsh-task: request id was reused with a different action: ${requestId}`);
			return { state: this.state() };
		}
		this.cache.set(requestId, { fingerprint });
		let opened;
		let cancelled;
		this.mutate((state) => {
			switch (action.kind) {
				case "create":
					if (state.tasks.find((task) => task.id === action.id) !== void 0) return false;
					state.tasks.push(createTask(action.id, action.input, this.now()));
					return true;
				case "update": {
					const index = state.tasks.findIndex((task) => task.id === action.taskId);
					if (index < 0) return false;
					const task = state.tasks[index];
					if (hasOpenExecution(task) || task.archivedAt !== void 0) return false;
					state.tasks[index] = updateTask(task, action.patch, this.now());
					return true;
				}
				case "delete": {
					const index = state.tasks.findIndex((task) => task.id === action.taskId);
					if (index < 0) return false;
					const task = state.tasks[index];
					if (hasOpenExecution(task)) return false;
					state.tasks.splice(index, 1);
					return true;
				}
				case "move": {
					const index = state.tasks.findIndex((task) => task.id === action.taskId);
					if (index < 0) return false;
					const task = state.tasks[index];
					if (task.status === action.status) return false;
					if (hasOpenExecution(task) || task.archivedAt !== void 0) return false;
					state.tasks[index] = withStatus(task, action.status);
					return true;
				}
				case "archive": {
					const index = state.tasks.findIndex((task) => task.id === action.taskId);
					if (index < 0) return false;
					const task = state.tasks[index];
					if (hasOpenExecution(task)) return false;
					state.tasks[index] = setArchived(task, true, this.now());
					return true;
				}
				case "restore": {
					const index = state.tasks.findIndex((task) => task.id === action.taskId);
					if (index < 0) return false;
					state.tasks[index] = setArchived(state.tasks[index], false, this.now());
					return true;
				}
				case "run":
				case "rerun": {
					const index = state.tasks.findIndex((task) => task.id === action.taskId);
					if (index < 0) return false;
					const task = state.tasks[index];
					if (task.archivedAt !== void 0 || hasOpenExecution(task)) return false;
					const result = startExecution(task, `${action.kind}-${crypto.randomUUID()}`, this.now(), buildTaskPrompt(task));
					state.tasks[index] = result.task;
					opened = result;
					return true;
				}
				case "cancel": {
					const index = state.tasks.findIndex((task) => task.id === action.taskId);
					if (index < 0) return false;
					const task = state.tasks[index];
					const open = task.executions.filter((execution) => execution.endedAt === void 0);
					if (open.length === 0) return false;
					const now = this.now();
					let next = task;
					const cancelledSessions = [];
					for (const execution of open) {
						if (execution.sessionId !== void 0) cancelledSessions.push(execution.sessionId);
						next = settleExecution(next, execution.id, "cancelled", now, "用户取消了任务");
					}
					state.tasks[index] = next;
					cancelled = cancelledSessions;
					return true;
				}
				default: return false;
			}
		});
		return {
			state: this.state(),
			...opened === void 0 ? {} : { run: opened },
			...cancelled === void 0 || cancelled.length === 0 ? {} : { cancelled }
		};
	}
	/** Runner-owned: attach the created session id to an execution. */
	attachSession(taskId, executionId, sessionId) {
		this.mutate((state) => {
			const index = state.tasks.findIndex((task) => task.id === taskId);
			if (index < 0) return false;
			state.tasks[index] = attachSession(state.tasks[index], executionId, sessionId);
			return true;
		});
	}
	/** Runner-owned: settle an execution with a result (task status follows). */
	settle(taskId, executionId, result, error) {
		this.mutate((state) => {
			const index = state.tasks.findIndex((task) => task.id === taskId);
			if (index < 0) return false;
			const task = state.tasks[index];
			const next = settleExecution(task, executionId, result, this.now(), error);
			state.tasks[index] = next;
			return true;
		});
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		this.listeners.clear();
		if (this.lockFd !== void 0) {
			try {
				closeSync(this.lockFd);
				if (readFileSync(this.lockPath, "utf8").trim() === `${process.pid}`) unlinkSync(this.lockPath);
			} catch {}
			this.lockFd = void 0;
		}
	}
};
//#endregion
export { HostTaskLedger as t };

//# sourceMappingURL=host-ledger-DTX-3KpF.js.map