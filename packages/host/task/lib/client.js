window.__ModuleLoader__.load({
	id: "@picoaide/dsh-task",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react_dom_client = require("react-dom/client");
		//#region src/client/controller.ts
		var TaskController = class {
			snapshot;
			listeners = /* @__PURE__ */ new Set();
			transport;
			refetchDebounceMs;
			uuid;
			started = false;
			disposed = false;
			refetchTimer;
			unsubscribeTransport;
			/** Optional cron service resolver (set by the client entry when dsh-cron is present). */
			cron;
			/** Opens a session in the shell (used by the execution-session jump). */
			openSession;
			constructor(deps) {
				this.transport = deps.transport;
				this.refetchDebounceMs = deps.refetchDebounceMs ?? 250;
				this.uuid = deps.uuid ?? (() => crypto.randomUUID());
				this.snapshot = {
					tasks: [],
					revision: 0,
					archiveView: false,
					pendingTaskIds: []
				};
			}
			start() {
				if (this.started || this.disposed) return;
				this.started = true;
				this.unsubscribeTransport = this.transport.subscribe(() => {
					this.scheduleRefetch();
				});
				this.refresh();
			}
			getSnapshot() {
				return this.snapshot;
			}
			subscribe(listener) {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			}
			create(input) {
				this.submit({
					kind: "create",
					id: this.uuid(),
					input
				});
			}
			update(taskId, patch) {
				this.submit({
					kind: "update",
					taskId,
					patch
				});
			}
			remove(taskId) {
				this.submit({
					kind: "delete",
					taskId
				});
			}
			move(taskId, status) {
				this.submit({
					kind: "move",
					taskId,
					status
				});
			}
			archive(taskId) {
				this.submit({
					kind: "archive",
					taskId
				});
			}
			restore(taskId) {
				this.submit({
					kind: "restore",
					taskId
				});
			}
			run(taskId) {
				this.submit({
					kind: "run",
					taskId
				});
			}
			rerun(taskId) {
				this.submit({
					kind: "rerun",
					taskId
				});
			}
			/** P0-3: cancel a running task (settles open executions as cancelled). */
			cancel(taskId) {
				this.submit({
					kind: "cancel",
					taskId
				});
			}
			openTask(taskId) {
				this.snapshot = {
					...this.snapshot,
					selectedTaskId: taskId
				};
				this.notify();
			}
			closeTask() {
				const { selectedTaskId: _drop, ...rest } = this.snapshot;
				this.snapshot = rest;
				this.notify();
			}
			toggleArchiveView() {
				this.snapshot = {
					...this.snapshot,
					archiveView: !this.snapshot.archiveView
				};
				this.notify();
			}
			retryHostSync() {
				return this.refresh();
			}
			dispose() {
				if (this.disposed) return;
				this.disposed = true;
				this.started = false;
				if (this.refetchTimer !== void 0) clearTimeout(this.refetchTimer);
				this.unsubscribeTransport?.();
				this.unsubscribeTransport = void 0;
				this.listeners.clear();
			}
			async submit(action) {
				if (this.disposed) return;
				const taskId = "taskId" in action ? action.taskId : void 0;
				this.markPending(taskId, true);
				try {
					const snapshot = await this.transport.action(action);
					this.install(snapshot);
				} catch (error) {
					this.snapshot = {
						...this.snapshot,
						transportError: error instanceof Error ? error.message : String(error)
					};
					this.notify();
					this.scheduleRefetch();
				} finally {
					this.markPending(taskId, false);
				}
			}
			async refresh() {
				if (this.disposed) return;
				try {
					const snapshot = await this.transport.state();
					if (snapshot.revision < this.snapshot.revision) return;
					this.install(snapshot);
				} catch (error) {
					this.snapshot = {
						...this.snapshot,
						transportError: error instanceof Error ? error.message : String(error)
					};
					this.notify();
				}
			}
			install(snapshot) {
				const { transportError: _dropped, ...rest } = this.snapshot;
				this.snapshot = {
					tasks: snapshot.tasks,
					revision: snapshot.revision,
					...rest.selectedTaskId === void 0 ? {} : { selectedTaskId: rest.selectedTaskId },
					archiveView: rest.archiveView,
					pendingTaskIds: rest.pendingTaskIds
				};
				this.notify();
			}
			markPending(taskId, pending) {
				if (taskId === void 0) return;
				const set = new Set(this.snapshot.pendingTaskIds);
				if (pending) set.add(taskId);
				else set.delete(taskId);
				this.snapshot = {
					...this.snapshot,
					pendingTaskIds: [...set]
				};
				this.notify();
			}
			scheduleRefetch() {
				if (this.disposed) return;
				if (this.refetchTimer !== void 0) return;
				this.refetchTimer = setTimeout(() => {
					this.refetchTimer = void 0;
					this.refresh();
				}, this.refetchDebounceMs);
			}
			notify() {
				for (const listener of [...this.listeners]) listener();
			}
		};
		//#endregion
		//#region src/client/host-api.ts
		function parseSnapshot(value) {
			if (typeof value !== "object" || value === null) throw new Error("invalid snapshot");
			const snapshot = value;
			if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.tasks)) throw new Error("unexpected schema");
			return snapshot;
		}
		var HttpTaskTransport = class {
			async bootstrap() {
				return this.state();
			}
			async state() {
				const response = await fetch("/api/task/state", { headers: { accept: "application/json" } });
				if (!response.ok) throw new Error(`task state failed: ${response.status}`);
				return parseSnapshot(await response.json());
			}
			async action(action) {
				const response = await fetch("/api/task/action", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						requestId: crypto.randomUUID(),
						action
					})
				});
				if (!response.ok) throw new Error(`task action failed: ${response.status}`);
				return parseSnapshot(await response.json());
			}
			subscribe(listener) {
				let closed = false;
				let source;
				try {
					source = new EventSource("/api/task/events");
					source.onmessage = () => {
						if (!closed) listener();
					};
					source.onerror = () => {
						if (!closed) listener();
					};
				} catch {
					listener();
				}
				return () => {
					closed = true;
					source?.close();
				};
			}
		};
		//#endregion
		//#region src/tasks.ts
		/** The five board columns. */
		const COLUMNS = [
			{
				status: "todo",
				labelKey: "board.column.todo"
			},
			{
				status: "doing",
				labelKey: "board.column.doing"
			},
			{
				status: "done",
				labelKey: "board.column.done"
			},
			{
				status: "failed",
				labelKey: "board.column.failed"
			}
		];
		//#endregion
		//#region src/client/styles.ts
		const styles = {
			board: {
				display: "flex",
				flexDirection: "column",
				height: "100%",
				minWidth: 640,
				position: "relative",
				fontSize: 13,
				color: "var(--dsw-alias-label-primary)",
				background: "transparent"
			},
			header: {
				display: "flex",
				alignItems: "center",
				gap: 10,
				padding: "10px 14px",
				borderBottom: "1px solid var(--dsw-alias-border-l2)",
				flexShrink: 0,
				minHeight: 44
			},
			title: {
				flex: 1,
				margin: 0,
				fontSize: 14,
				fontWeight: 600
			},
			meta: {
				fontSize: 11,
				opacity: .65,
				whiteSpace: "nowrap"
			},
			search: {
				border: "1px solid var(--dsw-alias-border-l3)",
				borderRadius: 6,
				background: "var(--dsw-alias-bg-layer-3)",
				color: "inherit",
				fontSize: 12,
				padding: "4px 8px",
				fontFamily: "inherit",
				width: 160
			},
			button: {
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: 6,
				background: "transparent",
				color: "inherit",
				fontSize: 12,
				padding: "4px 10px",
				cursor: "pointer",
				fontFamily: "inherit"
			},
			buttonPrimary: {
				borderColor: "var(--dsw-alias-state-business-primary)",
				color: "var(--dsw-alias-state-business-primary)"
			},
			buttonDisabled: {
				opacity: .45,
				cursor: "default"
			},
			error: {
				color: "var(--dsw-alias-state-error-primary)",
				fontSize: 12,
				padding: "4px 14px"
			},
			columns: {
				flex: 1,
				display: "grid",
				gridTemplateColumns: "repeat(4, minmax(180px, 1fr))",
				gap: 10,
				padding: "10px 14px",
				overflowX: "auto",
				overflowY: "hidden",
				alignItems: "start"
			},
			column: {
				display: "flex",
				flexDirection: "column",
				maxHeight: "100%",
				border: "1px solid var(--dsw-alias-border-l1)",
				borderRadius: 10,
				background: "var(--dsw-alias-bg-layer-2)"
			},
			columnHeader: {
				display: "flex",
				alignItems: "center",
				gap: 6,
				padding: "8px 10px",
				borderBottom: "1px solid var(--dsw-alias-border-l1)"
			},
			columnTitle: {
				flex: 1,
				margin: 0,
				fontSize: 12,
				fontWeight: 600
			},
			columnCount: {
				fontSize: 11,
				opacity: .7,
				background: "var(--dsw-alias-border-l1)",
				borderRadius: 999,
				padding: "1px 7px"
			},
			statusDot: {
				width: 8,
				height: 8,
				borderRadius: "50%",
				display: "inline-block"
			},
			cards: {
				flex: 1,
				overflowY: "auto",
				padding: 8,
				display: "flex",
				flexDirection: "column",
				gap: 8
			},
			card: {
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: 8,
				padding: "8px 10px",
				background: "var(--dsw-alias-bg-layer-2)",
				cursor: "pointer",
				display: "flex",
				flexDirection: "column",
				gap: 4
			},
			cardTitle: {
				fontWeight: 600,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			},
			cardDesc: {
				fontSize: 11,
				opacity: .7,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			},
			cardMeta: {
				fontSize: 10,
				opacity: .55,
				display: "flex",
				gap: 6
			},
			columnEmpty: {
				padding: "20px 8px",
				textAlign: "center",
				opacity: .5,
				fontSize: 12
			},
			detail: {
				position: "absolute",
				right: 0,
				top: 0,
				bottom: 0,
				width: "min(420px, 40vw)",
				borderLeft: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-2)",
				display: "flex",
				flexDirection: "column",
				zIndex: 10
			},
			detailHeader: {
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "10px 12px",
				borderBottom: "1px solid var(--dsw-alias-border-l2)"
			},
			detailBody: {
				flex: 1,
				overflowY: "auto",
				padding: "10px 12px",
				display: "flex",
				flexDirection: "column",
				gap: 10
			},
			field: {
				display: "flex",
				flexDirection: "column",
				gap: 4
			},
			label: {
				fontSize: 11,
				opacity: .75
			},
			value: {
				fontSize: 13,
				whiteSpace: "pre-wrap"
			},
			input: {
				border: "1px solid var(--dsw-alias-border-l3)",
				borderRadius: 6,
				background: "var(--dsw-alias-bg-layer-3)",
				color: "inherit",
				fontSize: 13,
				padding: "5px 8px",
				fontFamily: "inherit"
			},
			history: {
				display: "flex",
				flexDirection: "column",
				gap: 4,
				fontSize: 12
			},
			historyRow: {
				display: "flex",
				gap: 8,
				alignItems: "center"
			},
			switch: {
				display: "inline-flex",
				alignItems: "center",
				gap: 6,
				fontSize: 12,
				cursor: "pointer"
			},
			row: {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 12
			},
			rowDesc: {
				fontSize: 12,
				opacity: .7
			},
			resultOk: { color: "var(--dsw-alias-state-success-primary)" },
			resultFail: { color: "var(--dsw-alias-state-error-primary)" },
			resultCancel: { opacity: .7 },
			resultPending: { color: "var(--dsw-alias-state-warn-primary)" },
			overlay: {
				position: "fixed",
				inset: 0,
				background: "var(--dsw-alias-bg-mask-1)",
				backdropFilter: "var(--dsw-mask-blur)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				zIndex: 2147483e3
			},
			editor: {
				width: "min(520px, 92vw)",
				maxHeight: "88vh",
				overflowY: "auto",
				border: "1px solid var(--dsw-alias-border-l3)",
				borderRadius: 12,
				background: "var(--dsw-alias-bg-layer-2)",
				boxShadow: "var(--dsw-shadow-lv3)",
				padding: "14px 16px",
				display: "flex",
				flexDirection: "column",
				gap: 10,
				color: "var(--dsw-alias-label-primary)",
				fontSize: 13
			},
			editorActions: {
				display: "flex",
				justifyContent: "flex-end",
				gap: 8,
				marginTop: 4
			},
			schedule: {
				border: "1px dashed var(--dsw-alias-border-l2)",
				borderRadius: 8,
				padding: "8px 10px",
				display: "flex",
				flexDirection: "column",
				gap: 6,
				fontSize: 12
			}
		};
		//#endregion
		//#region src/client/locales.ts
		/**
		* Task plugin UI copy: zh is the key source, en mirrors the full key set.
		*/
		const zh = {
			"entry.label": "任务看板",
			"board.title": "任务看板",
			"board.close": "返回聊天",
			"board.search": "搜索任务…",
			"board.new": "新建任务",
			"board.archiveView": "归档 ({count})",
			"board.backToBoard": "返回看板",
			"board.hostMeta": "修订 {revision}",
			"board.hostError": "无法连接任务服务：{error}",
			"board.retryHost": "重试",
			"board.empty": "暂无任务",
			"board.column.todo": "待办",
			"board.column.doing": "进行中",
			"board.column.done": "已完成",
			"board.column.failed": "已失败",
			"board.archive": "归档",
			"archive.empty": "暂无归档任务",
			"detail.title": "任务详情",
			"detail.run": "执行",
			"detail.rerun": "重试",
			"detail.cancel": "取消执行",
			"detail.cancelConfirm": "确定取消这个正在执行的任务吗？任务将回到待办列，可重新执行。",
			"detail.openSession": "查看执行会话",
			"detail.edit": "编辑",
			"detail.delete": "删除",
			"detail.archive": "归档",
			"detail.restore": "恢复",
			"detail.history": "执行历史",
			"detail.noHistory": "尚未执行",
			"detail.context": "查看执行上下文",
			"detail.contextHide": "收起上下文",
			"detail.contextEmpty": "（本次执行未记录注入上下文）",
			"detail.prompt": "执行提示词",
			"detail.description": "描述",
			"detail.workspace": "工作区",
			"detail.mode": "Agent 预设",
			"detail.permission": "权限",
			"detail.status": "状态",
			"detail.statusMove": "移动到此状态",
			"detail.deleteConfirm": "确定删除该任务吗？删除后不可恢复。",
			"permission.none": "默认（当前会话权限）",
			"permission.read-only": "只读（read-only）",
			"permission.workspace-write": "工作区读写（workspace-write，需授权）",
			"permission.danger-full-access": "完全访问（danger-full-access，免授权）",
			"permission.unattended": "无人值守执行请选「完全访问」：执行时不弹授权框、不因等待授权而卡住。",
			"detail.current": "（当前）",
			"detail.default": "（默认）",
			"detail.execution.pending": "执行中",
			"detail.execution.succeeded": "成功",
			"detail.execution.failed": "失败",
			"detail.execution.cancelled": "已取消",
			"detail.schedule": "定时执行",
			"detail.schedule.enabled": "已启用定时执行",
			"detail.schedule.disabled": "未启用定时",
			"detail.schedule.attach": "配置定时执行",
			"detail.schedule.attached": "已关联定时任务",
			"new.title": "新建任务",
			"new.name": "标题",
			"new.prompt": "执行提示词（发送给智能体的指令）",
			"new.description": "描述",
			"new.save": "创建",
			"new.cancel": "取消",
			"new.titleRequired": "标题不能为空",
			"settings.title": "任务看板",
			"settings.enabled": "启用任务看板",
			"settings.enabledDesc": "关闭后看板隐藏，任务与执行历史保留。",
			"settings.announce": "向 Agent 公告插件能力",
			"settings.announceDesc": "在系统提示词中声明任务看板能力，模型可据此协作。"
		};
		const en = {
			"entry.label": "Task board",
			"board.title": "Task board",
			"board.close": "Back to chat",
			"board.search": "Search tasks…",
			"board.new": "New task",
			"board.archiveView": "Archive ({count})",
			"board.backToBoard": "Back to board",
			"board.hostMeta": "Revision {revision}",
			"board.hostError": "Task service unreachable: {error}",
			"board.retryHost": "Retry",
			"board.empty": "No tasks",
			"board.column.todo": "To do",
			"board.column.doing": "Doing",
			"board.column.done": "Done",
			"board.column.failed": "Failed",
			"board.archive": "Archive",
			"archive.empty": "No archived tasks",
			"detail.title": "Task detail",
			"detail.run": "Run",
			"detail.rerun": "Retry",
			"detail.cancel": "Cancel run",
			"detail.cancelConfirm": "Cancel this running task? It returns to the todo column and can be run again.",
			"detail.openSession": "Open execution session",
			"detail.edit": "Edit",
			"detail.delete": "Delete",
			"detail.archive": "Archive",
			"detail.restore": "Restore",
			"detail.history": "Execution history",
			"detail.noHistory": "Not executed yet",
			"detail.context": "View execution context",
			"detail.contextHide": "Hide context",
			"detail.contextEmpty": "(No injected context recorded for this run)",
			"detail.prompt": "Prompt",
			"detail.description": "Description",
			"detail.workspace": "Workspace",
			"detail.mode": "Agent preset",
			"detail.permission": "Permission",
			"detail.status": "Status",
			"detail.statusMove": "Move to status",
			"detail.deleteConfirm": "Delete this task? This cannot be undone.",
			"permission.none": "Default (current session permission)",
			"permission.read-only": "Read-only",
			"permission.workspace-write": "Workspace write (asks approval)",
			"permission.danger-full-access": "Full access (no approval prompts)",
			"permission.unattended": "For unattended runs choose \"Full access\": no approval prompts, no stuck waits.",
			"detail.current": "（current）",
			"detail.default": "（default）",
			"detail.execution.pending": "Running",
			"detail.execution.succeeded": "Succeeded",
			"detail.execution.failed": "Failed",
			"detail.execution.cancelled": "Cancelled",
			"detail.schedule": "Schedule",
			"detail.schedule.enabled": "Scheduled runs enabled",
			"detail.schedule.disabled": "Not scheduled",
			"detail.schedule.attach": "Configure schedule",
			"detail.schedule.attached": "Linked scheduled job",
			"new.title": "New task",
			"new.name": "Title",
			"new.prompt": "Prompt (instructions sent to the agent)",
			"new.description": "Description",
			"new.save": "Create",
			"new.cancel": "Cancel",
			"new.titleRequired": "Title is required",
			"settings.title": "Task board",
			"settings.enabled": "Enable task board",
			"settings.enabledDesc": "Disabling hides the board; tasks and history are kept.",
			"settings.announce": "Announce to agents",
			"settings.announceDesc": "Declares the task board capability in the system prompt."
		};
		/** Translate a key with optional {name} params. */
		function t(key, params) {
			let text = zh[key] ?? key;
			if (params !== void 0) for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, value);
			return text;
		}
		//#endregion
		//#region src/client/WorkspacePicker.tsx
		/**
		* Project (workspace) picker shared by the new-task modal and the task
		* detail editor. Reads the client workspaces feed (the same list the shell
		* sidebar shows) and offers an empty "当前项目（默认）" option plus every
		* registered project.
		*/
		/** Extract the workspace option list from the client feed. */
		function workspaceOptionsFrom(workspaces) {
			if (workspaces === void 0) return [];
			return workspaces.list.getSnapshot().items.map((item) => ({
				workspaceId: String(item.workspaceId),
				title: item.title !== "" ? item.title : String(item.path)
			}));
		}
		/** Subscribe to the workspaces feed; returns the latest option list. */
		function useWorkspaceOptions(workspaces) {
			const [options, setOptions] = (0, react.useState)(() => workspaceOptionsFrom(workspaces));
			(0, react.useEffect)(() => {
				if (workspaces === void 0) return;
				const update = () => {
					setOptions(workspaceOptionsFrom(workspaces));
				};
				update();
				return workspaces.list.subscribe(update);
			}, [workspaces]);
			return options;
		}
		/**
		* Project select row. `value` is the selected workspaceId ('' = current
		* project); onChange receives the selected workspaceId or ''.
		*/
		function WorkspacePicker({ workspaces, value, onChange }) {
			const options = useWorkspaceOptions(workspaces);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: styles.field,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: styles.label,
					children: t("detail.workspace")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
					style: styles.input,
					value,
					onChange: (event) => {
						onChange(event.target.value);
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value: "",
						children: t("detail.current")
					}), options.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value: option.workspaceId,
						children: option.title
					}, option.workspaceId))]
				})]
			});
		}
		//#endregion
		//#region src/client/PermissionPicker.tsx
		/**
		* Permission-preset picker shared by the new-task modal and the task detail
		* editor. The presets map to the official `/permission` command vocabulary
		* (read-only / workspace-write / danger-full-access). The unattended hint
		* steers scheduled/background runs to `danger-full-access` (approval: never),
		* which never blocks on an approval prompt nobody is there to answer.
		*/
		const PERMISSION_OPTIONS = [
			{
				value: "",
				label: "permission.none"
			},
			{
				value: "read-only",
				label: "permission.read-only"
			},
			{
				value: "workspace-write",
				label: "permission.workspace-write"
			},
			{
				value: "danger-full-access",
				label: "permission.danger-full-access"
			}
		];
		function PermissionPicker({ value, onChange }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: styles.field,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: styles.label,
						children: t("detail.permission")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
						style: styles.input,
						value,
						onChange: (event) => {
							onChange(event.target.value);
						},
						children: PERMISSION_OPTIONS.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: option.value,
							children: t(option.label)
						}, option.value))
					}),
					value === "danger-full-access" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: styles.rowDesc,
						children: t("permission.unattended")
					})
				]
			});
		}
		//#endregion
		//#region src/client/TaskDetail.tsx
		/**
		* Task detail panel: editable fields, run/rerun with execution history,
		* open-session jump, and scheduled-run integration with dsh-cron (the
		* schedule is a cron job with action {kind:'task', taskId}).
		*/
		function TaskDetail({ controller, task, cron, workspaces }) {
			const openSession = controller.openSession;
			const [editing, setEditing] = (0, react.useState)(false);
			const [title, setTitle] = (0, react.useState)(task.title);
			const [description, setDescription] = (0, react.useState)(task.description);
			const [prompt, setPrompt] = (0, react.useState)(task.prompt);
			const [workspaceId, setWorkspaceId] = (0, react.useState)(task.workspaceId ?? "");
			const [permission, setPermission] = (0, react.useState)(task.permission ?? "");
			const [cronJobs, setCronJobs] = (0, react.useState)(cron?.getSnapshot().jobs ?? []);
			(0, react.useEffect)(() => {
				if (cron === void 0) return;
				return cron.subscribe(() => setCronJobs(cron.getSnapshot().jobs));
			}, [cron]);
			const linkedJob = cronJobs.find((job) => job.action.kind === "task" && job.action.taskId === task.id);
			const save = () => {
				controller.update(task.id, {
					...title.trim() !== "" ? { title: title.trim() } : {},
					description,
					prompt,
					...workspaceId === "" ? {} : { workspaceId },
					...permission === "" ? {} : { permission }
				});
				setEditing(false);
			};
			const attachSchedule = () => {
				if (cron === void 0) return;
				if (linkedJob !== void 0) cron.registerJob({
					id: linkedJob.id,
					name: linkedJob.name,
					cron: linkedJob.cron,
					action: {
						kind: "task",
						taskId: task.id
					},
					enabled: !linkedJob.enabled
				});
				else cron.registerJob({
					id: `task-${task.id}`,
					name: task.title,
					cron: "0 9 * * *",
					action: {
						kind: "task",
						taskId: task.id
					},
					enabled: true
				});
			};
			const detachSchedule = () => {
				if (cron === void 0 || linkedJob === void 0) return;
				cron.unregisterJob(linkedJob.id);
			};
			const STATUS_OPTIONS = [
				"todo",
				"doing",
				"done",
				"failed"
			];
			const running = task.executions.some((execution) => execution.endedAt === void 0);
			const latest = task.executions[task.executions.length - 1];
			const history = [...task.executions].reverse();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: styles.detail,
				"data-dsh-part": "detail",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
					style: styles.detailHeader,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: styles.button,
							onClick: () => {
								controller.closeTask();
							},
							children: "‹"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							style: {
								...styles.title,
								margin: 0
							},
							children: t("detail.title")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: {
								...styles.button,
								...styles.buttonPrimary,
								...running ? styles.buttonDisabled : {}
							},
							disabled: running,
							onClick: () => {
								controller.run(task.id);
							},
							children: latest === void 0 ? t("detail.run") : t("detail.rerun")
						}),
						running && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: {
								...styles.button,
								...styles.buttonDanger
							},
							onClick: () => {
								if (window.confirm(t("detail.cancelConfirm"))) controller.cancel(task.id);
							},
							children: t("detail.cancel")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							style: styles.button,
							onClick: () => {
								setEditing(!editing);
							},
							children: editing ? "✓" : t("detail.edit")
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: styles.detailBody,
					children: [
						editing ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: styles.field,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles.label,
									children: t("new.name")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									style: styles.input,
									value: title,
									onChange: (event) => {
										setTitle(event.target.value);
									}
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: styles.field,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles.label,
									children: t("new.description")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									style: styles.input,
									value: description,
									onChange: (event) => {
										setDescription(event.target.value);
									}
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(WorkspacePicker, {
								workspaces,
								value: workspaceId,
								onChange: setWorkspaceId
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PermissionPicker, {
								value: permission,
								onChange: setPermission
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: styles.field,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles.label,
									children: t("new.prompt")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
									style: styles.input,
									rows: 4,
									value: prompt,
									onChange: (event) => {
										setPrompt(event.target.value);
									}
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: styles.editorActions,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: styles.button,
									onClick: () => {
										setEditing(false);
									},
									children: t("new.cancel")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: {
										...styles.button,
										...styles.buttonPrimary
									},
									onClick: save,
									children: t("new.save")
								})]
							})
						] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: styles.field,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles.label,
									children: t("new.name")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles.value,
									children: task.title
								})]
							}),
							task.description !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: styles.field,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles.label,
									children: t("new.description")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles.value,
									children: task.description
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: styles.field,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles.label,
									children: t("detail.prompt")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles.value,
									children: task.prompt
								})]
							}),
							task.workspaceId !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: styles.field,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles.label,
									children: t("detail.workspace")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles.value,
									children: task.workspaceId
								})]
							}),
							task.mode !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: styles.field,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles.label,
									children: t("detail.mode")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles.value,
									children: task.mode
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: styles.field,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles.label,
									children: t("detail.status")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: {
										display: "flex",
										gap: 6,
										flexWrap: "wrap"
									},
									children: STATUS_OPTIONS.map((status) => {
										const active = task.status === status;
										return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											style: {
												...styles.button,
												...active ? styles.buttonPrimary : {},
												...running && status !== task.status ? styles.buttonDisabled : {}
											},
											disabled: running && status !== task.status,
											title: t("detail.statusMove"),
											onClick: () => {
												if (!active) controller.move(task.id, status);
											},
											children: t(`board.column.${status}`)
										}, status);
									})
								})]
							})
						] }),
						cron !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.schedule,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: styles.label,
								children: t("detail.schedule")
							}), linkedJob === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("detail.schedule.disabled") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: styles.button,
								onClick: attachSchedule,
								children: t("detail.schedule.attach")
							})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
								t("detail.schedule.attached"),
								": ",
								linkedJob.cron,
								" · ",
								linkedJob.enabled ? t("detail.schedule.enabled") : t("detail.schedule.disabled")
							] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: {
									display: "flex",
									gap: 6
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: styles.button,
									onClick: attachSchedule,
									children: linkedJob.enabled ? t("detail.schedule.disabled") : t("detail.schedule.enabled")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: styles.button,
									onClick: detachSchedule,
									children: t("detail.delete")
								})]
							})] })]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.history,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles.label,
									children: t("detail.history")
								}),
								history.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: { opacity: .6 },
									children: t("detail.noHistory")
								}),
								history.map((execution) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ExecutionRow, {
									execution,
									...openSession === void 0 ? {} : { onOpenSession: openSession }
								}, execution.id))
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								gap: 6
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: styles.button,
								onClick: () => {
									controller.archive(task.id);
								},
								children: task.archivedAt === void 0 ? t("detail.archive") : t("detail.restore")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: {
									...styles.button,
									...running ? styles.buttonDisabled : {}
								},
								disabled: running,
								onClick: () => {
									if (!window.confirm(t("detail.deleteConfirm"))) return;
									detachSchedule();
									controller.remove(task.id);
								},
								children: t("detail.delete")
							})]
						})
					]
				})]
			});
		}
		function ExecutionRow({ execution, onOpenSession }) {
			const [open, setOpen] = (0, react.useState)(false);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: 4
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: styles.historyRow,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: { opacity: .7 },
								children: new Date(execution.startedAt).toLocaleString()
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ExecutionLabel, { execution }),
							execution.prompt !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: styles.button,
								onClick: () => {
									setOpen(!open);
								},
								title: t("detail.context"),
								children: open ? t("detail.contextHide") : t("detail.context")
							})
						]
					}),
					open && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							...styles.value,
							fontSize: 12,
							background: "var(--dsw-input, rgba(0,0,0,0.2))",
							borderRadius: 6,
							padding: "6px 8px",
							whiteSpace: "pre-wrap"
						},
						children: execution.prompt ?? t("detail.contextEmpty")
					}),
					execution.sessionId !== void 0 && onOpenSession !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						style: styles.button,
						onClick: () => {
							onOpenSession(execution.sessionId);
						},
						title: t("detail.openSession"),
						children: t("detail.openSession")
					})
				]
			});
		}
		function ExecutionLabel({ execution }) {
			if (execution.endedAt === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				style: styles.resultPending,
				children: t("detail.execution.pending")
			});
			switch (execution.result) {
				case "succeeded": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: styles.resultOk,
					children: t("detail.execution.succeeded")
				});
				case "failed": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: styles.resultFail,
					children: t("detail.execution.failed")
				});
				case "cancelled": return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: styles.resultCancel,
					children: t("detail.execution.cancelled")
				});
				default: return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "?" });
			}
		}
		//#endregion
		//#region src/client/NewTaskModal.tsx
		/**
		* New-task modal: title, description, project picker, and the execution
		* prompt.
		*/
		function NewTaskModal({ controller, workspaces, onClose }) {
			const [title, setTitle] = (0, react.useState)("");
			const [description, setDescription] = (0, react.useState)("");
			const [prompt, setPrompt] = (0, react.useState)("");
			const [workspaceId, setWorkspaceId] = (0, react.useState)("");
			const [permission, setPermission] = (0, react.useState)("");
			const [error, setError] = (0, react.useState)("");
			(0, react.useEffect)(() => {
				document.dispatchEvent(new CustomEvent("dsh-modal-open", { detail: "task-new" }));
				const onOtherModal = (event) => {
					if (event.detail !== "task-new") onClose();
				};
				document.addEventListener("dsh-modal-open", onOtherModal);
				return () => {
					document.removeEventListener("dsh-modal-open", onOtherModal);
				};
			}, [onClose]);
			(0, react.useEffect)(() => {
				const onKey = (event) => {
					if (event.key === "Escape") onClose();
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [onClose]);
			const save = () => {
				if (title.trim() === "") {
					setError(t("new.titleRequired"));
					return;
				}
				setError("");
				controller.create({
					title: title.trim(),
					description,
					prompt: prompt.trim() !== "" ? prompt.trim() : title.trim(),
					...workspaceId === "" ? {} : { workspaceId },
					...permission === "" ? {} : { permission }
				});
				onClose();
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: styles.overlay,
				role: "presentation",
				onMouseDown: (event) => {
					if (event.target === event.currentTarget) onClose();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: styles.editor,
					role: "dialog",
					"aria-label": t("new.title"),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.field,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles.label,
									children: t("new.name")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									style: styles.input,
									value: title,
									onChange: (event) => {
										setTitle(event.target.value);
										if (error !== "") setError("");
									},
									autoFocus: true
								}),
								error !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles.error,
									children: error
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: styles.label,
								children: t("new.description")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: styles.input,
								value: description,
								onChange: (event) => {
									setDescription(event.target.value);
								}
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(WorkspacePicker, {
							workspaces,
							value: workspaceId,
							onChange: setWorkspaceId
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PermissionPicker, {
							value: permission,
							onChange: setPermission
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: styles.label,
								children: t("new.prompt")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
								style: styles.input,
								rows: 4,
								value: prompt,
								onChange: (event) => {
									setPrompt(event.target.value);
								}
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.editorActions,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: styles.button,
								onClick: onClose,
								children: t("new.cancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: {
									...styles.button,
									...styles.buttonPrimary
								},
								onClick: save,
								children: t("new.save")
							})]
						})
					]
				})
			});
		}
		//#endregion
		//#region src/client/TaskBoard.tsx
		/**
		* Board view: the multi-column kanban that replaces the middle column while
		* active. Cards open the task detail; the header offers search, new-task,
		* archive view, and a back-to-chat escape. The `onClose` escape is supplied
		* by the main-area mount (absent in the better-sidebar tab).
		*/
		/** Case-insensitive title/description match. */
		function matchesFilter(task, filter) {
			if (filter.trim() === "") return true;
			const needle = filter.trim().toLowerCase();
			return task.title.toLowerCase().includes(needle) || task.description.toLowerCase().includes(needle);
		}
		const STATUS_DOT = {
			todo: "var(--dsw-warning, #d9a441)",
			doing: "var(--dsw-accent, #4d6bfe)",
			done: "var(--dsw-success, #4caf7d)",
			failed: "var(--dsw-danger, #e06666)"
		};
		function TaskBoard({ controller, onClose, workspaces }) {
			const [snapshot, setSnapshot] = (0, react.useState)(controller.getSnapshot());
			const [filter, setFilter] = (0, react.useState)("");
			const [showNew, setShowNew] = (0, react.useState)(false);
			(0, react.useEffect)(() => controller.subscribe(() => setSnapshot(controller.getSnapshot())), [controller]);
			const visible = (0, react.useMemo)(() => snapshot.tasks.filter((task) => matchesFilter(task, filter)), [snapshot.tasks, filter]);
			const selected = snapshot.selectedTaskId === void 0 ? void 0 : snapshot.tasks.find((task) => task.id === snapshot.selectedTaskId);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: styles.board,
				"data-dsh-plugin": "task",
				"data-dsh-task-board": "",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						style: styles.header,
						children: [
							onClose !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								style: styles.button,
								onClick: onClose,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									"aria-hidden": "true",
									children: "‹ "
								}), t("board.close")]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
								style: styles.title,
								children: t("board.title")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: styles.meta,
								children: t("board.hostMeta", { revision: String(snapshot.revision) })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: styles.search,
								type: "search",
								placeholder: t("board.search"),
								value: filter,
								onChange: (event) => {
									setFilter(event.target.value);
								},
								"aria-label": t("board.search")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: snapshot.archiveView ? {
									...styles.button,
									...styles.buttonPrimary
								} : styles.button,
								onClick: () => {
									controller.toggleArchiveView();
								},
								children: snapshot.archiveView ? t("board.backToBoard") : t("board.archiveView", { count: String(snapshot.tasks.filter((task) => task.archivedAt !== void 0).length) })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								style: {
									...styles.button,
									...styles.buttonPrimary
								},
								onClick: () => {
									setShowNew(true);
								},
								children: ["+ ", t("board.new")]
							})
						]
					}),
					snapshot.transportError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: styles.error,
						children: [
							t("board.hostError", { error: snapshot.transportError }),
							" ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: styles.button,
								onClick: () => {
									controller.retryHostSync();
								},
								children: t("board.retryHost")
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: styles.columns,
						children: snapshot.archiveView ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Column, {
							title: t("board.archive"),
							count: visible.filter((task) => task.archivedAt !== void 0).length,
							children: visible.filter((task) => task.archivedAt !== void 0).map((task) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskCard, {
								task,
								controller
							}, task.id))
						}) : COLUMNS.map((column) => {
							const tasks = visible.filter((task) => task.status === column.status && task.archivedAt === void 0);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Column, {
								title: t(column.labelKey),
								count: tasks.length,
								...STATUS_DOT[column.status] === void 0 ? {} : { dot: STATUS_DOT[column.status] },
								children: [tasks.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: styles.columnEmpty,
									children: t("board.empty")
								}), tasks.map((task) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskCard, {
									task,
									controller
								}, task.id))]
							}, column.status);
						})
					}),
					selected !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskDetail, {
						controller,
						task: selected,
						...workspaces === void 0 ? {} : { workspaces },
						...controller.cron?.() === void 0 ? {} : { cron: controller.cron?.() }
					}, selected.id),
					showNew && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(NewTaskModal, {
						controller,
						...workspaces === void 0 ? {} : { workspaces },
						onClose: () => {
							setShowNew(false);
						}
					})
				]
			});
		}
		function Column({ title, count, dot, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				style: styles.column,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
					style: styles.columnHeader,
					children: [
						dot !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: {
								...styles.statusDot,
								background: dot
							},
							"aria-hidden": "true"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
							style: styles.columnTitle,
							children: title
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: styles.columnCount,
							children: count
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: styles.cards,
					children
				})]
			});
		}
		function TaskCard({ task, controller }) {
			const latest = task.executions[task.executions.length - 1];
			const running = latest !== void 0 && latest.endedAt === void 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				style: styles.card,
				onClick: () => {
					controller.openTask(task.id);
				},
				"data-dsh-part": "card",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: styles.cardTitle,
						children: task.title
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: styles.cardDesc,
						children: task.description || task.prompt
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						style: styles.cardMeta,
						children: [running && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: styles.resultPending,
							children: t("detail.execution.pending")
						}), task.workspaceId !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["#", task.workspaceId.slice(0, 12)] })]
					})
				]
			});
		}
		//#endregion
		//#region src/client/TaskSettingsCard.tsx
		/**
		* Task plugin settings card (settings.plugin.item, key 'task'): a staged
		* form over the `task` settings namespace. The injected face is plain data
		* + callbacks, per the client discipline.
		*/
		var TaskSettingsCardController = class {
			scope;
			constructor(scope) {
				this.scope = scope;
			}
			getSnapshot() {
				return this.scope.getSnapshot();
			}
			subscribe(listener) {
				return this.scope.subscribe(listener);
			}
			set(field, value) {
				this.scope.set(field, value);
			}
			inject() {
				return {
					getSnapshot: () => this.getSnapshot(),
					subscribe: (listener) => this.subscribe(listener),
					set: (field, value) => this.set(field, value)
				};
			}
		};
		function ToggleRow({ label, desc, checked, onChange }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: styles.row,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: label }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: styles.rowDesc,
					children: desc
				})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
					style: styles.switch,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						type: "checkbox",
						checked,
						onChange: (event) => {
							onChange(event.target.checked);
						}
					})
				})]
			});
		}
		function TaskSettingsCard(props) {
			const { getSnapshot, subscribe, set } = props;
			const [snapshot, setSnapshot] = (0, react.useState)(() => getSnapshot());
			(0, react.useEffect)(() => subscribe(() => setSnapshot(getSnapshot())), [getSnapshot, subscribe]);
			const value = snapshot.status === "ready" ? snapshot.value ?? {} : {};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: styles.card,
				"data-dsh-plugin": "task",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleRow, {
					label: t("settings.enabled"),
					desc: t("settings.enabledDesc"),
					checked: value.enabled ?? true,
					onChange: (enabled) => {
						set("enabled", enabled);
					}
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleRow, {
					label: t("settings.announce"),
					desc: t("settings.announceDesc"),
					checked: value.announceToAgent ?? true,
					onChange: (announceToAgent) => {
						set("announceToAgent", announceToAgent);
					}
				})]
			});
		}
		//#endregion
		//#region src/client/TaskTrigger.tsx
		const TRIGGER_WIDE = {
			flex: "none",
			display: "flex",
			alignItems: "center",
			gap: 8,
			width: "calc(100% + 8px)",
			height: 34,
			margin: "4px -4px 4px",
			padding: "6px 2px 6px 10px",
			boxSizing: "border-box",
			border: "none",
			borderRadius: 12,
			background: "transparent",
			cursor: "pointer",
			overflow: "hidden",
			color: "var(--dsw-alias-label-primary)",
			fontFamily: "inherit",
			fontSize: 14,
			lineHeight: "22px"
		};
		const TRIGGER_RAIL = {
			...TRIGGER_WIDE,
			width: 36,
			height: 36,
			margin: "8px 0 10px",
			justifyContent: "center",
			gap: 0,
			padding: 0,
			borderRadius: "50%"
		};
		const LABEL = {
			overflow: "hidden",
			whiteSpace: "nowrap"
		};
		/** The main-area activation event shared by injected panels. */
		const ACTIVATE_EVENT$1 = "dsh-panel-activate";
		/** The html attribute this panel toggles. */
		const TASK_ACTIVE_ATTR = "data-dsh-task-active";
		/** Sibling panel attributes removed when this panel opens (cron, ssh). */
		const OTHER_ACTIVE_ATTRS = ["data-dsh-cron-active", "data-dsh-ssh-active"];
		function isTaskOpen() {
			return document.documentElement.hasAttribute(TASK_ACTIVE_ATTR);
		}
		/**
		* Sidebar foot trigger for the task board.
		* @param props - sidebar column state from the foot slot owner.
		*/
		function TaskTrigger(props) {
			const open = () => {
				if (isTaskOpen()) return;
				for (const attribute of OTHER_ACTIVE_ATTRS) document.documentElement.removeAttribute(attribute);
				document.documentElement.setAttribute(TASK_ACTIVE_ATTR, "");
				document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT$1, { detail: "task" }));
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				"aria-label": t("entry.label"),
				onClick: open,
				style: props.wide ? TRIGGER_WIDE : TRIGGER_RAIL,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
					width: props.wide ? 16 : 18,
					height: props.wide ? 16 : 18,
					viewBox: "0 0 16 16",
					fill: "none",
					"aria-hidden": "true",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
						x: "2",
						y: "2.5",
						width: "12",
						height: "11",
						rx: "1.5",
						stroke: "currentColor",
						strokeWidth: "1.3"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M2 6.5h12M6.5 6.5v7",
						stroke: "currentColor",
						strokeWidth: "1.3"
					})]
				}), props.wide && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: LABEL,
					children: t("entry.label")
				})]
			});
		}
		//#endregion
		//#region src/client/board-mount.tsx
		/**
		* Main-area mounting for the task board.
		*
		* The `conversation` slot is single-occupant (ui-conversation) and external
		* plugins cannot declare slots, so the board takes over the center column at
		* the DOM level — the same pattern as upstream dsh-task-board: a container is
		* appended inside the center column (`[class*="centerCol"]`, legacy
		* `[data-pane="conversation"]`) as a trailing child React never manages.
		*
		* Visibility is driven by a global stylesheet rule scoped to the html
		* activation attribute — no JS display toggling. While the board is active,
		* the conversation content underneath is hidden (it stays mounted and
		* stateful); the `!important` is required because the dsh shell wraps the
		* conversation view in a node with an inline `display: contents`.
		*/
		const CONVERSATION_COLUMN_SELECTOR = "[data-pane=\"conversation\"], [class*=\"centerCol\"], [class*=\"ConversationSurface\"], [class*=\"dshDesktopConversationSurface\"]";
		/** Cross-plugin activation event; detail is the activating panel name. */
		const ACTIVATE_EVENT = "dsh-panel-activate";
		const PANEL_NAME = "task";
		const SIDEBAR_ROW_SELECTOR = "[class*=\"sessionRow\"], [class*=\"projectRow\"], [class*=\"searchResultRow\"], [class*=\"searchResultWorkspace\"], [class*=\"newSession\"]";
		/** Close the task board (used by sibling panels, navigation, and the board header). */
		function closeTaskBoard() {
			document.documentElement.removeAttribute(TASK_ACTIVE_ATTR);
		}
		/** Global visibility rules (injected once per plugin activation). */
		function visibilityStyle() {
			const style = document.createElement("style");
			style.dataset.dshTaskVisibility = "";
			style.textContent = [
				`[data-dsh-task-view] {`,
				`  display: none;`,
				`  height: 100%;`,
				`  width: 100%;`,
				`}`,
				`html[${TASK_ACTIVE_ATTR}] [data-pane='conversation'] > :not([data-dsh-task-view]),`,
				`html[${TASK_ACTIVE_ATTR}] [class*='centerCol'] > :not([data-dsh-task-view]) {`,
				`  display: none !important;`,
				`}`,
				`html[${TASK_ACTIVE_ATTR}] [data-dsh-task-view] {`,
				`  display: block;`,
				`}`
			].join("\n");
			return style;
		}
		/**
		* Mount the board React tree into the center column and bind its visibility
		* to the html activation attribute.
		* @returns disposer unmounting the tree and restoring the column.
		*/
		function mountTaskBoard(controller, workspaces) {
			let root;
			let container;
			const style = visibilityStyle();
			document.head.appendChild(style);
			const ensure = () => {
				if (container !== void 0) return;
				const column = document.querySelector(CONVERSATION_COLUMN_SELECTOR);
				if (column === null) return;
				container = document.createElement("div");
				container.dataset.dshTaskView = "";
				container.dataset.dshPlugin = "task";
				column.appendChild(container);
				root = (0, react_dom_client.createRoot)(container);
				root.render((0, react.createElement)(TaskBoard, {
					controller,
					onClose: closeTaskBoard,
					...workspaces === void 0 ? {} : { workspaces }
				}));
			};
			const waitObserver = new MutationObserver(() => {
				ensure();
			});
			waitObserver.observe(document.body, {
				childList: true,
				subtree: true
			});
			const onOtherActivate = (event) => {
				if (event.detail !== PANEL_NAME) closeTaskBoard();
			};
			const onClickSidebarRow = (event) => {
				if (!document.documentElement.hasAttribute("data-dsh-task-active")) return;
				const target = event.target;
				if (target === null) return;
				if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) closeTaskBoard();
			};
			document.addEventListener("click", onClickSidebarRow, true);
			document.addEventListener(ACTIVATE_EVENT, onOtherActivate);
			ensure();
			return () => {
				document.removeEventListener("click", onClickSidebarRow, true);
				document.removeEventListener(ACTIVATE_EVENT, onOtherActivate);
				waitObserver.disconnect();
				closeTaskBoard();
				root?.unmount();
				root = void 0;
				container?.remove();
				container = void 0;
				style.remove();
			};
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* Task plugin client half: registers the sidebar foot entry, the settings
		* card (settings.plugin.item keyed 'task'), the main-area board mount, and
		* the better-sidebar board tab. The cron service is optional: when present,
		* task details gain the scheduled-run section.
		*
		* Client discipline: value imports limited to the platform module table;
		* @deepseek-ai/* and sibling packages enter type-only. Cross-plugin
		* collaboration goes through cordis services and slots only.
		*/
		const inject = [
			"slots",
			"settingsScope",
			"locale",
			"workspaces",
			"sessions"
		];
		/** Settings namespace this card edits (the Host half registers it). */
		const TASK_NS = "task";
		/** Locale namespace this plugin owns. */
		const LOCALE_NS = "task";
		function apply(ctx) {
			ctx.effect(() => {
				const offZh = ctx.locale.register(LOCALE_NS, {
					zh,
					en
				});
				return () => {
					offZh();
				};
			}, "dsh-task: dictionaries");
			const settingsScope = ctx.get("settingsScope");
			if (settingsScope !== void 0) {
				const card = new TaskSettingsCardController(settingsScope.bind({ namespace: TASK_NS }));
				ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
					name: "settings.plugin.item",
					key: TASK_NS,
					locale: LOCALE_NS,
					inject: () => card.inject()
				}, TaskSettingsCard));
			}
			const cron = ctx.get("picoCronService");
			const sessions = ctx.get("sessions");
			const workspacesService = ctx.get("workspaces");
			const controller = new TaskController({ transport: new HttpTaskTransport() });
			if (sessions !== void 0) controller.openSession = (id) => sessions.open(id);
			ctx.effect(() => {
				controller.start();
				return () => controller.dispose();
			}, "controller lifecycle");
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "pico-task",
				order: -5
			}, TaskTrigger));
			ctx.effect(() => mountTaskBoard(controller, workspacesService), "dsh-task: main-area board");
			ctx.inject(["betterSidebar"], (childCtx) => {
				const service = childCtx.get("betterSidebar");
				if (service === void 0) return;
				const disposeTab = service.registerTab({
					id: "pico:task-board",
					title: () => zh["entry.label"],
					order: 20,
					component: () => (0, react.createElement)(TaskBoard, {
						controller,
						...workspacesService === void 0 ? {} : { workspaces: workspacesService }
					})
				});
				childCtx.effect(() => () => {
					disposeTab();
				}, "dsh-task: better-sidebar board tab");
			});
			const cronRef = { current: cron };
			ctx.inject(["picoCronService"], (childCtx) => {
				cronRef.current = childCtx.get("picoCronService");
				childCtx.effect(() => () => {
					cronRef.current = void 0;
				}, "dsh-task: cron face");
			});
			controller.cron = () => cronRef.current;
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map