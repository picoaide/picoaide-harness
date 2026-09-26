package llmgateway

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// ===========================================================================
// `PUT /api/server/admin/gateway` 的**审计写点清单**（第二十八轮 FIX-40 ②）
// ===========================================================================
//
// 为什么需要这张表：第二十七轮 AA2-03 只修了被点名的那**一条**写点（DSN），而同一个
// 函数里紧挨着的 `web.glitchtip_base_url` 走的是同一条明文路径 —— 实测保存
// `https://<user>:<pass>@glitchtip.example.com` 后，库里那一行是
// `detail="GlitchTip地址:(空)→https://<user>:<pass>@glitchtip.example.com"`。
// 同一次枚举还发现 `server.base_url` 是**第三个**零校验 URL 写点（同样泄漏）。
//
// 「逐个点名地修」这种修法必然漏，所以判据改成**清单驱动 + 双向对账**：
//
//   - `auditSettingInventory` 是唯一真源：每一个 settings 写点要么登记为"取值可能是
//     URL/凭据 ⇒ 必须带折叠器"，要么登记为"不是 URL/凭据 ⇒ 写明为什么"，两者都必须
//     写理由；
//   - 观测面 = **整包**（`internal/llmgateway/**` 的非测试 `.go`，2026-09-27 起：
//     原先只 `ParseFile("admin.go")`）的 AST：多一个写点、少一个写点、把折叠器换成
//     别的、或者绕过 helper 手写 `serverstore.SetSetting*`，**任一形态都红**；
//   - 写入口**按符号来源**枚举，不按名字：`serverstore` 里**哪些函数会写 settings 表**
//     由那份源码自己的 SQL 派生（`INSERT INTO settings` / `UPDATE settings` /
//     `DELETE FROM settings`），llmgateway 侧"谁把键形参转发给这些写入口"也是派生的
//     ⇒ 改名、加一层包装、换一个不叫 `SetSettingTx` 的入口（池上的 `SetSetting`）
//     都自动进面；
//   - 反面防空转：扫描面必须真的收到 helper 的调用（否则"零违规"没有意义），并且
//     派生出来的写入口/helper 集合必须非空（派生链断了要红，不能静默空转）。
//
// 已知边界（写在这里，不假装覆盖了它）：判据认的是**写点的形状**，不是取值的语义 ——
// 一个今天不是 URL 的键（例如未来的某个字符串配置）被改成承载 URL 时，本判据不会自己
// 变红；这正是"登记项的 `why` 必须写清取值形态"的原因：改语义的人要改这一行。
//
// 另一条边界（R29-AC1-02 之后仍然成立，如实登记）：判据看的是**直接**写 settings 的
// 调用点。若某个函数把 `*sql.Tx` 交给别的包去写 settings（跨包转发），本判据看不见
// 那一层 —— 当前全仓没有这种形态，出现时这条注释要跟着改。
// ===========================================================================

// auditSettingWrite 是一个写点的登记项。
type auditSettingWrite struct {
	/** 期望的折叠器；空串 = 明文进 detail（必须写明为什么它不是 URL/凭据）。 */
	formatter string
	/** 为什么是这个判定（必须写清取值形态，不能只写"不需要"）。 */
	why string
}

