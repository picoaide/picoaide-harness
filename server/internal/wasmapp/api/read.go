package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/appcfg"
	"github.com/picoaide/picoaide/internal/wasmapp/appdb"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/diag"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/registry"
)

// 本文件是 §8 的**只读面**：诊断 / 自省 / 应用中心目录 / 导出。
//
// 四条口径先写清（都是"会不会多给/少给信息"的问题）：
//   - diagnostics：失败记录 + 概览 + **可操作 hints**（§4.9：第一消费者是 AI）；
//   - schema：表结构 + 占用（**仅发布者**，且**每次调用写审计**）；
//   - catalog：按可见性过滤的目录（R34/R38；**不做安装语义、不显示额度/用量**，R36）；
//   - export：R37 的只读快照 —— 控制面元数据 + 获取说明，**不含任何使用者数据**。

// ---------------------------------------------------------------------------
// 诊断：GET .../wasm/:app_id/diagnostics
// ---------------------------------------------------------------------------

func (h *Handlers) diagnostics(c *gin.Context) {
	if err := h.requireReady(); err != nil {
		writeErr(c, err)
		return
	}
	appID := registry.NormalizeAppID(c.Param("app_id"))
	// 只读动作 ⇒ 允许已退役（R37 的保留期内仍要能排障）。
	app, _, oerr := h.ownedApp(c, appID, true)
	if oerr != nil {
		writeErr(c, oerr)
		return
	}
	limit := atoiDefault(c.Query("limit"), limits.DiagnosticsDefaultLimit)
	window := windowFromQuery(c.Query("minutes"))
	since := h.now().UTC().Add(-window)
	ctx := c.Request.Context()

	failures, err := diag.RecentFailures(ctx, h.opt.DB, appID, limit)
	if err != nil {
		writeErr(c, internalErr("查询失败", err))
		return
	}
	summary, err := diag.Summary(ctx, h.opt.DB, appID, since)
	if err != nil {
		writeErr(c, internalErr("查询失败", err))
		return
	}
	// hints 的来源有两条且都要给：
	//   - summary.Hints（按出现次数排序的失败码对应建议）；
	//   - 逐条 failure 的 HintsFor（时间线上"那一次"是什么错就说什么）。
	// 合并后保序去重（同一个 hint 不重复刷屏）。
	hints := append([]string{}, summary.Hints...)
	for _, f := range failures {
		hints = append(hints, diag.HintsFor(f.ReasonCode)...)
	}
	c.JSON(http.StatusOK, gin.H{"diagnostics": gin.H{
		"app_id":         appID,
		"app_enabled":    app.Enabled,
		"app_frozen":     app.FrozenAt != nil,
		"app_deleted":    app.DeletedAt != nil,
		"since":          summary.Since,
		"window_minutes": int(window.Minutes()),
		"retention_days": limits.CallEventRetentionDays,
		"summary":        summary,
		"failures":       failures,
		"hints":          dedupeStrings(hints),
	}})
}

// windowFromQuery 解析诊断窗口（分钟）。缺省 24 h，上限 = 调用事件保留期
// （超过保留期的查询只会返回空，不如直接告诉调用方上限在哪）。
func windowFromQuery(raw string) time.Duration {
	const defMinutes = 24 * 60
	maxMinutes := limits.CallEventRetentionDays * 24 * 60
	m := atoiDefault(raw, defMinutes)
	if m <= 0 {
		m = defMinutes
	}
	if m > maxMinutes {
		m = maxMinutes
	}
	return time.Duration(m) * time.Minute
}

// atoiDefault 解析十进制整数，失败取缺省（查询参数不合法不该变成 500）。
func atoiDefault(raw string, def int) int {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return def
	}
	return n
}

