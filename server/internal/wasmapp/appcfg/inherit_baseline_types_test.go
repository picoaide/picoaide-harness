package appcfg

// 本文件是 `parseBaseline` 的**按类型解码**判据（2026-09-21 修复的相邻缺陷）。
//
// 缺陷现场：`parseBaseline` 曾用 `default:` 分支按**字符串**解码剩余字段，于是
// **对象**字段（`window`）解码失败被 `delete` ⇒ "上一版声明的窗口尺寸/比例在更新版本时
// 不会沿用"，与生成物里写着的"整个 `window` 缺席 = 沿用上一版生效值（与其它字段同一条
// 继承规则）"直接矛盾；而全仓测试**零覆盖**（这一条也是本文件存在的理由）。
//
// 判据三组（双向）：
//
//	① TestBaselineInheritsEveryKnownFieldByType —— 每个 KnownFields 字段都有一条
//	   "上一版给过值 ⇒ 本版缺席 ⇒ 继承生效"的行为判据（表必须覆盖 KnownFields 全集，
//	   新增字段忘了登记 ⇒ 红 —— 这是"别再用字符串兜底"的落地）；
//	② TestBaselineExplicitValuesOverrideInheritance —— 本版**显式给值**（含显式空/null）
//	   必须覆盖继承（防"永远沿用旧值"这条反向错误）；
//	③ TestBaselineEmptyValuesAreNotInherited —— `""` / `[]` / `{}` 不算"上一版给过值"
//	   （空值被继承会让 schema 缺省语义被抹掉）；其中**数组字段的 `[]`** 在行为上与
//	   "缺席"等价（两者最终都落到空名单），所以另有一条 `parseBaseline` 层的补充断言
//	   （TestBaselineEmptyValuesAreDroppedFromBaselineMap）把"空值不进基线 map"这条
//	   规则本身钉住。
//
// 变异验证（实跑）：
//   - 把 baselineValueUsable 的 FieldWindow 分支改回"按字符串解码"（旧实现）⇒ ① 的
//     window 子用例红（`上一版给过 window=… 本版缺席时未继承（得到 ）`）；
//   - 去掉 FieldWindow 分支的 `len(obj) > 0`（`{}` 也算给过值）⇒ ③ 的 window 空对象
//     子用例红（`不得作为继承基线…得到 {}`）；
//   - 去掉 FieldWhitelist/FieldSensitiveColumns 的 `len(list) > 0` ⇒ 补充断言红
//     （行为等价，理由见 ③）；
//   - 把 mergeMissing 的"提交里已有的键不填"改成无条件填 ⇒ ② 红
//     （`显式 window 必须覆盖上一版（want 800×600），得到 &{Ratio:1.7778 Width:1600 Height:900}`）。

import (
	"encoding/json"
	"reflect"
	"sort"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
)

// baselineFixture 是"上一版给过值"的字段 → 该字段的合法取值（JSON 片段）。
//
// 它必须覆盖 **KnownFields 全集**：漏一个就等于"那个字段的继承没有判据"，
// 由 TestBaselineInheritsEveryKnownFieldByType 的第一段对拍钉住。
//
// 取值刻意都用**能逐字节往返**的形态（ratio 写浮点而不是 "16:9"，因为后者在解析时
// 会被折算成 1.7777777777777777，与"原样比较"不是一回事）。
var baselineFixture = map[string]json.RawMessage{
	FieldAccess:           json.RawMessage(`"whitelist"`),
	FieldWhitelist:        json.RawMessage(`["zhangwei"]`),
	FieldPurpose:          json.RawMessage(`"报销单自动整理"`),
	FieldDataSensitivity:  json.RawMessage(`"internal"`),
	FieldOwner:            json.RawMessage(`"zhangwei"`),
	FieldSensitiveColumns: json.RawMessage(`["workstation_no"]`),
	FieldWindow:           json.RawMessage(`{"ratio":1.7778,"width":1600,"height":900}`),
}

