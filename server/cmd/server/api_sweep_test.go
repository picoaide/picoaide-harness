package main

// api_sweep_test.go —— 全路由 API 契约扫描（2026-09-19，用户要求
// 「用 API 测试所有 API 的请求，返回值都正常」）。
//
// 与既有用例的分工：main_test.go 断言"路由存在且命名空间正确"、
// routes_source_test.go 断言"测试树 == 生产装配树"；本文件**真的把每一条路由
// 都请求一遍**，并对响应形状做契约断言。这是唯一能发现"路由注册了、但一请求
// 就 5xx / 返回 HTML / 空 body"的手段 —— 路由表本身看不出来。
//
// 扫描做的事（逐条断言，失败信息带 method+path+status+content-type+body 摘要）：
//
//	A. 路径参数替换：每条路由都能按**唯一一份**规则生成可请求路径，并且该路径
//	   确实命中所属路由（自证，不是"看起来像"）；
//	B. API 命名空间（/api/server/**、/api/client/v2/**）与 LLM 网关（/v1/**、
//	   无前缀原生端点）必须返回 application/json + JSON 对象 body；未认证时
//	   必须带 {"error":{"code","message"}} 信封（管理面 401 AUTH_REQUIRED、
//	   客户端面 401 AUTH_REQUIRED）；
//	C. 没有非预期的 5xx：允许的例外是**声明式白名单**（每条写清理由），
//	   其余 5xx 一律失败并把 status/body 打出来；
//	D. 非 JSON 例外必须声明式登记（产品 HTML 面、探针、渠道素材、二进制下载、
//	   SSE），且每条都要**真的被扫到**并断言"它确实是那个例外"，反向也成立：
//	   不在例外表里的路由没有一条返回 HTML / 空 body；
//	E. 可读汇总（t.Logf）：总路由数 / JSON 断言数 / 例外数 / 未预期 5xx 数。
//
// 失败即定位：所有失败信息都带 `METHOD 请求路径（路由模板 …）`。

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/llmgateway"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/skillseed"
	"github.com/picoaide/picoaide/webadmin"
)

// ---------------------------------------------------------------------------
// A. 路径参数替换规则（唯一一份；扫描时自证）
// ---------------------------------------------------------------------------

// sweepParamValues 是路径参数的替换值表：**每个参数名一条**，逐条如下：
//
//	:id        → 1   资源主键（users/departments/models/providers/connectors…）
//	:app_id    → 1   WASM 应用标识（"1" 是合法 app_id 形状；鉴权在参数校验之前）
//	:upload_id → 1   分片上传会话 id
//	:index     → 1   分片序号（数字，必须是数字形状）
//	:version   → 1   版本号（必须是版本形状）
//	:name      → x   技能/智能体/预设名（非数字，用 x）
//	:kind      → x   能力类别（apps/:kind/:app_id/owner、capability-locks/:kind/:name）
//	*file      → x   通配捕获（/updates/client/*file）
//
// 新增参数名时**必须在这里显式登记**：没登记的名字会让扫描失败（而不是静默
// 拼出一个打不到任何路由的路径）——这正是"有例外就显式登记"的落地。
var sweepParamValues = map[string]string{
	"id":        "1",
	"app_id":    "1",
	"upload_id": "1",
	"index":     "1",
	"version":   "1",
	"name":      "x",
	"kind":      "x",
}

// sweepWildcardValue 是 `*name` 通配段的替换值。
const sweepWildcardValue = "x"

// sweepRequestPath 把 gin 路由模板变成可请求路径。
//
// 返回 error 的情形只有两种：未登记的参数名（逼迫登记），以及替换后仍残留
// `:`/`*` 段（规则漏了某种写法）。
func sweepRequestPath(route string) (string, error) {
	if route == "/" {
		return "/", nil
	}
	segs := strings.Split(route, "/")
	for i, seg := range segs {
		switch {
		case strings.HasPrefix(seg, ":"):
			name := seg[1:]
			v, ok := sweepParamValues[name]
			if !ok {
				return "", fmt.Errorf("参数名 %q 未在 sweepParamValues 登记", name)
			}
			segs[i] = v
		case strings.HasPrefix(seg, "*"):
			segs[i] = sweepWildcardValue
		}
	}
	out := strings.Join(segs, "/")
	for _, seg := range strings.Split(out, "/") {
		if strings.HasPrefix(seg, ":") || strings.HasPrefix(seg, "*") {
			return "", fmt.Errorf("替换后仍残留参数段 %q（路径 %q）", seg, out)
		}
	}
	return out, nil
}

// sweepPatternMatches 判定 gin 路由模板是否匹配一个具体路径
// （`:name` 匹配单段、`*name` 匹配剩余全部段）。
func sweepPatternMatches(pattern, path string) bool {
	if pattern == "/" {
		return path == "/"
	}
	ps := strings.Split(strings.Trim(pattern, "/"), "/")
	xs := strings.Split(strings.Trim(path, "/"), "/")
	for i, p := range ps {
		switch {
		case strings.HasPrefix(p, "*"):
			return true // 通配吃掉剩余全部（gin 语义：至少一段，本表恒给一段）
		case strings.HasPrefix(p, ":"):
			if i >= len(xs) {
				return false
			}
		default:
			if i >= len(xs) || p != xs[i] {
				return false
			}
		}
	}
	return len(ps) == len(xs)
}

