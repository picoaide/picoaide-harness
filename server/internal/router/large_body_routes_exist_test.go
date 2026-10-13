//go:build skills && apps

package router

// 本文件是**全开态**的路由表判据（P1 第二片，2026-10-14）。
//
// `largeBodyRoutes` 的豁免项里，技能面上传（市场/共享技能/智能体预设归档）与
// WASM 上传片只在这两个模块编进来时才存在 —— 关闭态那几条豁免项本来就无路由可指，
// 断言"必须对应真实路由"在该变体下没有意义。因此这条判据按它需要的模块分文件，
// 而不是把断言删掉或改成恒真。
//
// ⚠️ 基础面那半（`TestLargeBodyRoutesExemptions` 的负例、`TestBodyLimitMiddleware*`）
// 刻意留在不带 tag 的 `router_test.go` 里：它们八种组合都跑。

import "testing"

// 豁免表必须对应真实注册的路由(防路径写错导致豁免失效 → 上传被 1MB 拦)。
func TestLargeBodyRoutesExist(t *testing.T) {
	r := buildTestRouter(t)
	routes := map[string]bool{}
	for _, rt := range r.Routes() {
		routes[rt.Method+" "+rt.Path] = true
	}
	for key := range largeBodyRoutes {
		if !routes[key] {
			t.Fatalf("exempt route not registered in production tree: %s", key)
		}
	}
}