// dedupeStrings 保序去重（空串丢弃）。
func dedupeStrings(in []string) []string {
	out := make([]string, 0, len(in))
	seen := make(map[string]struct{}, len(in))
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if _, dup := seen[s]; dup {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}

// ---------------------------------------------------------------------------
// 自省：GET .../wasm/:app_id/schema
// ---------------------------------------------------------------------------

// schemaTable 是一张表的自省结果。
type schemaTable struct {
	Name    string      `json:"name"`
	Rows    int64       `json:"rows"`
	Columns []schemaCol `json:"columns"`
	Skipped bool        `json:"skipped,omitempty"`
	Reason  string      `json:"skip_reason,omitempty"`
}

// schemaCol 是一列的结构。
type schemaCol struct {
	Name    string `json:"name"`
	Type    string `json:"type"`
	NotNull bool   `json:"not_null"`
	PK      bool   `json:"pk"`
}

func (h *Handlers) schema(c *gin.Context) {
	if err := h.requireReady(); err != nil {
		writeErr(c, err)
		return
	}
	appID := registry.NormalizeAppID(c.Param("app_id"))
	app, u, oerr := h.ownedApp(c, appID, true)
	if oerr != nil {
		writeErr(c, oerr)
		return
	}
	// §8：自省"仅发布者 + 审计" —— 每次调用都留痕（自省面会暴露应用的数据规模）。
	h.auditApp(appID, u.Username, "wasm_app_schema_view",
		auditDetail(appID, app.Title, "查看表结构与占用"))

	report, serr := h.inspectAppDB(c.Request.Context(), appID)
	if serr != nil {
		writeErr(c, serr)
		return
	}
	c.JSON(http.StatusOK, gin.H{"schema": report})
}

// inspectAppDB 只读打开应用库并自省（表 / 列 / 行数 / 占用）。
//
// 为什么在 api 层直连 SQLite（而不是复用 appdb 的加固连接）：`appdb` 的连接面向
// **应用请求**（query_only/rw 两条 + 语句白名单），它明确拒绝 `sqlite_` 前缀的引擎
// 内部对象（sqlgate.go 的 internal_object），而自省正是要读 sqlite_master。
// 这里的连接是"平台读自己的文件"：只读（mode=ro + query_only）、不执行任何**应用
// 提供的** SQL、表名先过平台规则再进语句，风险面与 appdb 的只读连接同级。
// 库路径仍由 appdb 权威给出（不在本包复制"<data_root>/apps/<app_id>/app.db"的布局）。
func (h *Handlers) inspectAppDB(ctx context.Context, appID string) (gin.H, *apperr.Error) {
	probe, oerr := appdb.Open(ctx, appdb.Options{DataRoot: h.opt.DataRoot, AppID: appID})
	if oerr != nil {
		// 打开失败（限额设不上 / 金丝雀不成立）是平台状态问题，如实上报而不是假装空库。
		return nil, internalErr("应用库不可用", oerr)
	}
	path := probe.Path()
	_ = probe.Close()

	report := gin.H{
		"app_id":           appID,
		"db":               logicalUnderDataRoot(h.opt.DataRoot, path),
		"size_bytes":       int64(0),
		"max_bytes":        int64(limits.AppDBMaxBytes),
		"max_tables":       limits.MaxTablesPerApp,
		"max_columns":      limits.MaxColumnsPerTable,
		"column_types":     limits.SQLColumnTypes,
		"reserved_columns": []string{limits.ReservedRowIDColumn},
		"tables":           []schemaTable{},
		"table_count":      0,
		"usage_percent":    float64(0),
	}

	dsn := "file:" + path + "?mode=ro&_pragma=query_only(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, internalErr("应用库只读打开失败", err)
	}
	defer db.Close()
	if err := db.PingContext(ctx); err != nil {
		return nil, internalErr("应用库只读连接失败", err)
	}
	size := fileSize(path)
	report["size_bytes"] = size
	report["initialized"] = size > 0
	report["page_size"] = pragmaInt(ctx, db, "page_size")
	report["page_count"] = pragmaInt(ctx, db, "page_count")
	report["usage_percent"] = usagePercent(size, int64(limits.AppDBMaxBytes))

	names, err := appTableNames(ctx, db)
	if err != nil {
		return nil, internalErr("读取表清单失败", err)
	}
	tables := make([]schemaTable, 0, len(names))
	for _, name := range names {
		t := schemaTable{Name: name}
		// 名称先过平台自己的表名规则：sqlite_master 的内容是**应用可控**的
		//（正常由 db.define 建，但文件可能被篡改），拼进 SQL 前必须校验。
		if !validateTableName(name) {
			t.Skipped, t.Reason = true, "表名不符合平台规则（不是 db.define 建的）"
			tables = append(tables, t)
			continue
		}
		cols, cerr := tableColumns(ctx, db, name)
		if cerr != nil {
			return nil, internalErr("读取列结构失败", cerr)
		}
		t.Columns = cols
		if n, cerr := tableRowCount(ctx, db, name); cerr == nil {
			t.Rows = n
		}
		tables = append(tables, t)
	}
	report["tables"] = tables
	report["table_count"] = len(tables)
	return report, nil
}

