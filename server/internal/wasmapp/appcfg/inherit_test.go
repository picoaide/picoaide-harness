// 更新发布的配置继承（R1-pm-10 / R1-uxc-8）的**行为级护栏**。
//
// 判据（主控定调：服务端兑现"缺省=沿用上一版"，而不是改文案迁就实现）：
//
//	① 更新时省略 access      ⇒ 沿用上一版生效值（白名单应用**不放开**；
//	   历史 public 基线在读取侧即 login ⇒ 继承到 login，2026-09-19 契约 §4.4）
//	② 更新时显式写 access    ⇒ 真的按显式值改（显式空串不是"缺席"，会被拒）
//	③ 省略 purpose/data_sensitivity/owner ⇒ 沿用（不被清空）；显式空串才清空
//	④ 首版省略 access        ⇒ 仍是 login（既有语义不回归）
//	⑤ 旧 schema 的 visible/login_required **不参与"字段是否缺席"的判定**：带了它们
//	   也照样继承 access 轴（既不算显式声明，也不关掉继承）；首版才按 shim 映射
//	⑥ 基线**不可用**（非空但解析不了）⇒ 拒绝发布（UnusableBaselineError），不是回落 login
//	   —— 回落 login 对白名单应用是**放宽**（2026-09-19 审计 §1.4）
//
// 变异验证方式（每条都能"改回旧实现必红"，实跑记录见交付报告）：
//   - prepare 改回 appcfg.Parse(rawConfig)（忽略上一版）⇒ ①②③ 全红；
//   - mergeMissing 把"缺席才填"改成"无条件覆盖" ⇒ ②（显式 login 被上一版 public 洗掉）红；
//   - mergeMissing 把 legacy 重新计入缺席判定（老实现）⇒ ⑤ 红（白名单应用被静默放宽）；
//   - parseBaseline 把不可用基线当成"没有基线" ⇒ ⑥ 红（坏行被翻译成一次放宽）；
//   - ParseUpdate 在没有基线时补一个 access（例如 public）⇒ ④ 红；
//   - parseSubmitted 去掉 public 拒绝（改回 Parse）⇒ ②/④/⑤ 的 public 拒绝断言红。
package appcfg

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
)

// livePublic / liveWhitelist 是"上一版生效配置"的两种代表形态。
const (
	livePublic = `{"access":"public","whitelist":[],"purpose":"演示：共享小工具",` +
		`"data_sensitivity":"internal","owner":"张伟"}`
	liveWhitelist = `{"access":"whitelist","whitelist":["alice","bob"],"purpose":"值班排班",` +
		`"data_sensitivity":"内部","owner":"张三"}`
)

// declarationsOnly 是"AI 照工具描述省略未改动字段"的形态：只给三个声明。
const declarationsOnly = `{"purpose":"值班排班","data_sensitivity":"内部","owner":"张三"}`

func mustParseUpdate(t *testing.T, submitted, prev string) Config {
	t.Helper()
	c, e := ParseUpdate([]byte(submitted), prev)
	if e != nil {
		t.Fatalf("ParseUpdate(%s, prev=%s) = %v, want ok", submitted, prev, e)
	}
	return c
}

// ① 更新时省略 access ⇒ 沿用上一版生效值（whitelist 保持 whitelist + 名单；
// 历史 public 基线在**读取侧**即 login ⇒ 继承到 login，新版本不再写 public）。
func TestParseUpdateInheritsOmittedAccess(t *testing.T) {
	if got := mustParseUpdate(t, declarationsOnly, livePublic); got.Access != AccessLogin {
		t.Errorf("上一版 public、本次省略 access ⇒ 读取侧即 login（契约 §4.4），得到 %q", got.Access)
	}
	// 省略 access 的更新**不得**把 public 带进新版本：写入侧本来就拒 public，
	// 若基线照原值继承，一次纯代码更新就会 422。
	if _, e := ParseUpdate([]byte(declarationsOnly), livePublic); e != nil {
		t.Fatalf("public 基线的纯代码更新必须可发（继承为 login），得到 %v", e)
	}
	got := mustParseUpdate(t, declarationsOnly, liveWhitelist)
	if got.Access != AccessWhitelist {
		t.Fatalf("上一版 whitelist、本次省略 access ⇒ 应沿用 whitelist，得到 %q（旧实现落 login：白名单被静默放开）",
			got.Access)
	}
	if len(got.Whitelist) != 2 || got.Whitelist[0] != "alice" || got.Whitelist[1] != "bob" {
		t.Errorf("省略 whitelist ⇒ 应沿用上一版名单，得到 %v（旧实现清空名单）", got.Whitelist)
	}
}

