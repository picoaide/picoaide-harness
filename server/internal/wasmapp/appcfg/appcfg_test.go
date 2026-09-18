// 变异验证方式（CONTEXT §4.3 要求；每条用例都写成"闸门去掉即变红"）：
//   - 把 Parse 里的 access 缺省从 login 改成 public（或删掉缺省分支）
//     → TestAccessDefaultsToLogin 红；
//   - 把 Validate 里 `access=whitelist` + 空名单的检查删掉 → TestWhitelistAccessRequiresList 红；
//   - 把"login + 空名单也拒"的旧规则加回来 → TestLoginAllowsEmptyWhitelist 红；
//   - 把旧 schema 映射分支删掉（或让 login_required 走 unknown_field）
//     → TestLegacySchemaCompatMapping 红；
//   - 把未知字段检查删掉 → TestBadConfigRejected 红；
//   - 把 normalizeWhitelist 的 trim/dedup 删掉 → TestWhitelistNormalized 红；
//   - 把 requireDeclarations 分支删掉 → TestFirstReleaseRequiresDeclarations 红；
//   - 把 64 KiB 体积检查删掉 → TestOversizeRejected 红。
package appcfg

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// full 是一份"首次发布"用的合法配置（新 schema）。
func full() string {
	return `{
	  "access": "whitelist",
	  "whitelist": ["zhangwei", "lisi"],
	  "purpose": "报销单自动整理",
	  "data_sensitivity": "internal",
	  "owner": "zhangwei"
	}`
}

func mustParse(t *testing.T, s string) Config {
	t.Helper()
	c, e := Parse([]byte(s))
	if e != nil {
		t.Fatalf("Parse(%s) = %v, want ok", s, e)
	}
	return c
}

func TestParseFullConfig(t *testing.T) {
	c := mustParse(t, full())
	if c.Access != AccessWhitelist {
		t.Fatalf("access = %q, want %q", c.Access, AccessWhitelist)
	}
	if len(c.Whitelist) != 2 || c.Whitelist[0] != "zhangwei" {
		t.Fatalf("whitelist = %v", c.Whitelist)
	}
	if c.Purpose == "" || c.DataSensitivity == "" || c.Owner == "" {
		t.Fatalf("declarations lost: %+v", c)
	}
	if c.AuthMode() != abi.AuthModeWhitelist {
		t.Fatalf("AuthMode = %q", c.AuthMode())
	}
	if !c.RequiresLogin() || c.Public() {
		t.Fatalf("whitelist 模式必须要求登录: Public=%v", c.Public())
	}
	if e := c.Validate(true); e != nil {
		t.Fatalf("Validate(true) = %v", e)
	}
}

// R25（2026-09-18 收敛）：access 缺失即 login —— 写漏了只会"要求登录"，
// 不会意外变成匿名可达。
//
// 变异方式：把 Parse 里 `c.Access = AccessLogin` 的缺省分支改成 public ⇒ 红。
func TestAccessDefaultsToLogin(t *testing.T) {
	for _, in := range []string{
		`{}`,
		`{"purpose":"p","data_sensitivity":"d","owner":"o"}`,
		`{"whitelist":[]}`,
	} {
		c := mustParse(t, in)
		if c.Access != AccessLogin {
			t.Fatalf("Parse(%s).access = %q, want %q", in, c.Access, AccessLogin)
		}
		if c.AuthMode() != abi.AuthModeLogin {
			t.Fatalf("AuthMode = %q, want %q", c.AuthMode(), abi.AuthModeLogin)
		}
		if !c.RequiresLogin() {
			t.Fatal("缺省 access 必须要求登录（未登录 ⇒ 换票）")
		}
	}
	if AccessDefault != AccessLogin {
		t.Fatalf("AccessDefault = %q, want %q（缺省与 Parse 行为必须同源）", AccessDefault, AccessLogin)
	}
}