// TestBaselineInheritsEveryKnownFieldByType 是判据 ①（含"表覆盖全集"的门禁）。
func TestBaselineInheritsEveryKnownFieldByType(t *testing.T) {
	// ① 表必须覆盖 KnownFields 全集（双向：不多不少）。
	keys := make([]string, 0, len(baselineFixture))
	for k := range baselineFixture {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	want := append([]string(nil), KnownFields...)
	sort.Strings(want)
	if !reflect.DeepEqual(keys, want) {
		t.Fatalf("baselineFixture 的字段集合 %v 必须与 KnownFields %v 逐项一致 —— "+
			"新增字段必须在这里登记一条继承判据（旧实现的字符串兜底就是这么漏掉 window 的）", keys, want)
	}

	// ② 逐个字段：只给这一个字段的基线 + 一个"什么都不给"的提交 ⇒ 必须继承到。
	for _, field := range want {
		t.Run(field, func(t *testing.T) {
			baseline := baselineFor(t, map[string]json.RawMessage{field: baselineFixture[field]})
			c, e := ParseUpdate([]byte(`{}`), baseline)
			if e != nil {
				t.Fatalf("ParseUpdate(%s 基线) = %v", field, e)
			}
			got := valueOf(t, c, field)
			wantValue := normalizeJSON(t, string(baselineFixture[field]))
			if got != wantValue {
				t.Fatalf("上一版给过 %s=%s，本版缺席时未继承（得到 %s）—— "+
					"基线判定必须按**字段类型**解码，字符串兜底会把非字符串字段静默丢掉",
					field, wantValue, got)
			}
		})
	}
}

// TestBaselineExplicitValuesOverrideInheritance 是判据 ②（反向：显式覆盖必须赢）。
func TestBaselineExplicitValuesOverrideInheritance(t *testing.T) {
	baseline := baselineFor(t, map[string]json.RawMessage{
		FieldWindow:           baselineFixture[FieldWindow],
		FieldSensitiveColumns: baselineFixture[FieldSensitiveColumns],
		FieldAccess:           json.RawMessage(`"whitelist"`),
	})
	// 显式给出新值：窗口 800×600、声明清空。
	submitted := `{"access":"whitelist","whitelist":["zhangwei"],` +
		`"window":{"width":800,"height":600},"sensitive_columns":[]}`
	c, e := ParseUpdate([]byte(submitted), baseline)
	if e != nil {
		t.Fatalf("ParseUpdate(显式覆盖) = %v", e)
	}
	if c.Window == nil || c.Window.Width != 800 || c.Window.Height != 600 {
		t.Fatalf("显式 window 必须覆盖上一版（want 800×600），得到 %+v", c.Window)
	}
	if c.Window.Ratio != 0 {
		t.Fatalf("显式 window 未给 ratio ⇒ 不得把上一版的 ratio 带回来，得到 %v", c.Window.Ratio)
	}
	if len(c.SensitiveColumns) != 0 {
		t.Fatalf("显式空数组必须清空声明（覆盖继承），得到 %v", c.SensitiveColumns)
	}
	// 显式 null 也是"清空"（window 的既有语义），不得回落基线。
	cleared, e := ParseUpdate([]byte(`{"access":"whitelist","whitelist":["zhangwei"],"window":null}`), baseline)
	if e != nil {
		t.Fatalf("ParseUpdate(window=null) = %v", e)
	}
	if cleared.Window != nil {
		t.Fatalf("显式 null 必须清空 window（不得回落基线），得到 %+v", cleared.Window)
	}
}

// TestBaselineEmptyValuesAreNotInherited 是判据 ③（空值不算给过值）。
func TestBaselineEmptyValuesAreNotInherited(t *testing.T) {
	cases := []struct {
		name  string
		field string
		raw   json.RawMessage
	}{
		{"whitelist 空数组", FieldWhitelist, json.RawMessage(`[]`)},
		{"sensitive_columns 空数组", FieldSensitiveColumns, json.RawMessage(`[]`)},
		{"window 空对象", FieldWindow, json.RawMessage(`{}`)},
		{"声明字段空白串", FieldPurpose, json.RawMessage(`"   "`)},
		{"声明字段空串", FieldOwner, json.RawMessage(`""`)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			baseline := baselineFor(t, map[string]json.RawMessage{tc.field: tc.raw})
			c, e := ParseUpdate([]byte(`{}`), baseline)
			if e != nil {
				t.Fatalf("ParseUpdate(%s=%s) = %v", tc.field, tc.raw, e)
			}
			if got := valueOf(t, c, tc.field); got != "" {
				t.Fatalf("空值 %s=%s 不得作为继承基线（会让缺省语义被抹掉），得到 %s",
					tc.field, tc.raw, got)
			}
		})
	}
	// 非法 access 同样不算给过值：基线整体不可用 ⇒ **fail-closed**（拒绝发布），
	// 而不是"把非法值继承进新版本"或"静默回落 login"。
	// 这里刻意不经过 baselineFor：那份夹具有"基线本身必须合法"的前置断言。
	_, e := ParseUpdate([]byte(`{}`), `{"access":"bogus"}`)
	if e == nil || e.Code != apperr.CodeAppConfigBad || e.Details["reason"] != "baseline_unusable" {
		t.Fatalf("非法 access 的基线必须判为不可用（baseline_unusable，fail-closed），得到 %v", e)
	}
}

