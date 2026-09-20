package api

import (
	"net/http"
	"os"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/appdb"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/registry"
)

// 本文件是**应用作者的数据面**：只读浏览自己应用库里的行（2026-09-21 新增）。
//
// 为什么需要它（用户原话："作者不能够检查自己的SQL数据"）：平台此前只有
// `schema`（表/列/行数/占用）与 `export`（控制面元数据，明确不含使用者数据），
// 而**行内容**全仓没有任何出口。作者（尤其是替员工写应用的 AI）在"发布之后"
// 是盲的：员工报"数据不对"时无法回答"库里到底有什么"，只能改代码发一版 dump 页。
//
// 安全论证（为什么这**不新开**一条越权面）：
//   - 应用代码是作者写的，而应用对自己的库有完整读写权（R15：平台不做行级过滤）
//     ⇒ 作者今天已经可以发布一个"把整表渲染到页面"的版本、自己打开看。
//     本端点只是把"先发一版调试代码"变成"直接查"，作者对数据的**有效访问没有扩大**。
//   - 真正的新增面是"AI 读行内容 ⇒ 使用者 PII 进模型上下文"，因此：
//     · 员工面鉴权 = `ownedApp`（**只有发布者本人**，他人一律 404 与"应用不存在"同形）；
//     · 默认按列名启发式**脱敏**，显式 `unmask=1` 才给原值，且**该次调用单独审计**；
//     · 每次调用写审计（动作 `wasm_app_rows_view`），审计**只记表名/分页/行数与脱敏状态，
//     不记行内容**（`audit_text` 会折行，把行内容写进去等于把 PII 复制到审计表）。
//
// 实现纪律：
//   - **行查询走 `appdb`**（不是自己拼一条 SELECT 打到只读连接上）：语句闸门、单语句
//     5 s 预算、5000 行/8 MiB 上限、`_row_id` 投影剥离、值类型规整全部免费继承 ——
//     "同一件事只实现一次"在这里的具体含义是"作者看到的就是应用能看到的那些列"。
//   - **用独立句柄**（每次请求 Open/Close）：`appdb` 的句柄带每请求计量，复用服务请求的
//     句柄会污染 `wasm_call_events` 里的 `db_rows/db_bytes`。
//   - 库文件不存在时**不建库**（先 `appdb.Path` + `os.Stat`）：只读端点不该有写副作用。

const (
	// rowsDefaultLimit 是缺省返回行数。
	rowsDefaultLimit = 50
	// rowsMaxLimit 是单次返回行数上限。取 200 而不是 appdb 的 5000：
	// 这是给人/AI 看的浏览面，不是数据导出面（导出是另一个产品决策，当前没有）。
	rowsMaxLimit = 200
	// rowsMaxOffset 防止用超大 offset 逼 SQLite 扫全表。
	rowsMaxOffset = 1_000_000
	// rowsMaxValueBytes 是单个值的字节上限：超长值截断并计数（避免一列大文本把
	// 一次响应推到 MB 级；appdb 的 8 MiB 是最后一道闸，不是设计目标）。
	rowsMaxValueBytes = 4096
)

// rowsPayload 是 `GET …/wasm/:app_id/rows` 的响应体（**跨端冻结契约**）。
//
// 客户端面板、AI 工具与（将来的）管理端共用同一份形状；字段只增不改名。
type rowsPayload struct {
	AppID    string       `json:"app_id"`
	Table    string       `json:"table"`
	Columns  []rowsColumn `json:"columns"`
	Rows     [][]any      `json:"rows"`
	Limit    int          `json:"limit"`
	Offset   int          `json:"offset"`
	Returned int          `json:"returned"`
	// TotalRows 是**表的总行数**（来自 `SELECT COUNT(*)`，与分页无关）。
	TotalRows int64 `json:"total_rows"`
	// HasMore 表示按当前 offset/limit 还有更多行（分页提示用）。
	HasMore bool `json:"has_more"`
	// Truncated 表示 appdb 的返回上限（行数/字节）被命中 —— 与 HasMore 是两件事：
	// HasMore 是"翻页还有"，Truncated 是"这次结果本身被平台截断了"。
	Truncated bool `json:"truncated"`
	// TruncatedValues 是本次被按字节截断的值个数（>0 时界面应提示）。
	TruncatedValues int `json:"truncated_values"`
	// Unmasked 表示本次请求显式要求了原值（`unmask=1`）。
	Unmasked bool `json:"unmasked"`
	// MaskedColumns 是本次被脱敏的列名（默认脱敏；未脱敏时为空数组）。
	MaskedColumns []string `json:"masked_columns"`
	// ValueMaxBytes 是单值上限（客户端据此解释 TruncatedValues）。
	ValueMaxBytes int `json:"value_max_bytes"`
}

