package main

// 管理面**市场命名空间归档下载**端点的正向举证（2026-09-23）。
//
// ## 为什么需要它
//
// `GET /api/server/admin/skills/:name/archive` 与 `GET /agents/:name/archive` 是
// webadmin 归档预览弹层「文件过大 → 下载归档」的落点（链接 = 预览基路径 + `/archive`，
// 基路径按行的 channel 推导）。这两个端点属于 `sweepAuthGatedNonJSONSurfaces` 的
// **非 JSON 例外**（二进制归档），而未认证扫描只能看到 JSON 401（AdminAuth 闸先于
// 内容类型生效）⇒ 光靠扫描证明不了"它真的是二进制流"。本用例带**真管理会话**打一次，
// 断言：路由存在（不是 404/405）、响应是 application/zip 原样字节、版本/校验和头齐全。
//
// 它同时是例外登记表的**双向**守卫：
//   - 登记了却 never 命中 ⇒ `sweepCheckExceptionTables` 报红；
//   - 有人把登记从表里删掉 ⇒ 这里的 `assertDeclaredNonJSON` 报红。
//
// 变异验证：把任一 `GET …/:name/archive` 从 `RegisterAdminRoutes` 或 `internal/router`
// 摘掉 ⇒ 对应用例段红（404）；把 handler 的 Content-Type 写死成 JSON ⇒ 红。