// TestBaselineEmptyValuesAreDroppedFromBaselineMap 是 ③ 的补充断言：
// **空值不得进入基线 map**（规则本身，而不是它在当前 schema 下的行为后果）。
//
// 为什么要单独一条：数组字段的 `[]` 与"缺席"在当前 schema 下最终等价（都落到空名单），
// 所以"空值也算给过值"这个变异在端到端行为上**测不出来**（等价变异）。但这条规则是
// parseBaseline 的对外契约（"可继承字段 → 原始值"里不含空值），也是 whitelist 的既有
// 语义；直接对 map 断言才能把它钉住，并且将来给某个数组字段引入"空数组 ≠ 缺席"的语义时
// 不会悄悄回归。
func TestBaselineEmptyValuesAreDroppedFromBaselineMap(t *testing.T) {
	cases := []struct {
		name  string
		field string
		raw   json.RawMessage
	}{
		{"whitelist 空数组", FieldWhitelist, json.RawMessage(`[]`)},
		{"sensitive_columns 空数组", FieldSensitiveColumns, json.RawMessage(`[]`)},
		{"window 空对象", FieldWindow, json.RawMessage(`{}`)},
		{"声明字段空白串", FieldPurpose, json.RawMessage(`"   "`)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			base, state := parseBaseline(baselineFor(t, map[string]json.RawMessage{tc.field: tc.raw}))
			if state != BaselineUsable {
				t.Fatalf("夹具基线应可用，得到 state=%v", state)
			}
			if _, ok := base[tc.field]; ok {
				t.Fatalf("空值 %s=%s 不得进入基线 map（它不是「上一版给过的值」）",
					tc.field, tc.raw)
			}
		})
	}
}

// ===== 工具 =====

// baselineFor 造一份"上一版 config_json"：给定字段用给定 JSON 片段，其余给最小合法值。
func baselineFor(t *testing.T, fields map[string]json.RawMessage) string {
	t.Helper()
	body := map[string]json.RawMessage{FieldAccess: json.RawMessage(`"login"`)}
	for k, v := range fields {
		body[k] = v
	}
	// whitelist 与 access=whitelist 必须成对（否则 decode 会按"whitelist 模式无名单"拒）。
	if string(body[FieldAccess]) == `"whitelist"` {
		if _, ok := body[FieldWhitelist]; !ok {
			body[FieldWhitelist] = json.RawMessage(`["zhangwei"]`)
		}
	}
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("构造基线: %v", err)
	}
	// 基线必须是**能解析的**（parseBaseline 对坏基线 fail-closed，会让本用例测不到继承）。
	if _, e := Parse(raw); e != nil {
		t.Fatalf("夹具基线本身不合法（%s）：%v", raw, e)
	}
	return string(raw)
}

// valueOf 把一个字段的**生效值**渲染成规范 JSON（空串 = 该字段没有值/schema 缺省）。
//
// 比较口径统一走 JSON：文本字段带引号、数组是 JSON 数组、window 按结构体键序重新编码
// 后再规范化（键排序），因此"继承到的值"与"夹具片段"可以逐字节比较。
func valueOf(t *testing.T, c Config, field string) string {
	t.Helper()
	switch field {
	case FieldAccess:
		if c.Access == "" {
			return ""
		}
		return normalizeJSON(t, string(mustJSON(t, string(c.Access))))
	case FieldWhitelist:
		return listJSON(t, c.Whitelist)
	case FieldPurpose:
		return textJSON(t, c.Purpose)
	case FieldDataSensitivity:
		return textJSON(t, c.DataSensitivity)
	case FieldOwner:
		return textJSON(t, c.Owner)
	case FieldSensitiveColumns:
		return listJSON(t, c.SensitiveColumns)
	case FieldWindow:
		if c.Window == nil {
			return ""
		}
		return normalizeJSON(t, mustJSON(t, c.Window))
	default:
		t.Fatalf("valueOf 不认识字段 %q（新增字段必须同步本文件）", field)
		return ""
	}
}

// textJSON 渲染一个文本字段（空 ⇒ 空串 = 没有值）。
func textJSON(t *testing.T, s string) string {
	t.Helper()
	if s == "" {
		return ""
	}
	return normalizeJSON(t, string(mustJSON(t, s)))
}

// listJSON 渲染一个字符串数组字段（空 ⇒ 空串 = 没有值）。
func listJSON(t *testing.T, list []string) string {
	t.Helper()
	if len(list) == 0 {
		return ""
	}
	return normalizeJSON(t, string(mustJSON(t, list)))
}

// normalizeJSON 把 JSON 片段压成"解析后重新编码"的规范形态（忽略键序/空白差异）。
func normalizeJSON(t *testing.T, raw string) string {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		t.Fatalf("非法 JSON 片段 %q: %v", raw, err)
	}
	out, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("重新编码: %v", err)
	}
	return string(out)
}

// mustJSON 是测试内的编码便捷（失败即红）。
func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}
