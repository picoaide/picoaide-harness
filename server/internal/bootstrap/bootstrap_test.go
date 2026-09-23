package bootstrap

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

func setup(t *testing.T) (*gin.Engine, *sql.DB) {
	t.Helper()
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	// providers + models
	pid, err := serverstore.AddGatewayProvider(db, &serverstore.GatewayProvider{
		Name: "deepseek", BaseURL: "https://api.deepseek.com", Enabled: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.AddModel(db, &serverstore.Model{Name: "deepseek-chat", ProviderID: pid, DisplayName: "DeepSeek Chat"}); err != nil {
		t.Fatal(err)
	}
	// skill (one enabled, one disabled)
	_, err = serverstore.AddSkill(db, &serverstore.Skill{Name: "ppt-gen", Version: "1.2.0", Description: "PPT 生成", Enabled: 1})
	if err != nil {
		t.Fatal(err)
	}
	_, err = serverstore.AddSkill(db, &serverstore.Skill{Name: "off", Version: "0.1.0", Enabled: 0})
	if err != nil {
		t.Fatal(err)
	}
	// user + token
	if _, err := serverstore.CreateUserWithPassword(db, "alice", "pw123456"); err != nil {
		t.Fatal(err)
	}
	// 严格授权:alice 可见被授权的技能;未授权的不可见
	if err := serverstore.GrantSkill(db, "ppt-gen", "alice", serverstore.GranteeUser); err != nil {
		t.Fatal(err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterRoutes(r, db)
	return r, db
}

func getJSON(t *testing.T, r http.Handler, path, token string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest("GET", path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	return w, out
}

func TestBootstrap(t *testing.T) {
	r, db := setup(t)
	u, _ := serverstore.GetUserByUsername(db, "alice")
	token, _ := serverauth.IssueToken(db, u.ID)

	w, out := getJSON(t, r, "/api/client/v2/config/bootstrap", token)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	if out["default_model"] != "deepseek-chat" {
		t.Fatalf("default_model = %v", out["default_model"])
	}
	// server_version 的判据见 TestServerVersionIsInformationalOnly（本文件末尾）：
	// 这里曾经写着"客户端据此发现『服务端已升级、本机客户端是旧版』……是版本错配的
	// **唯一可见信号**，不能缺"—— 那是不成立的承诺（客户端零消费方），已撤回。
	// 留在这里的只有**线格式契约**这一条（字段在、值是服务端构建版本）。
	if got := out["server_version"]; got != serverauth.BuildVersion() {
		t.Fatalf("server_version = %v, want %q", got, serverauth.BuildVersion())
	}
	models := out["models"].([]any)
	if len(models) != 1 {
		t.Fatalf("models = %v", models)
	}
	// 0058:输入模态随清单下发(缺省仅 text;视觉模型为 text+image)
	m0 := models[0].(map[string]any)
	mods, ok := m0["input_modalities"].([]any)
	if !ok || len(mods) != 1 || mods[0] != "text" {
		t.Fatalf("model input_modalities = %v, want [text]", m0["input_modalities"])
	}
	skills := out["skills"].([]any)
	if len(skills) != 1 {
		t.Fatalf("skills = %v (disabled must be excluded)", skills)
	}
	web := out["web"].(map[string]any)
	if web["allow_private"] != nil || web["search_endpoint"] != nil {
		t.Fatalf("web = %v (allow_private/search_endpoint must be removed)", web)
	}
	// no token → 401
	if w, _ := getJSON(t, r, "/api/client/v2/config/bootstrap", ""); w.Code != http.StatusUnauthorized {
		t.Fatalf("no token status = %d", w.Code)
	}
}

func TestBootstrapInputModalitiesImage(t *testing.T) {
	// 0058:视觉模型(文本+图片)的 input_modalities 随 bootstrap 下发。
	r, db := setup(t)
	pid, err := serverstore.AddGatewayProvider(db, &serverstore.GatewayProvider{
		Name: "deepseek-vision", BaseURL: "https://api.deepseek.com", Enabled: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.AddModel(db, &serverstore.Model{
		Name: "vision-exp", ProviderID: pid, DisplayName: "Vision",
		InputModalities: []string{"text", "image"},
	}); err != nil {
		t.Fatal(err)
	}
	u, _ := serverstore.GetUserByUsername(db, "alice")
	token, _ := serverauth.IssueToken(db, u.ID)
	_, out := getJSON(t, r, "/api/client/v2/config/bootstrap", token)
	models := out["models"].([]any)
	if len(models) != 2 {
		t.Fatalf("models = %v", models)
	}
	var got []any
	for _, m := range models {
		if m.(map[string]any)["id"] == "vision-exp" {
			got = m.(map[string]any)["input_modalities"].([]any)
		}
	}
	if len(got) != 2 || got[0] != "text" || got[1] != "image" {
		t.Fatalf("vision input_modalities = %v, want [text image]", got)
	}
}

func TestBootstrapDefaultModelFallback(t *testing.T) {
	r, db := setup(t)
	if err := serverstore.SetSetting(db, "gateway.default_model", "nonexistent-model"); err != nil {
		t.Fatal(err)
	}
	u, _ := serverstore.GetUserByUsername(db, "alice")
	token, _ := serverauth.IssueToken(db, u.ID)
	_, out := getJSON(t, r, "/api/client/v2/config/bootstrap", token)
	if out["default_model"] != "deepseek-chat" {
		t.Fatalf("fallback default_model = %v, want deepseek-chat", out["default_model"])
	}
}

func TestBootstrapWebSettings(t *testing.T) {
	r, db := setup(t)
	// 2026-09:web.allow_private / web.search_endpoint 已删除,不再下发;
	// 旧 setting 值仍存在时也必须不出现在响应里(客户端不消费)。
	if err := serverstore.SetSetting(db, "web.allow_private", "true"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, "web.search_endpoint", "https://search.example.com/q"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, "web.default_thinking_level", "high"); err != nil {
		t.Fatal(err)
	}
	u, _ := serverstore.GetUserByUsername(db, "alice")
	token, _ := serverauth.IssueToken(db, u.ID)
	_, out := getJSON(t, r, "/api/client/v2/config/bootstrap", token)
	web := out["web"].(map[string]any)
	if web["allow_private"] != nil || web["search_endpoint"] != nil {
		t.Fatalf("web = %v (allow_private/search_endpoint must be removed)", web)
	}
	if web["default_thinking_level"] != "high" {
		t.Fatalf("default_thinking_level = %v, want high", web["default_thinking_level"])
	}
}

func TestBootstrapDefaultThinkingLevelFallback(t *testing.T) {
	r, db := setup(t)
	// 未配置 + 非法值 → 回落 max
	u, _ := serverstore.GetUserByUsername(db, "alice")
	token, _ := serverauth.IssueToken(db, u.ID)
	_, out := getJSON(t, r, "/api/client/v2/config/bootstrap", token)
	web := out["web"].(map[string]any)
	if web["default_thinking_level"] != "max" {
		t.Fatalf("default default_thinking_level = %v, want max", web["default_thinking_level"])
	}
	// 非法值回落 max
	if err := serverstore.SetSetting(db, "web.default_thinking_level", "ultra"); err != nil {
		t.Fatal(err)
	}
	_, out = getJSON(t, r, "/api/client/v2/config/bootstrap", token)
	web = out["web"].(map[string]any)
	if web["default_thinking_level"] != "max" {
		t.Fatalf("invalid default_thinking_level = %v, want max fallback", web["default_thinking_level"])
	}
}

func TestHealthzNoAuth(t *testing.T) {
	r, db := setup(t)
	// 无需 token,返回 200 + ok
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/healthz", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("healthz status = %d, body=%s", w.Code, w.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	if out["ok"] != true {
		t.Fatalf("healthz body = %s", w.Body.String())
	}

	// DB 不可用 → 503
	db.Close()
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/healthz", nil))
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("healthz with closed db = %d, body=%s", w.Code, w.Body.String())
	}
}

// 严格授权:未授权用户 bootstrap 的技能建议清单为空(部门隔离)
func TestBootstrapStrictDefault(t *testing.T) {
	r, db := setup(t)
	if _, err := serverstore.CreateUserWithPassword(db, "nobody", "pw123456"); err != nil {
		t.Fatal(err)
	}
	u, _ := serverstore.GetUserByUsername(db, "nobody")
	token, _ := serverauth.IssueToken(db, u.ID)

	w, out := getJSON(t, r, "/api/client/v2/config/bootstrap", token)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	skills := out["skills"].([]any)
	if len(skills) != 0 {
		t.Fatalf("nobody skills = %v, want empty", skills)
	}
	// models remain visible to everyone
	models := out["models"].([]any)
	if len(models) != 1 {
		t.Fatalf("models = %v, want the enabled model", models)
	}
}

// TestBootstrapConnectors: 0042 连接器下发——enabled 连接器出现在
// connectors[];禁用后不再下发。0045 已把 GlitchTip 连接器下架(enabled=0),
// 因此 bootstrap 只下发 example-mcp + sales-easy, glitchtip 不在列表中
// (错误上报走独立 Sentry DSN, 不依赖连接器);定义 defaultValue 注入
// 逻辑保留,由 TestInjectGlitchTipDefaults 直接单测(重新启用场景仍可用)。
func TestBootstrapConnectors(t *testing.T) {
	r, db := setup(t)
	u, _ := serverstore.GetUserByUsername(db, "alice")
	token, _ := serverauth.IssueToken(db, u.ID)

	_, out := getJSON(t, r, "/api/client/v2/config/bootstrap", token)
	conns := out["connectors"].([]any)
	if len(conns) < 2 {
		t.Fatalf("connectors = %d, want >= 2 (种子 example-mcp+sales-easy)", len(conns))
	}
	byID := map[string]map[string]any{}
	for _, c := range conns {
		m := c.(map[string]any)
		byID[m["id"].(string)] = m
	}
	// example-mcp / sales-easy 在;glitchtip(0045 下架)不在。
	if byID["example-mcp"] == nil || byID["sales-easy"] == nil {
		t.Fatalf("enabled seeds missing: %v", byID)
	}
	if byID["glitchtip"] != nil {
		t.Fatalf("disabled glitchtip still in connectors")
	}

	// 禁用 example-mcp → 不再出现。
	if err := serverstore.SetConnectorEnabled(db, "example-mcp", false); err != nil {
		t.Fatal(err)
	}
	_, out = getJSON(t, r, "/api/client/v2/config/bootstrap", token)
	conns = out["connectors"].([]any)
	for _, c := range conns {
		m := c.(map[string]any)
		if m["id"] == "example-mcp" {
			t.Fatalf("disabled example-mcp still in connectors")
		}
	}
}

// TestInjectGlitchTipDefaults: 服务端配置的 GlitchTip 地址/组织合成进
// tokenFields 的 defaultValue(0045 下架后仍保留该注入逻辑,重新启用
// GlitchTip 连接器时客户端表单自动预填)。
func TestInjectGlitchTipDefaults(t *testing.T) {
	defJSON := `{"tokenFields":[{"key":"GLITCHTIP_BASE_URL","label":"服务地址","type":"text","required":true},{"key":"GLITCHTIP_TOKEN","label":"Token","type":"password","required":true},{"key":"GLITCHTIP_ORGANIZATION","label":"组织 slug","type":"text","required":true}],"mcp":[{"serverName":"glitchtip"}]}`

	// 空配置 → 原样返回。
	if out := injectGlitchTipDefaults(defJSON, "", ""); out != defJSON {
		t.Fatalf("no-op expected, got %s", out)
	}
	// 地址+组织 → 两个 defaultValue。
	out := injectGlitchTipDefaults(defJSON, "https://gt.example.com", "picoaide")
	for _, want := range []string{`"defaultValue":"https://gt.example.com"`, `"defaultValue":"picoaide"`} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %s in %s", want, out)
		}
	}
	// 只配地址 → 只有 BASE_URL 有 defaultValue, 组织无默认值。
	out = injectGlitchTipDefaults(defJSON, "https://gt.example.com", "")
	if !strings.Contains(out, `"defaultValue":"https://gt.example.com"`) || strings.Contains(out, `"defaultValue":"picoaide"`) {
		t.Fatalf("partial inject wrong: %s", out)
	}
	// 非法 JSON → 原样返回。
	if out := injectGlitchTipDefaults("{not json", "https://x", "y"); out != "{not json" {
		t.Fatalf("invalid json expected passthrough, got %s", out)
	}
}

// TestBootstrapDeliversHeartbeatFlag:错误上报心跳开关随 bootstrap 下发
// (2026-09-16 P1-2/D4)。
//
// 语义契约:settings 显式为 "true" 才下发 true;缺省/无值/任何其它值都是 false
// —— 默认行为必须与历史**完全一致**(零回归),否则等于悄悄给所有部署加了噪音。
func TestBootstrapDeliversHeartbeatFlag(t *testing.T) {
	r, db := setup(t)
	u, _ := serverstore.GetUserByUsername(db, "alice")
	token, _ := serverauth.IssueToken(db, u.ID)

	// 缺省:false
	_, out := getJSON(t, r, "/api/client/v2/config/bootstrap", token)
	web := out["web"].(map[string]any)
	if web["error_reporting_heartbeat"] != false {
		t.Fatalf("default error_reporting_heartbeat = %v, want false", web["error_reporting_heartbeat"])
	}

	// 显式 true → 下发 true
	if err := serverstore.SetSetting(db, "web.error_reporting_heartbeat", "true"); err != nil {
		t.Fatal(err)
	}
	_, out = getJSON(t, r, "/api/client/v2/config/bootstrap", token)
	web = out["web"].(map[string]any)
	if web["error_reporting_heartbeat"] != true {
		t.Fatalf("error_reporting_heartbeat = %v, want true", web["error_reporting_heartbeat"])
	}
	// 等级阈值语义未被心跳开关影响(红线:不改 error_reporting_level)。
	if web["error_reporting_level"] != "error" {
		t.Fatalf("error_reporting_level = %v, want error (unchanged default)", web["error_reporting_level"])
	}

	// 非 "true" 的任意值都回落 false(只有显式打开才生效)。
	if err := serverstore.SetSetting(db, "web.error_reporting_heartbeat", "1"); err != nil {
		t.Fatal(err)
	}
	_, out = getJSON(t, r, "/api/client/v2/config/bootstrap", token)
	web = out["web"].(map[string]any)
	if web["error_reporting_heartbeat"] != false {
		t.Fatalf("error_reporting_heartbeat = %v for value \"1\", want false", web["error_reporting_heartbeat"])
	}
}

// ===========================================================================
// server_version 的**用途**判据（R3-A A-13）
// ===========================================================================

// noClientConsumerMarker 是 Response.ServerVersion 文档里必须出现的那句话。
//
// 它的作用不是"钉字符串"，而是把**口径与实现的一致性**变成可执行判据：
// 这一栏曾经宣称"客户端据此发现版本错配、是唯一可见信号"，而实际零消费方 ——
// 门禁因此一直在告诉读者"这条链路是通的"（存在性断言冒充能力断言）。
// A-13 的处置是**改承诺、不造消费方**：注释改成事实，用例改成下面这三条。
const noClientConsumerMarker = "当前没有客户端消费方"

// retractedClaim 是被撤回的那句承诺的**关键词**。
//
// 只禁"断言形态"、不禁"引用形态"：文档里引用被撤回的说法（并写明它不成立）
// 是好事 —— 读者需要知道为什么撤。判据因此看的是"出现该词的那一行有没有撤回
// 语气"（见 TestServerVersionIsInformationalOnly 的 ②b），而不是简单的包含检查。
const retractedClaim = "唯一可见信号"

// retractionWords 是"这一行是在撤回/否认该说法"的语气词（任一命中即可）。
var retractionWords = []string{"曾", "撤回", "不成立", "不是事实", "已删"}

// TestServerVersionIsInformationalOnly 钉住 server_version 的**真实用途**。
//
// 三条判据（对应 A-13 的三件事）：
//  1. **线格式契约**：字段仍在、值仍是服务端构建版本 —— 删字段/改键名是跨端变更，
//     必须与客户端同批发生，不能在这一条里悄悄做（这是"不造消费方"的边界，
//     而不是"这个字段随便改"）；
//  2. **文档说的是事实**：字段的文档必须声明"当前没有客户端消费方"，且不得再出现
//     被撤回的承诺"唯一可见信号"。判据读的是**交付出去的那份注释**
//     （bootstrap.go 本身），不是测试里的副本；
//  3. **事实复核**：客户端源码里确实没有读取点 —— 注释说的是事实而不是自述。
//     扫不到扫描面（packages/ 不存在）时**直接失败**，不静默通过
//     （本仓刚修过四条"空扫描面静默通过"的守卫，这里是同一条纪律）。
func TestServerVersionIsInformationalOnly(t *testing.T) {
	// ① 线格式契约（字段仍在、值正确）。
	r, db := setup(t)
	u, _ := serverstore.GetUserByUsername(db, "alice")
	token, _ := serverauth.IssueToken(db, u.ID)
	w, out := getJSON(t, r, "/api/client/v2/config/bootstrap", token)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	if got := out["server_version"]; got != serverauth.BuildVersion() {
		t.Fatalf("server_version = %v, want %q（线格式契约：值必须是服务端构建版本）", got, serverauth.BuildVersion())
	}

	// ② 口径与实现一致：读的是 bootstrap.go 里 ServerVersion 那一栏的文档注释。
	//    文件读不到 ⇒ 直接红（不允许"扫不到就算过"）。
	src, err := os.ReadFile("bootstrap.go")
	if err != nil {
		t.Fatalf("读不到 bootstrap.go（判据的扫描面缺失，拒绝宣称一致）: %v", err)
	}
	doc := fieldDocComment(t, string(src), "ServerVersion string `json:\"server_version\"`")
	if !strings.Contains(doc, noClientConsumerMarker) {
		t.Fatalf("ServerVersion 的文档必须如实声明 %q（谁真的加了客户端消费方，就同步改口径）:\n%s",
			noClientConsumerMarker, doc)
	}
	// ②b 不得把被撤回的承诺写回**断言形态**：出现该词的那一行必须有撤回语气。
	for _, line := range strings.Split(doc, "\n") {
		if !strings.Contains(line, retractedClaim) {
			continue
		}
		retracted := false
		for _, w := range retractionWords {
			if strings.Contains(line, w) {
				retracted = true
				break
			}
		}
		if !retracted {
			t.Fatalf("ServerVersion 的文档把被撤回的承诺写回了断言形态（客户端零消费方，这不是事实）:\n%s", line)
		}
	}

	// ③ 事实复核：客户端源码里没有 server_version / serverVersion 读取点。
	if hits := scanClientSources(t); len(hits) > 0 {
		t.Fatalf("客户端源码里出现了 server_version 的消费方 %v —— "+
			"口径必须同步（若已真的接上，请把文档里的 %q 改成事实描述，并让本条判据跟上）",
			hits, noClientConsumerMarker)
	}
}

// fieldDocComment 取出结构体字段声明行**紧邻上方**的连续 `//` 注释块。
//
// 用于把"注释即契约"变成可执行判据：判据读的是交付文件本身，不是测试里的副本。
func fieldDocComment(t *testing.T, src, decl string) string {
	t.Helper()
	lines := strings.Split(src, "\n")
	idx := -1
	for i, ln := range lines {
		if strings.Contains(ln, decl) {
			idx = i
			break
		}
	}
	if idx < 0 {
		t.Fatalf("在源文件里找不到字段声明 %q（字段被改名/删除？）", decl)
	}
	var block []string
	for i := idx - 1; i >= 0; i-- {
		trimmed := strings.TrimSpace(lines[i])
		if !strings.HasPrefix(trimmed, "//") {
			break
		}
		block = append([]string{trimmed}, block...)
	}
	if len(block) == 0 {
		t.Fatalf("字段 %q 上方没有任何文档注释（口径无从判据）", decl)
	}
	return strings.Join(block, "\n")
}

// scanClientSources 扫客户端源码里的 server_version / serverVersion 读取点。
//
// 扫描面 = 仓库根的 `packages/**` 源码（.ts/.tsx/.js/.mjs/.cjs），排除
// node_modules / lib / dist / build（第三方 SDK 与构建产物里出现同名字符串
// 不构成本产品的消费方 —— 例如 @modelcontextprotocol/sdk 内部有自己的
// `_serverVersion`，那是 MCP 协议字段，与本字段无关）。
//
// packages/ 不存在 ⇒ 直接 t.Fatalf：扫描面缺失不得静默通过。
func scanClientSources(t *testing.T) []string {
	t.Helper()
	root := filepath.Join("..", "..", "..", "packages")
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		t.Fatalf("客户端源码根 %s 不存在（判据的扫描面缺失，拒绝宣称「没有消费方」）: %v", root, err)
	}
	skip := map[string]bool{"node_modules": true, "lib": true, "dist": true, "build": true, ".git": true}
	exts := map[string]bool{".ts": true, ".tsx": true, ".js": true, ".mjs": true, ".cjs": true}
	var hits []string
	err = filepath.WalkDir(root, func(path string, d os.DirEntry, werr error) error {
		if werr != nil {
			return werr
		}
		if d.IsDir() {
			if skip[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if !exts[strings.ToLower(filepath.Ext(path))] {
			return nil
		}
		raw, rerr := os.ReadFile(path)
		if rerr != nil {
			return rerr
		}
		if bytes.Contains(raw, []byte("server_version")) || bytes.Contains(raw, []byte("serverVersion")) {
			hits = append(hits, path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("扫描客户端源码失败: %v", err)
	}
	return hits
}
