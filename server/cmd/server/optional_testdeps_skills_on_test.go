//go:build skills

package main

// 本文件在 `skills` 打开时给测试装配补上内置技能下发面（P1 第二片，2026-10-14）。
//
// 为什么是 build-tag 测试文件：`internal/skillseed` 属于 skills 模块 —— 把它吊在
// 不带 tag 的 `main_test.go` 里会让降配变体编不过，而 `make check-tags` 的
// `go vet ./...` 正是逐组合编译测试面的判据。

import (
	"testing"

	"github.com/picoaide/picoaide/internal/skillseed"
)

// fillSkillsProductionDeps 填 skills 面的 productionDeps 字段。
//
// 与 main() 同源：内置技能目录取 `skillseed.Dir`（镜像内 /opt/picoaide/skills；
// 本机没有该目录时清单为空，与"二进制旁边没有技能资产"的生产行为一致）。
func fillSkillsProductionDeps(_ *testing.T, d *productionDeps) {
	d.SkillSeed = skillseed.NewHandlers(skillseed.New(skillseed.Dir))
}
