import { isValidCron } from "./cron.js";
import { createJob, jobVisibleTo, rollNextRun, settleExecution, startExecution, updateJob } from "./jobs.js";
import "./protocol.js";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
//#region ../desktop/lib/desktop-home.js
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
*
* 审计 2026-08-25 P2-3:DSH_HOME 是完全可注入的环境变量(同机进程可设置后
* 以同一用户拉起应用)。虽保留其覆盖能力(e2e/多 profile 依赖),但拒绝把
* home 重定向到系统关键目录,避免「安全解压/凭据落盘」作用到 /tmp 等
* 攻击者控制的路径。
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
* Host-authoritative cron job ledger.
*
* All mutations serialize through {@link HostCronLedger.applyRequest}, which
* persists the full document (temp file + atomic rename, 0600 on POSIX),
* bumps the revision monotonically, and dedupes repeated requestIds via a
* bounded SHA-256 fingerprint cache so Host-restart retries stay idempotent.
*
* Design ported from dsh-web-ui (Apache-2.0) packages/dsh-task-board
* src/host-ledger.ts, adapted to the cron job domain.
*/
const MAX_REQUEST_CACHE = 256;
/** 保留的执行历史条数上限(审计 2026-08-25 P2-5):executions 曾只增不减,
* 高频 job 的 ledger.json 无限膨胀且每次 mutate 全量重写。 */
const MAX_EXECUTION_HISTORY = 100;
/** A lock file without a parseable owner pid is reclaimed once older than this. */
const STALE_LOCK_AGE_MS = 45e3;
function timeZone() {
	return Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
}
/** A job record with the nextRunAt optional field stripped (exactOptionalPropertyTypes). */
function withoutNextRun(job) {
	const { nextRunAt: _drop, ...rest } = job;
	return rest;
}
/** Conditionally-shaped nextRunAt seed for object literals. */
function seededNextRun(job, now) {
	const next = rollNextRun(job, now);
	return next === void 0 ? {} : { nextRunAt: next };
}
function cloneJobs(jobs) {
	return JSON.parse(JSON.stringify(jobs));
}
function hasOpenExecution(job) {
	return job.executions.some((execution) => execution.endedAt === void 0);
}
function fingerprintOf(requestId, action) {
	return createHash("sha256").update(JSON.stringify({
		requestId,
		action
	})).digest("hex");
}
/**
* Open a scheduled run: record a pending execution, roll nextRunAt forward,
* and remember the trigger time. Returns the opened run, or undefined when
* the job is disabled/archived/already running or the schedule cannot match.
*/
function openScheduledRun(job, executionId, now) {
	if (!job.enabled) return void 0;
	if (hasOpenExecution(job)) return void 0;
	const execution = startExecution(executionId, now);
	const nextRunAt = rollNextRun(job, now);
	return {
		job: {
			...job,
			executions: [...job.executions, execution],
			lastTriggeredAt: now,
			...nextRunAt === void 0 ? {} : { nextRunAt }
		},
		execution
	};
}
/**
* Host-owned ledger with serialized, idempotent, atomically persisted
* mutations. One instance per Host process; a file lock guards against a
* second Host process writing the same DSH home.
*/
var HostCronLedger = class {
	current;
	cache = /* @__PURE__ */ new Map();
	listeners = /* @__PURE__ */ new Set();
	lockPath;
	filePath;
	lockFd;
	disposed = false;
	/** Current account (gateway username); null when logged out. */
	owner;
	constructor(options = {}) {
		const dir = join(options.dshHomeDir ?? dshHome(), "cron");
		mkdirSync(dir, {
			recursive: true,
			mode: 448
		});
		this.filePath = join(dir, "ledger.json");
		this.lockPath = join(dir, "ledger.lock");
		this.now = options.now ?? Date.now;
		this.owner = options.owner ?? (() => null);
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
			if (error.code !== "EEXIST") throw new Error(`dsh-cron: cannot acquire ledger lock: ${String(error)}`);
			if (attempt === 1) throw new Error("dsh-cron: another Host process owns the cron ledger (ledger.lock exists and its owner is alive)");
			if (this.reclaimStaleLock()) continue;
			throw new Error("dsh-cron: another Host process owns the cron ledger (ledger.lock exists and its owner is alive)");
		}
		throw new Error("dsh-cron: cannot acquire ledger lock");
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
				jobs: [],
				scheduler: {
					timeZone: timeZone(),
					ledgerId: crypto.randomUUID()
				}
			};
		}
		try {
			const parsed = JSON.parse(raw);
			if (typeof parsed.schemaVersion !== "number" || !Array.isArray(parsed.jobs)) throw new Error("unexpected schema");
			let jobs = parsed.jobs;
			if (parsed.schemaVersion < 1) jobs = migrateCronLedger(jobs, parsed.schemaVersion);
			else if (parsed.schemaVersion > 1) throw new Error(`ledger schema v${String(parsed.schemaVersion)} is newer than supported v1`);
			const state = {
				revision: parsed.revision,
				jobs,
				scheduler: {
					timeZone: parsed.scheduler?.timeZone ?? timeZone(),
					...parsed.scheduler?.ledgerId === void 0 ? {} : { ledgerId: parsed.scheduler.ledgerId },
					...parsed.scheduler?.lastTickAt === void 0 ? {} : { lastTickAt: parsed.scheduler.lastTickAt },
					...parsed.scheduler?.error === void 0 ? {} : { error: parsed.scheduler.error }
				}
			};
			for (const entry of Array.isArray(parsed.recentRequests) ? parsed.recentRequests : []) if (typeof entry?.requestId === "string" && typeof entry?.fingerprint === "string") this.cache.set(entry.requestId, { fingerprint: entry.fingerprint });
			this.reconcileInterruptedStarts(state, this.now());
			return state;
		} catch (error) {
			try {
				renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
			} catch {}
			return {
				revision: 0,
				jobs: [],
				scheduler: {
					timeZone: timeZone(),
					ledgerId: crypto.randomUUID(),
					error: "ledger was corrupt or too new and reset"
				}
			};
		}
	}
	persist() {
		const document = {
			schemaVersion: 1,
			revision: this.current.revision,
			jobs: this.current.jobs,
			scheduler: this.current.scheduler,
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
		this.pruneCache();
	}
	pruneCache() {
		while (this.cache.size > MAX_REQUEST_CACHE) {
			const oldest = this.cache.keys().next().value;
			if (oldest === void 0) break;
			this.cache.delete(oldest);
		}
	}
	state() {
		return {
			revision: this.current.revision,
			jobs: cloneJobs(this.current.jobs),
			scheduler: { ...this.current.scheduler }
		};
	}
	/**
	* Reconcile executions left pending by a crashed Host: a pending execution
	* has no in-flight session evidence (the ledger cannot observe sessions),
	* so it is settled as cancelled and its job's nextRunAt is rolled forward
	* past `now` so the job can trigger again. Never re-fires a start that was
	* interrupted before the session was recorded.
	*/
	reconcileInterruptedStarts(state, now) {
		for (const job of state.jobs) {
			const pending = job.executions.find((execution) => execution.endedAt === void 0);
			if (pending === void 0) continue;
			const settled = settleExecution(pending, "cancelled", now, "host restarted before the execution settled");
			job.executions = job.executions.map((execution) => execution.id === pending.id ? settled : execution);
			if (job.nextRunAt !== void 0 && job.nextRunAt <= now) {
				const nextRunAt = rollNextRun(job, now);
				if (nextRunAt === void 0) delete job.nextRunAt;
				else job.nextRunAt = nextRunAt;
			}
		}
	}
	/** Lightweight summary for SSE frames (no deep clone of the job list). */
	summary() {
		return {
			revision: this.current.revision,
			scheduler: { ...this.current.scheduler }
		};
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
	/**
	* Apply one browser/UI action with idempotency. Returns the new snapshot
	* and, when a run was opened, the run to launch.
	*/
	applyRequest(requestId, action) {
		const fingerprint = fingerprintOf(requestId, action);
		const cached = this.cache.get(requestId);
		if (cached !== void 0) {
			if (cached.fingerprint !== fingerprint) throw new Error(`dsh-cron: request id was reused with a different action: ${requestId}`);
			return { state: this.state() };
		}
		this.cache.set(requestId, { fingerprint });
		const targetAction = action.kind === "update" || action.kind === "delete" || action.kind === "enable" || action.kind === "disable" || action.kind === "run" || action.kind === "rerun" ? action : void 0;
		if (targetAction !== void 0) {
			const target = this.current.jobs.find((job) => job.id === targetAction.jobId);
			if (target !== void 0 && !jobVisibleTo(target, this.owner())) throw new Error(`dsh-cron: job ${targetAction.jobId} belongs to another account`);
		}
		let opened;
		let rerun;
		this.mutate((state) => {
			switch (action.kind) {
				case "create": {
					if (state.jobs.find((job) => job.id === action.id) !== void 0) return false;
					const job = createJob(action.id, action.input, this.now(), this.owner() ?? void 0);
					if (job.enabled) {
						const seeded = rollNextRun(job, this.now());
						if (seeded !== void 0) job.nextRunAt = seeded;
					}
					state.jobs.push(job);
					return true;
				}
				case "update": {
					const index = state.jobs.findIndex((job) => job.id === action.jobId);
					if (index < 0) return false;
					const job = state.jobs[index];
					const next = updateJob(job, action.patch, this.now());
					if (action.patch.cron !== void 0 && action.patch.cron !== job.cron) {
						const seeded = rollNextRun(withoutNextRun(next), this.now());
						if (seeded !== void 0) next.nextRunAt = seeded;
					} else if (action.patch.enabled === true && job.nextRunAt === void 0) {
						const seeded = rollNextRun(withoutNextRun(next), this.now());
						if (seeded !== void 0) next.nextRunAt = seeded;
					}
					state.jobs[index] = next;
					return true;
				}
				case "delete": {
					const before = state.jobs.length;
					state.jobs = state.jobs.filter((job) => job.id !== action.jobId);
					return state.jobs.length !== before;
				}
				case "enable": {
					const index = state.jobs.findIndex((job) => job.id === action.jobId);
					if (index < 0) return false;
					const job = state.jobs[index];
					if (job.enabled) return false;
					const next = {
						...job,
						enabled: true,
						...job.nextRunAt === void 0 ? seededNextRun(job, this.now()) : {},
						updatedAt: this.now()
					};
					state.jobs[index] = next;
					return true;
				}
				case "disable": {
					const index = state.jobs.findIndex((job) => job.id === action.jobId);
					if (index < 0) return false;
					const job = state.jobs[index];
					if (!job.enabled) return false;
					state.jobs[index] = {
						...job,
						enabled: false,
						updatedAt: this.now()
					};
					return true;
				}
				case "run": {
					const index = state.jobs.findIndex((job) => job.id === action.jobId);
					if (index < 0) return false;
					const job = state.jobs[index];
					if (hasOpenExecution(job)) return false;
					const execution = startExecution(`run-${crypto.randomUUID()}`, this.now());
					const next = {
						...job,
						executions: [...job.executions, execution],
						lastTriggeredAt: this.now()
					};
					state.jobs[index] = next;
					opened = {
						job: next,
						execution
					};
					return true;
				}
				case "rerun": {
					const index = state.jobs.findIndex((job) => job.id === action.jobId);
					if (index < 0) return false;
					const job = state.jobs[index];
					if (hasOpenExecution(job)) return false;
					const execution = startExecution(`rerun-${crypto.randomUUID()}`, this.now());
					const next = {
						...job,
						executions: [...job.executions, execution],
						lastTriggeredAt: this.now()
					};
					state.jobs[index] = next;
					rerun = {
						job: next,
						execution
					};
					return true;
				}
				default: return false;
			}
		});
		return {
			state: this.state(),
			...opened === void 0 ? {} : { run: opened },
			...rerun === void 0 ? {} : { rerun }
		};
	}
	/** Scheduler-owned: record a tick time (persisted, revision-bumped). */
	setScheduler(patch) {
		this.mutate((state) => {
			const { error, ...rest } = patch;
			state.scheduler = {
				...state.scheduler,
				...rest
			};
			if ("error" in patch && error === void 0) delete state.scheduler.error;
			else if (error !== void 0) state.scheduler.error = error;
			return true;
		});
	}
	/** Scheduler-owned: settle an execution with a result. Prunes old history. */
	settle(jobId, executionId, result, error) {
		this.mutate((state) => {
			const job = state.jobs.find((candidate) => candidate.id === jobId);
			if (job === void 0) return false;
			const index = job.executions.findIndex((execution) => execution.id === executionId);
			if (index < 0) return false;
			const settled = settleExecution(job.executions[index], result, this.now(), error);
			job.executions[index] = settled;
			if (job.executions.length > MAX_EXECUTION_HISTORY) job.executions = job.executions.slice(job.executions.length - MAX_EXECUTION_HISTORY);
			return true;
		});
	}
	/** Scheduler-owned: roll every enabled job's nextRunAt past `now` (missed runs are skipped). */
	skipMissed(now) {
		this.mutate((state) => {
			let changed = false;
			for (const job of state.jobs) {
				if (!job.enabled || job.nextRunAt === void 0 || job.nextRunAt > now) continue;
				const nextRunAt = rollNextRun(job, now);
				if (nextRunAt === void 0) delete job.nextRunAt;
				else job.nextRunAt = nextRunAt;
				changed = true;
			}
			return changed;
		});
	}
	/** Scheduler-owned: roll one job's nextRunAt past `now` (post catch-up). */
	skipMissedFor(jobId, now) {
		this.mutate((state) => {
			const job = state.jobs.find((candidate) => candidate.id === jobId);
			if (job === void 0 || !job.enabled || job.nextRunAt === void 0 || job.nextRunAt > now) return false;
			const nextRunAt = rollNextRun(job, now);
			if (nextRunAt === void 0) delete job.nextRunAt;
			else job.nextRunAt = nextRunAt;
			return true;
		});
	}
	/** Scheduler-owned: open a due scheduled run (no-op when running/disabled/not due). */
	openScheduled(jobId, executionId, now) {
		let opened;
		this.mutate((state) => {
			const index = state.jobs.findIndex((candidate) => candidate.id === jobId);
			if (index < 0) return false;
			const result = openScheduledRun(state.jobs[index], executionId, now);
			if (result === void 0) return false;
			state.jobs[index] = result.job;
			opened = result;
			return true;
		});
		return opened;
	}
	/**
	* Service-owned upsert (used by sibling plugins via picoCronService).
	* Preserves execution history; re-seeds nextRunAt when the cron changed or
	* the job just became enabled.
	*/
	upsertJob(registration) {
		const owner = this.owner();
		this.mutate((state) => {
			const index = state.jobs.findIndex((job) => job.id === registration.id);
			const now = this.now();
			if (index < 0) {
				const job = createJob(registration.id, {
					name: registration.name,
					cron: registration.cron,
					action: registration.action,
					...registration.enabled === void 0 ? {} : { enabled: registration.enabled }
				}, now, owner ?? void 0);
				if (job.enabled) {
					const seeded = rollNextRun(job, now);
					if (seeded !== void 0) job.nextRunAt = seeded;
				}
				state.jobs.push(job);
				return true;
			}
			const job = state.jobs[index];
			const cronChanged = registration.cron !== job.cron;
			const next = {
				...job,
				name: registration.name,
				cron: registration.cron,
				action: registration.action,
				enabled: registration.enabled ?? job.enabled,
				updatedAt: now
			};
			if (cronChanged) {
				const seeded = rollNextRun(withoutNextRun(next), now);
				if (seeded !== void 0) next.nextRunAt = seeded;
			} else if (next.enabled && job.nextRunAt === void 0) {
				const seeded = rollNextRun(withoutNextRun(next), now);
				if (seeded !== void 0) next.nextRunAt = seeded;
			}
			state.jobs[index] = next;
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
/** Validate a cron expression against the shared parser (UI and Host agree). */
function validateCron(expr) {
	return isValidCron(expr);
}
/**
* Migrate a ledger's jobs from an older schema version to the current one.
* 审计 2026-08-25 C-1:此前 schema 版本不匹配 = 清空数据。现在旧版本走
* 逐级迁移;新版本必须在此注册(从 fromVersion 逐级到当前)。当前只有
* v1;未来字段/枚举变更时在此加 v1→v2、v2→v3 … 并同步 bump 常量。
*/
function migrateCronLedger(jobs, fromVersion) {
	return jobs;
}
//#endregion
export { validateCron as i, migrateCronLedger as n, openScheduledRun as r, HostCronLedger as t };

//# sourceMappingURL=host-ledger-CqX0T9MB.js.map