// ①' 省略 access 但显式改了别的字段：只有缺席的字段被继承（逐字段各自判定）。
func TestParseUpdateInheritsPerField(t *testing.T) {
	submitted := `{"access":"whitelist","whitelist":["carol"]}` // 只改名单，其余缺席
	got := mustParseUpdate(t, submitted, liveWhitelist)
	if got.Access != AccessWhitelist || len(got.Whitelist) != 1 || got.Whitelist[0] != "carol" {
		t.Fatalf("显式给的值必须以提交为准: access=%q whitelist=%v", got.Access, got.Whitelist)
	}
	if got.Purpose != "值班排班" || got.DataSensitivity != "内部" || got.Owner != "张三" {
		t.Fatalf("缺席的声明字段应沿用上一版: %+v", got)
	}
}

// ② 更新时**显式**写 access ⇒ 真的按显式值改；显式空串不是"缺席"。
func TestParseUpdateExplicitAccessWins(t *testing.T) {
	submitted := `{"access":"login","purpose":"值班排班","data_sensitivity":"内部","owner":"张三"}`
	got := mustParseUpdate(t, submitted, livePublic)
	if got.Access != AccessLogin {
		t.Fatalf("显式 access=login ⇒ 必须真的改成 login，得到 %q（继承不得覆盖显式值）", got.Access)
	}
	// 反方向：显式 public **在写入侧被拒**（契约 §4.4：新版本不得再写 public）。
	// 用 login 覆盖上一版 whitelist 仍要真的生效（显式值优先于基线）。
	got = mustParseUpdate(t, `{"access":"login"}`, liveWhitelist)
	if got.Access != AccessLogin {
		t.Fatalf("显式 access=login ⇒ 必须真的改成 login，得到 %q", got.Access)
	}
	if _, e := ParseUpdate([]byte(`{"access":"public"}`), liveWhitelist); e == nil {
		t.Fatal("显式 access=public 必须被拒（写入侧收敛）")
	} else if e.Details["reason"] != "public_not_allowed" {
		t.Fatalf("public 被拒的结构化形态不对: %+v", e)
	}
	// 显式空串 = 给了值，因此**不**被上一版覆盖 ⇒ 取值非法（422），而不是悄悄沿用。
	if _, e := ParseUpdate([]byte(`{"access":""}`), livePublic); e == nil {
		t.Fatal("显式 access=\"\" 应被拒（显式给值不是缺席；悄悄沿用上一版会让作者以为改成功了）")
	} else if e.Code != apperr.CodeAppConfigBad || e.Details["field"] != FieldAccess {
		t.Fatalf("显式空 access 的错误形态不对: %+v", e)
	}
}

// ③ 省略 purpose/data_sensitivity/owner ⇒ 沿用；显式空串才清空。
func TestParseUpdateInheritsDeclarationsAndExplicitEmptyClears(t *testing.T) {
	got := mustParseUpdate(t, `{"access":"login"}`, livePublic)
	if got.Purpose != "演示：共享小工具" || got.DataSensitivity != "internal" || got.Owner != "张伟" {
		t.Fatalf("缺席的三个声明字段应沿用上一版（旧实现清空它们）: %+v", got)
	}
	cleared := mustParseUpdate(t,
		`{"access":"login","purpose":"","data_sensitivity":"","owner":""}`, livePublic)
	if cleared.Purpose != "" || cleared.DataSensitivity != "" || cleared.Owner != "" {
		t.Fatalf("显式空串是“给值”，必须真的清空（不许被上一版填回来）: %+v", cleared)
	}
}

// ④ 首版（没有基线）省略 access ⇒ 仍是 login；缺省语义不回归。
//
// "没有基线"= 空串/空白，或没有任何 approved 版本（api 层据此传空串）。
// 注意坏基线**不在**这一组：它走 ⑥（拒绝发布），不是"当成首版"。
func TestParseUpdateWithoutBaselineKeepsLoginDefault(t *testing.T) {
	for _, prev := range []string{"", "   ", "\n\t"} {
		got := mustParseUpdate(t, declarationsOnly, prev)
		if got.Access != AccessLogin {
			t.Fatalf("基线 %q 不存在时省略 access ⇒ 必须仍是缺省 login，得到 %q", prev, got.Access)
		}
	}
	// 显式给值仍然是显式（基线缺失不改变取值合法性）：login/whitelist 照常，
	// 但 public 在**任何**提交里都被拒（含首版）。
	if got := mustParseUpdate(t, `{"access":"login"}`, ""); got.Access != AccessLogin {
		t.Fatalf("首版显式 login ⇒ login，得到 %q", got.Access)
	}
	if _, e := ParseUpdate([]byte(`{"access":"public"}`), ""); e == nil {
		t.Fatal("首版显式 public 同样必须被拒（写入侧收敛与版本无关）")
	}
}

