//go:build !skills

package router

import (
	"testing"

	"github.com/gin-gonic/gin"
)

// TestClosedSkillsRegistrationIsNoOp：skills **关闭**时，两个注册函数实跑之后
// 一条路由都不许新增（P1 第三片，2026-10-14 独立审计 P1-3）。
//
// 为什么需要它（比命名空间前缀表更根本的一层）：`cmd/server` 的登记级反向断言按
// **前缀**判，于是"在关闭态注册一条**新命名空间**下的路由"能绕过它（那张表里没有
// 那个名字）。这里是同一承诺的**位置级**判据 —— 关闭态的注册函数就是编译期 no-op，
// 真调用一次、断言树上零新增。两层合起来：位置级管"注册函数自己不许注册"，
// 登记级管"基础面代码不许替它注册"。
//
// 变异（实跑，2026-10-14）：在 `registerSkillsClientRoutes` 里用真 `BearerAuth`
// 注册 `GET /api/client/v2/shared-skills/leak-probe` 等三条 ⇒ 本用例红。
func TestClosedSkillsRegistrationIsNoOp(t *testing.T) {
	gin.SetMode(gin.TestMode)

	engine := gin.New()
	client := engine.Group("/api/client/v2")
	admin := engine.Group("/api/server/admin")
	registerSkillsClientRoutes(client, Deps{})
	registerSkillsAdminRoutes(admin, Deps{})

	if added := engine.Routes(); len(added) != 0 {
		names := make([]string, 0, len(added))
		for _, route := range added {
			names = append(names, route.Method+" "+route.Path)
		}
		t.Errorf("skills 关闭时技能面的注册函数新增了 %d 条路由（必须 0 条）：%v\n"+
			"  关闭态语义 = 整片命名空间从产物里消失（编译期 no-op），"+
			"见 docs/decisions/2026-10-14-server-build-tags.md。", len(added), names)
	}
}
