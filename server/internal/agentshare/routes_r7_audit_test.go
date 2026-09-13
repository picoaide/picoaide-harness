package agentshare

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/appstore"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/skillmanifest"
)

// ---------------------------------------------------------------------------
// R7 审计回归(archupd-1 / agentshare-1 / agentshare-2 / agentshare-5)
// ---------------------------------------------------------------------------

// seedMarketAgent 通过统一发布内核播种一个**市场渠道**智能体(agent kind,
// channel=market,发布即 approved),模拟市场端点创建的存量内容。
func seedMarketAgent(t *testing.T, db *sql.DB, name string) {
	t.Helper()
	archive := makeArchive(t, map[string]string{
		"agent.cordis.yml": testComposition,
		"preset.yml":       presetMeta("市场智能体", "1.0.0"),
	})
	entries, _, err := ListArchiveContents(archive)
	if err != nil {
		t.Fatal(err)
	}
	presetYML, _, found, _, _, err := ExtractFileContent(archive, skillmanifest.PresetMetaFile)
	if err != nil || !found {
		t.Fatalf("extract preset.yml: found=%v err=%v", found, err)
	}
	man, err := skillmanifest.ParseAgent(entries, presetYML, name)
	if err != nil {
		t.Fatal(err)
	}
	checksum, err := ValidatePresetArchive(archive)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := appstore.Publish(db, appstore.PublishRequest{
		Kind: serverstore.AppKindAgent, AppID: name, Channel: serverstore.AppChannelMarket,
		Archive: archive, Publisher: "boss", AdminPublish: true,
		Manifest: appstore.FromSkillManifest(man), Checksum: checksum,
	}); err != nil {
		t.Fatalf("seed market agent: %v", err)
	}
}

// adminGet/adminPost 走管理面(带 session + CSRF),返回状态码与响应体。
func adminDo(t *testing.T, r http.Handler, hdr map[string]string, method, path, body string) (int, string) {
	t.Helper()
	var rd *strings.Reader
	if body == "" {
		rd = strings.NewReader("")
	} else {
		rd = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, rd)
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w.Code, w.Body.String()
}