// ⑥ 基线不可用（**存在字节但解析不了**）⇒ 拒绝发布，而不是回落 login。
//
// 为什么方向必须是这样（2026-09-19 审计 §1.4）：whitelist = 登录 + 名单，login =
// 登录后全员，所以"坏基线 ⇒ login"对白名单应用是**放宽**。而作者侧没有任何信号，
// 只有一条 access_change 审计；拒绝则当场告诉他"上一版没读出来、继承没发生"。
//
// 变异：把 parseBaseline 的 BaselineUnusable 归并成 BaselineAbsent（老实现）
// ⇒ 本用例红（坏基线被翻译成一次静默放宽）。
func TestParseUpdateUnusableBaselineIsRefused(t *testing.T) {
	unusable := []string{
		"{不是 JSON",             // 坏 JSON
		`{"access":`,           // 截断
		`{"access":"bogus"}`,   // 合法 JSON、非法取值（decode 就拒）
		`[1,2]`,                // 顶层不是对象
		`"login"`,              // 顶层不是对象（字符串）
		`{"unknown_key":true}`, // 未知字段（手工改库才能造出来）
	}
	for _, prev := range unusable {
		if state := BaselineStateOf(prev); state != BaselineUnusable {
			t.Fatalf("基线 %q 应判为 BaselineUnusable，得到 %v", prev, state)
		}
		c, e := ParseUpdate([]byte(declarationsOnly), prev)
		if e == nil {
			t.Fatalf("基线 %q 不可用时必须拒绝发布，却得到 access=%q（静默放宽）", prev, c.Access)
		}
		if e.Code != apperr.CodeAppConfigBad || e.Details["reason"] != "baseline_unusable" {
			t.Fatalf("基线 %q 的错误形态不对: code=%s details=%v", prev, e.Code, e.Details)
		}
		if len(e.Hints) == 0 {
			t.Fatalf("基线 %q 不可用必须给出可操作提示（作者否则只能盲猜）", prev)
		}
	}
	// 反向对照：真的"没有基线"仍是首版语义（不是拒绝）。
	for _, prev := range []string{"", "   "} {
		if state := BaselineStateOf(prev); state != BaselineAbsent {
			t.Fatalf("基线 %q 应判为 BaselineAbsent，得到 %v", prev, state)
		}
	}
	if state := BaselineStateOf(liveWhitelist); state != BaselineUsable {
		t.Fatalf("合法基线应判为 BaselineUsable，得到 %v", state)
	}
}

// ⑤ 旧 schema 的 `visible` / `login_required` **不参与"字段是否缺席"的判定**。
//
// 也就是说：提交里带了它们、同时省略 access ⇒ access 轴**照常从基线继承**；
// 它们既不是 access 的显式声明（新字段恒优先），也不会关掉继承。
//
// 为什么（审计 §1.3）：`visible` 的语义是"一律忽略"，`login_required` 是旧客户端
// 形态 —— 让一个无效果/历史遗留的键决定"这次要不要沿用线上访问级别"，实测能把
// 白名单应用静默放宽成 login 并丢掉名单。
//
// 变异：把 legacy 键重新计入缺席判定（老实现）⇒ 下面三条全红。
func TestParseUpdateLegacyFieldsDoNotDisableInheritance(t *testing.T) {
	// ① 只带 visible（语义=一律忽略）：仍沿用白名单 + 名单。
	got := mustParseUpdate(t, `{"visible":true,"purpose":"值班排班","data_sensitivity":"内部","owner":"张三"}`, liveWhitelist)
	if got.Access != AccessWhitelist || len(got.Whitelist) != 2 {
		t.Fatalf("带 visible 的更新必须照常继承 access 轴，得到 access=%q whitelist=%v", got.Access, got.Whitelist)
	}
	// ② 只带 login_required=true：access 仍以基线为准（旧写法不再有信号量）。
	got = mustParseUpdate(t, `{"login_required":true}`, liveWhitelist)
	if got.Access != AccessWhitelist {
		t.Fatalf("带 login_required 的更新必须照常继承 access 轴，得到 access=%q（旧实现落 login：白名单被放开）", got.Access)
	}
	// ③ 两个都带：同样继承（旧实现在这里会落 public —— 匿名可达）。
	got = mustParseUpdate(t, `{"visible":true,"login_required":false}`, liveWhitelist)
	if got.Access != AccessWhitelist {
		t.Fatalf("两个 legacy 字段都带时仍必须继承 whitelist，得到 %q（旧实现落 public = 匿名可达）", got.Access)
	}
	// 声明字段照旧沿用（继承不是"整份提交作废"）。
	if got.Owner != "张三" {
		t.Fatalf("带 legacy 字段的提交仍应沿用缺席的声明，得到 owner=%q", got.Owner)
	}
	// 新字段恒优先：显式 access 与 legacy 同时出现时以 access 为准；
	// 显式 public 仍然是"这次提交要求匿名" ⇒ 写入侧拒（不被 legacy 键洗掉）。
	got = mustParseUpdate(t, `{"access":"login","login_required":true,"visible":false}`, liveWhitelist)
	if got.Access != AccessLogin {
		t.Fatalf("显式 access 必须优先于 legacy 字段，得到 %q", got.Access)
	}
	if _, e := ParseUpdate([]byte(`{"access":"public","login_required":true,"visible":false}`), liveWhitelist); e == nil {
		t.Fatal("显式 access=public 必须被拒，哪怕同时带了 legacy 键")
	}
}