// 旧 schema 兼容 shim：**已发布版本**里的 config_json 与随包 picoaide.app.json 还是
// 旧形态，Parse 必须接受并映射，且不报 unknown field。重新发布后写出的是新 schema。
//
// 变异方式：删掉 Parse 的旧形态映射分支（或把 legacy 字段当未知字段拒）⇒ 红。
func TestLegacySchemaCompatMapping(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want Access
	}{
		{"旧 public", `{"visible":false,"login_required":false,"whitelist":[]}`, AccessPublic},
		{"旧 白名单非空", `{"visible":true,"login_required":true,"whitelist":["a"]}`, AccessWhitelist},
		{"旧 登录+空名单（旧规则本会拒）", `{"visible":true,"login_required":true,"whitelist":[]}`, AccessLogin},
		{"旧 登录且无 whitelist 键", `{"login_required":true}`, AccessLogin},
		{"旧 完全无字段", `{}`, AccessLogin},
		{"旧 visible 单独出现（忽略）", `{"visible":true}`, AccessLogin},
		{"旧 visible=false 不影响 access", `{"visible":false,"login_required":false}`, AccessPublic},
		{"新字段优先于旧字段", `{"access":"public","login_required":true,"whitelist":["a"]}`, AccessPublic},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, e := Parse([]byte(tc.in))
			if e != nil {
				t.Fatalf("旧 schema 必须被接受（兼容 shim），却是 %v", e)
			}
			if c.Access != tc.want {
				t.Fatalf("access = %q, want %q", c.Access, tc.want)
			}
			// 重新发布写出的必须是新 schema：canonical JSON 里不得再有旧键。
			raw, merr := json.Marshal(c)
			if merr != nil {
				t.Fatal(merr)
			}
			var got map[string]json.RawMessage
			if err := json.Unmarshal(raw, &got); err != nil {
				t.Fatal(err)
			}
			for _, legacy := range []string{legacyFieldLoginRequired, legacyFieldVisible} {
				if _, ok := got[legacy]; ok {
					t.Fatalf("canonical JSON 里仍出现旧字段 %q（重新发布必须写出新 schema）: %s", legacy, raw)
				}
			}
			if _, ok := got[FieldAccess]; !ok {
				t.Fatalf("canonical JSON 缺少 access: %s", raw)
			}
		})
	}
}

// §10.5 第 56c 项（2026-09-18 变更）：
//   - access=whitelist 且名单为空 ⇒ 拒（这种应用对所有人不可用）；
//   - access=login 或 public 时名单为空 **合法**（"登录后全员"是正式模式，
//     旧规则"login_required=true + 空名单 ⇒ 拒"已废止）。
//
// 变异方式：把 whitelist 模式的检查删掉 ⇒ 前半红；把旧规则加回来 ⇒ 后半红。
func TestWhitelistAccessRequiresList(t *testing.T) {
	for _, in := range []string{
		`{"access":"whitelist"}`,
		`{"access":"whitelist","whitelist":[]}`,
	} {
		_, e := Parse([]byte(in))
		if e == nil {
			t.Fatalf("Parse(%s) 应当拒绝：access=whitelist 且白名单为空", in)
		}
		if e.Code != apperr.CodeAppConfigBad {
			t.Fatalf("code = %s, want %s", e.Code, apperr.CodeAppConfigBad)
		}
		if got := e.Details["field"]; got != FieldWhitelist {
			t.Fatalf("details.field = %v, want %s", got, FieldWhitelist)
		}
		if e.Status() != 422 {
			t.Fatalf("status = %d, want 422", e.Status())
		}
		// 提示必须给"改 access=login"这条出路（用户拍板的语义：
		// 想要"登录后全员可用"就不该用 whitelist）。
		hints := strings.Join(e.Hints, " | ")
		if !strings.Contains(hints, string(AccessLogin)) || !strings.Contains(hints, FieldWhitelist) {
			t.Fatalf("hints 必须同时给出 access=login 与名单两条出路: %v", e.Hints)
		}
	}
}

func TestLoginAllowsEmptyWhitelist(t *testing.T) {
	for _, in := range []string{
		`{"access":"login"}`,
		`{"access":"login","whitelist":[]}`,
		`{"login_required":true}`, // 旧形态映射到 login
		`{"login_required":true,"whitelist":[]}`,
	} {
		c, e := Parse([]byte(in))
		if e != nil {
			t.Fatalf("Parse(%s) 必须通过（登录后全员是合法模式），却是 %v", in, e)
		}
		if c.Access != AccessLogin {
			t.Fatalf("access = %q, want %q", c.Access, AccessLogin)
		}
	}
	// public + 空名单同样是合法形态（匿名应用）。
	if c := mustParse(t, `{"access":"public"}`); !c.Public() || c.AuthMode() != abi.AuthModePublic {
		t.Fatalf("public 形态不对: %+v", c)
	}
}