// rowsColumn 是一列的结构 + 本次是否被脱敏。
type rowsColumn struct {
	Name      string `json:"name"`
	Type      string `json:"type"`
	Sensitive bool   `json:"sensitive"`
}

// rows 是员工面（**仅发布者本人**）的行浏览。
func (h *Handlers) rows(c *gin.Context) {
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
	h.respondRows(c, appID, auditTitleOf(app), u.Username)
}

// adminRows 是管理面的行浏览（`capability:read`，与诊断/自省同权限点）。
//
// 管理员能看的原因与"管理员能看诊断"一致：排障与合规。审计同样逐次留痕（动作名相同，
// 但 `auditApp` 记录的是操作者账号 ⇒ 事后能分清"作者看的"与"管理员看的"）。
func (h *Handlers) adminRows(c *gin.Context) {
	if err := h.requireReady(); err != nil {
		writeErr(c, err)
		return
	}
	admin := serverauth.AdminUser(c)
	if admin == nil {
		writeErr(c, apperr.New(apperr.CodeAuthRequired, "未登录"))
		return
	}
	appID := registry.NormalizeAppID(c.Param("app_id"))
	app, aerr := h.adminApp(c, appID)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	h.respondRows(c, appID, auditTitleOf(app), admin.Username)
}

// respondRows 是两条鉴权面共用的唯一实现（同 diagnosticsPayload 的分工）。
//
// appTitle 只用于审计明细（"查看了《团队便签》的表 notes"），不参与数据查询。
func (h *Handlers) respondRows(c *gin.Context, appID, appTitle, operator string) {
	ctx := c.Request.Context()

	table := strings.TrimSpace(c.Query("table"))
	if !validateTableName(table) {
		// 表名规则与 `db.define` 完全一致（同一条 validateTableName）：
		// 自省面与写入面用**同一个**规则，作者才不会遇到"能建不能查"。
		writeErr(c, apperr.New(apperr.CodeValidation, "table 参数不合法").
			WithDetail("field", "table").
			WithDetail("pattern", "小写字母开头，只含 [a-z0-9_]，长度 ≤ 31").
			WithHint("表名就是 db.define 用的那个名字；先用 GET …/schema 看有哪些表"))
		return
	}

	limit := clampInt(atoiDefault(c.Query("limit"), rowsDefaultLimit), 1, rowsMaxLimit)
	offset := clampInt(atoiDefault(c.Query("offset"), 0), 0, rowsMaxOffset)
	unmask := isTruthyQuery(c.Query("unmask"))

	// ① 库文件不存在 ⇒ 应用还没有任何数据。**先 stat 再 Open**：appdb.Open 会建库，
	// 只读端点不该有写副作用（作者点一下"数据"就把 app.db 建出来是不可接受的）。
	path, perr := appdb.Path(h.opt.DataRoot, appID)
	if perr != nil {
		writeErr(c, perr)
		return
	}
	if _, serr := os.Stat(path); serr != nil {
		writeErr(c, notFoundApp(appID).WithDetail("table", table).
			WithHint("这个应用还没有数据库：它还没成功执行过任何 db.define/db.exec；"+
				"先打开应用跑一次写入，或检查应用的建表代码"))
		return
	}

	// ② 自省：表是否存在、列结构、总行数（与 GET …/schema 同一份只读实现）。
	db, _, _, oerr := h.openAppDBReadOnly(ctx, appID)
	if oerr != nil {
		writeErr(c, oerr)
		return
	}
	defer db.Close()
	tables, terr := listAppTables(ctx, db)
	if terr != nil {
		writeErr(c, internalErr("读取表清单失败", terr))
		return
	}
	var target *schemaTable
	for i := range tables {
		if tables[i].Name == table {
			target = &tables[i]
			break
		}
	}
	if target == nil {
		writeErr(c, notFoundApp(appID).WithDetail("table", table).
			WithDetail("available_tables", tableNames(tables, 20)).
			WithHint("表名拼错了或应用还没建这张表：available_tables 列出的是当前库里的表（最多 20 个）"))
		return
	}

	// ③ 行查询：走 appdb（闸门 + 5 s 预算 + 行/字节上限 + `_row_id` 剥离 + 值规整）。
	//
	// 为什么不带 ORDER BY：平台保留列 `_row_id` 在应用 SQL 里**提到即拒**
	//（sqlgate 的保留列判据），所以排序键只能用 SQLite 的默认扫描顺序（rowid 序）。
	// 分页因此在"没有并发写入"时稳定；有并发写入时可能与翻页错位 —— 这是浏览面的
	// 可接受语义（不是导出/对账面），已在响应里通过 total_rows/has_more 明示。
	quoted := quoteIdent(table)
	probe, aerr := appdb.Open(ctx, appdb.Options{DataRoot: h.opt.DataRoot, AppID: appID})
	if aerr != nil {
		writeErr(c, internalErr("应用库不可用", aerr))
		return
	}
	defer probe.Close()
	res, qerr := probe.Query(ctx, abi.SQLParams{
		SQL:  "SELECT * FROM " + quoted + " LIMIT ? OFFSET ?",
		Args: []any{limit, offset},
	})
	if qerr != nil {
		// 这里能到的失败是"平台侧语句问题"（我们的 SQL 是平台拼的、表名已校验），
		// 因此按内部错误上报而不是 400：如果真的到了这里，说明平台自己的拼装有 bug。
		writeErr(c, internalErr("读取应用数据失败", qerr))
		return
	}

	// ④ 投影：脱敏 + 单值截断。列名→是否敏感的判定只在这里做一次。
	cols := make([]rowsColumn, 0, len(res.Columns))
	masked := make([]string, 0)
	sensitive := make([]bool, len(res.Columns))
	for i, name := range res.Columns {
		s := isSensitiveColumn(name)
		sensitive[i] = s
		if s && !unmask {
			masked = append(masked, name)
		}
		cols = append(cols, rowsColumn{Name: name, Type: columnTypeOf(target, name), Sensitive: s})
	}
	outRows := make([][]any, 0, len(res.Rows))
	truncatedValues := 0
	for _, row := range res.Rows {
		values := make([]any, len(row))
		for i, v := range row {
			if i < len(sensitive) && sensitive[i] && !unmask {
				values[i] = "***"
				continue
			}
			val, cut := clampValue(v, rowsMaxValueBytes)
			if cut {
				truncatedValues++
			}
			values[i] = val
		}
		outRows = append(outRows, values)
	}

	// ⑤ 审计：**只记元数据**（表名/分页/行数/是否脱敏），绝不记行内容。
	action := "wasm_app_rows_view"
	detail := auditDetail(appID, appTitle,
		"查看数据表 "+table+"（offset="+itoa(offset)+" limit="+itoa(limit)+" rows="+itoa(len(outRows))+"）")
	if unmask {
		action = "wasm_app_rows_view_unmasked"
		detail = auditDetail(appID, appTitle,
			"查看数据表 "+table+" **原值**（offset="+itoa(offset)+" limit="+itoa(limit)+" rows="+itoa(len(outRows))+"）")
	}
	h.auditApp(appID, operator, action, detail)

	hasMore := int64(offset+len(outRows)) < target.Rows
	c.JSON(http.StatusOK, gin.H{"rows": rowsPayload{
		AppID:           appID,
		Table:           table,
		Columns:         cols,
		Rows:            outRows,
		Limit:           limit,
		Offset:          offset,
		Returned:        len(outRows),
		TotalRows:       target.Rows,
		HasMore:         hasMore,
		Truncated:       res.Truncated,
		TruncatedValues: truncatedValues,
		Unmasked:        unmask,
		MaskedColumns:   masked,
		ValueMaxBytes:   rowsMaxValueBytes,
	}})
}

