package clientrelease

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ===========================================================================
// 类型映射与文件名编码的**单元级**判据（R3-A A-12 的另外半边）
// ===========================================================================
//
// 与 download_headers_test.go 分开成两个文件是**有意的**：那一份是纯 HTTP 层
// （只用既有导出面，因此"把 clientrelease.go 换回修复前版本"时它照样编译、
// 照样变红，这正是"修复前红"的证据形状）；本文件引用本次新增的内部符号
// （assetContentType / assetContentTypes / contentDispositionAttachment），
// 在那个实验里会连编译都过不去。两类判据的失败语义不同，不该混在一起。

// TestAssetContentTypeNeverFallsBackToSniffing 覆盖类型映射的两个边界：
//   - 未知扩展名回落 `application/octet-stream`（**不是**嗅探结果）——
//     它经 HTTP 面不可达（allowedAssetName 先挡），所以直接对函数判定；
//   - 映射表必须覆盖白名单里的**每一个**扩展名（新增白名单扩展名时忘了配类型
//     会让该格式静默退化成 octet-stream：功能仍对，但判据不该悄悄变宽）。
func TestAssetContentTypeNeverFallsBackToSniffing(t *testing.T) {
	for ext, want := range map[string]string{
		".dmg":      "application/x-apple-diskimage",
		".exe":      "application/vnd.microsoft.portable-executable",
		".appimage": "application/vnd.appimage",
		".deb":      "application/vnd.debian.binary-package",
		".zip":      "application/zip",
		".tar.gz":   "application/gzip",
		".msi":      "application/x-msi",
		".pkg":      "application/vnd.apple.installer+xml",
	} {
		if got := assetContentType("x" + ext); got != want {
			t.Fatalf("assetContentType(x%s) = %q, want %q", ext, got, want)
		}
	}
	if got := assetContentType("payload.bin"); got != "application/octet-stream" {
		t.Fatalf("未知扩展名必须回落 octet-stream（绝不能是嗅探结果），得到 %q", got)
	}
	// 白名单 ↔ 类型表成对维护：白名单里每个扩展名都必须有类型。
	for _, ext := range allowedAssetExts {
		if _, ok := assetContentTypes[ext]; !ok {
			t.Fatalf("白名单扩展名 %s 没有配媒体类型（会静默退化成 octet-stream）", ext)
		}
	}
}

// TestDownloadFilenameIsQuotedAndEscaped 覆盖文件名的编码形态：
//   - 一律带引号（quoted-string），引号与反斜杠必须转义（否则头会被拼坏）；
//   - 含非 ASCII 时补 RFC 5987 的 filename*（只给一种会有人拿到乱码文件名）。
func TestDownloadFilenameIsQuotedAndEscaped(t *testing.T) {
	withReleaseDir(t, testInfo(t, "2.7.0", nil), map[string]string{
		`we"ird.zip`:    "zip",
		"安装包-2.7.0.dmg": "dmg",
	})
	r := newRouter("2.7.0")

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, `/updates/client/we%22ird.zip`, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("带引号的文件名应可下载，得到 %d", w.Code)
	}
	if cd := w.Header().Get("Content-Disposition"); cd != `attachment; filename="we\"ird.zip"` {
		t.Fatalf("Content-Disposition = %q（引号必须转义）", cd)
	}

	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, httptest.NewRequest(http.MethodGet, "/updates/client/安装包-2.7.0.dmg", nil))
	if w2.Code != http.StatusOK {
		t.Fatalf("非 ASCII 文件名应可下载，得到 %d", w2.Code)
	}
	cd := w2.Header().Get("Content-Disposition")
	if !strings.HasPrefix(cd, `attachment; filename="`) || !strings.Contains(cd, "filename*=UTF-8''") {
		t.Fatalf("非 ASCII 文件名必须同时给 ASCII 替身与 filename*，得到 %q", cd)
	}
}