// §10.5 第 56b 项：未知顶层字段 / JSON 非法 / 字段越界 → APP_CONFIG_INVALID(422)，
// 且 hints 指名具体字段。
func TestBadConfigRejected(t *testing.T) {
	cases := []struct {
		name  string
		in    string
		field string
	}{
		{"未知顶层字段", `{"access":"public","whitelst":["a"]}`, "whitelst"},
		{"JSON 非法", `{"access":`, ""},
		{"顶层为 null", `null`, ""},
		{"空文件", ``, ""},
		{"顶层不是对象", `["access"]`, ""},
		{"access 取值非法", `{"access":"everyone"}`, FieldAccess},
		{"access 大小写不符", `{"access":"Public"}`, FieldAccess},
		{"access 不是字符串", `{"access":true}`, FieldAccess},
		{"类型不符 bool", `{"login_required":"yes","whitelist":["a"]}`, legacyFieldLoginRequired},
		{"旧 visible 不是 bool", `{"visible":"no"}`, legacyFieldVisible},
		{"类型不符数组", `{"access":"whitelist","whitelist":"zhangwei"}`, FieldWhitelist},
		{"类型不符 string", `{"access":"whitelist","whitelist":["a"],"owner":42}`, FieldOwner},
		{"对象后有多余内容", `{"access":"public"} {"access":"public"}`, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, e := Parse([]byte(tc.in))
			if e == nil {
				t.Fatalf("Parse(%s) = ok, want reject", tc.in)
			}
			if e.Code != apperr.CodeAppConfigBad {
				t.Fatalf("code = %s, want %s", e.Code, apperr.CodeAppConfigBad)
			}
			if e.Status() != 422 {
				t.Fatalf("status = %d, want 422", e.Status())
			}
			if len(e.Hints) == 0 {
				t.Fatal("必须带 hints")
			}
			if tc.field != "" {
				if got := e.Details["field"]; got != tc.field {
					t.Fatalf("details.field = %v, want %q (message=%s hints=%v)", got, tc.field, e.Message, e.Hints)
				}
				joined := strings.Join(e.Hints, " | ")
				if !strings.Contains(joined, tc.field) && !strings.Contains(e.Message, tc.field) {
					t.Fatalf("报错没有点名具体字段 %q: message=%q hints=%v", tc.field, e.Message, e.Hints)
				}
			}
		})
	}
	// access 取值报错必须把三个合法值都列出来（作者照抄即可改对）。
	_, e := Parse([]byte(`{"access":"nobody"}`))
	for _, v := range AccessValues {
		if !strings.Contains(strings.Join(e.Hints, " ")+e.Message, v) {
			t.Fatalf("access 报错没有列出合法值 %q: message=%s hints=%v", v, e.Message, e.Hints)
		}
	}
}

func TestOversizeRejected(t *testing.T) {
	// 用一条超长 purpose 撑过 64 KiB（合法 JSON，只是太大）。
	big := `{"access":"public","purpose":"` + strings.Repeat("x", limits.AppConfigMaxBytes) + `"}`
	_, e := Parse([]byte(big))
	if e == nil {
		t.Fatal("超过 64 KiB 必须拒（§4.2）")
	}
	if e.Code != apperr.CodeAppConfigBad {
		t.Fatalf("code = %s, want %s", e.Code, apperr.CodeAppConfigBad)
	}
	if e.Details["max"] != limits.AppConfigMaxBytes {
		t.Fatalf("details.max = %v, want %d", e.Details["max"], limits.AppConfigMaxBytes)
	}
	// 边界：正好等于上限的合法文件应当通过（不误伤）。
	pad := strings.Repeat("x", limits.AppConfigMaxBytes-len(`{"access":"public","purpose":""}`))
	if _, e := Parse([]byte(`{"access":"public","purpose":"` + pad + `"}`)); e != nil {
		t.Fatalf("恰好 64 KiB 应当通过，却是 %v", e)
	}
}

func TestWhitelistLimitRejected(t *testing.T) {
	over := make([]string, 0, limits.AppConfigWhitelistMax+1)
	for i := 0; i <= limits.AppConfigWhitelistMax; i++ {
		over = append(over, `"user-`+strconv.Itoa(i)+`"`)
	}
	body := []byte(`{"access":"whitelist","whitelist":[` + strings.Join(over, ",") + `]}`)
	_, e := Parse(body)
	if e == nil {
		t.Fatalf("白名单超过 %d 条必须拒（§4.2）", limits.AppConfigWhitelistMax)
	}
	if e.Code != apperr.CodeAppConfigBad {
		t.Fatalf("code = %s, want %s", e.Code, apperr.CodeAppConfigBad)
	}
	if e.Details["max"] != limits.AppConfigWhitelistMax {
		t.Fatalf("details.max = %v, want %d", e.Details["max"], limits.AppConfigWhitelistMax)
	}
}

