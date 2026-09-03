package llmgateway

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// auditTestRouter 建最小管理路由树(与生产 router 声明一致)。
func auditTestRouter(t *testing.T) (http.Handler, *sql.DB, *http.Cookie, string) {
	t.Helper()
	// 密钥加密依赖 master key(与生产一致:env 注入)
	t.Setenv("PICOAI_MASTER_KEY", "0123456789abcdef")
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	uid, err := serverstore.CreateUser(db, &serverstore.User{
		Username: "boss", Source: "local", Status: 1, Role: serverstore.RoleSuperAdmin,
	})
	if err != nil {
		t.Fatal(err)
	}
	sess, csrf, err := serverauth.CreateAdminSession(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterAdminRoutes(r, db)
	return r, db, &http.Cookie{Name: "picoaide_session", Value: sess.ID}, csrf
}

func doJSON2(t *testing.T, r http.Handler, method, path string, body any, cookie *http.Cookie, csrf string) (int, map[string]any) {
	t.Helper()
	var rd *strings.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = strings.NewReader(string(b))
	} else {
		rd = strings.NewReader("")
	}
	req := httptest.NewRequest(method, path, rd)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.AddCookie(cookie)
	if req.Method != "GET" {
		req.Header.Set("X-CSRF-Token", csrf)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	out := map[string]any{}
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if w.Code != http.StatusOK {
		t.Fatalf("%s %s: %d %s", method, path, w.Code, w.Body.String())
	}
	return w.Code, out
}

func lastAudit(t *testing.T, db *sql.DB, action string) (string, bool) {
	t.Helper()
	var detail string
	err := db.QueryRow(`SELECT detail FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT 1`, action).Scan(&detail)
	if err != nil {
		return "", false
	}
	return detail, true
}

func TestGatewayConfigAudit(t *testing.T) {
	r, db, cookie, csrf := auditTestRouter(t)

	// 全局设置:限流 + 默认配额(两类审计动作)
	doJSON2(t, r, "PUT", "/api/server/admin/gateway", gin.H{"rate_limit": "120", "monthly_quota": "200000", "monthly_quota_money": "66"}, cookie, csrf)

	if _, ok := lastAudit(t, db, "quota_default_change"); !ok {
		t.Fatal("missing quota_default_change")
	} else if d, _ := lastAudit(t, db, "quota_default_change"); !strings.Contains(d, "默认token配额:") || !strings.Contains(d, "默认金额配额:") {
		t.Fatalf("quota_default_change detail = %s", d)
	}
	d, ok := lastAudit(t, db, "gateway_config")
	if !ok || !strings.Contains(d, "每用户限流:(空)→120") {
		t.Fatalf("gateway_config detail = %q", d)
	}
}

func TestProviderAudit(t *testing.T) {
	r, db, cookie, csrf := auditTestRouter(t)

	_, out := doJSON2(t, r, "POST", "/api/server/admin/providers", gin.H{
		"name": "DeepSeek", "base_url": "https://api.deepseek.com", "api_key": "sk-x",
		"models": []string{"deepseek-chat"}, "protocol": "openai",
	}, cookie, csrf)
	pid := int64(out["provider"].(map[string]any)["id"].(float64))
	if _, ok := lastAudit(t, db, "provider_create"); !ok {
		t.Fatal("missing provider_create")
	}
	// 更新(改名 + 启用切换)
	doJSON2(t, r, "PUT", "/api/server/admin/providers/"+itoa(pid), gin.H{"name": "DeepSeek 2", "enabled": false}, cookie, csrf)
	d, ok := lastAudit(t, db, "provider_update")
	if !ok || !strings.Contains(d, "name:DeepSeek→DeepSeek 2") || !strings.Contains(d, "enabled:true→false") {
		t.Fatalf("provider_update detail = %q", d)
	}
	// 删除
	doJSON2(t, r, "DELETE", "/api/server/admin/providers/"+itoa(pid), nil, cookie, csrf)
	if _, ok := lastAudit(t, db, "provider_delete"); !ok {
		t.Fatal("missing provider_delete")
	}
}

func TestModelAudit(t *testing.T) {
	r, db, cookie, csrf := auditTestRouter(t)

	_, out := doJSON2(t, r, "POST", "/api/server/admin/providers", gin.H{
		"name": "P", "base_url": "https://p.example.com", "api_key": "sk-x", "protocol": "openai",
	}, cookie, csrf)
	pid := int64(out["provider"].(map[string]any)["id"].(float64))

	_, mout := doJSON2(t, r, "POST", "/api/server/admin/models", gin.H{
		"name": "m1", "provider_id": pid, "display_name": "M1", "default_params": "{}",
		"input_price_per_1m": 2, "output_price_per_1m": 8,
	}, cookie, csrf)
	mid := int64(mout["model"].(map[string]any)["id"].(float64))
	d, ok := lastAudit(t, db, "model_create")
	if !ok || !strings.Contains(d, "m1") || !strings.Contains(d, "input=2") {
		t.Fatalf("model_create detail = %q", d)
	}
	// 改价(输出价 8→16)
	doJSON2(t, r, "PUT", "/api/server/admin/models/"+itoa(mid), gin.H{"output_price_per_1m": 16}, cookie, csrf)
	d, ok = lastAudit(t, db, "model_update")
	if !ok || !strings.Contains(d, "output:8→16") {
		t.Fatalf("model_update detail = %q", d)
	}
	// 删除
	doJSON2(t, r, "DELETE", "/api/server/admin/models/"+itoa(mid), nil, cookie, csrf)
	if _, ok := lastAudit(t, db, "model_delete"); !ok {
		t.Fatal("missing model_delete")
	}
}

func itoa(v int64) string {
	return strconv.FormatInt(v, 10)
}
