// 变异验证方式（CONTEXT §4.3；每条用例都是"闸门去掉即变红"）：
//   - 删掉 validateLogicalPath 里的 `..` 段检查 → TestPathTraversalRejected 红；
//   - 删掉 resolveExisting 的 EvalSymlinks + within 复核 → TestSymlinkEscapeDenied 红；
//   - 把 Write 的 O_EXCL 换成 O_CREATE|O_TRUNC → TestWriteRefusesOverwrite 红；
//   - 把 makeDirs 的 Lstat 符号链接检查换成 os.MkdirAll → TestWriteRejectsSymlinkSegment 红；
//   - 删掉 4 MiB 单文件检查 → TestReadOversizeRejected / TestWriteOversizeRejected 红；
//   - 把 ContentTypeFor 的映射值写进不在 limits.AppResponseContentTypes 的类型 → 闭环门禁用例红。
package assets

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

const (
	testAppID     = "expense-note"
	testReleaseID = "7"
)

// newStore 造一个真实的抽取目录：<tmp>/apps/<app_id>/assets/<release_id>/。
// 返回 store 与数据根（数据根用于把"根外"的文件放进可预期的位置）。
func newStore(t *testing.T) (*Store, string) {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, limits.AppsDirName, testAppID, AssetsDirName, testReleaseID)
	if err := os.MkdirAll(dir, limits.DataDirMode); err != nil {
		t.Fatal(err)
	}
	s, e := Open(root, testAppID, testReleaseID)
	if e != nil {
		t.Fatalf("Open = %v", e)
	}
	return s, root
}

func mustWrite(t *testing.T, s *Store, p string, data []byte) {
	t.Helper()
	if e := s.Write(p, data); e != nil {
		t.Fatalf("Write(%s) = %v", p, e)
	}
}

func mustRead(t *testing.T, s *Store, p string) (string, []byte) {
	t.Helper()
	ct, data, e := s.Read(p)
	if e != nil {
		t.Fatalf("Read(%s) = %v", p, e)
	}
	return ct, data
}

func TestWriteReadRoundTrip(t *testing.T) {
	s, _ := newStore(t)
	mustWrite(t, s, "picoaide.app.json", []byte(`{"login_required":false}`))
	mustWrite(t, s, "index.html", []byte("<h1>hi</h1>"))
	mustWrite(t, s, "static/app.css", []byte("body{}"))
	png := []byte{0x89, 'P', 'N', 'G', 0x00, 0x01, 0xff}
	mustWrite(t, s, "static/logo.png", png)

	if ct, data := mustRead(t, s, "picoaide.app.json"); ct != "application/json" || string(data) != `{"login_required":false}` {
		t.Fatalf("json: ct=%q data=%q", ct, data)
	}
	if ct, _ := mustRead(t, s, "index.html"); ct != "text/html" {
		t.Fatalf("html ct = %q", ct)
	}
	if ct, data := mustRead(t, s, "static/logo.png"); ct != "image/png" || len(data) != len(png) {
		t.Fatalf("png: ct=%q len=%d", ct, len(data))
	}
	if ct, _ := mustRead(t, s, "static/app.css"); ct != "text/css" {
		t.Fatalf("css ct = %q", ct)
	}

	got := s.List()
	want := []string{"index.html", "picoaide.app.json", "static/app.css", "static/logo.png"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("List = %v, want %v（排序、相对逻辑路径、`/` 分隔）", got, want)
	}
}

