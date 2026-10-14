//go:build !skills

package main

// 本文件是 `skills` 模块**关闭**时的装配接线（P1 第二片，2026-10-14）。
//
// 关闭态的语义（见 docs/decisions/2026-10-14-server-build-tags.md §关闭态语义）：
//   - `internal/{marketplace,sharedskills,agentshare,capabilities}` 与
//     `internal/skillseed` 五棵包树**不在依赖图里**；
//   - `/api/client/v2/{marketplace,skills/builtin,shared-skills,agent-presets,capabilities}`
//     与 `/api/server/admin/{skills,agents,shared-skills,agent-presets,capability-locks,capabilities}`
//     整片不注册（router 侧编译期 no-op）；
//   - **DB 不变**：迁移与 schema 一个字都不改，`apps` / `app_grants` /
//     `capability_locks` 等表照建、照空着（数据面不随变体分叉）。

import "github.com/picoaide/picoaide/internal/router"

// buildSkillSeedHandlers 在 skills 关闭时不构造任何 handler（恒 nil）。
//
// nil 在这里是安全的：router 侧的注册函数在关闭态根本不存在（编译期 no-op），
// 没有任何路径会把 nil handler 交给 gin。
func buildSkillSeedHandlers() *router.SkillSeedAPI { return nil }

// applySkillsDeps 在 skills 关闭时是编译期 no-op。
func applySkillsDeps(_ *router.Deps, _ productionDeps) {}