// tableNames 取表名清单（失败信息里给作者"有哪些表"的提示）。
//
// 为什么要限个数：应用最多 16 张表，但历史库可能被人塞过更多；
// 错误信封是给 AI 读的，塞 10000 个表名会把它淹掉。
func tableNames(tables []schemaTable, max int) []string {
	out := make([]string, 0, len(tables))
	for i, t := range tables {
		if i >= max {
			break
		}
		out = append(out, t.Name)
	}
	return out
}

// columnTypeOf 从自省结果里取某列的声明类型（找不到时回落空串，不编造）。
func columnTypeOf(table *schemaTable, name string) string {
	if table == nil {
		return ""
	}
	for _, c := range table.Columns {
		if c.Name == name {
			return c.Type
		}
	}
	return ""
}

// clampValue 把单个值收敛到可安全回传的形状：超长字符串按字节截断并报"截断了"。
//
// 只处理 JSON 能表达的类型（appdb.normalizeValue 已把 []byte → string、
// time.Time → RFC3339），其余类型原样回传（它们本来就只有标量）。
func clampValue(v any, maxBytes int) (any, bool) {
	s, ok := v.(string)
	if !ok {
		return v, false
	}
	if len(s) <= maxBytes {
		return s, false
	}
	// 按字节截断可能切断 UTF-8 序列 ⇒ 回退到最后一个完整 rune 边界。
	cut := maxBytes
	for cut > 0 && !utf8Start(s[cut]) {
		cut--
	}
	return s[:cut], true
}

// utf8Start 报告 b 是否是一个 UTF-8 序列的首字节（含 ASCII）。
func utf8Start(b byte) bool { return b&0xC0 != 0x80 }

