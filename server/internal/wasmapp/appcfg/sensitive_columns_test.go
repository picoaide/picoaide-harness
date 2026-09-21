package appcfg

// 本文件是**作者声明敏感列**（`sensitive_columns`，§5.9 第 8 点后半）在 appcfg 这一侧的
// 判据：契约、归一化、上限、继承。
//
// 为什么这些判据必须在 appcfg（而不是只测 api/rows.go 的脱敏）：声明是**作者契约** ——
// 它要进字段规格（appcfg.json / SKILL 生成物）、要参与版本继承、要有界。脱敏面只是
// 消费方之一；把"契约"与"用法"分开测，才能在契约被改坏时立刻红在真源上。
//
// 变异验证（实跑）：
//   - 删掉 decodeAs 里的 sensitive_columns 解析 ⇒ TestSensitiveColumnsContract 红；
//   - 去掉 normalizeSensitiveColumns 的 ToLower 去重（改成原样去重）⇒ 同用例的
//     大小写去重断言红；
//   - 去掉长度检查 ⇒ TestSensitiveColumnsBounds 的 64 字节断言红；
//   - 去掉 Validate 的条目数上限 ⇒ 同用例的 100 条断言红；
//   - 删掉 parseBaseline 的 sensitive_columns 分支 ⇒ TestSensitiveColumnsInheritance 红。

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// sensitiveCfg 造一份带声明的最小合法配置（首版声明的三个字段都齐）。
func sensitiveCfg(cols []string) string {
	b, err := json.Marshal(map[string]any{
		"access":            "login",
		"purpose":           "工位管理",
		"data_sensitivity":  "internal",
		"owner":             "zhangwei",
		"sensitive_columns": cols,
	})
	if err != nil {
		panic(err)
	}
	return string(b)
}

// TestSensitiveColumnsContract 钉住"声明能被解析、能归一化、且大小写不敏感去重"。
func TestSensitiveColumnsContract(t *testing.T) {
	c := mustParse(t, sensitiveCfg([]string{" workstation_no ", "dorm_room", "Phone", "phone"}))
	want := []string{"workstation_no", "dorm_room", "Phone"}
	if !reflect.DeepEqual(c.SensitiveColumns, want) {
		t.Fatalf("sensitive_columns = %v, want %v（去首尾空白 + 大小写不敏感去重，保留首次出现的原样写法）",
			c.SensitiveColumns, want)
	}
	// 缺失 = 空名单（不是错误；旧配置照样能读）。
	plain := mustParse(t, `{"access":"login"}`)
	if len(plain.SensitiveColumns) != 0 {
		t.Fatalf("未声明时 sensitive_columns = %v, want 空", plain.SensitiveColumns)
	}
	// 显式 `[]` = 清空（合法）。
	empty := mustParse(t, sensitiveCfg([]string{}))
	if len(empty.SensitiveColumns) != 0 {
		t.Fatalf("显式空数组应解析成空名单，得到 %v", empty.SensitiveColumns)
	}
	// 形态错误（不是字符串数组）⇒ APP_CONFIG_INVALID 且点名字段。
	_, e := Parse([]byte(`{"access":"login","sensitive_columns":"phone"}`))
	if e == nil || e.Code != apperr.CodeAppConfigBad || e.Details["field"] != FieldSensitiveColumns {
		t.Fatalf("sensitive_columns 不是数组时应回 APP_CONFIG_INVALID + field=%s，得到 %v", FieldSensitiveColumns, e)
	}
	// 未知字段检查不受影响（拼错的字段不会被静默忽略）。
	_, e = Parse([]byte(`{"access":"login","sensitive_column":["x"]}`))
	if e == nil || e.Details["reason"] != "unknown_field" {
		t.Fatalf("拼错的字段名应被拒（unknown_field），得到 %v", e)
	}
}