func userDo(t *testing.T, r http.Handler, hdr map[string]string, method, path, body string) (int, string) {
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

// archupd-1②:agent.cordis.yml 必须可读且可解析才能过闸 —— 真实超过预览
// 上限的编排(不含任何伪造)会让审核面只能看到空串,必须在发布期拒收,
// 而不是静默降级成「审核通过但没人看过编排」。
func TestUploadRejectsCompositionBeyondReviewPreviewCap(t *testing.T) {
	r, db, _, userHdr, _ := setup(t)
	defer db.Close()

	// 192KB 的真实编排(合法 YAML 列表,只是行数多),声明尺寸与真实一致。
	var big strings.Builder
	for i := 0; i < 6000; i++ {
		big.WriteString("- id: row")
		big.WriteString(string(rune('a' + i%26)))
		big.WriteString("\n  name: '@deepseek-ai/dsh-persona'\n")
	}
	if big.Len() <= maxFilePreviewBytes {
		t.Fatalf("fixture composition only %d bytes, want > %d", big.Len(), maxFilePreviewBytes)
	}
	archive := makeArchive(t, map[string]string{
		"agent.cordis.yml": big.String(),
		"preset.yml":       presetMeta("编排过大", "1.0.0"),
	})
	code, body := userDo(t, r, userHdr, "POST", "/api/client/v2/agent-presets", uploadBody("huge-comp", "", "", archive))
	if code != http.StatusUnprocessableEntity {
		t.Fatalf("upload oversized composition = %d %s, want 422 (审核面读不到编排就不能发布)", code, body)
	}
	if _, err := serverstore.GetApp(db, serverstore.AppKindAgent, "huge-comp"); err == nil {
		t.Fatal("unreviewable composition was stored anyway")
	}
}

// archupd-1②(结构面):agent.cordis.yml 必须是上游可挂载的「插件行列表」,
// 解析不了的包不能通过「必须可读且可解析」闸门。
func TestUploadRejectsUnparsableComposition(t *testing.T) {
	r, db, _, userHdr, _ := setup(t)
	defer db.Close()

	cases := []struct {
		name        string
		composition string
	}{
		{"not a list", "entry: []\n"},
		{"row without name", "- id: persona\n  config: {}\n"},
		{"broken yaml", "- id: [unclosed\n"},
	}
	for i, c := range cases {
		name := "bad-comp-" + string(rune('a'+i))
		archive := makeArchive(t, map[string]string{
			"agent.cordis.yml": c.composition,
			"preset.yml":       presetMeta("坏编排", "1.0.0"),
		})
		code, body := userDo(t, r, userHdr, "POST", "/api/client/v2/agent-presets", uploadBody(name, "", "", archive))
		if code != http.StatusUnprocessableEntity {
			t.Errorf("%s: upload = %d %s, want 422", c.name, code, body)
		}
	}
}

// archupd-1③(控制组):合法编排照常发布,且审核预览真的能看到其内容。
func TestUploadAcceptsParsableCompositionAndReviewSeesIt(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()
	archive := makeArchive(t, map[string]string{
		"agent.cordis.yml": testComposition,
		"preset.yml":       presetMeta("可审编排", "1.0.0"),
	})
	if code, body := userDo(t, r, userHdr, "POST", "/api/client/v2/agent-presets", uploadBody("good-comp", "", "", archive)); code != http.StatusCreated {
		t.Fatalf("upload valid composition = %d %s", code, body)
	}
	code, body := adminDo(t, r, adminHdr, "GET", "/api/server/admin/agent-presets/good-comp/preview", "")
	if code != http.StatusOK {
		t.Fatalf("preview = %d %s", code, body)
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatal(err)
	}
	if comp, _ := out["composition"].(string); !strings.Contains(comp, "dsh-persona") {
		t.Fatalf("review composition = %q, want the real agent.cordis.yml", comp)
	}
}

// agentshare-2:市场渠道的智能体不得出现在共享面(员工清单/管理清单/审核
// 队列/预览/下载),共享面的写端点也不得改写或销毁它。
func TestSharedSurfaceIgnoresMarketChannelAgents(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()
	seedMarketAgent(t, db, "mkt-agent")
	// 市场侧授权写的是同一张 app_grants(kind=agent):共享面读路径由此串面。
	if err := serverstore.GrantApp(db, serverstore.AppKindAgent, "mkt-agent", "alice", "user"); err != nil {
		t.Fatal(err)
	}

	// 员工清单(source=org 的能力面同源)不得出现市场智能体。
	code, body := userDo(t, r, userHdr, "GET", "/api/client/v2/agent-presets", "")
	if code != http.StatusOK || strings.Contains(body, "mkt-agent") {
		t.Fatalf("employee list = %d %s, want 200 without the market agent", code, body)
	}
	// 管理清单(审批面)同样只见组织库。
	code, body = adminDo(t, r, adminHdr, "GET", "/api/server/admin/agent-presets", "")
	if code != http.StatusOK || strings.Contains(body, "mkt-agent") {
		t.Fatalf("admin list = %d %s, want 200 without the market agent", code, body)
	}
	// 共享面的预览/下载/审核/删除都必须 404(市场内容归市场端点管)。
	if code, body := adminDo(t, r, adminHdr, "GET", "/api/server/admin/agent-presets/mkt-agent/preview", ""); code != http.StatusNotFound {
		t.Errorf("admin preview on market agent = %d %s, want 404", code, body)
	}
	if code, body := adminDo(t, r, adminHdr, "GET", "/api/server/admin/agent-presets/mkt-agent/1.0.0/file?path=agent.cordis.yml", ""); code != http.StatusNotFound {
		t.Errorf("admin file on market agent = %d %s, want 404", code, body)
	}
	if code, body := adminDo(t, r, adminHdr, "POST", "/api/server/admin/agent-presets/mkt-agent/reject", rejectBody("不该被共享面拒")); code != http.StatusNotFound {
		t.Errorf("admin reject on market agent = %d %s, want 404", code, body)
	}
	if code, body := adminDo(t, r, adminHdr, "DELETE", "/api/server/admin/agent-presets/mkt-agent", ""); code != http.StatusNotFound {
		t.Errorf("admin delete on market agent = %d %s, want 404", code, body)
	}
	// 市场内容必须完好:App 仍上架、版本仍 approved 且有归档。
	a, err := serverstore.GetApp(db, serverstore.AppKindAgent, "mkt-agent")
	if err != nil || a.Enabled != 1 || a.Channel != serverstore.AppChannelMarket {
		t.Fatalf("market app damaged: %+v err=%v", a, err)
	}
	rel, err := serverstore.GetRelease(db, serverstore.AppKindAgent, "mkt-agent", "1.0.0")
	if err != nil || rel.DeletedAt != nil || rel.Status != serverstore.ReleaseStatusApproved || len(rel.Archive) == 0 {
		t.Fatalf("market release damaged: %+v err=%v", rel, err)
	}
}

// agentshare-1:name 级删除的契约是「删该 name 的全部版本」,不能只软删
// 最高 approved 而把其它版本留成僵尸 approved 行。
func TestNameLevelDeleteSoftDeletesEveryVersion(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()

	upload := func(version string) {
		meta := presetMeta("多版本", version)
		if version != "1.0.0" {
			meta += "changelog: 第二个版本。\n"
		}
		archive := makeArchive(t, map[string]string{"agent.cordis.yml": testComposition, "preset.yml": meta})
		if code, body := userDo(t, r, userHdr, "POST", "/api/client/v2/agent-presets", uploadBody("multi", "", "", archive)); code != http.StatusCreated {
			t.Fatalf("upload %s = %d %s", version, code, body)
		}
		if code, body := adminDo(t, r, adminHdr, "POST", "/api/server/admin/agent-presets/multi/"+version+"/approve", ""); code != http.StatusOK {
			t.Fatalf("approve %s = %d %s", version, code, body)
		}
	}
	upload("1.0.0")
	upload("2.0.0")

	if code, body := adminDo(t, r, adminHdr, "DELETE", "/api/server/admin/agent-presets/multi", ""); code != http.StatusOK {
		t.Fatalf("name-level delete = %d %s", code, body)
	}
	rows, err := serverstore.ListAgentPresets(db, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range rows {
		if p.Name == "multi" {
			t.Fatalf("name-level delete left a live version behind: %+v", p)
		}
	}
	all, err := serverstore.ListReleases(db, serverstore.AppKindAgent, "multi")
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 {
		t.Fatalf("releases = %d, want 2", len(all))
	}
	for _, rel := range all {
		if rel.DeletedAt == nil {
			t.Fatalf("version %s survived the name-level delete (deleted_at IS NULL)", rel.Version)
		}
		if len(rel.Archive) != 0 {
			t.Fatalf("version %s kept its archive after delete", rel.Version)
		}
	}
}

// agentshare-5:被拒版本的归档必须清理 —— 否则归档永久留存、配额却已释放,
// 员工可无限循环上传(拒绝不清字节,存储无上界)。
func TestRejectClearsPresetArchive(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()
	archive := makeArchive(t, map[string]string{
		"agent.cordis.yml": testComposition,
		"preset.yml":       presetMeta("被拒预设", "1.0.0"),
	})
	if code, body := userDo(t, r, userHdr, "POST", "/api/client/v2/agent-presets", uploadBody("rej-preset", "", "", archive)); code != http.StatusCreated {
		t.Fatalf("upload = %d %s", code, body)
	}
	before, err := serverstore.GetAgentPresetByVersion(db, "rej-preset", "1.0.0")
	if err != nil || len(before.Archive) == 0 {
		t.Fatalf("archive not stored: %+v err=%v", before, err)
	}
	if code, body := adminDo(t, r, adminHdr, "POST", "/api/server/admin/agent-presets/rej-preset/reject", rejectBody("内容不合规")); code != http.StatusOK {
		t.Fatalf("reject = %d %s", code, body)
	}
	after, err := serverstore.GetAgentPresetByVersion(db, "rej-preset", "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != serverstore.AgentPresetRejected {
		t.Fatalf("status = %s, want rejected", after.Status)
	}
	if len(after.Archive) != 0 {
		t.Fatalf("rejected version kept %d archive bytes; the quota is released but the bytes are not", len(after.Archive))
	}
}
