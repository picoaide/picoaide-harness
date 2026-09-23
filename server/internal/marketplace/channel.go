package marketplace

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// 渠道作用域（A-8，2026-09-23 第三轮审计）
//
// marketplace 是**市场命名空间**：它拥有 `apps.channel='market'` 的智能体与技能。
// 组织共享库的智能体由 agentshare 的 `/agent-presets/*` 管理；那个包的
// `orgAgentApp` / `requireOrgAgent` 是同一条边界在反方向上的实现（本文件是它的
// 镜像，刻意保持同形，不另立第二套判据）。
//
// 缺陷现场：市场命名空间的 5 个智能体端点（preview / file / grants 读 /
// grants 整组替换 / grant 单条增删）此前只做 `GetApp` 存在性判断、**不看渠道**
// ⇒ 一条 `channel='org'` 的行在这个命名空间下可被预览、逐文件读出、读授权，
// 甚至被授权/撤销授权。技能侧的孪生端点（靠 `serverstore.GetSkill` 自带的
// `channel='market'` 过滤）与组织侧的孪生端点（`requireOrgAgent`）都正确 404。
//
// 该错配今天**不构成提权**（`market:read/write` 与 `capability:*` 目前都只授予
// super_admin），但它把「市场命名空间只管市场行」这条边界打破了：RBAC 一旦细化到
// 「市场运营 ≠ 组织运营」，这些端点就是现成的越权面（且 grants/grant 是**写**面）。
// ---------------------------------------------------------------------------

// marketAgentApp 解析一个市场渠道智能体；org 行一律按不存在处理
// （`serverstore.ErrNotFound`，调用方回 404，不泄露存在性）。
//
// 与 `agentshare.orgAgentApp` 同形、方向相反：那边的判据是 `!= AppChannelOrg`，
// 这边是 `!= AppChannelMarket`。两处都只允许这一份实现。
func marketAgentApp(db *sql.DB, name string) (*serverstore.App, error) {
	a, err := serverstore.GetApp(db, serverstore.AppKindAgent, name)
	if err != nil {
		return nil, err
	}
	if a.Channel != serverstore.AppChannelMarket {
		return nil, serverstore.ErrNotFound
	}
	return a, nil
}

// requireMarketAgent 断言路由参数指向市场渠道智能体，并在拒绝时写响应。
// 返回 false 表示响应已写，调用方必须直接 `return`。
//
// **位置契约**：必须在任何实际工作之前 —— 解析归档、读发布记录、列授权、
// 写授权之前。与 `agentshare.requireOrgAgent` 在四处授权面（list/replace/set/
// remove grants）置于函数首段的位置同形。
func requireMarketAgent(c *gin.Context, db *sql.DB, name string) bool {
	if _, err := marketAgentApp(db, name); err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "智能体不存在")
			return false
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return false
	}
	return true
}

// marketAgentChannelPolicy 是市场命名空间里一条智能体管理路由的渠道口径。
type marketAgentChannelPolicy string

const (
	// policyMarketOnlyByGuard：逐名端点必须过 `requireMarketAgent`
	// ⇒ org 行得到 404，且与"该名字不存在"逐字节同形。
	policyMarketOnlyByGuard marketAgentChannelPolicy = "market-only/guard"
	// policyMarketOnlyByListFilter：清单端点靠
	// `ListApps(kind, market)` 过滤，org 行根本不进响应 —— 没有"名字"可判，
	// 所以没有逐名守卫，但也绝不服务 org 行。
	policyMarketOnlyByListFilter marketAgentChannelPolicy = "market-only/list-filter"
	// policyCrossChannelNameExclusion：**故意**要读 org 行，为了给出跨源同名
	// 互斥的拒绝（409）。只读、只拒，从不服务 org 内容、从不写 org 行。
	policyCrossChannelNameExclusion marketAgentChannelPolicy = "cross-channel/name-exclusion"
)

// agentRouteChannelRule 把一条路由与它的渠道口径、依据绑在一起。
type agentRouteChannelRule struct {
	Policy marketAgentChannelPolicy
	// Why 是这条口径的依据。cross-channel 的条目必须写清"为什么不能加守卫"。
	Why string
}