func TestOpenValidatesDirectoryAndIdentifiers(t *testing.T) {
	root := t.TempDir()
	if _, e := Open(root, testAppID, "9"); e == nil {
		t.Fatal("目录不存在必须拒（发布期必须 MkdirAll）")
	} else if e.Code != apperr.CodeInternal {
		t.Fatalf("code = %s, want INTERNAL（平台状态自相矛盾）", e.Code)
	}

	dir := filepath.Join(root, limits.AppsDirName, testAppID, AssetsDirName, testReleaseID)
	if err := os.MkdirAll(dir, limits.DataDirMode); err != nil {
		t.Fatal(err)
	}
	bad := []struct{ appID, releaseID string }{
		{"../escape", testReleaseID},
		{"Expense-Note", testReleaseID}, // 大写不符 limits.AppIDPattern
		{"expense_note", testReleaseID},
		{testAppID, ".."},
		{testAppID, ".hidden"},
		{testAppID, "a/b"},
		{testAppID, ""},
	}
	for _, b := range bad {
		if _, e := Open(root, b.appID, b.releaseID); e == nil {
			t.Fatalf("Open(%q,%q) 应当拒（标识会进宿主路径）", b.appID, b.releaseID)
		} else if e.Code != apperr.CodeValidation {
			t.Fatalf("Open(%q,%q) code = %s, want VALIDATION", b.appID, b.releaseID, e.Code)
		}
	}
	if _, e := Open("", testAppID, testReleaseID); e == nil {
		t.Fatal("空数据根必须拒")
	}
}

// Store 根必须是**解析后**的绝对路径：数据根本身是符号链接时，前缀比对才挡得住逃逸。
func TestRootIsResolvedAbsolutePath(t *testing.T) {
	real := t.TempDir()
	dir := filepath.Join(real, limits.AppsDirName, testAppID, AssetsDirName, testReleaseID)
	if err := os.MkdirAll(dir, limits.DataDirMode); err != nil {
		t.Fatal(err)
	}
	linkParent := t.TempDir()
	link := filepath.Join(linkParent, "data-root")
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("环境不支持符号链接: %v", err)
	}
	s, e := Open(link, testAppID, testReleaseID)
	if e != nil {
		t.Fatalf("Open(符号链接数据根) = %v", e)
	}
	if !filepath.IsAbs(s.Root()) {
		t.Fatalf("Root = %q, want absolute", s.Root())
	}
	if strings.Contains(s.Root(), linkParent) {
		t.Fatalf("Root = %q, 应当是解析后的真实路径（否则前缀比对形同虚设）", s.Root())
	}
}

