//go:build !skills

package main

// 本文件在 `skills` **关闭**时生效（P1 第二片，2026-10-14）：例外登记表里那批
// **全部属于技能面**的路由在本变体里根本不存在，登记表因此必须为空 —— 判据会反向
// 断言"登记了却 never 命中 ⇒ 表在说谎"，把表清空不是让守卫变绿的手法，而是关闭态的
// 正确形态（见 api_sweep_module_surfaces_on_test.go 的另一半）。
//
// 归属判定：这 15 条逐条落在技能面（`marketplace` / `sharedskills` / `agentshare` /
// `skillseed`）的命名空间上（`/skills`、`/agents`、`/agent-presets`、`/shared-skills`、
// `/marketplace`），apps 与 connectors 一条都不在其中 —— 所以 build 约束是 `skills`，
// 不是"任一模块"。

// sweepModuleAuthGatedNonJSONSurfaces：三个模块全关 ⇒ 一条都没有。
var sweepModuleAuthGatedNonJSONSurfaces = map[string]string{}
