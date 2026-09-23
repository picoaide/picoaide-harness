package serverauth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/gin-gonic/gin"
	"golang.org/x/oauth2"

	"github.com/picoaide/picoaide/internal/channel"
	"github.com/picoaide/picoaide/internal/clientrelease"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

// errOIDCState is returned by HandleCallback for unknown or reused state.
var errOIDCState = errors.New("oidc: unknown state")

// oidcFlow holds the PKCE verifier and nonce bound to a state value.
// Stored in memory: flows are invalidated on restart (accepted per plan).
type oidcFlow struct {
	verifier  string
	nonce     string
	createdAt time.Time
	// returnServer:发起 login 的客户端填写的服务端地址(深链回跳用)。
	// 浏览器跳转完成后,桌面客户端深链需要知道 token 属于哪个服务端;
	// 为空 = 未指定(默认深链只带 token,由客户端用登录页 server 填充)。
	returnServer string
	// ip 是发起本次流程的来源 IP(按信任边界解析的真实客户端 IP)。
	// 只用于在途流程配额 oidcMaxFlowsPerIP;空串 = 调用方未提供(配额不生效)。
	ip string
}

// oidcFlowTTL bounds how long a flow may sit before the callback arrives.
// oidcMaxFlows caps the in-memory map so unauthenticated /oidc/login spam
// cannot grow memory without bound.
const (
	oidcFlowTTL  = 10 * time.Minute
	oidcMaxFlows = 1000
	// oidcMaxFlowsPerIP 是**单个来源 IP** 允许同时占用的在途流程数。
	//
	// 为什么需要它(审计 2026-09-23 R5-A-18 的"保留防滥用"部分):流程启动桶
	// 改成"只对失败计数"之后,这条攻击就失去了拦阻点 —— 一个 IP 用 1000 次
	// 廉价 GET 把流程表灌满,表满即 fail-closed(见 errOIDCFlowTableFull),
	// 全组织在最长 oidcFlowTTL(10 分钟)内起不了新流程。旧语义下它被
	// "60 次/5min/IP、成功也记账"间接挡住(10 分钟最多 120 条在途)。
	//
	// 配额与**速率**无关,所以不会误伤合法流量:真人流程在数秒内被回调消费
	// (HandleCallback 立刻 delete,p.flows 里随即让位),只有"只建不消费"的
	// 灌表模式才会累积到上限。取表容量的 1/10 ⇒ 单个 IP 最多占 10%,
	// 填满全表至少需要 10 个来源 IP。
	oidcMaxFlowsPerIP = oidcMaxFlows / 10
)

// errOIDCFlowTableFull 表示在途登录流程已满:此时**拒绝新流程**(fail-closed)
// 而不是驱逐最旧的一条 —— 旧实现驱逐最旧会让攻击者用 1000 次匿名 GET 把
// 正在登录的真人流程挤掉,回调时只得到"state 无效或已过期"(审计 2026-09-13 P2-4)。
var errOIDCFlowTableFull = errors.New("oidc: too many in-flight login flows")

// errOIDCFlowQuotaPerIP 表示**该来源 IP** 占用的在途流程已达 oidcMaxFlowsPerIP。
//
// 与 errOIDCFlowTableFull 分开成两个哨兵的原因是可诊断性:表满 = 全平台在途流程
// 被灌满(需要运维介入/等待 TTL),单 IP 配额满 = 一个来源在建而不消费(通常是
// 脚本或攻击),两者的处置完全不同。对外都回 429(不泄露是哪一种)。
var errOIDCFlowQuotaPerIP = errors.New("oidc: too many in-flight login flows from this client")