// §5.1/§4.4：无路径穿越。任何"宿主文件路径"形态都必须被拒，且**不碰文件系统**。
func TestPathTraversalRejected(t *testing.T) {
	s, root := newStore(t)
	// 在根外放一个诱饵：如果实现真的把 path 当宿主路径用，就会读到它。
	outside := filepath.Join(filepath.Dir(root), "canary.txt")
	if err := os.WriteFile(outside, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	hostile := []struct{ name, path string }{
		{"空路径", ""},
		{"绝对路径", "/etc/passwd"},
		{"绝对路径带点", "/../etc/passwd"},
		{"父目录", "../canary.txt"},
		{"父目录（深）", "static/../../canary.txt"},
		{"单点段", "./x"},
		{"重复斜杠", "static//app.css"},
		{"尾随斜杠", "static/"},
		{"反斜杠", `..\canary.txt`},
		{"盘符", "C:/Windows/win.ini"},
		{"协议形态", "file:///etc/passwd"},
		{"控制字符", "a\x00b"},
		{"换行", "a\nb"},
		{"非规范", "static/./app.css"},
		{"超长", strings.Repeat("a", MaxPathBytes+1)},
	}
	for _, h := range hostile {
		t.Run(h.name, func(t *testing.T) {
			_, _, e := s.Read(h.path)
			if e == nil {
				t.Fatalf("Read(%q) 应当拒", h.path)
			}
			if e.Code != apperr.CodeAssetDenied {
				t.Fatalf("code = %s, want %s（资源路径问题用专属补充码，不指向 DB_DENIED）", e.Code, apperr.CodeAssetDenied)
			}
			if e.Details["reason"] == nil {
				t.Fatalf("必须带 details.reason（%v）", e.Details)
			}
			if e.Status() != 403 {
				t.Fatalf("status = %d, want 403", e.Status())
			}
			if e := s.Write(h.path, []byte("x")); e == nil {
				t.Fatalf("Write(%q) 应当拒", h.path)
			} else if e.Code != apperr.CodeAssetDenied {
				t.Fatalf("Write code = %s, want %s", e.Code, apperr.CodeAssetDenied)
			}
		})
	}
	// 诱饵必须原封不动（证明越界路径根本没被解析成宿主路径）。
	if b, err := os.ReadFile(outside); err != nil || string(b) != "secret" {
		t.Fatalf("根外文件被影响: %q %v", b, err)
	}
}

// 边界：恰好 256 字节的路径允许；单个路径段超过 255 字节（POSIX NAME_MAX）
// 在拼宿主路径之前就被拒，而不是掉到 OS 层变成一句 INTERNAL。
func TestPathLengthBoundary(t *testing.T) {
	s, _ := newStore(t)
	dir := strings.Repeat("a", 127)
	name := strings.Repeat("b", 124) + ".txt"
	logical := dir + "/" + name
	if len(logical) != MaxPathBytes {
		t.Fatalf("夹具长度 = %d, want %d", len(logical), MaxPathBytes)
	}
	mustWrite(t, s, logical, []byte("ok"))
	if _, data := mustRead(t, s, logical); string(data) != "ok" {
		t.Fatal("恰好 256 字节的路径应当可用")
	}
	long := strings.Repeat("c", MaxSegmentBytes+1)
	if _, _, e := s.Read(long); e == nil || e.Code != apperr.CodeAssetDenied || e.Details["reason"] != "segment_too_long" {
		t.Fatalf("单段超长 = %v, want ASSET_DENIED/segment_too_long", e)
	}
	if e := s.Write(long, []byte("x")); e == nil || e.Code != apperr.CodeAssetDenied || e.Details["reason"] != "segment_too_long" {
		t.Fatalf("Write 单段超长 = %v, want ASSET_DENIED/segment_too_long", e)
	}
}

// §5.1 纵深防御（模块 H 审计 P2-4）：抽取目录**本身**是符号链接时，
// Store 绝不允许把宿主目录当资源根。
//
// 缺陷原状：`Open` 对 `apps/<app_id>/assets/<release_id>` 做 EvalSymlinks 后
// **把解析结果当 root**，于是 `<…>/assets/9 → /etc` 会让 `Read("passwd")` 真的
// 读到 `/etc/passwd`（当前攻击者模型下不可达 —— 造链要写数据根 —— 但代价极低）。
//
// 变异验证：把 Open 里的 assertRealSegments / 锚定比对删掉 ⇒ 本用例红。
func TestOpenRejectsSymlinkedExtractionRoot(t *testing.T) {
	// 正例（对照）：正常目录必须照常打开 —— 判据不能把合法部署打成拒。
	s, root := newStore(t)
	mustWrite(t, s, "index.html", []byte("<h1>hi</h1>"))
	if _, data := mustRead(t, s, "index.html"); string(data) != "<h1>hi</h1>" {
		t.Fatalf("正例读失败: %q", data)
	}

	// 反例 1：抽取目录（release 层）指向宿主目录 —— 必须拒，且不得成为资源根。
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "passwd"), []byte("top-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	escape := filepath.Join(root, limits.AppsDirName, testAppID, AssetsDirName, "9")
	if err := os.Symlink(outside, escape); err != nil {
		t.Skipf("环境不支持符号链接: %v", err)
	}
	st, e := Open(root, testAppID, "9")
	if e == nil {
		t.Fatalf("抽取目录是符号链接时必须拒（得到 root=%q）", st.Root())
	}
	if e.Code != apperr.CodeAssetDenied || e.Details["reason"] != "root_escaped" {
		t.Fatalf("code/reason = %s/%v, want ASSET_DENIED/root_escaped", e.Code, e.Details)
	}
	if e.Status() != 403 {
		t.Fatalf("status = %d, want 403", e.Status())
	}

	// 反例 2：抽取目录的**父级**（assets 层）是符号链接 —— 只比最终 realpath 的
	// 判据挡不住这一形态（解析后的锚点会跟着链接走），必须靠段级 Lstat 判据。
	root2 := t.TempDir()
	appDir := filepath.Join(root2, limits.AppsDirName, testAppID)
	if err := os.MkdirAll(appDir, limits.DataDirMode); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(appDir, AssetsDirName)); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(outside, testReleaseID), limits.DataDirMode); err != nil {
		t.Fatal(err)
	}
	st2, e2 := Open(root2, testAppID, testReleaseID)
	if e2 == nil {
		t.Fatalf("assets 目录是符号链接时必须拒（得到 root=%q）", st2.Root())
	}
	if e2.Code != apperr.CodeAssetDenied || e2.Details["reason"] != "symlink_segment" {
		t.Fatalf("code/reason = %s/%v, want ASSET_DENIED/symlink_segment", e2.Code, e2.Details)
	}

	// 反例 3：`apps` 层是符号链接（数据根刚建好时被替换）——同样拒。
	root3 := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root3, limits.AppsDirName)); err != nil {
		t.Fatal(err)
	}
	if _, e3 := Open(root3, testAppID, testReleaseID); e3 == nil ||
		e3.Code != apperr.CodeAssetDenied || e3.Details["reason"] != "symlink_segment" {
		t.Fatalf("apps 目录是符号链接 = %v, want ASSET_DENIED/symlink_segment", e3)
	}
}