// auditSettingInventory 是 settings 写点的登记表（键 = settings 键）。
//
// 新增写点时必须在这里加一行 —— 判据会打印"该写点的取值是不是 URL/凭据"这个提问，
// 而不是让你去猜它想让你写什么。
var auditSettingInventory = map[string]auditSettingWrite{
	"gateway.default_model": {
		why: "模型名（服务端目录里的 id），不是 URL/凭据。**手写**写点（它的变更明细不经 helper），由 TestAuditSettingWritePointsAreInventoryComplete 单独对账。",
	},
	"gateway.rate_limit": {
		why: "整数（每用户限流），不是 URL/凭据。",
	},
	SettingMaxFileRefs: {
		why: "整数（单请求文件引用上限），不是 URL/凭据。",
	},
	SettingBodyParseBudgetMB: {
		why: "整数（请求体加工内存预算，MB），不是 URL/凭据。",
	},
	"gateway.unpriced_model_policy": {
		why: "枚举 reject|allow，不是 URL/凭据。",
	},
	SettingFileExpiryDays: {
		why: "整数（文件保留上限天数），不是 URL/凭据。",
	},
	"usage.peak_windows": {
		why: "JSON（峰谷窗口：小时区间与折扣倍数），不是 URL/凭据。",
	},
	"usage.retention_months": {
		why: "整数（明细保留月数），不是 URL/凭据。",
	},
	"web.error_reporting_dsn": {
		formatter: "redactURLCredentialForAudit",
		why:       "URL 且 userinfo 就是凭据本体（第二十七轮 AA2-03 的原始缺陷形态：`https://<publicKey>[:<privateKey>]@host/<project>`）。",
	},
	"web.error_reporting_enabled": {
		why: "布尔字符串，不是 URL/凭据。",
	},
	"web.error_reporting_level": {
		why: "枚举 error|warning|info|debug，不是 URL/凭据。",
	},
	"web.error_reporting_heartbeat": {
		why: "布尔字符串，不是 URL/凭据。",
	},
	"web.glitchtip_base_url": {
		formatter: "redactURLCredentialForAudit",
		why:       "URL 且**零准入校验**（第二十八轮 FIX-40 ② 的实测缺陷：`https://<user>:<pass>@host` 原样进 detail）。",
	},
	"web.glitchtip_organization": {
		why: "组织 slug（路径段），不是 URL/凭据。",
	},
	"web.default_thinking_level": {
		why: "枚举 off|low|high|max，不是 URL/凭据。",
	},
	"server.base_url": {
		formatter: "redactURLCredentialForAudit",
		why:       "URL 且**零准入校验**（第二十八轮 FIX-40 ② 同族实测：与 glitchtip 同一条路径，userinfo 原样进 detail）。",
	},
}

// manualSettingWriteAllowance 是"绕过 helper、直接调 settings 写入口"的登记项。
//
// 每一条都必须带理由：手写写点没有折叠器，它的取值形态必须由人回答过。
type manualSettingWriteAllowance struct {
	key string
	why string
}

// manualSettingWrites 是整包里允许**绕过 helper** 直接写 settings 的调用点。
var manualSettingWrites = []manualSettingWriteAllowance{
	{
		key: "gateway.default_model",
		why: "默认模型的赋值是「读-改-回喂」链路的一部分（同一事务里先读旧值再写），且取值是模型 id、不是 URL/凭据 ⇒ 不加折叠器。",
	},
}

