package marketplace

import (
	"bytes"
	"encoding/base64"
	"net/http"
	"strings"
	"testing"
)

// 市场命名空间的管理面**归档下载**端点（2026-09-23）。
//
// ## 缺陷现场
//
// webadmin 的归档预览弹层在「文件过大」时给出「下载归档」链接，链接 = 预览基路径
// + `/archive`（`webadmin/src/components/archive-preview-dialog.tsx`；基路径由
// `webadmin/src/lib/capability-endpoints.ts` 按行的 channel 推导）。市场行的基路径
// 是 `/api/server/admin/skills/:name`（技能）与 `/agents/:name`（智能体），而这两个
// 命名空间此前**只声明了 POST …/archive（上传新版）**，GET 未声明 ⇒ 市场行点下去
// 404；组织行（`/shared-skills/:name/:version/archive`、
// `/agent-presets/:name/:version/archive`）正常。这两个用例就是那个链接的落点判据。
//
// ## 契约（照组织侧既有档案端点写，不自创）
//
//   - 管理面 `AdminRoute` + 读权限点（与同命名空间既有下载面 `/skills/:name/file`、
//     `/agents/:name/file` 同权限）；
//   - 失败一律 JSON 信封（`serverauth.WriteError`），且「不存在 / 尚未上传归档」都要
//     说清楚，不是空 body；
//   - 命中即按归档**实际格式**下发二进制流（application/zip 或 application/gzip），
//     并带版本 / 校验和头（员工侧与客户端安装器靠它们做对照）。
//
// 变异验证：把 `GET /skills/:name/archive` 从 `RegisterAdminRoutes` 摘掉 ⇒ 技能用例红；
// 摘掉 `GET /agents/:name/archive` ⇒ 智能体用例红；把 Content-Type 写死成
// application/gzip（不嗅探格式）⇒ zip 夹具下两条用例都红。
func TestAdminSkillArchiveDownload(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()

	// ① 未登记：404 + JSON 信封（不是空 body，也不是 405）。
	w, out := mreq(t, r, "GET", "/api/server/admin/skills/nope/archive", "", hdr)
	if w.Code != http.StatusNotFound {
		t.Fatalf("未登记技能的归档 = %d want 404（body=%s）", w.Code, w.Body.String())
	}
	if _, ok := out["error"]; !ok {
		t.Fatalf("404 必须是 JSON 错误信封，得到 %s", w.Body.String())
	}

	// ② 已登记但尚未上传归档：仍然是 JSON 404（与预览面同一句话）。
	if w, _ := mreq(t, r, "POST", "/api/server/admin/skills",
		`{"name":"demo","version":"1.0.0"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create skill = %d %s", w.Code, w.Body.String())
	}
	w, out = mreq(t, r, "GET", "/api/server/admin/skills/demo/archive", "", hdr)
	if w.Code != http.StatusNotFound {
		t.Fatalf("未上传归档的下载 = %d want 404", w.Code)
	}
	if _, ok := out["error"]; !ok {
		t.Fatalf("未上传归档的响应必须是 JSON 错误信封，得到 %s", w.Body.String())
	}

	// ③ 上传归档后：200 + 真二进制流 + 版本/校验和头。
	archive := makeZip(t, map[string]string{
		"SKILL.md":            skillMd("demo", "2.0.0"),
		"references/notes.md": "# 参考资料\n\n审批时应当能看到这个文件。\n",
	})
	if w, _ := mreq(t, r, "POST", "/api/server/admin/skills/demo/archive",
		`{"version":"2.0.0","archive":"`+base64.StdEncoding.EncodeToString(archive)+`"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("upload archive = %d %s", w.Code, w.Body.String())
	}
	w, _ = mreq(t, r, "GET", "/api/server/admin/skills/demo/archive", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("归档下载 = %d %s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/zip") {
		t.Fatalf("content-type = %q want application/zip（按归档实际格式嗅探）", ct)
	}
	if !bytes.Equal(w.Body.Bytes(), archive) {
		t.Fatalf("下发字节与上传归档不一致：%d vs %d 字节", w.Body.Len(), len(archive))
	}
	if v := w.Header().Get("X-Skill-Version"); v != "2.0.0" {
		t.Fatalf("X-Skill-Version = %q want 2.0.0", v)
	}
	if w.Header().Get("X-Skill-Checksum") == "" {
		t.Fatal("缺少 X-Skill-Checksum（客户端安装器靠它做 sha256 对照）")
	}
	if cd := w.Header().Get("Content-Disposition"); !strings.Contains(cd, "demo-2.0.0.zip") {
		t.Fatalf("Content-Disposition = %q want 含 demo-2.0.0.zip", cd)
	}
}

func TestAdminAgentArchiveDownload(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()

	// ① 未登记：JSON 404。
	w, out := mreq(t, r, "GET", "/api/server/admin/agents/ghost/archive", "", hdr)
	if w.Code != http.StatusNotFound {
		t.Fatalf("未登记智能体的归档 = %d want 404（body=%s）", w.Code, w.Body.String())
	}
	if _, ok := out["error"]; !ok {
		t.Fatalf("404 必须是 JSON 错误信封，得到 %s", w.Body.String())
	}

	// ② 已登记但没有任何 approved 版本：JSON 404（不是空流）。
	if w, _ := mreq(t, r, "POST", "/api/server/admin/agents",
		`{"name":"ppt-gen","description":"PPT 生成","author":"boss"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create agent = %d %s", w.Code, w.Body.String())
	}
	w, out = mreq(t, r, "GET", "/api/server/admin/agents/ppt-gen/archive", "", hdr)
	if w.Code != http.StatusNotFound {
		t.Fatalf("未发布版本的下载 = %d want 404", w.Code)
	}
	if _, ok := out["error"]; !ok {
		t.Fatalf("未发布版本的响应必须是 JSON 错误信封，得到 %s", w.Body.String())
	}

	// ③ 上传归档后：200 + 真二进制流 + 版本/校验和头。
	archive := agentArchive(t, "1.0.0", "PPT 生成器")
	if w, _ := mreq(t, r, "POST", "/api/server/admin/agents/ppt-gen/archive",
		`{"version":"1.0.0","archive":"`+base64.StdEncoding.EncodeToString(archive)+`"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("upload agent archive = %d %s", w.Code, w.Body.String())
	}
	w, _ = mreq(t, r, "GET", "/api/server/admin/agents/ppt-gen/archive", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("智能体归档下载 = %d %s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/zip") {
		t.Fatalf("content-type = %q want application/zip", ct)
	}
	if !bytes.Equal(w.Body.Bytes(), archive) {
		t.Fatalf("下发字节与上传归档不一致：%d vs %d 字节", w.Body.Len(), len(archive))
	}
	if v := w.Header().Get("X-Preset-Version"); v != "1.0.0" {
		t.Fatalf("X-Preset-Version = %q want 1.0.0", v)
	}
	if w.Header().Get("X-Preset-Checksum") == "" {
		t.Fatal("缺少 X-Preset-Checksum")
	}
}

// TestAdminAgentFileContentTooLargeKey：市场智能体的逐文件审核面必须与
// webadmin 的 `FileContentData`（以及组织侧 `/agent-presets/:name/:version/file`）
// 用**同一个键名** `too_large`。
//
// 缺陷现场：该分支此前写的是 `tooLarge`（驼峰），而 webadmin 的归档预览弹层读
// `file?.too_large` —— 于是市场智能体的超大文件**永不显示**「文件过大 → 下载归档」
// 入口（技能侧是 `too_large`，所以只有智能体这条静默失效）。这是一个跨端契约键，
// 只能靠断言钉住：两端各自"自证"都测不出来。
//
// 变异验证：把键名改回 `tooLarge` ⇒ 本用例红。
func TestAdminAgentFileContentTooLargeKey(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()

	if w, _ := mreq(t, r, "POST", "/api/server/admin/agents",
		`{"name":"ppt-gen","description":"PPT 生成","author":"boss"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create agent = %d %s", w.Code, w.Body.String())
	}
	// 128 KiB 是审核预览的内联上限（agentshare.maxFilePreviewBytes）——超一个字节即
	// 走 too_large 分支。
	big := strings.Repeat("A", 128<<10+1)
	files := map[string]string{
		"agent.cordis.yml": "- id: persona\n  name: '@deepseek-ai/dsh-persona'\n",
		"preset.yml": "name: PPT 生成器\nversion: 1.0.0\ndescription: 用于演示超大文件审核入口的测试智能体\n" +
			"author: bob\ncategory: demo\nchangelog: 首次发布\n",
		"references/big.txt": big,
	}
	archive := makeZip(t, files)
	if w, _ := mreq(t, r, "POST", "/api/server/admin/agents/ppt-gen/archive",
		`{"version":"1.0.0","archive":"`+base64.StdEncoding.EncodeToString(archive)+`"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("upload agent archive = %d %s", w.Code, w.Body.String())
	}

	w, out := mreq(t, r, "GET", "/api/server/admin/agents/ppt-gen/file?path=references%2Fbig.txt", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("逐文件审核 = %d %s", w.Code, w.Body.String())
	}
	if _, ok := out["too_large"]; !ok {
		t.Fatalf("响应缺少 too_large 键（webadmin 读的就是它）：%v", out)
	}
	if out["too_large"] != true {
		t.Fatalf("too_large = %v want true（%d 字节 > 128 KiB 内联上限）", out["too_large"], len(big))
	}
	if _, stale := out["tooLarge"]; stale {
		t.Fatalf("响应里仍有驼峰 tooLarge（跨端契约键只能是 too_large）：%v", out)
	}
}
