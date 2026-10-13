//go:build !apps

package router

import (
	"testing"

	"github.com/gin-gonic/gin"
)

// TestClosedAppsRegistrationIsNoOp：apps **关闭**时，WASM 应用平台的注册函数
// 实跑之后一条路由都不许新增（P1 第三片，2026-10-14 独立审计 P1-3）。
//
// 与 `optional_skills_off_registration_test.go` 同一口径：命名空间前缀表判不了
// "关闭态在**新**命名空间下注册路由"，位置级判据可以 —— 真调用一次，断言树上零新增。
func TestClosedAppsRegistrationIsNoOp(t *testing.T) {
	gin.SetMode(gin.TestMode)

	engine := gin.New()
	registerWasm(engine, Deps{})
	publishWasmReservedAppIDs(engine)

	if added := engine.Routes(); len(added) != 0 {
		names := make([]string, 0, len(added))
		for _, route := range added {
			names = append(names, route.Method+" "+route.Path)
		}
		t.Errorf("apps 关闭时 WASM 应用平台的注册函数新增了 %d 条路由（必须 0 条）：%v\n"+
			"  关闭态语义 = 整片命名空间从产物里消失（编译期 no-op），"+
			"见 docs/decisions/2026-10-14-server-build-tags.md。", len(added), names)
	}
}
