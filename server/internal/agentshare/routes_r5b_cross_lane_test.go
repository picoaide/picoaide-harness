package agentshare

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/appstore"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// ===========================================================================
// 第五轮审计 R5-B 的跨泳道尾巴（智能体侧孪生，2026-09-23）
//
// 技能侧（internal/sharedskills）的两条语义在同一轮里已收敛到
// serverstore/distribution.go 的单一权威；本文件覆盖智能体侧的两条孪生缺口：
//
//	R5-B-1：下架（apps.enabled=0）期间 approve 必须 409 APP_DELISTED（内容冻结），
//	        reject 不受限；
//	R5-B-2：归档下载的作者豁免必须与发布权同源到 apps.owner（归属转移后两面
//	        立即一致），不再是 app_releases.publisher。
// ===========================================================================

// r5bTailErrorCode 取错误信封里的稳定错误码（与技能侧审计探针同形）。
func r5bTailErrorCode(t *testing.T, body string) string {
	t.Helper()
	var env struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(body), &env); err != nil {
		t.Fatalf("错误信封解析失败: %v (%s)", err, body)
	}
	return env.Error.Code
}

// withOwnerTransferRoute 在测试路由树上补生产的那条归属转移路由（前缀、
// 中间件与权限申报与 internal/router 逐字一致）——测试自建树必须与生产同形，
// 否则「转移归属」这条链路在本包内无法端到端验证（与 capabilities 包同做法）。
func withOwnerTransferRoute(t *testing.T, r http.Handler, db *sql.DB) {
	t.Helper()
	engine, ok := r.(*gin.Engine)
	if !ok {
		t.Fatalf("测试路由树类型 = %T, want *gin.Engine", r)
	}
	g := engine.Group("/api/server/admin", serverauth.AdminAuth(db))
	serverauth.AdminRoute(g, "PUT", "/apps/:kind/:app_id/owner",
		serverauth.PermCapabilityWrite, appstore.NewHandlers(db).TransferOwner)
}

// r5bTailTransferOwner 走生产同形的归属转移端点。
func r5bTailTransferOwner(t *testing.T, r http.Handler, adminHdr map[string]string, kind, appID, owner string) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"owner": owner})
	w := httptest.NewRecorder()
	req := httptest.NewRequest("PUT", "/api/server/admin/apps/"+kind+"/"+appID+"/owner", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range adminHdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("转移归属 = %d %s", w.Code, w.Body.String())
	}
}

// r5bTailDo 是各用例共用的请求助手。
func r5bTailDo(r http.Handler, method, path, body string, hdr map[string]string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	return w
}

