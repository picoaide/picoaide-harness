// Command showcase 是应用平台的「能力全集」演示应用（窗口按手机竖屏锁定 9:19.5）。
//
// 它有两个定位：
//
//  1. **给客户看的能力全集**：平台给 WASM 应用的每一项能力都在页面上当场跑一遍，
//     并把真实结果（成功/失败、错误码、平台给的 hints、耗时微秒）显示出来。
//     "真实"指的是页面上那条时间线来自本次请求 `app.Traces()` 里**真的发生过**的
//     宿主调用，不是画出来的清单。
//  2. **上线前自查工具**：有一屏会故意违规，把平台回的 code / message / details /
//     hints 原样渲染，并显式对比"文档预期"与"本次实际"——不一致时页面会标出来。
//
// 平台契约里容易踩的几条，本文件全部按规矩走：
//   - 宿主能力只有六个原语（`db.define` / `db.query` / `db.exec` / `db.tx` / `log` /
//     `assets.read`），没有文件、没有网络、**wasm 侧没有 AI**（AI 走页面里的客户端
//     AI loop，见 web/app.js）；
//   - 值一律用 `?` 占位（平台不替你参数化：把值拼进 SQL 它照样放行）；
//   - 保留列 `_row_id` 连提都不能提（`rowid` / `_rowid_` / `oid` 一视同仁）；
//   - 事务内只允许 `db.query` / `db.exec` 与两个出口，`log` 与 `db.define` 进去必被拒；
//   - 建表只能走 `db.define`；DDL 与 `WITH` 在 SQL 里一律拒；
//   - 入口 `/` 必须先判名单再给页面（R24：平台不比对名单，只注入身份与访问模式）。
//
// 静态前端是纯静态、零外部依赖的（`web/index.html` + `/static/app.css` +
// `/static/app.js`）；`/static/*` 由宿主按路径**直出**、根本不经过这里，只有入口 `/`
// 与 `/api/*` 会进到 wasm —— 所以"先判名单再给页面"只有本文件这一条路。
//
// 语言侧只依赖 portable Go 标准库 + 平台内部的 abi 契约包（内置演示随镜像构建，
// 与外部作者不同：外部作者照 skill 的 examples 自己实现帧协议）。
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/picoaide/picoaide/demoapps/internal/demoapp"
	"github.com/picoaide/picoaide/internal/wasmapp/abi"
)

// ---------------------------------------------------------------------------
// 表结构与 SQL
// ---------------------------------------------------------------------------

const (
	// tableRuns 是演示用的「证据表」：一行 = 本次请求真的写进库里的一条记录。
	tableRuns = "showcase_runs"

	// historyLimit 是历史证据的展示条数（平台返回上限是 5000 行 / 8 MiB，这里只取一小段）。
	historyLimit = 20

	// runsLimitMax 是 `/api/runs?limit=` 允许的最大值。
	runsLimitMax = 50

	// logMaxBytes 是平台对**单条**日志的上限（超限截断，不拒绝）；每请求最多 100 条。
	logMaxBytes = 4096

	// defaultLogMessage 是 `/api/log` 未给正文时的兜底内容。
	defaultLogMessage = "showcase 能力自查：这一条来自页面上的「写一条日志」按钮"
)

// runColumns 是证据表的结构。
//
// 列名必须匹配 `^[a-z][a-z0-9_]{0,30}$`，类型只能是 text/int/real/bool/datetime；
// 平台会自动追加保留列 `_row_id INTEGER PRIMARY KEY AUTOINCREMENT`（**不占**应用的
// 列配额，也**绝不能**在 SQL 或列名里提到它）。
var runColumns = []demoapp.Column{
	{Name: "created_at", Type: "datetime"},
	{Name: "phase", Type: "text"},
	{Name: "label", Type: "text"},
	{Name: "detail", Type: "text"},
	{Name: "who", Type: "text"},
	{Name: "ok", Type: "bool"},
	{Name: "micros", Type: "int"},
	{Name: "marker", Type: "text"},
}

// runColumnNames 与 runColumns 同序，给历史表头与行投影用。
var runColumnNames = []string{"created_at", "phase", "label", "detail", "who", "ok", "micros", "marker"}

// insertRunSQL / selectRunSQL 是全应用唯一的两条业务 SQL。
//
//   - 值**一律**用 `?` 占位：平台不检查你是否参数化（字面量拼进 SQL 照样过闸门），
//     注入没有任何平台侧防线，只有参数占位挡得住；
//   - 一次只跑一条语句（分号后还有内容即拒）；
//   - 排序用我们自己声明的 `created_at`，**不碰**平台保留列。
const (
	insertRunSQL = "INSERT INTO showcase_runs (created_at, phase, label, detail, who, ok, micros, marker) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
	selectRunSQL = "SELECT created_at, phase, label, detail, who, ok, micros, marker FROM showcase_runs ORDER BY created_at DESC LIMIT ?"
)

// markerSeq 让同一纳秒内的两次请求也拿到不同的 marker（进程内单调递增）。
var markerSeq int64

// newMarker 生成本次请求的唯一标记：回滚演示靠它区分"本次写的行"与历史遗留。
func newMarker() string {
	markerSeq++
	return fmt.Sprintf("run-%d-%d", time.Now().UnixNano(), markerSeq)
}

func main() { demoapp.Main(handle) }

// handle 是唯一的路由入口。
//
// 路由事实：`/` 会走到 wasm；`/static/*` 这类非保留资源由宿主按路径直出、**不会**
// 到这里；`/api/*` 由下面的分支处理；其余路径走兜底（宿主没直出时才轮到这里）。
func handle(a *demoapp.App) demoapp.Response {
	switch a.Path() {
	case "", "/", "/index.html":
		return handleEntry(a)
	case "/api/whoami":
		return handleWhoami(a)
	case "/api/run":
		return requirePost(a, handleRun)
	case "/api/tx":
		return requirePost(a, handleTx)
	case "/api/denied":
		return handleDenied(a)
	case "/api/log":
		return requirePost(a, handleLog)
	case "/api/runs":
		return handleRuns(a)
	}
	// 兜底：宿主没有直出的包内资源，应用自己读一次（静态资源的推荐兜底姿势）。
	if a.Req.Method == "GET" || a.Req.Method == "HEAD" {
		if resp, ok := serveAsset(a); ok {
			return resp
		}
	}
	return demoapp.Fail(404, "NOT_FOUND", fmt.Sprintf("应用没有实现这个路径：%s %s", a.Req.Method, a.Path()))
}

// requirePost 包一层方法校验：写面只接受 POST，其余给 405 信封。
func requirePost(a *demoapp.App, fn func(*demoapp.App) demoapp.Response) demoapp.Response {
	if a.Req.Method != "POST" {
		return demoapp.Fail(405, "METHOD_NOT_ALLOWED", fmt.Sprintf("%s 只接受 POST，收到 %s", a.Path(), a.Req.Method))
	}
	return fn(a)
}