// logicalUnderDataRoot 把宿主绝对路径渲染成"数据根之下的相对路径"（对外只暴露
// 逻辑位置，不暴露服务器的目录布局）。不在数据根之下时返回空串。
func logicalUnderDataRoot(dataRoot, path string) string {
	root := strings.TrimSuffix(filepath.Clean(dataRoot), string(os.PathSeparator))
	clean := filepath.Clean(path)
	if root == "" || !strings.HasPrefix(clean, root+string(os.PathSeparator)) {
		return ""
	}
	return filepath.ToSlash(strings.TrimPrefix(clean, root+string(os.PathSeparator)))
}

// fileSize 返回文件字节数（不可读时返回 0：自省面不回错误码，占用为 0 已经足够表达
// "这个库还没有内容"）。
func fileSize(path string) int64 {
	st, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return st.Size()
}

func usagePercent(used, max int64) float64 {
	if max <= 0 {
		return 0
	}
	return float64(used) * 100 / float64(max)
}

// validateTableName 复用 limits 的规则（唯一真源是 limits.TableNamePattern /
// ColumnNamePattern = `^[a-z][a-z0-9_]{0,30}$`），手写一遍是为了避免为一次自省
// 引入正则编译；两条规则当前逐字相同，测试（read_test.go）对拍它们的一致性。
func validateTableName(name string) bool {
	if name == "" || len(name) > 31 {
		return false
	}
	if name[0] < 'a' || name[0] > 'z' {
		return false
	}
	for _, r := range name[1:] {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' {
			continue
		}
		return false
	}
	return true
}

func appTableNames(ctx context.Context, db *sql.DB) ([]string, error) {
	rows, err := db.QueryContext(ctx, `SELECT name FROM sqlite_master
		WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

func tableColumns(ctx context.Context, db *sql.DB, table string) ([]schemaCol, error) {
	// PRAGMA 不能用占位符；表名来自 sqlite_master 且已过 validateTableName
	//（只含 [a-z0-9_]）⇒ 没有注入面。
	rows, err := db.QueryContext(ctx, `PRAGMA table_info(`+quoteIdent(table)+`)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []schemaCol{}
	for rows.Next() {
		var cid int
		var name, declType string
		var notNull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &declType, &notNull, &dflt, &pk); err != nil {
			return nil, err
		}
		out = append(out, schemaCol{Name: name, Type: declType, NotNull: notNull == 1, PK: pk > 0})
	}
	return out, rows.Err()
}

func tableRowCount(ctx context.Context, db *sql.DB, table string) (int64, error) {
	var n int64
	err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+quoteIdent(table)).Scan(&n)
	return n, err
}

// quoteIdent 用双引号包裹标识符（内部的双引号翻倍）。表名在此前已过
// validateTableName，这一步是纵深防御而不是唯一防线。
func quoteIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

func pragmaInt(ctx context.Context, db *sql.DB, name string) int64 {
	var v int64
	if err := db.QueryRowContext(ctx, `PRAGMA `+name).Scan(&v); err != nil {
		return 0
	}
	return v
}

