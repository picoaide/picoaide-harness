// Package telemetry implements client-side skill usage reporting: the
// desktop client POSTs skill-call events after a model/user skill invocation,
// and the server increments the per-skill call counters (0040).
package telemetry

import (
	"database/sql"
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
		name := strings.TrimSpace(req.Name)
		if name == "" || len(name) > maxNameLen || strings.ContainsAny(name, "/\\") {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "skill name 不合法")
			return
		}
		version := strings.TrimSpace(req.Version)
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