// 反例 1 的"内容"判据：审计探针里那条 `Read("passwd") → /etc/passwd` 的反向断言 ——
// 宿主秘密文件绝不能经由抽取目录被读出。
func TestSymlinkedRootNeverLeaksHostFile(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "passwd"), []byte("root:x:0:0"), 0o600); err != nil {
		t.Fatal(err)
	}
	appDir := filepath.Join(root, limits.AppsDirName, testAppID, AssetsDirName)
	if err := os.MkdirAll(appDir, limits.DataDirMode); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(appDir, "9")); err != nil {
		t.Skipf("环境不支持符号链接: %v", err)
	}
	st, e := Open(root, testAppID, "9")
	if e != nil {
		if st != nil {
			t.Fatalf("拒绝时不得返回 Store: %v", st)
		}
		return // 期望路径：Open 直接拒 ⇒ 攻击面不存在
	}
	// 万一 Open 放行（回归），Read 也绝不能读到宿主文件。
	if _, data, rerr := st.Read("passwd"); rerr == nil {
		t.Fatalf("读到了宿主文件内容 %q —— 抽取目录逃逸（纵深防御失效）", data)
	}
}

// §5.1：符号链接不得逃出抽取根（EvalSymlinks + 前缀比对）。
func TestSymlinkEscapeDenied(t *testing.T) {
	s, _ := newStore(t)
	outsideDir := t.TempDir()
	secret := filepath.Join(outsideDir, "secret.txt")
	if err := os.WriteFile(secret, []byte("top-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(s.Root(), "leak.txt")); err != nil {
		t.Skipf("环境不支持符号链接: %v", err)
	}
	if err := os.Symlink(outsideDir, filepath.Join(s.Root(), "leakdir")); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"leak.txt", "leakdir/secret.txt"} {
		_, _, e := s.Read(p)
		if e == nil {
			t.Fatalf("Read(%q) 必须拒（符号链接逃逸）", p)
		}
		if e.Code != apperr.CodeAssetDenied || e.Details["reason"] != "symlink_escape" {
			t.Fatalf("Read(%q) = %s/%v, want ASSET_DENIED/symlink_escape", p, e.Code, e.Details)
		}
		if strings.Join(s.List(), ",") != "" {
			t.Fatalf("List 不应列出读不到的条目: %v", s.List())
		}
	}
	// 指向**根内**的符号链接是允许的（复核的是"解析结果仍在根内"，不是"不许有链接"）。
	mustWrite(t, s, "real.txt", []byte("inside"))
	if err := os.Symlink(filepath.Join(s.Root(), "real.txt"), filepath.Join(s.Root(), "alias.txt")); err != nil {
		t.Fatal(err)
	}
	if _, data := mustRead(t, s, "alias.txt"); string(data) != "inside" {
		t.Fatalf("根内符号链接应当可读，得到 %q", data)
	}
}