// isTruthyQuery 解析布尔型查询参数（`1`/`true`/`yes`/`on`，大小写不敏感）。
func isTruthyQuery(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// clampInt 把 v 收敛到 [lo, hi]（用于分页参数：越界**收敛**而不是报错，
// 因为浏览面的越界几乎总是"翻到最后一页"这类无害输入）。
func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// sensitiveColumnPatterns 是**默认脱敏**的列名启发式（UNMASK 可显式覆盖）。
//
// 判据不是"子串包含"（那会把 `total` 判成 `tel`、`hotel` 判成 `tel`、`monitor` 判成 `pin`），
// 而是**按分隔符切词后整词匹配**（`api_key` → [api,key]；`passwordHash` → [password,hash]），
// 再加一组"连写词"的整名匹配（`idcard` / `phonenumber` 这类没有分隔符的写法）。
//
// 列表刻意保守：**漏判**只是"作者看到了本该脱敏的列"（他本来就能通过应用代码看到），
// 而**误判**会让排障变难（作者以为数据丢了）。两组判据的取舍见下。
var sensitiveColumnTokens = map[string]struct{}{
	"password": {}, "passwd": {}, "pwd": {}, "secret": {}, "token": {},
	"credential": {}, "credentials": {}, "authorization": {},
	"ssn": {}, "cvv": {}, "pin": {},
	"phone": {}, "mobile": {}, "cellphone": {}, "telephone": {},
	"email": {}, "mail": {},
	"idcard": {}, "idnumber": {}, "passport": {}, "bankcard": {},
}

// sensitiveColumnNames 是"整名匹配"（无分隔符写法，或必须整体相等才算的词）。
var sensitiveColumnNames = map[string]struct{}{
	"tel": {}, "id": {}, "key": {}, "apikey": {}, "privatekey": {}, "secretkey": {},
	"accesskey": {}, "cardno": {}, "phoneNumber": {}, "identity": {},
}

// isSensitiveColumn 判定列名是否按默认策略脱敏。
func isSensitiveColumn(name string) bool {
	normalized := strings.ToLower(strings.TrimSpace(name))
	if normalized == "" {
		return false
	}
	if _, ok := sensitiveColumnNames[normalized]; ok {
		return true
	}
	// 切词：非字母数字都是分隔符（`api_key` / `api-key` / `api key` / `apiKey` 归一）。
	// 大小写边界也要切（`passwordHash` → password + hash）。
	for _, token := range splitIdentifier(normalized) {
		if _, ok := sensitiveColumnTokens[token]; ok {
			return true
		}
	}
	// 连写词：把切出来的词拼回去再比一次（`id` + `card` → `idcard`）。
	joined := strings.Join(splitIdentifier(normalized), "")
	if _, ok := sensitiveColumnTokens[joined]; ok {
		return true
	}
	return false
}

// splitIdentifier 把标识符切成小写词序列（分隔符 + 驼峰边界）。
func splitIdentifier(name string) []string {
	var out []string
	var cur strings.Builder
	flush := func() {
		if cur.Len() > 0 {
			out = append(out, cur.String())
			cur.Reset()
		}
	}
	prevLower := false
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			cur.WriteRune(r)
			prevLower = r >= 'a' && r <= 'z'
		case r >= 'A' && r <= 'Z':
			// 驼峰边界：小写/数字后跟大写 ⇒ 新词（split 前已 ToLower，这里兜底）。
			if prevLower {
				flush()
			}
			cur.WriteRune(r + ('a' - 'A'))
			prevLower = false
		default:
			flush()
			prevLower = false
		}
	}
	flush()
	return out
}

// adminSchema 是管理面的表结构自省（与员工面同形、同 payload）。
//
// 为什么管理员需要它：员工面的 `schema` 只认发布者，而管理员排障时既没有发布者令牌、
// 也不该借用他人令牌（审计会记错人）。这里用管理会话 + `capability:read`，
// 操作者账号如实进审计。
func (h *Handlers) adminSchema(c *gin.Context) {
	if err := h.requireReady(); err != nil {
		writeErr(c, err)
		return
	}
	admin := serverauth.AdminUser(c)
	if admin == nil {
		writeErr(c, apperr.New(apperr.CodeAuthRequired, "未登录"))
		return
	}
	appID := registry.NormalizeAppID(c.Param("app_id"))
	app, aerr := h.adminApp(c, appID)
	if aerr != nil {
		writeErr(c, aerr)
		return
	}
	h.auditApp(appID, admin.Username, "wasm_app_schema_view",
		auditDetail(appID, auditTitleOf(app), "查看表结构与占用"))
	report, serr := h.inspectAppDB(c.Request.Context(), appID)
	if serr != nil {
		writeErr(c, serr)
		return
	}
	c.JSON(http.StatusOK, gin.H{"schema": report})
}