// oidcOutboundClient 是 OIDC discovery / token / JWKS 的**统一出站 client**
// (审计 2026-09-13 P1-4)。
//
// go-oidc / oauth2 默认走 http.DefaultClient:无 IP 复检、默认跟随重定向、
// 无超时。而 issuer 是管理员在认证配置里填的地址(保存路径此前零校验),
// 一旦填成内网/link-local 目标,discovery(保存时触发)与 callback 期的
// token/JWKS 请求都会打到那里 —— SSRF 纵深护栏(FIX-09)此前只装在"测试连接"
// 按钮上。这里通过 oidc.ClientContext 注入带连接期 IP 复检的 client:
//   - 私网照旧放行(企业自建 IdP 常在 10.x/172.16.x,产品主场景);
//   - 链路本地 / 云 metadata(含 DNS rebinding)被拦;
//   - 重定向逐跳复检,至多 5 跳。
var oidcOutboundClient = &http.Client{
	Timeout:   20 * time.Second,
	Transport: util.SafeOutboundTransport(),
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("oidc: too many redirects")
		}
		return util.CheckOutboundTarget(req.Context(), req.URL.Hostname())
	},
}

// oidcExchangeTimeout bounds the IdP code exchange (C-14); a hung IdP token
// endpoint must not hold the callback goroutine forever. Test-injectable.
var oidcExchangeTimeout = 10 * time.Second

// OIDCProvider implements the authorization code + PKCE flow.
// Config keys: issuer, client_id, client_secret, redirect_url.
// name 用于区分两套独立 IdP 配置("oidc" / "openid"),决定路由前缀。
type OIDCProvider struct {
	cfg      oauth2.Config
	verifier *oidc.IDTokenVerifier
	mu       sync.Mutex
	flows    map[string]*oidcFlow
	name     string
}

func (p *OIDCProvider) Name() string {
	if p.name != "" {
		return p.name
	}
	return "oidc"
}

func (p *OIDCProvider) Configure(cfg map[string]string) error {
	issuer := cfg["issuer"]
	clientID := cfg["client_id"]
	redirect := cfg["redirect_url"]
	if issuer == "" || clientID == "" || redirect == "" {
		return errors.New("oidc: issuer, client_id and redirect_url are required")
	}
	// discovery 必须限时:不可达/挂起的 IdP 不得阻塞服务启动(审计2026-M4);
	// 失败视为 OIDC 未配置(降级,不阻断启动)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	// P1-4:discovery 走受护栏的 client(而不是 http.DefaultClient)。
	ctx = oidc.ClientContext(ctx, oidcOutboundClient)
	provider, err := oidc.NewProvider(ctx, issuer)
	if err != nil {
		return err
	}
	p.cfg = oauth2.Config{
		ClientID:     clientID,
		ClientSecret: decryptSettingSecret(cfg["client_secret"]),
		RedirectURL:  redirect,
		Endpoint:     provider.Endpoint(),
		Scopes:       []string{oidc.ScopeOpenID, "profile", "email"},
	}
	p.verifier = provider.Verifier(&oidc.Config{ClientID: clientID})
	p.flows = map[string]*oidcFlow{}
	return nil
}

// AuthURL starts a flow for the given state and returns the authorization
// URL carrying state, PKCE S256 challenge and nonce. `returnServer` (from the
// login page's `?server=` param) is bound to the flow so the callback deep
// link can carry it back to the initiating desktop client. `clientIP` 是发起
// 流程的来源 IP,用于 oidcMaxFlowsPerIP 的**在途流程配额**(空串按"未知来源"
// 计入同一配额,不跳过)。
func (p *OIDCProvider) AuthURL(state, returnServer, clientIP string) (string, error) {
	if state == "" {
		return "", errors.New("oidc: empty state")
	}
	nonce, err := randomHex(16)
	if err != nil {
		return "", err
	}
	verifier := oauth2.GenerateVerifier()
	p.mu.Lock()
	p.sweepFlowsLocked(time.Now())
	if len(p.flows) >= oidcMaxFlows {
		// 满了就明确拒绝:驱逐在途流程会把真人登录挤掉(P2-4)。回调期
		// 无需再判空(表只会被消费/过期清理,不会无限增长)。
		p.mu.Unlock()
		return "", errOIDCFlowTableFull
	}
	// 单 IP 配额(审计 2026-09-23 R5-A-18):判定与占位在同一临界区内,
	// 因此并发灌表也无法穿透(名额本身就是被消耗的资源)。
	// 空 clientIP 归到同一个"未知来源"桶 —— 调用方忘了解析 IP 时**不会**静默
	// 跳过配额(fail-closed),而是所有这类调用共享一份配额。
	if p.flowsForIPLocked(clientIP) >= oidcMaxFlowsPerIP {
		p.mu.Unlock()
		return "", errOIDCFlowQuotaPerIP
	}
	p.flows[state] = &oidcFlow{verifier: verifier, nonce: nonce, createdAt: time.Now(), returnServer: returnServer, ip: clientIP}
	p.mu.Unlock()
	return p.cfg.AuthCodeURL(state,
		oauth2.S256ChallengeOption(verifier),
		oidc.Nonce(nonce)), nil
}

