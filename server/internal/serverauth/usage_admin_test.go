package serverauth

import (
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

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
	today := time.Now().Format("2006-01-02")

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
	if _, err := serverstore.AddModel(db, &serverstore.Model{Name: "deepseek-chat", ProviderID: p1}); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.RecordUsage(db, 1, "deepseek-chat", 10, 5); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.RecordUsage(db, 1, "no-map-model", 3, 3); err != nil {
		t.Fatal(err)
	}
	today := time.Now().Format("2006-01-02")
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
	today := time.Now().Format("2006-01-02")

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
	today := time.Now().Format("2006-01-02")
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

// TestAdminQuotaChangeAudit:配额变更(用户)写 quota_change(2026-09 P1)。
func TestAdminQuotaChangeAudit(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()
	hdr := adminSession(t, r)

	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: "qc", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	// 设金额配额 60
	if w, _ := doJSON(t, r, "PUT", "/api/server/admin/users/"+strconv.FormatInt(uid, 10), `{"quota_money":60}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("set quota: %d", w.Code)
	}
	var detail string
	if err := db.QueryRow(`SELECT detail FROM audit_logs WHERE action='quota_change' ORDER BY id DESC LIMIT 1`).Scan(&detail); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(detail, "token 默认→默认") || !strings.Contains(detail, "money 默认→60.00") {
		t.Fatalf("quota_change detail = %q", detail)
	}
	// 清除金额 + 设 token 1000
	if w, _ := doJSON(t, r, "PUT", "/api/server/admin/users/"+strconv.FormatInt(uid, 10), `{"quota_clear":true,"quota_tokens":1000,"quota_money":26.5}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("set quota2: %d", w.Code)
	}
	if err := db.QueryRow(`SELECT detail FROM audit_logs WHERE action='quota_change' ORDER BY id DESC LIMIT 1`).Scan(&detail); err != nil {
		t.Fatal(err)
	}
	// quota_clear 优先于 quota_tokens(语义:token 回默认);金额单独设为 26.5
	if !strings.Contains(detail, "token 默认→默认") || !strings.Contains(detail, "money 60.00→26.50") {
		t.Fatalf("quota_change detail2 = %q", detail)
	}
}

// TestAdminDeptBudgetAudit:部门预算变更写 dept_budget_change(2026-09 P1)。
func TestAdminDeptBudgetAudit(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()
	hdr := adminSession(t, r)

	var everyone int64
	if err := db.QueryRow(`SELECT id FROM groups WHERE name='全员'`).Scan(&everyone); err != nil {
		t.Fatal(err)
	}
	w, out := doJSON(t, r, "POST", "/api/server/admin/departments", `{"name":"审计部","parent_id":`+strconv.FormatInt(everyone, 10)+`}`, hdr)
	if w.Code != http.StatusCreated && w.Code != http.StatusOK {
		t.Fatalf("create dept: %d", w.Code)
	}
	id := int64(out["department"].(map[string]any)["id"].(float64))
	// 设预算 500
	if w, _ := doJSON(t, r, "PUT", "/api/server/admin/departments/"+strconv.FormatInt(id, 10), `{"name":"审计部","parent_id":`+strconv.FormatInt(everyone, 10)+`,"budget_money":500}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("set budget: %d", w.Code)
	}
	var detail string
	if err := db.QueryRow(`SELECT detail FROM audit_logs WHERE action='dept_budget_change' ORDER BY id DESC LIMIT 1`).Scan(&detail); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(detail, "审计部: 预算 unset→500.00") {
		t.Fatalf("dept_budget_change detail = %q", detail)
	}
	// 改 800
	if w, _ := doJSON(t, r, "PUT", "/api/server/admin/departments/"+strconv.FormatInt(id, 10), `{"name":"审计部","parent_id":`+strconv.FormatInt(everyone, 10)+`,"budget_money":800}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("set budget2: %d", w.Code)
	}
	if err := db.QueryRow(`SELECT detail FROM audit_logs WHERE action='dept_budget_change' ORDER BY id DESC LIMIT 1`).Scan(&detail); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(detail, "500.00→800.00") {
		t.Fatalf("dept_budget_change detail2 = %q", detail)
	}
}
