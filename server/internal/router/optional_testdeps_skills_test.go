//go:build skills

package router

// 本文件在 `skills` 打开时给 router 包内测试装配补上技能面 handler
// （P1 第二片，2026-10-14）。
//
// 为什么按**模块**拆 build-tag 测试文件，而不是"全开 or 全不填"：验收与开发循环里的
// `go test ./internal/router/...` **不带任何 tag**（= 三个模块全关）。判据必须在每一种
// 组合下都能编译并表达"当前变体该有什么" —— 而不是靠"只在全开时才有意义"躲开那一刻。

import (
	"testing"

	"github.com/picoaide/picoaide/internal/agentshare"
	"github.com/picoaide/picoaide/internal/capabilities"
	"github.com/picoaide/picoaide/internal/marketplace"
	"github.com/picoaide/picoaide/internal/sharedskills"
	"github.com/picoaide/picoaide/internal/skillseed"
	wasmapi "github.com/picoaide/picoaide/internal/wasmapp/api"
)

// fillSkillsTestDeps 填技能面五个 handler（测试树必须与生产树同形 —— 否则
// `largeBodyRoutes` 的"豁免必须对应真实路由"门禁测不出路径写错）。
func fillSkillsTestDeps(t *testing.T, d *Deps) {
	t.Helper()
	d.Market = marketplace.NewHandlers(nil, "/tmp/nonexistent")
	d.Agentshare = agentshare.NewHandlers(nil, "/tmp/nonexistent")
	d.Shared = sharedskills.NewHandlers(nil, "/tmp/nonexistent")
	d.Capability = capabilities.NewHandlers(nil, "/tmp/nonexistent")
	d.SkillSeed = skillseed.NewHandlers(skillseed.New(t.TempDir()))
	_ = wasmapi.Options{}
}