// flowsForIPLocked 统计某来源 IP 当前占用的在途流程数;caller holds p.mu。
//
// 复杂度 O(len(p.flows)) ≤ oidcMaxFlows(1000):只在流程启动时跑一次,
// 每次最多一千次 map 迭代(微秒级),不值得为它再维护一份按 IP 的计数表
// (那份表还要在消费/过期/驱逐三条路径上同步,多一份状态就多一处不一致)。
func (p *OIDCProvider) flowsForIPLocked(ip string) int {
	n := 0
	for _, f := range p.flows {
		if f.ip == ip {
			n++
		}
	}
	return n
}

// sweepFlowsLocked removes expired flows; caller holds p.mu.
func (p *OIDCProvider) sweepFlowsLocked(now time.Time) {
	cutoff := now.Add(-oidcFlowTTL)
	for s, f := range p.flows {
		if f.createdAt.Before(cutoff) {
			delete(p.flows, s)
		}
	}
}

// HandleCallback exchanges the code (validating PKCE, state and nonce) and
// returns the identity from the ID token. Each state is single-use.
func (p *OIDCProvider) HandleCallback(code, state string) (UserInfo, error) {
	p.mu.Lock()
	flow, ok := p.flows[state]
	delete(p.flows, state)
	p.mu.Unlock()
	if !ok || code == "" {
		return UserInfo{}, errOIDCState
	}
	ctx, cancel := context.WithTimeout(context.Background(), oidcExchangeTimeout)
	defer cancel()
	// P1-4:token 交换与 JWKS 拉取同样走受护栏的 client。
	ctx = oidc.ClientContext(ctx, oidcOutboundClient)
	tok, err := p.cfg.Exchange(ctx, code, oauth2.VerifierOption(flow.verifier))
	if err != nil {
		return UserInfo{}, err
	}
	raw, ok := tok.Extra("id_token").(string)
	if !ok {
		return UserInfo{}, errors.New("oidc: no id_token in token response")
	}
	idt, err := p.verifier.Verify(ctx, raw)
	if err != nil {
		return UserInfo{}, err
	}
	var claims struct {
		Sub               string    `json:"sub"`
		PreferredUsername string    `json:"preferred_username"`
		Email             string    `json:"email"`
		Name              string    `json:"name"`
		Nonce             string    `json:"nonce"`
		Groups            *[]string `json:"groups"` // 指针:区分"未下发"与"空数组"(P2-9)
	}
	if err := idt.Claims(&claims); err != nil {
		return UserInfo{}, err
	}
	if subtle.ConstantTimeCompare([]byte(flow.nonce), []byte(claims.Nonce)) != 1 {
		return UserInfo{}, errors.New("oidc: nonce mismatch")
	}
	username := claims.PreferredUsername
	if username == "" {
		username = claims.Email
	}
	if username == "" {
		username = claims.Sub
	}
	groups := []string{}
	groupsPresent := claims.Groups != nil
	if groupsPresent {
		groups = *claims.Groups
	}
	return UserInfo{
		Username:      username,
		DisplayName:   claims.Name,
		Email:         claims.Email,
		Groups:        groups,
		GroupsPresent: groupsPresent,
		// P2-9:OIDC 的稳定主体标识是 sub(用户名/邮箱都可能被改),外部身份
		// 绑定到 sub,避免同名接管。
		ExternalID:     claims.Sub,
		Source:         "external",
		ExternalSource: p.Name(),
	}, nil
}

