package agentshare

import (
	"database/sql"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// 渠道作用域(agentshare-2)
//
// agentshare 是**组织共享库**:它拥有 channel=org 的智能体。market 渠道的
// 智能体由 marketplace 端点登记/审核/上下架;两条路径共用 apps/app_releases
// 的 agent kind 与同一张 app_grants,读侧不过滤渠道时市场内容就会串进共享面
// (员工清单把它标成「组织共享」、审批队列给出 agentshare 的 base_path、市场
// 下架在这里不生效),写侧不设闸门时共享面的一次 DELETE/reject 就能销毁
// 市场内容。技能侧的对偶实现是 sharedskills.orgSkillReleases(按
// ListApps(kind, org) 过滤)与 marketplace 的
// `a.Channel != AppChannelMarket → 404`。
// ---------------------------------------------------------------------------

// orgAgentApp 解析一个组织渠道智能体;market 行一律按不存在处理(404,
// 不泄露存在性),审核/删除/质量/授权等写端点与审核面必须走这里。
func orgAgentApp(db *sql.DB, name string) (*serverstore.App, error) {
	a, err := serverstore.GetApp(db, serverstore.AppKindAgent, name)
	if err != nil {
		return nil, err
	}
	if a.Channel != serverstore.AppChannelOrg {
		return nil, serverstore.ErrNotFound
	}
	return a, nil
}

// orgAgentNames 返回组织渠道智能体的名字集合(清单类端点先过滤再投影,
// 与 sharedskills 的 orgSkillReleases 同口径)。
func orgAgentNames(db *sql.DB) (map[string]bool, error) {
	apps, err := serverstore.ListApps(db, serverstore.AppKindAgent, serverstore.AppChannelOrg)
	if err != nil {
		return nil, err
	}
	out := make(map[string]bool, len(apps))
	for _, a := range apps {
		out[a.AppID] = true
	}
	return out, nil
}

// requireOrgAgent 断言路由参数指向组织渠道智能体,并在拒绝时写响应。
// 返回 false 表示响应已写,调用方必须直接 return。
func requireOrgAgent(c *gin.Context, db *sql.DB, name string) bool {
	if _, err := orgAgentApp(db, name); err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
			return false
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return false
	}
	return true
}

// employeePresetDownloadable 报告非管理员能否下载该行。
//
// org 行沿用共享库规则(approved + 授权)。market 行归市场端点,但**归档下载**
// 必须保留:桌面能力中心的市场智能体安装走的正是
// /api/client/v2/agent-presets/:name/archive(CapabilityCenterPanel
// 的 installEndpoint),市场侧没有对员工开放的归档端点。市场「下架」在这里
// 必须生效(enabled=0 → 404)—— 这正是此前「市场下架后共享面仍可下载」的根因
// (appstore.VisibleReleases 看 enabled,ListVisibleAgentPresets 不看)。
func employeePresetDownloadable(db *sql.DB, name string) (bool, error) {
	a, err := serverstore.GetApp(db, serverstore.AppKindAgent, name)
	if err != nil {
		return false, err
	}
	if a.Channel == serverstore.AppChannelOrg {
		return true, nil
	}
	return a.Enabled == 1, nil
}
