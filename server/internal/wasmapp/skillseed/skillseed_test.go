package skillseed

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/archiveutil"
	"github.com/picoaide/picoaide/internal/skillmanifest"
)

// repoSkillDir 是本仓真实的内置技能**源树**目录（`server/skills/` 那一棵）。
// 它只用于"打包器本身"的单元用例（PackDir 的确定性、路径闸）。
//
// ⚠️ 凡是要问「下发给员工的这份资产如何如何」（能不能过闸门 / 运行期装载 / 接口契约 /
// 摘要）的用例，对象都必须是 `imageSkillDir` 装配出来的**镜像里那一棵树**：源树比下发树
// 少一个构建期注入的文件（`skillFileInjections`），打源树等于答错了题。
//
// 目录名从 repoSkillsRoot（builtin_skills_test.go）拼出来：**技能集合**本身由那张登记表
// 与三方对账判据守着（R13-F-05），这里只钉 app-builder 这一条真资产的细节。
const repoSkillDir = repoSkillsRoot + "/app-builder"

// seededSkillVersion 是真资产 SKILL.md 里的 version。
//
// ⚠️ 改技能内容必须**同步提这个版本号**（R1-pm-8：内容变了版本没变 ⇒ 客户端判不出
// "有更新"，装过的员工永远拿不到新版手册）。这条纪律由 skill_version_test.go 的
// TestBuiltinSkillVersionTracksContent 用"内容摘要 → 版本"登记表守住；这里只是把
// 断言里的字面量收敛到一处。
const seededSkillVersion = "2.12.0"

// dropSkillVersion 从 SKILL.md 文本里删掉 version 那一行（坏资产夹具）。
// 用正则而不是字面量替换：版本号提级时夹具不会跟着烂掉。
func dropSkillVersion(t *testing.T, raw string) string {
	t.Helper()
	broken := regexp.MustCompile(`(?m)^version: .*\n`).ReplaceAllString(raw, "")
	if broken == raw {
		t.Fatal("前置：未能从 SKILL.md 删掉 version")
	}
	return broken
}

func testRouter(h *Handlers) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	// 与生产同路径（认证不在这里测：router 包另有用例钉 BearerAuth 分组）。
	r.GET("/api/client/v2/skills/builtin", h.ListBuiltin)
	r.GET("/api/client/v2/skills/builtin/:name/archive", h.BuiltinDownload)
	return r
}

func doGet(t *testing.T, r *gin.Engine, path string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
	return w
}

func TestPackDirIsDeterministic(t *testing.T) {
	first, files, err := PackDir(repoSkillDir)
	if err != nil {
		t.Fatalf("PackDir: %v", err)
	}
	second, files2, err := PackDir(repoSkillDir)
	if err != nil {
		t.Fatalf("PackDir(2): %v", err)
	}
	if !bytes.Equal(first, second) {
		t.Fatalf("同一份源目录两次打包必须逐字节一致（sha256 才是可信凭据）")
	}
	if files != files2 || files < 10 {
		t.Fatalf("包内普通文件数 = %d/%d，want 相等且 >= 10", files, files2)
	}
	// 确定性还意味着跨进程稳定：同一次运行里 sha256 必须与 archiveutil 的
	// 计算一致（客户端就是拿这个值对拍）。
	sum, err := archiveutil.Validate(first, archiveutil.DefaultLimits(SkillFile))
	if err != nil {
		t.Fatalf("archiveutil.Validate: %v", err)
	}
	want := sha256.Sum256(first)
	if sum != hex.EncodeToString(want[:]) {
		t.Fatalf("checksum 口径不一致: %s vs %s", sum, hex.EncodeToString(want[:]))
	}
}

