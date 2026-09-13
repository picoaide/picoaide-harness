package marketplace

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// TestSkillArchiveForReviewRejectsTraversalVersion(P3-4,审计 2026-09-13):
// 磁盘回退路径用 s.Version 拼文件名,legacy 行的 version 可能含 `..`。
// 非法版本一律当作「归档缺失」(返回 nil),绝不读出 cacheDir 之外的文件;
// 合法版本的回退必须保持可用(审核预览不能因加固而失效)。
func TestSkillArchiveForReviewRejectsTraversalVersion(t *testing.T) {
	root := t.TempDir()
	cacheDir := filepath.Join(root, "cache")
	if err := os.MkdirAll(cacheDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// cacheDir 之外(上一级)放一份**能解析**的归档:越界一旦成立就会读到它。
	outsider := filepath.Join(root, "secret.zip")
	if err := os.WriteFile(outsider, makeZip(t, map[string]string{
		"SKILL.md":   skillMd("legacy-skill", "9.9.9"),
		"secret.txt": "TOP-SECRET",
	}), 0o600); err != nil {
		t.Fatal(err)
	}
	// 正向对照:合法版本的磁盘回退仍然可用。
	legit := makeZip(t, map[string]string{"SKILL.md": skillMd("legacy-skill", "1.0.0")})
	if err := os.WriteFile(filepath.Join(cacheDir, "legacy-skill-1.0.0.zip"), legit, 0o600); err != nil {
		t.Fatal(err)
	}
	if raw, msg := skillArchiveForReview(&serverstore.Skill{Name: "legacy-skill", Version: "1.0.0"}, cacheDir); raw == nil {
		t.Fatalf("合法版本的磁盘回退不可用: %s", msg)
	}

	// name-../../../secret.zip 经 Clean 后是 <cacheDir>/../secret.zip。
	for _, version := range []string{
		"../../../secret", "..", "../..", "sub/1.0.0", `..\..\secret`, "",
	} {
		raw, _ := skillArchiveForReview(&serverstore.Skill{Name: "legacy-skill", Version: version}, cacheDir)
		if raw != nil {
			t.Fatalf("version=%q 读出了 cacheDir 之外/非法的归档(泄漏 %d 字节)", version, len(raw))
		}
	}
}

// TestSkillPreviewNotFoundForTraversalVersion 是上面同一不变式的 HTTP 面:
// 存量脏数据(version 含 ..、DB 无归档)的预览必须 404,响应体不得包含
// cacheDir 之外那份归档的任何内容。
func TestSkillPreviewNotFoundForTraversalVersion(t *testing.T) {
	r, db, hdr, cacheDir := marketAdminSetupWithCache(t)
	defer db.Close()

	if w, _ := mreq(t, r, "POST", "/api/server/admin/skills",
		`{"name":"dirty-skill","version":"1.0.0"}`, hdr); w.Code != 200 {
		t.Fatalf("create skill: %d %s", w.Code, w.Body.String())
	}
	// 直接写一行 version 含 .. 的版本(绕过上传校验,模拟 legacy 脏数据);
	// 该行没有归档字节 → 预览走磁盘回退。
	if err := serverstore.ReplaceSkillArchive(db, "dirty-skill", "../../../secret", "deadbeef", nil); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(filepath.Dir(cacheDir), "secret.zip")
	if err := os.WriteFile(outside, makeZip(t, map[string]string{
		"SKILL.md":   skillMd("dirty-skill", "9.9.9"),
		"secret.txt": "TOP-SECRET",
	}), 0o600); err != nil {
		t.Fatal(err)
	}

	if w, _ := mreq(t, r, "GET", "/api/server/admin/skills/dirty-skill/preview", "", hdr); w.Code != 404 {
		t.Fatalf("越界 version 预览 = %d %s, want 404(归档缺失语义)", w.Code, w.Body.String())
	} else if strings.Contains(w.Body.String(), "TOP-SECRET") {
		t.Fatalf("预览泄露了 cacheDir 之外的文件: %s", w.Body.String())
	}
	wf, _ := mreq(t, r, "GET", "/api/server/admin/skills/dirty-skill/file?path=secret.txt", "", hdr)
	if wf.Code != 404 || strings.Contains(wf.Body.String(), "TOP-SECRET") {
		t.Fatalf("逐文件预览 = %d %s, want 404 且无泄露", wf.Code, wf.Body.String())
	}
}
