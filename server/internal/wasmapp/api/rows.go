package api

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/appcfg"
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
//     · **作者可补充声明**（`picoaide.app.json` 的 `sensitive_columns`，§5.9 第 8 点后半）：
//     启发式覆盖不到的业务列名由作者声明，声明与启发式取**并集**（只增不减）；
//     · 每次调用写审计（动作 `wasm_app_rows_view`），审计**只记表名/分页/行数与脱敏状态，
//     不记行内容**（把行内容写进审计等于把 PII **再复制一份**到审计表，而审计的保留期
//     与可见面与业务库完全不同；另外审计明细是"一条 = 一行"的追加型文本面，
//     行内容里的换行会破坏行结构 —— 入口的 `util.EscapeControl` 只保证结构不被伪造，
//     不解决"PII 多存一份"这件事，所以唯一正确的做法是根本不写进去）。
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
	//
	// **数值真源 = `limits.RowsPageMax`**（会随生成链进 `references/limits.md`）。
	// 这里保留字面量而不是写成 `= limits.RowsPageMax`：跨语言对拍
	// （`packages/client/wasm-apps/src/client/rows-paging-contract.spec.ts`）按
	// `rowsMaxLimit = <数字>` 的形态读本文件，换成符号引用会让那条判据失效。
	// 与真源的同值绑定（以及作者文档那句"一页最多 N 行"）由
	// `rows_page_limit_binding_test.go` 判红。
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
	h.respondRows(c, appID, auditTitleOf(app), u.Username, appcfg.SensitiveColumnsOfConfigJSON(app.ConfigJSON))
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
	h.respondRows(c, appID, auditTitleOf(app), admin.Username, appcfg.SensitiveColumnsOfConfigJSON(app.ConfigJSON))
}

