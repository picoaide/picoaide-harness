package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/appcfg"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// ===========================================================================
// §10.5 发布链路逐条用例（编号即设计文档第 52–60 项）
// ===========================================================================

// TestPublishHappyPath 覆盖"发布成功"的全部可观察后果：库行、生效版本、资源
// 目录、配置投影、审计、响应字段。
func TestPublishHappyPath(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	// 真自定义段：index.html 是资源，go:buildid 是工具链元数据（必须被忽略）。
	mod := withCustomSections(t, guest, map[string][]byte{
		"index.html": []byte("<html>hi</html>"),
		"go:buildid": []byte("fake-build-id"),
	})

	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/demo-tool/releases", e.tokens["alice"],
		e.payload("demo-tool", "1.0.0", mod, goodConfig()))
	var out struct {
		App struct {
			AppID       string `json:"app_id"`
			Title       string `json:"title"`
			Description string `json:"description"`
			Enabled     bool   `json:"enabled"`
			Owner       string `json:"owner"`
			Version     string `json:"version"`
		} `json:"app"`
		Release struct {
			ID              int64    `json:"id"`
			Version         string   `json:"version"`
			Status          string   `json:"status"`
			Current         bool     `json:"current"`
			Checksum        string   `json:"checksum"`
			Size            int64    `json:"size"`
			Assets          []string `json:"assets"`
			IgnoredSections []string `json:"ignored_sections"`
			CompileMS       int64    `json:"compile_ms"`
			CompileCached   bool     `json:"compile_cached"`
		} `json:"release"`
		ReviewRequired bool `json:"review_required"`
	}
	e.decodeJSON(w, http.StatusCreated, &out)

	if out.Release.Status != serverstore.ReleaseStatusApproved || !out.Release.Current {
		t.Fatalf("首发应直接生效: status=%s current=%v", out.Release.Status, out.Release.Current)
	}
	if out.Release.ID <= 0 || out.Release.Size != int64(len(mod)) || out.Release.Checksum == "" {
		t.Fatalf("release 字段不完整: %+v", out.Release)
	}
	if out.App.Owner != "alice" || !out.App.Enabled || out.App.Version != "1.0.0" {
		t.Fatalf("app 字段不对: %+v", out.App)
	}
	// ⚠️ 发布响应**不再有** `entry_url`（W4 删除；总纲 §8.4/§5.2）：应用只在桌面客户端内
	// 以 `<渠道 app scheme>://<app_id>` 打开，入口链接由客户端自行构造。这里断言它
	// 确实不在响应里 —— 只删服务端 emit 而客户端仍在读的形态会被这条挡住。
	if raw, err := json.Marshal(out.App); err != nil {
		t.Fatalf("序列化 app 失败: %v", err)
	} else if strings.Contains(string(raw), "entry_url") {
		t.Fatalf("发布响应不得再出现 entry_url: %s", raw)
	}
	if out.ReviewRequired {
		t.Fatal("审核开关缺省必须是关（R17）")
	}
	if len(out.Release.Assets) != 1 || out.Release.Assets[0] != "index.html" {
		t.Fatalf("静态资源抽取不对: %v", out.Release.Assets)
	}
	// Go 的工具链元数据段（go:buildid / name / producers）必须被忽略并报告，
	// 不能落成资源文件（`name` 是 73 KiB 的符号表：落下去只会浪费配额）。
	if !contains(out.Release.IgnoredSections, "go:buildid") || !contains(out.Release.IgnoredSections, "name") {
		t.Fatalf("工具链元数据段应被忽略并报告: %v", out.Release.IgnoredSections)
	}

	// 库：apps 行 + 生效版本指针；app_releases 行状态 approved。
	t.Logf("compile=%vms cached=%v", out.Release.CompileMS, out.Release.CompileCached)
	app, err := serverstore.GetWasmApp(t.Context(), e.db, "demo-tool")
	if err != nil {
		t.Fatalf("读应用失败: %v", err)
	}
	if app.Owner != "alice" || app.Channel != serverstore.AppChannelWasm || !app.Enabled {
		t.Fatalf("apps 行不对: %+v", app)
	}
	if app.CurrentReleaseID != out.Release.ID {
		t.Fatalf("current_release_id = %d, want %d", app.CurrentReleaseID, out.Release.ID)
	}
	// ⚠️ 2026-09-18：可见性投影列已删（0071）。访问模式从 config_json 现解。
	if got := appcfg.AccessOfConfigJSON(app.ConfigJSON); got != appcfg.AccessLogin {
		t.Fatalf("access 投影 = %q, want %q（发布时写的 access=public 必须落进 config_json）", got, appcfg.AccessLogin)
	}
	if !app.Enabled {
		t.Fatal("新建应用即上架（enabled 独立于访问模式）")
	}
	rel, err := serverstore.GetWasmRelease(t.Context(), e.db, "demo-tool", "1.0.0")
	if err != nil {
		t.Fatalf("读版本失败: %v", err)
	}
	if rel.Status != serverstore.ReleaseStatusApproved || rel.Publisher != "alice" {
		t.Fatalf("release 行不对: %+v", rel)
	}
	// assets_dir 列有意留空：它是"资源抽取到磁盘"时代的遗留列 —— 2026-09-20 起随包
	// 资源从 wasm 自定义段在内存里构造（决策文档
	// docs/decisions/2026-09-20-wasm-assets-in-memory.md），磁盘上没有按版本的资源目录。
	if rel.AssetsDir != "" {
		t.Fatalf("assets_dir 应留空（资源不再落盘）：%q", rel.AssetsDir)
	}

	// 应用自己读到的那份配置（宿主注入内存资源集的 picoaide.app.json）= **库内**版本行
	// 的 config_json。资源不落盘以后这是唯一权威副本，所以断言改在这里。
	var cfg appcfg.Config
	if jerr := json.Unmarshal([]byte(rel.ConfigJSON), &cfg); jerr != nil {
		t.Fatalf("版本行 config_json 不是合法 JSON: %v", jerr)
	}
	if cfg.Owner != "张伟" || cfg.Purpose == "" || cfg.DataSensitivity != "internal" {
		t.Fatalf("版本行配置内容不对: %+v", cfg)
	}
	// 负向判据（2026-09-20 定案）：发布成功后 <data_root>/apps/<app_id>/ 下**不得**
	// 出现 assets/ 目录 —— 整条发布链路只写数据库。
	// 变异验证：把 staging + rename 落盘代码加回发布链路，这条立刻变红。
	assertNoAssetsDir(t, e.dataRoot, "demo-tool")

	// 审计：发布成功留痕，且带 app 维度（0069）。
	actions := e.auditActions("demo-tool")
	if !contains(actions, "wasm_app_release") {
		t.Fatalf("发布成功应写审计: %v", actions)
	}
	logs, _ := serverstore.ListAuditLogsByApp(e.db, "demo-tool", 50)
	found := false
	for _, l := range logs {
		if l.Action == "wasm_app_release" && l.AppID == "demo-tool" && strings.Contains(l.Detail, "v1.0.0") {
			found = true
		}
	}
	if !found {
		t.Fatal("审计明细应含版本号且带 app_id 列")
	}

	// 第二个版本：生效版本切换 + 保留策略（只有 2 版，不该有回收）。
	rel2 := e.publishOK(e.tokens["alice"], "demo-tool", "1.1.0", guest, goodConfig())
	if rel2["current"] != true {
		t.Fatalf("第二版应生效: %+v", rel2)
	}
	app2, _ := serverstore.GetWasmApp(t.Context(), e.db, "demo-tool")
	if app2.CurrentReleaseID != int64(rel2["id"].(float64)) {
		t.Fatalf("生效版本未切换: %+v", app2)
	}

	// 访问模式变更必须留痕（独立审计 2026-09-18 P2-5 补的回归网）：
	// `wasm_app_access_change` 此前没有任何用例咬住 —— 实现是对的，但删掉它
	// 不会有任何测试变红（本仓纪律：安全/审计行为的"正确"必须能被变异证明）。
	// 这里在同一个应用上连发三版：改访问模式 ⇒ 有；不改 ⇒ 没有。
	accessActions := func(appID string) []string {
		var out []string
		logs, aerr := serverstore.ListAuditLogsByApp(e.db, appID, 500)
		if aerr != nil {
			t.Fatalf("读审计失败: %v", aerr)
		}
		for _, l := range logs {
			if l.Action == "wasm_app_access_change" {
				out = append(out, l.Detail)
			}
		}
		return out
	}
	// demo-tool 此时已发过 v1.0.0 与 v1.1.0，两版都是 access=login ⇒ 零变更记录。
	if got := accessActions("demo-tool"); len(got) != 0 {
		t.Fatalf("访问模式没变不该写 wasm_app_access_change: %v", got)
	}
	// v1.2.0 改成 whitelist（名单非空）⇒ 应记一条，且明细带旧值→新值。
	gatedCfg := goodConfig()
	gatedCfg["access"] = "whitelist"
	gatedCfg["whitelist"] = []string{"alice"}
	e.publishOK(e.tokens["alice"], "demo-tool", "1.2.0", guest, gatedCfg)
	got := accessActions("demo-tool")
	if len(got) != 1 {
		t.Fatalf("访问模式 login→whitelist 应恰好记一条 wasm_app_access_change，得到 %v", got)
	}
	if !strings.Contains(got[0], "login") || !strings.Contains(got[0], "whitelist") || !strings.Contains(got[0], "1.2.0") {
		t.Fatalf("访问模式变更明细应含 旧值→新值 与版本号，得到 %q", got[0])
	}
	// v1.3.0 从 whitelist 改回 login（名单清空）⇒ 再记一条。
	e.publishOK(e.tokens["alice"], "demo-tool", "1.3.0", guest, goodConfig())
	if got := accessActions("demo-tool"); len(got) != 2 {
		t.Fatalf("再改一次应记第二条，得到 %v", got)
	}

}