// TestAuditSettingWritePointsAreInventoryComplete 把**整包**的 settings 写点与上面的
// 登记表做**双向**对账（新增/删除/换折叠器/绕过 helper 四种形态都红）。
//
// 2026-09-27（R29-AC1-02）重写的三条：扫描根从 `admin.go` 一个文件改成整包；写入口按
// **符号来源**派生（`serverstore` 源码里真的会写 settings 表的函数）而不是按函数名；
// 手写写点的键也必须登记（原先只数个数）。
func TestAuditSettingWritePointsAreInventoryComplete(t *testing.T) {
	pkg := parseGoPackage(t, ".")
	store := parseGoPackage(t, filepath.Join("..", "serverstore"))

	writers := deriveSettingsWriters(t, store)
	if len(writers) < 2 {
		t.Fatalf("从 serverstore 源码里只派生出 %d 个 settings 写入口（现有 SetSetting / SetSettingTx）—— "+
			"派生链断了，判据会静默空转", len(writers))
	}
	helpers := deriveSettingWriteHelpers(pkg, writers)
	if len(helpers) < 2 {
		t.Fatalf("只派生出 %d 个 settings 写 helper（现有 auditSetSettingTx / auditSetSettingFormattedTx）—— "+
			"派生的转发链断了，会让「整包扫描」变成空转", len(helpers))
	}

	observed, manual := scanSettingWriteSites(t, pkg, writers, helpers)

	// 反面防空转：helper 的调用必须真的被扫到（否则表与代码脱钩也不会红）。
	if len(observed) < 10 {
		t.Fatalf("扫描面只收到 %d 个 helper 写点（现有 15 个 settings 键）⇒ 判据会空转（helper 改名/搬文件了？）", len(observed))
	}
	if len(pkg) < 20 {
		t.Fatalf("只解析到 %d 个非测试 .go 文件（llmgateway 现有 29 个）—— 扫描根变窄了，同包新文件会静默", len(pkg))
	}

	keys := make([]string, 0, len(observed))
	for key := range observed {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	for _, key := range keys {
		got := observed[key]
		want, ok := auditSettingInventory[key]
		if !ok {
			t.Errorf("写点 %q 没有登记：它的取值可能是 URL/凭据吗？"+
				"是 ⇒ 用 auditSetSettingFormattedTx + redactURLCredentialForAudit；"+
				"不是 ⇒ 在 auditSettingInventory 里登记并写明为什么", key)
			continue
		}
		if got != want.formatter {
			t.Errorf("写点 %q 的折叠器 = %q，登记表要求 %q（换折叠器必须同步改登记与理由）", key, got, want.formatter)
		}
	}
	// 反向：登记表里的键必须仍然存在（防止"写点搬走了、登记项还在"变成免检区）。
	for key, entry := range auditSettingInventory {
		if _, ok := observed[key]; ok {
			continue
		}
		if key == "gateway.default_model" {
			continue // 手写写点，见下面的手写写点对账
		}
		t.Errorf("登记表里的写点 %q 已经不存在了 —— 请删掉这条陈旧登记（%s）", key, entry.why)
	}
	// 每条登记都必须写明理由（空/敷衍的理由等于免检）。
	for key, entry := range auditSettingInventory {
		if len([]rune(entry.why)) < 12 {
			t.Errorf("登记项 %q 的理由太短：必须写清取值形态与判定依据", key)
		}
	}

	// 手写写点（不经 helper）也必须登记：判据是"直接调用 settings 写入口的调用点数量
	// == 登记的手写写点数量"，且**每一个**的键都必须在登记表里。绕过 helper 新增一个
	// 设置写入 ⇒ 红（R29-AC1-02 的 M2 形态：池上的 `serverstore.SetSetting`）。
	if len(manual) != len(manualSettingWrites) {
		t.Errorf("整包里有 %d 处**绕过 helper** 的直接 settings 写入，登记的手写写点只有 %d 处 —— "+
			"新增手写写点必须同时登记它的取值形态；实际：%v", len(manual), len(manualSettingWrites), manual)
	}
	allowed := map[string]string{}
	for _, a := range manualSettingWrites {
		if len([]rune(a.why)) < 12 {
			t.Errorf("手写写点登记 %q 的理由太短：必须写清取值形态", a.key)
		}
		allowed[a.key] = a.why
	}
	for _, site := range manual {
		if _, ok := allowed[site.key]; !ok {
			t.Errorf("%s: 手写写点 %q 没有登记（登记表里的手写写点：%v）", site.pos, site.key, manualSettingWrites)
			continue
		}
		if _, ok := auditSettingInventory[site.key]; !ok {
			t.Errorf("%s: 手写写点 %q 的键不在 auditSettingInventory 里 —— 手写写点同样要回答「取值是不是 URL/凭据」", site.pos, site.key)
		}
	}
	if _, ok := observed["gateway.default_model"]; ok {
		t.Error("gateway.default_model 不应该出现在 helper 的观测面里（它是手写写点）—— 判据的假设变了，请同步修正")
	}
}

// observedWrite 记录一次 helper 调用点的观测结果（键 → 折叠器名）。
type observedWrite = map[string]string

// manualWriteSite 是一次"绕过 helper 直接写 settings"的调用点。
type manualWriteSite struct {
	pos token.Position
	key string
}

// settingsWriter 是从 `serverstore` 源码里派生出来的一个 settings 写入口。
type settingsWriter struct {
	/** 写入口名（`SetSetting` / `SetSettingTx` / 未来任何包装）。 */
	name string
	/** settings 键在该入口形参表里的下标。 */
	keyIndex int
	/** 命中的 SQL 片段（诊断用：说明它为什么被判成写入口）。 */
	evidence string
}

// settingsWriteSQLMarkers 是"这个函数真的在写 settings 表"的证据（settings 表的写语句）。
var settingsWriteSQLMarkers = []string{"INSERT INTO settings", "UPDATE settings", "DELETE FROM settings"}

// deriveSettingsWriters 从 **serverstore 的真实源码**里派生 settings 写入口集合。
//
// 为什么不写死名字（R29-AC1-02）：写死 `SetSettingTx` 会让"池上的 `SetSetting`"、
// "新加的一层包装"整类形态落在判据面外 —— 而它们写的是同一张表。这里认的是**符号
// 来源**：函数体里真的出现 settings 表的写语句（或其调用链最终落到这样的函数）。
//
// 键下标 = 第一个 `string` 形参（`SetSetting(db, key, value)` / `SetSettingTx(tx, key,
// value)` / `DeleteSetting(db, key)` 三处一致）。这条约定由调用侧的自检兜底：观测到的
// 键必须都能在登记表里对账，派生错下标会立刻表现为"大量未知键"。
func deriveSettingsWriters(t *testing.T, store map[string]*ast.File) map[string]settingsWriter {
	t.Helper()
	out := map[string]settingsWriter{}
	decls := map[string]*ast.FuncDecl{}
	for _, file := range store {
		for _, decl := range file.Decls {
			fd, ok := decl.(*ast.FuncDecl)
			if !ok || fd.Name == nil || fd.Body == nil {
				continue
			}
			decls[fd.Name.Name] = fd
		}
	}
	for name, fd := range decls {
		if index, evidence, ok := parameterizedSettingsWrite(fd); ok {
			out[name] = settingsWriter{name: name, keyIndex: index, evidence: evidence}
		}
	}
	// 定点迭代：**薄包装**也是写入口 —— 判据是"把自己的键形参原样转发到已知写入口的
	// 键位置"，不是"调用过写入口"。
	//
	// 为什么必须是"转发"而不是"调用过"（本轮实测踩到）：serverstore 里有一批**顺带**
	// 写 settings 的领域函数（`SyncProviderModelsTx` / `AddExcludedModelTx` / …），
	// 它们自己算出键、不是入口。按"调用过"闭包会把它们全收进来，于是 llmgateway 里
	// 每一次 provider/model 同步都会被记成"手写 settings 写点"—— 判据当场变成假红。
	for changed := true; changed; {
		changed = false
		for name, fd := range decls {
			if _, ok := out[name]; ok {
				continue
			}
			keyIndex := firstStringParamIndex(fd)
			if keyIndex < 0 {
				continue
			}
			params := paramNames(fd)
			forwarded, evidence := forwardsKeyParamToWriter(fd, params[keyIndex], writersOf(out))
			if forwarded {
				out[name] = settingsWriter{name: name, keyIndex: keyIndex, evidence: evidence}
				changed = true
			}
		}
	}
	return out
}

// writersOf 把 settingsWriter 视图投影成 forwardsKeyParamToWriter 需要的键下标表。
func writersOf(out map[string]settingsWriter) map[string]settingsWriter { return out }

// forwardsKeyParamToWriter 判定 fd 是否把 `keyParam` 原样转发给一个已知写入口的键位置。
func forwardsKeyParamToWriter(fd *ast.FuncDecl, keyParam string, writers map[string]settingsWriter) (bool, string) {
	if keyParam == "" {
		return false, ""
	}
	evidence := ""
	ast.Inspect(fd.Body, func(n ast.Node) bool {
		if evidence != "" {
			return true
		}
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		id, ok := call.Fun.(*ast.Ident)
		if !ok {
			return true
		}
		writer, ok := writers[id.Name]
		if !ok || writer.keyIndex < 0 || writer.keyIndex >= len(call.Args) {
			return true
		}
		if arg, ok := call.Args[writer.keyIndex].(*ast.Ident); ok && arg.Name == keyParam {
			evidence = "转发到 " + writer.name
		}
		return true
	})
	return evidence != "", evidence
}

// settingWriteHelper 是 llmgateway 侧"把键形参转发给写入口"的函数（= 观测面的入口）。
type settingWriteHelper struct {
	keyIndex       int
	formatterIndex int // -1 = 该 helper 自己钉死折叠器（调用点写空串）
	forwardsTo     string
}

// deriveSettingWriteHelpers 派生 llmgateway 侧的写 helper 集合。
//
// 判据是**转发**而不是"调用过写入口"：一个业务函数调用 helper 时，键是**字面量**
// （它才是要登记的写点）；而 helper 的定义把**自己的形参**转发下去 —— 后者才是"实现"，
// 在枚举调用点时必须跳过。这条区分让"新加一层 wrapper"与"新加一个写点"自动分开。
func deriveSettingWriteHelpers(pkg map[string]*ast.File, writers map[string]settingsWriter) map[string]settingWriteHelper {
	decls := map[string]*ast.FuncDecl{}
	for _, file := range pkg {
		for _, decl := range file.Decls {
			fd, ok := decl.(*ast.FuncDecl)
			if !ok || fd.Name == nil || fd.Body == nil {
				continue
			}
			decls[fd.Name.Name] = fd
		}
	}
	out := map[string]settingWriteHelper{}
	for changed := true; changed; {
		changed = false
		for name, fd := range decls {
			if _, ok := out[name]; ok {
				continue
			}
			keyIndex := firstStringParamIndex(fd)
			if keyIndex < 0 {
				continue
			}
			params := paramNames(fd)
			callee, ok := forwardsKeyParam(fd, params[keyIndex], keyIndex, writers, out)
			if !ok {
				continue
			}
			out[name] = settingWriteHelper{
				keyIndex:       keyIndex,
				formatterIndex: firstFuncParamIndex(fd),
				forwardsTo:     callee,
			}
			changed = true
		}
	}
	return out
}

// scanSettingWriteSites 枚举整包里**业务侧**的 settings 写点。
//
//   - 调用 helper 且**不在 helper 自己的实现里** ⇒ 记一条观测（键 → 折叠器）；
//   - 直接调用 settings 写入口且不在 helper 实现里 ⇒ 记一条"手写写点"。
func scanSettingWriteSites(t *testing.T, pkg map[string]*ast.File, writers map[string]settingsWriter, helpers map[string]settingWriteHelper) (observedWrite, []manualWriteSite) {
	t.Helper()
	out := observedWrite{}
	var manual []manualWriteSite
	for name, file := range pkg {
		var stack []ast.Node
		ast.Inspect(file, func(n ast.Node) bool {
			if n == nil {
				stack = stack[:len(stack)-1]
				return true
			}
			defer func() { stack = append(stack, n) }()
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			enclosing := enclosingFuncName(stack)
			_, insideHelper := helpers[enclosing]
			switch fun := call.Fun.(type) {
			case *ast.Ident:
				helper, ok := helpers[fun.Name]
				if !ok || insideHelper {
					return true
				}
				key, ok := settingKeyAt(call, helper.keyIndex)
				if !ok {
					t.Errorf("%s:%d: %s 调用的第 %d 个实参不是可识别的 settings 键 —— 判据无法对账（派生下标错了吗？）",
						name, lineOf(call), fun.Name, helper.keyIndex+1)
					return true
				}
				formatter := ""
				if helper.formatterIndex >= 0 {
					formatter = identOrEmpty(call, helper.formatterIndex)
					if formatter == "" {
						t.Errorf("%s:%d: 写点 %q 的折叠器不是可识别的标识符：判据无法对账", name, lineOf(call), key)
					}
				}
				if previous, dup := out[key]; dup {
					t.Errorf("写点 %q 出现两次（前一次折叠器=%q）—— 同一个键两处写法必然分叉", key, previous)
				}
				out[key] = formatter
			case *ast.SelectorExpr:
				pkgIdent, ok := fun.X.(*ast.Ident)
				if !ok || pkgIdent.Name != "serverstore" || insideHelper {
					return true
				}
				writer, ok := writers[fun.Sel.Name]
				if !ok {
					return true
				}
				key, ok := settingKeyAt(call, writer.keyIndex)
				if !ok {
					t.Errorf("%s:%d: serverstore.%s 的第 %d 个实参不是可识别的 settings 键", name, lineOf(call), fun.Sel.Name, writer.keyIndex+1)
					return true
				}
				manual = append(manual, manualWriteSite{pos: token.Position{Filename: name, Line: lineOf(call)}, key: key})
			}
			return true
		})
	}
	return out, manual
}

// parameterizedSettingsWrite 判定函数是不是**键由调用方给出**的 settings 写入口。
//
// 为什么必须区分（本轮实测踩到，两个方向都踩了）：
//   - `AddExcludedModelTx(tx, providerID, name)` 这类领域函数**自己算键**
//     （`excludedModelsKey(providerID)`）并直接 `INSERT INTO settings` —— 它是写 settings
//     表的函数，但**不是**"调用方指定键"的入口。把它算成入口，会让 llmgateway 里每一次
//     排除名单操作都被记成"手写 settings 写点"（假红）。
//   - 反过来，只认 `SetSettingTx` 这个名字，会让池上的 `SetSetting` 整类形态在面外（假绿）。
//
// 判据（源码事实，不看名字）：函数体的那次 settings 表写入里，**第一个 `string` 形参**是否
// 作为实参出现。`SetSetting(db, key, value)` / `SetSettingTx(tx, key, value)` /
// `DeleteSetting(db, key)` 都成立；上面那类"内部算键"的领域函数不成立。
func parameterizedSettingsWrite(fd *ast.FuncDecl) (int, string, bool) {
	index := firstStringParamIndex(fd)
	params := paramNames(fd)
	if index < 0 || index >= len(params) || params[index] == "" {
		return -1, "", false
	}
	keyParam := params[index]
	evidence := ""
	ast.Inspect(fd.Body, func(n ast.Node) bool {
		if evidence != "" {
			return true
		}
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sql := callStringLiterals(call)
		for _, marker := range settingsWriteSQLMarkers {
			if !strings.Contains(sql, marker) {
				continue
			}
			for _, arg := range call.Args {
				if id, ok := arg.(*ast.Ident); ok && id.Name == keyParam {
					evidence = marker
					return true
				}
			}
		}
		return true
	})
	if evidence == "" {
		return -1, "", false
	}
	return index, evidence, true
}

// forwardsKeyParam 判定 fd 是否把 `params[keyParam]` 这个形参原样转发给写入口/已确认 helper。
func forwardsKeyParam(fd *ast.FuncDecl, keyParam string, _ int, writers map[string]settingsWriter, helpers map[string]settingWriteHelper) (string, bool) {
	if keyParam == "" {
		return "", false
	}
	found := ""
	ast.Inspect(fd.Body, func(n ast.Node) bool {
		if found != "" {
			return true
		}
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		target := ""
		calleeKeyIndex := -1
		switch fun := call.Fun.(type) {
		case *ast.Ident:
			if helper, ok := helpers[fun.Name]; ok {
				target, calleeKeyIndex = fun.Name, helper.keyIndex
			}
		case *ast.SelectorExpr:
			if pkgIdent, ok := fun.X.(*ast.Ident); ok && pkgIdent.Name == "serverstore" {
				if writer, ok := writers[fun.Sel.Name]; ok {
					target, calleeKeyIndex = fun.Sel.Name, writer.keyIndex
				}
			}
		}
		if target == "" || calleeKeyIndex < 0 || calleeKeyIndex >= len(call.Args) {
			return true
		}
		if id, ok := call.Args[calleeKeyIndex].(*ast.Ident); ok && id.Name == keyParam {
			found = target
		}
		return true
	})
	return found, found != ""
}

// calledNames 返回函数体里被调用的名字（裸标识符与 selector 末段）。
func calledNames(fd *ast.FuncDecl) []string {
	var out []string
	ast.Inspect(fd.Body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		switch fun := call.Fun.(type) {
		case *ast.Ident:
			out = append(out, fun.Name)
		case *ast.SelectorExpr:
			out = append(out, fun.Sel.Name)
		}
		return true
	})
	return out
}