// 内置资产必须能通过**服务端既有的** manifest 校验（与管理员上传同一个
// skillmanifest.Parse）。这条直接打真资产：frontmatter 少一个必填字段就红。
//
// ⚠️ 对象是**镜像里那一棵树**（`imageSkillDir` = 磁盘技能源树 + `server/Dockerfile`
// 最终阶段注入的文件），不是磁盘源树：解耦后下发的那棵树比源树多一个文件（注入的打包器），
// 打源树就等于答错了题 —— 注入文件过不了闸门（尺寸/条目/路径/manifest 规则）时这条仍然绿，
// 而运行期 `skillseed` 会把整条技能记成坏资产跳过（清单为空、员工装不到，只在启动日志与
// 管理端诊断里可见）。"判据描述的对象 ≠ 运行期读的对象"正是本仓反复登记的假绿形态。
func TestRealAssetPassesServerManifestValidation(t *testing.T) {
	// 前置：注入登记不得为空，否则本用例会静默退化成"只打磁盘源树"（覆盖面凭空少一半）。
	injectionsByKey, _ := registeredSkillInjections(t)
	injected := make([]skillFileInjection, 0, len(injectionsByKey))
	for _, inj := range sortedInjections(injectionsByKey) {
		if inj.Skill == "app-builder" {
			injected = append(injected, inj)
		}
	}
	if len(injected) == 0 {
		t.Fatal("app-builder 没有任何注入文件登记 —— 前置不成立：本用例必须覆盖镜像树里的每一个文件")
	}
	skillDir := imageSkillDir(t, "app-builder")
	archive, _, err := PackDir(skillDir)
	if err != nil {
		t.Fatalf("PackDir(%s): %v", skillDir, err)
	}
	lim := archiveutil.DefaultLimits(SkillFile)
	if _, err := archiveutil.Validate(archive, lim); err != nil {
		t.Fatalf("archiveutil.Validate: %v", err)
	}
	entries, skillMD, err := archiveutil.ListContents(archive, lim, manifestPreviewBytes)
	if err != nil {
		t.Fatalf("ListContents: %v", err)
	}
	m, err := skillmanifest.Parse(entries, skillMD, "app-builder")
	if err != nil {
		t.Fatalf("skillmanifest.Parse 必须通过（内置技能走与上传完全相同的校验）: %v", err)
	}
	if m.AppID != "app-builder" || m.Version != seededSkillVersion {
		t.Fatalf("manifest = %q/%q", m.AppID, m.Version)
	}
	if m.Title == "" || m.Author == "" || m.Category == "" {
		t.Fatalf("title/author/category 不得为空: %+v", m)
	}
	if len(m.Description) < skillmanifest.MinDescriptionRunes {
		t.Fatalf("description 过短")
	}
	// 非 .md 文件必须真的进包（examples/ 是「照着 skill 做」的模板 +
	// scripts/ 下的注入文件 —— 技能文档按这个相对路径引用它）。
	for _, want := range []string{
		"SKILL.md",
		"references/abi.md",
		"references/imports.md",
		"references/limits.md",
		"references/publishing.md",
		"references/diagnostics.md",
		"examples/go/main.go",
		"examples/go/go.mod",
		"examples/go/picoaide.app.json",
		"examples/go/preview.mjs",
		"examples/go/README.md",
	} {
		found := false
		for _, e := range entries {
			if e == want {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("归档缺少条目 %q（entries=%v）", want, entries)
		}
	}
	// 注入文件必须真的进包，且逐字节等于中性源那一份（镜像里的技能文件 == 中性源字节，
	// 这是"两个落点同源 ⇒ 规则不会漂"的前提；少一条 ⇒ 员工装到的技能缺这个文件）。
	for _, inj := range injected {
		want, rerr := os.ReadFile(filepath.Join(repoServerRoot, filepath.FromSlash(inj.Source)))
		if rerr != nil {
			t.Fatalf("读中性源 %s: %v", inj.Source, rerr)
		}
		got, _, found, binary, _, xerr := archiveutil.ExtractFileContent(archive, inj.Dest, manifestPreviewBytes)
		if xerr != nil {
			t.Fatalf("ExtractFileContent(%s): %v", inj.Dest, xerr)
		}
		if !found || binary {
			t.Fatalf("注入文件 %s 没进包（found=%v binary=%v，entries=%v）—— "+
				"镜像里的技能目录缺这个文件，而技能文档仍按该相对路径引用它", inj.Dest, found, binary, entries)
		}
		if got != string(want) {
			t.Fatalf("包内 %s 与中性源 %s 不一致（注入必须逐字节同源）", inj.Dest, inj.Source)
		}
	}
	// SKILL.md 必须逐字是装配出来的那棵树上那份（打包不得改写内容）。
	raw, err := os.ReadFile(filepath.Join(skillDir, SkillFile))
	if err != nil {
		t.Fatal(err)
	}
	got, _, _, _, _, err := archiveutil.ExtractFileContent(archive, SkillFile, manifestPreviewBytes)
	if err != nil {
		t.Fatalf("ExtractFileContent: %v", err)
	}
	if got != string(raw) {
		t.Fatalf("包内 SKILL.md 与磁盘内容不一致")
	}
}

// 路径闸的变异验证对象：去掉归一化 ⇒ 前四条必须变红。
func TestPackEntryNameRejectsTraversalAndAbsolute(t *testing.T) {
	bad := map[string]string{
		"../evil.md":             "上跳",
		"a/../../evil.md":        "中段上跳",
		"/etc/passwd":            "绝对路径",
		"\\windows\\evil.txt":    "反斜杠绝对路径",
		"C:\\temp\\evil.txt":     "盘符绝对路径",
		".picoaide/release.json": "安装器溯源目录",
	}
	for rel, reason := range bad {
		if _, _, err := packEntryName(rel); err == nil {
			t.Fatalf("packEntryName(%q) 必须拒绝（%s）", rel, reason)
		}
	}
	good := map[string]string{
		"./SKILL.md":          "SKILL.md",
		"a/./b/c.md":          "a/b/c.md",
		"references\\abi.md":  "references/abi.md",
		"examples/go/main.go": "examples/go/main.go",
	}
	for rel, want := range good {
		got, skip, err := packEntryName(rel)
		if err != nil {
			t.Fatalf("packEntryName(%q): %v", rel, err)
		}
		if skip || got != want {
			t.Fatalf("packEntryName(%q) = %q(skip=%v), want %q", rel, got, skip, want)
		}
	}
	// 包根自身：跳过而不是产出空名条目（空名条目在客户端是拒绝项）。
	if _, skip, err := packEntryName("./"); err != nil || !skip {
		t.Fatalf("packEntryName(\"./\") 必须 skip（err=%v skip=%v）", err, skip)
	}
}

func TestPackDirRejectsSymlinkAndProvenanceDir(t *testing.T) {
	t.Run("symlink", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, SkillFile), []byte("---\nname: x\n---\nbody"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink("/etc/passwd", filepath.Join(dir, "leak.txt")); err != nil {
			t.Skipf("symlink 不可用: %v", err)
		}
		if _, _, err := PackDir(dir); err == nil || !strings.Contains(err.Error(), "符号链接") {
			t.Fatalf("符号链接必须被拒，得到 %v", err)
		}
	})
	t.Run("provenance dir", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, SkillFile), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(dir, provenanceDir), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, provenanceDir, "release.json"), []byte("{}"), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, _, err := PackDir(dir); err == nil || !strings.Contains(err.Error(), provenanceDir) {
			t.Fatalf("%s 目录必须被拒，得到 %v", provenanceDir, err)
		}
	})
	t.Run("missing SKILL.md", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "notes.md"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, _, err := PackDir(dir); err == nil || !strings.Contains(err.Error(), SkillFile) {
			t.Fatalf("根部缺 %s 必须被拒，得到 %v", SkillFile, err)
		}
	})
}

