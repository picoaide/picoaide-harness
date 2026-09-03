package serverauth

import (
	"github.com/gin-gonic/gin"
)

// ---------------------------------------------------------------------------
// Handler 供给面(工程化重构 2026-09): 路由声明集中在 internal/router 包,
// 本包只通过公开 Handlers 结构暴露 gin.HandlerFunc 引用(内部实现保持私有)。
// Deps 组装方式: New(db).Handlers() → router.Deps.Auth。
// ---------------------------------------------------------------------------

// ClientHandlers 客户端员工面(auth)handler 集合。
type ClientHandlers struct {
	Login  gin.HandlerFunc
	Logout gin.HandlerFunc
	Me     gin.HandlerFunc
	Usage  gin.HandlerFunc
	// ChangePassword 员工自助改密(0057; 本地认证用户)。
	ChangePassword gin.HandlerFunc
	// OIDC 每套已配置 browser provider(oidc/openid)一条 login/callback。
	// 由 Handlers() 预生成绑定 provider 的闭包; key 是 provider 名。
	OIDC []OIDCRoute
}

// OIDCRoute 一套 browser provider 的 login/callback handler 对。
// Name 是 provider 名(oidc/openid), 路由声明用 `/api/client/v2/auth/<name>/...`。
type OIDCRoute struct {
	Name     string
	Login    gin.HandlerFunc
	Callback gin.HandlerFunc
}

// Handlers 返回客户端认证面 handler 集合(供 router 包集中声明路由)。
// 无状态: 每次调用返回指向同一 a 的引用集合; OIDC 闭包预生成绑定 provider。
func (a *API) Handlers() *ClientHandlers {
	oidc := make([]OIDCRoute, 0, len(a.browsers))
	for _, p := range a.browsers {
		oidc = append(oidc, OIDCRoute{
			Name:     p.Name(),
			Login:    a.handleOIDCLoginWith(p),
			Callback: a.handleOIDCCallbackWith(p),
		})
	}
	return &ClientHandlers{
		Login:          a.handleLogin,
		Logout:         a.handleLogout,
		Me:             a.handleMe,
		Usage:          a.handleUsageSummary,
		ChangePassword: a.handleChangePassword,
		OIDC:           oidc,
	}
}

// AdminHandlers 服务端管理面(webadmin)handler 集合。
// 含 RBAC 权限点位: 路径声明由 router 包集中, 权限由 AdminRoute 申报。
type AdminHandlers struct {
	Login            gin.HandlerFunc // 公开: 管理登录
	LoginMFA         gin.HandlerFunc // 公开: 两步登录第二步(0057)
	PublicMethods    gin.HandlerFunc // 公开: 登录方式发现
	Me               gin.HandlerFunc
	Logout           gin.HandlerFunc
	MePassword       gin.HandlerFunc // POST /me/password 管理员改自己密码(0057)
	GetMyMFA         gin.HandlerFunc // GET /me/mfa
	EnableMyMFA      gin.HandlerFunc // POST /me/mfa/enable
	VerifyMyMFA      gin.HandlerFunc // POST /me/mfa/verify
	DisableMyMFA     gin.HandlerFunc // POST /me/mfa/disable
	ResetUserMFA     gin.HandlerFunc // PUT /users/:id/mfa 重置他人 MFA
	ListUsers        gin.HandlerFunc
	CreateUser       gin.HandlerFunc
	UpdateUser       gin.HandlerFunc
	DeleteUser       gin.HandlerFunc
	GetUserGroups    gin.HandlerFunc
	SetUserDept      gin.HandlerFunc
	ListDepts        gin.HandlerFunc
	CreateDept       gin.HandlerFunc
	UpdateDept       gin.HandlerFunc
	DeleteDept       gin.HandlerFunc
	ListUserTokens   gin.HandlerFunc
	RevokeToken      gin.HandlerFunc
	Usage            gin.HandlerFunc
	UsageOverview    gin.HandlerFunc // GET /usage/overview(2026-09 用量中心总览)
	UsageRequests    gin.HandlerFunc // GET /usage/requests(2026-09 请求级明细)
	ServerInfo       gin.HandlerFunc
	ListAuditLogs    gin.HandlerFunc
	GetAuditSettings gin.HandlerFunc // GET /audit/settings 审计保留策略(G13)
	PutAuditSettings gin.HandlerFunc // PUT /audit/settings 审计保留策略(仅 super_admin)
	GetAuthConfig    gin.HandlerFunc
	SetAuthConfig    gin.HandlerFunc
	TestConn         gin.HandlerFunc
}

// AdminHandlers 返回服务端管理面 handler 集合(供 router 包集中声明路由)。
func (a *AdminAPI) Handlers() *AdminHandlers {
	return &AdminHandlers{
		Login:            a.handleLogin,
		LoginMFA:         a.handleLoginMFA,
		PublicMethods:    a.getPublicAuthMethods,
		Me:               a.handleMe,
		Logout:           a.handleLogout,
		MePassword:       a.handleMePassword,
		GetMyMFA:         a.getMyMFA,
		EnableMyMFA:      a.enableMyMFA,
		VerifyMyMFA:      a.verifyMyMFA,
		DisableMyMFA:     a.disableMyMFA,
		ResetUserMFA:     a.resetUserMFA,
		ListUsers:        a.listUsers,
		CreateUser:       a.createUser,
		UpdateUser:       a.updateUser,
		DeleteUser:       a.deleteUser,
		GetUserGroups:    a.getUserGroups,
		SetUserDept:      a.setUserDepartment,
		ListDepts:        a.listDepartments,
		CreateDept:       a.createDepartment,
		UpdateDept:       a.updateDepartment,
		DeleteDept:       a.deleteDepartment,
		ListUserTokens:   a.listUserTokens,
		RevokeToken:      a.revokeToken,
		Usage:            a.usage,
		UsageOverview:    a.usageOverview,
		UsageRequests:    a.usageRequests,
		ServerInfo:       a.handleServerInfo,
		ListAuditLogs:    a.listAuditLogs,
		GetAuditSettings: a.getAuditSettings,
		PutAuditSettings: a.putAuditSettings,
		GetAuthConfig:    a.getAuthConfig,
		SetAuthConfig:    a.setAuthConfig,
		TestConn:         a.testAuthConnection,
	}
}