// oidcStateCookieName binds the OIDC login flow to the initiating browser:
// the state is written into a SameSite=Lax cookie at /oidc/login and must be
// echoed by the /oidc/callback request (login CSRF 防护:第三方页面不能在受害者
// 浏览器里发起登录流程并把自己的身份塞给受害者)。
const oidcStateCookieName = "picoaide_oidc_state"

// handleOIDCLoginWith runs the login flow for a specific browser provider.
// `?server=<url>` records the initiating client's server address, carried in
// the callback deep link so the desktop client knows which server to attach.
func (a *API) handleOIDCLoginWith(p BrowserProvider) gin.HandlerFunc {
	return func(c *gin.Context) {
		// P2-4:未认证的 /auth/{oidc,openid}/login 是**流程表**的放大器(每次调用
		// 写入一条 state,表满即 fail-closed ⇒ 全组织的 SSO 都起不了新流程),
		// 必须限流。
		// 口径更正:discovery **不在**本路径上(它在 Configure/保存认证配置时做一次
		// 并缓存),所以每次调用的成本是"一次内存写入 + 一次 302",真正被消耗的资源
		// 是流程表名额 —— 这也是防滥用落在 oidcMaxFlowsPerIP(配额)而不是"按速率卡
		// 成功"的原因。
		//
		// 2026-09-23 R5-A-18:本桶**只对失败计数**。
		//   判定 = blocked(只读快照);记账 = 每个**真实失败**出口各 record 一次;
		//   成功既不记账也**不** reset(见下)。
		// 修前的语义是"与登录 IP 桶共用实例 + allow 每次被接受都记账",于是每一次
		// **成功**的 SSO 登录都吃掉一格,而该键全仓零处 reset ⇒ 每个出口 IP 的
		// SSO 登录被永久压到 60 次/5 分钟(纯合法流量即触发,无 env 旋钮)。
		//
		// 2026-09-23 R6-A-4(本轮):**平台自身容量**导致的拒绝(在途流程表满 /
		// 单 IP 在途配额满)也不计入失败预算 —— 它们走 recordFlowCapacityRejection
		// 的独立计数与独立审计动作。把"被自己的配额拒绝"算成"失败",会让一个 NAT
		// 出口在登录潮里自我强化成 5 分钟全组织 SSO 封锁(见该闭包的注释)。
		//
		// 键在这里**只构造一次**,判定与所有记账点复用同一个字符串 ——
		// 本仓有过"判定键 ≠ 记账键 ⇒ 桶永远判不满、限流静默失效"的教训
		// (loginIPBudgetKey 的注释),所以不留第二个构造点。
		flowKey := oidcFlowBudgetKey(c)
		if a.oidcFlowLimiter.blocked(flowKey) {
			_ = serverstore.AuditLog(a.DB, "oidc-login", "login_fail", "rate_limited ip="+c.ClientIP())
			writeError(c, http.StatusTooManyRequests, "RATE_LIMITED", "登录请求过于频繁,请稍后再试")
			return
		}
		// recordFlowFailure 必须在**每一个真实失败出口**各调一次。下面共 4 个记账点,
		// 覆盖 5 条失败出口:状态生成失败 / server 参数格式错 / scheme 不合法 /
		// 来源不可信 / provider 的其它错误(协议/配置失败)。
		// 漏一处 = 该条失败路径不计预算
		// (判据见 audit_20260923_oidc_flow_bucket_test.go)。
		recordFlowFailure := func() { a.oidcFlowLimiter.record(flowKey) }
		// recordFlowCapacityRejection 记录一次**因平台自身容量**被拒的流程启动
		// (在途流程表满 / 单来源 IP 在途配额满),走的是与失败预算**不同的通道**。
		//
		// 2026-09-23 R6-A-4:这两条 429 此前与"凭证/协议错误"共用同一个失败预算,
		// 于是产生了自我强化 —— 一个 NAT 出口的在途流程凑到 oidcMaxFlowsPerIP(100,
		// 见 oidc.go 顶部的 TTL 说明:流程在 HandleCallback 之前占位最长 10 分钟)
		// 之后,第 101 人起的**每一个**合法登录尝试都既回 429、又吃掉一格失败预算;
		// 累计 60 次(oidcFlowStartMaxAttempts)就把整个出口 IP 的 SSO 再封 5 分钟。
		// 平台自己的容量闸门把受害者推向"疑似攻击者"的判定 —— 纯合法流量即可触发,
		// 且没有任何 env 旋钮。
		//
		// 现在的口径:
		//   · 失败预算只被**真实失败**(凭证/协议/配置错误)消耗;
		//   · 容量拒绝单独计数(API.OIDCFlowCapacityRejections,供运维/探针读),
		//     并写一条**动作可区分**的审计(oidc_flow_capacity,不是 login_fail);
		//   · HTTP 响应体刻意**不变**(仍是 429 RATE_LIMITED + 同一句文案):
		//     对外区分"表满"与"你的 IP 超额"会泄露平台容量状态,且 429 的语义
		//     ("稍后再试")对两种情形都成立。可区分性落在服务端日志与计数上,
		//     不落在客户端可见面。
		recordFlowCapacityRejection := func(reason string) {
			a.oidcFlowCapacity.Add(1)
			if a.DB != nil {
				_ = serverstore.AuditLog(a.DB, "oidc-login", "oidc_flow_capacity",
					"capacity_rejected reason="+reason+" ip="+c.ClientIP())
			}
		}
		state, err := randomHex(16)
		if err != nil {
			recordFlowFailure()
			writeError(c, http.StatusInternalServerError, "INTERNAL", "状态生成失败")
			return
		}
		returnServer := strings.TrimSpace(c.Query("server"))
		if returnServer != "" {
			// 校验:格式 + scheme(仅 https 或 http 回环,与客户端
			// assertServerURLAllowed 同规)+ **命中服务端配置声明的对外来源**。
			// 深链里带的是刚签发的真实 token,`?server=` 决定客户端把 token
			// 发去哪台服务端;只校验 scheme 等于让任意 https 域名(攻击者域名)
			// 把员工 token 领走(P0,2026-09-13 srvcore-1)。合法客户端传的就是
			// 用户正在访问的这台服务端(auth-gate 登录页),而"用户正在访问的
			// 是哪台"只有服务端配置能证明 —— 请求 Host 不行(见
			// returnServerIsTrusted,R7-F3-N3)。
			u, perr := url.Parse(returnServer)
			if perr != nil || u.Host == "" {
				recordFlowFailure()
				writeError(c, http.StatusBadRequest, "VALIDATION", "server 参数格式错误")
				return
			}
			loopback := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "[::1]"
			if u.Scheme != "https" && !(u.Scheme == "http" && loopback) {
				recordFlowFailure()
				writeError(c, http.StatusBadRequest, "VALIDATION", "server 必须为 https(或 http 回环)")
				return
			}
			if !returnServerIsTrusted(p, u) {
				recordFlowFailure()
				writeError(c, http.StatusBadRequest, "VALIDATION", "server 与本次登录的服务端不一致")
				return
			}
		}
		authURL, err := p.AuthURL(state, returnServer, c.ClientIP())
		if err != nil {
			// 顺序有意:先摘出**平台自身容量**的两条出口(它们不吃失败预算),
			// 剩下的才是真实失败。见上面 recordFlowCapacityRejection 的注释。
			if errors.Is(err, errOIDCFlowTableFull) {
				// 在途流程已满:明确 429(不驱逐真人在途流程)。
				recordFlowCapacityRejection("flow_table_full")
				writeError(c, http.StatusTooManyRequests, "RATE_LIMITED", "登录请求过于频繁,请稍后再试")
				return
			}
			if errors.Is(err, errOIDCFlowQuotaPerIP) {
				// 单 IP 在途流程配额满:同样是 429(对外不区分是哪一种)。
				// 这一条是"只对失败计数"之后**替代**旧"成功也记账"的防滥用面:
				// 建而不消费的灌表模式会在这里被挡住(见 oidcMaxFlowsPerIP)。
				// ⚠️ 它**不是**失败:合法用户在登录潮里也会撞到(配额与速率无关,
				// 只与"在途未回调"的条数有关),所以它不进失败预算 —— 否则
				// "被自己的配额拒绝"会把整个出口 IP 推向二次封锁(R6-A-4)。
				recordFlowCapacityRejection("per_ip_quota")
				writeError(c, http.StatusTooManyRequests, "RATE_LIMITED", "登录请求过于频繁,请稍后再试")
				return
			}
			// 真实失败(协议/配置/随机源等):吃失败预算。
			recordFlowFailure()
			writeError(c, http.StatusBadGateway, "UPSTREAM", "OIDC 服务不可用")
			return
		}
		// 成功出口:**不记账**(这正是本条修复)—— 合法登录不再消耗任何预算,
		// 因此"连续 N 次成功 SSO(N 远大于预算)"也不会 429。
		//
		// 为什么成功也**不** reset(与登录桶的 loginSucceeded 不同):流程启动的
		// "成功"是**匿名可得**的 —— 任何人发一次不带参数、不带凭据的合法 GET 就
		// 成功。若在这里 reset,攻击者用"59 次失败 + 1 次成功"交替即可把失败预算
		// 永远洗掉,限流等于不存在。登录桶可以 reset,是因为那里的成功需要**通过
		// 鉴权**,攻击者拿不到。失败预算的清账只由滑动窗口(5 分钟)自然过期承担。
		name := p.Name()
		http.SetCookie(c.Writer, &http.Cookie{
			Name:     oidcStateCookieName + "_" + name,
			Value:    state,
			Path:     "/api/client/v2/auth/" + name,
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
			Secure:   secureCookieFor(c, a.DB),
			MaxAge:   int(oidcFlowTTL.Seconds()),
		})
		c.Redirect(http.StatusFound, authURL)
	}
}

