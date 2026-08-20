window.__ModuleLoader__.load({
	id: "@picoaide/dsh-cron",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let react_dom_client = require("react-dom/client");
		//#region src/client/controller.ts
		var CronController = class {
			snapshot;
			listeners = /* @__PURE__ */ new Set();
			transport;
			refetchDebounceMs;
			uuid;
			started = false;
			disposed = false;
			refetchTimer;
			unsubscribeTransport;
			constructor(deps) {
				this.transport = deps.transport;
				this.refetchDebounceMs = deps.refetchDebounceMs ?? 250;
				this.uuid = deps.uuid ?? (() => crypto.randomUUID());
				this.snapshot = {
					jobs: [],
					scheduler: { timeZone: "local" },
					revision: 0,
					pendingJobIds: []
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
			update(jobId, patch) {
				this.submit({
					kind: "update",
					jobId,
					patch
				});
			}
			remove(jobId) {
				this.submit({
					kind: "delete",
					jobId
				});
			}
			enable(jobId) {
				this.submit({
					kind: "enable",
					jobId
				});
			}
			disable(jobId) {
				this.submit({
					kind: "disable",
					jobId
				});
			}
			run(jobId) {
				this.submit({
					kind: "run",
					jobId
				});
			}
			rerun(jobId) {
				this.submit({
					kind: "rerun",
					jobId
				});
			}
			/** Re-pull the full snapshot now (used after reconnect/visibility). */
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
				const jobId = "jobId" in action ? action.jobId : void 0;
				this.markPending(jobId, true);
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
					this.markPending(jobId, false);
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
					jobs: snapshot.jobs,
					scheduler: snapshot.scheduler,
					revision: snapshot.revision,
					pendingJobIds: rest.pendingJobIds
				};
				this.notify();
			}
			markPending(jobId, pending) {
				if (jobId === void 0) return;
				const set = new Set(this.snapshot.pendingJobIds);
				if (pending) set.add(jobId);
				else set.delete(jobId);
				this.snapshot = {
					...this.snapshot,
					pendingJobIds: [...set]
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
			if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.jobs)) throw new Error("unexpected schema");
			return snapshot;
		}
		var HttpCronTransport = class {
			async bootstrap() {
				return this.state();
			}
			async state() {
				const response = await fetch("/api/cron/state", { headers: { accept: "application/json" } });
				if (!response.ok) throw new Error(`cron state failed: ${response.status}`);
				return parseSnapshot(await response.json());
			}
			async action(action) {
				const response = await fetch("/api/cron/action", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						requestId: crypto.randomUUID(),
						action
					})
				});
				if (!response.ok) throw new Error(`cron action failed: ${response.status}`);
				return parseSnapshot(await response.json());
			}
			subscribe(listener) {
				let closed = false;
				let source;
				try {
					source = new EventSource("/api/cron/events");
					source.onmessage = (message) => {
						if (closed) return;
						try {
							listener(JSON.parse(message.data));
						} catch {}
					};
					source.onerror = () => {
						listener(void 0);
					};
				} catch {
					listener(void 0);
				}
				return () => {
					closed = true;
					source?.close();
				};
			}
		};
		//#endregion
		//#region src/client/browser-service.ts
		/** Browser-side implementation of the cron service over the same-origin API. */
		var HttpBrowserCronService = class {
			snapshot = {
				schemaVersion: 1,
				revision: 0,
				jobs: [],
				scheduler: { timeZone: "local" }
			};
			listeners = /* @__PURE__ */ new Set();
			transport;
			started = false;
			disposed = false;
			unsubscribeTransport;
			constructor(transport) {
				this.transport = transport;
			}
			start() {
				if (this.started || this.disposed) return;
				this.started = true;
				this.unsubscribeTransport = this.transport.subscribe(() => {
					this.refresh();
				});
				this.refresh();
			}
			registerJob(registration) {
				if (this.snapshot.jobs.find((job) => job.id === registration.id) !== void 0) {
					this.submit({
						kind: "update",
						jobId: registration.id,
						patch: {
							...registration.name === void 0 ? {} : { name: registration.name },
							...registration.cron === void 0 ? {} : { cron: registration.cron },
							...registration.enabled === void 0 ? {} : { enabled: registration.enabled }
						}
					});
					return;
				}
				this.submit({
					kind: "create",
					id: registration.id,
					input: {
						name: registration.name,
						cron: registration.cron,
						action: registration.action,
						...registration.enabled === void 0 ? {} : { enabled: registration.enabled }
					}
				});
			}
			unregisterJob(id) {
				this.submit({
					kind: "delete",
					jobId: id
				});
			}
			listJobs() {
				return this.snapshot.jobs;
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
			dispose() {
				if (this.disposed) return;
				this.disposed = true;
				this.unsubscribeTransport?.();
				this.listeners.clear();
			}
			async submit(action) {
				if (this.disposed) return;
				try {
					this.snapshot = await this.transport.action(action);
					this.notify();
				} catch (error) {
					console.error("[dsh-cron] browser service action failed", error);
				}
			}
			async refresh() {
				if (this.disposed) return;
				try {
					const snapshot = await this.transport.state();
					if (snapshot.revision < this.snapshot.revision) return;
					this.snapshot = snapshot;
					this.notify();
				} catch (error) {
					console.error("[dsh-cron] browser service state refresh failed", error);
				}
			}
			notify() {
				for (const listener of [...this.listeners]) listener();
			}
		};
		//#endregion
		//#region src/client/styles.ts
		const styles = {
			cron: {
				display: "flex",
				flexDirection: "column",
				height: "100%",
				minWidth: 280,
				fontSize: 13,
				color: "var(--dsw-alias-label-primary)",
				background: "transparent"
			},
			header: {
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "10px 12px",
				borderBottom: "1px solid var(--dsw-alias-border-l2)"
			},
			title: {
				flex: 1,
				margin: 0,
				fontSize: 13,
				fontWeight: 600
			},
			meta: {
				fontSize: 11,
				opacity: .65,
				whiteSpace: "nowrap"
			},
			list: {
				flex: 1,
				overflowY: "auto",
				padding: 8,
				display: "flex",
				flexDirection: "column",
				gap: 8
			},
			empty: {
				padding: "24px 12px",
				textAlign: "center",
				opacity: .6
			},
			job: {
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: 8,
				padding: "8px 10px",
				background: "var(--dsw-alias-bg-layer-2)"
			},
			jobRow: {
				display: "flex",
				alignItems: "center",
				gap: 8
			},
			jobName: {
				flex: 1,
				fontWeight: 600,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			},
			jobCron: {
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
				fontSize: 11,
				opacity: .8
			},
			jobNext: {
				fontSize: 11,
				opacity: .65
			},
			actions: {
				display: "flex",
				gap: 4,
				alignItems: "center"
			},
			button: {
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: 6,
				background: "transparent",
				color: "inherit",
				fontSize: 12,
				padding: "3px 8px",
				cursor: "pointer",
				fontFamily: "inherit"
			},
			buttonHover: {},
			buttonDisabled: {
				opacity: .45,
				cursor: "default"
			},
			buttonPrimary: {
				borderColor: "var(--dsw-alias-state-business-primary)",
				color: "var(--dsw-alias-state-business-primary)"
			},
			switch: {
				display: "inline-flex",
				alignItems: "center",
				gap: 6,
				fontSize: 12,
				cursor: "pointer"
			},
			history: {
				marginTop: 6,
				paddingTop: 6,
				borderTop: "1px dashed var(--dsw-alias-border-l1)",
				fontSize: 11,
				opacity: .75
			},
			historyRow: {
				display: "flex",
				gap: 8,
				padding: "1px 0"
			},
			historyTime: { opacity: .7 },
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
				width: "min(480px, 92vw)",
				maxHeight: "86vh",
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
			field: {
				display: "flex",
				flexDirection: "column",
				gap: 4
			},
			label: {
				fontSize: 12,
				opacity: .8
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
			presets: {
				display: "flex",
				flexWrap: "wrap",
				gap: 6
			},
			preset: {
				fontSize: 11,
				padding: "2px 8px",
				borderRadius: 999,
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "transparent",
				color: "inherit",
				cursor: "pointer",
				fontFamily: "inherit"
			},
			error: {
				color: "var(--dsw-alias-state-error-primary)",
				fontSize: 12
			},
			editorActions: {
				display: "flex",
				justifyContent: "flex-end",
				gap: 8,
				marginTop: 4
			},
			card: {
				display: "flex",
				flexDirection: "column",
				gap: 10,
				fontSize: 13
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
			}
		};
		//#endregion
		//#region src/cron.ts
		/** Inclusive ranges per field, in cron order. */
		const FIELD_RANGES = [
			[0, 59],
			[0, 23],
			[1, 31],
			[1, 12],
			[0, 7]
		];
		/**
		* Parse a 5-field cron expression.
		* @returns the match sets, or null when the expression is invalid.
		*/
		function parseCron(expr) {
			const fields = expr.trim().split(/\s+/);
			if (fields.length !== 5) return null;
			const sets = [];
			for (let index = 0; index < 5; index++) {
				const [min, max] = FIELD_RANGES[index];
				const set = /* @__PURE__ */ new Set();
				if (!parseField(fields[index], min, max, set)) return null;
				sets.push(set);
			}
			const weekdays = /* @__PURE__ */ new Set();
			for (const day of sets[4]) weekdays.add(day === 7 ? 0 : day);
			return {
				minutes: sets[0],
				hours: sets[1],
				days: sets[2],
				months: sets[3],
				weekdays,
				dayWildcard: fields[2] === "*",
				weekdayWildcard: fields[4] === "*"
			};
		}
		/** Whether the expression parses. */
		function isValidCron(expr) {
			return parseCron(expr) !== null;
		}
		/**
		* Compute the next matching instant after `fromMs` (ms epoch), in local time,
		* at minute granularity, strictly greater than `fromMs`. Returns the ms epoch
		* of the matching minute's start, or undefined when the calendar constraint
		* can never match (for example `0 0 30 2 *`). The five-year horizon includes
		* a full leap cycle, so a valid February 29 schedule remains reachable from
		* every non-leap year.
		*
		* Walks candidate year/month/day/hour/minute values straight from the parsed
		* field sets instead of scanning every minute. Wall-clock field construction
		* + the final `matches` re-check preserve standard DST semantics: nonexistent
		* spring minutes normalize forward and the repeated fall-back hour is never
		* visited twice.
		*/
		function nextRunAtMs(expr, fromMs) {
			const schedule = parseCron(expr);
			if (schedule === null) return void 0;
			if (!hasPossibleCalendarDay(schedule)) return void 0;
			const from = new Date(fromMs);
			const limitMs = fromMs + 5 * 366 * 24 * 60 * 60 * 1e3;
			const sortedMinutes = [...schedule.minutes].sort((a, b) => a - b);
			const sortedHours = [...schedule.hours].sort((a, b) => a - b);
			const sortedMonths = [...schedule.months].sort((a, b) => a - b);
			let year = from.getFullYear();
			let month = from.getMonth() + 1;
			let day = from.getDate();
			let hour = from.getHours();
			let minute = from.getMinutes() + 1;
			while (new Date(year, month - 1, 1, 0, 0, 0, 0).getTime() <= limitMs) {
				for (const candidateMonth of sortedMonths) {
					if (candidateMonth < month) continue;
					const daysInMonth = new Date(year, candidateMonth, 0).getDate();
					const dayStart = candidateMonth === month ? day : 1;
					for (let candidateDay = dayStart; candidateDay <= daysInMonth; candidateDay += 1) {
						if (!dayCandidate(schedule, new Date(year, candidateMonth - 1, candidateDay, 0, 0, 0, 0))) continue;
						const hourStart = candidateMonth === month && candidateDay === day ? hour : 0;
						for (const candidateHour of sortedHours) {
							if (candidateHour < hourStart) continue;
							const minuteStart = candidateMonth === month && candidateDay === day && candidateHour === hour ? minute : 0;
							for (const candidateMinute of sortedMinutes) {
								if (candidateMinute < minuteStart) continue;
								const candidate = new Date(year, candidateMonth - 1, candidateDay, candidateHour, candidateMinute, 0, 0);
								const time = candidate.getTime();
								if (time <= fromMs) continue;
								if (time > limitMs) return void 0;
								if (matches(schedule, candidate)) return time;
							}
						}
					}
				}
				year += 1;
				month = 1;
				day = 1;
				hour = 0;
				minute = 0;
			}
		}
		/** Day/weekday OR gate shared by {@link matches} and the candidate scan. */
		function dayCandidate(schedule, date) {
			const dayMatches = schedule.days.has(date.getDate());
			const weekdayMatches = schedule.weekdays.has(date.getDay());
			if (schedule.dayWildcard) return weekdayMatches;
			if (schedule.weekdayWildcard) return dayMatches;
			return dayMatches || weekdayMatches;
		}
		/** Reject impossible month/day pairs without spending the multi-year scan. */
		function hasPossibleCalendarDay(schedule) {
			if (schedule.dayWildcard || !schedule.weekdayWildcard) return true;
			const maximumDay = /* @__PURE__ */ new Map([
				[1, 31],
				[2, 29],
				[3, 31],
				[4, 30],
				[5, 31],
				[6, 30],
				[7, 31],
				[8, 31],
				[9, 30],
				[10, 31],
				[11, 30],
				[12, 31]
			]);
			for (const month of schedule.months) {
				const maximum = maximumDay.get(month) ?? 0;
				if ([...schedule.days].some((day) => day <= maximum)) return true;
			}
			return false;
		}
		/** Parse one comma-list field into the match set. */
		function parseField(field, min, max, out) {
			if (field === "*") {
				for (let value = min; value <= max; value++) out.add(value);
				return true;
			}
			for (const part of field.split(",")) {
				if (part === "") return false;
				const [rangeRaw, stepRaw] = part.split("/");
				const range = rangeRaw ?? "";
				let low;
				let high;
				if (range === "*") {
					low = min;
					high = max;
				} else if (range.includes("-")) {
					const [a, b] = range.split("-");
					if (a === void 0 || b === void 0 || a === "" || b === "" || !isDigits(a) || !isDigits(b)) return false;
					low = Number(a);
					high = Number(b);
				} else if (isDigits(range)) {
					low = Number(range);
					high = Number(range);
				} else return false;
				if (low < min || high > max || low > high) return false;
				const step = stepRaw === void 0 ? 1 : isDigits(stepRaw) ? Number(stepRaw) : NaN;
				if (!Number.isInteger(step) || step < 1) return false;
				for (let value = low; value <= high; value += step) out.add(value);
			}
			return true;
		}
		/** Day/weekday OR semantics: a restricted day field alone gates, and vice versa. */
		function matches(schedule, date) {
			if (!schedule.minutes.has(date.getMinutes())) return false;
			if (!schedule.hours.has(date.getHours())) return false;
			if (!schedule.months.has(date.getMonth() + 1)) return false;
			return dayCandidate(schedule, date);
		}
		function isDigits(value) {
			return /^\d+$/.test(value);
		}
		//#endregion
		//#region src/jobs.ts
		function isCronJobAction(value) {
			if (typeof value !== "object" || value === null) return false;
			const action = value;
			const keys = Object.keys(action);
			if (action.kind === "task") {
				if (keys.length !== 2 || !keys.includes("kind") || !keys.includes("taskId")) return false;
				return typeof action.taskId === "string" && action.taskId !== "";
			}
			if (action.kind === "prompt") {
				if (keys.length !== 3 || !keys.includes("kind") || !keys.includes("sessionId") || !keys.includes("text")) return false;
				return typeof action.sessionId === "string" && action.sessionId !== "" && typeof action.text === "string" && action.text !== "";
			}
			return false;
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* Cron plugin UI copy: zh is the key source, en mirrors the full key set.
		*/
		const zh = {
			"settings.title": "定时任务",
			"settings.enabled": "启用定时任务",
			"settings.enabledDesc": "关闭后调度器停止触发，已配置的任务保留。",
			"settings.announce": "向 Agent 公告插件能力",
			"settings.announceDesc": "在系统提示词中声明定时任务能力，模型可据此协作。",
			"settings.catchUp": "补跑错过的触发",
			"settings.catchUpDesc": "应用重启或系统休眠恢复后，为每个到期任务补跑最近一次错过的触发（默认跳过）。",
			"settings.hostMeta": "Host 时区 {timeZone} · 修订 {revision}",
			"job.listTitle": "定时任务",
			"job.empty": "暂无定时任务",
			"job.new": "新建任务",
			"job.name": "名称",
			"job.cron": "Cron 表达式",
			"job.cronInvalid": "cron 表达式无效",
			"job.enabled": "启用",
			"job.disabled": "已停用",
			"job.nextRun": "下次运行",
			"job.notScheduled": "未调度",
			"job.lastTriggered": "上次触发",
			"job.never": "从未",
			"job.delete": "删除",
			"job.run": "立即执行",
			"job.actionTask": "执行任务",
			"job.actionPrompt": "发送消息",
			"job.workspace": "项目",
			"job.workspaceCurrent": "当前项目（默认）",
			"job.taskId": "任务",
			"job.taskSelect": "选择任务…",
			"job.nameRequired": "请填写任务名称",
			"job.taskIdRequired": "请选择要执行的任务",
			"job.sessionIdRequired": "请填写会话 ID",
			"job.promptTextRequired": "请填写消息内容",
			"job.sessionId": "会话 ID",
			"job.promptText": "消息内容",
			"job.save": "保存",
			"job.cancel": "取消",
			"job.history": "触发历史",
			"job.deleteConfirm": "确定删除该定时任务吗？",
			"job.showHistory": "展开触发历史",
			"job.hideHistory": "收起触发历史",
			"job.execution.succeeded": "成功",
			"job.execution.failed": "失败",
			"job.execution.cancelled": "已取消",
			"job.execution.pending": "执行中",
			"preset.daily9": "每天 09:00",
			"preset.hourly": "每小时",
			"preset.tenMin": "每 10 分钟",
			"preset.weeklyMon9": "每周一 09:00",
			"board.close": "返回聊天"
		};
		const en = {
			"settings.title": "Scheduled jobs",
			"settings.enabled": "Enable scheduled jobs",
			"settings.enabledDesc": "Disabling stops the scheduler; configured jobs are kept.",
			"settings.announce": "Announce to agents",
			"settings.announceDesc": "Declares the scheduler capability in the system prompt so models can collaborate.",
			"settings.catchUp": "Catch up missed triggers",
			"settings.catchUpDesc": "After a restart or resume, fire the single most recent missed trigger per due job (default: skip).",
			"settings.hostMeta": "Host timezone {timeZone} · revision {revision}",
			"job.listTitle": "Scheduled jobs",
			"job.empty": "No scheduled jobs",
			"job.new": "New job",
			"job.name": "Name",
			"job.cron": "Cron expression",
			"job.cronInvalid": "Invalid cron expression",
			"job.enabled": "Enabled",
			"job.disabled": "Disabled",
			"job.nextRun": "Next run",
			"job.notScheduled": "Not scheduled",
			"job.lastTriggered": "Last triggered",
			"job.never": "Never",
			"job.delete": "Delete",
			"job.run": "Run now",
			"job.actionTask": "Run a task",
			"job.actionPrompt": "Send a message",
			"job.workspace": "Project",
			"job.workspaceCurrent": "Current project (default)",
			"job.taskId": "Task",
			"job.taskSelect": "Select a task…",
			"job.sessionId": "Session ID",
			"job.promptText": "Message text",
			"job.save": "Save",
			"job.cancel": "Cancel",
			"job.history": "Trigger history",
			"job.nameRequired": "Please enter a name",
			"job.taskIdRequired": "Please select a task to run",
			"job.sessionIdRequired": "Please enter a session ID",
			"job.promptTextRequired": "Please enter the message",
			"job.deleteConfirm": "Delete this scheduled job?",
			"job.showHistory": "Expand trigger history",
			"job.hideHistory": "Collapse trigger history",
			"job.execution.succeeded": "Succeeded",
			"job.execution.failed": "Failed",
			"job.execution.cancelled": "Cancelled",
			"job.execution.pending": "Running",
			"preset.daily9": "Daily 09:00",
			"preset.hourly": "Hourly",
			"preset.tenMin": "Every 10 minutes",
			"preset.weeklyMon9": "Monday 09:00",
			"board.close": "Back to chat"
		};
		/** Translate a key with optional {name} params. */
		function t(key, params) {
			let text = zh[key] ?? key;
			if (params !== void 0) for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, value);
			return text;
		}
		//#endregion
		//#region src/client/workspace-select.ts
		/**
		* Project (workspace) options for the cron job editor. Reads the client
		* workspaces feed (the same list the shell sidebar shows) — implemented
		* locally because cross-package client imports are forbidden; the sibling
		* dsh-task plugin owns its own copy.
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
		//#endregion
		//#region src/client/JobEditor.tsx
		/**
		* Job editor dialog: name, cron expression (with presets + live validation),
		* project (workspace) picker, and the action (run a dsh-task task, or send a
		* message to a session). Task actions select the target task from the chosen
		* project's board (fetched through the dsh-task loopback API); prompt actions
		* name a session id directly.
		*/
		const PRESETS = [
			{
				cron: "0 9 * * *",
				key: "preset.daily9"
			},
			{
				cron: "0 * * * *",
				key: "preset.hourly"
			},
			{
				cron: "*/10 * * * *",
				key: "preset.tenMin"
			},
			{
				cron: "0 9 * * 1",
				key: "preset.weeklyMon9"
			}
		];
		/** Fetch the dsh-task board tasks through its loopback API (soft dependency). */
		async function fetchTaskOptions() {
			try {
				const response = await fetch("/api/task/state", { headers: { accept: "application/json" } });
				if (!response.ok) return [];
				return ((await response.json()).tasks ?? []).map((task) => ({
					id: task.id,
					title: task.title,
					...task.workspaceId !== void 0 ? { workspaceId: task.workspaceId } : {}
				}));
			} catch {
				return [];
			}
		}
		function JobEditor({ controller, job, workspaces, onClose }) {
			const [name, setName] = (0, react.useState)(job?.name ?? "");
			const [cron, setCron] = (0, react.useState)(job?.cron ?? "0 9 * * *");
			const [actionKind, setActionKind] = (0, react.useState)(job?.action.kind ?? "task");
			const [taskId, setTaskId] = (0, react.useState)(job?.action.kind === "task" ? job.action.taskId : "");
			const [sessionId, setSessionId] = (0, react.useState)(job?.action.kind === "prompt" ? job.action.sessionId : "");
			const [text, setText] = (0, react.useState)(job?.action.kind === "prompt" ? job.action.text : "");
			const [error, setError] = (0, react.useState)();
			const workspaceOptions = useWorkspaceOptions(workspaces);
			const [workspaceId, setWorkspaceId] = (0, react.useState)("");
			const [taskOptions, setTaskOptions] = (0, react.useState)([]);
			(0, react.useEffect)(() => {
				if (actionKind !== "task") return;
				let alive = true;
				fetchTaskOptions().then((options) => {
					if (!alive) return;
					setTaskOptions(options);
				});
				return () => {
					alive = false;
				};
			}, [actionKind, workspaceId]);
			const cronValid = isValidCron(cron);
			const nextRun = cronValid ? nextRunAtMs(cron, Date.now()) : void 0;
			const visibleTasks = workspaceId === "" ? taskOptions.filter((task) => task.workspaceId === void 0) : taskOptions.filter((task) => task.workspaceId === workspaceId);
			const save = () => {
				if (!cronValid) {
					setError(t("job.cronInvalid"));
					return;
				}
				if (name.trim() === "") {
					setError(t("job.nameRequired"));
					return;
				}
				const action = actionKind === "task" ? {
					kind: "task",
					taskId: taskId.trim()
				} : {
					kind: "prompt",
					sessionId: sessionId.trim(),
					text
				};
				if (!isCronJobAction(action)) {
					if (actionKind === "task") setError(t("job.taskIdRequired"));
					else if (sessionId.trim() === "") setError(t("job.sessionIdRequired"));
					else setError(t("job.promptTextRequired"));
					return;
				}
				if (job === void 0) {
					const input = {
						name: name.trim(),
						cron: cron.trim(),
						action,
						enabled: true
					};
					controller.create(input);
				} else {
					controller.update(job.id, {
						name: name.trim(),
						cron: cron.trim()
					});
					if (!job.enabled) controller.enable(job.id);
				}
				onClose();
			};
			(0, react.useEffect)(() => {
				const onKey = (event) => {
					if (event.key === "Escape") onClose();
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [onClose]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: styles.overlay,
				role: "presentation",
				onMouseDown: (event) => {
					if (event.target === event.currentTarget) onClose();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: styles.editor,
					role: "dialog",
					"aria-label": t("job.new"),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: styles.label,
								children: t("job.name")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: styles.input,
								value: name,
								onChange: (event) => {
									setName(event.target.value);
								}
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.field,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: styles.label,
									children: t("job.cron")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									style: styles.input,
									value: cron,
									onChange: (event) => {
										setCron(event.target.value);
									},
									spellCheck: false
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									style: styles.presets,
									children: PRESETS.map((preset) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										style: styles.preset,
										onClick: () => {
											setCron(preset.cron);
										},
										children: t(preset.key)
									}, preset.key))
								}),
								cronValid && nextRun !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: styles.jobNext,
									children: [
										t("job.nextRun"),
										": ",
										new Date(nextRun).toLocaleString()
									]
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: styles.label,
								children: t("job.workspace")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								style: styles.input,
								value: workspaceId,
								onChange: (event) => {
									setWorkspaceId(event.target.value);
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: t("job.workspaceCurrent")
								}), workspaceOptions.map((option) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: option.workspaceId,
									children: option.title
								}, option.workspaceId))]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								style: styles.label,
								children: [
									t("job.actionTask"),
									" / ",
									t("job.actionPrompt")
								]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								style: styles.input,
								value: actionKind,
								onChange: (event) => {
									setActionKind(event.target.value);
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "task",
									children: t("job.actionTask")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "prompt",
									children: t("job.actionPrompt")
								})]
							})]
						}),
						actionKind === "task" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: styles.label,
								children: t("job.taskId")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								style: styles.input,
								value: taskId,
								onChange: (event) => {
									setTaskId(event.target.value);
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: t("job.taskSelect")
								}), visibleTasks.map((task) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: task.id,
									children: task.title || task.id
								}, task.id))]
							})]
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: styles.label,
								children: t("job.sessionId")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: styles.input,
								value: sessionId,
								onChange: (event) => {
									setSessionId(event.target.value);
								},
								placeholder: "session-…"
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.field,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: styles.label,
								children: t("job.promptText")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
								style: styles.input,
								rows: 3,
								value: text,
								onChange: (event) => {
									setText(event.target.value);
								}
							})]
						})] }),
						error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: styles.error,
							children: error
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.editorActions,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: styles.button,
								onClick: onClose,
								children: t("job.cancel")
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: {
									...styles.button,
									...styles.buttonPrimary
								},
								onClick: save,
								children: t("job.save")
							})]
						})
					]
				})
			});
		}
		//#endregion
		//#region src/client/CronJobTab.tsx
		/**
		* Scheduled-job center: the panel tab listing all jobs with enable/disable,
		* run-now, edit, delete, and per-job trigger history.
		*/
		function executionLabel(result) {
			if (result.endedAt === void 0) return {
				text: t("job.execution.pending"),
				style: styles.resultPending
			};
			switch (result.result) {
				case "succeeded": return {
					text: t("job.execution.succeeded"),
					style: styles.resultOk
				};
				case "failed": return {
					text: t("job.execution.failed"),
					style: styles.resultFail
				};
				case "cancelled": return {
					text: t("job.execution.cancelled"),
					style: styles.resultCancel
				};
				default: return {
					text: "?",
					style: styles.resultCancel
				};
			}
		}
		function CronJobTab({ controller, workspaces }) {
			const [snapshot, setSnapshot] = (0, react.useState)(controller.getSnapshot());
			const [editing, setEditing] = (0, react.useState)();
			const [creating, setCreating] = (0, react.useState)(false);
			(0, react.useEffect)(() => controller.subscribe(() => setSnapshot(controller.getSnapshot())), [controller]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: styles.cron,
				"data-dsh-plugin": "cron",
				"data-dsh-cron-panel": "",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
						style: styles.header,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
								style: styles.title,
								children: t("job.listTitle")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: styles.meta,
								children: t("settings.hostMeta", {
									timeZone: snapshot.scheduler.timeZone,
									revision: String(snapshot.revision)
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								style: {
									...styles.button,
									...styles.buttonPrimary
								},
								onClick: () => {
									setCreating(true);
								},
								children: ["+ ", t("job.new")]
							})
						]
					}),
					snapshot.transportError !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: styles.error,
						children: [
							snapshot.transportError,
							" ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								style: styles.button,
								onClick: () => {
									controller.retryHostSync();
								},
								children: "retry"
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: styles.list,
						children: [snapshot.jobs.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: styles.empty,
							children: t("job.empty")
						}), snapshot.jobs.map((job) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(JobRow, {
							job,
							pending: snapshot.pendingJobIds.includes(job.id),
							controller,
							onEdit: setEditing
						}, job.id))]
					}),
					creating && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(JobEditor, {
						controller,
						...workspaces === void 0 ? {} : { workspaces },
						onClose: () => {
							setCreating(false);
						}
					}),
					editing !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(JobEditor, {
						controller,
						job: editing,
						...workspaces === void 0 ? {} : { workspaces },
						onClose: () => {
							setEditing(void 0);
						}
					})
				]
			});
		}
		function JobRow({ job, pending, controller, onEdit }) {
			const [open, setOpen] = (0, react.useState)(false);
			const recent = job.executions.slice(-5).reverse();
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: styles.job,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: styles.jobRow,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: styles.jobName,
							title: job.name,
							children: job.name
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: styles.jobCron,
							children: job.cron
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: styles.jobNext,
							children: job.enabled ? `${t("job.nextRun")} ${job.nextRunAt === void 0 ? t("job.notScheduled") : new Date(job.nextRunAt).toLocaleString()}` : t("job.disabled")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.actions,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									style: styles.switch,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: job.enabled,
										disabled: pending,
										onChange: (event) => {
											if (event.target.checked) controller.enable(job.id);
											else controller.disable(job.id);
										}
									}), t("job.enabled")]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: {
										...styles.button,
										...pending || !job.enabled ? styles.buttonDisabled : {}
									},
									disabled: pending || !job.enabled,
									onClick: () => {
										controller.run(job.id);
									},
									children: t("job.run")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: {
										...styles.button,
										...pending ? styles.buttonDisabled : {}
									},
									disabled: pending,
									onClick: () => {
										onEdit(job);
									},
									children: "…"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: {
										...styles.button,
										...pending ? styles.buttonDisabled : {}
									},
									disabled: pending,
									onClick: () => {
										if (!window.confirm(t("job.deleteConfirm"))) return;
										controller.remove(job.id);
									},
									children: t("job.delete")
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									style: styles.button,
									"aria-expanded": open,
									"aria-label": open ? t("job.hideHistory") : t("job.showHistory"),
									onClick: () => {
										setOpen(!open);
									},
									children: open ? "−" : "+"
								})
							]
						})
					]
				}), open && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: styles.history,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: t("job.history") }),
						recent.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: styles.historyRow,
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("job.never") })
						}),
						recent.map((execution) => {
							const label = executionLabel(execution);
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: styles.historyRow,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: styles.historyTime,
										children: new Date(execution.triggeredAt).toLocaleString()
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: label.style,
										children: label.text
									}),
									execution.error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										title: execution.error,
										children: execution.error.slice(0, 80)
									})
								]
							}, execution.id);
						})
					]
				})]
			});
		}
		//#endregion
		//#region src/client/CronSettingsCard.tsx
		/**
		* Cron plugin settings card (settings.plugin.item, key 'cron') plus its
		* tiny controller: a staged form over the `cron` settings namespace. The
		* namespace itself is registered by the Host half; the card only edits it.
		* The injected face is plain data + callbacks (JSON-compatible), per the
		* client discipline.
		*/
		var CronSettingsCardController = class {
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
		function CronSettingsCard(props) {
			const { getSnapshot, subscribe, set } = props;
			const [snapshot, setSnapshot] = (0, react.useState)(() => getSnapshot());
			(0, react.useEffect)(() => subscribe(() => setSnapshot(getSnapshot())), [getSnapshot, subscribe]);
			const value = snapshot.status === "ready" ? snapshot.value ?? {} : {};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: styles.card,
				"data-dsh-plugin": "cron",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleRow, {
						label: t("settings.enabled"),
						desc: t("settings.enabledDesc"),
						checked: value.enabled ?? true,
						onChange: (enabled) => {
							set("enabled", enabled);
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleRow, {
						label: t("settings.announce"),
						desc: t("settings.announceDesc"),
						checked: value.announceToAgent ?? true,
						onChange: (announceToAgent) => {
							set("announceToAgent", announceToAgent);
						}
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ToggleRow, {
						label: t("settings.catchUp"),
						desc: t("settings.catchUpDesc"),
						checked: value.catchUpMissed ?? false,
						onChange: (catchUpMissed) => {
							set("catchUpMissed", catchUpMissed);
						}
					})
				]
			});
		}
		//#endregion
		//#region src/client/CronTrigger.tsx
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
			lineHeight: 22
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
		/** The main-area activation event shared by injected panels (task-board family protocol). */
		const ACTIVATE_EVENT$1 = "dsh-panel-activate";
		/** The html attribute this panel toggles (sibling panels remove it). */
		const CRON_ACTIVE_ATTR = "data-dsh-cron-active";
		/** The html attribute sibling injected panels toggle (removed when we open). */
		const OTHER_ACTIVE_ATTR = "data-dsh-task-active";
		function isCronOpen() {
			return document.documentElement.hasAttribute(CRON_ACTIVE_ATTR);
		}
		/**
		* Sidebar foot trigger for the scheduled-job center.
		* @param props - sidebar column state from the foot slot owner.
		*/
		function CronTrigger(props) {
			const open = () => {
				if (isCronOpen()) return;
				document.documentElement.removeAttribute(OTHER_ACTIVE_ATTR);
				document.documentElement.setAttribute(CRON_ACTIVE_ATTR, "");
				document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT$1, { detail: "cron" }));
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				"aria-label": t("job.listTitle"),
				onClick: open,
				style: props.wide ? TRIGGER_WIDE : TRIGGER_RAIL,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
					width: props.wide ? 16 : 18,
					height: props.wide ? 16 : 18,
					viewBox: "0 0 16 16",
					fill: "none",
					"aria-hidden": "true",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: "8",
						cy: "8",
						r: "6",
						stroke: "currentColor",
						strokeWidth: "1.3"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						d: "M8 4.5V8l2.2 1.4",
						stroke: "currentColor",
						strokeWidth: "1.3",
						strokeLinecap: "round"
					})]
				}), props.wide && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: LABEL,
					children: t("job.listTitle")
				})]
			});
		}
		//#endregion
		//#region src/client/panel-mount.tsx
		/**
		* Main-area mounting for the scheduled-job center.
		*
		* The `conversation` slot is single-occupant (ui-conversation) and external
		* plugins cannot declare slots, so the center takes over the center column
		* at the DOM level — the same pattern as upstream dsh-task-board: a
		* container is appended inside the center column as a trailing child React
		* never manages, and a global stylesheet rule scoped to the html activation
		* attribute hides the conversation content while the center is active. The
		* conversation subtree underneath stays mounted and stateful.
		*/
		const CONVERSATION_COLUMN_SELECTOR = "[data-pane=\"conversation\"], [class*=\"centerCol\"]";
		/** Cross-plugin activation event; detail is the activating panel name. */
		const ACTIVATE_EVENT = "dsh-panel-activate";
		const PANEL_NAME = "cron";
		const SIDEBAR_ROW_SELECTOR = "[class*=\"sessionRow\"], [class*=\"projectRow\"], [class*=\"searchResultRow\"], [class*=\"searchResultWorkspace\"], [class*=\"newSession\"]";
		/** Close the cron center (used by sibling panels and navigation). */
		function closeCronPanel() {
			document.documentElement.removeAttribute(CRON_ACTIVE_ATTR);
		}
		/** Global visibility rules (injected once per plugin activation). */
		function visibilityStyle() {
			const style = document.createElement("style");
			style.dataset.dshCronVisibility = "";
			style.textContent = [
				`[data-dsh-cron-view] {`,
				`  display: none;`,
				`  height: 100%;`,
				`  width: 100%;`,
				`}`,
				`html[${CRON_ACTIVE_ATTR}] [data-pane='conversation'] > :not([data-dsh-cron-view]),`,
				`html[${CRON_ACTIVE_ATTR}] [class*='centerCol'] > :not([data-dsh-cron-view]) {`,
				`  display: none !important;`,
				`}`,
				`html[${CRON_ACTIVE_ATTR}] [data-dsh-cron-view] {`,
				`  display: block;`,
				`}`
			].join("\n");
			return style;
		}
		/**
		* Mount the cron center React tree into the center column and bind its
		* visibility to the html activation attribute.
		* @returns disposer unmounting the tree and restoring the column.
		*/
		function mountCronPanel(controller, workspaces) {
			let root;
			let container;
			const style = visibilityStyle();
			document.head.appendChild(style);
			const ensure = () => {
				if (container !== void 0) return;
				const column = document.querySelector(CONVERSATION_COLUMN_SELECTOR);
				if (column === null) return;
				container = document.createElement("div");
				container.dataset.dshCronView = "";
				container.dataset.dshPlugin = "cron";
				column.appendChild(container);
				root = (0, react_dom_client.createRoot)(container);
				root.render((0, react.createElement)(CronCenterView, {
					controller,
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
				if (event.detail !== PANEL_NAME) closeCronPanel();
			};
			const onClickSidebarRow = (event) => {
				if (!document.documentElement.hasAttribute("data-dsh-cron-active")) return;
				const target = event.target;
				if (target === null) return;
				if (target.closest(SIDEBAR_ROW_SELECTOR) !== null) closeCronPanel();
			};
			document.addEventListener("click", onClickSidebarRow, true);
			document.addEventListener(ACTIVATE_EVENT, onOtherActivate);
			ensure();
			return () => {
				document.removeEventListener("click", onClickSidebarRow, true);
				document.removeEventListener(ACTIVATE_EVENT, onOtherActivate);
				waitObserver.disconnect();
				closeCronPanel();
				root?.unmount();
				root = void 0;
				container?.remove();
				container = void 0;
				style.remove();
			};
		}
		/** Center view: a back-to-chat header plus the job center body. */
		function CronCenterView({ controller, workspaces }) {
			const back = () => {
				closeCronPanel();
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					height: "100%",
					minWidth: 420
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						display: "flex",
						alignItems: "center",
						gap: 8,
						padding: "10px 14px"
					},
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						onClick: back,
						style: backButtonStyle,
						"aria-label": t("board.close"),
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							"aria-hidden": "true",
							children: "‹"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("board.close") })]
					})
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					style: {
						flex: 1,
						overflow: "hidden"
					},
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CronJobTab, {
						controller,
						...workspaces === void 0 ? {} : { workspaces }
					})
				})]
			});
		}
		const backButtonStyle = {
			display: "inline-flex",
			alignItems: "center",
			gap: 6,
			border: "1px solid var(--dsw-border, rgba(128,128,128,.3))",
			borderRadius: 8,
			background: "transparent",
			color: "inherit",
			fontFamily: "inherit",
			fontSize: 13,
			padding: "4px 10px",
			cursor: "pointer"
		};
		//#endregion
		//#region src/client/index.ts
		/**
		* Cron plugin client half: registers the settings card (settings.plugin.item
		* keyed 'cron') and, when dsh-better-sidebar is present, the scheduled-job
		* center tab. The sidebar dependency is soft: `ctx.inject(['betterSidebar'])`
		* mounts a child fiber only while the service exists, so the plugin works in
		* compositions without the sidebar and the tab unregisters on service loss.
		*
		* Client discipline: value imports are limited to the platform module table;
		* @deepseek-ai/* and sibling packages enter type-only. Cross-plugin
		* collaboration goes through cordis services and slots only.
		*/
		const inject = [
			"slots",
			"settingsScope",
			"locale",
			"workspaces"
		];
		/** Settings namespace this card edits (the Host half registers it). */
		const CRON_NS = "cron";
		/** Locale namespace this plugin owns. */
		const LOCALE_NS = "cron";
		/** Cordis service name of the browser cron face (sibling plugins consume). */
		const BROWSER_CRON_SERVICE = "picoCronService";
		function apply(ctx) {
			ctx.effect(() => {
				const offZh = ctx.locale.register(LOCALE_NS, {
					zh,
					en
				});
				return () => {
					offZh();
				};
			}, "dsh-cron: dictionaries");
			const browserCron = new HttpBrowserCronService(new HttpCronTransport());
			ctx.effect(() => {
				browserCron.start();
				return () => browserCron.dispose();
			}, "dsh-cron: browser cron service");
			ctx.provide(BROWSER_CRON_SERVICE, browserCron);
			const settingsScope = ctx.get("settingsScope");
			if (settingsScope !== void 0) {
				const card = new CronSettingsCardController(settingsScope.bind({ namespace: CRON_NS }));
				ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
					name: "settings.plugin.item",
					key: CRON_NS,
					locale: LOCALE_NS,
					inject: () => card.inject()
				}, CronSettingsCard));
			}
			const controller = new CronController({ transport: new HttpCronTransport() });
			ctx.effect(() => {
				controller.start();
				return () => controller.dispose();
			}, "controller lifecycle");
			const workspacesService = ctx.get("workspaces");
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "pico-cron",
				order: -10
			}, CronTrigger));
			ctx.effect(() => mountCronPanel(controller, workspacesService), "dsh-cron: main-area center");
			ctx.inject(["betterSidebar"], (childCtx) => {
				const service = childCtx.get("betterSidebar");
				if (service === void 0) return;
				const disposeTab = service.registerTab({
					id: "pico:cron",
					title: () => zh["job.listTitle"],
					order: 30,
					component: () => (0, react.createElement)(CronJobTab, {
						controller,
						...workspacesService === void 0 ? {} : { workspaces: workspacesService }
					})
				});
				childCtx.effect(() => () => {
					disposeTab();
				}, "dsh-cron: better-sidebar tab");
			});
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map