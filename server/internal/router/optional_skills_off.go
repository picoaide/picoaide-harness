//go:build !skills

package router

// 本文件是 `skills` 模块**关闭**时的接线（P1 第二片，2026-10-14）。
//
// 五个 handler 类型都是空类型、两个注册函数都是编译期 no-op —— 技能商城的路由
// 注册代码因此**编不进产物**，而不是"注册了一片 handler 为 nil 的路由"。
// 关闭态语义见 docs/decisions/2026-10-14-server-build-tags.md。
//
// 保留权限点与 RBAC 定义：权限模型不随变体变（关掉的是**入口**，不是权限位），
// 见 cmd/server/audit_r13ge_permset_test.go 的登记口径。

import "github.com/gin-gonic/gin"

// 与打开态同名的五个空类型（Deps 的字段名是装配契约的一部分，字段本身仍在）。
type (
	// MarketAPI 技能商城 handler 集合（关闭态：空类型）。
	MarketAPI struct{}
	// SharedSkillsAPI 组织共享技能 handler 集合（关闭态：空类型）。
	SharedSkillsAPI struct{}
	// AgentshareAPI 共享 Agent handler 集合（关闭态：空类型）。
	AgentshareAPI struct{}
	// CapabilitiesAPI 能力中心 handler 集合（关闭态：空类型）。
	CapabilitiesAPI struct{}
	// SkillSeedAPI 内置技能下发面 handler 集合（关闭态：空类型）。
	SkillSeedAPI struct{}
)

// registerSkillsClientRoutes 在 skills 关闭时是编译期 no-op（提前 return 的编译期形态）。
func registerSkillsClientRoutes(_ *gin.RouterGroup, _ Deps) {}

// registerSkillsAdminRoutes 在 skills 关闭时是编译期 no-op。
func registerSkillsAdminRoutes(_ *gin.RouterGroup, _ Deps) {}