// handleOIDCCallbackWith runs the callback for a specific browser provider.
func (a *API) handleOIDCCallbackWith(p BrowserProvider) gin.HandlerFunc {
	return func(c *gin.Context) {
		code, state := c.Query("code"), c.Query("state")
		if code == "" || state == "" {
			writeError(c, http.StatusBadRequest, "VALIDATION", "缺少 code 或 state")
			return
		}
		name := p.Name()
		// login CSRF 绑定:回调必须回显 login 时签发的 state cookie
		stateCookie, err := c.Cookie(oidcStateCookieName + "_" + name)
		if err != nil || stateCookie == "" || subtle.ConstantTimeCompare([]byte(stateCookie), []byte(state)) != 1 {
			writeError(c, http.StatusBadRequest, "VALIDATION", "state 与登录浏览器不匹配")
			return
		}
		// 消费 cookie:流程单次有效
		// cookie-secure 修复(审计 2026-08-30 CodeQL go/cookie-secure-not-set):
		// 删除指令的 cookie 须声明与写入时一致的 Secure/SameSite/Path,
		// 否则非 HTTPS 部署下浏览器不发送删除指令, state 残留可被重放。
		http.SetCookie(c.Writer, &http.Cookie{
			Name:     oidcStateCookieName + "_" + name,
			Value:    "",
			Path:     "/api/client/v2/auth/" + name,
			MaxAge:   -1,
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
			Secure:   secureCookieFor(c, a.DB),
		})
		// v3b §2.6: OIDC 回调限流(按来源 IP; 防 IdP 妥协后暴力回调)。
		// 2026-09-08 P0-2:改用独立 IP 桶(不再占用全局 u:oidc-callback 登录桶,
		// 否则全组织 SSO 每 5 分钟只能登录 10 次)。
		// 2026-09-23 E-01:allow 判定即记账(成功回调由 oidcCallbackSucceeded 清空)
		// —— 旧"只对失败回调计数"由调用方 record,并发回调同样能穿透。
		if !a.oidcCallbackAllowed(c) {
			_ = serverstore.AuditLog(a.DB, "oidc-callback", "login_fail", "rate_limited ip="+c.ClientIP())
			return
		}
		// 先取出 returnServer(HandleCallback 会删除 state,state 单次使用)
		rs := returnServerOf(p, state)
		ui, err := p.HandleCallback(code, state)
		if errors.Is(err, errOIDCState) {
			writeError(c, http.StatusBadRequest, "VALIDATION", "state 无效或已过期")
			return
		}
		if err != nil {
			// v3b 审计: OIDC 失败留痕。
			_ = serverstore.AuditLog(a.DB, "oidc", "login_fail", "ip="+c.ClientIP())
			writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "OIDC 认证失败")
			return
		}
		a.oidcCallbackSucceeded(c)
		user, err := a.provisionUser(ui)
		if errors.Is(err, serverstore.ErrIdentityConflict) {
			writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "该用户名已绑定到其它身份源账号,请联系管理员")
			return
		}
		if err != nil {
			writeError(c, http.StatusInternalServerError, "INTERNAL", "用户创建失败")
			return
		}
		if user.Status != 1 {
			writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "账号已禁用")
			return
		}
		// v3b: 审计账号禁止使用客户端——SSO 回调同样拒绝签发员工 token。
		if user.Role == serverstore.RoleAuditor {
			writeError(c, http.StatusUnauthorized, "AUDITOR_NOT_ALLOWED", "审计账号不可登录客户端,请使用管理后台")
			return
		}
		token, err := IssueToken(a.DB, user.ID)
		if err != nil {
			writeError(c, http.StatusInternalServerError, "INTERNAL", "令牌签发失败")
			return
		}
		// v3b 审计: OIDC 成功留痕。
		_ = serverstore.AuditLog(a.DB, user.Username, "login_success", "oidc ip="+c.ClientIP())
		// 桌面客户端深链:携带 token + 发起 server + username(客户端拿到
		// 后直接构造 session,无需再调 /api/auth/me)。server 为 login 时
		// 记录的 returnServer;为空时客户端用其登录页输入的 server 兜底。
		// scheme 跟随渠道(见 channel.DeepLinkScheme):渠道构建用它自己的 scheme,
		// 浏览器跳回客户端时的确认框里不出现厂商名。三处必须一致 —— 客户端
		// protocols(打包)、客户端解析、以及这里。
		ret := fmt.Sprintf("%s://auth?token=%s", channel.DeepLinkScheme(), url.QueryEscape(token))
		if rs != "" {
			ret += fmt.Sprintf("&server=%s", url.QueryEscape(rs))
		}
		if ui.Username != "" {
			ret += fmt.Sprintf("&user=%s", url.QueryEscape(ui.Username))
		}
		c.Redirect(http.StatusFound, ret)
	}
}