// ---------------------------------------------------------------------------
// 入口：先判名单，再给页面
// ---------------------------------------------------------------------------

// handleEntry 是入口 `/` 的处理器。
//
// 顺序是硬要求：`app.AccessAllowed()` 通不过就**绝不**返回页面（返回自制的 403 页，
// 且必须显示本人账号 —— 那是作者发现名单拼错的唯一途径）。配置读不到时
// `AccessAllowed` 一律返回 false（宁可 500 也不静默放行）。
func handleEntry(a *demoapp.App) demoapp.Response {
	allowed, reason, cfg := a.AccessAllowed()
	if !allowed {
		return demoapp.HTML(403, deniedPage(a, cfg, reason))
	}
	markup, herr := a.EntryHTML()
	if herr != nil {
		return demoapp.Fail(500, herr.Code, "入口页读不到（包内缺 index.html / index.htm）："+herr.Message)
	}
	return demoapp.HTML(200, markup)
}

// deniedPage 是应用自己的 403 页（必须显示本人账号）。
func deniedPage(a *demoapp.App, cfg demoapp.Config, reason string) string {
	var b strings.Builder
	writeDeniedHead(&b)
	b.WriteString(`<main class="denied"><section class="deniedCard">`)
	b.WriteString(brandMarkup("mark mark-lg"))
	b.WriteString(`<h1>没有访问权限</h1>`)
	b.WriteString(`<p class="deniedReason">` + html.EscapeString(reason) + `</p>`)

	b.WriteString(`<dl class="kv">`)
	writeKV(&b, "账号（帧里的 user.username）", a.Username())
	writeKV(&b, "显示名", a.DisplayName())
	if a.Req.User != nil {
		writeKV(&b, "用户 ID", strconv.FormatInt(a.Req.User.ID, 10))
		writeKV(&b, "部门", a.Req.User.Dept)
		writeKV(&b, "本应用发布者", yesNo(a.Req.User.IsPublisher))
	} else {
		writeKV(&b, "身份", "本次请求没有 user 字段（匿名）")
	}
	b.WriteString(`</dl>`)

	b.WriteString(`<div class="deniedBox"><h2>为什么被拦下来</h2><p>本应用配置里的 <span class="mono">access</span> 是 <span class="mono">`)
	b.WriteString(html.EscapeString(cfg.Access))
	b.WriteString(`</span>，名单里没有上面这个账号。</p><p>名单（<span class="mono">`)
	b.WriteString(strconv.Itoa(len(cfg.Whitelist)))
	b.WriteString(`</span> 条）：<span class="mono">`)
	b.WriteString(html.EscapeString(strings.Join(cfg.Whitelist, ", ")))
	b.WriteString(`</span></p></div>`)

	b.WriteString(`<p class="muted">R24：平台<b>不比对</b>名单，只把身份与访问模式注入请求帧；`)
	b.WriteString(`判定与这一页 403 都是应用自己做的 —— 所以上面显示的账号就是帧里的账号。`)
	b.WriteString(`把账号原样发给管理员加进名单即可。</p>`)
	b.WriteString(`</section></main></body></html>`)
	return b.String()
}

