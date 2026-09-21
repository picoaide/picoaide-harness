package readyz

// 本文件钉住 `/readyz` 的**缓存模式维**（`exec_cache_mode` / `compile_cache_mode`）
// 在探针这一侧的三条语义：
//
//	① 提供者注入什么就报什么（探针不做任何再判断 —— 判定权在组件内部）；
//	② 提供者为 nil ⇒ 字段是**空串**（"没注入"与"某一种模式"不可混淆）；
//	③ 两个字段出现在 JSON 里（键名是跨端契约；结构体字段名改了不会红，键名改了会红）。
//
// 装配级判据（真的从运行时/编译器取值 + 降级路径）在 cmd/server 的
// wasmapp_cache_mode_test.go。
//
// 变异验证：把 Snapshot 的 json 标签从 exec_cache_mode 改成 exec_mode ⇒ ③ 红；
// 把 collect 里的 ExecCacheMode 分支删掉 ⇒ ① 红。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestSnapshotCarriesCacheModes(t *testing.T) {
	c := New(Options{
		DiskFree:         func(string) (int64, error) { return MinDiskFreeBytes, nil },
		ExecCacheMode:    func() string { return "memory" },
		CompileCacheMode: func() string { return "temporary" },
	})
	rr := httptest.NewRecorder()
	c.Handler()(rr, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是合法 JSON: %v", err)
	}
	if got := body["exec_cache_mode"]; got != "memory" {
		t.Fatalf("exec_cache_mode = %v, want \"memory\"（提供者给什么就报什么）", got)
	}
	if got := body["compile_cache_mode"]; got != "temporary" {
		t.Fatalf("compile_cache_mode = %v, want \"temporary\"", got)
	}
}

func TestSnapshotCacheModesEmptyWithoutProviders(t *testing.T) {
	c := New(Options{DiskFree: func(string) (int64, error) { return MinDiskFreeBytes, nil }})
	s := c.Snapshot()
	if s.ExecCacheMode != "" || s.CompileCacheMode != "" {
		t.Fatalf("未注入提供者时两个模式字段必须是空串（空值 ≠ 任何一种模式），得到 %q/%q",
			s.ExecCacheMode, s.CompileCacheMode)
	}
}