// TestR5BTail1DelistFreezesAgentApproval：下架期间 approve 一律 409
// APP_DELISTED（name 级与 name@version 级两条审核面都要挡），reject 不受限；
// 管理员显式重新上架后审批立即恢复。
//
// 判据的可打坏性：拆掉 decide/decideVersioned 里的 approveWritable 闸门即红
// （见最终报告的变异对照）。
func TestR5BTail1DelistFreezesAgentApproval(t *testing.T) {
	r, db, adminHdr, aliceHdr, _ := setup(t)
	defer db.Close()
	withOwnerTransferRoute(t, r, db)

	upload := func(name, version string) {
		t.Helper()
		// 非首个版本必须带 changelog（包内元数据契约）。
		archive := makeArchive(t, map[string]string{
			"agent.cordis.yml": testComposition,
			"preset.yml":       presetMeta("下架冻结测试", version) + "changelog: " + version + " 的改动说明。\n",
		})
		if w := r5bTailDo(r, "POST", "/api/client/v2/agent-presets",
			uploadBody(name, "下架冻结测试", "下架冻结测试", archive), aliceHdr); w.Code != http.StatusCreated {
			t.Fatalf("upload %s = %d %s", version, w.Code, w.Body.String())
		}
	}

	upload("frozen-agent", "1.0.0")
	if w := r5bTailDo(r, "POST", "/api/server/admin/agent-presets/frozen-agent/approve", "", adminHdr); w.Code != http.StatusOK {
		t.Fatalf("正对照 approve = %d %s", w.Code, w.Body.String())
	}
	// 两个待审版本：1.1.0 用于验证「下架期间 approve 被拒」，1.2.0 用于验证
	// 「下架期间 reject 不受限」（reject 会释放归档字节，所以两条不能共用一个版本）。
	upload("frozen-agent", "1.1.0")
	upload("frozen-agent", "1.2.0")

	// 管理员下架（生产端点：PUT /api/server/admin/agent-presets/:name/enabled）。
	if w := r5bTailDo(r, "PUT", "/api/server/admin/agent-presets/frozen-agent/enabled",
		`{"enabled":false}`, adminHdr); w.Code != http.StatusOK {
		t.Fatalf("下架 = %d %s", w.Code, w.Body.String())
	}

	// ① name 级审核面：approve ⇒ 409 APP_DELISTED。
	w := r5bTailDo(r, "POST", "/api/server/admin/agent-presets/frozen-agent/approve", "", adminHdr)
	if w.Code != http.StatusConflict {
		t.Fatalf("下架期间 approve = %d %s, want 409", w.Code, w.Body.String())
	}
	if code := r5bTailErrorCode(t, w.Body.String()); code != appstore.CodeAppDelisted {
		t.Fatalf("下架期间 approve 错误码 = %q, want %q", code, appstore.CodeAppDelisted)
	}
	// ② name@version 级审核面：同闸门（三条审核面各写一份守卫正是 ID-01 的根因）。
	w = r5bTailDo(r, "POST", "/api/server/admin/agent-presets/frozen-agent/1.1.0/approve", "", adminHdr)
	if w.Code != http.StatusConflict {
		t.Fatalf("下架期间 approve@version = %d %s, want 409", w.Code, w.Body.String())
	}
	if code := r5bTailErrorCode(t, w.Body.String()); code != appstore.CodeAppDelisted {
		t.Fatalf("下架期间 approve@version 错误码 = %q, want %q", code, appstore.CodeAppDelisted)
	}
	// 被拒的 approve 不得落任何状态变更：1.1.0 仍是 pending。
	p, err := serverstore.GetAgentPresetByVersion(db, "frozen-agent", "1.1.0")
	if err != nil {
		t.Fatal(err)
	}
	if p.Status != serverstore.AgentPresetPending {
		t.Fatalf("被拦下的 approve 改动了版本状态 = %q, want pending", p.Status)
	}

	// ③ reject 不是分发动作：下架期间仍应允许管理员清理队列。
	if w := r5bTailDo(r, "POST", "/api/server/admin/agent-presets/frozen-agent/1.2.0/reject",
		rejectBody("下架期间清理队列"), adminHdr); w.Code != http.StatusOK {
		t.Fatalf("下架期间 reject = %d %s, want 200（reject 不受冻结限制）", w.Code, w.Body.String())
	}

	// ④ 出口是管理员显式重新上架：上架后审批立即恢复（不再 409）。
	if w := r5bTailDo(r, "PUT", "/api/server/admin/agent-presets/frozen-agent/enabled",
		`{"enabled":true}`, adminHdr); w.Code != http.StatusOK {
		t.Fatalf("重新上架 = %d %s", w.Code, w.Body.String())
	}
	if w := r5bTailDo(r, "POST", "/api/server/admin/agent-presets/frozen-agent/1.1.0/approve", "", adminHdr); w.Code != http.StatusOK {
		t.Fatalf("重新上架后 approve = %d %s, want 200", w.Code, w.Body.String())
	}
}

