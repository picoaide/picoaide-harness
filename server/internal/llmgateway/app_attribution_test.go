package llmgateway

// 应用维度归因（迁移 0076 / 契约 §21.4）的判据。
//
// 三件事：
//
//	① 网关侧的标签**收窄**于平台权威规则（app_id 形状）—— 放行的任何值都必须是
//	   registry 认的合法 app_id（否则归因标签会与平台身份空间对不上）；
//	② 标签**不参与计费**：绑定后金额、tokens、账本一律不变（变异：把 app_id 塞进
//	   计费 SQL 的入参并让它影响 cost ⇒ 本用例的金额断言红）；
//	③ 头缺失/非法 ⇒ 不写库（空标签 = 无归因），且**绝不影响**响应。

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/registry"
)

// TestSanitizeUsageAppIDIsNarrowerThanRegistry 是"收窄副本"的对拍（唯一真源在 registry）。
//
// 变异：把 usageAppIDRe 放宽（例如允许 `_` 或大写）⇒ 本用例红（会放行 registry 不认的值）。
func TestSanitizeUsageAppIDIsNarrowerThanRegistry(t *testing.T) {
	corpus := []string{
		"notes", "a-b", "a1", "1a", "abc-def-ghi",
		"", " ", "a", "-x", "x-", "a--b", "UPPER", "上标", "has space",
		"a" + strings.Repeat("b", 62), "a" + strings.Repeat("b", 63),
		"notes/../etc", "notes.example", "notes_1", "sec-ch-ua",
	}
	for _, in := range corpus {
		got := serverstore.SanitizeUsageAppID(in)
		if got == "" {
			continue
		}
		// 收窄关系：网关放行的值必须是 registry 认的合法 app_id 形状。
		if aerr := registry.CheckAppIDShape(got); aerr != nil {
			t.Errorf("SanitizeUsageAppID(%q) = %q，但 registry 不认它是合法 app_id: %v", in, got, aerr)
		}
		if got != strings.ToLower(strings.TrimSpace(in)) {
			t.Errorf("SanitizeUsageAppID(%q) = %q（只允许小写化 + 去空白）", in, got)
		}
	}
	// 反向抽样：明显非法的必须落空串。
	for _, bad := range []string{"", "a", "-x", "x-", "a--b", "has space", "<script>", "notes/../etc"} {
		if got := serverstore.SanitizeUsageAppID(bad); got != "" {
			t.Errorf("SanitizeUsageAppID(%q) = %q, want 空串", bad, got)
		}
	}
}

// TestBindUsageAppIDDoesNotTouchBilling 钉住"归因只是标签"。
func TestBindUsageAppIDDoesNotTouchBilling(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	// R14-K（D-04）：归因现在要求 app_id 指向真实存在、未软删的 wasm 应用
	// ⇒ 判据本身必须先播一个（否则测的是"应用不存在"那条路径）。
	seedAttributionApp(t, db, "notes")
	uid := createAttributionUser(t, db, "u-bill")
	id, err := serverstore.RecordUsageKind(db, uid, "demo-model", 100, 50, "chat")
	if err != nil {
		t.Fatalf("落 usage: %v", err)
	}
	before := readAttributionRow(t, db, id)

	api := &API{DB: db}
	c := ginContextWithHeader(appSessionIDHeaderName(), "app:notes#alice@4a54f91a306086cb9240010905674512")
	api.bindUsageAppID(c, id)

	after := readAttributionRow(t, db, id)
	if after.appID != "notes" {
		t.Fatalf("usage.app_id = %q, want notes（归因必须真的写进去）", after.appID)
	}
	if after.cost != before.cost || after.prompt != before.prompt || after.completion != before.completion {
		t.Fatalf("归因改变了计费数据：before=%+v after=%+v（app_id 绝不参与计费）", before, after)
	}
}