func TestWriteRefusesOverwrite(t *testing.T) {
	s, _ := newStore(t)
	mustWrite(t, s, "index.html", []byte("v1"))
	e := s.Write("index.html", []byte("v2"))
	if e == nil {
		t.Fatal("抽取只写一次：覆盖必须拒（§10.5 第 56f 项：改内容 = 发新版）")
	}
	if e.Code != apperr.CodeAssetExists || e.Details["reason"] != "already_exists" || e.Status() != 409 {
		t.Fatalf("code/reason/status = %s/%v/%d, want ASSET_EXISTS/already_exists/409", e.Code, e.Details, e.Status())
	}
	if _, data := mustRead(t, s, "index.html"); string(data) != "v1" {
		t.Fatalf("原文件被改写: %q", data)
	}
}

func TestWriteCreatesParentsAtomically(t *testing.T) {
	s, _ := newStore(t)
	mustWrite(t, s, "static/deep/app.css", []byte("body{}"))
	if _, data := mustRead(t, s, "static/deep/app.css"); string(data) != "body{}" {
		t.Fatalf("data = %q", data)
	}
	entries, err := os.ReadDir(filepath.Join(s.Root(), "static", "deep"))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".picoaide-tmp-") {
			t.Fatalf("残留临时文件 %s（原子写必须清理）", e.Name())
		}
	}
	if len(entries) != 1 {
		t.Fatalf("目录内容 = %v, want 仅 app.css", entries)
	}
}

func TestWriteRejectsSymlinkSegment(t *testing.T) {
	s, _ := newStore(t)
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(s.Root(), "static")); err != nil {
		t.Skipf("环境不支持符号链接: %v", err)
	}
	e := s.Write("static/app.css", []byte("x"))
	if e == nil {
		t.Fatal("父目录是符号链接时必须拒（MkdirAll 会写到根外）")
	}
	if e.Code != apperr.CodeAssetDenied || e.Details["reason"] != "symlink_segment" {
		t.Fatalf("code/reason = %s/%v, want ASSET_DENIED/symlink_segment", e.Code, e.Details)
	}
	if _, err := os.Stat(filepath.Join(outside, "app.css")); err == nil {
		t.Fatal("资源被写到了根外")
	}
}

