//go:build unix

package channel

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// FIFO（命名管道）不是素材。
//
// 旧实现下 `os.Stat` 会把 FIFO 判成"存在且非目录"，而随后 `http.ServeFile` 的
// `os.Open` 在**没有写者时永久阻塞** ⇒ 一个未认证请求就能挂住一条连接（直到
// 全局 WriteTimeout）。因此这里钉两件事：
//   - 判据层：assetExists/assetPath 必须按"不存在"处理；
//   - HTTP 层：请求必须**很快**返回 404（不阻塞）。
//
// 只建 FIFO、不写数据：拒绝路径不该去打开它，所以既不该阻塞、也不该读到任何字节。
func TestAssetFIFOIsNotServedAndDoesNotBlock(t *testing.T) {
	dir, _ := setupAssetDir(t, map[string]string{
		"channel.json": `{"schema":1,"channel_id":"acme","identity":{"display_name":"Acme AI"},
          "assets":{"favicon":"favicon.fifo"}}`,
	})
	if err := syscall.Mkfifo(filepath.Join(dir, "favicon.fifo"), 0o644); err != nil {
		t.Skipf("本环境不支持 mkfifo（%v）：该用例的触发条件构造不出来", err)
	}

	if assetExists("favicon.fifo") {
		t.Errorf("assetExists(\"favicon.fifo\") = true：FIFO 必须按不存在处理")
	}
	if got := assetPath("favicon.fifo"); got != "" {
		t.Errorf("assetPath(\"favicon.fifo\") = %q，want \"\"", got)
	}

	// 请求放子协程里跑：旧实现会永久阻塞，超时即判红（子协程泄漏不影响测试进程退出）。
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- get(t, "/channel/favicon") }()
	select {
	case w := <-done:
		if w.Code != http.StatusNotFound {
			t.Fatalf("GET /channel/favicon = %d（body=%q）：FIFO 被当成素材下发", w.Code, w.Body.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("GET /channel/favicon 在 FIFO 素材上阻塞超过 5s（拒绝路径必须先判类型再打开）")
	}
}