func writeDeniedHead(b *strings.Builder) {
	b.WriteString(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">`)
	b.WriteString(`<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`)
	b.WriteString(`<title>没有访问权限 · 能力全集</title>`)
	b.WriteString(`<link rel="stylesheet" href="/static/app.css"></head><body class="page deniedPage">`)
	b.WriteString(`<div class="bg" aria-hidden="true"><span class="blob b1"></span><span class="blob b2"></span><span class="blob b3"></span><span class="grid"></span></div>`)
}

func writeKV(b *strings.Builder, label, value string) {
	b.WriteString(`<div class="kvRow"><dt>` + html.EscapeString(label) + `</dt><dd>` + html.EscapeString(value) + `</dd></div>`)
}

// ---------------------------------------------------------------------------
// GET /api/whoami —— 身份注入 + 访问模式
// ---------------------------------------------------------------------------

func handleWhoami(a *demoapp.App) demoapp.Response {
	// 名单判定走与入口**同一条**路径（app.AccessAllowed ⇒ 读配置 + 比对）。
	allowed, reason, cfg := a.AccessAllowed()
	// 原始配置文本：保留资源只有应用自己读得到（宿主永不直出），顺带演示 assets.read 的判别字段。
	asset, assetErr := a.AssetRead(demoapp.AppConfigPath)

	raw := ""
	rawTruncated := false
	if assetErr == nil {
		raw = asset.Text
		if len(raw) > 2000 {
			raw = raw[:2000]
			rawTruncated = true
		}
	}

	accessNote := "access=login ⇒ 登录后全员可用（平台只注入模式，不做名单比对）"
	if cfg.Access == "whitelist" {
		accessNote = fmt.Sprintf("access=whitelist ⇒ 应用自己比对名单（名单 %d 条）；不在名单里由应用返回 403 并显示本人账号", len(cfg.Whitelist))
	}

	identity := map[string]any{
		"present":      a.Req.User != nil,
		"id":           userIDText(a),
		"username":     a.Username(),
		"display_name": a.DisplayName(),
		"dept":         userDeptText(a),
		"is_publisher": yesNo(a.Req.User != nil && a.Req.User.IsPublisher),
	}

	frame := map[string]any{
		"abi":           a.Req.ABI,
		"app_id":        a.Req.AppID,
		"version":       a.Req.Version,
		"method":        a.Req.Method,
		"path":          a.Path(),
		"auth_mode":     string(a.Req.Auth.Mode),
		"auth_verified": yesNo(a.Req.Auth.Verified),
		"header_keys":   headerKeys(a),
		"cookie_header": cookieHeaderText(a),
		"body_bytes":    strconv.Itoa(len(a.Req.Body)),
		"query_keys":    queryKeys(a),
	}

	config := map[string]any{
		"access":           cfg.Access,
		"whitelist":        cfg.Whitelist,
		"whitelist_count":  len(cfg.Whitelist),
		"purpose":          cfg.Purpose,
		"data_sensitivity": cfg.DataSensitivity,
		"owner":            cfg.Owner,
		"raw":              raw,
		"raw_truncated":    rawTruncated,
	}

	configAsset := map[string]any{
		"ok":           assetErr == nil,
		"content_type": asset.ContentType,
		"size":         asset.Size,
		"encoding":     asset.Encoding,
	}
	if assetErr != nil {
		configAsset["error"] = errorViewOf(assetErr)
	}

	return demoapp.JSON(200, map[string]any{
		"identity":     identity,
		"frame":        frame,
		"config":       config,
		"config_asset": configAsset,
		"access": map[string]any{
			"allowed": allowed,
			"reason":  reason,
			"note":    accessNote,
		},
		"explain": map[string]string{
			"login":     "login：要求登录。登录后全员可用 —— 平台注入身份（user）并把 auth.mode 置为 login，应用不需要任何登录逻辑。",
			"whitelist": "whitelist：要求登录「且」应用自己比对名单。平台同样只注入身份与模式（auth.mode=whitelist），不比对、也不校验名单里的账号是否存在（否则等于账号枚举接口）。",
			"r24":       "R24：名单判定永远在应用侧。应用的入口第一件事就是读自己的 picoaide.app.json 比对，不在名单里返回 403 页面并显示「本人账号」。",
			"where":     "名单放 picoaide.app.json（平台保留资源，永不直出）：放进会被直出的非保留资源，等于把名单公开给任何能打开应用的人。",
		},
		"traces": a.Traces(),
	})
}

// ---------------------------------------------------------------------------
// POST /api/run —— 3~7 全跑一遍
// ---------------------------------------------------------------------------

func handleRun(a *demoapp.App) demoapp.Response {
	started := time.Now()
	marker := newMarker()
	who := a.DisplayName()
	steps := make([]step, 0, 8)

	// 每个 /api/* 也自己判一次名单：不依赖"入口判过了"（应用无状态，每请求都要判）。
	allowed, reason, cfg := a.AccessAllowed()
	if !allowed {
		return demoapp.Fail(403, "ACCESS_DENIED", reason)
	}

	// 1) 建表（DDL 只能走 db.define；幂等：created=false 表示表已存在）。
	from := len(a.Traces())
	created, defineErr := a.Define(tableRuns, runColumns)
	columns := make([]string, 0, len(runColumns))
	for _, c := range runColumns {
		columns = append(columns, c.Name+" "+c.Type)
	}
	defineNote := "表已存在（db.define 幂等，没有报错）"
	if created {
		defineNote = "本次新建了这张表"
	}
	steps = append(steps, makeStep(
		a, stepCall{Key: "define", Title: "建表 · db.define（DDL 的唯一入口）", From: from, Err: defineErr},
		defineNote,
		[]field{
			txt("表名", tableRuns),
			txt("本次是否新建", yesNo(created)),
			code("列声明（"+strconv.Itoa(len(runColumns))+" 列）", strings.Join(columns, ", ")),
			txt("列配额", "每表 ≤16 列、每应用 ≤16 表；类型只有 text/int/real/bool/datetime"),
			txt("保留列", "平台自动追加 _row_id（不占列配额），应用看不到也不能提到它"),
		},
		nil,
	))

	// 2) 写一条（db.exec + 参数化 ?）。
	from = len(a.Traces())
	directDetail := "直写一条：" + marker
	affected, insertErr := insertRunRow(a, marker, "direct", "直写 1 条", directDetail, who, true, elapsedMicros(started))
	steps = append(steps, makeStep(
		a, stepCall{Key: "insert", Title: "写入 · db.exec（值一律走 ? 占位）", From: from, Err: insertErr},
		"插一条、返回受影响行数",
		[]field{
			code("SQL", insertRunSQL),
			txt("绑定参数个数", strconv.Itoa(len(runColumns))),
			txt("受影响行数", strconv.FormatInt(affected, 10)),
			txt("写进去的 detail", directDetail),
			txt("谁写的", who+"（来自帧里的身份，应用没有登录逻辑）"),
		},
		nil,
	))

	// 3) 读回来（db.query，只跑 SELECT；按 marker 过滤在应用侧做）。
	from = len(a.Traces())
	rows, queryErr := a.Query(selectRunSQL, historyLimit)
	mine := rowsByValue(rows, "marker", marker)
	steps = append(steps, makeStep(
		a, stepCall{Key: "select", Title: "查询 · db.query（读回刚写的那条）", From: from, Err: queryErr},
		"这一次查询扫的是整张表最近 "+strconv.Itoa(historyLimit)+" 行，命中的行按 marker 在应用侧筛出来",
		[]field{
			code("SQL", selectRunSQL),
			txt("绑定参数", strconv.Itoa(historyLimit)+"（LIMIT，仍是 ? 占位）"),
			txt("返回列", strings.Join(rows.Columns, ", ")),
			txt("返回行数", strconv.Itoa(len(rows.Rows))),
			txt("是否被截断", yesNo(rows.Truncated)),
			txt("本次 marker 命中", strconv.Itoa(len(mine))+" 行"),
		},
		withTable(rowTable("本次 marker 命中的行（含刚写的那条）", rows, mine)),
	))

	// 4) 事务提交：写两条 + commit，然后重新查询证明"真的落库了"。
	from = len(a.Traces())
	commitAffected, commitOut := txRun(a, marker, "tx_commit", false, who, started)
	afterCommit := queryMarker(a, marker)
	commitErr := firstErr(commitOut.Inner, commitOut.TxErr)
	commitNote := txHeadline("commit", commitOut, commitAffected, len(afterCommit.Rows))
	steps = append(steps, makeStep(
		a, stepCall{Key: "tx_commit", Title: "事务 · 提交（写两条 → commit）", From: from, Err: commitErr},
		commitNote,
		[]field{
			txt("事务协议", "tx_begin → db.exec ×2 → tx_commit（语言侧的 db.tx 原语就是这三步）"),
			txt("commit 的受影响行数", strconv.FormatInt(commitAffected, 10)),
			txt("提交后本次 marker 的行数", strconv.Itoa(len(afterCommit.Rows))),
		},
		withTable(rowTable("提交后库里本次 marker 的行（应有 3 行：直写 1 + 事务 2）", afterCommit, afterCommit.Rows)),
	))

	// 5) 事务回滚：同样写两条，然后 rollback —— 用数据证明这两条没落库。
	from = len(a.Traces())
	rollbackAffected, rollbackOut := txRun(a, marker, "tx_rollback", true, who, started)
	afterRollback := queryMarker(a, marker)
	rolledBackVisible := rowsByValue(afterRollback, "phase", "tx_rollback")
	rollbackErr := firstErr(rollbackOut.Inner, rollbackOut.TxErr)
	rollbackNote := txHeadline("rollback", rollbackOut, rollbackAffected, len(afterRollback.Rows))
	steps = append(steps, makeStep(
		a, stepCall{Key: "tx_rollback", Title: "事务 · 回滚（写两条 → rollback）", From: from, Err: rollbackErr},
		rollbackNote,
		[]field{
			txt("事务协议", "tx_begin → db.exec ×2 → tx_rollback（事务内只允许 db.query / db.exec 与两个出口）"),
			txt("回滚前写入的条数", strconv.FormatInt(rollbackAffected, 10)),
			txt("回滚后可见的 tx_rollback 行", strconv.Itoa(len(rolledBackVisible))+" 行"),
			txt("回滚后本次 marker 的行数", strconv.Itoa(len(afterRollback.Rows))+"（与提交后相同 ⇒ 回滚真的没落库）"),
		},
		withTable(rowTable("回滚后库里本次 marker 的行（tx_rollback 的两条不在这里）", afterRollback, afterRollback.Rows)),
	))

	// 6) 应用日志（单条 ≤4 KiB、每请求 ≤100 条、保留 7 天）。
	from = len(a.Traces())
	logMessage := fmt.Sprintf("showcase 能力自查：user=%s access=%s marker=%s", a.Username(), cfg.Access, marker)
	var logRes abi.LogResult
	logErr := a.Call(abi.MethodLog, abi.LogParams{Level: "info", Message: logMessage}, &logRes)
	steps = append(steps, makeStep(
		a, stepCall{Key: "log", Title: "日志 · log（排障第一手材料）", From: from, Err: logErr},
		"日志落在平台侧，保留 7 天；单条 ≤4 KiB（超限截断），每请求 ≤100 条（超出丢弃并计数）",
		[]field{
			txt("级别", "info"),
			txt("正文", logMessage),
			txt("平台接受条数", strconv.Itoa(logRes.Accepted)),
			txt("被丢弃条数", strconv.Itoa(logRes.Dropped)),
			txt("单条上限", strconv.Itoa(logMaxBytes)+" 字节（超出截断，不拒绝）"),
		},
		nil,
	))

	// 7) 包内资源：入口页（非保留资源）与配置（保留资源）。
	steps = append(steps, assetStep(a, "asset_entry", "包内资源 · assets.read(\"index.html\")", demoapp.EntryAssetPath))
	steps = append(steps, assetStep(a, "asset_config", "保留资源 · assets.read(\"picoaide.app.json\")", demoapp.AppConfigPath))

	// 收尾：把表里最近的行读出来（历史证据）。
	from = len(a.Traces())
	history, historyErr := a.Query(selectRunSQL, historyLimit)
	steps = append(steps, makeStep(
		a, stepCall{Key: "history", Title: "历史 · db.query（最近 " + strconv.Itoa(historyLimit) + " 行）", From: from, Err: historyErr},
		"平台对返回做上限保护：行数或字节超限是「截断」并置 truncated=true，不报错",
		[]field{
			txt("返回行数", strconv.Itoa(len(history.Rows))),
			txt("是否被截断", yesNo(history.Truncated)),
		},
		withTable(rowTable("showcase_runs 最近 "+strconv.Itoa(historyLimit)+" 行", history, history.Rows)),
	))

	return demoapp.JSON(200, map[string]any{
		"marker":       marker,
		"who":          who,
		"started_at":   started.UTC().Format(time.RFC3339Nano),
		"total_micros": elapsedMicros(started),
		"steps":        steps,
		"traces":       a.Traces(),
		"notes": []string{
			"每一步的耗时 = 这一步真实发生的宿主调用（app.Traces() 片段）之和，单位微秒；不是估的。",
			"事务提交与回滚都用同一个 marker 写行：回滚那两条在库里查不到，就是回滚生效的证据。",
			"平台上限：单语句 5s、guest 10s/请求、返回 5000 行或 8 MiB（超限截断）。",
		},
	})
}

// ---------------------------------------------------------------------------
// POST /api/tx —— 只跑事务（页面上「提交」「回滚」两个按钮）
// ---------------------------------------------------------------------------

type txRequest struct {
	Mode string `json:"mode"`
}

func handleTx(a *demoapp.App) demoapp.Response {
	var req txRequest
	if a.Req.Body != "" && !a.BodyJSON(&req) {
		return demoapp.Fail(400, "VALIDATION", `请求体必须是 {"mode":"commit"|"rollback"}`)
	}
	mode := strings.TrimSpace(req.Mode)
	if mode == "" {
		mode = "commit"
	}
	if mode != "commit" && mode != "rollback" {
		return demoapp.Fail(400, "VALIDATION", `mode 只能是 "commit" 或 "rollback"，收到：`+mode)
	}

	allowed, reason, _ := a.AccessAllowed()
	if !allowed {
		return demoapp.Fail(403, "ACCESS_DENIED", reason)
	}

	started := time.Now()
	marker := newMarker()
	who := a.DisplayName()
	steps := make([]step, 0, 2)

	// 表要先存在（db.define 幂等）。
	from := len(a.Traces())
	created, defineErr := a.Define(tableRuns, runColumns)
	steps = append(steps, makeStep(
		a, stepCall{Key: "define", Title: "建表 · db.define（幂等）", From: from, Err: defineErr},
		"事务演示前先确保表存在",
		[]field{
			txt("表名", tableRuns),
			txt("本次是否新建", yesNo(created)),
		},
		nil,
	))

	from = len(a.Traces())
	affected, out := txRun(a, marker, "tx_"+mode, mode == "rollback", who, started)
	rows := queryMarker(a, marker)
	visible := rowsByValue(rows, "phase", "tx_"+mode)

	title := "事务 · 提交（写两条 → commit）"
	if mode == "rollback" {
		title = "事务 · 回滚（写两条 → rollback）"
	}
	verdict := txHeadline(mode, out, affected, len(visible))

	steps = append(steps, makeStep(
		a, stepCall{Key: "tx", Title: title, From: from, Err: firstErr(out.Inner, out.TxErr)},
		verdict,
		[]field{
			txt("事务协议", "tx_begin → db.exec ×2 → tx_"+mode+"（事务内只允许 db.query / db.exec 与两个出口）"),
			txt("写入条数（受影响行数）", strconv.FormatInt(affected, 10)),
			txt("本次 marker 在库里的行数", strconv.Itoa(len(rows.Rows))),
			txt("本次 marker 里 tx_"+mode+" 的行", strconv.Itoa(len(visible))+" 行"),
		},
		withTable(rowTable("本次 marker 的行（"+mode+" 之后）", rows, rows.Rows)),
	))

	return demoapp.JSON(200, map[string]any{
		"marker":       marker,
		"mode":         mode,
		"affected":     affected,
		"visible_rows": len(visible),
		"total_rows":   len(rows.Rows),
		"verdict":      verdict,
		"steps":        steps,
		"traces":       a.Traces(),
	})
}

// txRun 在事务里写两条记录：wantRollback=false 提交、true 主动回滚。
//
// 返回的 txOutcome 把三种"不成功"分开，页面才能如实显示：
//   - Inner：事务体内**真实的**宿主调用失败（平台拒绝）；
//   - TxErr：tx_begin / tx_commit / tx_rollback 这一层的问题；
//   - RolledBack：事务确实回滚了（主动回滚也算，那是**预期结果**不是失败）。
func txRun(a *demoapp.App, marker, phase string, wantRollback bool, who string, started time.Time) (int64, txOutcome) {
	var out txOutcome
	var affected int64
	err := a.Tx(func() error {
		for i := 1; i <= 2; i++ {
			label := fmt.Sprintf("%s %d/2", phaseLabel(phase), i)
			detail := fmt.Sprintf("事务 %s 的第 %d 条：marker=%s", phase, i, marker)
			n, herr := insertRunRow(a, marker, phase, label, detail, who, true, elapsedMicros(started))
			if herr != nil {
				// 事务体内失败：返回 error 让包装器回滚（demoapp.Tx 的契约）。
				out.Inner = herr
				return errors.New(herr.Error())
			}
			affected += n
		}
		if wantRollback {
			out.RolledBack = true
			return errors.New("演示：主动回滚（这两条不应该留在库里）")
		}
		return nil
	})
	if err != nil {
		if isRollbackSentinel(err) {
			out.RolledBack = true
		} else {
			out.TxErr = err
		}
	}
	return affected, out
}

// txOutcome 见 txRun 的说明。
type txOutcome struct {
	RolledBack bool
	Inner      *demoapp.HostError
	TxErr      *demoapp.HostError
}

// txHeadline 把事务结果写成一句话（页面直接显示这句）。
//
// 三种情况必须分开说，否则排障时会误判：协议层失败 / 事务体内失败 / 按设计提交或回滚。
func txHeadline(mode string, out txOutcome, affected int64, visible int) string {
	switch {
	case out.TxErr != nil:
		return "事务没有跑起来（tx_begin / tx_commit / tx_rollback 这一层失败）：" +
			out.TxErr.Error() + txDiagnostic(out.TxErr)
	case out.Inner != nil:
		return fmt.Sprintf("事务体内出错 ⇒ 平台强制回滚：本次 %d 条写入全部撤销，回滚后本次 marker 可见 %d 行",
			affected, visible)
	case mode == "rollback":
		return fmt.Sprintf("已回滚：事务里写了两条（受影响行数 %d），回滚后库里本次 marker 可见 %d 行 —— 回滚真的没落库",
			affected, visible)
	default:
		return fmt.Sprintf("已提交：事务里写了两条（受影响行数 %d），提交后库里本次 marker 可见 %d 行",
			affected, visible)
	}
}

// txDiagnostic 在"宿主压根不认识事务原语"时补一句可执行的判断。
//
// 触发条件很具体：`tx_begin` 回 NOT_FOUND（宿主方法不存在）。真实平台不该出现它；
// 本地预览的假宿主只应答 db.define / db.query / db.exec / log / assets.read，所以
// 第一次在本地预览时会看到 —— 与其让人以为应用坏了，不如把这句话显示出来。
func txDiagnostic(herr *demoapp.HostError) string {
	if herr == nil || herr.Code != "NOT_FOUND" {
		return ""
	}
	return "（宿主不认识事务原语：本次没有发生任何提交或回滚 —— 本地预览宿主只应答 db.define / db.query / db.exec / log / assets.read；平台宿主上这一步会真的落库或回滚。）"
}

// phaseLabel 是给行标签用的中文前缀。
func phaseLabel(phase string) string {
	switch phase {
	case "direct":
		return "直写"
	case "tx_commit":
		return "事务提交"
	case "tx_rollback":
		return "事务回滚"
	}
	return phase
}

// insertRunRow 写一行证据。
//
// micros 列的含义是「写入这一行的时刻，距本次请求开始多少微秒」——它在写入**之前**
// 就能算出来（每步真实的宿主调用耗时另由 app.Traces() 片段给出）。
func insertRunRow(a *demoapp.App, marker, phase, label, detail, who string, ok bool, micros int64) (int64, *demoapp.HostError) {
	return a.Exec(insertRunSQL,
		time.Now().UTC().Format(time.RFC3339Nano),
		phase, label, detail, who, ok, micros, marker,
	)
}

// queryMarker 把整表最近 N 行读出来，再在**应用侧**筛出本次 marker 的行。
//
// 为什么不在 SQL 里写 WHERE marker = ?：这一条查询在本地预览宿主（preview.mjs）里
// 也要能跑通，而预览宿主只认 `SELECT <列…> FROM <表> [ORDER BY created_at DESC] [LIMIT ?]`
// 这一种最小形态。把筛选放在应用侧，两边语义一致，也不会因为宿主能力差异产生假象。
func queryMarker(a *demoapp.App, marker string) demoapp.Rows {
	rows, herr := a.Query(selectRunSQL, historyLimit)
	if herr != nil {
		return demoapp.Rows{Columns: []string{"错误"}, Rows: [][]any{{herr.Code + ": " + herr.Message}}}
	}
	return demoapp.Rows{Columns: rows.Columns, Rows: rowsByValue(rows, "marker", marker), Truncated: rows.Truncated}
}

// ---------------------------------------------------------------------------
// POST /api/log —— 只写一条日志
// ---------------------------------------------------------------------------

type logRequest struct {
	Message string `json:"message"`
}

func handleLog(a *demoapp.App) demoapp.Response {
	var req logRequest
	if a.Req.Body != "" && !a.BodyJSON(&req) {
		return demoapp.Fail(400, "VALIDATION", `请求体必须是 {"message":"…"}`)
	}
	message := strings.TrimSpace(req.Message)
	if message == "" {
		message = defaultLogMessage
	}
	// 页面上限 400 字；平台上限 4 KiB（超限截断）。这里如实回显最终写进去的正文。
	if len(message) > logMaxBytes {
		message = message[:logMaxBytes]
	}
	message = fmt.Sprintf("[%s] %s", a.Username(), message)

	from := len(a.Traces())
	var res abi.LogResult
	herr := a.Call(abi.MethodLog, abi.LogParams{Level: "info", Message: message}, &res)
	one := makeStep(
		a, stepCall{Key: "log", Title: "日志 · log", From: from, Err: herr},
		"写一条应用日志：平台保留 7 天，是排障的第一手材料",
		[]field{
			txt("级别", "info"),
			txt("正文（字节数 "+strconv.Itoa(len(message))+"）", message),
			txt("平台接受条数", strconv.Itoa(res.Accepted)),
			txt("被丢弃条数", strconv.Itoa(res.Dropped)),
		},
		nil,
	)

	return demoapp.JSON(200, map[string]any{
		"message": message,
		"steps":   []step{one},
		"traces":  a.Traces(),
	})
}

// ---------------------------------------------------------------------------
// GET /api/runs —— 历史证据
// ---------------------------------------------------------------------------

func handleRuns(a *demoapp.App) demoapp.Response {
	limit := historyLimit
	if raw := strings.TrimSpace(a.QueryParam("limit")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > runsLimitMax {
		limit = runsLimitMax
	}

	allowed, reason, _ := a.AccessAllowed()
	if !allowed {
		return demoapp.Fail(403, "ACCESS_DENIED", reason)
	}

	// 表可能还没建（例如用户直接刷新页面就点了「历史」）⇒ 先幂等建表。
	if _, herr := a.Define(tableRuns, runColumns); herr != nil {
		return demoapp.Fail(500, herr.Code, "建表失败："+herr.Message)
	}
	rows, herr := a.Query(selectRunSQL, limit)
	if herr != nil {
		return demoapp.Fail(500, herr.Code, "查询失败："+herr.Message)
	}

	return demoapp.JSON(200, map[string]any{
		"limit":     limit,
		"row_count": len(rows.Rows),
		"truncated": rows.Truncated,
		"table":     rowTable("showcase_runs 最近 "+strconv.Itoa(limit)+" 行", rows, rows.Rows),
		"note":      "这是应用库里的真实数据：不随客户端清缓存 / 切账号丢失（与 localStorage 那类可再生存储不同）。",
		"traces":    a.Traces(),
	})
}

// ---------------------------------------------------------------------------
// /api/denied —— 故意违规，把平台的拒绝原样渲染
// ---------------------------------------------------------------------------

// deniedVariant 是一种"故意违规"的形态。
//
// ExpectedCode 是文档给出的预期；页面会把"预期"与"本次实际"并排显示 —— 不一致时
// 明确标出来（本地预览宿主的闸门比平台窄，不一致本身就是有用的信息）。
type deniedVariant struct {
	Kind         string `json:"kind"`
	Title        string `json:"title"`
	Why          string `json:"why"`
	ExpectedCode string `json:"expected_code"`
	Call         string `json:"call"`
}

func deniedVariants() []deniedVariant {
	return []deniedVariant{
		{
			Kind: "reserved_column", Title: "SQL 里提到保留列 _row_id",
			Why:          "保留列应用看不到也不能提到；alias（rowid / _rowid_ / oid）一视同仁",
			ExpectedCode: "DB_DENIED", Call: `db.query: SELECT phase FROM showcase_runs WHERE _row_id > ?`,
		},
		{
			Kind: "reserved_alias", Title: "用别名 rowid 绕过",
			Why:          "带引号 / 裸词走同一个闸门：引号不是绕过路径",
			ExpectedCode: "DB_DENIED", Call: `db.query: SELECT rowid, phase FROM showcase_runs LIMIT ?`,
		},
		{
			Kind: "with_cte", Title: "带 WITH 的查询（CTE）",
			Why:          "平台一律拒 WITH（含非递归 CTE）：漏放递归 CTE 的代价是一次资源耗尽",
			ExpectedCode: "DB_DENIED", Call: `db.query: WITH recent AS (…) SELECT … FROM recent LIMIT ?`,
		},
		{
			Kind: "multi_statement", Title: "一条里塞两条语句",
			Why:          "一次只能一条语句：分号后还有内容即拒",
			ExpectedCode: "DB_DENIED", Call: `db.query: SELECT phase FROM showcase_runs LIMIT ?; SELECT 1`,
		},
		{
			Kind: "ddl_direct", Title: "绕过 db.define 直接跑 DDL",
			Why:          "建表只能走 db.define；db.exec 只跑 INSERT / UPDATE / DELETE",
			ExpectedCode: "DB_DENIED", Call: `db.exec: CREATE TABLE showcase_hack (x text)`,
		},
		{
			Kind: "tx_log", Title: "事务里调 log",
			Why:          "事务内只允许 db.query / db.exec 与两个出口；log 会长时间阻塞 ⇒ kind=blocking_capability",
			ExpectedCode: "DB_DENIED", Call: `tx_begin → log → tx_rollback`,
		},
		{
			Kind: "tx_define", Title: "事务里 db.define",
			Why:          "事务里不允许 DDL ⇒ kind=ddl：建表请在事务外做",
			ExpectedCode: "DB_DENIED", Call: `tx_begin → db.define → tx_rollback`,
		},
		{
			Kind: "tx_nested", Title: "事务里再开一个事务",
			Why:          "事务不可嵌套 ⇒ kind=nested_tx",
			ExpectedCode: "DB_DENIED", Call: `tx_begin → tx_begin`,
		},
	}
}

func handleDenied(a *demoapp.App) demoapp.Response {
	// GET：只返回可选的违规形态（页面用它渲染按钮，保证前后端同一份清单）。
	if a.Req.Method != "POST" {
		return demoapp.JSON(200, map[string]any{
			"variants": deniedVariants(),
			"note":     "用 POST {\"kind\":\"…\"} 触发一次故意违规，平台回的 code / message / details / hints 会原样返回。",
		})
	}

	var req struct {
		Kind string `json:"kind"`
	}
	if a.Req.Body != "" && !a.BodyJSON(&req) {
		return demoapp.Fail(400, "VALIDATION", `请求体必须是 {"kind":"…"}`)
	}
	kind := strings.TrimSpace(req.Kind)
	if kind == "" {
		kind = deniedVariants()[0].Kind
	}
	variant, ok := findVariant(kind)
	if !ok {
		return demoapp.Fail(400, "VALIDATION", "未知的违规形态："+kind)
	}

	allowed, reason, _ := a.AccessAllowed()
	if !allowed {
		return demoapp.Fail(403, "ACCESS_DENIED", reason)
	}

	// 先确保表存在：否则"表不存在"的错误会盖住我们真正要演示的那条拒绝。
	_, _ = a.Define(tableRuns, runColumns)

	started := time.Now()
	herr := triggerDenied(a, kind)
	matched := herr != nil && herr.Code == variant.ExpectedCode

	actual := map[string]any{"denied": herr != nil, "code": "", "message": ""}
	if herr != nil {
		actual["code"] = herr.Code
		actual["message"] = herr.Message
	} else {
		actual["code"] = "(宿主没有拒绝)"
		actual["message"] = "这次调用成功了 —— 与文档预期不一致，页面会标出来"
	}

	return demoapp.JSON(200, map[string]any{
		"kind":             variant.Kind,
		"title":            variant.Title,
		"why":              variant.Why,
		"call":             variant.Call,
		"expected_code":    variant.ExpectedCode,
		"matches_expected": matched,
		"actual":           actual,
		"error":            errorViewOf(herr),
		"envelope":         envelopeText(herr),
		"trace_micros":     elapsedMicros(started),
		"traces":           a.Traces(),
		"note": "error 里的 code / message / details / hints 是宿主（平台）原样回的 JSON-RPC 错误；" +
			"应用侧不做任何改写。matches_expected=false 表示本次宿主没有按文档拒绝（本地预览宿主的闸门比平台窄）。",
	})
}

// triggerDenied 执行一次故意违规，返回平台给的错误（nil = 没被拒）。
func triggerDenied(a *demoapp.App, kind string) *demoapp.HostError {
	switch kind {
	case "reserved_column":
		_, herr := a.Query("SELECT phase FROM showcase_runs WHERE _row_id > ?", 0)
		return herr
	case "reserved_alias":
		_, herr := a.Query("SELECT rowid, phase FROM showcase_runs LIMIT ?", 5)
		return herr
	case "with_cte":
		_, herr := a.Query("WITH recent AS (SELECT phase FROM showcase_runs) SELECT phase FROM recent LIMIT ?", 5)
		return herr
	case "multi_statement":
		_, herr := a.Query("SELECT phase FROM showcase_runs LIMIT ?; SELECT 1", 5)
		return herr
	case "ddl_direct":
		_, herr := a.Exec("CREATE TABLE showcase_hack (x text)")
		return herr
	case "tx_log":
		return deniedInsideTx(a, func() *demoapp.HostError {
			var res abi.LogResult
			return a.Call(abi.MethodLog, abi.LogParams{Level: "info", Message: "试图在事务里写日志"}, &res)
		})
	case "tx_define":
		return deniedInsideTx(a, func() *demoapp.HostError {
			_, herr := a.Define("showcase_hack", []demoapp.Column{{Name: "x", Type: "text"}})
			return herr
		})
	case "tx_nested":
		return deniedInsideTx(a, func() *demoapp.HostError {
			var begin abi.TxResult
			return a.Call(abi.MethodTxBegin, struct{}{}, &begin)
		})
	}
	return nil
}

// deniedInsideTx 在一个事务里执行 action，无论结果如何都把事务收干净。
func deniedInsideTx(a *demoapp.App, action func() *demoapp.HostError) *demoapp.HostError {
	var begin abi.TxResult
	if herr := a.Call(abi.MethodTxBegin, struct{}{}, &begin); herr != nil {
		return herr
	}
	inner := action()
	var rolled abi.TxResult
	if herr := a.Call(abi.MethodTxRollback, abi.TxParams{TxID: begin.TxID}, &rolled); herr != nil && inner == nil {
		return herr
	}
	return inner
}

func findVariant(kind string) (deniedVariant, bool) {
	for _, v := range deniedVariants() {
		if v.Kind == kind {
			return v, true
		}
	}
	return deniedVariant{}, false
}

// envelopeText 把宿主错误还原成 JSON-RPC 错误信封的原文（页面原样显示这一段）。
func envelopeText(herr *demoapp.HostError) string {
	if herr == nil {
		return "(这次调用没有失败，所以没有错误信封)"
	}
	body := map[string]any{"code": herr.Code, "message": herr.Message}
	if len(herr.Details) > 0 {
		body["details"] = herr.Details
	}
	raw, err := json.MarshalIndent(map[string]any{"jsonrpc": "2.0", "id": 1, "error": body}, "", "  ")
	if err != nil {
		return herr.Error()
	}
	return string(raw)
}

// ---------------------------------------------------------------------------
// 兜底：宿主没有直出的包内资源
// ---------------------------------------------------------------------------

// serveAsset 在 wasm 里读一次包内资源（宿主直出没命中时才会走到）。
//
// 保留资源与宿主命名空间**必须**在这里挡住：`picoaide.app.json` 里有名单，
// 平台永不直出它，应用自己也不能把它当普通资源发出去。
func serveAsset(a *demoapp.App) (demoapp.Response, bool) {
	logical := strings.TrimPrefix(a.Path(), "/")
	if logical == "" {
		return demoapp.Response{}, false
	}
	if strings.EqualFold(logical, demoapp.AppConfigPath) {
		return demoapp.Fail(404, "NOT_FOUND", "保留资源不对外直出：它只由应用自己用 assets.read 读取"), true
	}
	if logical == "__picoaide" || strings.HasPrefix(logical, "__picoaide/") {
		return demoapp.Fail(404, "NOT_FOUND", "宿主保留命名空间：请求到不了应用，这里只是兜底"), true
	}
	asset, herr := a.AssetRead(logical)
	if herr != nil {
		return demoapp.Response{}, false
	}
	headers := map[string]string{"content-type": asset.ContentType}
	switch asset.Encoding {
	case abi.EncodingText:
		return demoapp.Response{Status: 200, Headers: headers, Body: asset.Text}, true
	case abi.EncodingEmpty:
		return demoapp.Response{Status: 200, Headers: headers, Body: ""}, true
	default:
		// 本应用不随包携带二进制素材（平台总量上限 4 MiB，图片/字体一律用内联 SVG + CSS）。
		return demoapp.Fail(415, "ASSET_BINARY", "这个资源是二进制（encoding=base64），本应用不直出二进制素材"), true
	}
}

// ---------------------------------------------------------------------------
// 响应零件（字段 / 表格 / 步骤 / 错误）
// ---------------------------------------------------------------------------

// field 是一行「标签 → 值」。全部是字符串：前端只用 textContent 渲染，不拼 HTML。
type field struct {
	Label string `json:"label"`
	Value string `json:"value"`
	Kind  string `json:"kind,omitempty"` // 空 = 普通文本；mono = 等宽；code = 等宽可换行长文本
}

// tableView 是一张表（列名 + 行，单元格同样是字符串）。
type tableView struct {
	Title   string     `json:"title"`
	Columns []string   `json:"columns"`
	Rows    [][]string `json:"rows"`
	Note    string     `json:"note,omitempty"`
}

// errorView 是宿主错误的结构化视图（code / message / details / hints 原样带上）。
type errorView struct {
	Method  string         `json:"method"`
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
	Hints   []string       `json:"hints"`
	JSON    string         `json:"json"`
}

// step 是一个能力步骤的结果。
type step struct {
	Key    string      `json:"key"`
	Title  string      `json:"title"`
	OK     bool        `json:"ok"`
	Micros int64       `json:"micros"`
	Note   string      `json:"note"`
	Error  *errorView  `json:"error,omitempty"`
	Fields []field     `json:"fields"`
	Tables []tableView `json:"tables,omitempty"`
}

// stepCall 是一次宿主调用的上下文：步骤标识 + 它在 traces 里的起始下标 + 结果错误。
type stepCall struct {
	Key   string
	Title string
	From  int
	Err   *demoapp.HostError
}

// makeStep 组装一个步骤。
//
// Micros 取「这一步真实发生的宿主调用耗时之和」（app.Traces() 的片段），不是估的：
// 页面上的数字因此可以被时间线逐条对上。
func makeStep(a *demoapp.App, call stepCall, note string, fields []field, tables []tableView) step {
	window := traceWindow(a, call.From)
	out := step{
		Key:    call.Key,
		Title:  call.Title,
		OK:     call.Err == nil,
		Micros: microsOf(window),
		Note:   note,
		Fields: fields,
		Tables: tables,
	}
	if call.Err != nil {
		out.Error = errorViewOf(call.Err)
	}
	return out
}

// assetStep 是"读一个包内资源并显示 content_type / size / encoding"的步骤。
func assetStep(a *demoapp.App, key, title, path string) step {
	from := len(a.Traces())
	asset, herr := a.AssetRead(path)
	fields := []field{
		txt("包内逻辑路径", path),
		txt("content_type", asset.ContentType),
		txt("size", strconv.Itoa(asset.Size)+" 字节"),
		txt("encoding", asset.Encoding+"（判别字段：text 读 text 字段、base64 读 base64 字段、empty 表示零字节）"),
	}
	note := "非保留资源会被宿主按路径直出，但入口页必须由 wasm 读出来再返回（否则名单判定就没有机会执行）"
	if strings.EqualFold(path, demoapp.AppConfigPath) {
		note = "保留资源：宿主「永不直出」，只有应用自己用 assets.read 读得到 —— 名单放这里才安全"
		preview := asset.Text
		if len(preview) > 160 {
			preview = preview[:160] + "…"
		}
		fields = append(fields, txt("前 160 字节", preview))
	} else {
		fields = append(fields, txt("正文长度", strconv.Itoa(len(asset.Text))+" 字符（页面里的 HTML 就是它）"))
	}
	// 预算是 8 MiB，这里不展示全文；只给出长度与元数据。
	return makeStep(
		a, stepCall{Key: key, Title: title, From: from, Err: herr},
		note,
		fields,
		nil,
	)
}

// rowTable 用「列名 + 白名单行」构造表格；rows 为空时给一句说明。
func rowTable(title string, all demoapp.Rows, selected [][]any) tableView {
	out := tableView{Title: title, Columns: all.Columns, Rows: [][]string{}}
	for _, row := range selected {
		line := make([]string, 0, len(row))
		for _, cell := range row {
			line = append(line, demoapp.Stringify(cell))
		}
		out.Rows = append(out.Rows, line)
	}
	if len(out.Rows) == 0 {
		out.Note = "0 行 —— 这正是「什么都没落库」的证据"
	}
	return out
}

func txt(label, value string) field  { return field{Label: label, Value: value} }
func code(label, value string) field { return field{Label: label, Value: value, Kind: "code"} }

// withTable 把一张表包成「步骤的表格列表」（调用点读起来短一点）。
func withTable(t tableView) []tableView { return []tableView{t} }

// traceWindow 返回 traces 中从 from 起的这一段（即某一步真实发生的宿主调用）。
func traceWindow(a *demoapp.App, from int) []demoapp.Trace {
	all := a.Traces()
	if from < 0 || from > len(all) {
		return nil
	}
	return all[from:]
}

// microsOf 是一段 traces 的耗时之和（微秒）。
func microsOf(traces []demoapp.Trace) int64 {
	var total int64
	for _, t := range traces {
		total += t.Micros
	}
	return total
}

// firstErr 取两个错误里第一个非 nil 的。
func firstErr(a, b *demoapp.HostError) *demoapp.HostError {
	if a != nil {
		return a
	}
	return b
}

// isRollbackSentinel 判定 demoapp.Tx 的"主动/被动回滚"结果。
//
// demoapp.Tx 的契约：fn 返回 error ⇒ rollback，并把结果报成
// `HostError{Method:"tx_commit", Code:"ROLLED_BACK"}`。这不是平台的业务失败，
// 而是包装器说明"事务已按设计回滚"，所以页面按成功显示。
func isRollbackSentinel(err *demoapp.HostError) bool {
	return err != nil && err.Code == "ROLLED_BACK"
}

func errorViewOf(herr *demoapp.HostError) *errorView {
	if herr == nil {
		return nil
	}
	out := &errorView{
		Method:  herr.Method,
		Code:    herr.Code,
		Message: herr.Message,
		Details: herr.Details,
		Hints:   extractHints(herr.Details),
	}
	if len(herr.Details) > 0 {
		if raw, err := json.MarshalIndent(herr.Details, "", "  "); err == nil {
			out.JSON = string(raw)
		}
	}
	return out
}

// extractHints 把 details 里的 hint / hints 抽成列表（演示的重点：平台给的是"怎么改"）。
func extractHints(details map[string]any) []string {
	out := []string{}
	if details == nil {
		return out
	}
	if hint, ok := details["hint"].(string); ok && hint != "" {
		out = append(out, hint)
	}
	switch hs := details["hints"].(type) {
	case []any:
		for _, v := range hs {
			if s, ok := v.(string); ok && s != "" {
				out = append(out, s)
			}
		}
	case []string:
		for _, s := range hs {
			if s != "" {
				out = append(out, s)
			}
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// 小工具：帧字段、行筛选
// ---------------------------------------------------------------------------

func elapsedMicros(started time.Time) int64 { return time.Since(started).Microseconds() }

// rowsByValue 返回 column 列等于 want 的行（列名不存在时返回空）。
func rowsByValue(rows demoapp.Rows, column, want string) [][]any {
	idx := -1
	for i, name := range rows.Columns {
		if name == column {
			idx = i
			break
		}
	}
	out := [][]any{}
	if idx < 0 {
		return out
	}
	for _, row := range rows.Rows {
		if idx < len(row) && demoapp.Stringify(row[idx]) == want {
			out = append(out, row)
		}
	}
	return out
}

func headerKeys(a *demoapp.App) []string {
	keys := make([]string, 0, len(a.Req.Headers))
	for k := range a.Req.Headers {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func queryKeys(a *demoapp.App) []string {
	keys := make([]string, 0, len(a.Req.Query))
	for k := range a.Req.Query {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// cookieHeaderText 说明"帧里的 headers 不含 Cookie"这条平台事实。
func cookieHeaderText(a *demoapp.App) string {
	for k := range a.Req.Headers {
		if strings.EqualFold(k, "cookie") {
			return "存在（与平台契约不符，请报告）"
		}
	}
	return "不存在 —— 平台剥离了 Cookie，帧里的 headers 不含它"
}

func userIDText(a *demoapp.App) string {
	if a.Req.User == nil {
		return ""
	}
	return strconv.FormatInt(a.Req.User.ID, 10)
}

func userDeptText(a *demoapp.App) string {
	if a.Req.User == nil {
		return ""
	}
	return a.Req.User.Dept
}

func yesNo(v bool) string {
	if v {
		return "是"
	}
	return "否"
}

// brandMarkup 是品牌 mark 的内联 SVG（几何取自仓库品牌真源 brands/official/logo.svg：
// 圆角方块底板 + 一对花括号 + 连接线 + 两个节点圆，1.25× 放大）。
// 浅色用黑底白 mark、深色用白底黑 mark（与 logo.svg / logo-dark.svg 的关系一致，
// 颜色由 CSS 变量切换，几何一字不改）。
func brandMarkup(class string) string {
	return `<svg class="` + class + `" viewBox="0 0 1254 1254" aria-hidden="true" focusable="false">` +
		`<rect x="0" y="0" width="1254" height="1254" rx="180" fill="var(--mark-tile)"/>` +
		`<g transform="translate(627 627) scale(1.25) translate(-627 -627)">` +
		`<path d="M 334 409 C 300 409 273 431 273 466 V 548 C 273 582 254 607 220 620 C 254 633 273 658 273 692 V 775 C 273 810 300 843 334 843" fill="none" stroke="var(--mark-ink)" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/>` +
		`<path d="M 920 409 C 954 409 981 431 981 466 V 548 C 981 582 1000 607 1034 620 C 1000 633 981 658 981 692 V 775 C 981 810 954 843 920 843" fill="none" stroke="var(--mark-ink)" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/>` +
		`<line x1="435" y1="627" x2="817" y2="627" stroke="var(--mark-ink)" stroke-width="20" stroke-linecap="round"/>` +
		`<circle cx="435" cy="627" r="65" fill="var(--mark-ink)"/>` +
		`<circle cx="817" cy="627" r="65" fill="var(--mark-ink)"/>` +
		`</g></svg>`
}