func TestWhitelistNormalized(t *testing.T) {
	c := mustParse(t, `{"access":"whitelist","whitelist":["  zhangwei  ","lisi","zhangwei","lisi","wangwu"]}`)
	want := []string{"zhangwei", "lisi", "wangwu"}
	if len(c.Whitelist) != len(want) {
		t.Fatalf("whitelist = %v, want %v（去空白 + 去重）", c.Whitelist, want)
	}
	for i := range want {
		if c.Whitelist[i] != want[i] {
			t.Fatalf("whitelist = %v, want %v（保留首次出现顺序）", c.Whitelist, want)
		}
	}
	// 空串一律拒（不是静默丢弃）。
	if _, e := Parse([]byte(`{"access":"whitelist","whitelist":["zhangwei",""]}`)); e == nil {
		t.Fatal("白名单含空条目必须拒")
	} else if e.Details["reason"] != "empty_entry" {
		t.Fatalf("reason = %v, want empty_entry", e.Details["reason"])
	}
	// 全是空白字符的条目同样算空。
	if _, e := Parse([]byte(`{"access":"whitelist","whitelist":["   "]}`)); e == nil {
		t.Fatal("空白条目必须拒")
	}
}

// §10.5 第 56d 项：平台**不校验**名单里的账号是否存在（否则等于账号枚举接口）。
func TestWhitelistDoesNotValidateAccounts(t *testing.T) {
	in := `{"access":"whitelist","whitelist":["definitely-not-a-real-account-9f3a"],
	        "purpose":"p","data_sensitivity":"d","owner":"o"}`
	if _, e := Parse([]byte(in)); e != nil {
		t.Fatalf("平台不得校验账号存在性（R26），却是 %v", e)
	}
}

// 首次发布必填 purpose/data_sensitivity/owner；非首版可沿用。
func TestFirstReleaseRequiresDeclarations(t *testing.T) {
	for _, field := range []string{FieldPurpose, FieldDataSensitivity, FieldOwner} {
		body := map[string]any{FieldAccess: "public"}
		for _, f := range []string{FieldPurpose, FieldDataSensitivity, FieldOwner} {
			if f != field {
				body[f] = "x"
			}
		}
		raw, _ := json.Marshal(body)
		// Parse 不做首版判定（内部只做 Validate(false)）⇒ 通过。
		c, e := Parse(raw)
		if e != nil {
			t.Fatalf("Parse(%s) = %v, want ok（首版判定属于调用方）", raw, e)
		}
		e = c.Validate(true)
		if e == nil {
			t.Fatalf("缺少 %s 时 Validate(true) 应当拒", field)
		}
		if e.Code != apperr.CodeMissingField {
			t.Fatalf("code = %s, want %s", e.Code, apperr.CodeMissingField)
		}
		if e.Details["field"] != field {
			t.Fatalf("details.field = %v, want %s", e.Details["field"], field)
		}
		if e.Status() != 422 {
			t.Fatalf("status = %d, want 422", e.Status())
		}
		// 非首版：同样的配置文件可以沿用。
		if e := c.Validate(false); e != nil {
			t.Fatalf("非首版不应要求声明字段，却是 %v", e)
		}
	}
	// 只有空白字符不算填写。
	c := mustParse(t, `{"access":"public","purpose":"   ","data_sensitivity":"d","owner":"o"}`)
	if e := c.Validate(true); e == nil || e.Details["field"] != FieldPurpose {
		t.Fatalf("空白 purpose 必须按未填写处理，却是 %v", e)
	}
}

// Parse 内部已做 Validate(false)：忘记调 Validate 也不会放进"对所有人不可用"的应用。
func TestParseEnforcesSemanticRules(t *testing.T) {
	if _, e := Parse([]byte(`{"access":"whitelist"}`)); e == nil {
		t.Fatal("Parse 必须自己拦下 access=whitelist 且名单为空的配置")
	}
	// 反例：login 应用不触发该规则（证明拦的是规则本身，不是"缺字段"）。
	if _, e := Parse([]byte(`{"access":"login"}`)); e != nil {
		t.Fatalf("login 且无名单应当通过 Parse，却是 %v", e)
	}
}