// ---------------------------------------------------------------------------
// 响应分类与期望声明
// ---------------------------------------------------------------------------

const (
	sweepClassJSON  = "json"  // application/json（前缀匹配）
	sweepClassHTML  = "html"  // text/html
	sweepClassEmpty = "empty" // 空 body（重定向等）
	sweepClassOther = "other" // 其它一律落到这里（图片、安装包字节…）
)

func sweepClassify(contentType string, body []byte) string {
	switch {
	case len(body) == 0:
		return sweepClassEmpty
	case strings.HasPrefix(contentType, "application/json"):
		return sweepClassJSON
	case strings.HasPrefix(contentType, "text/html"):
		return sweepClassHTML
	default:
		return sweepClassOther
	}
}

// sweepExpect 是一条路由（或 NoRoute 路径）的响应契约期望。
type sweepExpect struct {
	statuses []int    // 允许的状态码（未认证扫描下的确定值）
	classes  []string // 允许的响应类别
	why      string   // 为什么是这样 —— 例外必须写清理由
	// auth401 为 true 时额外断言"401 + AUTH_REQUIRED 信封"。
	auth401 bool
}

// sweepHit 是一次扫描的原始记录。
type sweepHit struct {
	method  string
	route   string // 路由模板（NoRoute 面 = 请求路径本身）
	reqPath string
	status  int
	ct      string
	header  http.Header
	body    []byte
	class   string
}

// label 是失败信息里的定位串（method + 请求路径 + 路由模板）。
func (h sweepHit) label() string {
	if h.route == h.reqPath {
		return fmt.Sprintf("%s %s", h.method, h.reqPath)
	}
	return fmt.Sprintf("%s %s（路由模板 %s）", h.method, h.reqPath, h.route)
}

// bodySummary 截断响应体用于日志/失败信息（不打印整页 HTML）。
func (h sweepHit) bodySummary() string {
	s := strings.ReplaceAll(strings.TrimSpace(string(h.body)), "\n", " ")
	if len([]rune(s)) > 200 {
		return string([]rune(s)[:200]) + "…"
	}
	return s
}

// isAPINamespace 判定路由是否属于两个 API 命名空间（强制 JSON 契约）。
func isAPINamespace(route string) bool {
	return strings.HasPrefix(route, "/api/server/") || strings.HasPrefix(route, "/api/client/v2/")
}

// isGatewayRoute 判定路由是否属于 LLM 网关（/v1/** 或官方原生无前缀端点）。
func isGatewayRoute(route string) bool {
	if strings.HasPrefix(route, "/v1/") {
		return true
	}
	switch route {
	case "/models", "/chat/completions", "/embeddings", "/completions", "/responses", "/messages":
		return true
	}
	return false
}

// sweepPublicAPIRoutes 是**未认证即可达**的 API 路由（不在 AdminAuth/BearerAuth
// 之后）。登记它们等于声明"这些不是漏挂鉴权"：每条都写清为什么公开。
var sweepPublicAPIRoutes = map[string]sweepExpect{
	// --- 管理面公开入口（webadmin 登录页要用） ---
	"POST /api/server/admin/login": {
		statuses: []int{400, 401, 403, 429}, classes: []string{sweepClassJSON},
		why: "管理员登录入口（公开）；空 body ⇒ VALIDATION 信封，密码错/限流是 401/429",
	},
	"POST /api/server/admin/login/mfa": {
		statuses: []int{400, 401, 403, 429}, classes: []string{sweepClassJSON},
		why: "管理员 MFA 第二步（公开）；无票据 ⇒ 400/401 信封",
	},
	"GET /api/server/admin/auth/methods": {
		statuses: []int{200}, classes: []string{sweepClassJSON},
		why: "登录页要显示可用登录方式（公开只读）",
	},
	// --- 客户端面公开入口 ---
	"POST /api/client/v2/auth/login": {
		statuses: []int{400, 401, 403, 429}, classes: []string{sweepClassJSON},
		why: "员工账密登录（公开）；空 body ⇒ VALIDATION 信封",
	},
	"GET /api/client/v2/auth/methods": {
		statuses: []int{200}, classes: []string{sweepClassJSON},
		why: "客户端登录页要显示可用登录方式（公开只读）",
	},
	"GET /api/client/v2/auth/oidc/login": {
		statuses: []int{400, 404}, classes: []string{sweepClassJSON},
		why: "OIDC 跳转入口（公开）；未配置该登录方式 ⇒ 404 信封（不泄露配置）",
	},
	"GET /api/client/v2/auth/oidc/callback": {
		statuses: []int{400, 404}, classes: []string{sweepClassJSON},
		why: "OIDC 回调（公开，IdP 直接重定向过来）；未配置 ⇒ 404 信封",
	},
	"GET /api/client/v2/auth/openid/login": {
		statuses: []int{400, 404}, classes: []string{sweepClassJSON},
		why: "OpenID 跳转入口（公开）；未配置 ⇒ 404 信封",
	},
	"GET /api/client/v2/auth/openid/callback": {
		statuses: []int{400, 404}, classes: []string{sweepClassJSON},
		why: "OpenID 回调（公开）；未配置 ⇒ 404 信封",
	},
	"GET /api/client/v2/channel": {
		statuses: []int{200}, classes: []string{sweepClassJSON},
		why: "渠道内容下发（登录页/门户共用，公开）",
	},
	"GET /api/client/v2/updates/manifest": {
		statuses: []int{200}, classes: []string{sweepClassJSON},
		why: "客户端更新清单（公开；客户端未登录就要能检查更新）",
	},
	// --- 渠道素材（公开）：配置了渠道 logo 时是图片，未配置时是 404 JSON 信封 ---
	"GET /api/client/v2/channel/logo": {
		statuses: []int{200, 404}, classes: []string{sweepClassJSON, sweepClassOther},
		why: "渠道 logo 素材：已配置 ⇒ 图片字节（产品二进制面）；未配置 ⇒ 404 JSON 信封",
	},
	"GET /api/client/v2/channel/logo-dark": {
		statuses: []int{200, 404}, classes: []string{sweepClassJSON, sweepClassOther},
		why: "渠道暗色 logo：同上",
	},
	"GET /api/client/v2/channel/favicon": {
		statuses: []int{200, 404}, classes: []string{sweepClassJSON, sweepClassOther},
		why: "渠道站点图标：同上",
	},
	"HEAD /api/client/v2/channel/logo": {
		statuses: []int{200, 404}, classes: []string{sweepClassJSON, sweepClassOther},
		why: "同上（HEAD 变体）",
	},
	"HEAD /api/client/v2/channel/logo-dark": {
		statuses: []int{200, 404}, classes: []string{sweepClassJSON, sweepClassOther},
		why: "同上（HEAD 变体）",
	},
	"HEAD /api/client/v2/channel/favicon": {
		statuses: []int{200, 404}, classes: []string{sweepClassJSON, sweepClassOther},
		why: "同上（HEAD 变体）",
	},
}