// TestSensitiveColumnsBounds 钉住两条上限（条目数 / 单条字节数）与空条目。
func TestSensitiveColumnsBounds(t *testing.T) {
	// ① 条目数上限：恰好上限通过，超一条拒。
	atMax := make([]string, 0, limits.AppConfigSensitiveColumnsMax)
	for i := 0; i < limits.AppConfigSensitiveColumnsMax; i++ {
		atMax = append(atMax, "col_"+itoaTest(i))
	}
	if _, e := Parse([]byte(sensitiveCfg(atMax))); e != nil {
		t.Fatalf("%d 条声明（= 上限）应通过，得到 %v", len(atMax), e)
	}
	over := append(append([]string{}, atMax...), "one_more")
	_, e := Parse([]byte(sensitiveCfg(over)))
	if e == nil || e.Code != apperr.CodeAppConfigBad || e.Details["field"] != FieldSensitiveColumns {
		t.Fatalf("超条目上限的错误应点名 %s，得到 %v", FieldSensitiveColumns, e)
	}
	if got, _ := e.Details["max"].(int); got != limits.AppConfigSensitiveColumnsMax {
		t.Fatalf("上限 details.max = %v, want %d（数字必须来自 limits 真源）", e.Details["max"], limits.AppConfigSensitiveColumnsMax)
	}

	// ② 单条字节上限：恰好 64 字节通过，65 字节拒。
	okName := strings.Repeat("a", limits.AppConfigSensitiveColumnMaxBytes)
	if _, e := Parse([]byte(sensitiveCfg([]string{okName}))); e != nil {
		t.Fatalf("%d 字节的列名（= 上限）应通过，得到 %v", len(okName), e)
	}
	tooLong := strings.Repeat("a", limits.AppConfigSensitiveColumnMaxBytes+1)
	_, e = Parse([]byte(sensitiveCfg([]string{tooLong})))
	if e == nil || e.Details["reason"] != "entry_too_long" {
		t.Fatalf("超过单条字节上限应被拒（entry_too_long），得到 %v", e)
	}
	if got, _ := e.Details["max_bytes"].(int); got != limits.AppConfigSensitiveColumnMaxBytes {
		t.Fatalf("details.max_bytes = %v, want %d", e.Details["max_bytes"], limits.AppConfigSensitiveColumnMaxBytes)
	}

	// ③ 空条目/纯空白 ⇒ 拒（不要用空行占位）。
	for _, bad := range [][]string{{""}, {"  "}, {"phone", " "}} {
		if _, e := Parse([]byte(sensitiveCfg(bad))); e == nil || e.Details["reason"] != "empty_entry" {
			t.Fatalf("空条目 %q 应被拒（empty_entry），得到 %v", bad, e)
		}
	}

	// ④ Validate 复查长度（Config 也可能被程序化构造/继承合并出来，不经过 normalize）。
	c := mustParse(t, sensitiveCfg([]string{"phone"}))
	c.SensitiveColumns = []string{tooLong}
	if e := c.Validate(false); e == nil || e.Details["reason"] != "entry_too_long" {
		t.Fatalf("Validate 必须复查单条长度（继承/程序化构造路径不经过 normalize），得到 %v", e)
	}
	c.SensitiveColumns = over
	if e := c.Validate(false); e == nil || e.Details["field"] != FieldSensitiveColumns {
		t.Fatalf("Validate 必须复查条目数上限，得到 %v", e)
	}
}