// returnServerOf 从具体 provider 类型读取该 state 绑定的 returnServer;
// 非 OIDCProvider 实现(测试桩)返回空串。
func returnServerOf(p BrowserProvider, state string) string {
	if o, ok := p.(*OIDCProvider); ok {
		return o.ReturnServer(state)
	}
	return ""
}

// TrustedReturnServerHostsEnv 是运维显式声明的**补充**对外来源清单(逗号分隔;
// 每项可为 `https://host[:port]` 或裸 `host[:port]`,裸主机按 https 解释)。
//
// 用途:多 vhost / 内外双域名部署 —— 客户端登录页填的地址既不是某次请求的 Host
// 依据,又不该占用 PICOAI_PUBLIC_BASE_URL(后者是客户端下载地址的唯一权威来源,
// 改它会影响下发)。请求方改不了这个环境变量,故它可以作为来源证明。
//
// 注意区分:这是 **OIDC 深链回跳地址** 的允许清单,与 `PICOAI_TRUSTED_PROXIES`
// (反代 IP,用于登录限流取真实客户端 IP)不是一回事;它也不是 HTTP Host 头的
// 允许清单 —— Host 头根本不参与来源判定(见 returnServerIsTrusted)。
const TrustedReturnServerHostsEnv = "PICOAI_TRUSTED_HOSTS"