// sweepNonAPIRoutes 是**不在两个 API 命名空间**、但注册在路由树里的端点。
// 它们同样必须显式登记（新增根路径端点却没人登记 ⇒ 扫描失败）。
var sweepNonAPIRoutes = map[string]sweepExpect{
	"GET /healthz": {
		statuses: []int{200}, classes: []string{sweepClassJSON},
		why: "健康探针（JSON {ok:true}；不属于 API 契约，没有错误信封要求）",
	},
	"GET /readyz": {
		statuses: []int{200, 503}, classes: []string{sweepClassJSON},
		why: "水位探针：磁盘/缓存/编译队列低于阈值时按设计返回 503（§4.9「低于阈值红灯」）——" +
			"它是探针不是业务接口，503 正是它要说的话（见 sweepAllowed5xx）",
	},
	"GET /updates/client/*file": {
		statuses: []int{404}, classes: []string{sweepClassJSON, sweepClassOther},
		why: "客户端安装包下载（二进制面）：本机无资产目录 ⇒ 404 JSON 信封；有资产 ⇒ 原样字节",
	},
	"HEAD /updates/client/*file": {
		statuses: []int{404}, classes: []string{sweepClassJSON, sweepClassOther},
		why: "同上（HEAD 变体，Range/断点续传用）",
	},
	// --- 员工浏览器会话与换票（主站 HTML 面，不是 API） ---
	"GET /login": {
		statuses: []int{200}, classes: []string{sweepClassHTML},
		why: "员工登录页（注入式 HTML，零外部资源）",
	},
	"POST /login": {
		statuses: []int{403}, classes: []string{sweepClassHTML},
		why: "登录提交：非幂等请求必须来自主站源（无 Origin/Referer 的裸请求 fail-closed 403 HTML）",
	},
	"POST /logout": {
		statuses: []int{403}, classes: []string{sweepClassHTML},
		why: "登出：同上（Origin 校验）",
	},
	"GET /app-ticket": {
		statuses: []int{404}, classes: []string{sweepClassHTML},
		why: "换票确认页：未配置应用基域时 404（本测试装配 BaseDomain 为空）",
	},
	"POST /app-ticket": {
		statuses: []int{404}, classes: []string{sweepClassHTML},
		why: "换票签发：同上（必须 POST + Origin == 主站源，见 session.Manager）",
	},
	// --- LLM 网关的官方原生无前缀端点（带 /v1 前缀的走 isGatewayRoute 默认） ---
	"GET /models":            {statuses: []int{401}, classes: []string{sweepClassJSON}, why: "LLM 网关（BearerAuth）", auth401: true},
	"POST /chat/completions": {statuses: []int{401}, classes: []string{sweepClassJSON}, why: "LLM 网关（BearerAuth）", auth401: true},
	"POST /completions":      {statuses: []int{401}, classes: []string{sweepClassJSON}, why: "LLM 网关（BearerAuth）", auth401: true},
	"POST /embeddings":       {statuses: []int{401}, classes: []string{sweepClassJSON}, why: "LLM 网关（BearerAuth）", auth401: true},
	"POST /responses":        {statuses: []int{401}, classes: []string{sweepClassJSON}, why: "LLM 网关（BearerAuth）", auth401: true},
	"POST /messages":         {statuses: []int{401}, classes: []string{sweepClassJSON}, why: "LLM 网关（BearerAuth）", auth401: true},
}