// TestValidateDoesNotWriteAnything 是 §4.2 的硬要求：validate **不落版本号、
// 不进审计**（它是纯预检，可以随便重试）。
func TestValidateDoesNotWriteAnything(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	before := e.countAudit()

	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/validate", e.tokens["alice"],
		e.payload("preflight", "1.0.0", guest, goodConfig()))
	var out struct {
		Validation struct {
			AppID    string `json:"app_id"`
			OK       bool   `json:"ok"`
			Checksum string `json:"checksum"`
			DryRun   string `json:"dry_run"`
			Imports  []struct {
				Module string `json:"module"`
				Name   string `json:"name"`
			} `json:"imports"`
			FirstRelease bool     `json:"first_release"`
			Assets       []string `json:"assets"`
		} `json:"validation"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	if !out.Validation.OK || out.Validation.DryRun != "ok" {
		t.Fatalf("预检应通过: %+v", out.Validation)
	}
	if !out.Validation.FirstRelease {
		t.Fatal("尚无版本行 ⇒ first_release 应为 true")
	}
	hasFDRead := false
	for _, im := range out.Validation.Imports {
		if im.Module == limits.WasmImportModule && im.Name == "fd_read" {
			hasFDRead = true
		}
	}
	if !hasFDRead {
		t.Fatal("导入面应含 fd_read（ABI 读 stdin 需要）")
	}

	if n := e.countReleases("preflight"); n != 0 {
		t.Fatalf("validate 不得落版本行，实际 %d 行", n)
	}
	if _, err := serverstore.GetWasmApp(t.Context(), e.db, "preflight"); err == nil {
		t.Fatal("validate 不得建应用行")
	}
	if after := e.countAudit(); after != before {
		t.Fatalf("validate 不得进审计：before=%d after=%d", before, after)
	}
}

// TestAppIDRules 覆盖 §10.5 第 52/53/53b 项（app_id 的形态与保留字）。
func TestAppIDRules(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	cases := []struct {
		name  string
		appID string
	}{
		{"大写", "My-App"},
		{"下划线", "my_app"},
		{"连续连字符", "my--app"},
		{"首连字符", "-myapp"},
		{"尾连字符", "myapp-"},
		{"超长", strings.Repeat("a", limits.MaxAppIDLen+1)},
		{"纯数字", "12345"},
		{"punycode 前缀", "xn--abc"},
		{"保留字", "www"},
		{"保留字 acme", "_acme-challenge"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/validate", e.tokens["alice"],
				e.payload(tc.appID, "1.0.0", guest, goodConfig()))
			eb := e.decodeErr(w, http.StatusBadRequest)
			if eb.Error.Code != string("INVALID_APP_ID") {
				t.Fatalf("code = %s, want INVALID_APP_ID; body=%s", eb.Error.Code, w.Body.String())
			}
			if len(eb.Error.Hints) == 0 {
				t.Fatal("INVALID_APP_ID 必须带可操作 hints（第一消费者是 AI）")
			}
		})
	}
}

// TestAppIDExtraReservedInjected 覆盖 §4.1 的"部署期注入企业已知主机名"。
func TestAppIDExtraReservedInjected(t *testing.T) {
	e := newTestEnv(t, func(o *Options) { o.AppIDExtraReserved = []string{"legacy-portal"} })
	guest := testGuestModule(t)
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/validate", e.tokens["alice"],
		e.payload("legacy-portal", "1.0.0", guest, goodConfig()))
	eb := e.decodeErr(w, http.StatusBadRequest)
	if !strings.Contains(eb.Error.Message, "企业既有主机名") {
		t.Fatalf("注入的保留名应被拒: %s", w.Body.String())
	}
}

// TestPublishNameTakenByOtherOwner 覆盖 §10.5 第 53c/60 项（owner 检查 / 名称占用）。
//
// 语义与 appstore.Publish 逐字一致：409 NAME_TAKEN + "名称已被占用，无法上传…"
// （2026-09-02 用户拍板的"明确告知占用关系、但不泄露是谁/什么内容"）。
func TestPublishNameTakenByOtherOwner(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	e.publishOK(e.tokens["alice"], "shared-tool", "1.0.0", guest, goodConfig())
	// 非首版的 app 也需要 changelog（这里是 alice 的 v2，先证明"自己的应用能发新版"）。
	if _, err := serverstore.GetWasmApp(t.Context(), e.db, "shared-tool"); err != nil {
		t.Fatalf("前置条件失败: %v", err)
	}

	// 员工 B 更新员工 A 的应用 ⇒ 拒（§10.5 第 60 项）。
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/shared-tool/releases", e.tokens["bob"],
		e.payload("shared-tool", "2.0.0", guest, goodConfig()))
	eb := e.decodeErr(w, http.StatusConflict)
	if eb.Error.Code != "NAME_TAKEN" {
		t.Fatalf("code = %s, want NAME_TAKEN", eb.Error.Code)
	}
	if !strings.Contains(eb.Error.Message, "名称已被占用") {
		t.Fatalf("文案应与 appstore.Publish 一致: %s", eb.Error.Message)
	}
	if !strings.Contains(eb.Error.Message, "不属于你") && !strings.Contains(eb.Error.Message, "联系管理员") {
		t.Fatalf("应给出可行动的出路: %s", eb.Error.Message)
	}
	// 被拒的发布不落行（R18）。
	if n := e.countReleases("shared-tool"); n != 1 {
		t.Fatalf("被拒的发布不得落行，实际 %d 行", n)
	}
	// 归属不可改写（首占）。
	app, _ := serverstore.GetWasmApp(t.Context(), e.db, "shared-tool")
	if app.Owner != "alice" {
		t.Fatalf("归属被改写: %s", app.Owner)
	}
	if !contains(e.auditActions("shared-tool"), "wasm_app_release_denied") {
		t.Fatalf("被拒也要留痕: %v", e.auditActions("shared-tool"))
	}

	// 平台管理员可兜底接管（R23），但**不改写归属**（DA 层的 COALESCE 守卫）。
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/shared-tool/releases", e.tokens["boss"],
		e.payload("shared-tool", "2.0.0", guest, goodConfig()))
	if w.Code != http.StatusCreated {
		t.Fatalf("管理员应能发布他人应用: %d %s", w.Code, w.Body.String())
	}
	app, _ = serverstore.GetWasmApp(t.Context(), e.db, "shared-tool")
	if app.Owner != "alice" {
		t.Fatalf("管理员发布不得改写归属: %s", app.Owner)
	}
}

// TestPublishVersionRules 覆盖 §10.5 第 54 项（版本号形态与严格递增）。
func TestPublishVersionRules(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)

	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/ver-tool/releases", e.tokens["alice"],
		e.payload("ver-tool", "1.0", guest, goodConfig()))
	eb := e.decodeErr(w, http.StatusBadRequest)
	if eb.Error.Code != "VERSION_INVALID" {
		t.Fatalf("非 x.y.z 应拒: %s", w.Body.String())
	}

	e.publishOK(e.tokens["alice"], "ver-tool", "1.0.0", guest, goodConfig())
	for _, bad := range []string{"1.0.0", "0.9.9"} {
		p := e.payload("ver-tool", bad, guest, goodConfig())
		p["changelog"] = "改了点什么"
		w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/ver-tool/releases", e.tokens["alice"], p)
		eb := e.decodeErr(w, http.StatusBadRequest)
		if eb.Error.Code != "VERSION_NOT_NEWER" {
			t.Fatalf("版本 %s 应拒（不是严格递增）: %s", bad, w.Body.String())
		}
	}
	// 版本号一经落行永久占位：失败尝试不改变库里的版本集合。
	if n := e.countReleases("ver-tool"); n != 1 {
		t.Fatalf("版本行数 = %d, want 1", n)
	}
}

// TestPublishNonFirstRequiresChangelog 覆盖 §10.5 第 55 项。
func TestPublishNonFirstRequiresChangelog(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	e.publishOK(e.tokens["alice"], "log-tool", "1.0.0", guest, goodConfig())

	p := e.payload("log-tool", "1.0.1", guest, goodConfig())
	p["changelog"] = "   "
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/log-tool/releases", e.tokens["alice"], p)
	eb := e.decodeErr(w, http.StatusUnprocessableEntity)
	if eb.Error.Code != "MISSING_FIELD" {
		t.Fatalf("code = %s, want MISSING_FIELD", eb.Error.Code)
	}
	if eb.Error.Details["field"] != "changelog" {
		t.Fatalf("details.field 应指出 changelog: %v", eb.Error.Details)
	}
	// 首版不要求 changelog。
	p2 := e.payload("log-tool-2", "1.0.0", guest, goodConfig())
	p2["changelog"] = ""
	if w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/log-tool-2/releases", e.tokens["alice"], p2); w.Code != http.StatusCreated {
		t.Fatalf("首版不要求 changelog: %d %s", w.Code, w.Body.String())
	}
}

// TestUploadBodyLimits 覆盖 §10.5 第 56/57 项：两档体积都要**有指向性**地拒，
// 不得退化成无指向的 400。
func TestUploadBodyLimits(t *testing.T) {
	e := newTestEnv(t)
	// 第 56 项：33 MiB wasm（base64 ≈ 44 MiB）由**应用层**拒（32 MiB 上限）。
	wasm33 := make([]byte, 33<<20)
	body56 := fmt.Sprintf(`{"app_id":"big-tool","version":"1.0.0","title":"x","wasm_base64":"%s"}`,
		b64(wasm33))
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/big-tool/releases", e.tokens["alice"], body56)
	eb := e.decodeErr(w, http.StatusRequestEntityTooLarge)
	if eb.Error.Code != "WASM_TOO_LARGE" {
		t.Fatalf("code = %s, want WASM_TOO_LARGE（33 MiB 应被应用层按 32 MiB 上限拒）", eb.Error.Code)
	}
	if !strings.Contains(eb.Error.Message, "32.0 MiB") {
		t.Fatalf("文案必须指出上限数值: %s", eb.Error.Message)
	}
	if len(eb.Error.Hints) == 0 {
		t.Fatal("必须给可操作提示（压缩/去符号/子集化字体）")
	}
	if got := eb.Error.Details["max_wasm_bytes"]; got == nil {
		t.Fatalf("details 应带上限: %v", eb.Error.Details)
	}
	if n := e.countReleases("big-tool"); n != 0 {
		t.Fatalf("超限上传不得落行: %d", n)
	}
	wasm33 = nil

	// 第 57 项：40 MiB wasm（base64 ≈ 53 MiB）触 48 MiB 请求体上限。
	wasm40 := make([]byte, 40<<20)
	body57 := fmt.Sprintf(`{"app_id":"huge-tool","version":"1.0.0","title":"x","wasm_base64":"%s"}`,
		b64(wasm40))
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/huge-tool/releases", e.tokens["alice"], body57)
	eb = e.decodeErr(w, http.StatusRequestEntityTooLarge)
	if eb.Error.Code != "BODY_TOO_LARGE" {
		t.Fatalf("code = %s, want BODY_TOO_LARGE（40 MiB 应触 48 MiB 请求体上限）", eb.Error.Code)
	}
	if len(eb.Error.Hints) == 0 || !strings.Contains(eb.Error.Message, "48.0 MiB") {
		t.Fatalf("文案必须指出请求体上限: %s %v", eb.Error.Message, eb.Error.Hints)
	}
	// 关键：不得退化成"JSON 解析失败"的 400（§10.5 第 57 项原话）。
	if w.Code == http.StatusBadRequest {
		t.Fatal("40 MiB 上传不得退化成无指向的 400")
	}
	wasm40 = nil
}

// TestPublishConfigRules 覆盖 §10.5 第 56b/56c/56d/56e 项。
func TestPublishConfigRules(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)

	post := func(appID string, cfg map[string]any, mutate func(map[string]any)) *httptest.ResponseRecorder {
		p := e.payload(appID, "1.0.0", guest, cfg)
		if mutate != nil {
			mutate(p)
		}
		return e.req(http.MethodPost, "/api/client/v2/apps/wasm/"+appID+"/releases", e.tokens["alice"], p)
	}

	t.Run("56b 缺失", func(t *testing.T) {
		p := e.payload("cfg-missing", "1.0.0", guest, goodConfig())
		delete(p, "config")
		w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/cfg-missing/releases", e.tokens["alice"], p)
		eb := e.decodeErr(w, http.StatusUnprocessableEntity)
		if eb.Error.Code != "APP_CONFIG_INVALID" {
			t.Fatalf("code = %s, want APP_CONFIG_INVALID", eb.Error.Code)
		}
	})
	t.Run("56b 未知字段", func(t *testing.T) {
		cfg := goodConfig()
		cfg["visable"] = true // 拼错
		eb := e.decodeErr(post("cfg-typo", cfg, nil), http.StatusUnprocessableEntity)
		if eb.Error.Code != "APP_CONFIG_INVALID" || eb.Error.Details["field"] != "visable" {
			t.Fatalf("应指名拼错的字段: %+v", eb.Error)
		}
	})
	t.Run("56b access 取值非法", func(t *testing.T) {
		cfg := goodConfig()
		cfg["access"] = "everyone" // 三取值之外
		eb := e.decodeErr(post("cfg-access", cfg, nil), http.StatusUnprocessableEntity)
		if eb.Error.Code != "APP_CONFIG_INVALID" || eb.Error.Details["field"] != "access" {
			t.Fatalf("应点名 access 字段: %+v", eb.Error)
		}
		// 报错必须把**可写**合法值都列出来（作者照抄即可改对；历史 public 不在其中）。
		joined := strings.Join(eb.Error.Hints, " ")
		for _, v := range appcfg.AccessWritableValues {
			if !strings.Contains(joined, v) {
				t.Fatalf("access 报错应列出合法值 %q: %v", v, eb.Error.Hints)
			}
		}
	})
	t.Run("56b 类型越界", func(t *testing.T) {
		cfg := goodConfig()
		cfg["access"] = true // 布尔不是字符串
		eb := e.decodeErr(post("cfg-type", cfg, nil), http.StatusUnprocessableEntity)
		if eb.Error.Code != "APP_CONFIG_INVALID" {
			t.Fatalf("code = %s", eb.Error.Code)
		}
	})
	t.Run("56b 旧字段类型非法仍拒（兼容 shim 不做类型放松）", func(t *testing.T) {
		cfg := goodConfig()
		cfg["login_required"] = "true" // 字符串不是布尔
		eb := e.decodeErr(post("cfg-legacy-type", cfg, nil), http.StatusUnprocessableEntity)
		if eb.Error.Code != "APP_CONFIG_INVALID" {
			t.Fatalf("code = %s", eb.Error.Code)
		}
	})
	t.Run("56c access=whitelist 且白名单为空 ⇒ 拒", func(t *testing.T) {
		cfg := goodConfig()
		cfg["access"] = "whitelist"
		cfg["whitelist"] = []string{}
		eb := e.decodeErr(post("cfg-whitelist", cfg, nil), http.StatusUnprocessableEntity)
		if eb.Error.Code != "APP_CONFIG_INVALID" {
			t.Fatalf("code = %s, want APP_CONFIG_INVALID（否则应用对所有人不可用）", eb.Error.Code)
		}
		hints := strings.Join(eb.Error.Hints, " ")
		if !strings.Contains(hints, "login") {
			t.Fatalf("提示必须给出「改 access=login」这条出路: %v", eb.Error.Hints)
		}
	})
	// ⚠️ 2026-09-18 用户拍板：旧规则「login_required=true 且 whitelist 为空 ⇒ 拒」废止 ——
	// "登录后全员可用"是正式模式，这条回归防止它被悄悄加回来。
	t.Run("56c login + 空名单 ⇒ 允许发布（登录后全员）", func(t *testing.T) {
		cfg := goodConfig()
		cfg["access"] = "login"
		cfg["whitelist"] = []string{}
		w := post("cfg-login-empty", cfg, nil)
		if w.Code != http.StatusCreated {
			t.Fatalf("access=login 且无名单必须允许发布（登录后全员可用）: %d %s", w.Code, w.Body.String())
		}
		app, err := serverstore.GetWasmApp(t.Context(), e.db, "cfg-login-empty")
		if err != nil || appcfg.AccessOfConfigJSON(app.ConfigJSON) != appcfg.AccessLogin {
			t.Fatalf("access 应投影成 login: %+v %v", app, err)
		}
	})
	t.Run("56d 白名单含不存在的账号仍可发布", func(t *testing.T) {
		cfg := goodConfig()
		cfg["access"] = "whitelist"
		cfg["whitelist"] = []string{"ghost-user-does-not-exist"}
		w := post("cfg-ghost", cfg, nil)
		if w.Code != http.StatusCreated {
			t.Fatalf("平台不校验账号是否存在（避免账号枚举）: %d %s", w.Code, w.Body.String())
		}
	})
	// 56e（2026-09-18 变更）：**不再有 visible 过滤** —— whitelist / login / 已下架
	// 的应用都照旧进目录，条目里给出 access 与 enabled。
	t.Run("56e 访问模式与下架状态都进目录，条目带 access/enabled", func(t *testing.T) {
		cfg := goodConfig()
		cfg["access"] = "whitelist"
		cfg["whitelist"] = []string{"alice"}
		if w := post("cfg-whitelist-listed", cfg, nil); w.Code != http.StatusCreated {
			t.Fatalf("access=whitelist 应允许发布: %d %s", w.Code, w.Body.String())
		}
		loginCfg := goodConfig()
		loginCfg["access"] = "login"
		if w := post("cfg-login-listed", loginCfg, nil); w.Code != http.StatusCreated {
			t.Fatalf("access=login 应允许发布: %d %s", w.Code, w.Body.String())
		}
		if w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/cfg-login-listed/unpublish", e.tokens["alice"], nil); w.Code != http.StatusOK {
			t.Fatalf("下架失败: %s", w.Body.String())
		}
		var cat struct {
			Apps []map[string]any `json:"apps"`
		}
		e.decodeJSON(e.req(http.MethodGet, "/api/client/v2/apps/wasm/catalog", e.tokens["bob"], nil), http.StatusOK, &cat)
		seen := map[string]map[string]any{}
		for _, a := range cat.Apps {
			seen[a["app_id"].(string)] = a
		}
		for id, wantAccess := range map[string]string{
			"cfg-whitelist-listed": "whitelist",
			"cfg-login-listed":     "login",
		} {
			row, ok := seen[id]
			if !ok {
				t.Fatalf("%s 必须出现在应用中心（目录不再按访问级别/上架态过滤）: %v", id, seen)
			}
			if row["access"] != wantAccess {
				t.Fatalf("%s 的 access = %v, want %q", id, row["access"], wantAccess)
			}
			if _, ok := row["visible"]; ok {
				t.Fatalf("目录行不得再有 visible 字段（R38 作废）: %+v", row)
			}
			if _, ok := row["enabled"]; !ok {
				t.Fatalf("目录行必须给出 enabled（UI 要标「已下架」）: %+v", row)
			}
		}
		if seen["cfg-login-listed"]["enabled"] != false {
			t.Fatalf("已下架的应用应带 enabled=false: %+v", seen["cfg-login-listed"])
		}
	})
	// 兼容 shim：**旧 schema 的载荷仍能发布**，且落库/下发写出的都是新 schema
	//（"重新发布后写出的就是新 schema"，迁移 0071 负责改写库里的存量行）。
	t.Run("旧 schema 载荷仍可发布，落库即新 schema", func(t *testing.T) {
		legacy := map[string]any{
			"visible":          true,
			"login_required":   true,
			"whitelist":        []string{"alice"},
			"purpose":          "旧 schema 载荷",
			"data_sensitivity": "internal",
			"owner":            "张伟",
		}
		w := post("cfg-legacy", legacy, nil)
		if w.Code != http.StatusCreated {
			t.Fatalf("旧 schema 载荷必须仍能发布（兼容 shim）: %d %s", w.Code, w.Body.String())
		}
		app, err := serverstore.GetWasmApp(t.Context(), e.db, "cfg-legacy")
		if err != nil {
			t.Fatalf("读应用: %v", err)
		}
		var stored map[string]any
		if err := json.Unmarshal([]byte(app.ConfigJSON), &stored); err != nil {
			t.Fatalf("落库的 config_json 不是合法 JSON: %q", app.ConfigJSON)
		}
		if stored["access"] != "whitelist" {
			t.Fatalf("旧 login_required=true + 名单非空 应映射成 whitelist: %v", stored)
		}
		for _, legacyKey := range []string{"visible", "login_required"} {
			if _, ok := stored[legacyKey]; ok {
				t.Fatalf("落库必须是新 schema，不得保留旧键 %q: %v", legacyKey, stored)
			}
		}
	})
}

// TestPublishCompileFailureDoesNotOccupyVersion 覆盖 §10.5 第 59 项（R18）：
// 编译失败的发布**不落行**，因此同一个版本号可以原样重发并成功。
func TestPublishCompileFailureDoesNotOccupyVersion(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)

	broken := append([]byte{}, guest...)
	copy(broken[:4], []byte{0x00, 0x61, 0x73, 0x00}) // 魔数坏掉：连静态校验都过不去

	p := e.payload("retry-tool", "1.0.0", broken, goodConfig())
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/retry-tool/releases", e.tokens["alice"], p)
	if w.Code == http.StatusCreated {
		t.Fatal("坏模块不得发布成功")
	}
	eb := e.decodeErr(w, w.Code)
	if eb.Error.Code == "" || len(eb.Error.Hints) == 0 {
		t.Fatalf("失败必须结构化且带 hints: %s", w.Body.String())
	}
	if n := e.countReleases("retry-tool"); n != 0 {
		t.Fatalf("失败的发布不得落行（R18），实际 %d 行", n)
	}
	if !contains(e.auditActions("retry-tool"), "wasm_app_release_failed") {
		t.Fatalf("失败也要留痕: %v", e.auditActions("retry-tool"))
	}

	// 同一版本号原样重发 ⇒ 成功（版本号没被占用）。
	if rel := e.publishOK(e.tokens["alice"], "retry-tool", "1.0.0", guest, goodConfig()); rel["status"] != serverstore.ReleaseStatusApproved {
		t.Fatalf("重发应成功并生效: %+v", rel)
	}
}

// TestUploadRateGate429IsPointed 覆盖上传闸门（§4.3：每用户 30 次/小时 +
// 同时最多 1 次编译中）：第 31 次必须 429，且带 Retry-After 与可读原因。
func TestUploadRateGate429IsPointed(t *testing.T) {
	e := newTestEnv(t)
	broken := []byte("not a wasm module at all")
	for i := 0; i < limits.UploadRatePerHour; i++ {
		p := e.payload("rate-tool", "1.0.0", broken, goodConfig())
		w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/validate", e.tokens["alice"], p)
		if w.Code == http.StatusTooManyRequests {
			t.Fatalf("第 %d 次就被限流（上限应为 %d）: %s", i+1, limits.UploadRatePerHour, w.Body.String())
		}
	}
	p := e.payload("rate-tool", "1.0.0", broken, goodConfig())
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/validate", e.tokens["alice"], p)
	eb := e.decodeErr(w, http.StatusTooManyRequests)
	if eb.Error.Code != "RATE_LIMITED" {
		t.Fatalf("code = %s, want RATE_LIMITED", eb.Error.Code)
	}
	if w.Header().Get("Retry-After") == "" {
		t.Fatal("429 必须带 Retry-After（§4.6）")
	}
	if got := eb.Error.Details["limit_per_hour"]; got != float64(limits.UploadRatePerHour) {
		t.Fatalf("details.limit_per_hour = %v, want %d", got, limits.UploadRatePerHour)
	}
	// 另一个用户不受影响（限流是**每用户**的）。
	if w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/validate", e.tokens["bob"],
		e.payload("rate-tool", "1.0.0", broken, goodConfig())); w.Code == http.StatusTooManyRequests {
		t.Fatalf("限流不该影响其他用户: %s", w.Body.String())
	}
}

// TestUploadSlotReleasedOnFailure 是"defer ReleaseUpload"的判据：失败路径也必须
// 释放并发占位，否则一次编译失败就把用户永久卡在"同时 1 次编译中"上。
func TestUploadSlotReleasedOnFailure(t *testing.T) {
	e := newTestEnv(t)
	broken := []byte("not a wasm module at all")
	for i := 0; i < 3; i++ {
		p := e.payload("slot-tool", "1.0.0", broken, goodConfig())
		w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/validate", e.tokens["alice"], p)
		eb := e.decodeErr(w, w.Code)
		if eb.Error.Code == "RATE_LIMITED" || eb.Error.Code == "COMPILE_BUSY" {
			t.Fatalf("第 %d 次请求被并发/频率闸门拦下（占位未释放？）: %s", i+1, w.Body.String())
		}
	}
	// 并发占位（inflight）应回到 0。
	if _, inflight := e.compiler.UploadState(e.ids["alice"], time.Now()); inflight != 0 {
		t.Fatalf("inflight = %d, want 0（失败路径必须释放）", inflight)
	}
}

// TestArtifactQuotaRejected 覆盖每用户制品配额（§5.3：1 GiB）。
// used 通过 Options.ArtifactUsed 注入 —— 否则要把 1 GiB 字节真的灌进测试库。
func TestArtifactQuotaRejected(t *testing.T) {
	e := newTestEnv(t, func(o *Options) {
		o.ArtifactUsed = func(_ context.Context, _ string) (int64, error) {
			return limits.ArtifactQuotaPerUserBytes - 1024, nil
		}
	})
	guest := testGuestModule(t)
	p := e.payload("quota-tool", "1.0.0", guest, goodConfig())
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/quota-tool/releases", e.tokens["alice"], p)
	eb := e.decodeErr(w, http.StatusBadRequest)
	if eb.Error.Code != "VALIDATION" {
		t.Fatalf("code = %s, want VALIDATION（制品配额）", eb.Error.Code)
	}
	if eb.Error.Details["quota_bytes"] != float64(limits.ArtifactQuotaPerUserBytes) {
		t.Fatalf("details.quota_bytes = %v", eb.Error.Details["quota_bytes"])
	}
	if n := e.countReleases("quota-tool"); n != 0 {
		t.Fatalf("超配额不得落行: %d", n)
	}
}

// TestPublishAssetRejectedLeavesNothing 是"非法资源名 ⇒ 一行都不留"的判据。
//
// 旧形态（2026-09-20 前）判的是"写盘失败"：段名超过 POSIX NAME_MAX 时 assets.Write
// 拒绝。资源不落盘以后没有写盘这一步，但**同一个非法段名仍然必须被拒**，而且拒的
// 位置提前到了发布期的 assets.ValidateLogicalPath（运行期 assets.Build 的同源副本）：
// 判据因此变成"逻辑路径完整校验失败 ⇒ 库里一行都没有（版本号未被占用）"。
//
// 两个长度档分别咬住两条规则：整条 > MaxPathBytes(256) 与 单段 > MaxSegmentBytes(255)。
func TestPublishAssetRejectedLeavesNothing(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	cases := []struct {
		name     string
		appID    string
		section  string
		wantCode string
	}{
		{
			name:     "整条路径超长",
			appID:    "fs-tool",
			section:  strings.Repeat("a", 300), // > MaxPathBytes
			wantCode: "ASSET_DENIED",
		},
		{
			name:     "单段超长",
			appID:    "fs-seg-tool",
			section:  strings.Repeat("b", 256), // = MaxPathBytes 之内，但单段 > MaxSegmentBytes
			wantCode: "ASSET_DENIED",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mod := withCustomSections(t, guest, map[string][]byte{tc.section: []byte("x")})
			p := e.payload(tc.appID, "1.0.0", mod, goodConfig())
			w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/"+tc.appID+"/releases", e.tokens["alice"], p)
			if w.Code == http.StatusCreated {
				t.Fatal("非法资源名不得发布成功")
			}
			eb := e.decodeErr(w, w.Code)
			if eb.Error.Code != tc.wantCode {
				t.Fatalf("code = %s, want %s（details=%v）", eb.Error.Code, tc.wantCode, eb.Error.Details)
			}
			if eb.Error.Details["section"] != tc.section {
				t.Fatalf("错误应指出是哪个段: %v", eb.Error.Details)
			}
			if eb.Error.Details["reason"] == nil {
				t.Fatalf("错误应给出具体被拒的理由: %v", eb.Error.Details)
			}
			if len(eb.Error.Hints) == 0 {
				t.Fatal("错误应给出可行动的 hints（作者要知道合法的段名长什么样）")
			}
			if n := e.countReleases(tc.appID); n != 0 {
				t.Fatalf("校验失败后库里不得有 release 行（R18），实际 %d 行", n)
			}
			if _, err := serverstore.GetWasmApp(t.Context(), e.db, tc.appID); err == nil {
				t.Fatal("校验失败后不得留下占名的应用行（版本号为 0 的悬挂应用）")
			}
			// 失败路径同样不得有任何磁盘痕迹（负向判据）。
			assertNoAssetsDir(t, e.dataRoot, tc.appID)
		})
	}
}

// TestPublishAssetLimitsRejectBeforeCommit 咬住发布期的"单文件 / 总量"上限校验
// （与运行期 assets.Build 同一份口径）。这里直接对校验函数做单元级断言：真编译一份
// 带 4 MiB 段的模块代价过高，而这条判据的价值在于"上限被拿掉时必红"。
func TestPublishAssetLimitsRejectBeforeCommit(t *testing.T) {
	max := int(limits.SectionTotalMaxBytes)

	// ① 单文件超上限 ⇒ ASSET_OVERSIZE，且指出是哪个段。
	big := map[string][]byte{"static/app.js": make([]byte, max+1)}
	eb := checkPublishAssets(big, nil)
	if eb == nil || eb.Code != apperr.CodeAssetOversize {
		t.Fatalf("单文件超限必须被拒，得到 %+v", eb)
	}
	if eb.Details["section"] != "static/app.js" || eb.Details["max"] != limits.SectionTotalMaxBytes {
		t.Fatalf("单文件超限的错误明细不对: %v", eb.Details)
	}

	// ② 两个文件各自合法但总量超上限 ⇒ ASSET_OVERSIZE（details.total）。
	half := make([]byte, max/2+1)
	total := map[string][]byte{"a.png": half, "b.png": half}
	eb = checkPublishAssets(total, nil)
	if eb == nil || eb.Code != apperr.CodeAssetOversize {
		t.Fatalf("总量超限必须被拒，得到 %+v", eb)
	}
	if eb.Details["total"] == nil {
		t.Fatalf("总量超限应给出 details.total: %v", eb.Details)
	}

	// ③ 平台注入的 picoaide.app.json 也占额度（口径与 assets.Build 逐字一致）。
	eb = checkPublishAssets(map[string][]byte{"a.png": make([]byte, max-8)}, make([]byte, 64))
	if eb == nil || eb.Code != apperr.CodeAssetOversize {
		t.Fatalf("配置文件也让总量越界时必须被拒，得到 %+v", eb)
	}

	// ④ 恰好等于上限（含配置文件）必须放行 —— 免得把上限判成"小于等于"以外的东西。
	ok := map[string][]byte{"a.png": make([]byte, max-64)}
	if eb := checkPublishAssets(ok, make([]byte, 64)); eb != nil {
		t.Fatalf("恰好等于上限应放行: %+v", eb)
	}
	// ⑤ 边界上再多一字节即拒。
	if eb := checkPublishAssets(ok, make([]byte, 65)); eb == nil {
		t.Fatal("超出一字节必须被拒")
	}
}

// TestPublishDuplicateAssetSectionRejected 咬住 `ASSET_EXISTS` 的**唯一触发点**：
// 同一个包内路径在自定义段里出现了两次。
//
// 为什么必须拒：重名段在解析层只取第一个、其余**静默丢弃**（wasmmod.Parse 的既有
// 语义），作者的两种常见形态都会撞上 —— 打包脚本给两个源文件写了同一个 DEST，或手工
// 往模块里重复追加同一个段。两种情况都表现为"页面内容与预期不一致"，而平台一声不响。
// 这个错误码在磁盘版的 `assets.Store.Write`（"拒绝覆盖"）删除后曾经没有任何触发点，
// 而 `server/skills/app-builder/references/abi.md` 已声明该语义 ⇒ 实现必须跟上文档。
//
// 变异验证：去掉 prepare 里的 checkDuplicateSections 调用，本用例必须变红（会发布成功）。
func TestPublishDuplicateAssetSectionRejected(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	// 同一段名两次、内容不同：解析层保留第一份（"<html>first</html>"）。
	mod := withRepeatedCustomSection(t, guest, "index.html",
		[]byte("<html>first</html>"), []byte("<html>second</html>"))

	// ① 预检与发布必须给同一个结论（否则 AI 会看到"预检通过、发布被拒"）。
	// 顺带咬住"validate 不写审计"（§4.2）：预检是只读动作。
	auditBefore := e.countAudit()
	p := e.payload("dup-tool", "1.0.0", mod, goodConfig())
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/validate", e.tokens["alice"], p)
	veb := e.decodeErr(w, http.StatusConflict)
	if veb.Error.Code != "ASSET_EXISTS" {
		t.Fatalf("validate code = %s, want ASSET_EXISTS", veb.Error.Code)
	}
	if veb.Error.Details["reason"] != "duplicate_section" {
		t.Fatalf("validate details.reason = %v, want duplicate_section", veb.Error.Details)
	}
	if fmt.Sprint(veb.Error.Details["paths"]) != "[index.html]" {
		t.Fatalf("validate details.paths = %v, want [index.html]", veb.Error.Details["paths"])
	}
	if got := e.countAudit(); got != auditBefore {
		t.Fatalf("预检不得写审计: %d → %d", auditBefore, got)
	}

	// ② 发布：同样的码与明细，且**一行都不留**（版本号未被占用）。
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/dup-tool/releases", e.tokens["alice"], p)
	eb := e.decodeErr(w, http.StatusConflict)
	if eb.Error.Code != "ASSET_EXISTS" {
		t.Fatalf("publish code = %s, want ASSET_EXISTS", eb.Error.Code)
	}
	if eb.Error.Details["reason"] != "duplicate_section" {
		t.Fatalf("publish details.reason = %v, want duplicate_section", eb.Error.Details)
	}
	if fmt.Sprint(eb.Error.Details["paths"]) != "[index.html]" {
		t.Fatalf("publish details.paths = %v, want [index.html]", eb.Error.Details["paths"])
	}
	if len(eb.Error.Hints) < 2 {
		t.Fatalf("错误应给出两条可行动的 hints（怎么改 + 改内容要发新版）: %v", eb.Error.Hints)
	}
	if n := e.countReleases("dup-tool"); n != 0 {
		t.Fatalf("重名被拒后库里不得有 release 行（R18），实际 %d 行", n)
	}
	if _, err := serverstore.GetWasmApp(t.Context(), e.db, "dup-tool"); err == nil {
		t.Fatal("重名被拒后不得留下占名的应用行")
	}
	// 发布失败必须留痕（审计动作是 wasm_app_release_failed，不是成功那条）。
	if got := e.countAudit(); got != auditBefore+1 {
		t.Fatalf("被拒的发布应写一条失败审计: %d → %d", auditBefore, got)
	}
	if actions := e.auditActions("dup-tool"); !contains(actions, "wasm_app_release_failed") {
		t.Fatalf("缺少 wasm_app_release_failed 审计: %v", actions)
	}
	assertNoAssetsDir(t, e.dataRoot, "dup-tool")
}

// TestPublishDuplicateNonAssetSectionsStillAllowed 是上一条的**反向控制**：
// 工具链元数据段（`producers`）与平台独占的 `picoaide.app.json` 重复出现**不得**被
// 重名闸门误伤（它们本来就可能重复/被忽略，判据只罩保留下来的资源段）。
func TestPublishDuplicateNonAssetSectionsStillAllowed(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	mod := withRepeatedCustomSection(t, guest, "producers", []byte("meta-1"), []byte("meta-2"))
	mod = withRepeatedCustomSection(t, mod, limits.AppConfigFileName,
		[]byte(`{"access":"public"}`), []byte(`{"access":"whitelist"}`))

	rel := e.publishOK(e.tokens["alice"], "dup-meta-tool", "1.0.0", mod, goodConfig())
	ignored, _ := rel["ignored_sections"].([]any)
	got := map[string]bool{}
	for _, name := range ignored {
		got[fmt.Sprint(name)] = true
	}
	if !got["producers"] || !got[limits.AppConfigFileName] {
		t.Fatalf("工具链段与 picoaide.app.json 应被忽略并报告，得到 %v", ignored)
	}
	// 资源只有段里真正的那份配置被注入 ⇒ 库内 config_json 是**平台解析后的**配置。
	r, err := serverstore.GetWasmRelease(t.Context(), e.db, "dup-meta-tool", "1.0.0")
	if err != nil {
		t.Fatalf("读版本失败: %v", err)
	}
	if appcfg.AccessOfConfigJSON(r.ConfigJSON) != appcfg.AccessLogin {
		t.Fatalf("库内配置应来自提交的 config（login），得到 %q", appcfg.AccessOfConfigJSON(r.ConfigJSON))
	}
}

// TestReviewSwitchKeepsCurrentRelease 覆盖 R17：开启审核后新版本只是 pending，
// **线上仍旧版本**（不中断使用）；关闭后新版本立即生效。
func TestReviewSwitchKeepsCurrentRelease(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	rel1 := e.publishOK(e.tokens["alice"], "rev-tool", "1.0.0", guest, goodConfig())
	v1ID := int64(rel1["id"].(float64))

	// 管理员开启审核开关（写审计，组织级动作）。
	w := e.req(http.MethodPut, "/api/server/admin/wasm-apps/review", "", map[string]any{"required": true})
	var rr struct {
		ReviewRequired bool `json:"review_required"`
		Changed        bool `json:"changed"`
	}
	e.decodeJSON(w, http.StatusOK, &rr)
	if !rr.ReviewRequired || !rr.Changed {
		t.Fatalf("开关应被打开: %+v", rr)
	}
	// 组织级审计没有 app 维度 ⇒ 用全表审计断言。
	logs, _, aerr := serverstore.ListAuditLogsPagedFiltered(e.db, 0, 100, "wasm_review_switch", "")
	if aerr != nil {
		t.Fatalf("读审计失败: %v", aerr)
	}
	if len(logs) != 1 || logs[0].Username != "boss" {
		t.Fatalf("审核开关变更必须写审计（R17）: %+v", logs)
	}

	// 新版本进待审队列：status=pending，current 仍旧版本。
	p := e.payload("rev-tool", "1.1.0", guest, goodConfig())
	p["changelog"] = "加了新功能"
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/rev-tool/releases", e.tokens["alice"], p)
	var out struct {
		Release struct {
			ID      int64  `json:"id"`
			Status  string `json:"status"`
			Current bool   `json:"current"`
		} `json:"release"`
		ReviewRequired bool `json:"review_required"`
	}
	e.decodeJSON(w, http.StatusCreated, &out)
	if out.Release.Status != serverstore.ReleaseStatusPending || out.Release.Current {
		t.Fatalf("审核开启时新版本应为 pending 且不生效: %+v", out.Release)
	}
	if !out.ReviewRequired {
		t.Fatal("响应应回显 review_required=true")
	}
	app, _ := serverstore.GetWasmApp(t.Context(), e.db, "rev-tool")
	if app.CurrentReleaseID != v1ID {
		t.Fatalf("待审期间线上必须仍是旧版本: current=%d want=%d", app.CurrentReleaseID, v1ID)
	}
	if !contains(e.auditActions("rev-tool"), "wasm_app_release_pending") {
		t.Fatalf("待审也要留痕: %v", e.auditActions("rev-tool"))
	}

	// 关掉开关后新版本立即生效。
	e.decodeJSON(e.req(http.MethodPut, "/api/server/admin/wasm-apps/review", "", map[string]any{"required": false}), http.StatusOK, &rr)
	p2 := e.payload("rev-tool", "1.2.0", guest, goodConfig())
	p2["changelog"] = "继续改"
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/rev-tool/releases", e.tokens["alice"], p2)
	e.decodeJSON(w, http.StatusCreated, &out)
	if out.Release.Status != serverstore.ReleaseStatusApproved || !out.Release.Current {
		t.Fatalf("开关关闭后应立即生效: %+v", out.Release)
	}
}

// TestAppIDCaseInsensitiveLookupForReadPaths 记录一条**有意的**差异：
// 创建路径严格拒大写（§10.5 第 52 项），而只读/管理路径按域名语义大小写不敏感
// （DNS 不区分大小写，app_id 就是域名标签）。
func TestAppIDCaseInsensitiveLookupForReadPaths(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "case-tool", "1.0.0", testGuestModule(t), goodConfig())
	var schema struct {
		Schema struct {
			AppID string `json:"app_id"`
		} `json:"schema"`
	}
	e.decodeJSON(e.req(http.MethodGet, "/api/client/v2/apps/wasm/CASE-TOOL/schema", e.tokens["alice"], nil), http.StatusOK, &schema)
	if schema.Schema.AppID != "case-tool" {
		t.Fatalf("只读路径应大小写不敏感: %q", schema.Schema.AppID)
	}
}

// contains 是测试用的小工具。
func contains(hay []string, needle string) bool {
	for _, h := range hay {
		if h == needle {
			return true
		}
	}
	return false
}

// TestNoRenamePath 覆盖 §10.5 第 53d 项：**不支持改名**（改名 = 换域名）。
//
// 平台没有、也不该有"改 app_id"的入口：标识是域名标签，改名等于换域名（外部契约）。
// 判据是行为而不是文档：换个 app_id 发布得到的是**另一个应用**，原应用的标识与
// 元数据一字不改。
func TestNoRenamePath(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	e.publishOK(e.tokens["alice"], "rename-a", "1.0.0", guest, goodConfig())
	rel := e.publishOK(e.tokens["alice"], "rename-b", "1.0.0", guest, goodConfig())

	appA, err := serverstore.GetWasmApp(t.Context(), e.db, "rename-a")
	if err != nil {
		t.Fatalf("原应用应仍在: %v", err)
	}
	appB, err := serverstore.GetWasmApp(t.Context(), e.db, "rename-b")
	if err != nil {
		t.Fatalf("新应用应已建: %v", err)
	}
	if appA.AppID == appB.AppID || appA.CurrentReleaseID == appB.CurrentReleaseID {
		t.Fatal("换 app_id 发布必须得到两个独立应用（不是改名的同一个）")
	}
	if appA.Title != "示例应用 rename-a" {
		t.Fatalf("原应用元数据不得被改写: %q", appA.Title)
	}
	// 原应用仍可正常发布新版本（标识没被"搬走"）。
	p := e.payload("rename-a", "1.1.0", guest, goodConfig())
	p["changelog"] = "原应用继续迭代"
	if w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/rename-a/releases", e.tokens["alice"], p); w.Code != http.StatusCreated {
		t.Fatalf("原应用应可继续发布: %d %s", w.Code, w.Body.String())
	}
	_ = rel
}

// TestUploadTimeoutInvariant 覆盖 §10.5 第 58 项的**服务端一侧**断言：
// 客户端上传超时必须大于服务端 ReadTimeout（否则大体积上传会被服务端先掐断，
// 客户端只会看到"网络错误"）。
//
// 客户端 >8 MiB 走分片那一半在客户端仓库（packages/host/enterprise），不在本包范围。
func TestUploadTimeoutInvariant(t *testing.T) {
	if limits.ClientUploadTimeout <= limits.ServerReadTimeout {
		t.Fatalf("客户端上传超时(%v)必须 > 服务端 ReadTimeout(%v)",
			limits.ClientUploadTimeout, limits.ServerReadTimeout)
	}
	if limits.WasmMaxBytes <= limits.SectionTotalMaxBytes {
		t.Fatalf("wasm 上限(%d)必须 > 自定义段总量上限(%d)", limits.WasmMaxBytes, limits.SectionTotalMaxBytes)
	}
	if int64(limits.UploadBodyMaxBytes) <= int64(limits.WasmMaxBytes)*4/3 {
		t.Fatalf("请求体上限(%d)必须容得下 32 MiB 的 base64(%d)",
			limits.UploadBodyMaxBytes, int64(limits.WasmMaxBytes)*4/3)
	}
}
