// Package telemetry implements client-side skill usage reporting: the
// desktop client POSTs skill-call events after a model/user skill invocation,
// and the server increments the per-skill call counters (0040).
package telemetry

import (
	"database/sql"
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// maxNameLen bounds the reported skill name (defense: bound every field the
// client sends before it hits SQL).
const maxNameLen = 128

// P2-20 限流:任意登录用户此前可无限刷 skill-call → calls 刷榜。
// 双桶(每分钟):perUser 防单账号刷量,perSkill 防单技能被集中刷票。
// 可用环境变量下调(测试/压测);0 = 不限。
var (
	perUserLimitPerMin  = envInt("PICOAI_TELEMETRY_MAX_PER_MIN", 60)
	perSkillLimitPerMin = envInt("PICOAI_TELEMETRY_MAX_PER_SKILL_PER_MIN", 10)
	skillCallLimiter    = newCallLimiter(time.Minute)
)

func envInt(name string, def int) int {
	if v := strings.TrimSpace(os.Getenv(name)); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			return n
		}
	}
	return def
}

// RegisterRoutes mounts /api/client/v2/telemetry/* behind BearerAuth
// (测试/自建路由辅助; 生产路由由 internal/router 包集中声明)。
func RegisterRoutes(r *gin.Engine, db *sql.DB) {
	base := "/api/client/v2/telemetry"
	g := r.Group(base, serverauth.BearerAuth(db))
	g.POST("/skill-call", reportSkillCall(db))
	g.POST("/error-reporting", reportErrorReporting(db))
}

// reportSkillCall increments the call counter for the reported skill. The
// client reports after a successful invocation (tool `skill` executed or a
// `/name` user gesture injected). Unknown/local skills are ignored (ok=true)
// so the client telemetry is monotone and non-fatal.
//
// Request: {"name": "...", "version": "..."} — version optional; when present
// it targets the shared-skill row (name+version) first, then the marketplace
// row by name.
func reportSkillCall(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
			return
		}
		// SG-1(审计 2026-09-17):name/version 是同一个洞 —— NUL 能穿过长度与
		// 分隔符校验,却会让后续 SELECT/UPDATE 的参数被 PG 拒绝(500 + 计数丢失)。
		// 与 error-reporting 共用同一份清洗;清洗后再走原有校验(空名/分隔符仍 400)。
		name := stripControlChars(strings.TrimSpace(req.Name))
		if name == "" || len(name) > maxNameLen || strings.ContainsAny(name, "/\\") {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "skill name 不合法")
			return
		}
		version := stripControlChars(strings.TrimSpace(req.Version))
		if len(version) > maxNameLen {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "version 不合法")
			return
		}
		// P2-20: 双桶限流——perUser(账号刷量) + perUser+skill(单技能刷票)。
		// 放在参数校验之后:非法请求不消耗上报预算。
		if u := serverauth.CurrentUser(c); u != nil {
			if !skillCallLimiter.allow("u:"+strconv.FormatInt(u.ID, 10), perUserLimitPerMin) ||
				!skillCallLimiter.allow("s:"+strconv.FormatInt(u.ID, 10)+"|"+name, perSkillLimitPerMin) {
				serverauth.WriteError(c, http.StatusTooManyRequests, "RATE_LIMITED", "上报过于频繁,请稍后再试")
				return
			}
			// srvcore-2(审计 2026-09-13):限流只压速率、不限定计数目标 ——
			// 任意登录员工都能给**对自己不可见**的技能刷 calls(读侧 404/
			// 空列表,写侧 200 + calls+1)。这里复用读侧的可见性口径判定
			// 计数目标。
			//
			// R7-F3-N2(复核 2026-09-13):不可见时**沿用该端点既有的"静默
			// 忽略"语义**(与"平台上不存在的本地创作技能"同响应),不换状态码。
			// 换 404 会把"存在但对我不可见"与"平台上不存在"变成可区分信号
			// (读侧刻意同码 404 不泄露资源存在性,AGENTS.md §2.1/§2.2),本端点
			// 就成了比读侧更强的技能存在性预言机:任意登录员工可据此枚举平台
			// 技能名(含他人未审核/被拒的组织共享技能版本)。计数同样不落 ——
			// 可见性判定与 srvcore-2 一致,只是对外表现与"不存在"不可区分。
			allowed, err := skillCallTargetAllowed(db, u, name, version)
			if err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "记录失败")
				return
			}
			if !allowed {
				c.JSON(http.StatusOK, gin.H{"ok": true})
				return
			}
		}
		// 未知技能(本地创作/未上架)静默忽略:上报不得因未知名字报错,
		// 以免影响客户端主链路。
		if _, err := serverstore.IncrementSkillCall(db, name, version); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "记录失败")
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// skillCallTargetAllowed 判定本次上报的计数目标是否对该调用者可见,口径与
// 读侧一致:市场技能列表/详情 = 已上架 ∧ 已授权(app_grants,kind='skill';
// 市场与组织共享库共用同一授权命名空间),admin 恒全量、不落授权表;组织共享
// 技能的作者本人可见(与 ListVisibleSharedSkills 的作者例外一致)。
//
// 目标在平台上不存在 = 本地创作技能:沿用既有"静默忽略"语义返回 true
// (后续 UPDATE 不命中任何行,计数不变),不让遥测影响客户端主链路。
func skillCallTargetAllowed(db *sql.DB, u *serverstore.User, name, version string) (bool, error) {
	rel, err := skillCallTarget(db, name, version)
	if err != nil {
		return false, err
	}
	if rel == nil || u.IsAdmin {
		return true, nil
	}
	if rel.Publisher != "" && rel.Publisher == u.Username {
		return true, nil
	}
	groups, err := serverstore.UserEffectiveGroups(db, u.ID)
	if err != nil {
		return false, err
	}
	names, err := serverstore.AccessibleSkillNames(db, u.Username, groups)
	if err != nil {
		return false, err
	}
	for _, n := range names {
		if n == name {
			return true, nil
		}
	}
	return false, nil
}

// skillCallTarget 解析上报命中的版本行,与 IncrementSkillCall 的落点同口径:
// 带 version 精确命中该版本行;不带 version 回落展示版本(最高 approved
// 未软删版本)。nil = 平台上不存在该名字(本地创作技能)。
func skillCallTarget(db *sql.DB, name, version string) (*serverstore.Release, error) {
	if version == "" {
		rel, err := serverstore.CurrentMarketReleaseFor(db, serverstore.AppKindSkill, name, false)
		if errors.Is(err, serverstore.ErrNotFound) {
			return nil, nil
		}
		return rel, err
	}
	rel, err := serverstore.GetRelease(db, serverstore.AppKindSkill, name, version)
	if errors.Is(err, serverstore.ErrNotFound) {
		return nil, nil
	}
	return rel, err
}