// TestBindUsageAppIDSkipsInvalidAndEmpty 钉住 best-effort：非法/缺失链路一律不写库。
func TestBindUsageAppIDSkipsInvalidAndEmpty(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	uid := createAttributionUser(t, db, "u-skip")
	id, err := serverstore.RecordUsageKind(db, uid, "demo-model", 1, 1, "chat")
	if err != nil {
		t.Fatalf("落 usage: %v", err)
	}
	api := &API{DB: db}
	for _, bad := range []string{
		"",                               // 没有头
		"session-12",                     // 普通会话：不是应用会话
		"app:",                           // 空 app_id
		"app:Demo",                       // 大写不合法
		"app:notes/../etc",               // 路径注入形态
		"app:" + strings.Repeat("a", 64), // 超长
	} {
		api.bindUsageAppID(ginContextWithHeader(appSessionIDHeaderName(), bad), id)
		if got := readAttributionRow(t, db, id).appID; got != "" {
			t.Fatalf("会话 id %q 不该归因却写进了库（app_id = %q）", bad, got)
		}
	}
}

// TestBindUsageAppIDIgnoresSelfDeclaredHeader 是 §21.4 后半的判据：
// **没有会话链路的自报头**（`X-Pico-App-Id`）一律忽略 —— 它没有可校验的来源。
//
// 变异：把 `appIDFromRequest` 改回"读自报头" ⇒ 本用例红（伪造头就能写标签）。
func TestBindUsageAppIDIgnoresSelfDeclaredHeader(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	seedAttributionApp(t, db, "notes") // R14-K（D-04）：正对照需要一个真实应用
	uid := createAttributionUser(t, db, "u-self")
	id, err := serverstore.RecordUsageKind(db, uid, "demo-model", 1, 1, "chat")
	if err != nil {
		t.Fatalf("落 usage: %v", err)
	}
	api := &API{DB: db}
	api.bindUsageAppID(ginContextWithHeader(legacyAppIDHeader, "notes"), id)
	if got := readAttributionRow(t, db, id).appID; got != "" {
		t.Fatalf("自报头（无会话链路）被当成归因来源：app_id = %q", got)
	}
	// 正对照：同一行，**带会话链路**时必须归因（证明上一条不是因为别的原因恒空）。
	api.bindUsageAppID(ginContextWithHeader(appSessionIDHeaderName(), "app:notes"), id)
	if got := readAttributionRow(t, db, id).appID; got != "notes" {
		t.Fatalf("带会话链路却没有归因：app_id = %q", got)
	}
}

// attributionRow 是本文件专用的 usage 投影（刻意不复用别的用例的同名结构：
// 字段集不同，共用会让"归因改了计费字段"这类断言被掩盖）。
type attributionRow struct {
	appID      string
	cost       float64
	prompt     int64
	completion int64
}

func readAttributionRow(t *testing.T, db *sql.DB, id int64) attributionRow {
	t.Helper()
	var row attributionRow
	if err := db.QueryRow(`SELECT app_id, cost, prompt_tokens, completion_tokens FROM usage WHERE id = ?`, id).
		Scan(&row.appID, &row.cost, &row.prompt, &row.completion); err != nil {
		t.Fatalf("读 usage 行: %v", err)
	}
	return row
}

// ginContextWithHeader 造一个只带某个请求头的 gin 上下文（bindUsageAppID 的唯一输入）。
func ginContextWithHeader(name, value string) *gin.Context {
	gin.SetMode(gin.TestMode)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	if name != "" && value != "" {
		req.Header.Set(name, value)
	}
	c.Request = req
	return c
}

func createAttributionUser(t *testing.T, db *sql.DB, name string) int64 {
	t.Helper()
	id, err := serverstore.CreateUser(db, &serverstore.User{
		Username: name, Source: "local", Status: 1, Role: serverstore.RoleUser})
	if err != nil {
		t.Fatalf("建用户 %s: %v", name, err)
	}
	return id
}