// paramNames 按声明顺序返回形参名（`a, b string` 展开成两个）。
func paramNames(fd *ast.FuncDecl) []string {
	var out []string
	if fd.Type == nil || fd.Type.Params == nil {
		return out
	}
	for _, field := range fd.Type.Params.List {
		for _, name := range field.Names {
			out = append(out, name.Name)
		}
		if len(field.Names) == 0 {
			out = append(out, "")
		}
	}
	return out
}

// firstStringParamIndex 返回第一个 `string` 形参的下标（-1 = 没有）。
func firstStringParamIndex(fd *ast.FuncDecl) int {
	if fd.Type == nil || fd.Type.Params == nil {
		return -1
	}
	index := 0
	for _, field := range fd.Type.Params.List {
		names := len(field.Names)
		if names == 0 {
			names = 1
		}
		if ident, ok := field.Type.(*ast.Ident); ok && ident.Name == "string" {
			return index
		}
		index += names
	}
	return -1
}

// firstFuncParamIndex 返回第一个函数类型形参的下标（-1 = 没有）。
//
// 用途：折叠器就是这样一个形参（`format func(string) string`）。它决定调用点上"哪个
// 实参是折叠器"，从而不需要在判据里写死 helper 的签名。
func firstFuncParamIndex(fd *ast.FuncDecl) int {
	if fd.Type == nil || fd.Type.Params == nil {
		return -1
	}
	index := 0
	for _, field := range fd.Type.Params.List {
		names := len(field.Names)
		if names == 0 {
			names = 1
		}
		if _, ok := field.Type.(*ast.FuncType); ok {
			return index
		}
		index += names
	}
	return -1
}

