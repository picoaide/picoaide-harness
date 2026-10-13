//go:build !skills

package main

// 本文件在 `skills` 关闭时生效（P1 第二片，2026-10-14）：内置技能下发面不构造。
// 关闭态 router 根本没有那片注册代码（编译期 no-op），nil 不会被交给 gin。

import "testing"

// fillSkillsProductionDeps 在降配变体里什么都不填。
func fillSkillsProductionDeps(_ *testing.T, _ *productionDeps) {}