import (
	"archive/zip"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// zipBytes 构造一个最小 zip 归档（archiveutil.Format 按魔数嗅探为 zip）。
func zipBytes(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range entries {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatalf("zip create %s: %v", name, err)
		}
		if _, err := w.Write([]byte(content)); err != nil {
			t.Fatalf("zip write %s: %v", name, err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	return buf.Bytes()
}

func TestAdminMarketArchiveEndpointsAreBinary(t *testing.T) {
	db := requireRealDB(t)
	sweepSilenceAccessLog(t)
	r := sweepEngine(t, db)

	// 超管（管理面会话要求 HasManagementAccess）——与生产同一条路径建 id。
	if _, err := serverstore.CreateUserWithPassword(db, "archive-admin", "admin123456"); err != nil {
		t.Fatalf("create admin: %v", err)
	}
	u, err := serverstore.GetUserByUsername(db, "archive-admin")
	if err != nil {
		t.Fatalf("load admin: %v", err)
	}
	u.IsAdmin = true
	if err := serverstore.UpdateUser(db, u); err != nil {
		t.Fatalf("promote admin: %v", err)
	}

	// 登录拿会话 cookie + CSRF（写面必须带 CSRF，与 webadmin 同口径）。
	login := httptest.NewRequest("POST", "/api/server/admin/login",
		strings.NewReader(`{"username":"archive-admin","password":"admin123456"}`))
	login.Header.Set("Content-Type", "application/json")
	lw := httptest.NewRecorder()
	r.ServeHTTP(lw, login)
	if lw.Code != http.StatusOK {
		t.Fatalf("admin login = %d %s", lw.Code, lw.Body.String())
	}
	var loginBody map[string]any
	if err := json.Unmarshal(lw.Body.Bytes(), &loginBody); err != nil {
		t.Fatalf("login body not JSON: %v", err)
	}
	csrf, _ := loginBody["csrf_token"].(string)
	session := ""
	for _, ck := range lw.Result().Cookies() {
		if ck.Name == "picoaide_session" {
			session = ck.Value
		}
	}
	if csrf == "" || session == "" {
		t.Fatalf("登录未返回 csrf/session（csrf=%q session=%q）", csrf, session)
	}
	hdr := map[string]string{"Cookie": "picoaide_session=" + session, "X-CSRF-Token": csrf}

	do := func(method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w
	}

	// 例外登记表是**载荷**：本用例正向举证的两条路由必须登记在案
	// （删掉登记 ⇒ 本用例红），否则"归档是二进制例外"这件事可以从表里被悄悄删掉。
	assertDeclaredNonJSON(t, "GET /api/server/admin/skills/:name/archive", "application/gzip")
	assertDeclaredNonJSON(t, "GET /api/server/admin/agents/:name/archive", "application/gzip")

	// ---- 市场技能 ----
	if w := do("POST", "/api/server/admin/skills", `{"name":"sweep-archive-skill","version":"1.0.0"}`); w.Code != http.StatusOK {
		t.Fatalf("create skill = %d %s", w.Code, w.Body.String())
	}
	skillZip := zipBytes(t, map[string]string{
		"SKILL.md": "---\nname: sweep-archive-skill\ntitle: 全路由扫描夹具技能\nversion: 1.0.0\n" +
			"description: 用于举证管理面市场归档下载端点的夹具技能,描述需要满足最短长度要求。\n" +
			"author: api-sweep\ncategory: fixture\nchangelog: 夹具的更新说明。\n---\n\n" +
			"# sweep-archive-skill\n\n" +
			"本技能是服务端归档端点举证用例使用的夹具包,正文需要足够长才能通过空壳校验," +
			"因此这里补充一段说明用途的文字:它只用于证明管理面市场命名空间的归档下载端点" +
			"返回 application/zip 原样字节,不参与任何发布面。\n",
		"references/notes.md": "# 参考资料\n\n审批时应当能看到这个文件。\n",
	})
	body := `{"version":"1.0.0","archive":"` + base64.StdEncoding.EncodeToString(skillZip) + `"}`
	if w := do("POST", "/api/server/admin/skills/sweep-archive-skill/archive", body); w.Code != http.StatusOK {
		t.Fatalf("upload skill archive = %d %s", w.Code, w.Body.String())
	}
	sw := do("GET", "/api/server/admin/skills/sweep-archive-skill/archive", "")
	if sw.Code != http.StatusOK {
		t.Fatalf("技能归档下载 = %d %s（路由缺失/守卫不符都会落在这里）", sw.Code, sw.Body.String())
	}
	if ct := sw.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/zip") {
		t.Fatalf("技能归档 content-type = %q want application/zip", ct)
	}
	if !bytes.Equal(sw.Body.Bytes(), skillZip) {
		t.Fatalf("技能归档字节与上传不一致：%d vs %d", sw.Body.Len(), len(skillZip))
	}
	if sw.Header().Get("X-Skill-Version") != "1.0.0" || sw.Header().Get("X-Skill-Checksum") == "" {
		t.Fatalf("技能归档缺少版本/校验和头：%v", sw.Header())
	}

	// ---- 市场智能体 ----
	if w := do("POST", "/api/server/admin/agents", `{"name":"sweep-archive-agent","description":"夹具智能体","author":"api-sweep"}`); w.Code != http.StatusOK {
		t.Fatalf("create agent = %d %s", w.Code, w.Body.String())
	}
	agentZip := zipBytes(t, map[string]string{
		"agent.cordis.yml": "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n",
		"preset.yml": "name: 夹具智能体\nversion: 1.0.0\ndescription: 用于举证管理面市场归档下载端点的夹具智能体\n" +
			"author: api-sweep\ncategory: fixture\nchangelog: 首次发布\n",
	})
	abody := `{"version":"1.0.0","archive":"` + base64.StdEncoding.EncodeToString(agentZip) + `"}`
	if w := do("POST", "/api/server/admin/agents/sweep-archive-agent/archive", abody); w.Code != http.StatusOK {
		t.Fatalf("upload agent archive = %d %s", w.Code, w.Body.String())
	}
	aw := do("GET", "/api/server/admin/agents/sweep-archive-agent/archive", "")
	if aw.Code != http.StatusOK {
		t.Fatalf("智能体归档下载 = %d %s", aw.Code, aw.Body.String())
	}
	if ct := aw.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/zip") {
		t.Fatalf("智能体归档 content-type = %q want application/zip", ct)
	}
	if !bytes.Equal(aw.Body.Bytes(), agentZip) {
		t.Fatalf("智能体归档字节与上传不一致：%d vs %d", aw.Body.Len(), len(agentZip))
	}
	if aw.Header().Get("X-Preset-Version") != "1.0.0" || aw.Header().Get("X-Preset-Checksum") == "" {
		t.Fatalf("智能体归档缺少版本/校验和头：%v", aw.Header())
	}
}
