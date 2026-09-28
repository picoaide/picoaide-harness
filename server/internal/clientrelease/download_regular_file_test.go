package clientrelease

import (
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// ===========================================================================
// 下载面只下发资产目录内的**普通文件**（第二十七轮审计 AA2-01）
// ===========================================================================
//
// 威胁链：`/updates/client/<file>` 按产品设计**未认证**（客户端装机时还没有登录
// 态），而资产目录由 CI 产物注入（`server/Dockerfile` 的 `COPY --from=clientassets`，
// **不 dereference**），升级路径还会用 `docker cp`（默认同样不跟随链接）刷新它 ——
// 这是一份**不可信输入**。
//
// 旧实现两处都在跟随符号链接：
//   - `os.Stat(full)`（判"存在且是普通文件"）—— 跟随；
//   - `http.ServeFile` —— **按路径二次解析**并再次跟随。
//
// 于是资产目录里一个符号链接就等于把**容器内任意可读文件**挂到了这个未认证
// 端点上（审计实测 `GET /updates/client/evil.dmg => 200`，body 是目录外的文件内容；
// 第二种形态是"清单里登记过的正常文件在运行期被换成链接"，同样 200）。
//
// 修法（与 `internal/channel` 的 assetRegular/openAsset **同源**）：Lstat 拒一切
// 非普通文件 → os.Open 取 fd → f.Stat + os.SameFile 复验 → http.ServeContent 只读
// 这个 fd。本文件把四件事分别钉住：正向不退化、链接被拒且零字节泄露、运行期换链
// 接被拒、校验/打开之间被换掉（TOCTOU）被拒。
// ===========================================================================

// assetSecretMarker 是资产目录之外那个文件的特征串：断言它**不出现在响应体里**。
// "没返回该文件内容"比"状态码不是 200"更贴近真正要保证的事 —— 拒绝路径的 JSON
// 信封也必须干净。
const assetSecretMarker = "TOP-SECRET-OUTSIDE-CLIENT-ASSET-DIR"

// linkAsset 在资产目录里建一个符号链接；环境不支持（如未开开发者模式的 Windows）
// 时跳过，而不是误报红 —— 触发条件构造不出来时断言没有意义。
func linkAsset(t *testing.T, dir, name, target string) {
	t.Helper()
	if err := os.Symlink(target, filepath.Join(dir, name)); err != nil {
		t.Skipf("本环境不支持符号链接（%v）：该用例的触发条件构造不出来", err)
	}
}

// getDownload 在已构造好的路由树上取一个资产。
func getDownload(t *testing.T, r *gin.Engine, path string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
	return w
}

// assertNotFoundNoLeak 断言"拒绝 + 不外泄字节 + 仍是 JSON 信封"。
func assertNotFoundNoLeak(t *testing.T, w *httptest.ResponseRecorder, what string) {
	t.Helper()
	if w.Code != http.StatusNotFound {
		t.Fatalf("%s = %d（body=%q）：非普通文件被下发", what, w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), assetSecretMarker) {
		t.Fatalf("%s 的响应体泄露了资产目录之外的文件内容：%q", what, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"NOT_FOUND"`) {
		t.Fatalf("%s 不是既有的 JSON 404 信封：%q", what, w.Body.String())
	}
}

// ① 正向不退化：资产目录里的**普通文件**照样 200，且字节逐字相同。
func TestDownloadServesRegularAssetByteForByte(t *testing.T) {
	body := strings.Repeat("PicoAide-2.7.0\x00\x01", 128)
	withReleaseDir(t, testInfo(t, "2.7.0", map[string]any{
		"linux-x64": map[string]any{"file": "PicoAide-2.7.0.AppImage", "sha256": testSHA, "size": len(body)},
	}), map[string]string{"PicoAide-2.7.0.AppImage": body})
	r := newRouter("2.7.0")

	w := getDownload(t, r, "/updates/client/PicoAide-2.7.0.AppImage")
	if w.Code != http.StatusOK {
		t.Fatalf("GET 普通安装包 = %d（body=%q），want 200", w.Code, w.Body.String())
	}
	if got := w.Body.String(); got != body {
		t.Fatalf("下载字节与磁盘不一致：len=%d want %d", len(got), len(body))
	}
	// 下发的字节必须来自磁盘上的那个文件（内容一致已足够；这里同时确认
	// 响应头仍是 A-12 那一套，避免换 ServeContent 时把显式头丢掉）。
	if ct := w.Result().Header.Get("Content-Type"); ct != "application/vnd.appimage" {
		t.Errorf("Content-Type = %q，want application/vnd.appimage", ct)
	}
	if cd := w.Result().Header.Get("Content-Disposition"); !strings.Contains(cd, "attachment") {
		t.Errorf("Content-Disposition = %q，want attachment", cd)
	}
}

// ② 资产目录里的**符号链接**（指向目录外真实文件）⇒ 404，且 body 不含目标内容。
// 绝对目标与相对目标两种形态都要覆盖（历史绕过常只堵一种）。
func TestDownloadRejectsSymlinksOutsideAssetDir(t *testing.T) {
	for _, form := range []string{"absolute", "relative"} {
		t.Run(form, func(t *testing.T) {
			withReleaseDir(t, testInfo(t, "2.7.0", map[string]any{
				"linux-x64": map[string]any{"file": "evil.AppImage", "sha256": testSHA, "size": 1},
			}), nil)
			outside := t.TempDir()
			secret := filepath.Join(outside, "secret.txt")
			if err := os.WriteFile(secret, []byte(assetSecretMarker), 0o644); err != nil {
				t.Fatal(err)
			}
			target := secret
			if form == "relative" {
				target = filepath.Join("..", filepath.Base(outside), "secret.txt")
			}
			linkAsset(t, Dir, "evil.AppImage", target)
			r := newRouter("2.7.0")

			assertNotFoundNoLeak(t, getDownload(t, r, "/updates/client/evil.AppImage"),
				"GET 指向目录外的符号链接("+form+")")
		})
	}
}

// ③ 第二种形态（AA2 实测）：**清单里登记过**的正常文件在运行期被换成符号链接。
// 清单仍然宣告它（sha256/size 都在），只有下载面能拦住。
func TestDownloadRejectsRegisteredAssetSwappedToSymlink(t *testing.T) {
	withReleaseDir(t, testInfo(t, "2.7.0", map[string]any{
		"mac-universal": map[string]any{"file": "PicoAide-2.7.0.dmg", "sha256": testSHA, "size": 13},
	}), map[string]string{"PicoAide-2.7.0.dmg": "REAL-DMG-BODY"})
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(secret, []byte(assetSecretMarker), 0o644); err != nil {
		t.Fatal(err)
	}
	r := newRouter("2.7.0")
	// 先确认修前形态的"正常路径"没坏：换成链接**之前**是 200。
	if w := getDownload(t, r, "/updates/client/PicoAide-2.7.0.dmg"); w.Code != http.StatusOK {
		t.Fatalf("换链接之前 GET = %d，want 200", w.Code)
	}
	// 运行期替换：普通文件 → 指向目录外的符号链接。
	if err := os.Remove(filepath.Join(Dir, "PicoAide-2.7.0.dmg")); err != nil {
		t.Fatal(err)
	}
	linkAsset(t, Dir, "PicoAide-2.7.0.dmg", secret)

	assertNotFoundNoLeak(t, getDownload(t, r, "/updates/client/PicoAide-2.7.0.dmg"),
		"GET 登记过的资产在运行期被换成链接")
}

// ④ 目录（含"目录探测"形态）⇒ 404，且不得给出目录列表。
func TestDownloadRejectsDirectoryAsset(t *testing.T) {
	withReleaseDir(t, testInfo(t, "2.7.0", nil), nil)
	if err := os.Mkdir(filepath.Join(Dir, "downloads.dmg"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(Dir, "downloads.dmg", "inner.txt"), []byte("inner"), 0o644); err != nil {
		t.Fatal(err)
	}
	r := newRouter("2.7.0")
	w := getDownload(t, r, "/updates/client/downloads.dmg")
	if w.Code != http.StatusNotFound {
		t.Fatalf("GET 目录 = %d（body=%q），want 404", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), "inner.txt") {
		t.Fatalf("目录内容被列出：%q", w.Body.String())
	}
}

// ⑤ 设备文件不是资产：直接喂 openRegularAsset 一个真实字符设备（os.DevNull）。
//
// 为什么走路径入口而不是端点：构造一个落在资产目录内的设备文件需要 mknod 权限
// （CI runner 上没有），而"按路径打开任意东西"这条判据本身与目录无关 ——
// openRegularAsset 正是端点调用的那一个实现（openAsset 只多做名字形状校验）。
func TestOpenRegularAssetRejectsDeviceFile(t *testing.T) {
	f, info, err := openRegularAsset(os.DevNull)
	if err == nil {
		_ = f.Close()
		t.Fatalf("openRegularAsset(%q) 成功了（info=%v）：设备文件被当成资产", os.DevNull, info)
	}
	if runtime.GOOS != "windows" && !errors.Is(err, errAssetNotRegular) {
		t.Fatalf("os.DevNull 的拒绝理由 = %v，want errAssetNotRegular（必须是类型判据，不是「碰巧打不开」）", err)
	}
}

// ⑥ TOCTOU：**校验（Lstat）与打开（open）之间**路径被换掉 ⇒ 必须拒。
//
// 这个窗口在真实文件系统上没法确定性复现（两次系统调用之间没有可插入的点），
// 所以用 assetOpen 这个注入点在"第 1 步之后、第 2 步之前"精确地把普通文件换成
// 指向目录外的符号链接 —— 这正是 os.SameFile 复验要杀掉的那一瞬间。
//
// 判据要能杀死回退：删掉 openRegularAsset 里的 assetIdentityMatches 复验，
// Lstat 看到的是普通文件、open 拿到的是**另一个**普通文件 ⇒ 本用例立刻变红
// （fd 会被返回，端点就会下发目录外的内容）。
func TestDownloadRejectsSwapBetweenLstatAndOpen(t *testing.T) {
	withReleaseDir(t, testInfo(t, "2.7.0", map[string]any{
		"linux-x64": map[string]any{"file": "PicoAide-2.7.0.AppImage", "sha256": testSHA, "size": 19},
	}), map[string]string{"PicoAide-2.7.0.AppImage": "REAL-ASSET-CONTENT"})
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(secret, []byte(assetSecretMarker), 0o644); err != nil {
		t.Fatal(err)
	}

	prev := assetOpen
	t.Cleanup(func() { assetOpen = prev })
	assetPath := filepath.Join(Dir, "PicoAide-2.7.0.AppImage")
	swapped := false
	assetOpen = func(name string) (*os.File, error) {
		assetOpen = prev // 只换一次：后续请求（若有）按正常形态跑
		if name == assetPath && !swapped {
			swapped = true
			if err := os.Remove(assetPath); err != nil {
				return nil, err
			}
			if err := os.Symlink(secret, assetPath); err != nil {
				return nil, err
			}
		}
		return prev(name)
	}

	r := newRouter("2.7.0")
	assertNotFoundNoLeak(t, getDownload(t, r, "/updates/client/PicoAide-2.7.0.AppImage"),
		"GET 校验与打开之间被换掉的资产")
	if !swapped {
		t.Fatal("注入点没有被触发：用例的触发条件构造失败（判据会假绿）")
	}
}

// ⑦ 结构判据（补谓词级判据的盲区，教训见第二十七轮 AA2-05：只钉函数不钉调用点，
// 删掉调用点按名匹配的用例 100% 绿）：下载端点必须"判据与下发是同一个对象"。
//
//   - file() 里不得再出现 os.Stat / http.ServeFile —— 后者会自己再解析一次路径
//     并重新打开，把 openAsset 的 Lstat/SameFile 整体绕开（这才是修前形态的第二半，
//     只有"换了 ServeContent"这件事被钉住才不会退化）；
//   - openRegularAsset 必须同时出现 Lstat / 打开 / f.Stat / 身份复验四步。
func TestAssetOpeningSequenceIsCallSiteComplete(t *testing.T) {
	src, err := os.ReadFile("clientrelease.go")
	if err != nil {
		t.Fatal(err)
	}
	bodies := funcBodies(t, string(src))
	fileBody, ok := bodies["file"]
	if !ok {
		t.Fatal("clientrelease.go 里找不到 file()：判据已失效，必须同步更新")
	}
	for _, banned := range []string{"http.ServeFile", "os.Stat("} {
		if strings.Contains(fileBody, banned) {
			t.Errorf("file() 里出现了 %s：路径会被第二次解析/跟随，Lstat+SameFile 的校验被绕开", banned)
		}
	}
	for _, want := range []string{"openAsset(", "http.ServeContent"} {
		if !strings.Contains(fileBody, want) {
			t.Errorf("file() 里找不到 %s：下发必须基于已校验的 fd", want)
		}
	}
	openBody, ok := bodies["openRegularAsset"]
	if !ok {
		t.Fatal("clientrelease.go 里找不到 openRegularAsset()：判据已失效，必须同步更新")
	}
	for _, want := range []string{"os.Lstat(", "assetOpen(", ".Stat()", "assetIdentityMatches("} {
		if !strings.Contains(openBody, want) {
			t.Errorf("openRegularAsset() 里找不到 %s：TOCTOU 判据链不完整", want)
		}
	}
}

// funcBodies 取 clientrelease.go 里每个**具名函数**的函数体原文。
//
// 判据只认函数体内的文本：注释里提到 `http.ServeFile`（本仓的注释习惯就是把旧
// 实现写进解释里）与"别的函数里的同名调用"都不算证据，否则这条判据会被自己的
// 文档注释打成假红/假绿。
func funcBodies(t *testing.T, src string) map[string]string {
	t.Helper()
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "clientrelease.go", src, 0)
	if err != nil {
		t.Fatalf("解析 clientrelease.go: %v", err)
	}
	out := map[string]string{}
	for _, decl := range f.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Body == nil {
			continue
		}
		out[fn.Name.Name] = src[fn.Body.Pos()-1 : fn.Body.End()-1]
	}
	return out
}