// ---------------------------------------------------------------------------
// 应用中心目录：GET /apps/wasm/catalog
// ---------------------------------------------------------------------------

func (h *Handlers) catalog(c *gin.Context) {
	if err := h.requireReady(); err != nil {
		writeErr(c, err)
		return
	}
	// 目录是**登录后**的可见面（§8：客户端员工面）。不做匿名目录。
	if _, aerr := h.currentUser(c); aerr != nil {
		writeErr(c, aerr)
		return
	}
	// 目录**不过滤访问级别**（2026-09-18 用户拍板，R38 作废）：无论 public / login /
	// whitelist，也无论是否下架，都列出来 —— 使用者需要看见"有哪些应用"，
	// 能不能用由条目上的 access 与 enabled 提示、由应用自己判（R24）。
	apps, err := serverstore.ListWasmApps(c.Request.Context(), h.opt.DB, serverstore.WasmAppFilter{})
	if err != nil {
		writeErr(c, internalErr("查询失败", err))
		return
	}
	out := make([]gin.H, 0, len(apps))
	for _, a := range apps {
		// 目录条件（R34 + §8，2026-09-18 收敛后**只剩三条**）：
		//   未删除（DAO 已保证）· 有生效版本（占名但从未发布成功的行不列）· 未冻结。
		//   - **下架（enabled=false）仍列出**：下架是**可逆的发布者动作**，应用与它的
		//     数据都还在（应用子域返回 410 Gone + "应用已下架，数据仍然保留，恢复后
		//     链接不变"，见 appserver/respond.go 的 writeGone）—— 直接隐去会让使用者
		//     以为应用被删了，还会让人以为标识空出来了（标识一经发布不能改名）。
		//     条目里给出 enabled，由 UI 标"已下架"并禁用打开按钮。
		//     ⚠️ 勘误（2026-09-18 独立审计）：此前这里写"子域照旧可访问"是**错的**
		//     —— serve.go 对 enabled=false 返回 410。列出它的理由是可逆与"仍在"，
		//     不是"还能用"。
		//   - **冻结仍不列**：冻结 = 停止服务（appserver 对 frozen 一律 404，R37），
		//     列出来只会给出一个死链接。
		if a.FrozenAt != nil || a.CurrentReleaseID <= 0 {
			continue
		}
		// 负责人 = picoaide.app.json 的 owner（§4.2 的"负责人"声明）；平台归属
		// （apps.owner）只是兜底 —— 两者同名不同物，不做互相推导（appcfg 包注释）。
		responsible := ""
		if a.ConfigJSON != "" {
			var cfg appcfg.Config
			if json.Unmarshal([]byte(a.ConfigJSON), &cfg) == nil {
				responsible = strings.TrimSpace(cfg.Owner)
			}
		}
		if responsible == "" {
			responsible = a.Owner
		}
		row := gin.H{
			"app_id":      a.AppID,
			"title":       a.Title,
			"description": a.Description,
			"responsible": responsible,
			"owner":       a.Owner,
			// access 让应用中心能标出访问级别（public/login/whitelist）；
			// 它从 config_json 现解（旧 schema 由 appcfg 的兼容 shim 映射，
			// 解析失败回落 login —— 见 appcfg.AccessOfConfigJSON）。
			"access": string(appcfg.AccessOfConfigJSON(a.ConfigJSON)),
			// enabled=false = 已下架：**不能**从 URL 直达（appserver 返回 410 Gone，
			// 见 writeGone），但它仍列在目录里（理由见上面的目录条件）。
			"enabled":    a.Enabled,
			"updated_at": a.UpdatedAt,
		}
		if origin := h.appOrigin(c, a.AppID); origin != "" {
			row["entry_url"] = origin
		}
		// R36：目录**不**显示额度/用量 —— 这里刻意不返回任何用量字段。
		out = append(out, row)
	}
	c.JSON(http.StatusOK, gin.H{"apps": out})
}