// Validate 对零值 Config 必须 fail-closed：空 access 不是"公开"，而是配置未解析。
func TestValidateRejectsZeroValueConfig(t *testing.T) {
	var zero Config
	if e := zero.Validate(false); e == nil {
		t.Fatal("零值 Config 的 Validate 必须拒（access 未设置）")
	} else if e.Details["field"] != FieldAccess {
		t.Fatalf("details.field = %v, want %s", e.Details["field"], FieldAccess)
	}
	// 而 AuthMode 对零值回落 login（绝不意外公开）。
	if got := zero.AuthMode(); got != abi.AuthModeLogin {
		t.Fatalf("零值 AuthMode = %q, want %q（fail-closed）", got, abi.AuthModeLogin)
	}
	if !zero.RequiresLogin() {
		t.Fatal("零值 Config 必须要求登录")
	}
}

// 字段名是**外部契约**：作者手写的 JSON 与平台解析必须逐字一致。
func TestFieldNamesAreContract(t *testing.T) {
	c := mustParse(t, full())
	raw, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]json.RawMessage
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != len(KnownFields) {
		t.Fatalf("序列化字段数 = %d, want %d (%v)", len(got), len(KnownFields), got)
	}
	for _, f := range KnownFields {
		if _, ok := got[f]; !ok {
			t.Fatalf("缺少字段 %q（字段名是外部契约，不得改名）", f)
		}
	}
}

// owner 是负责人声明，不是平台归属（平台归属在 apps.owner，取自登录态）。
func TestOwnerIsDeclarationNotPlatformOwnership(t *testing.T) {
	c := mustParse(t, full())
	if c.Owner != "zhangwei" {
		t.Fatalf("owner = %q", c.Owner)
	}
	// 与登录态无关：任何人写的任何名字都能通过——平台不拿它做权限判断。
	if _, e := Parse([]byte(`{"access":"public","purpose":"p","data_sensitivity":"d","owner":"someone-else"}`)); e != nil {
		t.Fatalf("owner 只是声明字段，不该被平台校验归属：%v", e)
	}
}

func TestWhitelistEntryCountEqualsLimitPasses(t *testing.T) {
	uniq := make([]string, 0, limits.AppConfigWhitelistMax)
	for i := 0; i < limits.AppConfigWhitelistMax; i++ {
		uniq = append(uniq, `"user-`+strconv.Itoa(i)+`"`)
	}
	body := []byte(`{"access":"whitelist","whitelist":[` + strings.Join(uniq, ",") + `]}`)
	if _, e := Parse(body); e != nil {
		t.Fatalf("恰好 %d 条应当通过，却是 %v", limits.AppConfigWhitelistMax, e)
	}
}

// AuthMode 的三个取值是**跨语言契约**：必须与 abi 包的常量逐字一致。
func TestAuthModeValuesMatchABI(t *testing.T) {
	cases := []struct {
		access Access
		want   abi.AuthMode
	}{
		{AccessPublic, abi.AuthModePublic},
		{AccessLogin, abi.AuthModeLogin},
		{AccessWhitelist, abi.AuthModeWhitelist},
	}
	for _, tc := range cases {
		c := Config{Access: tc.access}
		if got := c.AuthMode(); got != tc.want {
			t.Fatalf("AuthMode(%q) = %q, want %q", tc.access, got, tc.want)
		}
		if string(tc.want) != string(tc.access) {
			t.Fatalf("abi.%q 与 appcfg.%q 必须逐字一致（帧内取值来自配置文件）", tc.want, tc.access)
		}
	}
}

// AccessOfConfigJSON 是目录/运维面的**显示投影**：旧 schema 与坏数据都要能落到
// 一个确定的答案（回落 login），绝不因为解析失败就把应用标成 public。
func TestAccessOfConfigJSON(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want Access
	}{
		{"空串", "", AccessLogin},
		{"空白", "   ", AccessLogin},
		{"坏 JSON", "{not json", AccessLogin},
		{"新 schema", `{"access":"public"}`, AccessPublic},
		{"新 schema 白名单（即使名单为空也如实显示）", `{"access":"whitelist"}`, AccessWhitelist},
		{"旧 schema public", `{"visible":false,"login_required":false}`, AccessPublic},
		{"旧 schema 名单", `{"login_required":true,"whitelist":["a"]}`, AccessWhitelist},
		{"旧 schema 登录", `{"login_required":true}`, AccessLogin},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := AccessOfConfigJSON(tc.in); got != tc.want {
				t.Fatalf("AccessOfConfigJSON(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}
