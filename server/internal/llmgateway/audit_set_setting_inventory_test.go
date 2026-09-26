package llmgateway

import (
	"go/ast"
	"go/parser"
	"go/token"
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
//   - 观测面 = 直接解析 `admin.go` 的 AST：多一个写点、少一个写点、把折叠器换成别的、
//     或者绕过 helper 手写 `SetSettingTx`，**任一形态都红**；
//   - 反面防空转：扫描面必须真的收到 helper 的调用（否则"零违规"没有意义）。
//
// 已知边界（写在这里，不假装覆盖了它）：判据认的是**写点的形状**，不是取值的语义 ——
// 一个今天不是 URL 的键（例如未来的某个字符串配置）被改成承载 URL 时，本判据不会自己
// 变红；这正是"登记项的 `why` 必须写清取值形态"的原因：改语义的人要改这一行。
// ===========================================================================

// auditSettingWrite 是一个写点的登记项。
type auditSettingWrite struct {
	/** 期望的折叠器；空串 = 明文进 detail（必须写明为什么它不是 URL/凭据）。 */
	formatter string
	/** 为什么是这个判定（必须写清取值形态，不能只写"不需要"）。 */
	why string
}

// auditSettingInventory 是 `admin.go` 里全部 settings 写点的登记表（键 = settings 键）。
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

// TestAuditSettingWritePointsAreInventoryComplete 把 `admin.go` 的 settings 写点与
// 上面的登记表做**双向**对账（新增/删除/换折叠器/绕过 helper 四种形态都红）。
func TestAuditSettingWritePointsAreInventoryComplete(t *testing.T) {
	observed := scanAuditSettingWrites(t)

	// 反面防空转：helper 的调用必须真的被扫到（否则表与代码脱钩也不会红）。
	if len(observed) < 10 {
		t.Fatalf("扫描面只收到 %d 个 auditSetSetting* 调用点 ⇒ 判据会空转（是不是 helper 改名/搬文件了？）", len(observed))
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
			continue // 手写写点，见 TestAuditSettingWritePointsAreInventoryComplete 的第二个断言
		}
		t.Errorf("登记表里的写点 %q 已经不存在了 —— 请删掉这条陈旧登记（%s）", key, entry.why)
	}
	// 每条登记都必须写明理由（空/敷衍的理由等于免检）。
	for key, entry := range auditSettingInventory {
		if len([]rune(entry.why)) < 12 {
			t.Errorf("登记项 %q 的理由太短：必须写清取值形态与判定依据", key)
		}
	}

	// 手写写点（不经 helper）也必须登记：判据是"SetSettingTx 的调用点数量 ==
	// helper 写点数量 + 登记的手写写点数量"。绕过 helper 新增一个设置写入 ⇒ 红。
	if manual := scanManualSettingWrites(t); manual != 1 {
		t.Errorf("admin.go 里有 %d 处**绕过 helper** 的 serverstore.SetSettingTx 调用，登记的手写写点只有 1 处（gateway.default_model）—— "+
			"新增手写写点必须同时登记它的取值形态", manual)
	}
	if _, ok := observed["gateway.default_model"]; ok {
		t.Error("gateway.default_model 不应该出现在 helper 的观测面里（它是手写写点）—— 判据的假设变了，请同步修正")
	}
}

// observedWrite 记录一次 auditSetSetting* 调用点的观测结果（键 → 折叠器名）。
type observedWrite = map[string]string

// scanAuditSettingWrites 解析 `admin.go`，取出全部 `auditSetSettingTx` /
// `auditSetSettingFormattedTx` 调用点的（settings 键 → 折叠器名）。
func scanAuditSettingWrites(t *testing.T) observedWrite {
	t.Helper()
	out := observedWrite{}
	ast.Inspect(parseAdminGo(t), func(node ast.Node) bool {
		// 跳过 helper 自己的转发实现（`auditSetSettingTx` 体内的那一次调用传的是形参，
		// 不是 settings 键）—— 其余调用点都在 `setGatewayConfig` 这类业务函数里。
		if decl, ok := node.(*ast.FuncDecl); ok && decl.Name != nil && decl.Name.Name == "auditSetSettingTx" {
			return false
		}
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		ident, ok := call.Fun.(*ast.Ident)
		if !ok {
			return true
		}
		var formatter string
		switch ident.Name {
		case "auditSetSettingTx":
			formatter = ""
		case "auditSetSettingFormattedTx":
			if len(call.Args) < 6 {
				t.Errorf("auditSetSettingFormattedTx 的实参少于 6 个：%v", call.Pos())
				return true
			}
		default:
			return true
		}
		if len(call.Args) < 3 {
			t.Errorf("%s 的实参少于 3 个", ident.Name)
			return true
		}
		key, ok := stringLiteral(call.Args[2])
		if !ok {
			// 键是常量（例如 SettingMaxFileRefs）时按标识符名反查。
			if name, ok := identName(call.Args[2]); ok {
				key = constantSettingKey(name)
			}
		}
		if key == "" {
			t.Errorf("%s 的第 3 个实参不是可识别的 settings 键：%v", ident.Name, call.Pos())
			return true
		}
		if ident.Name == "auditSetSettingFormattedTx" {
			formatter = formatterName(call.Args[5])
			if formatter == "" {
				t.Errorf("写点 %q 的折叠器不是可识别的标识符：判据无法对账", key)
			}
		}
		if previous, dup := out[key]; dup {
			t.Errorf("写点 %q 出现两次（前一次折叠器=%q）—— 同一个键两处写法必然分叉", key, previous)
		}
		out[key] = formatter
		return true
	})
	return out
}

// constantSettingKey 把 `admin.go` 里以常量形式给出的 settings 键映射回字面量。
//
// 取值来自 `admin.go` 自身与 `serverstore` 的常量定义（两处都是这个键的唯一真源，
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

// scanManualSettingWrites 数 `admin.go` 里**绕过 helper** 的 `serverstore.SetSettingTx`
// 调用点（helper 自己内部那一次不算：它就是 helper 的实现）。
func scanManualSettingWrites(t *testing.T) int {
	t.Helper()
	count := 0
	ast.Inspect(parseAdminGo(t), func(node ast.Node) bool {
		if decl, ok := node.(*ast.FuncDecl); ok && decl.Name != nil && decl.Name.Name == "auditSetSettingFormattedTx" {
			return false // helper 自己的实现，不算"绕过"
		}
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		pkg, ok := selector.X.(*ast.Ident)
		if ok && pkg.Name == "serverstore" && selector.Sel.Name == "SetSettingTx" {
			count++
		}
		return true
	})
	return count
}

// parseAdminGo 解析本包的 `admin.go`（判据的输入缺失不得静默通过）。
func parseAdminGo(t *testing.T) *ast.File {
	t.Helper()
	file, err := parser.ParseFile(token.NewFileSet(), "admin.go", nil, parser.SkipObjectResolution)
	if err != nil {
		t.Fatalf("解析 admin.go 失败：%v", err)
	}
	return file
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
