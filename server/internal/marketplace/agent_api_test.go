package marketplace

import (
	"encoding/base64"
	"net/http"
	"strings"
	"testing"
)

// agentArchive 构造市场智能体归档(zip):agent.cordis.yml + preset.yml 元数据。
func agentArchive(t *testing.T, version, title string) []byte {
	t.Helper()
	return makeZip(t, map[string]string{
		"agent.cordis.yml": "# composition\nentry: []\n",
		"preset.yml": `name: ` + title + `
version: ` + version + `
description: 一个用于演示市场智能体管理的测试智能体
author: bob
category: demo
changelog: 首次发布
`,
	})
}

func TestAdminAgentsCRUD(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()

	// 登记 → 清单空
	if w, _ := mreq(t, r, "POST", "/api/server/admin/agents", `{"name":"ppt-gen","description":"PPT 生成","author":"boss"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create agent: %d %s", w.Code, w.Body.String())
	}
	_, out := mreq(t, r, "GET", "/api/server/admin/agents", "", hdr)
	agents := out["agents"].([]any)
	if len(agents) != 1 || agents[0].(map[string]any)["name"] != "ppt-gen" {
		t.Fatalf("agents = %v", agents)
	}
	// 同名跨源互斥:组织共享库行(agent-presets)已存在时拒绝。
	mreq(t, r, "POST", "/api/server/admin/agents", `{"name":"ppt-gen"}`, hdr) // duplicate
	if w, _ := mreq(t, r, "POST", "/api/server/admin/agents", `{"name":"ppt-gen"}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("duplicate accepted: %d", w.Code)
	}
	// 上传发布(包内 version 与清单一致)
	archive := agentArchive(t, "1.0.0", "PPT 生成器")
	body := `{"version":"1.0.0","archive":"` + base64.StdEncoding.EncodeToString(archive) + `"}`
	if w, out := mreq(t, r, "POST", "/api/server/admin/agents/ppt-gen/archive", body, hdr); w.Code != http.StatusOK {
		t.Fatalf("upload: %d %v", w.Code, out)
	} else if out["version"] != "1.0.0" {
		t.Fatalf("upload version = %v", out["version"])
	}
	// 清单带版本/质量
	_, out = mreq(t, r, "GET", "/api/server/admin/agents", "", hdr)
	agents = out["agents"].([]any)
	row := agents[0].(map[string]any)
	if row["version"] != "1.0.0" || row["title"] != "PPT 生成器" {
		t.Fatalf("agent row = %v", row)
	}
	// 版本必须递增
	archive2 := agentArchive(t, "1.0.0", "PPT 生成器")
	body2 := `{"version":"1.0.0","archive":"` + base64.StdEncoding.EncodeToString(archive2) + `"}`
	if w, _ := mreq(t, r, "POST", "/api/server/admin/agents/ppt-gen/archive", body2, hdr); w.Code != http.StatusConflict {
		t.Fatalf("duplicate version accepted: %d", w.Code)
	}
	// 预览:file 清单 + composition
	if w, out := mreq(t, r, "GET", "/api/server/admin/agents/ppt-gen/preview", "", hdr); w.Code != http.StatusOK {
		t.Fatalf("preview: %d %s", w.Code, w.Body.String())
	} else if len(out["files"].([]any)) != 2 || !strings.Contains(out["composition"].(string), "entry") {
		t.Fatalf("preview = %v", out)
	}
	// 授权:用户直授 + 组授权,清单可见
	if w, _ := mreq(t, r, "PUT", "/api/server/admin/agents/ppt-gen/grant", `{"username":"carol"}`, hdr); w.Code != http.StatusOK {
		t.Fatal("grant user failed")
	}
	if w, out := mreq(t, r, "GET", "/api/server/admin/agents/ppt-gen/grants", "", hdr); w.Code != http.StatusOK {
		t.Fatal("list grants failed")
	} else if !strings.Contains(w.Body.String(), "carol") {
		t.Fatalf("grants = %v", out)
	}
	// 元数据更新(描述)与下架/重新上架;author 保持原归属(owner 一经写入不可覆盖,
	// 改归属走 /apps/agent/:name/owner)。
	if w, _ := mreq(t, r, "PUT", "/api/server/admin/agents/ppt-gen", `{"description":"新描述"}`, hdr); w.Code != http.StatusOK {
		t.Fatal("update failed")
	}
	_, out = mreq(t, r, "GET", "/api/server/admin/agents", "", hdr)
	row = out["agents"].([]any)[0].(map[string]any)
	if row["description"] != "新描述" || row["author"] != "boss" {
		t.Fatalf("after update = %v", row)
	}
	if w, _ := mreq(t, r, "DELETE", "/api/server/admin/agents/ppt-gen", "", hdr); w.Code != http.StatusOK {
		t.Fatal("disable failed")
	}
	if w, _ := mreq(t, r, "POST", "/api/server/admin/agents/ppt-gen/enable", "", hdr); w.Code != http.StatusOK {
		t.Fatal("enable failed")
	}
}

// TestAdminAgentArchiveValidation: 缺少 preset.yml / 缺少 agent.cordis.yml 被拒。
func TestAdminAgentArchiveValidation(t *testing.T) {
	r, _, hdr := marketAdminSetup(t)
	// admin setup 用 t.TempDir 依赖 db; 这里只需路由, 复用 header。
	if w, _ := mreq(t, r, "POST", "/api/server/admin/agents", `{"name":"bad"}`, hdr); w.Code != http.StatusOK {
		t.Fatal("create failed")
	}
	// 无 agent.cordis.yml
	noComp := makeZip(t, map[string]string{"preset.yml": "name: bad\nversion: 1.0.0\ndescription: x\n"})
	if w, _ := mreq(t, r, "POST", "/api/server/admin/agents/bad/archive",
		`{"version":"1.0.0","archive":"`+base64.StdEncoding.EncodeToString(noComp)+`"}`, hdr); w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("missing agent.cordis.yml accepted: %d", w.Code)
	}
	// 缺 preset.yml
	noMeta := makeZip(t, map[string]string{"agent.cordis.yml": "# c\n"})
	if w, _ := mreq(t, r, "POST", "/api/server/admin/agents/bad/archive",
		`{"version":"1.0.0","archive":"`+base64.StdEncoding.EncodeToString(noMeta)+`"}`, hdr); w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("missing preset.yml accepted: %d", w.Code)
	}
}