// respondRows 是两条鉴权面共用的唯一实现（同 diagnosticsPayload 的分工）。
//
// appTitle 只用于审计明细（"查看了《团队便签》的表 notes"），不参与数据查询。
// declared 是作者在 `picoaide.app.json` 里**声明**的额外敏感列（appcfg 的
// `sensitive_columns`）：与默认启发式取**并集**（声明是加法）。
func (h *Handlers) respondRows(c *gin.Context, appID, appTitle, operator string, declared []string) {
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

	// ①+② 只读打开（库文件不存在 ⇒ 应用还没有任何数据；**不建库、不建目录**）：
	// 同一份 helper 服务 /rows 与 /schema，写副作用在结构上不可能。
	db, _, _, exists, oerr := h.appDBReadOnly(ctx, appID)
	if oerr != nil {
		writeErr(c, oerr)
		return
	}
	if !exists {
		writeErr(c, notFoundApp(appID).WithDetail("table", table).
			WithHint("这个应用还没有数据库：它还没成功执行过任何 db.define/db.exec；"+
				"先打开应用跑一次写入，或检查应用的建表代码"))
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
	//
	// 敏感 = **默认启发式 ∪ 作者声明**（§5.9 第 8 点后半）：两条通道是**并集**，
	// 声明不能"取消"启发式（没有反向开关 —— 平台无法复核作者"这列不敏感"的判断，
	// 而判错的代价是 PII 进模型上下文）。声明的匹配是**逐字 + 大小写不敏感**
	//（appcfg.DeclaredSensitiveColumn），不做前缀/子串：模糊判定是启发式的职责。
	//
	// 声明了但**不在结果集里**的列不算错误（列改名、还没建表、或这张表本来就没有它）：
	// 它只是这次不参与脱敏，`masked_columns` 也只在真的遮住某一列时才提到那一列
	//（"声明"不是"结果集"的事实，两者不该互相要求）。
	declaredSet := appcfg.SensitiveColumnSet(declared)
	cols := make([]rowsColumn, 0, len(res.Columns))
	masked := make([]string, 0)
	sensitive := make([]bool, len(res.Columns))
	for i, name := range res.Columns {
		s := isSensitiveColumn(name) || appcfg.DeclaredSensitiveColumn(declaredSet, name)
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
	// 姓名 / 地址 / 生日（2026-09-21 三轮审计 P2-③：这三类此前的漏判率最高——
	// 结构化业务库几乎每张"员工/客户"表都有它们，而它们直接指认到人）。
	//
	// ⚠️ **故意不放裸 `name`**：本表既用于"逐词匹配"也用于"拼回整名匹配"
	// （见 isSensitiveColumn 的 joined 分支），放进去会让 `file_name`/`hostname`/
	// `table_name`/`display_name` 全部被误判 —— 而误判的代价是"排障时看不到任何有用
	// 数据"，与漏判同样有害。所以只放**复合写法**：`real_name` → 拼回 `realname` 命中，
	// 而 `file_name` → `filename` 不在表里。判据 TestSensitiveColumnHeuristicCoversBusinessVocabulary
	// 的 mustNotMask 清单就是为这条纪律准备的（实测：加 `name` 立刻红 5 条）。
	"realname": {}, "fullname": {}, "username": {}, "surname": {},
	"firstname": {}, "lastname": {}, "nickname": {}, "personname": {},
	"address": {}, "addr": {}, "street": {}, "city": {}, "postcode": {}, "zipcode": {},
	"birthday": {}, "birthdate": {}, "birth": {}, "dob": {},
	// 财务：薪资与银行账号（泄露后果与口令同级，且业务库里几乎必然存在）。
	"salary": {}, "wage": {}, "income": {},
	"account": {}, "accountno": {}, "accountnumber": {}, "bankaccount": {},
	"iban": {}, "swift": {},
	// 网络身份：IP 与设备标识（可关联到人）。
	"ip": {}, "ipaddr": {}, "ipaddress": {}, "mac": {}, "macaddr": {}, "imei": {}, "imsi": {},
	// 中文业务库里的**拼音列名**（2026-09-21 三轮审计实测：全拼音写法此前 100% 漏判）。
	// 中文 SaaS/外包项目的建表习惯经常是 `shoujihao`/`xingming`/`shenfenzheng` 这类写法，
	// 而"漏判 = 使用者 PII 进模型上下文"，正是本端点要防的那件事。
	"shouji": {}, "shoujihao": {}, "dianhua": {}, "youxiang": {}, "xingming": {},
	"xingmingquan": {}, "shenfenzheng": {}, "shenfen": {}, "dizhi": {}, "shengri": {},
	"yinhang": {}, "yinhangzhanghao": {}, "zhanghao": {}, "mima": {}, "mimacuowu": {},
	// 微信 / QQ 的**词根**：单独成词即命中（`wechat_id` → [wechat, id]）。
	"wechat": {}, "weixin": {},
	// **多词拼回形态**（joined 分支查的就是本表）：`id_card_no` → "idcardno"、
	// `card_number` → "cardnumber"、`qq_number` → "qqnumber"。四轮审计发现的两类漏判
	// 都落在这里：① 多词写法拼回后不等于已有的单数形态；② 键放错表（见 Names 表注释）。
	"wxid": {}, "wxno": {},
	"wechatid": {}, "wechatno": {}, "wechatnumber": {},
	"weixinid": {}, "weixinnumber": {},
	"qqid": {}, "qqno": {}, "qqnumber": {},
	"idcardno": {}, "cardnumber": {},
	// （`idnumber` / `accountnumber` 本表已有，勿重复。）
}

// sensitiveColumnNames 是"整名匹配"（无分隔符写法，或必须整体相等才算的词）。
var sensitiveColumnNames = map[string]struct{}{
	"tel": {}, "id": {}, "key": {}, "apikey": {}, "privatekey": {}, "secretkey": {},
	"accesskey": {}, "cardno": {}, "identity": {},
	// ⚠️ 这里**不能**放 camelCase 写法（`phoneNumber`）：`isSensitiveColumn` 先把列名
	// `ToLower` 再切词，所以进到本表比较的永远是全小写形态 —— 放 camelCase 键就是
	// **死条目**（四轮审计实测：`phoneNumber` 从未被命中）。camelCase 由**切词**覆盖：
	// `phoneNumber` → [phone, number] → `phone` 命中 sensitiveColumnTokens。
	// 本表只收"整名相等才算"的全小写写法。
	// 单独出现时足以指认到人、但**不能**进 sensitiveColumnTokens 的词：
	// 它们作为子串在业务库里极其常见（`contact`/`content`/`gender` 里没有，但
	// `name` 一旦进了 token 表，`filename`/`hostname`/`table_name` 都会被误判成敏感，
	// 而误判的代价是"排障时看不到任何有用数据"）。
	// 这里放的是"整名相等才算"的写法：`contact`（联系人）/`gender` 不进（不是标识符）。
	"contact": {}, "contactinfo": {},
	// 微信 / QQ 的短写法（**整名相等**才算）：`wx`/`qq` 单独作为列名才是敏感列，
	// 作为词根则过于常见（`qq` 可能出现在别处）⇒ 它们不进 token 表。
	// ⚠️ 教训（四轮审计）：**多词拼回形态（`wechatid`/`qqnumber`/`idcardno`…）必须放
	// token 表**，因为 `isSensitiveColumn` 的 joined 分支只查 token 表 —— 放进本表就是
	// 死条目（`wechat_id` 切词后拼回 `wechatid`，在本表里永远比不到 ⇒ 成片漏判）。
	"wechat": {}, "weixin": {}, "wx": {}, "wxid": {}, "wxno": {}, "qq": {},
}

// isSensitiveColumn 判定列名是否按默认策略脱敏。
//
// ⚠️ 切词必须用**原串**，不能先 `ToLower`（2026-09-21 四轮审计 P2）：本函数此前先
// `strings.ToLower(name)` 再 `splitIdentifier`，而驼峰边界正是 `splitIdentifier` 判据的一部分
// （"小写后跟大写 ⇒ 新词"）—— 先小写等于**把边界擦掉**，于是所有 camelCase 写法
// （`phoneNumber` / `accountName` / `idCardNo` / `bankAccountNo`）都退化成单个词、全部漏判；
// 同一原因还让 `sensitiveColumnNames` 里的 `phoneNumber` 变成**死条目**（键永远比不到，
// 因为查表用的是全小写形态）。现在：整名表查小写形态，切词/拼回用保留大小写的原串。
func isSensitiveColumn(name string) bool {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return false
	}
	// 整名相等表（键一律全小写；放 camelCase 键是死条目）。
	if _, ok := sensitiveColumnNames[strings.ToLower(trimmed)]; ok {
		return true
	}
	// 切词：非字母数字都是分隔符（`api_key` / `api-key` / `api key`），
	// **以及驼峰边界**（`passwordHash` → password + hash、`phoneNumber` → phone + number）。
	tokens := splitIdentifier(trimmed)
	for _, token := range tokens {
		if _, ok := sensitiveColumnTokens[token]; ok {
			return true
		}
	}
	// 连写词：把切出来的词拼回去再比一次（`id` + `card` → `idcard`）。
	joined := strings.Join(tokens, "")
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
	// 审计写在读成功之后（与 `rows` 及员工面 `schema` 同一口径，2026-09-21 独立审计 P3-⑧）：
	// 审计行 = 真的发生过一次成功读取，而不是"有人尝试过"。
	report, serr := h.inspectAppDB(c.Request.Context(), appID)
	if serr != nil {
		writeErr(c, serr)
		return
	}
	h.auditApp(appID, admin.Username, "wasm_app_schema_view",
		auditDetail(appID, auditTitleOf(app), "查看表结构与占用"))
	c.JSON(http.StatusOK, gin.H{"schema": report})
}