// sweepAuthGatedJSONSurfaces 是"产品响应不是 JSON、但**未认证扫描只能看到
// JSON 401**"的路由：二进制归档下载（application/gzip）与 SSE
// （text/event-stream）。它们必须登记在案，并有**正向举证**用例
// （TestAPISweepExceptionEvidence*）证明"例外确实是那个例外"。
//
// 为什么不能在看板上只写"它们是例外"：扫描是未认证的，鉴权闸先于内容类型生效，
// 这两族路由在扫描里逐条都是 JSON 401 —— 若不写清，读者会以为"扫描没覆盖到"。
var sweepAuthGatedNonJSONSurfaces = map[string]string{
	// application/gzip（archiveutil 打包的技能/智能体归档）
	"GET /api/client/v2/skills/builtin/:name/archive":            "内置技能归档（application/gzip）",
	"GET /api/client/v2/marketplace/skills/:name/archive":        "商城技能归档（application/gzip）",
	"GET /api/client/v2/agent-presets/:name/archive":             "智能体预设归档（application/gzip）",
	"GET /api/client/v2/agent-presets/:name/:version/archive":    "智能体预设指定版本归档（application/gzip）",
	"GET /api/client/v2/shared-skills/:name/:version/archive":    "组织共享技能归档（application/gzip）",
	"POST /api/server/admin/skills/:name/archive":                "管理端技能归档（application/gzip，重新打包）",
	"GET /api/server/admin/skills/:name/file":                    "管理端技能单文件（原样字节）",
	"GET /api/server/admin/agents/:name/file":                    "管理端智能体单文件（原样字节）",
	"GET /api/server/admin/agent-presets/:name/archive":          "管理端预设归档（application/gzip）",
	"GET /api/server/admin/agent-presets/:name/:version/archive": "管理端预设指定版本归档（application/gzip）",
	"GET /api/server/admin/agent-presets/:name/:version/file":    "管理端预设单文件（原样字节）",
	"GET /api/server/admin/shared-skills/:name/:version/archive": "管理端组织共享技能归档（application/gzip）",
	"GET /api/server/admin/shared-skills/:name/:version/file":    "管理端组织共享技能单文件（原样字节）",
	// text/event-stream（上游流式转发）
	"POST /v1/chat/completions": "OpenAI 兼容流式对话（stream=true ⇒ text/event-stream）",
	"POST /v1/messages":         "Anthropic 兼容流式对话（stream=true ⇒ text/event-stream）",
	"POST /chat/completions":    "官方原生无前缀变体（同上）",
	"POST /messages":            "官方原生无前缀变体（同上）",
}

// sweepAllowed5xx 是允许的 5xx 白名单（声明式，每条写清理由）。
//
// 除这里列出的以外，任何 5xx 都是失败 —— 这是本次扫描最有价值的一条断言：
// "路由注册了但一请求就崩"在路由表上完全看不出来。
var sweepAllowed5xx = map[string]string{
	"GET /readyz": "水位探针按设计用 503 表达「低于阈值」（磁盘 < 1 GiB / 编译不可用等），" +
		"它不是业务接口，503 是它的正常语义",
}

// ---------------------------------------------------------------------------
// 扫描主体
// ---------------------------------------------------------------------------

// sweepExpectationFor 返回一条路由的期望；未登记的路由返回 false（必须显式登记）。
func sweepExpectationFor(method, route string) (sweepExpect, bool) {
	key := method + " " + route
	if e, ok := sweepPublicAPIRoutes[key]; ok {
		return e, true
	}
	if e, ok := sweepNonAPIRoutes[key]; ok {
		return e, true
	}
	if isAPINamespace(route) || isGatewayRoute(route) {
		// 默认：认证闸之后的 API。未认证必须 401 + AUTH_REQUIRED 信封。
		return sweepExpect{
			statuses: []int{401}, classes: []string{sweepClassJSON}, auth401: true,
			why: "认证闸（AdminAuth/BearerAuth）之后的 API：未认证 ⇒ 401 + AUTH_REQUIRED 信封",
		}, true
	}
	return sweepExpect{}, false
}

// sweepEngine 构造扫描用的完整生产路由树（真实 DB + 与生产同序的 NoRoute 护栏）。
func sweepEngine(t *testing.T, db *sql.DB) *gin.Engine {
	t.Helper()
	r := buildRouterWithDB(t, db)
	dist, _ := fs.Sub(webadmin.FS, "dist")
	mountAPIGuards(r, db, http.FileServer(http.FS(dist)), dist)
	return r
}

