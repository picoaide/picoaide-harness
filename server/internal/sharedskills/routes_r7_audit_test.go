package sharedskills

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/appstore"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/skillmanifest"
)

// ---------------------------------------------------------------------------
// R7 审计回归(agentshare-3 / agentshare-5)
//
// 共享技能库(sharedskills)只拥有 channel=org 的技能;市场渠道技能由
// marketplace 端点管理。两者共用 apps/app_releases 与同一张 app_grants:
// 读侧(orgSkillReleases)已按渠道过滤,写侧此前没有,于是共享库的
// reject/delete/quality/grants 可以直接改写或销毁市场技能(复核实测:
// reject 之后市场列表只剩 {"version":""} 的空壳行,delete 之后彻底消失)。
// ---------------------------------------------------------------------------

// seedMarketSkill 通过统一发布内核播种一个市场渠道技能(发布即 approved)。
func seedMarketSkill(t *testing.T, db *sql.DB, name, version string, wanted bool) {
	t.Helper()
	archive := makeSkillArchive(t, map[string]string{"SKILL.md": skillMd(name, version)})
	entries, md, err := ListArchiveContents(archive)
	if err != nil {
		t.Fatal(err)
	}
	man, err := skillmanifest.Parse(entries, md, name)
	if err != nil {
		t.Fatal(err)
	}
	checksum, err := ValidateSkillArchive(archive)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := appstore.Publish(db, appstore.PublishRequest{
		Kind: serverstore.AppKindSkill, AppID: name, Channel: serverstore.AppChannelMarket,
		Archive: archive, Publisher: "boss", AdminPublish: true,
		Manifest: appstore.FromSkillManifest(man), Checksum: checksum,
	}); err != nil {
		t.Fatalf("seed market skill: %v", err)
	}
	if wanted {
		if err := serverstore.GrantSkill(db, name, "alice", serverstore.GranteeUser); err != nil {
			t.Fatal(err)
		}
	}
}

func skAdminDo(t *testing.T, r http.Handler, hdr map[string]string, method, path, body string) (int, string) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w.Code, w.Body.String()
}

func skUserDo(t *testing.T, r http.Handler, hdr map[string]string, method, path, body string) (int, string) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w.Code, w.Body.String()
}

func TestSharedSkillWriteEndpointsRejectMarketChannelRows(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()
	seedMarketSkill(t, db, "mkt-skill", "1.0.0", true)

	// 读侧闸门对照:共享库清单不含市场技能(既有行为)。
	if code, body := skUserDo(t, r, userHdr, "GET", "/api/client/v2/shared-skills", ""); code != http.StatusOK || strings.Contains(body, "mkt-skill") {
		t.Fatalf("control: employee shared list = %d %s", code, body)
	}
	// 共享技能的授权读侧也不该吐出市场技能。
	if code, body := skAdminDo(t, r, adminHdr, "GET", "/api/server/admin/shared-skills/mkt-skill/grants", ""); code != http.StatusNotFound {
		t.Errorf("shared grants on market skill = %d %s, want 404", code, body)
	}
	// 审核/预览/质量/授权/删除五个写(或审核面)入口都必须 404。
	if code, body := skAdminDo(t, r, adminHdr, "GET", "/api/server/admin/shared-skills/mkt-skill/1.0.0/preview", ""); code != http.StatusNotFound {
		t.Errorf("shared preview on market skill = %d %s, want 404", code, body)
	}
	if code, body := skAdminDo(t, r, adminHdr, "GET", "/api/server/admin/shared-skills/mkt-skill/1.0.0/file?path=SKILL.md", ""); code != http.StatusNotFound {
		t.Errorf("shared file on market skill = %d %s, want 404", code, body)
	}
	if code, body := skAdminDo(t, r, adminHdr, "POST", "/api/server/admin/shared-skills/mkt-skill/1.0.0/reject", `{"reason":"不该被共享面拒"}`); code != http.StatusNotFound {
		t.Errorf("shared reject on market skill = %d %s, want 404", code, body)
	}
	if code, body := skAdminDo(t, r, adminHdr, "PUT", "/api/server/admin/shared-skills/mkt-skill/1.0.0/quality", `{"quality":"featured"}`); code != http.StatusNotFound {
		t.Errorf("shared quality on market skill = %d %s, want 404", code, body)
	}
	if code, body := skAdminDo(t, r, adminHdr, "PUT", "/api/server/admin/shared-skills/mkt-skill/grants", `{"groups":[]}`); code != http.StatusNotFound {
		t.Errorf("shared replace-grants on market skill = %d %s, want 404", code, body)
	}
	if code, body := skAdminDo(t, r, adminHdr, "DELETE", "/api/server/admin/shared-skills/mkt-skill/1.0.0", ""); code != http.StatusNotFound {
		t.Errorf("shared delete on market skill = %d %s, want 404", code, body)
	}

	// 市场内容必须完好:approved、有归档、授权还在、市场面可下载。
	rel, err := serverstore.GetRelease(db, serverstore.AppKindSkill, "mkt-skill", "1.0.0")
	if err != nil || rel.DeletedAt != nil || rel.Status != serverstore.ReleaseStatusApproved || len(rel.Archive) == 0 {
		t.Fatalf("market release damaged: %+v err=%v", rel, err)
	}
	grants, err := serverstore.ListSkillGrants(db, "mkt-skill")
	if err != nil || len(grants) != 1 {
		t.Fatalf("market grants damaged: %+v err=%v", grants, err)
	}
}

// agentshare-5(技能侧):被拒版本的归档必须清理 —— 归档永久留存而配额已
// 释放,员工可以无限循环上传堆字节。
func TestSharedSkillRejectClearsArchive(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()
	if code, body := skUserDo(t, r, userHdr, "POST", "/api/client/v2/shared-skills", skillUpload(t, "rej-skill", "1.0.0", "")); code != http.StatusCreated {
		t.Fatalf("upload = %d %s", code, body)
	}
	before, err := serverstore.GetSharedSkill(db, "rej-skill", "1.0.0")
	if err != nil || len(before.Archive) == 0 {
		t.Fatalf("archive not stored: %+v err=%v", before, err)
	}
	if code, body := skAdminDo(t, r, adminHdr, "POST", "/api/server/admin/shared-skills/rej-skill/1.0.0/reject", `{"reason":"内容不合规"}`); code != http.StatusOK {
		t.Fatalf("reject = %d %s", code, body)
	}
	after, err := serverstore.GetSharedSkill(db, "rej-skill", "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != serverstore.SharedSkillRejected {
		t.Fatalf("status = %s, want rejected", after.Status)
	}
	if len(after.Archive) != 0 {
		t.Fatalf("rejected version kept %d archive bytes; quota released but bytes retained", len(after.Archive))
	}
}