func TestOversizeRejected(t *testing.T) {
	s, _ := newStore(t)
	big := make([]byte, limits.SectionTotalMaxBytes+1)
	e := s.Write("big.bin", big)
	if e == nil {
		t.Fatal("写超过 4 MiB 必须拒（§4.2 自定义段总量同源）")
	}
	if e.Code != apperr.CodeAssetOversize || e.Status() != 422 {
		t.Fatalf("code/status = %s/%d, want ASSET_OVERSIZE/422", e.Code, e.Status())
	}
	if _, err := os.Stat(filepath.Join(s.Root(), "big.bin")); err == nil {
		t.Fatal("被拒的资源不得落盘")
	}

	// 读侧同样拦（防御：磁盘上不该出现这种文件）。
	full := filepath.Join(s.Root(), "handmade.bin")
	if err := os.WriteFile(full, big, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, e := s.Read("handmade.bin"); e == nil || e.Code != apperr.CodeAssetOversize {
		t.Fatalf("Read 超限文件 = %v, want ASSET_OVERSIZE", e)
	}
}

func TestReadMissingAndDirectory(t *testing.T) {
	s, _ := newStore(t)
	if _, _, e := s.Read("nope.txt"); e == nil || e.Code != apperr.CodeNotFound {
		t.Fatalf("Read(缺失) = %v, want NOT_FOUND", e)
	}
	mustWrite(t, s, "static/app.css", []byte("x"))
	if _, _, e := s.Read("static"); e == nil || e.Code != apperr.CodeNotFound {
		t.Fatalf("Read(目录) = %v, want NOT_FOUND", e)
	}
}

// §5.5 数值/集合单一真源：content-type 映射的值必须落在 §4.8 的限定集合内。
func TestContentTypeMappingClosedSet(t *testing.T) {
	allowed := map[string]bool{}
	for _, ct := range limits.AppResponseContentTypes {
		allowed[ct] = true
	}
	seen := map[string]bool{}
	for ext, ct := range extContentTypes {
		if !allowed[ct] {
			t.Fatalf("扩展名 %s 映射到 %q，不在 limits.AppResponseContentTypes 内（§4.8 限定集合）", ext, ct)
		}
		seen[ct] = true
	}
	for _, ct := range []string{"text/html", "text/plain", "text/css", "text/javascript", "application/json"} {
		if !seen[ct] {
			t.Fatalf("文本类 content-type %q 应当有扩展名映射", ct)
		}
	}
	if got := ContentTypeFor("a.unknown"); got != "application/octet-stream" {
		t.Fatalf("未知扩展名 = %q", got)
	}
	if got := ContentTypeFor("dir.v2/README"); got != "application/octet-stream" {
		t.Fatalf("无扩展名 = %q", got)
	}
	if got := ContentTypeFor("IMG.PNG"); got != "image/png" {
		t.Fatalf("大写扩展名 = %q", got)
	}
}

// text / base64 二选一的判据（§4.2 + §5.1）。
func TestTextPayloadRule(t *testing.T) {
	cases := []struct {
		ct   string
		data []byte
		want bool
	}{
		{"text/plain", []byte("hello"), true},
		{"text/html", []byte("<p>中文</p>"), true},
		{"application/json", []byte(`{"a":1}`), true},
		{"text/plain", []byte{0xff, 0xfe}, false},            // 文本类型但不是合法 UTF-8
		{"application/json", []byte{0xc3, 0x28}, false},      // 同上
		{"image/png", []byte("not really png"), false},       // 二进制类型
		{"application/javascript", []byte("var a=1"), false}, // 非 text/* 且非 json ⇒ base64
		{"application/octet-stream", []byte("x"), false},
	}
	for _, tc := range cases {
		if got := TextPayload(tc.ct, tc.data); got != tc.want {
			t.Fatalf("TextPayload(%q, %v) = %v, want %v", tc.ct, tc.data, got, tc.want)
		}
	}
	// 空资源：文本类算 text（size=0 的应用侧判据见 hostcap 注释）。
	if !TextPayload("text/plain", nil) {
		t.Fatal("空文本资源应走 text 分支（size=0）")
	}
	if got := Base64([]byte("hi")); got != "aGk=" {
		t.Fatalf("Base64 = %q", got)
	}
}

// 抽取目录里混入不可读条目时，List 不得"列得出来但读不到"。
func TestListSkipsUnreadable(t *testing.T) {
	s, _ := newStore(t)
	mustWrite(t, s, "ok.txt", []byte("ok"))
	broken := filepath.Join(s.Root(), "broken.txt")
	if err := os.Symlink(filepath.Join(s.Root(), "missing-target.txt"), broken); err != nil {
		t.Skipf("环境不支持符号链接: %v", err)
	}
	if got := s.List(); strings.Join(got, ",") != "ok.txt" {
		t.Fatalf("List = %v, want [ok.txt]", got)
	}
}

// 上限边界：恰好 4 MiB 的文件可读（不误伤）。
func TestSectionSizeBoundary(t *testing.T) {
	s, _ := newStore(t)
	data := make([]byte, limits.SectionTotalMaxBytes)
	if e := s.Write("exact.bin", data); e != nil {
		t.Fatalf("恰好 4 MiB 应当可写: %v", e)
	}
	if _, got, e := s.Read("exact.bin"); e != nil || len(got) != len(data) {
		t.Fatalf("恰好 4 MiB 应当可读: %v", e)
	}
}