// sweepDo 发一次真实请求（httptest + r.ServeHTTP，与生产同一棵路由树）。
func sweepDo(r *gin.Engine, method, path string) sweepHit {
	req := httptest.NewRequest(method, path, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	body := w.Body.Bytes()
	ct := w.Header().Get("Content-Type")
	return sweepHit{
		method: method, reqPath: path, status: w.Code, ct: ct,
		header: w.Header(), body: body, class: sweepClassify(ct, body),
	}
}

// TestAPISweepAllRoutesContract：全路由扫描主用例（见文件头 A–E）。
func TestAPISweepAllRoutesContract(t *testing.T) {
	sweepSilenceAccessLog(t)
	db := requireRealDB(t)
	r := sweepEngine(t, db)

	routes := r.Routes()
	// 模板集合（自证"替换出的路径确实命中所属路由"用）。
	templates := make(map[string][]string, len(routes))

	// ---- A. 替换规则自证 ----
	for _, rt := range routes {
		p, err := sweepRequestPath(rt.Path)
		if err != nil {
			t.Fatalf("路由 %s %s 无法生成可请求路径：%v", rt.Method, rt.Path, err)
		}
		if !sweepPatternMatches(rt.Path, p) {
			t.Fatalf("替换规则不自洽：路由 %s %s 替换出 %s，但该路径不匹配自身模板", rt.Method, rt.Path, p)
		}
		templates[rt.Method+" "+p] = append(templates[rt.Method+" "+p], rt.Path)
	}
	t.Logf("路径参数替换规则：%s；通配 *name → %q（共 %d 条路由全部生成出可请求路径）",
		sweepParamRuleSummary(), sweepWildcardValue, len(routes))

	// ---- B/C/D. 逐条请求 + 契约断言 ----
	var hits []sweepHit
	var problems []string
	jsonAsserted, htmlHits := 0, 0
	var unexpected5xx []sweepHit

	for _, rt := range routes {
		p, err := sweepRequestPath(rt.Path)
		if err != nil {
			t.Fatalf("路由 %s %s：%v", rt.Method, rt.Path, err)
		}
		h := sweepDo(r, rt.Method, p)
		h.route = rt.Path
		hits = append(hits, h)

		// 该请求路径只能命中"自己"（多命中说明替换值把两条路由合并了，
		// 扫描会变成给别的路由发请求 —— 那是最隐蔽的假绿）。
		if got := templates[rt.Method+" "+p]; len(got) != 1 || got[0] != rt.Path {
			problems = append(problems, fmt.Sprintf(
				"%s：替换出的请求路径同时命中 %v（预期只有 %s）—— 替换值冲突，扫描覆盖不可信",
				h.label(), got, rt.Path))
			continue
		}

		exp, registered := sweepExpectationFor(rt.Method, rt.Path)
		if !registered {
			problems = append(problems, fmt.Sprintf(
				"%s：未登记契约期望（新增路由必须在 api_sweep_test.go 的期望表里显式登记，或它落进了未覆盖的命名空间）",
				h.label()))
			continue
		}

		if !sweepContains(exp.classes, h.class) {
			problems = append(problems, fmt.Sprintf(
				"%s：响应类别 %s 不在期望 %v 内（%s）；status=%d content-type=%q body=%s",
				h.label(), h.class, exp.classes, exp.why, h.status, h.ct, h.bodySummary()))
		}
		if !sweepContainsInt(exp.statuses, h.status) {
			problems = append(problems, fmt.Sprintf(
				"%s：status=%d 不在期望 %v 内（%s）；content-type=%q body=%s",
				h.label(), h.status, exp.statuses, exp.why, h.ct, h.bodySummary()))
		}

		if h.class == sweepClassHTML {
			htmlHits++
		}

		// API 命名空间 + 网关：JSON 对象 + 错误信封（未认证一律带信封）。
		if isAPINamespace(rt.Path) || isGatewayRoute(rt.Path) {
			jsonAsserted++
			if h.class != sweepClassJSON {
				problems = append(problems, fmt.Sprintf(
					"%s：API 必须返回 application/json，实际 %q（body=%s）",
					h.label(), h.ct, h.bodySummary()))
			} else if err := sweepAssertJSONObject(h); err != nil {
				problems = append(problems, fmt.Sprintf("%s：%v", h.label(), err))
			} else if h.status >= 400 {
				if code, msg, ok := sweepErrorEnvelope(h.body); !ok {
					problems = append(problems, fmt.Sprintf(
						"%s：非 2xx 响应缺少 {\"error\":{\"code\",\"message\"}} 信封；status=%d body=%s",
						h.label(), h.status, h.bodySummary()))
				} else if exp.auth401 && (h.status != 401 || code != "AUTH_REQUIRED") {
					problems = append(problems, fmt.Sprintf(
						"%s：未认证必须 401 + AUTH_REQUIRED，实际 %d + %q（message=%q）",
						h.label(), h.status, code, msg))
				}
			}
		}

		if h.status >= 500 {
			if _, allowed := sweepAllowed5xx[rt.Method+" "+rt.Path]; !allowed {
				unexpected5xx = append(unexpected5xx, h)
			}
		}
	}

	// ---- D2. NoRoute 产品 HTML 面（不在 r.Routes() 里，由 mountAPIGuards 提供） ----
	noRouteHits := sweepNoRouteSurfaces(t, r, &problems, &htmlHits)

	// ---- D3. 例外表双向一致：登记了必须命中，未登记不许出现 HTML/空 body ----
	problems = append(problems, sweepCheckExceptionTables(routes, hits)...)

	// ---- C. 未预期 5xx ----
	for _, h := range unexpected5xx {
		problems = append(problems, fmt.Sprintf(
			"%s：未预期的 %d（不在 sweepAllowed5xx 白名单里）；content-type=%q body=%s",
			h.label(), h.status, h.ct, h.bodySummary()))
	}

	// ---- E. 汇总 ----
	t.Logf("扫描汇总：路由 %d 条 + NoRoute 产品面 %d 条；JSON 契约断言 %d 条；HTML 例外命中 %d 条；"+
		"认证闸后非 JSON 例外登记 %d 条；未预期 5xx %d 条",
		len(hits), noRouteHits, jsonAsserted, htmlHits, len(sweepAuthGatedNonJSONSurfaces), len(unexpected5xx))

	if len(problems) > 0 {
		sort.Strings(problems)
		t.Fatalf("全路由 API 契约扫描发现 %d 个问题：\n  - %s",
			len(problems), strings.Join(problems, "\n  - "))
	}
}

// sweepNoRouteSurfaces 请求并断言 NoRoute 提供的产品 HTML 面（`/`、`/portal`、
// `/admin/*`）。这些是"非 JSON 例外"里最容易被漏掉的一半：它们不在 r.Routes()。
func sweepNoRouteSurfaces(t *testing.T, r *gin.Engine, problems *[]string, htmlHits *int) int {
	t.Helper()
	type surface struct {
		method, path string
		statuses     []int
		classes      []string
		why          string
	}
	// /admin/* 是 Vite SPA：dist 已构建 ⇒ 200 HTML；未构建 ⇒ 404 JSON（既有语义，
	// 见 TestAdminResponsesCarrySecurityHeaders 的 distBuilt 分支）。
	surfaces := []surface{
		{"GET", "/", []int{200}, []string{sweepClassHTML}, "门户首页（零脚本 HTML）"},
		{"GET", "/portal", []int{200}, []string{sweepClassHTML}, "门户页（同上）"},
		{"GET", "/admin", []int{302}, []string{sweepClassHTML, sweepClassEmpty},
			"/admin ⇒ /admin/ 的既有重定向（http.Redirect 对 GET 会带一小段 HTML body）"},
		{"GET", "/admin/", []int{200, 404}, []string{sweepClassHTML, sweepClassJSON},
			"webadmin SPA 入口：dist 未构建时是 404 JSON（既有语义）"},
		{"GET", "/admin/usage/balance", []int{200, 404}, []string{sweepClassHTML, sweepClassJSON},
			"webadmin SPA 前端路由回退：同上"},
	}
	for _, s := range surfaces {
		h := sweepDo(r, s.method, s.path)
		h.route = s.path
		if !sweepContains(s.classes, h.class) {
			*problems = append(*problems, fmt.Sprintf(
				"%s：NoRoute 产品面期望类别 %v，实际 %s；status=%d content-type=%q body=%s",
				h.label(), s.classes, h.class, h.status, h.ct, h.bodySummary()))
		}
		if !sweepContainsInt(s.statuses, h.status) {
			*problems = append(*problems, fmt.Sprintf(
				"%s：NoRoute 产品面期望 status %v，实际 %d（%s）；content-type=%q",
				h.label(), s.statuses, h.status, s.why, h.ct))
		}
		if h.class == sweepClassHTML {
			*htmlHits++
		}
	}
	// 反向：NoRoute 的**兜底分支**（任意未登记根路径）必须是 JSON 404 信封，
	// 否则"不在例外表里的路径不返回 HTML"这条在产品 HTML 面之外就不成立。
	fallback := sweepDo(r, "GET", "/sweep-unknown-root-surface")
	if fallback.class != sweepClassJSON || fallback.status != http.StatusNotFound {
		*problems = append(*problems, fmt.Sprintf(
			"%s：NoRoute 兜底必须是 404 JSON 信封，实际 status=%d content-type=%q body=%s",
			fallback.label(), fallback.status, fallback.ct, fallback.bodySummary()))
	}
	return len(surfaces) + 1
}

// sweepCheckExceptionTables 做例外表的**双向**一致性检查。
func sweepCheckExceptionTables(routes gin.RoutesInfo, hits []sweepHit) []string {
	var problems []string

	// 未登记却返回 HTML / 空 body 的路由：非 JSON 面必须显式登记。
	sweptHTML := make(map[string]sweepHit)
	for _, h := range hits {
		if h.class == sweepClassHTML || h.class == sweepClassEmpty {
			sweptHTML[h.method+" "+h.route] = h
		}
	}
	for _, h := range sweptHTML {
		exp, ok := sweepExpectationFor(h.method, h.route)
		if !ok || !sweepContains(exp.classes, h.class) {
			problems = append(problems, fmt.Sprintf(
				"%s：返回了 %s（非 JSON 例外）却没有登记期望 —— 例外必须声明式登记",
				h.label(), h.class))
		}
	}

	// 例外表里的条目必须真的被扫到（不能只在表里挂着却 never 命中）。
	swept := make(map[string]bool, len(hits))
	for _, h := range hits {
		swept[h.method+" "+h.route] = true
	}
	registered := make(map[string]bool, len(routes))
	for _, rt := range routes {
		registered[rt.Method+" "+rt.Path] = true
	}
	// 认证闸后的非 JSON 面：既要登记，也必须真的在扫描里（看到的是 JSON 401）。
	for route, why := range sweepAuthGatedNonJSONSurfaces {
		if !swept[route] {
			problems = append(problems, fmt.Sprintf(
				"例外登记表里的 %s（%s）没有出现在扫描里：登记了却 never 命中 ⇒ 表在说谎", route, why))
			continue
		}
		if !registered[route] {
			problems = append(problems, fmt.Sprintf(
				"例外登记表里的 %s 根本不在路由树里（已下线却没人删登记）", route))
		}
	}
	// 5xx 白名单条目同样必须真的被扫到。
	for route, why := range sweepAllowed5xx {
		if !swept[route] {
			problems = append(problems, fmt.Sprintf(
				"5xx 白名单里的 %s（%s）没有被扫到 ⇒ 白名单条目已过期", route, why))
		}
	}
	// 公开路由表 / 非 API 表：必须都命中（防"表里挂着一条早已删掉的路由"）。
	for _, table := range []map[string]sweepExpect{sweepPublicAPIRoutes, sweepNonAPIRoutes} {
		for route := range table {
			if !swept[route] {
				problems = append(problems, fmt.Sprintf(
					"期望表里的 %s 没有被扫到（路由已删/改名，或 method 写错）", route))
			}
		}
	}
	return problems
}

// sweepParamRuleSummary 把替换规则渲染成一行（日志与失败信息共用）。
func sweepParamRuleSummary() string {
	names := make([]string, 0, len(sweepParamValues))
	for k := range sweepParamValues {
		names = append(names, ":"+k)
	}
	sort.Strings(names)
	parts := make([]string, 0, len(names))
	for _, n := range names {
		parts = append(parts, fmt.Sprintf("%s→%s", n, sweepParamValues[strings.TrimPrefix(n, ":")]))
	}
	return strings.Join(parts, " ")
}

// sweepAssertJSONObject 断言 body 能 unmarshal 成 JSON 对象。
func sweepAssertJSONObject(h sweepHit) error {
	var obj map[string]any
	if err := json.Unmarshal(h.body, &obj); err != nil {
		return fmt.Errorf("body 不是 JSON 对象：%v；content-type=%q body=%s", err, h.ct, h.bodySummary())
	}
	return nil
}

// sweepErrorEnvelope 解析 {"error":{"code","message"}} 信封。
func sweepErrorEnvelope(body []byte) (code, message string, ok bool) {
	var payload struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", "", false
	}
	if payload.Error.Code == "" || payload.Error.Message == "" {
		return payload.Error.Code, payload.Error.Message, false
	}
	return payload.Error.Code, payload.Error.Message, true
}

