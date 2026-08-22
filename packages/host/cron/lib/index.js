import { t as HostCronLedger } from "./host-ledger-Bi3N4tgX.js";
import { isValidCron, nextRunAtMs } from "./cron.js";
import { jobVisibleTo } from "./jobs.js";
import { HostCronExecutor } from "./host-executor.js";
import { HostCronScheduler } from "./host-scheduler.js";
import { t as makeCronRoutes } from "./host-routes-DXjUhAFq.js";
import z from "@deepseek-ai/schemastery";
import { Service } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region node_modules/@deepseek-ai/dsh-settings/lib/index.js
/**
* Structural secret redaction for settings values. `role('secret')` fields are
* removed from a value before it crosses a wire boundary; a sidecar records
* each schema-declared secret position and whether it currently holds a value,
* so a configuration surface can render a write-only input without ever
* receiving the secret itself.
* @module @deepseek-ai/dsh-settings/redact
*/
/** Whether a value is a plain data object the walker may recurse into. */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function walk(node, value, path, secrets) {
	if (node === void 0) return value;
	if (node.meta?.role === "secret") {
		secrets.push({
			path,
			set: value !== void 0
		});
		return;
	}
	switch (node.type) {
		case "object": {
			const properties = node.dict ?? {};
			const source = isRecord(value) ? value : void 0;
			const rebuilt = {};
			if (source !== void 0) for (const [key, entry] of Object.entries(source)) {
				if (key in properties) continue;
				rebuilt[key] = entry;
			}
			for (const [key, child] of Object.entries(properties)) {
				const stripped = walk(child, source?.[key], [...path, key], secrets);
				if (stripped !== void 0) rebuilt[key] = stripped;
			}
			return source === void 0 && Object.keys(rebuilt).length === 0 ? value : rebuilt;
		}
		case "dict": {
			if (!isRecord(value)) return value;
			const rebuilt = {};
			for (const [key, entry] of Object.entries(value)) {
				const stripped = walk(node.inner, entry, [...path, key], secrets);
				if (stripped !== void 0) rebuilt[key] = stripped;
			}
			return rebuilt;
		}
		case "array":
			if (!Array.isArray(value)) return value;
			return value.map((entry, index) => walk(node.inner, entry, [...path, String(index)], secrets));
		default: return value;
	}
}
/**
* Service Definition for the user-settings capability seam (`ctx.settings`). Providers store one raw document of
* per-namespace sections; plugins register a namespace schema and read the
* resolved value, which layers schema defaults, the registrant's composition
* `base`, and the user document section, in that order.
* @module @deepseek-ai/dsh-settings
*/
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/;
/**
* Brand a raw string as a {@link SettingsNamespace}.
* @param value - candidate namespace; lowercase kebab-case, as in plugin short names.
* @returns the branded namespace.
*/
function settingsNamespace(value) {
	if (!NAMESPACE_PATTERN.test(value)) throw new TypeError(`settings namespace "${value}" must match ${String(NAMESPACE_PATTERN)}`);
	return value;
}
/**
* Deep equality over JSON-compatible data (objects, arrays, primitives) — the
* Service Definition's single change-detection predicate, exported so the invariant
* companion checks exactly the implementation's relation.
* @param a - one JSON-compatible value.
* @param b - the other JSON-compatible value.
* @returns whether the two values are structurally equal.
*/
function deepEqualJson(a, b) {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((entry, index) => deepEqualJson(entry, b[index]));
	}
	const left = a;
	const right = b;
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every((key) => key in right && deepEqualJson(left[key], right[key]));
}
/** Whether a value is a plain data object (not an array, null, or class instance). */
function isPlainObject(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}
/** Apply one path op to a detached section, returning the next section. */
function applyPathOp(section, op) {
	const [head, ...rest] = op.path;
	if (head === void 0) {
		if (op.op === "unset") return {};
		if (!isPlainObject(op.value)) throw new TypeError("settings mutate: setting the section root requires a plain object");
		return { ...op.value };
	}
	if (rest.length === 0) {
		if (op.op === "set") return {
			...section,
			[head]: op.value
		};
		const { [head]: _removed, ...kept } = section;
		return kept;
	}
	const child = section[head];
	if (!isPlainObject(child)) {
		if (op.op === "unset") return section;
		return {
			...section,
			[head]: applyPathOp({}, {
				...op,
				path: rest
			})
		};
	}
	return {
		...section,
		[head]: applyPathOp(child, {
			...op,
			path: rest
		})
	};
}
/**
* Layer `over` onto `under`: plain objects merge recursively, every other
* value (arrays included) replaces the lower layer wholesale. `over` never
* carries `undefined` entries — sections come from parsed documents and write
* snapshots pass {@link cloneJsonShaped}, which strips them so a sparse patch
* cannot erase lower keys.
*/
function mergeLayers(under, over) {
	if (over === void 0) return under;
	if (!isPlainObject(under) || !isPlainObject(over)) return over;
	const merged = { ...under };
	for (const [key, value] of Object.entries(over)) merged[key] = key in merged ? mergeLayers(merged[key], value) : value;
	return merged;
}
/** Recursively freeze one resolved value so handed-out snapshots stay immutable. */
function deepFreeze(value) {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const entry of Object.values(value)) deepFreeze(entry);
	return Object.freeze(value);
}
Service.init;
/**
* Value mirror of the `FiberState` members {@link isUnloading} compares
* against: a const enum has no runtime object to import, and the value is
* needed at runtime (same rationale as the CLI boot driver's mirror).
*/
const FIBER_DISPOSED = 4;
const FIBER_UNLOADING = 5;
/** Whether the consumer's own fiber is tearing down (not just losing the settings service). */
function isUnloading(ctx) {
	const state = ctx.fiber.state;
	return state === FIBER_UNLOADING || state === FIBER_DISPOSED;
}
/**
* Install the canonical optional-settings consumer wiring: while a settings
* service exists, register `ns` with the consumer's composition entry as the
* `base` layer and point the source thunk at the resolved scope; when the
* service goes away (disposal, provider reload), fall back to the entry so
* the consumer keeps working exactly as composed. The registration rides the
* scoped fiber, so no settings service ever mounted means none of this runs.
* @param ctx - consumer plugin context owning the wiring.
* @param ns - the consumer-owned settings namespace.
* @param schema - schema resolving the namespace (typically the plugin Config).
* @param entry - the consumer's composition entry config, used as `base`.
* @param hooks - source sink and change notification.
*/
function installSettingsSection(ctx, ns, schema, entry, hooks) {
	ctx.inject(["settings"], (sctx) => {
		const scope = sctx.settings.register(ns, schema, {
			base: entry,
			...hooks.validate === void 0 ? {} : { validate: hooks.validate }
		});
		hooks.setSource(() => scope.get());
		sctx.effect(() => () => {
			if (isUnloading(ctx)) return;
			hooks.setSource(() => entry);
			hooks.onChange();
		});
		hooks.onChange();
		scope.watch(() => {
			if (isUnloading(ctx)) return;
			hooks.onChange();
		});
	});
}
//#endregion
//#region src/host-service.ts
var HostCronService = class {
	ledger;
	scheduler;
	listeners = /* @__PURE__ */ new Set();
	active = true;
	lastEventJson = "";
	now;
	/** Current account (gateway username); set by the plugin on session change. */
	username = null;
	constructor(api, options = {}) {
		this.ledger = options.ledger ?? new HostCronLedger({ owner: () => this.username });
		this.now = options.now ?? Date.now;
		const executor = options.executor ?? new HostCronExecutor({
			api,
			taskService: options.taskService ?? (() => void 0)
		});
		this.scheduler = options.scheduler ?? new HostCronScheduler(this.ledger, executor, {
			now: this.now,
			visible: (job) => jobVisibleTo(job, this.username)
		});
		this.ledger.subscribe(() => this.emit());
	}
	/** Set the current account (gateway username); null when logged out. */
	setUsername(username) {
		this.username = username;
		this.emit();
	}
	/** Current account (gateway username). */
	currentUsername() {
		return this.username;
	}
	start() {
		this.scheduler.start();
	}
	setConfiguration(active, catchUpMissed) {
		const resumed = !this.active && active;
		this.active = active;
		this.scheduler.catchUpMissed = catchUpMissed;
		if (resumed) this.scheduler.start();
		if (!active) this.scheduler.stop();
		this.emit();
	}
	snapshot() {
		const state = this.ledger.state();
		return {
			schemaVersion: 1,
			revision: state.revision,
			jobs: state.jobs.filter((job) => jobVisibleTo(job, this.username)),
			scheduler: state.scheduler
		};
	}
	/** SSE frame payload; deliberately skips the jobs deep-clone of {@link snapshot}. */
	eventPayload() {
		const { revision, scheduler } = this.ledger.summary();
		return {
			revision,
			scheduler
		};
	}
	subscribe(listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	apply(requestId, action) {
		if (!this.active) throw new Error("cron scheduler is disabled");
		const result = this.ledger.applyRequest(requestId, action);
		if (result.run !== void 0) this.scheduler.fire(result.run.job, result.run.execution);
		if (result.rerun !== void 0) this.scheduler.fire(result.rerun.job, result.rerun.execution);
		return this.snapshot();
	}
	registerJob(registration) {
		if (!this.active) throw new Error("cron scheduler is disabled");
		this.ledger.upsertJob(registration);
	}
	unregisterJob(id) {
		this.ledger.applyRequest(`unregister-${crypto.randomUUID()}`, {
			kind: "delete",
			jobId: id
		});
	}
	listJobs() {
		return this.ledger.state().jobs;
	}
	getSnapshot() {
		return this.snapshot();
	}
	emit() {
		const json = JSON.stringify(this.eventPayload());
		if (json === this.lastEventJson) return;
		this.lastEventJson = json;
		for (const listener of [...this.listeners]) listener();
	}
	dispose() {
		this.scheduler.dispose();
		this.ledger.dispose();
		this.listeners.clear();
	}
};
//#endregion
//#region src/tools.ts
/** Cron tools host entry: registers the tools on the tools registry. */
function registerCronTools(ctx, service) {
	const disposers = [];
	disposers.push(ctx.tools.register(defineTool({
		name: "cron_create",
		description: "创建定时任务（cron 表达式，5 段：分 时 日 月 周，支持 */n 步进、a-b 范围、逗号列表，日/周 OR 语义）。到点由 Host 进程执行——关闭窗口或浏览器页面后仍会执行。动作二选一：执行看板任务（taskId）或向指定会话发送消息（sessionId+text）。",
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "定时任务名称（非空）"
			},
			cron: {
				type: "string",
				required: true,
				description: "5 段 cron 表达式，如 0 9 * * *（每天 09:00）"
			},
			taskId: {
				type: "string",
				description: "要执行的看板任务 id（与 sessionId+text 二选一）；用 task_list 查询（任务创建时可用 workspace_list 选择项目）"
			},
			sessionId: {
				type: "string",
				description: "要发送消息的目标会话 id（与 taskId 二选一）"
			},
			text: {
				type: "string",
				description: "要发送的消息内容（sessionId 模式必填）"
			},
			enabled: {
				type: "boolean",
				description: "是否立即启用（默认 false）"
			}
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{
				type: "text",
				text: `已创建定时任务 ${value.id}`
			}]
		},
		async execute(args) {
			if (!isValidCron(args.cron)) throw new Error(`cron 表达式无效: ${args.cron}`);
			if (nextRunAtMs(args.cron, Date.now()) === void 0) throw new Error(`cron 表达式在五年内无匹配时刻: ${args.cron}`);
			const hasTask = args.taskId !== void 0 && args.taskId !== "";
			const hasPrompt = args.sessionId !== void 0 && args.sessionId !== "";
			if (hasTask === hasPrompt) throw new Error("必须且只能提供 taskId 或 sessionId+text 之一");
			if (hasPrompt && (args.text === void 0 || args.text === "")) throw new Error("sessionId 模式必须提供 text");
			const id = `job-${crypto.randomUUID()}`;
			service.registerJob({
				id,
				name: args.name.trim(),
				cron: args.cron.trim(),
				action: hasTask ? {
					kind: "task",
					taskId: args.taskId
				} : {
					kind: "prompt",
					sessionId: args.sessionId,
					text: args.text
				},
				enabled: args.enabled ?? false
			});
			return { id };
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "cron_list",
		description: "列出全部定时任务（id、名称、cron、启用状态、下次运行时间、执行历史条数）。",
		parameters: { enabledOnly: {
			type: "boolean",
			description: "只列已启用的（默认 false）"
		} },
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value)
			}]
		},
		async execute(args) {
			return service.listJobs().filter((job) => args.enabledOnly !== true || job.enabled).map((job) => ({
				id: job.id,
				name: job.name,
				cron: job.cron,
				enabled: job.enabled,
				...job.nextRunAt === void 0 ? {} : { nextRunAt: job.nextRunAt },
				executions: job.executions.length
			}));
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "cron_set_enabled",
		description: "启用或停用一个定时任务（停用后到点不再触发，任务保留）。",
		parameters: {
			jobId: {
				type: "string",
				required: true,
				description: "定时任务 id"
			},
			enabled: {
				type: "boolean",
				required: true,
				description: "true=启用，false=停用"
			}
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => {
				const v = value;
				return [{
					type: "text",
					text: `${v.enabled ? "已启用" : "已停用"}定时任务 ${v.jobId}`
				}];
			}
		},
		async execute(args) {
			service.apply(`tool-${crypto.randomUUID()}`, {
				kind: args.enabled ? "enable" : "disable",
				jobId: args.jobId
			});
			return {
				jobId: args.jobId,
				enabled: args.enabled
			};
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "cron_run",
		description: "立即触发一个定时任务（走与到点触发相同的执行路径；任务不存在或已在运行时返回错误）。",
		parameters: { jobId: {
			type: "string",
			required: true,
			description: "定时任务 id"
		} },
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{
				type: "text",
				text: value.started ? "定时任务已触发" : "定时任务未能触发"
			}]
		},
		async execute(args) {
			const before = service.listJobs().find((job) => job.id === args.jobId);
			if (before === void 0) throw new Error(`定时任务不存在: ${args.jobId}`);
			if (before.executions.some((execution) => execution.endedAt === void 0)) throw new Error(`定时任务 ${args.jobId} 已在运行`);
			service.apply(`tool-${crypto.randomUUID()}`, {
				kind: "run",
				jobId: args.jobId
			});
			return { started: true };
		}
	})));
	return () => {
		for (const dispose of disposers) dispose();
	};
}
//#endregion
//#region src/index.ts
/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 200;
const name = "pico-cron";
/** Required Host services (cordis inject waiting). */
const inject = [
	"systemPrompt",
	"apiProxy",
	"webServer",
	"tools"
];
/** Model-facing announcement: plugin presence, capabilities, and limits. */
const CRON_GUIDANCE = "本机已安装 dsh-cron 插件（DSH Desktop 的定时任务调度器）：可创建定时任务（cron 表达式，分钟级精度），到点由 Host 进程执行——关闭窗口或浏览器页面后仍会执行；应用完全退出期间错过的触发点默认跳过（可在设置中开启补跑最近一次）；定时任务可执行 dsh-task 插件的任务，或向指定会话发送 prompt。模型可直接调用 cron_create / cron_list / cron_set_enabled / cron_run 工具创建、查看、启停和触发定时任务。用户提到「定时任务 / cron / 定时执行」时即指本插件，请据此协作。";
/** Settings namespace of the cron plugin (spelled here and in the browser half). */
const CRON_SETTINGS_NAMESPACE = settingsNamespace("cron");
const Config = z.object({
	enabled: z.boolean().default(true),
	announceToAgent: z.boolean().default(true),
	catchUpMissed: z.boolean().default(false)
});
/**
* Register the cron Host service, routes, and announcement section. The
* service is re-judged whenever the settings source changes, so a settings
* edit takes effect without a restart.
*/
function apply(ctx, config) {
	const host = new HostCronService(ctx.apiProxy, { taskService: () => ctx.get("picoTaskService") });
	host.setConfiguration(config.enabled ?? true, config.catchUpMissed ?? false);
	host.start();
	const currentUser = () => {
		try {
			return ctx.get("picoSession")?.getSession?.()?.username ?? null;
		} catch {
			return null;
		}
	};
	host.setUsername(currentUser());
	ctx.on("pico/session-changed", (next) => {
		host.setUsername(next?.username ?? null);
	});
	const serviceDisposer = ctx.provide("picoCronService", host);
	ctx.effect(() => {
		const disposers = [serviceDisposer];
		try {
			for (const route of makeCronRoutes(host)) disposers.push(ctx.webServer.register(route));
			disposers.push(registerCronTools(ctx, host));
		} catch (error) {
			for (const dispose of disposers) dispose();
			host.dispose();
			throw error;
		}
		return () => {
			for (const dispose of disposers) dispose();
			host.dispose();
		};
	}, "dsh-cron: ledger, scheduler, and routes");
	let current = () => config ?? {};
	let disposeSection;
	const sync = () => {
		if (disposeSection !== void 0) {
			disposeSection();
			disposeSection = void 0;
		}
		const active = current().enabled ?? true;
		host.setConfiguration(active, current().catchUpMissed ?? false);
		if (!active) return;
		if ((current().announceToAgent ?? true) === false) return;
		disposeSection = ctx.systemPrompt.section({
			name: "plugin:dsh-cron",
			order: SECTION_ORDER,
			text: CRON_GUIDANCE
		});
	};
	installSettingsSection(ctx, CRON_SETTINGS_NAMESPACE, Config, config ?? {}, {
		setSource: (source) => {
			current = source;
		},
		onChange: sync
	});
	sync();
}
//#endregion
export { CRON_GUIDANCE, CRON_SETTINGS_NAMESPACE, Config, apply, inject, name };

//# sourceMappingURL=index.js.map