// returnServerIsTrusted 判定 `?server=` 是否指向**服务端配置**声明的本服务对外
// 来源(scheme + host,默认端口/大小写/尾斜杠/子路径归一后比对)。
//
// 可信来源只有三类,都是请求方改不了的服务端配置:
//  1. OIDC `redirect_url` 的 origin —— IdP 把浏览器重定向回来的地址,SSO 能走通
//     就说明它是本服务的浏览器可达来源;
//  2. `PICOAI_PUBLIC_BASE_URL`(客户端下载地址的唯一权威,见 clientrelease);
//  3. `PICOAI_TRUSTED_HOSTS`(上面的显式补充清单)。
//
// R7-F3-N3(复核 2026-09-13):这里**刻意不看请求 Host**。Host 是请求头,不是
// 来源证明 —— 任何能决定"浏览器用哪个 Host 到达本服务端"的入口(自有 vhost 的
// 反代 `proxy_set_header Host $host`、共享 ingress、AI 网关、DNS 重绑定)都能同时
// 把 `?server=` 设成同一个域名,于是第一轮那句"攻击者无法把任意域名塞进来"对
// Host 侧并不成立:真实员工 token 仍会随深链交给攻击者域名。修法选择复核报告的
// 方案②("Host 必须命中服务端配置的允许清单")的更强形式:Host 完全不参与判定,
// 只用配置;未配置任何来源时 `?server=` 一律拒(不落回 Host 推断)。
func returnServerIsTrusted(p BrowserProvider, u *url.URL) bool {
	for _, origin := range returnServerTrustedOrigins(p) {
		if strings.EqualFold(u.Scheme, origin.Scheme) && hostPortKey(u) == hostPortKey(origin) {
			return true
		}
	}
	return false
}