// ⑤' 首版（**没有**基线）时旧形态仍按 shim 映射：兼容承诺不回归 ——
// 唯一例外是 `login_required=false`（它映射出的就是被收敛掉的 public，
// 因此写入侧拒；读取侧仍照常识别，见 appcfg_test 的 public 用例）。
func TestParseUpdateLegacySubmissionWithoutBaselineStillMaps(t *testing.T) {
	if _, e := ParseUpdate([]byte(`{"login_required":false,"purpose":"看板","data_sensitivity":"internal","owner":"李四"}`), ""); e == nil {
		t.Fatal("首版 login_required=false（= 要求匿名）必须被拒（写入侧不再接受 public）")
	} else if e.Details["reason"] != "public_not_allowed" {
		t.Fatalf("拒绝理由应点名 public_not_allowed: %+v", e)
	}
	if got := mustParseUpdate(t, `{"login_required":true,"whitelist":["alice"],"purpose":"x","data_sensitivity":"y","owner":"z"}`, ""); got.Access != AccessWhitelist {
		t.Fatalf("首版 login_required=true + 名单非空 ⇒ whitelist（兼容 shim），得到 %q", got.Access)
	}
}

// 上一版是**旧 schema** 的行（迁移 0071 之前的历史行）：先映射成新 schema 再继承。
// `login_required=false` 映射出的 public 在读取侧即 login（契约 §4.4）⇒ 继承到 login。
func TestParseUpdateLegacyBaselineMapsToNewSchema(t *testing.T) {
	prev := `{"login_required":false,"purpose":"看板","data_sensitivity":"internal","owner":"李四"}`
	got := mustParseUpdate(t, `{"purpose":"看板","data_sensitivity":"internal","owner":"李四"}`, prev)
	if got.Access != AccessLogin {
		t.Fatalf("上一版 login_required=false（= public）读取侧即 login ⇒ 继承后应为 login，得到 %q", got.Access)
	}
}

// 继承不得绕过任何一条既有校验：合并结果仍然走 Parse + Validate。
func TestParseUpdateDoesNotBypassValidation(t *testing.T) {
	// 显式把名单清空而 access 仍是（继承来的）whitelist ⇒ 拒（§10.5 第 56c 项）。
	if _, e := ParseUpdate([]byte(`{"whitelist":[]}`), liveWhitelist); e == nil {
		t.Fatal("access=whitelist + 空名单必须被拒")
	}
	// 未知字段照旧拒。
	if _, e := ParseUpdate([]byte(`{"visibleness":true}`), livePublic); e == nil {
		t.Fatal("未知字段必须被拒（继承不是放宽 schema 的借口）")
	}
	// 顶层不是对象照旧拒。
	if _, e := ParseUpdate([]byte(`[1,2]`), livePublic); e == nil {
		t.Fatal("顶层必须是 JSON 对象")
	}
}

// 继承来的值必须真的写进"平台权威副本"（应用 assets.read 读到的那份）。
func TestParseUpdateCanonicalOutputCarriesInheritedValues(t *testing.T) {
	got := mustParseUpdate(t, declarationsOnly, liveWhitelist)
	raw, err := json.Marshal(got)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	var back map[string]any
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("反序列化失败: %v", err)
	}
	if back["access"] != string(AccessWhitelist) {
		t.Fatalf("权威副本里的 access = %v，want whitelist", back["access"])
	}
	list, _ := back["whitelist"].([]any)
	if len(list) != 2 {
		t.Fatalf("权威副本里的 whitelist = %v，want 上一版的两条", back["whitelist"])
	}
	if !strings.Contains(string(raw), "值班排班") {
		t.Fatalf("权威副本里应带上沿用的 purpose: %s", raw)
	}
}
