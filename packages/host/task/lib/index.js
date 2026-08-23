import { HostTaskService } from "./host-service.js";
import { t as makeTaskRoutes } from "./host-routes-DSxkRfrf.js";
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
//#region src/tools.ts
function request(payload) {
	return {
		rpcId: `task-tool-${crypto.randomUUID()}`,
		payload
	};
}
/** Task board tools host entry: registers the tools on the tools registry. */
function registerTaskTools(ctx, service) {
	const disposers = [];
	disposers.push(ctx.tools.register(defineTool({
		name: "workspace_list",
		description: "列出全部项目（工作区）：id、标题、路径。创建任务需要指定项目时先用本工具查询项目 id，再传给 task_create 的 workspaceId。",
		parameters: {},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value)
			}]
		},
		async execute() {
			const response = await ctx.apiProxy.workspace.list(request({}));
			if (!response.result.ok) throw new Error(`${response.result.error.code}: ${response.result.error.message}`);
			return response.result.value.items.map((item) => ({
				workspaceId: item.workspaceId,
				title: item.title !== "" ? item.title : item.path,
				path: item.path
			}));
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "task_create",
		description: "在任务看板创建一个新任务。任务由真实 DSH 智能体会话执行（每次执行新建独立会话，可钉住工作区、agent 预设和权限）。项目（workspaceId）先用 workspace_list 查询；留空则使用当前会话的项目。返回任务 id。",
		parameters: {
			title: {
				type: "string",
				required: true,
				description: "任务标题（必填，非空）"
			},
			description: {
				type: "string",
				description: "任务描述"
			},
			prompt: {
				type: "string",
				description: "执行提示词（发送给智能体的指令）；缺省使用标题"
			},
			workspaceId: {
				type: "string",
				description: "钉住的项目（工作区）id，用 workspace_list 查询；缺省为当前项目"
			},
			mode: {
				type: "string",
				description: "钉住的 agent 预设 id；缺省为默认预设"
			},
			permission: {
				type: "string",
				description: "可选权限预设：read-only / workspace-write / danger-full-access；无人值守（定时/后台）执行请用 danger-full-access（完全访问、执行时不弹授权框）"
			}
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{
				type: "text",
				text: `已创建任务 ${value.id}`
			}]
		},
		async execute(args) {
			const input = {
				title: args.title.trim(),
				description: args.description ?? "",
				prompt: args.prompt !== void 0 && args.prompt.trim() !== "" ? args.prompt.trim() : args.title.trim(),
				...args.workspaceId === void 0 ? {} : { workspaceId: args.workspaceId },
				...args.mode === void 0 ? {} : { mode: args.mode },
				...args.permission === void 0 ? {} : { permission: args.permission }
			};
			const id = `task-${crypto.randomUUID()}`;
			service.apply(`tool-${crypto.randomUUID()}`, {
				kind: "create",
				id,
				input
			});
			return { id };
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "task_list",
		description: "列出任务看板的任务（可选按状态过滤）。返回任务 id、标题、状态、执行历史摘要。",
		parameters: {
			status: {
				type: "string",
				description: "可选状态过滤：todo / doing / done / failed"
			},
			archived: {
				type: "boolean",
				description: "是否包含归档任务（默认不含）"
			}
		},
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{
				type: "text",
				text: JSON.stringify(value)
			}]
		},
		async execute(args) {
			return service.getSnapshot().tasks.filter((task) => args.archived === true || task.archivedAt === void 0).filter((task) => args.status === void 0 || task.status === args.status).map((task) => ({
				id: task.id,
				title: task.title,
				status: task.status,
				executions: task.executions.length
			}));
		}
	})));
	disposers.push(ctx.tools.register(defineTool({
		name: "task_run",
		description: "立即执行一个任务（真实 DSH 智能体会话，经 Host runner 创建会话并发送提示词；执行历史自动回写看板）。任务已运行或不存在时返回错误。",
		parameters: { taskId: {
			type: "string",
			required: true,
			description: "任务 id"
		} },
		output: {
			schema: { type: "json" },
			render: (_args, value) => [{
				type: "text",
				text: value.started ? "任务已开始执行" : "任务未能开始"
			}]
		},
		async execute(args) {
			const result = await service.runTask(args.taskId);
			if (!result.ok) throw new Error(result.error);
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
const name = "pico-task";
/** Required Host services (cordis inject waiting). */
const inject = [
	"systemPrompt",
	"apiProxy",
	"webServer",
	"tools"
];
/** Model-facing announcement: plugin presence, capabilities, and limits. */
const TASK_GUIDANCE = "本机已安装 dsh-task 插件（DSH Desktop 的任务看板）：多列看板管理任务；任务由真实 DSH 智能体会话执行（每次执行新建独立会话，可钉住工作区、agent 预设和权限）；执行结果自动回写看板；可与 dsh-cron 配合定时执行。模型可直接调用 task_create / task_list / task_run 工具创建、查看和执行任务。用户提到「任务看板 / 看板 / 任务」时即指本插件，请据此协作。";
/** Settings namespace of the task plugin (spelled here and in the browser half). */
const TASK_SETTINGS_NAMESPACE = settingsNamespace("task");
const Config = z.object({
	enabled: z.boolean().default(true),
	announceToAgent: z.boolean().default(true)
});
function apply(ctx, config) {
	const host = new HostTaskService(ctx.apiProxy);
	host.setActive(config.enabled ?? true);
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
	const serviceDisposer = ctx.provide("picoTaskService", host);
	ctx.effect(() => {
		const disposers = [serviceDisposer];
		try {
			for (const route of makeTaskRoutes(host)) disposers.push(ctx.webServer.register(route));
			disposers.push(registerTaskTools(ctx, host));
		} catch (error) {
			for (const dispose of disposers) dispose();
			host.dispose();
			throw error;
		}
		return () => {
			for (const dispose of disposers) dispose();
			host.dispose();
		};
	}, "dsh-task: ledger, runner, routes, and tools");
	let current = () => config ?? {};
	let disposeSection;
	const sync = () => {
		if (disposeSection !== void 0) {
			disposeSection();
			disposeSection = void 0;
		}
		const active = current().enabled ?? true;
		host.setActive(active);
		if (!active) return;
		if ((current().announceToAgent ?? true) === false) return;
		disposeSection = ctx.systemPrompt.section({
			name: "plugin:dsh-task",
			order: SECTION_ORDER,
			text: TASK_GUIDANCE
		});
	};
	installSettingsSection(ctx, TASK_SETTINGS_NAMESPACE, Config, config ?? {}, {
		setSource: (source) => {
			current = source;
		},
		onChange: sync
	});
	sync();
}
//#endregion
export { Config, TASK_GUIDANCE, TASK_SETTINGS_NAMESPACE, apply, inject, name };

//# sourceMappingURL=index.js.map