// settingKeyAt 取调用实参里第 index 个位置上的 settings 键（支持常量形式）。
func settingKeyAt(call *ast.CallExpr, index int) (string, bool) {
	if index < 0 || index >= len(call.Args) {
		return "", false
	}
	if value, ok := stringLiteral(call.Args[index]); ok {
		return value, true
	}
	if name, ok := identName(call.Args[index]); ok {
		key := constantSettingKey(name)
		if key != "" {
			return key, true
		}
		return "", false
	}
	return "", false
}

// identOrEmpty 取调用实参里第 index 个位置上的标识符名（不是标识符时返回空串）。
func identOrEmpty(call *ast.CallExpr, index int) string {
	if index < 0 || index >= len(call.Args) {
		return ""
	}
	if id, ok := call.Args[index].(*ast.Ident); ok {
		return id.Name
	}
	return ""
}

// goFset 是判据用的共享 FileSet（位置信息只用于诊断，不做任何判定）。
var goFset = token.NewFileSet()

// lineOf 返回节点所在行（诊断用）。
func lineOf(node ast.Node) int { return goFset.Position(node.Pos()).Line }

// parseGoPackage 解析一个包目录里的非测试 .go 文件（键 = 文件名）。
func parseGoPackage(t *testing.T, dir string) map[string]*ast.File {
	t.Helper()
	pkgs, err := parser.ParseDir(goFset, dir, func(fi fs.FileInfo) bool {
		return !strings.HasSuffix(fi.Name(), "_test.go")
	}, parser.SkipObjectResolution)
	if err != nil {
		t.Fatalf("解析包目录 %s: %v", dir, err)
	}
	out := map[string]*ast.File{}
	for _, pkg := range pkgs {
		for name, file := range pkg.Files {
			out[name] = file
		}
	}
	if len(out) == 0 {
		t.Fatalf("包目录 %s 里一个非测试 .go 都没解析到：扫描根失效（判据会恒真）", dir)
	}
	return out
}

