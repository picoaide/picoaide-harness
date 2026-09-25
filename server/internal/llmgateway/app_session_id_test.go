package llmgateway

// 应用会话 id 契约（`app-session-id.json`）的判据。
//
// 三件事：
//
//	① **形状与平台权威规则同源**：契约里的 app_id 正则/长度必须逐字等于
//	   `wasmapp/limits` 的 `AppIDPattern`/`MaxAppIDLen`（registry 也是从它们编译的）
//	   —— 否则归因标签会与平台身份空间对不上（放行 registry 不认的值，或拒掉合法应用）；
//	② **语料双向对拍**：同一份 `app-session-id.json` 同时被客户端（构造方向）与本用例
//	   （解析方向）消费。这里逐条跑 `build_cases` 与 `parse_cases`：
//	   `AppIDFromSessionID(session_id) == app_id`；`app_id` 为空串的行必须**不归因**。
//	   客户端那侧由 `packages/host/wasm-apps-host/src/app-session-id-contract.spec.ts`
//	   跑同一个文件的另一半（用户 + 服务端 + 应用 ⇒ session_id）。任何一端改了形状，
//	   另一端必红。
//	③ **非会话链路不归因**：普通会话 id / 自报头（`X-Pico-App-Id`）/ 畸形前缀一律空串。

import (
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// TestAppSessionIDContractMatchesPlatformRules 钉住"契约 == 平台权威规则"。
//
// 变异：把 JSON 的 `app_id_pattern` 改成 `^[A-Za-z0-9-]+$`（放宽字母大小写）⇒ 本用例红；
// 把 `app_id_max_length` 从 63 改成 64 ⇒ 本用例红。
func TestAppSessionIDContractMatchesPlatformRules(t *testing.T) {
	if appSessionID.AppIDPattern != limits.AppIDPattern {
		t.Fatalf("契约 app_id_pattern = %q，平台权威真源 limits.AppIDPattern = %q（必须逐字相同）",
			appSessionID.AppIDPattern, limits.AppIDPattern)
	}
	if appSessionID.AppIDMaxLength != limits.MaxAppIDLen {
		t.Fatalf("契约 app_id_max_length = %d，平台权威真源 limits.MaxAppIDLen = %d",
			appSessionID.AppIDMaxLength, limits.MaxAppIDLen)
	}
	// 编译出来的正则必须真的能拒掉非法形状（防止"字符串对但编译成了别的东西"）。
	for _, bad := range []string{"Demo", "a--b", "-x", "x-", "notes.example", "notes_1", ""} {
		if appSessionID.appIDRe.MatchString(bad) {
			t.Fatalf("契约正则放行了非法 app_id %q", bad)
		}
	}
	for _, good := range []string{"a", "1", "a1", "notes", "a-b", "abc-def-ghi"} {
		if !appSessionID.appIDRe.MatchString(good) {
			t.Fatalf("契约正则拒了合法 app_id %q", good)
		}
	}
}

// TestAppSessionIDContractCases 跑契约里的全部语料（两端共用同一份文件）。
func TestAppSessionIDContractCases(t *testing.T) {
	if len(appSessionID.BuildCases) == 0 || len(appSessionID.ParseCases) == 0 {
		t.Fatal("契约语料为空：对拍会变成空转（这是失败，不是跳过）")
	}
	// 历史形态必须留一条语料：它是"旧会话/旧客户端仍归因"这条兼容承诺的判据。
	legacyCovered := false
	for _, c := range appSessionID.ParseCases {
		if strings.HasPrefix(c.SessionID, appSessionID.Prefix) &&
			!strings.Contains(c.SessionID[len(appSessionID.Prefix):], appSessionID.ScopeSeparator) &&
			c.AppID != "" {
			legacyCovered = true
		}
	}
	if !legacyCovered {
		t.Fatalf("契约语料里没有历史形态 %s 的用例（兼容承诺失去判据）", appSessionID.LegacyForm)
	}

	for _, c := range appSessionID.BuildCases {
		if c.SessionID == "" || c.AppID == "" {
			t.Fatalf("build_cases 行缺字段: %+v", c)
		}
		if !strings.HasPrefix(c.SessionID, appSessionID.Prefix) {
			t.Fatalf("build_cases 行 %q 不以 %q 开头", c.SessionID, appSessionID.Prefix)
		}
		if !strings.Contains(c.SessionID, appSessionID.ScopeSeparator) {
			t.Fatalf("build_cases 行 %q 没有账号作用域（这正是本契约要防的形态）", c.SessionID)
		}
		if got := AppIDFromSessionID(c.SessionID); got != c.AppID {
			t.Errorf("AppIDFromSessionID(%q) = %q, want %q", c.SessionID, got, c.AppID)
		}
	}
	for _, c := range appSessionID.ParseCases {
		if got := AppIDFromSessionID(c.SessionID); got != c.AppID {
			t.Errorf("AppIDFromSessionID(%q) = %q, want %q（%s）", c.SessionID, got, c.AppID, c.Note)
		}
	}
}

// TestAppIDFromSessionIDBoundaries 是语料之外的两个边界（长度与多分隔符）的显式判据。
func TestAppIDFromSessionIDBoundaries(t *testing.T) {
	max := strings.Repeat("a", limits.MaxAppIDLen)
	if got := AppIDFromSessionID(appSessionID.Prefix + max); got != max {
		t.Fatalf("上限长度的 app_id 被拒：got %q", got)
	}
	if got := AppIDFromSessionID(appSessionID.Prefix + max + "a"); got != "" {
		t.Fatalf("超上限的 app_id 被放行：got %q", got)
	}
	// 账号作用域里再出现分隔符：只按**第一个**分隔符切分。
	id := appSessionID.Prefix + "notes" + appSessionID.ScopeSeparator + "alice" +
		appSessionID.ScopeSeparator + "extra"
	if got := AppIDFromSessionID(id); got != "notes" {
		t.Fatalf("多分隔符切分错误：AppIDFromSessionID(%q) = %q, want notes", id, got)
	}
}
