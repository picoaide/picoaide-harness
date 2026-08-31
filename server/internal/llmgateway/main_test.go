package llmgateway

import (
	"os"
	"testing"
)

// TestMain 保证每个测试前清空本包的上游路由缓存:
// 测试各自建独立临时 DB,而 upstreamCache 是进程级全局变量,
// 前一测试写入的 provider 列表会污染后续测试(2026-08-31 加缓存后引入)。
func TestMain(m *testing.M) {
	InvalidateUpstreams()
	code := m.Run()
	os.Exit(code)
}