func sweepContains(set []string, v string) bool {
	for _, s := range set {
		if s == v {
			return true
		}
	}
	return false
}

func sweepContainsInt(set []int, v int) bool {
	for _, s := range set {
		if s == v {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// 非 JSON 例外的正向举证
// ---------------------------------------------------------------------------

// assertDeclaredNonJSON 断言某条路由登记在"认证闸后非 JSON 面"表里，且申报的
// 内容类型与正向举证一致（删掉/改错登记 ⇒ 举证用例红，例外表因此是载荷而非注释）。
func assertDeclaredNonJSON(t *testing.T, route, wantContentType string) {
	t.Helper()
	why, ok := sweepAuthGatedNonJSONSurfaces[route]
	if !ok {
		t.Fatalf("%s 未登记在 sweepAuthGatedNonJSONSurfaces：非 JSON 例外必须显式登记"+
			"（它未认证时是 JSON 401，扫描里看不出真实内容类型）", route)
	}
	if !strings.Contains(why, wantContentType) {
		t.Fatalf("%s 的登记理由是 %q，未申报 %s", route, why, wantContentType)
	}
}

// sweepIssueToken 造一个真实用户并签发客户端 Bearer 令牌。
func sweepIssueToken(t *testing.T, db *sql.DB, username string) string {
	t.Helper()
	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: username, Source: "local", Status: 1})
	if err != nil {
		t.Fatalf("建用户 %s: %v", username, err)
	}
	token, err := serverauth.IssueToken(db, uid)
	if err != nil {
		t.Fatalf("签发令牌: %v", err)
	}
	return token
}

// sweepDoAuthed 带 Bearer 令牌发一次请求（route 是路由模板，仅用于日志/失败信息）。
func sweepDoAuthed(r *gin.Engine, method, route, path, token string) sweepHit {
	req := httptest.NewRequest(method, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	body := w.Body.Bytes()
	ct := w.Header().Get("Content-Type")
	return sweepHit{
		method: method, route: route, reqPath: path, status: w.Code, ct: ct,
		header: w.Header(), body: body, class: sweepClassify(ct, body),
	}
}

// sweepSilenceAccessLog 把 gin 的访问日志临时丢弃。
//
// 扫描会发 200+ 次真请求：访问日志会把失败详情挤出 CI 日志（本仓有过一次
// "CI 红了但日志里没有失败详情"的教训）。失败信息里已经带 method+path+status+
// content-type+body 摘要，不依赖访问日志；本函数只影响调用它的用例。
func sweepSilenceAccessLog(t *testing.T) {
	t.Helper()
	prev := gin.DefaultWriter
	gin.DefaultWriter = io.Discard
	t.Cleanup(func() { gin.DefaultWriter = prev })
}

// TestAPISweepExceptionEvidenceBinaryArchive：非 JSON 例外「二进制归档下载
// （application/gzip）」的**正向举证**。
//
// 为什么需要它：扫描是未认证的，BearerAuth 闸先于内容类型生效 ⇒ 归档路由在扫描里
// 逐条都是 JSON 401，看不到真实内容类型。这里带真令牌打一次内置技能归档
// （资产用仓库真实的内置技能目录 server/skills，即镜像里 /opt/picoaide/skills 的源头），
// 断言它确实是 application/gzip + 真 gzip 字节。
func TestAPISweepExceptionEvidenceBinaryArchive(t *testing.T) {
	db := requireRealDB(t)

	// 内置技能目录：把 skillseed.Dir 指到仓库真实资产（生产里由镜像提供）。
	skillsDir, err := filepath.Abs(filepath.Join("..", "..", "skills"))
	if err != nil {
		t.Fatalf("解析技能资产目录: %v", err)
	}
	if st, err := os.Stat(filepath.Join(skillsDir, "app-builder", skillseed.SkillFile)); err != nil {
		t.Fatalf("前置失败：仓库内置技能资产缺失（%s）：%v", skillsDir, err)
	} else if st.IsDir() {
		t.Fatalf("前置失败：%s 是目录", skillsDir)
	}
	prevDir := skillseed.Dir
	skillseed.Dir = skillsDir
	t.Cleanup(func() { skillseed.Dir = prevDir })

	// 例外表是**载荷**：这里正向举证的路由必须登记在案（删掉登记 ⇒ 本用例红），
	// 否则"归档是 gzip 例外"这件事可以被人从表里悄悄删掉而没人发现。
	assertDeclaredNonJSON(t, "GET /api/client/v2/skills/builtin/:name/archive", "application/gzip")

	sweepSilenceAccessLog(t)
	r := sweepEngine(t, db)
	token := sweepIssueToken(t, db, "sweep-archive")

	h := sweepDoAuthed(r, "GET", "/api/client/v2/skills/builtin/:name/archive",
		"/api/client/v2/skills/builtin/app-builder/archive", token)
	if h.status != 200 {
		t.Fatalf("%s：status=%d want 200；content-type=%q body=%s",
			h.label(), h.status, h.ct, h.bodySummary())
	}
	if !strings.HasPrefix(h.ct, "application/gzip") {
		t.Fatalf("%s：content-type=%q want application/gzip（例外登记里的二进制面）",
			h.label(), h.ct)
	}
	if len(h.body) < 3 || h.body[0] != 0x1f || h.body[1] != 0x8b {
		t.Fatalf("%s：body 不是 gzip 字节流（前 3 字节 % x）", h.label(), h.body[:min(3, len(h.body))])
	}
	if chk := h.header.Get("X-Skill-Checksum"); chk == "" {
		t.Errorf("%s：缺少 X-Skill-Checksum（客户端靠它做 sha256 对照）", h.label())
	}
	t.Logf("例外正向举证：%s ⇒ %d %s（%d 字节 gzip，X-Skill-Checksum=%s…）",
		h.label(), h.status, h.ct, len(h.body), h.header.Get("X-Skill-Checksum")[:8])
}

// TestAPISweepExceptionEvidenceSSE：非 JSON 例外「SSE（text/event-stream）」
// 的**正向举证**。
//
// 配置一个指向本进程内假上游的 provider + model，带真令牌发一次 stream=true 的
// 对话请求，断言响应确实是 text/event-stream（上游字节被原样转发）。
func TestAPISweepExceptionEvidenceSSE(t *testing.T) {
	db := requireRealDB(t)

	// 假上游：按 OpenAI 流式形态吐两帧 + [DONE]。
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	t.Cleanup(upstream.Close)

	// 测试库里的 provider 密钥是明文（与 internal/llmgateway 的测试同口径：
	// 生产装配注入的是 AES-GCM 解密，测试里换成恒等函数）。
	prevDecrypt := llmgateway.DecryptSecret
	llmgateway.DecryptSecret = func(s string) (string, error) { return s, nil }
	// 上游路由有进程内缓存：造数据前后都必须失效，否则读到别的用例/上一步的集合。
	llmgateway.InvalidateUpstreams()
	t.Cleanup(func() {
		llmgateway.DecryptSecret = prevDecrypt
		llmgateway.InvalidateUpstreams()
	})

	if _, err := db.Exec(
		`INSERT INTO gateway_providers (name, base_url, api_key_enc, models) VALUES ('sweep-fake', ?, 'k', '["sweep-model"]')`,
		upstream.URL); err != nil {
		t.Fatalf("插入上游: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO models (name, provider_id, display_name) VALUES ('sweep-model', 1, 'Sweep Model')`); err != nil {
		t.Fatalf("插入模型: %v", err)
	}

	// 例外表是**载荷**：同上，SSE 面必须登记在案。
	assertDeclaredNonJSON(t, "POST /v1/chat/completions", "text/event-stream")

	sweepSilenceAccessLog(t)
	r := sweepEngine(t, db)
	token := sweepIssueToken(t, db, "sweep-sse")

	body := `{"model":"sweep-model","messages":[{"role":"user","content":"hi"}],"stream":true}`
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	hit := sweepHit{method: "POST", route: "/v1/chat/completions", reqPath: "/v1/chat/completions",
		status: w.Code, ct: w.Header().Get("Content-Type"), header: w.Header(), body: w.Body.Bytes()}
	if hit.status != 200 {
		t.Fatalf("%s：status=%d want 200；content-type=%q body=%s",
			hit.label(), hit.status, hit.ct, hit.bodySummary())
	}
	if !strings.HasPrefix(hit.ct, "text/event-stream") {
		t.Fatalf("%s：content-type=%q want text/event-stream（例外登记里的流式面）",
			hit.label(), hit.ct)
	}
	if !strings.Contains(string(hit.body), "data: ") {
		t.Fatalf("%s：SSE 流里没有 data: 帧：%s", hit.label(), hit.bodySummary())
	}
	t.Logf("例外正向举证：%s（stream=true）⇒ %d %s（%d 字节）",
		hit.label(), hit.status, hit.ct, len(hit.body))
}