// TestSensitiveColumnsInheritance 钉住"缺席=沿用上一版、显式 [] = 清空"。
//
// 为什么这条在"加法声明"上尤其重要：声明被静默丢掉 = 某些列从"默认脱敏"退回明文，
// 而新版本看起来一切正常（没有任何报错）。因此继承必须**显式**实现（parseBaseline 的
// 数组分支），不能指望 default 分支——那个分支按字符串解码，数组会被 delete 掉。
func TestSensitiveColumnsInheritance(t *testing.T) {
	previous := sensitiveCfg([]string{"workstation_no", "dorm_room"})

	// ① 提交里缺席 ⇒ 沿用上一版的声明。
	c, e := ParseUpdate([]byte(`{"access":"login"}`), previous)
	if e != nil {
		t.Fatalf("ParseUpdate: %v", e)
	}
	if !reflect.DeepEqual(c.SensitiveColumns, []string{"workstation_no", "dorm_room"}) {
		t.Fatalf("缺席字段必须沿用上一版声明，得到 %v（丢掉声明 = 某些列退回明文）", c.SensitiveColumns)
	}

	// ② 显式 [] ⇒ 清空（显式给值以提交为准）。
	c, e = ParseUpdate([]byte(`{"access":"login","sensitive_columns":[]}`), previous)
	if e != nil {
		t.Fatalf("ParseUpdate: %v", e)
	}
	if len(c.SensitiveColumns) != 0 {
		t.Fatalf("显式空数组应清空声明，得到 %v", c.SensitiveColumns)
	}

	// ③ 显式新值 ⇒ 覆盖。
	c, e = ParseUpdate([]byte(`{"access":"login","sensitive_columns":["id_card_no"]}`), previous)
	if e != nil {
		t.Fatalf("ParseUpdate: %v", e)
	}
	if !reflect.DeepEqual(c.SensitiveColumns, []string{"id_card_no"}) {
		t.Fatalf("显式值应覆盖上一版，得到 %v", c.SensitiveColumns)
	}

	// ④ 基线的声明是空数组 ⇒ 视为"没有这项"（与 whitelist 同口径），不一致失败。
	c, e = ParseUpdate([]byte(`{"access":"login"}`), sensitiveCfg([]string{}))
	if e != nil {
		t.Fatalf("ParseUpdate: %v", e)
	}
	if len(c.SensitiveColumns) != 0 {
		t.Fatalf("空基线不应变出声明，得到 %v", c.SensitiveColumns)
	}
}

// TestSensitiveColumnLookupHelpers 钉住脱敏路径真正用的两个纯函数（加法 + 大小写不敏感 + 逐字）。
func TestSensitiveColumnLookupHelpers(t *testing.T) {
	set := SensitiveColumnSet([]string{"Workstation_No", " dorm_room "})
	for _, name := range []string{"workstation_no", "WORKSTATION_NO", "dorm_room", "Dorm_Room"} {
		if !DeclaredSensitiveColumn(set, name) {
			t.Errorf("声明匹配必须大小写不敏感：%q 未命中", name)
		}
	}
	// 逐字匹配（不做前缀/子串）：声明 `no` 不该遮住 `order_no`。
	narrow := SensitiveColumnSet([]string{"no"})
	if DeclaredSensitiveColumn(narrow, "order_no") {
		t.Error("声明是逐字的：`no` 不得匹配 `order_no`（模糊判定是启发式的职责）")
	}
	if DeclaredSensitiveColumn(nil, "phone") {
		t.Error("空名单不得命中任何列")
	}
	if got := SensitiveColumnSet(nil); got != nil {
		t.Errorf("空名单应返回 nil，得到 %v", got)
	}
}

// TestSensitiveColumnsOfConfigJSON 钉住投影读取的"坏行不编造"。
func TestSensitiveColumnsOfConfigJSON(t *testing.T) {
	if got := SensitiveColumnsOfConfigJSON(""); got != nil {
		t.Fatalf("空 config_json ⇒ 空名单，得到 %v", got)
	}
	if got := SensitiveColumnsOfConfigJSON("{not json"); got != nil {
		t.Fatalf("坏 JSON ⇒ 空名单（回落默认启发式），得到 %v", got)
	}
	got := SensitiveColumnsOfConfigJSON(sensitiveCfg([]string{"workstation_no"}))
	if !reflect.DeepEqual(got, []string{"workstation_no"}) {
		t.Fatalf("SensitiveColumnsOfConfigJSON = %v", got)
	}
}

// itoaTest 是测试内的十进制渲染（避免为一个用例引入 strconv 之外的东西）。
func itoaTest(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
