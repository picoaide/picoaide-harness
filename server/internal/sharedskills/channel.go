package sharedskills

import (
	"database/sql"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// 渠道作用域(agentshare-3)
//
// sharedskills 是**组织共享库**:它拥有 channel=org 的技能。market 渠道技能
// 由 marketplace 端点管理;两者共用 apps/app_releases 与同一张 app_grants。
// 读侧(orgSkillReleases)一直按渠道过滤,但写侧此前直接
// serverstore.GetSharedSkill(不看渠道)—— 共享库的 reject/delete/quality/
// grants 因此能改写或销毁市场技能(市场列表随之只剩空壳行/彻底消失)。
// 这里补上与读侧一致的闸门;市场技能的等价守卫是 marketplace 的
// `a.Channel != AppChannelMarket → 404`。
// ---------------------------------------------------------------------------

// orgSkillApp 解析一个组织渠道技能;market 行一律按不存在处理(404,
// 不泄露存在性)。所有共享技能端点(读/写)都必须先过这里。
func orgSkillApp(db *sql.DB, name string) (*serverstore.App, error) {
	a, err := serverstore.GetApp(db, serverstore.AppKindSkill, name)
	if err != nil {
		return nil, err
	}
	if a.Channel != serverstore.AppChannelOrg {
		return nil, serverstore.ErrNotFound
	}
	return a, nil
}

// requireOrgSkill 断言该技能属于组织共享库,并在拒绝时写响应。
// 返回 false 表示响应已写,调用方必须直接 return。
func requireOrgSkill(c *gin.Context, db *sql.DB, name string) bool {
	if _, err := orgSkillApp(db, name); err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
			return false
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return false
	}
	return true
}