// returnServerTrustedOrigins 汇总上面三类服务端配置来源(去重不做:数量个位数,
// 重复比对无副作用)。
func returnServerTrustedOrigins(p BrowserProvider) []*url.URL {
	var out []*url.URL
	add := func(raw string) {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			return
		}
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" || u.Scheme == "" {
			return
		}
		out = append(out, &url.URL{Scheme: u.Scheme, Host: u.Host})
	}
	if o, ok := p.(*OIDCProvider); ok {
		add(o.cfg.RedirectURL)
	}
	add(os.Getenv(clientrelease.PublicBaseURLEnv))
	for _, entry := range strings.Split(os.Getenv(TrustedReturnServerHostsEnv), ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		if !strings.Contains(entry, "://") {
			entry = "https://" + entry
		}
		add(entry)
	}
	return out
}

// hostPortKey 归一 authority:小写、去尾点、去默认端口(https:443 / http:80),
// IPv6 统一走 net.JoinHostPort(带方括号),使 `[::1]:8443` 与 `[::1]:8443`
// 这类书写差异不会造成误判。
func hostPortKey(u *url.URL) string {
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	port := u.Port()
	if (u.Scheme == "https" && port == "443") || (u.Scheme == "http" && port == "80") {
		port = ""
	}
	if port == "" {
		return host
	}
	return net.JoinHostPort(host, port)
}

// ReturnServer 返回该 state 绑定的发起方服务端地址(login 时 ?server= 记录)。
func (p *OIDCProvider) ReturnServer(state string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	f := p.flows[state]
	if f == nil {
		return ""
	}
	return f.returnServer
}

func randomHex(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