// ---------------------------------------------------------------------------
// 导出：GET .../wasm/:app_id/export（R37 只读快照）
// ---------------------------------------------------------------------------

func (h *Handlers) export(c *gin.Context) {
	if err := h.requireReady(); err != nil {
		writeErr(c, err)
		return
	}
	appID := registry.NormalizeAppID(c.Param("app_id"))
	app, u, oerr := h.ownedApp(c, appID, true)
	if oerr != nil {
		writeErr(c, oerr)
		return
	}
	ctx := c.Request.Context()
	releases, err := serverstore.ListWasmReleases(ctx, h.opt.DB, appID, true)
	if err != nil {
		writeErr(c, internalErr("查询失败", err))
		return
	}
	h.auditApp(appID, u.Username, "wasm_app_export",
		auditDetail(appID, app.Title, "导出控制面快照"))

	rows := make([]gin.H, 0, len(releases))
	var currentVersion string
	for _, r := range releases {
		row := gin.H{
			"version":     r.Version,
			"title":       r.Title,
			"description": r.Description,
			"changelog":   r.Changelog,
			"publisher":   r.Publisher,
			"status":      r.Status,
			"checksum":    r.Checksum,
			"size":        r.Size,
			"created_at":  r.CreatedAt,
			"deleted":     r.DeletedAt != nil,
		}
		if r.ConfigJSON != "" {
			row["config"] = json.RawMessage(r.ConfigJSON)
		}
		if r.ID == app.CurrentReleaseID {
			currentVersion = r.Version
			row["current"] = true
		}
		rows = append(rows, row)
	}
	var appConfig json.RawMessage
	if app.ConfigJSON != "" {
		appConfig = json.RawMessage(app.ConfigJSON)
	}
	body := gin.H{"export": gin.H{
		"format":      "picoaide.wasm-app-export/1",
		"exported_at": h.now().UTC(),
		"app": gin.H{
			"app_id":             app.AppID,
			"title":              app.Title,
			"description":        app.Description,
			"owner":              app.Owner,
			"channel":            app.Channel,
			"enabled":            app.Enabled,
			"access":             string(appcfg.AccessOfConfigJSON(app.ConfigJSON)),
			"purpose":            app.Purpose,
			"data_sensitivity":   app.DataSensitivity,
			"config":             appConfig,
			"current_version":    currentVersion,
			"current_release_id": app.CurrentReleaseID,
			"frozen_at":          app.FrozenAt,
			"deleted_at":         app.DeletedAt,
			"created_at":         app.CreatedAt,
			"updated_at":         app.UpdatedAt,
		},
		"releases": rows,
		"assets": gin.H{
			"layout": "<data_root>/apps/<app_id>/assets/<release_id>/",
			"note":   "静态资源在发布期已从 wasm 自定义段抽出到这个目录；本导出**不**返回资源内容（可从各版本 wasm 重新抽出）",
		},
		"database": gin.H{
			"path_template": "<data_root>/apps/<app_id>/app.db",
			"included":      false,
			"why": "应用库里是**使用者**写入的业务数据（可能含个人信息）；导出它属于独立的管理员运维动作，" +
				"不在本端点范围内（§8 管理平面边界：本导出只含控制面元数据）",
			"snapshot_hint": "SQLite 单文件只读快照：`VACUUM INTO '<目标路径>'`（SQLite 3.27+；不锁写、不留 WAL 尾巴）；" +
				"平台侧 R37 的定期快照由后台任务执行（当前未实现）",
		},
		"retention": gin.H{
			"snapshot_days": limits.RetirementSnapshotRetentionDays,
			"note":          "R37：冻结 → 只读快照保留期内可导出 → 保留期结束后真删（真删任务当前未实现）",
		},
	}}
	c.Header("Content-Disposition", `attachment; filename="`+url.PathEscape(appID)+`-export.json"`)
	c.JSON(http.StatusOK, body)
}