// TestR5BTail2AgentDownloadExemptionFollowsOwner：归档下载的作者豁免与发布权
// 同源到 apps.owner —— 归属转移后**新归属人**取得到自己负责的内容，旧上传者
// 按普通同事规则（需授权）。
//
// 判据的可打坏性：把 isOwner 改回 `u.Username == p.Author` 即红（转移后 alice
// 会重新拿到 200、bob 退化成 404）。
func TestR5BTail2AgentDownloadExemptionFollowsOwner(t *testing.T) {
	r, db, adminHdr, aliceHdr, bobHdr := setup(t)
	defer db.Close()
	withOwnerTransferRoute(t, r, db)

	archive := makeArchive(t, map[string]string{
		"agent.cordis.yml": testComposition,
		"preset.yml":       presetMeta("归属豁免测试", "1.0.0"),
	})
	if w := r5bTailDo(r, "POST", "/api/client/v2/agent-presets",
		uploadBody("owner-agent", "归属豁免测试", "归属豁免测试", archive), aliceHdr); w.Code != http.StatusCreated {
		t.Fatalf("upload = %d %s", w.Code, w.Body.String())
	}
	if w := r5bTailDo(r, "POST", "/api/server/admin/agent-presets/owner-agent/approve", "", adminHdr); w.Code != http.StatusOK {
		t.Fatalf("approve = %d %s", w.Code, w.Body.String())
	}
	// 前提：两个人**都没有**授权（app_grants 为空）——豁免只可能来自归属。
	// 名称→版本两条下载入口都覆盖（客户端两条路由共用 serveArchive）。
	latestPath := "/api/client/v2/agent-presets/owner-agent/archive"
	versionedPath := "/api/client/v2/agent-presets/owner-agent/1.0.0/archive"

	// 正对照：归属人（=上传者 alice）无需授权即可下载；bob 未授权 ⇒ 404。
	if w := r5bTailDo(r, "GET", latestPath, "", aliceHdr); w.Code != http.StatusOK {
		t.Fatalf("转移前 alice 下载 = %d, want 200（归属人豁免）", w.Code)
	}
	if w := r5bTailDo(r, "GET", versionedPath, "", aliceHdr); w.Code != http.StatusOK {
		t.Fatalf("转移前 alice 版本下载 = %d, want 200", w.Code)
	}
	if w := r5bTailDo(r, "GET", latestPath, "", bobHdr); w.Code != http.StatusNotFound {
		t.Fatalf("转移前 bob 下载 = %d, want 404（既非归属人也未授权）", w.Code)
	}

	// 归属转移：alice → bob（生产端点）。
	r5bTailTransferOwner(t, r, adminHdr, serverstore.AppKindAgent, "owner-agent", "bob")

	// ① 旧上传者失去豁免：按普通同事规则 404；失败语义与「不存在」逐字一致。
	w := r5bTailDo(r, "GET", latestPath, "", aliceHdr)
	if w.Code != http.StatusNotFound {
		t.Fatalf("转移后 alice 下载 = %d %s, want 404（豁免必须跟随 apps.owner）", w.Code, w.Body.String())
	}
	missing := r5bTailDo(r, "GET", "/api/client/v2/agent-presets/no-such-agent/archive", "", aliceHdr)
	if w.Code != missing.Code || w.Body.String() != missing.Body.String() {
		t.Fatalf("转移后旧作者与「不存在」的响应不一致: %d %s vs %d %s",
			w.Code, w.Body.String(), missing.Code, missing.Body.String())
	}
	if w := r5bTailDo(r, "GET", versionedPath, "", aliceHdr); w.Code != http.StatusNotFound {
		t.Fatalf("转移后 alice 版本下载 = %d, want 404", w.Code)
	}

	// ② 新归属人立刻取得到自己负责的内容（「转移出来的发布权」不能是空的）。
	if w := r5bTailDo(r, "GET", latestPath, "", bobHdr); w.Code != http.StatusOK {
		t.Fatalf("转移后 bob 下载 = %d, want 200（新归属人豁免）", w.Code)
	}
	if w := r5bTailDo(r, "GET", versionedPath, "", bobHdr); w.Code != http.StatusOK {
		t.Fatalf("转移后 bob 版本下载 = %d, want 200", w.Code)
	}

	// ③ 管理面归档不受影响（审核/排查仍需可取）。
	if w := r5bTailDo(r, "GET", "/api/server/admin/agent-presets/owner-agent/archive", "", adminHdr); w.Code != http.StatusOK {
		t.Fatalf("管理面下载 = %d, want 200", w.Code)
	}
}
