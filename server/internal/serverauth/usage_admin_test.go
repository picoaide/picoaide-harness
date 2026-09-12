package serverauth

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// adminSession 登录 boss 并返回带 CSRF/Cookie 的请求头。
func adminSession(t *testing.T, r http.Handler) map[string]string {
	t.Helper()
	w, out := doJSON(t, r, "POST", "/api/server/admin/login", `{"username":"boss","password":"pw123456"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("login: %d %s", w.Code, w.Body.String())
	}
	sess := ""
	for _, ck := range w.Result().Cookies() {
		if ck.Name == sessionCookieName {
			sess = ck.Value
		}
	}
	return map[string]string{"Cookie": "picoaide_session=" + sess, "X-CSRF-Token": out["csrf_token"].(string)}
}

// TestAdminUsageDept: group=dept 聚合 + dept 过滤(2026-09 用量中心)。
func TestAdminUsageDept(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()
	hdr := adminSession(t, r)

	var everyoneID int64
	if err := db.QueryRow(`SELECT id FROM groups WHERE name = ?`, "全员").Scan(&everyoneID); err != nil {
		t.Fatal(err)
	}
	rdID, err := serverstore.CreateDepartment(db, "研发部", everyoneID, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	u1, err := serverstore.CreateUser(db, &serverstore.User{Username: "dev1", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	u2, err := serverstore.CreateUser(db, &serverstore.User{Username: "dev2", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SyncUserGroups(db, u1, []string{"研发部"}); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SyncUserGroups(db, u2, []string{"研发部"}); err != nil {
		t.Fatal(err)
	}
	_ = rdID
	for _, u := range []int64{u1, u2} {
		if _, err := serverstore.RecordUsage(db, u, "m1", 10, 5); err != nil {
			t.Fatal(err)
		}
	}
	// 今日 = 北京日(唯一真源):本机日期在 UTC 容器下会指向前一天。
	today := serverstore.BeijingNow().Format("2006-01-02")

	// group=dept:整体
	w1, out := doJSON(t, r, "GET", "/api/server/admin/usage?group=dept&from="+today+"&to="+today, "", hdr)
	if w1.Code != http.StatusOK {
		t.Fatalf("group=dept: %d %s", w1.Code, w1.Body.String())
	}
	rowsAny, ok := out["rows"].([]any)
	if !ok {
		t.Fatalf("group=dept rows: %v (body=%s)", out, w1.Body.String())
	}
	rows := rowsAny
	if len(rows) == 0 {
		t.Fatal("group=dept rows empty")
	}
	found := false
	for _, row := range rows {
		rr := row.(map[string]any)
		if rr["label"] == "研发部" {
			found = true
			if rr["prompt_tokens"].(float64) != 20 || rr["requests"].(float64) != 2 {
				t.Fatalf("研发部 row = %v", rr)
			}
		}
	}
	if !found {
		t.Fatalf("研发部 not in dept rows: %v", rows)
	}

	// dept 过滤 + model 分组
	w, out := doJSON(t, r, "GET", "/api/server/admin/usage?group=model&dept=研发部&from="+today+"&to="+today, "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("dept filter: %d %s", w.Code, w.Body.String())
	}
	if len(out["rows"].([]any)) != 1 {
		t.Fatalf("dept filter rows = %v", out["rows"])
	}

	// 未知 dept → 200 空
	if w, out := doJSON(t, r, "GET", "/api/server/admin/usage?group=model&dept=幽灵&from="+today+"&to="+today, "", hdr); w.Code != http.StatusOK || len(out["rows"].([]any)) != 0 {
		t.Fatalf("unknown dept: %d %v", w.Code, out["rows"])
	}

	// 非法 group
	if w, _ := doJSON(t, r, "GET", "/api/server/admin/usage?group=nope", "", hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("bad group: %d", w.Code)
	}
}

// TestAdminUsageProvider: group=provider 归并(2026-09 用量中心)。
func TestAdminUsageProvider(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()
	hdr := adminSession(t, r)

	p1, err := serverstore.AddGatewayProvider(db, &serverstore.GatewayProvider{Name: "DeepSeek", BaseURL: "https://api.deepseek.com", APIKeyEnc: "x", Models: []string{}, Enabled: 1})
	if err != nil {
		t.Fatal(err)
	}
	// 模型带价格:让 DeepSeek 行的费用 >0,(未配置渠道)行费用为 0,
	// 费用降序下 DeepSeek 稳定排第一(否则等值费用时行序随机漂移,
	// 2026-09-05 CI 首跑必挂实测)。
	one := 0.1
	two := 0.2
	if _, err := serverstore.AddModel(db, &serverstore.Model{Name: "deepseek-chat", ProviderID: p1, InputPricePer1M: &one, OutputPricePer1M: &two}); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.RecordUsage(db, 1, "deepseek-chat", 10, 5); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.RecordUsage(db, 1, "no-map-model", 3, 3); err != nil {
		t.Fatal(err)
	}
	// 今日 = 北京日(唯一真源):本机日期在 UTC 容器下会指向前一天。
	today := serverstore.BeijingNow().Format("2006-01-02")
	_, out := doJSON(t, r, "GET", "/api/server/admin/usage?group=provider&from="+today+"&to="+today, "", hdr)
	rows := out["rows"].([]any)
	if len(rows) != 2 {
		mp, _ := serverstore.ModelProviderMap(db)
		var cnt int
		_ = db.QueryRow(`SELECT COUNT(*) FROM models`).Scan(&cnt)
		t.Fatalf("provider rows = %v (map=%v models=%d)", rows, mp, cnt)
	}
	if rows[0].(map[string]any)["label"] != "DeepSeek" {
		t.Fatalf("provider rows[0] = %v", rows[0])
	}
}

// TestAdminUsageRequests: 请求明细分页 + 校验(2026-09 用量中心)。
func TestAdminUsageRequests(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()
	hdr := adminSession(t, r)

	for i := 0; i < 3; i++ {
		if _, err := serverstore.RecordUsageKind(db, 1, "m1", int64(10+i), 5, "chat"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := serverstore.RecordUsageKind(db, 1, "m1", 20, 0, "embedding"); err != nil {
		t.Fatal(err)
	}
	// 今日 = 北京日(唯一真源):本机日期在 UTC 容器下会指向前一天。
	today := serverstore.BeijingNow().Format("2006-01-02")

	w, out := doJSON(t, r, "GET", "/api/server/admin/usage/requests?from="+today+"&to="+today+"&size=2", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("requests: %d %s", w.Code, w.Body.String())
	}
	if out["total"].(float64) != 4 || len(out["rows"].([]any)) != 2 {
		t.Fatalf("requests total/rows = %v %v", out["total"], out["rows"])
	}
	// 过滤 kind
	_, out = doJSON(t, r, "GET", "/api/server/admin/usage/requests?from="+today+"&to="+today+"&kind=embedding", "", hdr)
	if out["total"].(float64) != 1 {
		t.Fatalf("kind filter: %v", out["total"])
	}
	// kind 非法 → 400
	if w, _ := doJSON(t, r, "GET", "/api/server/admin/usage/requests?kind=nope", "", hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("bad kind: %d", w.Code)
	}
	// 窗口 >90 天 → 400
	if w, _ := doJSON(t, r, "GET", "/api/server/admin/usage/requests?from=2025-01-01&to=2025-12-31", "", hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("wide window: %d", w.Code)
	}
}

// TestAdminUsageOverview: 总览聚合(2026-09 用量中心)。
func TestAdminUsageOverview(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()
	hdr := adminSession(t, r)

	if _, err := serverstore.RecordUsageKind(db, 1, "m1", 10, 5, "chat"); err != nil {
		t.Fatal(err)
	}
	// 今日 = 北京日(唯一真源):本机日期在 UTC 容器下会指向前一天。
	today := serverstore.BeijingNow().Format("2006-01-02")
	w, out := doJSON(t, r, "GET", "/api/server/admin/usage/overview?from="+today+"&to="+today, "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("overview: %d %s", w.Code, w.Body.String())
	}
	for _, k := range []string{"range", "month", "today", "trend", "top_models"} {
		if _, ok := out[k]; !ok {
			t.Fatalf("overview missing key %q: %v", k, out)
		}
	}
	rangeSum := out["range"].(map[string]any)
	if rangeSum["requests"].(float64) != 1 {
		t.Fatalf("range requests = %v", rangeSum)
	}
}

// 2026-09-11:quota_change / dept_budget_change 两个审计动作随配额与部门预算
// 下线一并移除(网关唯一闸门 = 余额,审计动作 = balance_adjust/balance_grant/
// balance_settings)。

// ---------------------------------------------------------------------------
// 分页参数钳制(审计 2026-09-12):OFFSET = (page-1)*size 必须在任何输入下
// 都是非负的 —— page 直接来自查询串,不设上界会在 int64 上回绕成负数,
// 交给 PG 就是 "OFFSET must not be negative" 500(本可安全返回空页)。
// ---------------------------------------------------------------------------

func TestPaginateClampsAndNeverOverflows(t *testing.T) {
	cases := []struct {
		query           string
		def, max        int
		page, size, off int
	}{
		// 正常值原样通过
		{"page=3&size=50", 20, 200, 3, 50, 100},
		// 缺省
		{"", 20, 200, 1, 20, 0},
		// page 越界（下界/上界）与非法
		{"page=0", 20, 200, 1, 20, 0},
		{"page=-5", 20, 200, 1, 20, 0},
		{"page=abc", 20, 200, 1, 20, 0},
		{"page=999999999", 20, 200, maxPage, 20, (maxPage - 1) * 20},
		// size 越界与非法 → 回落默认
		{"size=0", 20, 200, 1, 20, 0},
		{"size=99999", 20, 200, 1, 20, 0},
		{"size=xyz", 20, 200, 1, 20, 0},
		// 溢出场景:int64 上界与低于它的值都必须给出非负 offset
		{"page=9223372036854775807&size=200", 20, 200, maxPage, 200, (maxPage - 1) * 200},
		{"page=9223372036854775806&size=200", 20, 200, maxPage, 200, (maxPage - 1) * 200},
		{"page=4611686018427387904&size=1", 20, 200, maxPage, 1, maxPage - 1},
	}
	for _, tc := range cases {
		gin.SetMode(gin.TestMode)
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest(http.MethodGet, "/?"+tc.query, nil)
		page, size, off := paginate(c, tc.def, tc.max)
		if page != tc.page || size != tc.size || off != tc.off {
			t.Errorf("paginate(%q, def=%d, max=%d) = (%d,%d,%d), want (%d,%d,%d)",
				tc.query, tc.def, tc.max, page, size, off, tc.page, tc.size, tc.off)
		}
		if off < 0 {
			t.Errorf("paginate(%q) produced negative offset %d", tc.query, off)
		}
	}
}