// 条目数 / 解包总量闸门（复用 archiveutil 的既有常量，测试把上限临时收窄）。
func TestPackDirEnforcesCaps(t *testing.T) {
	orig := limits
	t.Cleanup(func() { limits = orig })

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, SkillFile), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"a.txt", "b.txt", "c.txt", "d.txt"} {
		if err := os.WriteFile(filepath.Join(dir, n), []byte("0123456789"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	limits = archiveutil.DefaultLimits(SkillFile)
	limits.MaxEntries = 3
	if _, _, err := PackDir(dir); err == nil || !strings.Contains(err.Error(), "条目数超过上限") {
		t.Fatalf("条目数闸门失效: %v", err)
	}

	limits = archiveutil.DefaultLimits(SkillFile)
	limits.MaxUnpackedBytes = 8
	if _, _, err := PackDir(dir); err == nil || !strings.Contains(err.Error(), "解包总量超过上限") {
		t.Fatalf("解包总量闸门失效: %v", err)
	}

	limits = archiveutil.DefaultLimits(SkillFile)
	limits.MaxArchiveBytes = 16
	if _, _, err := PackDir(dir); err == nil || !strings.Contains(err.Error(), "归档超过上限") {
		t.Fatalf("归档体积闸门失效: %v", err)
	}
}

// 纵深防御：假定有人绕过了打包侧的路径闸（比如资产目录被换成手写的 tar），
// 交给 archiveutil 的那一道必须仍然拦得住 —— 我们打包后确实调了它。
func TestArchiveutilStillRejectsTraversalArchive(t *testing.T) {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	body := []byte("pwned")
	if err := tw.WriteHeader(&tar.Header{Name: "../evil.md", Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(body); err != nil {
		t.Fatal(err)
	}
	if err := tw.WriteHeader(&tar.Header{Name: SkillFile, Mode: 0o644, Size: 4, Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte("body")); err != nil {
		t.Fatal(err)
	}
	_ = tw.Close()
	_ = gz.Close()
	if _, err := archiveutil.Validate(buf.Bytes(), archiveutil.DefaultLimits(SkillFile)); err == nil {
		t.Fatalf("含 ../ 的归档必须被 archiveutil 拒绝")
	}
}

func TestCatalogLoadsRealAssetAndServesContract(t *testing.T) {
	dir := t.TempDir()
	copyTree(t, imageSkillDir(t, "app-builder"), filepath.Join(dir, "app-builder"))
	c := New(dir)
	h := NewHandlers(c)
	r := testRouter(h)

	// 清单
	w := doGet(t, r, "/api/client/v2/skills/builtin")
	if w.Code != http.StatusOK {
		t.Fatalf("list = %d %s", w.Code, w.Body.String())
	}
	var payload struct {
		Skills []struct {
			Name, Version, Title, Description, Author, Category, SHA256, Source string
			Size                                                                int64
			Files                                                               int
		} `json:"skills"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatalf("list JSON: %v", err)
	}
	if len(payload.Skills) != 1 {
		t.Fatalf("skills = %d, want 1", len(payload.Skills))
	}
	row := payload.Skills[0]
	if row.Name != "app-builder" || row.Version != seededSkillVersion || row.Source != "builtin" {
		t.Fatalf("row = %+v", row)
	}
	if row.Title == "" || row.Description == "" || row.Author == "" || row.Category == "" {
		t.Fatalf("清单必须带展示元数据: %+v", row)
	}
	if row.Size <= 0 || row.Files < 10 || len(row.SHA256) != 64 {
		t.Fatalf("清单必须带 sha256/size/files: %+v", row)
	}

	// 归档 + 两个契约响应头
	w = doGet(t, r, "/api/client/v2/skills/builtin/app-builder/archive")
	if w.Code != http.StatusOK {
		t.Fatalf("archive = %d %s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/gzip" {
		t.Fatalf("Content-Type = %q", ct)
	}
	// sha256 校验是客户端安装的完整性凭据：头必须等于正文的 sha256。
	sum := sha256.Sum256(w.Body.Bytes())
	if got := w.Header().Get("X-Skill-Checksum"); got != hex.EncodeToString(sum[:]) {
		t.Fatalf("X-Skill-Checksum = %q, 正文 sha256 = %q", got, hex.EncodeToString(sum[:]))
	}
	if got := w.Header().Get("X-Skill-Checksum"); got != row.SHA256 {
		t.Fatalf("清单 sha256(%s) 与响应头(%s) 必须一致", row.SHA256, got)
	}
	if got := w.Header().Get("X-Skill-Version"); got != seededSkillVersion {
		t.Fatalf("X-Skill-Version = %q", got)
	}
	if !strings.Contains(w.Header().Get("Content-Disposition"), "app-builder-"+seededSkillVersion+".tar.gz") {
		t.Fatalf("Content-Disposition = %q", w.Header().Get("Content-Disposition"))
	}
	// 正文必须真的是 tar.gz 且能过 archiveutil（客户端装的就是这份字节）。
	if format := archiveutil.Format(w.Body.Bytes()); format != "tar.gz" {
		t.Fatalf("format = %q", format)
	}
	if _, err := archiveutil.Validate(w.Body.Bytes(), archiveutil.DefaultLimits(SkillFile)); err != nil {
		t.Fatalf("下发的归档必须能过 archiveutil: %v", err)
	}

	// 未知名 → 404 JSON 信封（不泄露内部诊断）。
	w = doGet(t, r, "/api/client/v2/skills/builtin/../evil/archive")
	if w.Code != http.StatusNotFound {
		t.Fatalf("穿越名必须 404（实际 %d）", w.Code)
	}
	w = doGet(t, r, "/api/client/v2/skills/builtin/nope/archive")
	if w.Code != http.StatusNotFound || !strings.Contains(w.Body.String(), "NOT_FOUND") {
		t.Fatalf("未知名 = %d %s", w.Code, w.Body.String())
	}
}

// 坏资产必须被**丢掉并记录原因**，而不是以「能装上一个坏技能」的方式下发。
// 这里把真资产的 version 删掉 —— manifest 校验少一个必填字段。
func TestCatalogDropsBrokenAssetAndRecordsProblem(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "app-builder")
	copyTree(t, imageSkillDir(t, "app-builder"), target)
	raw, err := os.ReadFile(filepath.Join(target, SkillFile))
	if err != nil {
		t.Fatal(err)
	}
	broken := dropSkillVersion(t, string(raw))
	if err := os.WriteFile(filepath.Join(target, SkillFile), []byte(broken), 0o644); err != nil {
		t.Fatal(err)
	}
	c := New(root)
	if err := c.Load(); err != nil {
		t.Fatalf("Load: %v", err)
	}
	if got := len(c.Entries()); got != 0 {
		t.Fatalf("缺必填字段的技能必须被丢弃，实际 %d 条", got)
	}
	problems := c.Problems()
	if len(problems) != 1 || !strings.Contains(problems[0], "version") {
		t.Fatalf("必须记录被跳过的原因（含字段名 version），得到 %v", problems)
	}
}

// 资产目录不存在不是错误（本地 `make build-server` 的二进制旁边没有
// /opt/picoaide/skills），但清单必须是空数组而不是 null。
func TestCatalogMissingDirIsEmptyNotError(t *testing.T) {
	c := New(filepath.Join(t.TempDir(), "nope"))
	h := NewHandlers(c)
	w := doGet(t, testRouter(h), "/api/client/v2/skills/builtin")
	if w.Code != http.StatusOK {
		t.Fatalf("list = %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), `"skills":[]`) {
		t.Fatalf("空清单必须是 []，得到 %s", w.Body.String())
	}
}

// 目录名不是合法应用 ID 的目录直接跳过（不然它会以非法 name 进清单）。
func TestCatalogSkipsNonAppIDDirectory(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "Bad_Name")
	copyTree(t, imageSkillDir(t, "app-builder"), target)
	c := New(root)
	if err := c.Load(); err != nil {
		t.Fatal(err)
	}
	if len(c.Entries()) != 0 {
		t.Fatalf("非法目录名必须被跳过: %+v", c.Entries())
	}
	if len(c.Problems()) != 1 {
		t.Fatalf("problems = %v", c.Problems())
	}
}

// TestExportArchiveForE2E 把**服务端真正会下发的那串字节**写到
// $SKILLSEED_E2E_OUT，供跨语言端到端脚本使用（客户端是 JS 写的，只能这样把
// "Go 打的包"喂给"真的安装器"）。
//
// 未设置该环境变量时直接跳过 —— 它不是常规回归用例（常规断言在上面那些用例里），
// 而是给 E2E 脚本用的取证出口。跑法见 temp/skillseed-e2e/README.md。
func TestExportArchiveForE2E(t *testing.T) {
	out := os.Getenv("SKILLSEED_E2E_OUT")
	if out == "" {
		t.Skip("SKILLSEED_E2E_OUT 未设置（这是给跨语言 E2E 脚本用的取证出口）")
	}
	// 出口里的字节必须是**服务端真正会下发的那一串** ⇒ 打镜像里那一棵树
	// （磁盘源树 + Dockerfile 最终阶段注入的文件），不是源树。
	archive, files, err := PackDir(imageSkillDir(t, "app-builder"))
	if err != nil {
		t.Fatalf("PackDir: %v", err)
	}
	if err := os.WriteFile(out, archive, 0o644); err != nil {
		t.Fatalf("write %s: %v", out, err)
	}
	sum := sha256.Sum256(archive)
	t.Logf("exported %d bytes / %d files / sha256=%s", len(archive), files, hex.EncodeToString(sum[:]))
}

// ===== 管理端只读诊断面（GET /api/server/admin/skills/builtin，2026-09-19）=====
//
// 用户原话「我在能力中心里看不到这个」的背后是管理端**完全没有内置技能面**：
// 服务端带了什么技能、哪条技能因为什么被跳过，只有启动日志里能看到。这些用例钉住
// 诊断面的三条形状：正常、坏了（200 + problems 而非空数组）、目录不存在。

// adminTestRouter 与生产同路径（权限/认证在 router 包另行钉住）。
func adminTestRouter(h *Handlers) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/server/admin/skills/builtin", h.AdminListBuiltin)
	return r
}

func TestAdminListBuiltinReportsRealAsset(t *testing.T) {
	dir := t.TempDir()
	copyTree(t, imageSkillDir(t, "app-builder"), filepath.Join(dir, "app-builder"))
	h := NewHandlers(New(dir))
	w := doGet(t, adminTestRouter(h), "/api/server/admin/skills/builtin")
	if w.Code != http.StatusOK {
		t.Fatalf("admin list = %d %s", w.Code, w.Body.String())
	}
	var payload struct {
		Dir      string `json:"dir"`
		DirExist bool   `json:"dir_exists"`
		Skills   []struct {
			Name, Version, Title, Description, Author, Category, SHA256 string
			Size                                                        int64
			Files                                                       int
		} `json:"skills"`
		Problems []struct{ Name, Reason string } `json:"problems"`
		Counts   struct {
			Skills   int `json:"skills"`
			Problems int `json:"problems"`
		} `json:"counts"`
		LoadError string `json:"load_error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatalf("admin list JSON: %v", err)
	}
	if payload.Dir != dir || !payload.DirExist {
		t.Fatalf("诊断面必须回显扫描目录与存在性: dir=%q exists=%v", payload.Dir, payload.DirExist)
	}
	if payload.LoadError != "" {
		t.Fatalf("正常扫描不得带 load_error: %q", payload.LoadError)
	}
	if len(payload.Skills) != 1 || payload.Skills[0].Name != "app-builder" {
		t.Fatalf("skills = %+v", payload.Skills)
	}
	row := payload.Skills[0]
	if row.Version != seededSkillVersion || len(row.SHA256) != 64 || row.Size <= 0 || row.Files < 10 {
		t.Fatalf("管理端清单必须带 version/sha256/size/files: %+v", row)
	}
	if row.Title == "" || row.Author == "" || row.Category == "" || row.Description == "" {
		t.Fatalf("管理端清单必须带展示元数据: %+v", row)
	}
	if len(payload.Problems) != 0 {
		t.Fatalf("正常资产不得有 problems: %+v", payload.Problems)
	}
	// 空数组而不是 null：前端不必判空。
	if !strings.Contains(w.Body.String(), `"problems":[]`) {
		t.Fatalf("problems 必须是 []（不是 null）: %s", w.Body.String())
	}
	if payload.Counts.Skills != 1 || payload.Counts.Problems != 0 {
		t.Fatalf("counts = %+v", payload.Counts)
	}
}

// 这是本次新增面的**核心价值**：技能坏掉时客户端只看到"空清单"，管理端必须看到
// 「哪条技能 + 为什么」—— 而且必须仍是 200（页面要能渲染出来）。
func TestAdminListBuiltinReportsSkippedSkillWithReason(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "app-builder")
	copyTree(t, imageSkillDir(t, "app-builder"), target)
	raw, err := os.ReadFile(filepath.Join(target, SkillFile))
	if err != nil {
		t.Fatal(err)
	}
	broken := dropSkillVersion(t, string(raw))
	if err := os.WriteFile(filepath.Join(target, SkillFile), []byte(broken), 0o644); err != nil {
		t.Fatal(err)
	}
	h := NewHandlers(New(root))
	w := doGet(t, adminTestRouter(h), "/api/server/admin/skills/builtin")
	if w.Code != http.StatusOK {
		t.Fatalf("坏资产也必须 200（页面要能显示原因），得到 %d %s", w.Code, w.Body.String())
	}
	var payload struct {
		DirExist bool                            `json:"dir_exists"`
		Skills   []struct{ Name string }         `json:"skills"`
		Problems []struct{ Name, Reason string } `json:"problems"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatalf("admin list JSON: %v", err)
	}
	if !payload.DirExist {
		t.Fatal("目录存在（只是内容坏了），dir_exists 必须为 true")
	}
	if len(payload.Skills) != 0 {
		t.Fatalf("坏资产不得进清单: %+v", payload.Skills)
	}
	if len(payload.Problems) != 1 || payload.Problems[0].Name != "app-builder" {
		t.Fatalf("必须点名被跳过的技能: %+v", payload.Problems)
	}
	if !strings.Contains(payload.Problems[0].Reason, "version") {
		t.Fatalf("必须带上原因（含字段名 version）: %q", payload.Problems[0].Reason)
	}
}

// 「目录名 ≠ frontmatter name」是**最隐蔽**的一种坏法（skillseed 用目录名当
// declaredAppID 调 skillmanifest.Parse）：接口 200 + 空数组 + 一句日志。
// 诊断面必须把它讲清楚。
func TestAdminListBuiltinExplainsDirNameMismatch(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "app-builder")
	copyTree(t, imageSkillDir(t, "app-builder"), target)
	raw, err := os.ReadFile(filepath.Join(target, SkillFile))
	if err != nil {
		t.Fatal(err)
	}
	mismatch := strings.Replace(string(raw), "name: app-builder", "name: picoaide-app-builder", 1)
	if mismatch == string(raw) {
		t.Fatal("前置：未能改写 frontmatter name")
	}
	if err := os.WriteFile(filepath.Join(target, SkillFile), []byte(mismatch), 0o644); err != nil {
		t.Fatal(err)
	}
	w := doGet(t, adminTestRouter(NewHandlers(New(root))), "/api/server/admin/skills/builtin")
	var payload struct {
		Skills   []struct{ Name string }         `json:"skills"`
		Problems []struct{ Name, Reason string } `json:"problems"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatalf("admin list JSON: %v", err)
	}
	if w.Code != http.StatusOK || len(payload.Skills) != 0 || len(payload.Problems) != 1 {
		t.Fatalf("目录名与 name 不一致必须只记问题、不进清单: %d %s", w.Code, w.Body.String())
	}
	if !strings.Contains(payload.Problems[0].Reason, "必须等于") {
		t.Fatalf("原因必须说明目录名/name 一致性: %q", payload.Problems[0].Reason)
	}
}

func TestAdminListBuiltinMissingDirIsNotAnError(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "nope")
	w := doGet(t, adminTestRouter(NewHandlers(New(missing))), "/api/server/admin/skills/builtin")
	if w.Code != http.StatusOK {
		t.Fatalf("目录不存在不是故障（本地直跑二进制就是这种形态）: %d %s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if !strings.Contains(body, `"dir_exists":false`) || !strings.Contains(body, `"skills":[]`) {
		t.Fatalf("必须诚实说明「没有这个目录」而不是报错: %s", body)
	}
	if !strings.Contains(body, `"problems":[]`) {
		t.Fatalf("problems 必须是 []: %s", body)
	}
}

// 资产根目录里的**散文件**：把 SKILL.md 放错层（放在 /opt/picoaide/skills/ 而不是
// /opt/picoaide/skills/<name>/）是最可能的部署配置错误。它们确实不该进清单，但
// **不能静默**：原先 `if !de.IsDir() { continue }` 让管理端只看到"目录存在 + 空清单 +
// 零问题"，而空态文案还指向一个不存在的「被跳过」块（R2-SK-2）。
func TestAdminListBuiltinReportsLooseFilesAtAssetRoot(t *testing.T) {
	root := t.TempDir()
	raw, err := os.ReadFile(filepath.Join(imageSkillDir(t, "app-builder"), SkillFile))
	if err != nil {
		t.Fatal(err)
	}
	for name, data := range map[string][]byte{SkillFile: raw, "notes.txt": []byte("随手放的文件")} {
		if err := os.WriteFile(filepath.Join(root, name), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	h := NewHandlers(New(root))
	w := doGet(t, adminTestRouter(h), "/api/server/admin/skills/builtin")
	if w.Code != http.StatusOK {
		t.Fatalf("散文件形态也必须 200（页面要能显示原因），得到 %d %s", w.Code, w.Body.String())
	}
	var payload struct {
		DirExist bool                            `json:"dir_exists"`
		Skills   []struct{ Name string }         `json:"skills"`
		Problems []struct{ Name, Reason string } `json:"problems"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatalf("admin list JSON: %v", err)
	}
	if !payload.DirExist {
		t.Fatal("目录存在（只是内容没按 <name>/SKILL.md 放），dir_exists 必须为 true")
	}
	if len(payload.Skills) != 0 {
		t.Fatalf("散文件不是技能，不得进清单: %+v", payload.Skills)
	}
	// 数量断言（不是"存在"断言）：两个散文件都要登记 —— 漏一个就是静默丢弃。
	if len(payload.Problems) != 2 {
		t.Fatalf("资产根的两个散文件都必须登记为 problem（want 2）: %+v", payload.Problems)
	}
	names := []string{payload.Problems[0].Name, payload.Problems[1].Name}
	sort.Strings(names)
	if !reflect.DeepEqual(names, []string{SkillFile, "notes.txt"}) {
		t.Fatalf("problem 必须点名具体文件: %v", names)
	}
	for _, p := range payload.Problems {
		if !strings.Contains(p.Reason, "散文件不会被打包下发") {
			t.Fatalf("原因必须给出可执行结论（散文件不下发 + 正确形态）: %q", p.Reason)
		}
	}
	// 启动日志与诊断面同一份事实（main.go 打的就是这个）。
	if got := h.Catalog().Problems(); len(got) != 2 {
		t.Fatalf("Catalog.Problems() 必须与诊断面一致（启动日志用）: %v", got)
	}
}

// 非 UTF-8 的散文件名：Linux 文件名是任意字节串，`encoding/json` 会把每个非法字节
// 编码成 U+FFFD，于是两个**不同**的坏名字在管理端显示成同一个 `��A` —— 管理员据此
// 定位不到具体是哪个文件（2026-09-19 第三轮审计 F3-6）。
//
// 判据不是"名字里出现某个字符"，而是**可区分性**：两个不同非法名在诊断面必须给出
// 不同的表示，且 JSON 必须可解析、无非法编码（非法字节绝不能原样进 JSON —— 那会让
// 前端 JSON.parse 抛错或静默丢字符）。
func TestAdminListBuiltinDisambiguatesNonUTF8Names(t *testing.T) {
	root := t.TempDir()
	// `\xff\xfeA` 与 `\xff\xfdA`：经 JSON 编码后都是 "\ufffd\ufffdA"。
	names := []string{"\xff\xfeA", "\xff\xfdA"}
	for _, name := range names {
		if err := os.WriteFile(filepath.Join(root, name), []byte("x"), 0o644); err != nil {
			t.Skipf("本文件系统不接受非 UTF-8 文件名（%v）—— 该缺陷只在 Linux/Ext4 类文件系统上可复现", err)
		}
	}
	// 先确认文件系统真的把字节原样存下来了（某些文件系统会归一化/拒绝，测试跳过而不是假绿）。
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	stored := make(map[string]bool, len(entries))
	for _, e := range entries {
		if utf8.ValidString(e.Name()) {
			t.Skipf("文件系统把非法字节归一化了（%q 成了合法 UTF-8）—— 该缺陷在此不可复现", e.Name())
		}
		stored[nameBytesHex(e.Name())] = true
	}
	if len(stored) != 2 {
		t.Skipf("文件系统只存下 %d 个非法名（want 2）", len(stored))
	}

	h := NewHandlers(New(root))
	w := doGet(t, adminTestRouter(h), "/api/server/admin/skills/builtin")
	if w.Code != http.StatusOK {
		t.Fatalf("非法文件名也必须 200（页面要能显示原因），得到 %d %s", w.Code, w.Body.String())
	}
	// ① JSON 必须可解析（非法字节不得原样进响应体）。
	var payload struct {
		Problems []struct {
			Name         string `json:"name"`
			NameBytesHex string `json:"name_bytes_hex"`
		} `json:"problems"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatalf("诊断面 JSON 必须可解析（非法 UTF-8 不得原样进 JSON）: %v", err)
	}
	if len(payload.Problems) != 2 {
		t.Fatalf("两个非法名散文件都要登记（want 2）: %+v", payload.Problems)
	}
	// ② 每个问题项都必须带精确字节形态，且**覆盖到全部两个真实文件名** ——
	// 这才是"可区分"的判据：只断言"字段非空"会让两个都指向同一个文件的实现通过。
	got := map[string]bool{}
	for _, p := range payload.Problems {
		if p.NameBytesHex == "" {
			t.Fatalf("非法 UTF-8 名字必须给出 name_bytes_hex（否则两个坏名字在页面上不可区分）: %+v", p)
		}
		raw, err := hex.DecodeString(strings.ReplaceAll(p.NameBytesHex, " ", ""))
		if err != nil {
			t.Fatalf("name_bytes_hex 必须是空格分隔的十六进制: %q (%v)", p.NameBytesHex, err)
		}
		if utf8.Valid(raw) {
			t.Fatalf("name_bytes_hex 对应的字节不该是合法 UTF-8（否则它没必要单列）: %q", p.NameBytesHex)
		}
		got[p.NameBytesHex] = true
	}
	if len(got) != 2 {
		t.Fatalf("两个不同非法名必须给出**不同**的 name_bytes_hex（现在 %d 个不同值）⇒ 管理员仍分不清", len(got))
	}
	for want := range stored {
		if !got[want] {
			t.Fatalf("诊断面漏了真实文件 %q（实际给出 %v）", want, got)
		}
	}
	// ③ 反向断言：合法 UTF-8 名字**不得**填充 name_bytes_hex（正常路径不许多一列噪音）。
	if got := nameBytesHex("SKILL.md"); got != "" {
		t.Fatalf("合法 UTF-8 名字不该有 name_bytes_hex，得到 %q", got)
	}
	if got := nameBytesHex("技能.md"); got != "" {
		t.Fatalf("合法 UTF-8（非 ASCII）名字不该有 name_bytes_hex，得到 %q", got)
	}
}

// copyTree 递归复制目录（测试夹具；符号链接不可用时使用）。
func copyTree(t *testing.T, src, dst string) {
	t.Helper()
	err := filepath.WalkDir(src, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
	if err != nil {
		t.Fatalf("copyTree: %v", err)
	}
}
