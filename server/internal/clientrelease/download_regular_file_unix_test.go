//go:build unix

package clientrelease

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// FIFO（命名管道）不是资产 —— 与 channel 的 `asset_fifo_unix_test.go` 同源。
//
// 旧实现下 `os.Stat` 会把 FIFO 判成"存在且非目录"，而随后 `http.ServeFile` 的
// `os.Open` 在**没有写者时永久阻塞** ⇒ 一个未认证请求就能挂住一条连接（直到全局
// WriteTimeout）。因此这里钉两件事：
//   - 判据层：openAsset 必须按"不是资产"处理（errAssetNotRegular）；
//   - HTTP 层：请求必须**很快**返回 404（既不阻塞、也不读到任何字节）。
//
// 只建 FIFO、不写数据：拒绝路径不该去打开它。
func TestDownloadRejectsFIFOAndDoesNotBlock(t *testing.T) {
	withReleaseDir(t, testInfo(t, "2.7.0", map[string]any{
		"linux-x64": map[string]any{"file": "pipe.AppImage", "sha256": testSHA, "size": 0},
	}), nil)
	if err := syscall.Mkfifo(filepath.Join(Dir, "pipe.AppImage"), 0o644); err != nil {
		t.Skipf("本环境不支持 mkfifo（%v）：该用例的触发条件构造不出来", err)
	}

	if f, _, err := openAsset("pipe.AppImage"); err == nil {
		_ = f.Close()
		t.Error("openAsset(\"pipe.AppImage\") 成功了：FIFO 被当成资产")
	} else if !errors.Is(err, errAssetNotRegular) {
		t.Errorf("FIFO 的拒绝理由 = %v，want errAssetNotRegular", err)
	}

	// 请求放子协程里跑：旧实现会永久阻塞，超时即判红（子协程泄漏不影响测试进程退出）。
	r := newRouter("2.7.0")
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- getDownload(t, r, "/updates/client/pipe.AppImage") }()
	select {
	case w := <-done:
		if w.Code != http.StatusNotFound {
			t.Fatalf("GET FIFO 资产 = %d（body=%q）：FIFO 被下发", w.Code, w.Body.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("GET FIFO 资产阻塞超过 5s（拒绝路径必须先判类型再打开）")
	}
}

// 设备文件（字符设备）⇒ 拒。mknod 需要权限，拿不到就跳过该形态 ——
// 无权限时 `os.DevNull` 那条用例（download_regular_file_test.go 的
// TestOpenRegularAssetRejectsDeviceFile）覆盖同一个类型判据。
func TestOpenRegularAssetRejectsCharDevice(t *testing.T) {
	dev := filepath.Join(t.TempDir(), "null.AppImage")
	// 1:3 = /dev/null 的 major:minor；Linux 的编码是 (major<<8)|minor。
	// 设备号具体是多少不影响本用例（断言只关心"是不是普通文件"），
	// 所以别的 unix 上编出别的设备也同样成立。
	if err := syscall.Mknod(dev, syscall.S_IFCHR|0o644, (1<<8)|3); err != nil {
		t.Skipf("本环境不支持 mknod（%v）：该用例的触发条件构造不出来", err)
	}
	f, info, err := openRegularAsset(dev)
	if err == nil {
		_ = f.Close()
		t.Fatalf("openRegularAsset(字符设备) 成功了（info=%v）", info)
	}
	if !errors.Is(err, errAssetNotRegular) {
		t.Fatalf("字符设备拒绝理由 = %v，want errAssetNotRegular", err)
	}
}
