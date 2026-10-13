//go:build skills

package main

// 本文件是 `skills` 模块**打开**时的装配接线（P1 第二片，2026-10-14）。
// 关闭态见 `optional_skills_off.go`（同名空实现）——装配代码因此不需要 build tag。

import (
	"log"

	"github.com/picoaide/picoaide/internal/agentshare"
	"github.com/picoaide/picoaide/internal/capabilities"
	"github.com/picoaide/picoaide/internal/marketplace"
	"github.com/picoaide/picoaide/internal/router"
	"github.com/picoaide/picoaide/internal/sharedskills"
	"github.com/picoaide/picoaide/internal/skillseed"
)

// buildSkillSeedHandlers 加载镜像内置技能目录并构造下发 handler。
//
// 启动即加载一次：清单要在第一个请求之前就绪，且"资产缺失/坏掉"必须出现在启动
// 日志里 —— 否则它只表现为"客户端里没有这条技能"，零报错（与 clientrelease 的
// 负载清单同一个教训）。关闭 skills 时整段不编译（连同 internal/skillseed 包树）。
func buildSkillSeedHandlers() *router.SkillSeedAPI {
	skillCatalog := skillseed.New(skillseed.Dir)
	if lerr := skillCatalog.Load(); lerr != nil {
		log.Printf("内置技能目录读取失败（%v），内置技能清单为空", lerr)
	} else {
		for _, problem := range skillCatalog.Problems() {
			log.Printf("内置技能被跳过 —— %s", problem)
		}
		log.Printf("内置技能：%d 个（%s）", len(skillCatalog.Entries()), skillCatalog.Dir())
	}
	return skillseed.NewHandlers(skillCatalog)
}

// applySkillsDeps 把技能面的四个 handler 装进路由依赖（第五个 SkillSeed 由
// buildSkillSeedHandlers 直接给出，因为它的构造要读镜像目录）。
func applySkillsDeps(rd *router.Deps, d productionDeps) {
	rd.Market = marketplace.NewHandlers(d.DB, d.DataDir+"/skills-cache")
	rd.Agentshare = agentshare.NewHandlers(d.DB, d.DataDir+"/agent-presets-cache")
	rd.Shared = sharedskills.NewHandlers(d.DB, d.DataDir+"/shared-skills-cache")
	rd.Capability = capabilities.NewHandlers(d.DB, d.DataDir+"/skills-cache")
}