// marketAgentRoutePolicy 是**显式清单**：市场命名空间
// （`/api/server/admin/agents*`）每一条路由的渠道口径 —— 「哪些面跨渠道」的
// **唯一真源**。
//
// 清单之外的路由一律只服务市场行。新增智能体管理路由时，
// `TestAgentAdminRoutesAreMarketOnlyOrRegistered` 会要求作者在这里登记
// （或给它加守卫），不允许静默留白：这条清单与运行时路由表**双向**比对，
// 登记了却不在、在却没登记都红。
var marketAgentRoutePolicy = map[string]agentRouteChannelRule{
	"GET /api/server/admin/agents": {
		Policy: policyMarketOnlyByListFilter,
		Why:    "listAgentsAdmin 走 ListApps(AppKindAgent, AppChannelMarket)，org 行不进行表",
	},
	"POST /api/server/admin/agents": {
		Policy: policyCrossChannelNameExclusion,
		Why: "必须先看同名 org 行才能回「名称与组织共享库智能体冲突」的 409（跨源同名互斥，" +
			"与技能侧 SkillNameExists 同语义）；加守卫会把它降级成 404「智能体不存在」，" +
			"管理员会以为自己名字打错了",
	},
	"POST /api/server/admin/agents/:name/archive": {
		Policy: policyCrossChannelNameExclusion,
		Why: "跨渠道同名互斥的真源在 appstore.Publish（existing.Channel != req.Channel ⇒ 409 " +
			"NAME_TAKEN）；它必须读到 org 行才能拒绝。加守卫会把 409 降级成 404",
	},
	"PUT /api/server/admin/agents/:name": {
		Policy: policyMarketOnlyByGuard,
		Why:    "updateAgentAdmin：元数据更新只作用于市场行",
	},
	"DELETE /api/server/admin/agents/:name": {
		Policy: policyMarketOnlyByGuard,
		Why:    "deleteAgentAdmin：下架只作用于市场行",
	},
	"POST /api/server/admin/agents/:name/enable": {
		Policy: policyMarketOnlyByGuard,
		Why:    "enableAgentAdmin：重新上架只作用于市场行",
	},
	"GET /api/server/admin/agents/:name/preview": {
		Policy: policyMarketOnlyByGuard,
		Why:    "previewAgentAdmin：A-8 补守卫（此前 org 行可被预览）",
	},
	"GET /api/server/admin/agents/:name/file": {
		Policy: policyMarketOnlyByGuard,
		Why:    "fileContentAgentAdmin：A-8 补守卫（此前 org 行可被逐文件读出）",
	},
	"GET /api/server/admin/agents/:name/archive": {
		Policy: policyMarketOnlyByGuard,
		Why:    "downloadAgentArchiveAdmin：2026-09-23 新端点，落地即带守卫",
	},
	"GET /api/server/admin/agents/:name/grants": {
		Policy: policyMarketOnlyByGuard,
		Why:    "listAgentGrants：A-8 补守卫（此前可读出 org 行的授权；与 org 行同名同 kind 的 ACL 会串面）",
	},
	"PUT /api/server/admin/agents/:name/grants": {
		Policy: policyMarketOnlyByGuard,
		Why:    "replaceAgentGrants：A-8 补守卫（**写**面：此前可替换 org 行的部门授权）",
	},
	"PUT /api/server/admin/agents/:name/grant": {
		Policy: policyMarketOnlyByGuard,
		Why:    "applyAgentGrant(grant=true)：A-8 补守卫（**写**面：此前可给 org 行加授权）",
	},
	"DELETE /api/server/admin/agents/:name/grant": {
		Policy: policyMarketOnlyByGuard,
		Why:    "applyAgentGrant(grant=false)：A-8 补守卫（**写**面：此前可撤销 org 行的授权）",
	},
}

// ruleViolations 是单条清单条目的自洽判据（依据非空、口径与路由形状相符）。
func (r agentRouteChannelRule) ruleViolations(key string) []string {
	if strings.TrimSpace(r.Why) == "" {
		return []string{key + "：渠道口径没有写依据"}
	}
	switch r.Policy {
	case policyCrossChannelNameExclusion:
		if !strings.Contains(r.Why, "409") {
			return []string{fmt.Sprintf("%s：跨渠道条目必须写明它拒绝时回什么（当前依据 %q）", key, r.Why)}
		}
	case policyMarketOnlyByGuard:
		if !strings.Contains(key, ":name") {
			return []string{fmt.Sprintf("%s：标为逐名守卫类，但路由里没有 :name（清单与实现不符）", key)}
		}
	case policyMarketOnlyByListFilter:
		// 清单类靠 ListApps(kind, market) 过滤，没有逐名守卫 —— 允许无 :name。
	default:
		return []string{fmt.Sprintf("%s：未知渠道口径 %q", key, r.Policy)}
	}
	return nil
}

// MarketAgentRouteViolations 把「运行时路由表 ↔ marketAgentRoutePolicy」的双向对拍
// 收敛成**唯一实现**，`observed` 是一份 `"METHOD /path"` 路由集合的快照：
//
//   - 包内 `TestAgentAdminRoutesAreMarketOnlyOrRegistered` 传**测试镜像树**
//     （`RegisterAdminRoutes`）的路由集合；
//   - `internal/router` 的 `TestProductionAgentRoutesMatchMarketplacePolicy` 传
//     **生产路由表**（`router.Register`）的 `/agents*` 路由集合。
//
// 为什么必须导出（独立复审 F1，2026-09-23）：包内守门只枚举测试镜像树，而新增路由的
// 自然落点是生产真源 `internal/router/router.go`（server/AGENTS.md §7.0 规定"路由集中
// 声明"）—— 只在生产树里多一条未登记路由时，包内守卫、`internal/router` 的
// 「镜像 ⊆ 生产」子集断言、`cmd/server` 的三条装配/扫描断言**全绿**，而该路由在生产
// 树上真实可达（复审 MG1 实测：它返回 handler 的"智能体不存在"而不是 NoRoute 的
// "接口不存在"）。修复方声称的"两条守卫组合即等价"因此不成立；只有把生产树本身
// 纳入对拍面才能闭合。导出面刻意只有这一个**纯函数**（不导出清单、不导出类型、无状态），
// 判据仍只有一份实现。
//
// 返回空切片 = 通过；每条违规是一行可直接读的中文说明（已排序，便于失败时对拍）。
func MarketAgentRouteViolations(observed []string) []string {
	violations := make([]string, 0)
	seen := make(map[string]bool, len(observed))
	for _, key := range observed {
		if seen[key] {
			continue
		}
		seen[key] = true
		rule, ok := marketAgentRoutePolicy[key]
		if !ok {
			violations = append(violations, fmt.Sprintf(
				"路由 %s 未登记渠道口径：新增智能体管理路由必须在 marketAgentRoutePolicy 里"+
					"选择「加 requireMarketAgent 守卫」或「登记为跨渠道并写依据」", key))
			continue
		}
		violations = append(violations, rule.ruleViolations(key)...)
	}
	for key := range marketAgentRoutePolicy {
		if !seen[key] {
			violations = append(violations, fmt.Sprintf(
				"marketAgentRoutePolicy 登记了 %s，但运行时路由表里没有这条路由（陈旧条目）", key))
		}
	}
	sort.Strings(violations)
	return violations
}
