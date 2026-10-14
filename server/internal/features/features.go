// Package features 是服务端**可选模块**的编译期开关真源。
//
// 模块名与渠道契约逐字一致（`skills` / `apps` / `connectors`）：渠道侧的同一批名字由
// `packages/host/desktop/scripts/channel-constants.ts` 与私有渠道仓的 channel.json 持有，
// 三处必须同写法（改名 = 换契约，不是重构）。
//
// 开关由 `go build -tags=…` 决定（全部由构建入口传入，缺省"全开"）：
//
//	-tags=                        三个模块全关（最小内核）
//	-tags=skills                  只开技能面
//	-tags=apps                    只开应用面（WASM 应用平台）
//	-tags=skills,apps             技能 + 应用
//	-tags=skills,apps,connectors  全开 —— **发布态**（server/Makefile 的 GO_TAGS 缺省值）
//
// 开关状态由同目录下的 build-tag 文件提供（skills/apps 面四个互斥且穷尽的文件 +
// connectors 面一对正交文件），本文件因此**不带任何 build tag**：它只放模块名、
// 规范顺序与查询 API，八种组合（三个独立开关的全部子集）都编译同一份声明。
//
// 本包**只回答"编译期开了什么"**，不含任何路由/装配决策：把模块真正裁掉（关掉某模块时
// 对应包树从二进制里消失）是下一片的事，见 docs/decisions/2026-10-14-server-build-tags.md。
package features

// 模块名常量 —— 对外契约的一部分，不得改写法（渠道配置与客户端组装清单按字面量比对）。
//
// 下面的常量块与 `allModules` 那一行都是 `scripts/gen-module-contract.mjs` 从仓库根
// `module-contract.json` 生成的**生成物**：改模块名要改真源再跑那个脚本重算；
// 手改生成区会被该脚本的 `--check` 判红。
const (
	// @generated:module-contract (scripts/gen-module-contract.mjs) — 手改会被 --check 判红
	// ModuleSkills 技能面：技能商城、共享技能、智能体共享、能力中心。
	ModuleSkills = "skills"
	// ModuleApps 应用面：WASM 应用平台（编译/运行/审计/演示应用）。
	ModuleApps = "apps"
	// ModuleConnectors 连接器面：MCP/连接器目录与令牌刷新。
	ModuleConnectors = "connectors"
	// @end:module-contract
)

// allModules 是规范顺序（Enabled 的返回顺序 = 它过滤后的子序列）。
// 顺序刻意写死：让"同一个组合"在任何机器上都得到逐字节相同的 Enabled() 结果。
// @generated:module-contract (scripts/gen-module-contract.mjs) — 手改会被 --check 判红
var allModules = []string{ModuleSkills, ModuleApps, ModuleConnectors}

// @end:module-contract

// AllModules 返回全部模块名（规范顺序）的副本。
func AllModules() []string {
	return append([]string(nil), allModules...)
}

// Enabled 返回当前**编译期**打开的模块名（规范顺序）。
//
// 返回值与 Has 对每一个 AllModules() 成员逐条一致（判据见 features_test.go）：
// 这里刻意用 Has 派生而不是各自维护一份条件，避免两处判定漂移。
func Enabled() []string {
	enabled := make([]string, 0, len(allModules))
	for _, name := range allModules {
		if Has(name) {
			enabled = append(enabled, name)
		}
	}
	return enabled
}

// Has 报告模块 name 是否在当前编译期打开；未知名字一律 false（不 panic、不猜）。
func Has(name string) bool {
	switch name {
	case ModuleSkills:
		return skillEnabled
	case ModuleApps:
		return appEnabled
	case ModuleConnectors:
		return connectorEnabled
	default:
		return false
	}
}

// HasSkills 是 Has(ModuleSkills) 的便捷形态（调用点不必再拼字符串）。
func HasSkills() bool { return skillEnabled }

// HasApps 是 Has(ModuleApps) 的便捷形态。
func HasApps() bool { return appEnabled }

// HasConnectors 是 Has(ModuleConnectors) 的便捷形态。
func HasConnectors() bool { return connectorEnabled }