// enclosingFuncName 返回最近的函数/方法名（匿名函数返回外层函数名）。
func enclosingFuncName(stack []ast.Node) string {
	for i := len(stack) - 1; i >= 0; i-- {
		if fd, ok := stack[i].(*ast.FuncDecl); ok && fd.Name != nil {
			return fd.Name.Name
		}
	}
	return ""
}

// callStringLiterals 把一个调用实参里的字符串字面量按顺序拼起来（SQL 文本的近似）。
func callStringLiterals(call *ast.CallExpr) string {
	var b strings.Builder
	for _, a := range call.Args {
		ast.Inspect(a, func(n ast.Node) bool {
			if bl, ok := n.(*ast.BasicLit); ok && bl.Kind == token.STRING {
				b.WriteString(strings.Trim(bl.Value, "`\""))
			}
			return true
		})
	}
	return b.String()
}

// constantSettingKey 把以常量形式给出的 settings 键映射回字面量。
//
// 取值来自 llmgateway 自身与 `serverstore` 的常量定义（两处都是这个键的唯一真源，
// 常量改名时本表会因"观测不到的键"而变红 —— 那正是要对账的东西）。
func constantSettingKey(name string) string {
	switch name {
	case "SettingMaxFileRefs":
		return SettingMaxFileRefs
	case "SettingBodyParseBudgetMB":
		return SettingBodyParseBudgetMB
	case "SettingFileExpiryDays":
		return SettingFileExpiryDays
	case "UnpricedModelPolicySetting":
		return "gateway.unpriced_model_policy"
	case "PeakWindowsSetting":
		return "usage.peak_windows"
	case "RetentionMonthsSetting":
		return "usage.retention_months"
	default:
		return ""
	}
}

// stringLiteral 取字符串字面量的值。
func stringLiteral(expr ast.Expr) (string, bool) {
	literal, ok := expr.(*ast.BasicLit)
	if !ok || literal.Kind != token.STRING {
		return "", false
	}
	value, err := strconv.Unquote(literal.Value)
	if err != nil {
		return "", false
	}
	return value, true
}

// identName 取标识符名（settings 键以常量给出时用；`serverstore.XxxSetting` 取末段）。
func identName(expr ast.Expr) (string, bool) {
	switch typed := expr.(type) {
	case *ast.Ident:
		return typed.Name, true
	case *ast.SelectorExpr:
		return typed.Sel.Name, true
	default:
		return "", false
	}
}

// formatterName 取折叠器的名字（只接受裸标识符：`redact…` 这类包内函数）。
func formatterName(expr ast.Expr) string {
	ident, ok := expr.(*ast.Ident)
	if !ok {
		return ""
	}
	if strings.Contains(ident.Name, "redact") || strings.Contains(ident.Name, "Redact") {
		return ident.Name
	}
	return ident.Name
}
