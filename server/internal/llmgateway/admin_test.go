package llmgateway

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

func adminTestSetup(t *testing.T) (http.Handler, *sql.DB, map[string]string) {
	t.Helper()
	t.Setenv("PICOAI_MASTER_KEY", "0123456789abcdef0123456789abcdef")
	// adminLoginLimiter 是包级共享(默认 10 次/5min):测试反复登录 boss,
	// 用例增多后触发限流 → login 429 → csrf 为空(flaky)。按该 env 设计用途放宽。
	t.Setenv("PICOAI_LOGIN_MAX_ATTEMPTS", "10000")
	DecryptSecret = func(s string) (string, error) { return s, nil }
	db, err := serverstore.EnsureMigrated(serverstore.DBConfig{Path: fmt.Sprintf("%s/admin.db", t.TempDir())})
	if err != nil {
		t.Fatal(err)
	}
	// channel-type provider creation now syncs immediately: default the
	// fetchFn to a canned catalog so tests never hit the real upstream
	prev := syncFetchFn
	syncFetchFn = func(url string) ([]byte, error) {
		return []byte(`{"data":[{"id":"deepseek-chat"},{"id":"deepseek-reasoner"}]}`), nil
	}
	t.Cleanup(func() { syncFetchFn = prev })
	// admin user
	if _, err := serverstore.CreateUserWithPassword(db, "boss", "pw123456"); err != nil {
		t.Fatal(err)
	}
	u, _ := serverstore.GetUserByUsername(db, "boss")
	u.IsAdmin = true
	if err := serverstore.UpdateUser(db, u); err != nil {
		t.Fatal(err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	serverauth.RegisterAdminRoutes(r, db)
	RegisterAdminRoutes(r, db)

	// login
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/admin/login", strings.NewReader(`{"username":"boss","password":"pw123456"}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	csrf := out["csrf_token"].(string)
	sess := ""
	for _, ck := range w.Result().Cookies() {
		if ck.Name == "picoaide_session" {
			sess = ck.Value
		}
	}
	hdr := map[string]string{"Cookie": "picoaide_session=" + sess, "X-CSRF-Token": csrf}
	return r, db, hdr
}

func adminReq(t *testing.T, r http.Handler, method, path, body string, hdr map[string]string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	return w, out
}

func TestAdminProviders(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	// create provider with key
	w, out := adminReq(t, r, "POST", "/api/admin/providers",
		`{"name":"deepseek","base_url":"https://api.deepseek.com","api_key":"sk-secret-xyz","models":["deepseek-chat"]}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create provider: %d %s", w.Code, w.Body.String())
	}
	// key must be encrypted at rest, masked in response
	p := out["provider"].(map[string]any)
	if p["api_key"] != "***" {
		t.Fatalf("api_key not masked: %v", p["api_key"])
	}
	providers, _ := serverstore.ListGatewayProviders(db)
	if len(providers) != 1 || providers[0].APIKeyEnc == "sk-secret-xyz" {
		t.Fatalf("key not encrypted at rest: %+v", providers)
	}
	if !strings.HasPrefix(providers[0].APIKeyEnc, "enc:v1:") {
		t.Fatalf("key lacks enc prefix: %q", providers[0].APIKeyEnc)
	}
	// master key decrypt round trip
	key, _ := util.GetMasterKey()
	plain, err := util.Decrypt(key, providers[0].APIKeyEnc)
	if err != nil || plain != "sk-secret-xyz" {
		t.Fatalf("decrypt round trip: %q %v", plain, err)
	}
	// non-admin → 403
	if w, _ := adminReq(t, r, "GET", "/api/admin/providers", "", nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("no session: %d", w.Code)
	}

	// update without key keeps old
	w, _ = adminReq(t, r, "PUT", "/api/admin/providers/1", `{"base_url":"https://new.example.com"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("update provider: %d", w.Code)
	}
	providers, _ = serverstore.ListGatewayProviders(db)
	if providers[0].BaseURL != "https://new.example.com" || providers[0].APIKeyEnc == "" {
		t.Fatalf("update lost key: %+v", providers[0])
	}
}

func TestAdminProviderChannel(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	w, out := adminReq(t, r, "POST", "/api/admin/providers",
		`{"name":"deepseek","base_url":"https://api.deepseek.com","api_key":"sk","models":[],"channel":"deepseek"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create channel provider: %d %s", w.Code, w.Body.String())
	}
	p := out["provider"].(map[string]any)
	if p["channel"] != "deepseek" {
		t.Fatalf("channel = %v", p["channel"])
	}

	w, out = adminReq(t, r, "GET", "/api/admin/channels", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("channels: %d %s", w.Code, w.Body.String())
	}
	arr, ok := out["channels"].([]any)
	if !ok || len(arr) == 0 {
		t.Fatalf("channels = %v", out)
	}
}

func TestAdminProviderChannelAutofill(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	// base_url omitted + channel set → autofill from channel default
	w, out := adminReq(t, r, "POST", "/api/admin/providers",
		`{"name":"deepseek","api_key":"sk","models":[],"channel":"deepseek"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create channel provider: %d %s", w.Code, w.Body.String())
	}
	p := out["provider"].(map[string]any)
	if p["base_url"] != "https://api.deepseek.com" {
		t.Fatalf("base_url not autofilled from channel: %v", p["base_url"])
	}

	// stored custom base_url
	if w, _ := adminReq(t, r, "PUT", "/api/admin/providers/1", `{"base_url":"https://custom.example.com"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("set custom base_url: %d", w.Code)
	}
	// channel-only update must not clobber the stored custom base_url
	w, out = adminReq(t, r, "PUT", "/api/admin/providers/1", `{"channel":"deepseek"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("channel update: %d %s", w.Code, w.Body.String())
	}
	p = out["provider"].(map[string]any)
	if p["base_url"] != "https://custom.example.com" {
		t.Fatalf("channel-only update clobbered custom base_url: %v", p["base_url"])
	}
}

func TestAdminChannelProviderUpdateKeepsSyncedModels(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	// sync must not add models in this test (assertion counts them)
	prev := syncFetchFn
	syncFetchFn = func(url string) ([]byte, error) { return []byte(`{"data":[]}`), nil }
	t.Cleanup(func() { syncFetchFn = prev })

	// create channel provider with models=[]
	w, out := adminReq(t, r, "POST", "/api/admin/providers",
		`{"name":"deepseek","base_url":"https://api.deepseek.com","api_key":"sk","models":[],"channel":"deepseek"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create channel provider: %d %s", w.Code, w.Body.String())
	}
	p := out["provider"].(map[string]any)
	id := int64(p["id"].(float64))

	// channel sync puts a model into the models table directly
	if err := serverstore.SyncProviderModel(db, id, "deepseek-v4-flash", "{}"); err != nil {
		t.Fatal(err)
	}

	// update the provider (name change); must not wipe channel-synced models
	if w, _ := adminReq(t, r, "PUT", fmt.Sprintf("/api/admin/providers/%d", id), `{"name":"deepseek-v2"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("update channel provider: %d %s", w.Code, w.Body.String())
	}
	models, _ := ListModels(db)
	if len(models) != 1 || models[0].ID != "deepseek-v4-flash" {
		t.Fatalf("synced model wiped by update: %+v", models)
	}
}

// 渠道型 provider 创建后立即同步上游模型,响应与 models 表都要反映出来。
func TestCreateProviderChannelSyncsImmediately(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	w, out := adminReq(t, r, "POST", "/api/admin/providers",
		`{"name":"deepseek","api_key":"sk","channel":"deepseek"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create channel provider: %d %s", w.Code, w.Body.String())
	}
	sync := out["sync"].(map[string]any)
	if int(sync["added"].(float64)) != 2 {
		t.Fatalf("sync.added = %v, want 2", sync["added"])
	}
	models, _ := ListModels(db)
	if len(models) != 2 {
		t.Fatalf("models = %+v, want the 2 synced models", models)
	}
	names := []string{models[0].ID, models[1].ID}
	if names[0] != "deepseek-chat" && names[1] != "deepseek-chat" {
		t.Fatalf("deepseek-chat missing: %v", names)
	}
}

// 上游同步失败不阻塞创建:provider 保存成功,响应带 sync.error 供页面提示。
func TestCreateProviderSyncFailureKeepsProvider(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()
	prev := syncFetchFn
	syncFetchFn = func(url string) ([]byte, error) { return nil, errors.New("upstream 500") }
	t.Cleanup(func() { syncFetchFn = prev })

	w, out := adminReq(t, r, "POST", "/api/admin/providers",
		`{"name":"deepseek","api_key":"sk","channel":"deepseek"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create must not fail on sync error: %d %s", w.Code, w.Body.String())
	}
	p := out["provider"].(map[string]any)
	if p["channel"] != "deepseek" {
		t.Fatalf("provider channel = %v", p["channel"])
	}
	sync, ok := out["sync"].(map[string]any)
	if !ok || sync["error"] == nil || sync["error"] == "" {
		t.Fatalf("sync.error missing: %v", out["sync"])
	}
	// provider row exists, models table empty (sync never ran)
	providers, _ := serverstore.ListGatewayProviders(db)
	if len(providers) != 1 {
		t.Fatalf("providers = %+v", providers)
	}
	models, _ := ListModels(db)
	if len(models) != 0 {
		t.Fatalf("models should be empty after failed sync: %+v", models)
	}
}

// 渠道列表返回 name + 默认 base_url,页面据此自动回填。
func TestChannelsListDetailed(t *testing.T) {
	r, _, hdr := adminTestSetup(t)
	w, out := adminReq(t, r, "GET", "/api/admin/channels", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("channels: %d %s", w.Code, w.Body.String())
	}
	arr, ok := out["channels"].([]any)
	if !ok || len(arr) == 0 {
		t.Fatalf("channels = %v", out)
	}
	first := arr[0].(map[string]any)
	if first["name"] == nil || first["base_url"] == nil {
		t.Fatalf("channel entry lacks name/base_url: %v", first)
	}
}

func TestAdminModelsAndDefaultModel(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	if w, _ := adminReq(t, r, "POST", "/api/admin/providers",
		`{"name":"deepseek","base_url":"https://api.deepseek.com","api_key":"k","models":["deepseek-chat"]}`, hdr); w.Code != http.StatusOK {
		t.Fatal("create provider failed")
	}
	// provider models are synced into the models table, so a model is
	// immediately visible and selectable as default (no double source)
	w, out := adminReq(t, r, "GET", "/api/admin/models", "", hdr)
	if w.Code != http.StatusOK || len(out["models"].([]any)) != 1 {
		t.Fatalf("models not synced from provider: %d %v", w.Code, out)
	}
	// default model must be in enabled models
	w, _ = adminReq(t, r, "PUT", "/api/admin/gateway", `{"default_model":"bogus-model"}`, hdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bogus default model accepted: %d", w.Code)
	}
	w, _ = adminReq(t, r, "PUT", "/api/admin/gateway", `{"default_model":"deepseek-chat","allow_private":true,"search_endpoint":"https://s/q"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("set default model: %d %s", w.Code, w.Body.String())
	}
	v, ok, _ := serverstore.GetSetting(db, "gateway.default_model")
	if !ok || v != "deepseek-chat" {
		t.Fatalf("default_model = %q ok=%v", v, ok)
	}
	// read back
	w, out = adminReq(t, r, "GET", "/api/admin/gateway", "", hdr)
	if w.Code != http.StatusOK || out["default_model"] != "deepseek-chat" || out["allow_private"] != true {
		t.Fatalf("gateway config: %d %v", w.Code, out)
	}
	// server_base_url:对外 HTTPS 地址,webadmin 配置并读回
	w, _ = adminReq(t, r, "PUT", "/api/admin/gateway", `{"server_base_url":"https://picoaide.example.com"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("set server_base_url: %d %s", w.Code, w.Body.String())
	}
	w, out = adminReq(t, r, "GET", "/api/admin/gateway", "", hdr)
	if w.Code != http.StatusOK || out["server_base_url"] != "https://picoaide.example.com" {
		t.Fatalf("server_base_url not persisted: %d %v", w.Code, out)
	}
	// monthly_quota:全局默认员工月配额,读写并拒绝负数
	if w, _ := adminReq(t, r, "PUT", "/api/admin/gateway", `{"monthly_quota":"-5"}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("negative monthly_quota accepted: %d", w.Code)
	}
	w, _ = adminReq(t, r, "PUT", "/api/admin/gateway", `{"monthly_quota":"100000"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("set monthly_quota: %d %s", w.Code, w.Body.String())
	}
	w, out = adminReq(t, r, "GET", "/api/admin/gateway", "", hdr)
	if w.Code != http.StatusOK || out["monthly_quota"] != "100000" {
		t.Fatalf("monthly_quota not persisted: %d %v", w.Code, out)
	}
	// 未配置时 GET 返回 "0"(不限)
	w, _ = adminReq(t, r, "PUT", "/api/admin/gateway", `{"monthly_quota":"0"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("reset monthly_quota: %d", w.Code)
	}
	// delete model
	if w, _ := adminReq(t, r, "DELETE", "/api/admin/models/1", "", hdr); w.Code != http.StatusOK {
		t.Fatalf("delete model: %d", w.Code)
	}
}

// 禁用开关:enabled=false 后 provider 不再参与路由
func TestProviderEnableToggle(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()
	w, out := adminReq(t, r, "POST", "/api/admin/providers",
		`{"name":"manual","base_url":"https://x.example","api_key":"sk","models":["m1"]}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create provider: %d %s", w.Code, w.Body.String())
	}
	id := int64(out["provider"].(map[string]any)["id"].(float64))
	// 禁用
	if w, _ := adminReq(t, r, "PUT", fmt.Sprintf("/api/admin/providers/%d", id), `{"enabled":false}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("disable provider: %d %s", w.Code, w.Body.String())
	}
	ups, err := MatchModels(db, "m1")
	if err != nil {
		t.Fatal(err)
	}
	if len(ups) != 0 {
		t.Fatalf("disabled provider still routable: %+v", ups)
	}
	// 重新启用
	if w, _ := adminReq(t, r, "PUT", fmt.Sprintf("/api/admin/providers/%d", id), `{"enabled":true}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("enable provider: %d %s", w.Code, w.Body.String())
	}
	ups, err = MatchModels(db, "m1")
	if err != nil || len(ups) != 1 {
		t.Fatalf("re-enabled provider not routable: %+v %v", ups, err)
	}
}

// TestAdminGatewayMoneyQuota: 全局默认金额配额读写 + 拒绝负数。
func TestAdminGatewayMoneyQuota(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	// 未配置时 GET 返回 "0"(不限)
	w, out := adminReq(t, r, "GET", "/api/admin/gateway", "", hdr)
	if w.Code != http.StatusOK || out["monthly_quota_money"] != "0" {
		t.Fatalf("default monthly_quota_money: %d %v", w.Code, out)
	}
	// 负数拒绝
	if w, _ := adminReq(t, r, "PUT", "/api/admin/gateway", `{"monthly_quota_money":"-5"}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("negative monthly_quota_money accepted: %d", w.Code)
	}
	// 写入并读回
	w, _ = adminReq(t, r, "PUT", "/api/admin/gateway", `{"monthly_quota_money":"500"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("set monthly_quota_money: %d %s", w.Code, w.Body.String())
	}
	w, out = adminReq(t, r, "GET", "/api/admin/gateway", "", hdr)
	if w.Code != http.StatusOK || out["monthly_quota_money"] != "500" {
		t.Fatalf("monthly_quota_money not persisted: %d %v", w.Code, out)
	}
}

// TestAdminModelPricing: 模型增改携带 input/output 价格(0022)。
func TestAdminModelPricing(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	if w, _ := adminReq(t, r, "POST", "/api/admin/providers",
		`{"name":"deepseek","base_url":"https://api.deepseek.com","api_key":"k","models":[]}`, hdr); w.Code != http.StatusOK {
		t.Fatal("create provider failed")
	}
	// 新增模型带价格
	w, _ := adminReq(t, r, "POST", "/api/admin/models",
		`{"name":"deepseek-chat","provider_id":1,"display_name":"聊天","input_price_per_1m":2,"output_price_per_1m":8}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create model with price: %d %s", w.Code, w.Body.String())
	}
	m, err := serverstore.GetModel(db, 1)
	if err != nil {
		t.Fatal(err)
	}
	if m.InputPricePer1M == nil || *m.InputPricePer1M != 2 {
		t.Fatalf("input price = %v, want 2", m.InputPricePer1M)
	}
	if m.OutputPricePer1M == nil || *m.OutputPricePer1M != 8 {
		t.Fatalf("output price = %v, want 8", m.OutputPricePer1M)
	}
	// 更新价格
	w, _ = adminReq(t, r, "PUT", "/api/admin/models/1",
		`{"input_price_per_1m":3,"output_price_per_1m":10}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("update model price: %d %s", w.Code, w.Body.String())
	}
	m, err = serverstore.GetModel(db, 1)
	if err != nil {
		t.Fatal(err)
	}
	if *m.InputPricePer1M != 3 || *m.OutputPricePer1M != 10 {
		t.Fatalf("prices after update = %v/%v, want 3/10", *m.InputPricePer1M, *m.OutputPricePer1M)
	}
	// 负数拒绝
	if w, _ := adminReq(t, r, "PUT", "/api/admin/models/1", `{"input_price_per_1m":-1}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("negative price accepted: %d", w.Code)
	}
}

// TestAdminModelOffpeakDiscount: 模型低谷折扣率增改与校验(0023)。
func TestAdminModelOffpeakDiscount(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	if w, _ := adminReq(t, r, "POST", "/api/admin/providers",
		`{"name":"deepseek","base_url":"https://api.deepseek.com","api_key":"k","models":[]}`, hdr); w.Code != http.StatusOK {
		t.Fatal("create provider failed")
	}
	// 新增带峰谷折扣
	w, _ := adminReq(t, r, "POST", "/api/admin/models",
		`{"name":"deepseek-chat","provider_id":1,"display_name":"聊天","input_price_per_1m":2,"output_price_per_1m":8,"offpeak_discount":0.5}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create model with offpeak: %d %s", w.Code, w.Body.String())
	}
	m, err := serverstore.GetModel(db, 1)
	if err != nil {
		t.Fatal(err)
	}
	if m.OffpeakDiscount == nil || *m.OffpeakDiscount != 0.5 {
		t.Fatalf("offpeak_discount = %v, want 0.5", m.OffpeakDiscount)
	}
	// 更新折扣
	w, _ = adminReq(t, r, "PUT", "/api/admin/models/1", `{"offpeak_discount":0.6}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("update offpeak: %d %s", w.Code, w.Body.String())
	}
	m, _ = serverstore.GetModel(db, 1)
	if *m.OffpeakDiscount != 0.6 {
		t.Fatalf("offpeak after update = %v, want 0.6", *m.OffpeakDiscount)
	}
	// 非法值拒绝:0 与 >1
	if w, _ := adminReq(t, r, "PUT", "/api/admin/models/1", `{"offpeak_discount":0}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("offpeak 0 accepted: %d", w.Code)
	}
	if w, _ := adminReq(t, r, "PUT", "/api/admin/models/1", `{"offpeak_discount":1.5}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("offpeak 1.5 accepted: %d", w.Code)
	}
	if w, _ := adminReq(t, r, "PUT", "/api/admin/models/1", `{"offpeak_discount":-0.5}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("offpeak -0.5 accepted: %d", w.Code)
	}
}

// TestAdminGatewayPeakWindows: 高峰时段配置读写 + 非法值拒绝。
func TestAdminGatewayPeakWindows(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	// 缺省返回空(无峰谷)
	w, out := adminReq(t, r, "GET", "/api/admin/gateway", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("gateway get: %d", w.Code)
	}
	if out["peak_windows"] != "" {
		t.Fatalf("default peak_windows = %v, want empty", out["peak_windows"])
	}

	// 写入 DeepSeek 当前政策窗口
	body := `{"peak_windows":"[{\"start\":\"09:00\",\"end\":\"12:00\"},{\"start\":\"14:00\",\"end\":\"18:00\"}]"}`
	if w, _ := adminReq(t, r, "PUT", "/api/admin/gateway", body, hdr); w.Code != http.StatusOK {
		t.Fatalf("set peak_windows: %d %s", w.Code, w.Body.String())
	}
	v, ok, _ := serverstore.GetSetting(db, serverstore.PeakWindowsSetting)
	if !ok || v == "" {
		t.Fatalf("peak_windows not persisted: %q ok=%v", v, ok)
	}
	w, out = adminReq(t, r, "GET", "/api/admin/gateway", "", hdr)
	if w.Code != http.StatusOK || out["peak_windows"] != v {
		t.Fatalf("peak_windows readback: %d %v", w.Code, out)
	}

	// 非法 JSON 拒绝(不写库,防计费口径混乱)
	if w, _ := adminReq(t, r, "PUT", "/api/admin/gateway", `{"peak_windows":"not-json"}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("bad peak_windows accepted: %d", w.Code)
	}
}

// TestAdminModelsListIncludesPricing: admin 模型列表必须返回价格与峰谷折扣
// 字段(webadmin 价格列/编辑弹窗的数据源;此前误用公开 ListModels 导致字段缺失)。
func TestAdminModelsListIncludesPricing(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	if w, _ := adminReq(t, r, "POST", "/api/admin/providers",
		`{"name":"deepseek","base_url":"https://api.deepseek.com","api_key":"k","models":[]}`, hdr); w.Code != http.StatusOK {
		t.Fatal("create provider failed")
	}
	w, _ := adminReq(t, r, "POST", "/api/admin/models",
		`{"name":"deepseek-chat","provider_id":1,"display_name":"聊天","input_price_per_1m":2,"output_price_per_1m":8,"offpeak_discount":0.5}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create model: %d %s", w.Code, w.Body.String())
	}

	w, out := adminReq(t, r, "GET", "/api/admin/models", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("list models: %d", w.Code)
	}
	ms := out["models"].([]any)
	if len(ms) != 1 {
		t.Fatalf("models = %d, want 1", len(ms))
	}
	m := ms[0].(map[string]any)
	if v, ok := m["input_price_per_1m"]; !ok || v != float64(2) {
		t.Fatalf("input_price_per_1m = %v (present=%v), want 2", v, ok)
	}
	if v, ok := m["output_price_per_1m"]; !ok || v != float64(8) {
		t.Fatalf("output_price_per_1m = %v (present=%v), want 8", v, ok)
	}
	if v, ok := m["offpeak_discount"]; !ok || v != float64(0.5) {
		t.Fatalf("offpeak_discount = %v (present=%v), want 0.5", v, ok)
	}
}

// 审计修复 H1:peak_windows 显式空串 = 清空(移除高峰窗口),保持 UI
// 「留空 = 无峰谷价」承诺成立。此前空串被跳过,已配置的窗口无法关闭。
func TestAdminGatewayPeakWindowsClear(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	body := `{"peak_windows":"[{\"start\":\"09:00\",\"end\":\"12:00\"}]"}`
	if w, _ := adminReq(t, r, "PUT", "/api/admin/gateway", body, hdr); w.Code != http.StatusOK {
		t.Fatalf("set peak_windows: %d", w.Code)
	}
	v, ok, _ := serverstore.GetSetting(db, serverstore.PeakWindowsSetting)
	if !ok || v == "" {
		t.Fatalf("peak_windows not persisted: %q ok=%v", v, ok)
	}
	// 显式空串清空
	if w, _ := adminReq(t, r, "PUT", "/api/admin/gateway", `{"peak_windows":""}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("clear peak_windows: %d", w.Code)
	}
	w, out := adminReq(t, r, "GET", "/api/admin/gateway", "", hdr)
	if w.Code != http.StatusOK || out["peak_windows"] != "" {
		t.Fatalf("peak_windows after clear = %v (%d), want empty", out["peak_windows"], w.Code)
	}
}

// 审计修复 M1:PUT /gateway 部分更新语义——未传字段不覆盖,显式空串清空。
// 此前 allow_private/search_endpoint 被部分提交意外重置,server_base_url
// /default_model 又永远无法清空。
func TestAdminGatewayPartialUpdate(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	// 先全量设置
	if w, _ := adminReq(t, r, "PUT", "/api/admin/gateway", `{
		"default_model":"","rate_limit":"60","monthly_quota":"0","monthly_quota_money":"0",
		"peak_windows":"","allow_private":true,"search_endpoint":"https://s/q","server_base_url":"https://picoaide.example.com"
	}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("full set: %d", w.Code)
	}
	// 只提交 rate_limit:其它字段必须保持原值
	if w, _ := adminReq(t, r, "PUT", "/api/admin/gateway", `{"rate_limit":"120"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("partial update: %d", w.Code)
	}
	w, out := adminReq(t, r, "GET", "/api/admin/gateway", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("get: %d", w.Code)
	}
	if out["rate_limit"] != "120" || out["allow_private"] != true || out["search_endpoint"] != "https://s/q" ||
		out["server_base_url"] != "https://picoaide.example.com" {
		t.Fatalf("partial update clobbered fields: %v", out)
	}
	// 显式空串清空 server_base_url / search_endpoint / default_model
	if w, _ := adminReq(t, r, "PUT", "/api/admin/gateway", `{"server_base_url":"","search_endpoint":""}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("clear fields: %d", w.Code)
	}
	w, out = adminReq(t, r, "GET", "/api/admin/gateway", "", hdr)
	if w.Code != http.StatusOK || out["server_base_url"] != "" || out["search_endpoint"] != "" {
		t.Fatalf("clear not applied: %v", out)
	}
	// 显式 false 关闭 allow_private
	if w, _ := adminReq(t, r, "PUT", "/api/admin/gateway", `{"allow_private":false}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("disable allow_private: %d", w.Code)
	}
	w, out = adminReq(t, r, "GET", "/api/admin/gateway", "", hdr)
	if w.Code != http.StatusOK || out["allow_private"] != false {
		t.Fatalf("allow_private not disabled: %v", out)
	}
}

// 审计修复 M2:删除不存在的上游/模型 → 404 NOT_FOUND(此前 500)。
func TestAdminDeleteNotFound(t *testing.T) {
	r, _, hdr := adminTestSetup(t)
	if w, out := adminReq(t, r, "DELETE", "/api/admin/providers/999", "", hdr); w.Code != http.StatusNotFound {
		t.Fatalf("delete missing provider = %d %v, want 404", w.Code, out)
	}
	if w, out := adminReq(t, r, "DELETE", "/api/admin/models/999", "", hdr); w.Code != http.StatusNotFound {
		t.Fatalf("delete missing model = %d %v, want 404", w.Code, out)
	}
}

// 审计修复 M2:createModel 指向不存在的上游 → VALIDATION(此前 FK 冲突落 500)。
func TestAdminCreateModelBadProvider(t *testing.T) {
	r, _, hdr := adminTestSetup(t)
	if w, out := adminReq(t, r, "POST", "/api/admin/models",
		`{"name":"m","provider_id":999}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("create model with bad provider = %d %v, want 400", w.Code, out)
	}
}

// 审计修复 M7:改名防护——渠道同步模型与有用量记录的手动模型拒绝改名。
func TestAdminModelRenameProtection(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	// 渠道型上游(adminTestSetup 的 syncFetchFn 返回 deepseek-chat/reasoner)
	if w, _ := adminReq(t, r, "POST", "/api/admin/providers",
		`{"name":"deepseek","api_key":"sk","channel":"deepseek"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create channel provider: %d", w.Code)
	}
	// 渠道同步模型拒绝改名
	if w, out := adminReq(t, r, "PUT", "/api/admin/models/1", `{"name":"renamed-chat"}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("rename channel model = %d %v, want 400", w.Code, out)
	}
	// 手动型上游:无用量可改名
	if w, _ := adminReq(t, r, "POST", "/api/admin/providers",
		`{"name":"manual","base_url":"https://x.example","api_key":"sk","models":["m1"]}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create manual provider: %d", w.Code)
	}
	var mid int64
	if err := db.QueryRow("SELECT id FROM models WHERE name = 'm1'").Scan(&mid); err != nil {
		t.Fatal(err)
	}
	if w, _ := adminReq(t, r, "PUT", fmt.Sprintf("/api/admin/models/%d", mid), `{"name":"m1-renamed"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("rename manual model without usage = %d", w.Code)
	}
	// 有用量记录后拒绝改名
	if _, err := serverstore.RecordUsage(db, 1, "m1-renamed", 10, 10); err != nil {
		t.Fatal(err)
	}
	if w, out := adminReq(t, r, "PUT", fmt.Sprintf("/api/admin/models/%d", mid), `{"name":"m1-again"}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("rename model with usage = %d %v, want 400", w.Code, out)
	}
	// 改名撞已存在模型名 → VALIDATION(此前 UNIQUE 冲突落 500)
	if w, out := adminReq(t, r, "PUT", fmt.Sprintf("/api/admin/models/%d", mid), `{"name":"deepseek-reasoner"}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("rename to existing name = %d %v, want 400", w.Code, out)
	}
}

// 审计修复 L6:显式 null 清空价格为未定价(此前 null 与缺省同义,无法回退)。
func TestAdminModelPriceNullClears(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	if w, _ := adminReq(t, r, "POST", "/api/admin/providers",
		`{"name":"p","base_url":"https://x.example","api_key":"k","models":[]}`, hdr); w.Code != http.StatusOK {
		t.Fatal("create provider failed")
	}
	if w, _ := adminReq(t, r, "POST", "/api/admin/models",
		`{"name":"m","provider_id":1,"input_price_per_1m":2,"output_price_per_1m":8}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create model: %d", w.Code)
	}
	// 显式 null 清空输入价
	if w, _ := adminReq(t, r, "PUT", "/api/admin/models/1", `{"input_price_per_1m":null}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("null clear: %d", w.Code)
	}
	m, err := serverstore.GetModel(db, 1)
	if err != nil {
		t.Fatal(err)
	}
	if m.InputPricePer1M != nil {
		t.Fatalf("input price = %v, want nil (cleared)", *m.InputPricePer1M)
	}
	if m.OutputPricePer1M == nil || *m.OutputPricePer1M != 8 {
		t.Fatalf("output price = %v, want 8 (untouched)", m.OutputPricePer1M)
	}
}

// 审计修复 L4:渠道型上游无 API Key 创建 → VALIDATION。
func TestAdminCreateChannelProviderRequiresKey(t *testing.T) {
	r, _, hdr := adminTestSetup(t)
	if w, out := adminReq(t, r, "POST", "/api/admin/providers",
		`{"name":"nokey","channel":"deepseek"}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("channel provider without key = %d %v, want 400", w.Code, out)
	}
}

// 审计修复 M3:渠道型上游更新时清理其手动模型清单(防旧模型继续路由)。
func TestAdminProviderUpdateChannelClearsManualModels(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()
	// 手动型上游带模型清单
	w, out := adminReq(t, r, "POST", "/api/admin/providers",
		`{"name":"p","base_url":"https://x.example","api_key":"k","models":["m1"]}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create manual provider: %d", w.Code)
	}
	id := int64(out["provider"].(map[string]any)["id"].(float64))
	// 切到渠道型
	if w, _ := adminReq(t, r, "PUT", fmt.Sprintf("/api/admin/providers/%d", id), `{"channel":"deepseek"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("switch to channel: %d", w.Code)
	}
	p, err := serverstore.GetGatewayProvider(db, id)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Models) != 0 {
		t.Fatalf("manual models not cleared after channel switch: %+v", p.Models)
	}
}

// 审计修复 M3:管理端模型列表展示已停用上游的模型(此前被 enabled 过滤隐藏,
// 禁用上游的模型变成不可管理的"幽灵")。客户端列表仍只显示启用上游。
func TestAdminModelsListIncludesDisabledProvider(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()
	w, out := adminReq(t, r, "POST", "/api/admin/providers",
		`{"name":"p","base_url":"https://x.example","api_key":"k","models":["m1"]}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create provider: %d", w.Code)
	}
	id := int64(out["provider"].(map[string]any)["id"].(float64))
	if w, _ := adminReq(t, r, "PUT", fmt.Sprintf("/api/admin/providers/%d", id), `{"enabled":false}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("disable provider: %d", w.Code)
	}
	w, out = adminReq(t, r, "GET", "/api/admin/models", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("list models: %d", w.Code)
	}
	ms := out["models"].([]any)
	if len(ms) != 1 {
		t.Fatalf("admin models = %d, want 1 (disabled provider's model still listed)", len(ms))
	}
	m := ms[0].(map[string]any)
	if m["provider_name"] != "p" || m["provider_enabled"] != false {
		t.Fatalf("provider fields = %v/%v, want p/false", m["provider_name"], m["provider_enabled"])
	}
	// 客户端列表过滤禁用上游
	pub, err := ListModels(db)
	if err != nil || len(pub) != 0 {
		t.Fatalf("public models = %+v, want empty", pub)
	}
}

// 审计修复 H2:DELETE 渠道同步模型 → 记入排除名单,再次同步不复活。
func TestAdminDeleteChannelModelNotResurrected(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()
	// 渠道型上游创建即同步 2 个模型(adminTestSetup 的 syncFetchFn)
	if w, _ := adminReq(t, r, "POST", "/api/admin/providers",
		`{"name":"deepseek","api_key":"sk","channel":"deepseek"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create channel provider: %d", w.Code)
	}
	w, out := adminReq(t, r, "GET", "/api/admin/models", "", hdr)
	if w.Code != http.StatusOK || len(out["models"].([]any)) != 2 {
		t.Fatalf("models after channel sync = %v", out)
	}
	// 删除 deepseek-chat(id=1)
	if w, _ := adminReq(t, r, "DELETE", "/api/admin/models/1", "", hdr); w.Code != http.StatusOK {
		t.Fatalf("delete channel model: %d", w.Code)
	}
	// 再次同步同一目录:排除名单中的模型不复活
	fetch := func(url string) ([]byte, error) {
		return []byte(`{"data":[{"id":"deepseek-chat"},{"id":"deepseek-reasoner"}]}`), nil
	}
	if _, err := SyncOnce(db, fetch); err != nil {
		t.Fatal(err)
	}
	w, out = adminReq(t, r, "GET", "/api/admin/models", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("list models: %d", w.Code)
	}
	ms := out["models"].([]any)
	if len(ms) != 1 {
		t.Fatalf("models after resync = %d, want 1 (excluded model not resurrected): %v", len(ms), out)
	}
	if ms[0].(map[string]any)["name"] != "deepseek-reasoner" {
		t.Fatalf("unexpected model: %v", ms[0])
	}
}

// 审计修复 M3 附带:渠道型上游可切回手动型(此前 channel 空串被跳过,
// 一旦选了渠道永远无法取消);创建渠道型上游时不落手动模型清单。
func TestAdminProviderChannelClearToManual(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	// 创建渠道型上游并携带 models:清单必须被丢弃(模型由同步维护)
	w, out := adminReq(t, r, "POST", "/api/admin/providers",
		`{"name":"ch","api_key":"sk","channel":"deepseek","models":["stale-model"]}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create channel provider: %d %s", w.Code, w.Body.String())
	}
	id := int64(out["provider"].(map[string]any)["id"].(float64))
	p, err := serverstore.GetGatewayProvider(db, id)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Models) != 0 {
		t.Fatalf("channel provider stored manual models: %+v", p.Models)
	}

	// 切回手动型:channel 显式空串
	if w, _ := adminReq(t, r, "PUT", fmt.Sprintf("/api/admin/providers/%d", id), `{"channel":""}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("clear channel: %d %s", w.Code, w.Body.String())
	}
	p, err = serverstore.GetGatewayProvider(db, id)
	if err != nil {
		t.Fatal(err)
	}
	if p.Channel != "" {
		t.Fatalf("channel not cleared: %q", p.Channel)
	}
	// 渠道型 provider 更新的 models 表行由同步删除(切手动型后手动清单为空)
	models, _ := ListModels(db)
	if len(models) != 0 {
		t.Fatalf("models after clear-to-manual = %+v, want empty", models)
	}
}

// 回归:手动型上游仅启停(enabled)不得清空其模型清单(审计修复后曾误删)。
func TestAdminToggleProviderKeepsManualModels(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	if w, _ := adminReq(t, r, "POST", "/api/admin/providers",
		`{"name":"manual","base_url":"http://x","api_key":"k","models":["keep-a","keep-b"]}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create provider: %d", w.Code)
	}
	// 手动型:models 字段在创建时即入 models 表
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM models WHERE provider_id = 1").Scan(&n); err != nil || n != 2 {
		t.Fatalf("models after create = %d, want 2", n)
	}
	// 仅启停(不带 models 字段)
	if w, _ := adminReq(t, r, "PUT", "/api/admin/providers/1", `{"enabled":false}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("toggle: %d %s", w.Code, w.Body.String())
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM models WHERE provider_id = 1").Scan(&n); err != nil || n != 2 {
		t.Fatalf("models after toggle = %d, want 2 (must not be wiped)", n)
	}
	// 显式携带 models 才同步
	if w, _ := adminReq(t, r, "PUT", "/api/admin/providers/1", `{"models":["only-a"]}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("set models: %d", w.Code)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM models WHERE provider_id = 1").Scan(&n); err != nil || n != 1 {
		t.Fatalf("models after explicit sync = %d, want 1", n)
	}
}
