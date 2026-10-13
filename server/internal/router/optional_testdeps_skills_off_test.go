//go:build !skills

package router

// 本文件在 `skills` 关闭时生效（P1 第二片，2026-10-14）：技能面 handler 一律留空 ——
// 关闭态的 router 根本不注册那一片（编译期 no-op），判据反过来断言"这些路由不在"。

import "testing"

// fillSkillsTestDeps 在 skills 关闭时什么都不填。
func fillSkillsTestDeps(_ *testing.T, _ *Deps) {}
