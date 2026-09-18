// Package aichat 实现 §5.1 的 `ai.chat` 能力（§4.7 / §4.4 / §7.3 / R36）。
//
// # 身份注入，不是令牌传递（§D3.1）
//
// WASM guest 读不到 Cookie、读不到文件、不能发网络 —— 结构上不可能自己拿到
// 凭据。所以应用**完全不需要知道凭据存在**：宿主为「(会话, 用户)」铸造一张
// 短时效用户令牌，进程内存持有、不落盘、不进浏览器，然后用它去调平台既有的
// `/v1/chat/completions`（BearerAuth 路径）。费用记在**使用者**账上，
// 平台不引入应用级额度、不做应用维度归因（R36）。
//
// # 令牌方案的取舍（本模块最需要判断力的一处）
//
// 备选：①每次续期**重铸**（CreateToken 写新行，回收旧行）；②**复用**一张长效
// 令牌、把"短时效"只做在内存里。
//
// 选 ①（重铸），理由：
//   - 「短时效 45 min」必须是**网关侧的真实约束**。复用方案里 DB 行的
//     expires_at 必须远长于 45 min（否则第 46 分钟起网关就拒），此时"短时效"
//     只剩内存里一个自定的 deadline —— 它拦不住任何东西，只是缓存失效策略；
//     一旦进程被 dump/被调试器读到，或 45 min 内被误用，DB 行还长期有效。
//   - 重铸的唯一代价是**行累积**，而它可以用"延迟回收"消除（见下）。
//
// 行累积怎么处理（旧行回收）：
//   - 续期发生在**到期前 limits.AITokenRenewBefore**（5 min），此刻旧行仍然有效；
//     如果立刻删掉旧行，正在飞行中的请求会拿着刚被删掉的令牌撞 401。
//   - 所以本实现把旧行记进内存，**等它自然过期之后**再删（过期行在网关侧
//     本来就会被 VerifyToken 拒掉，删它不可能影响任何在飞请求）。每个会话
//     因此最多同时存在 2 行（当前 + 上一张），下一次续期时上一张已过期 → 删掉。
//   - 登出/禁用走 RevokeSession/RevokeUser：**立即**删行 + 丢内存条目。
//     登出后旧令牌立即失效是正确行为（在飞请求失败正是"已登出"的语义）。
//   - 进程重启后，内存里没有任何明文令牌（不落盘 ⇒ 重启即失忆），旧行只会在
//     DB 里空转到 45 min 到期；这是"不加列、不落盘"的必然代价，已在交付说明认账。
//
// 三条硬约束都由①满足：45 min 是**网关看得到的** expires_at；登出即吊销靠删行；
// 不落盘靠"明文只在内存"（DB 只存 SHA-256，与平台既有令牌完全一致）。
package aichat

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/picoaide/picoaide/internal/llmgateway"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 内部常量（非"上限"，故不属 limits；单一来源仍在本文件）。
const (
	// rawTokenBytes 是令牌明文的熵（32 字节 crypto/rand，hex 编码 = 64 字符）。
	rawTokenBytes = 32
	// defaultModelSetting 是平台默认模型设置键（与 bootstrap/llmgateway 同源）。
	defaultModelSetting = "gateway.default_model"
	// dialTimeout / idleConnTimeout 是连接层预算（请求总预算由 ctx 控制）。
	dialTimeout     = 5 * time.Second
	idleConnTimeout = 90 * time.Second
)

// Options 是 aichat.Client 的装配参数。
type Options struct {
	// BaseURL 是**服务端自己的**地址（如 http://127.0.0.1:8080）：宿主用它
	// 直调本地 /v1。可以带也可以不带尾部 `/v1`，两种写法都接受。
	BaseURL string
	// DB 是平台主库（api_tokens 所在）；nil = 未配置，Chat 返回 INTERNAL。
	DB *sql.DB
	// TokenTTL 是令牌有效期，零值取 limits.AITokenTTL（45 min）。
	TokenTTL time.Duration
	// AllowPlaintextRemote 允许把用户令牌用**明文 http** 发往非回环地址。
	//
	// 默认 false = 拒绝：Bearer 令牌在明文信道上等于把员工凭据交给路径上的
	// 任何人。回环地址（127.0.0.1/::1/localhost）与 https 一律放行。
	// 只有"服务端与网关在同一个可信托管网络里、且没有 https"这种部署
	// 形态才需要打开它。
	AllowPlaintextRemote bool
}

// tokenMinter / tokenDropper 是平台令牌表的两个操作。
//
// minter 的生产实现就是 serverstore.CreateToken（§4.7 明确复用，不改表结构、
// 不加列）。它们被放在一个可注入结构里**只为测试**：让不依赖 PostgreSQL 的
// 用例也能跑完整 Chat 路径（含 HTTP 与错误映射），真实实现另有 PG 用例覆盖。
type tokenMinter func(db *sql.DB, userID int64, raw string, expiresAt time.Time) (int64, error)
type tokenDropper func(db *sql.DB, tokenID int64) error

// deps 是宿主依赖的注入点（生产实现都是本文件的默认值）。
type deps struct {
	minter       tokenMinter
	dropper      tokenDropper
	defaultModel func(db *sql.DB) (string, error)
	budget       time.Duration
	now          func() time.Time
}

// Client 实现 capapi.AI。
//
// 并发安全：令牌缓存有锁；HTTP 客户端共享连接池。
type Client struct {
	baseURL string
	db      *sql.DB
	ttl     time.Duration
	// renewBefore 是续期提前量（到期前多久重铸）。
	renewBefore time.Duration
	// cfgErr 非 nil 表示装配参数非法：不在 New 里 panic（构造函数签名固定），
	// 而是在每次 Chat 上 fail-closed 返回 INTERNAL。
	cfgErr *apperr.Error
	http   *http.Client

	d deps

	mu     sync.Mutex
	tokens map[tokenKey]*sessionToken
	// revokeFailures 统计"删行失败"次数（§4.9：吊销是 fire-and-forget + 失败计数）。
	revokeFailures atomic.Int64
}

// tokenKey 是缓存键：**(用户, 会话)**。
//
// 会话来自 ctx（见 WithSessionKey）：应用子域会话是"谁在哪个浏览器里用"
// 的最小单位，登出就按它批量吊销（§10.4 第 46 项）。
type tokenKey struct {
	userID  int64
	session string
}

// sessionToken 是一张在手令牌的明文与账目。
type sessionToken struct {
	raw       string
	id        int64
	expiresAt time.Time
	// stale 是历史行：**已经不需要再使用、但仍可能在有效期内**的旧令牌行。
	// 只有等它自己过期后才会被删除（见包注释"行累积怎么处理"）。
	stale []staleToken
}

type staleToken struct {
	id        int64
	expiresAt time.Time
}

// New 构造客户端（装配错误延迟到第一次 Chat 暴露，见 cfgErr）。
func New(opt Options) *Client {
	ttl := opt.TokenTTL
	if ttl <= 0 {
		ttl = limits.AITokenTTL
	}
	c := &Client{
		baseURL:     normalizeBaseURL(opt.BaseURL),
		db:          opt.DB,
		ttl:         ttl,
		renewBefore: limits.AITokenRenewBefore,
		tokens:      map[tokenKey]*sessionToken{},
		d: deps{
			defaultModel: lookupDefaultModel,
			budget:       limits.HostAIChatBudget,
			now:          time.Now,
		},
	}
	// 令牌表的两个操作只在真的配了主库时才注入：没配 = 能力不可用，
	// Chat 会 fail-closed 返回 INTERNAL（而不是拿 nil db 去撞 panic）。
	if opt.DB != nil {
		c.d.minter = serverstore.CreateToken
		c.d.dropper = deleteTokenRow
	}
	if e := validateBaseURL(c.baseURL, opt.AllowPlaintextRemote); e != nil {
		c.cfgErr = e
	}
	// 直连本地：**不走出站代理**（企业环境常设 HTTP(S)_PROXY，一旦让它
	// 生效，本地调用会被送去代理并且带上用户令牌）；也**不经** util 的
	// netguard 出站白名单 —— §4.4/D3.1 明确 ai.chat 直调本地 /v1。
	tr := &http.Transport{
		Proxy: nil,
		DialContext: (&net.Dialer{
			Timeout:   dialTimeout,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		MaxIdleConns:        limits.GlobalInstances,
		MaxIdleConnsPerHost: limits.GlobalInstances,
		IdleConnTimeout:     idleConnTimeout,
		ForceAttemptHTTP2:   true,
	}
	// 不用 http.Client.Timeout：预算由 ctx（limits.HostAIChatBudget）控制，
	// 两处各设一个会让错误归属（超预算 vs 被取消）无法区分。
	c.http = &http.Client{Transport: tr}
	return c
}

// ===== capapi.AI =====

// Chat 用**使用者身份**调用平台既有 /v1/chat/completions（R36）。
//
// 错误映射（§4.7 / §7.4）：
//   - 匿名 ⇒ AUTH_REQUIRED(401)；
//   - 余额不足 ⇒ AI_BALANCE_INSUFFICIENT(402)，**不暴露余额数值**；
//   - 平台既有用户级限流 ⇒ AI_RATE_LIMITED(429)，带 Retry-After；
//   - 超预算 ⇒ HOST_CALL_OVER_BUDGET(504)；被取消 ⇒ MODULE_KILLED(504)；
//   - 其余上游失败 ⇒ INTERNAL，**不透出上游原文**。
func (c *Client) Chat(ctx context.Context, user *abi.User, p abi.AIChatParams) (abi.AIChatResult, error) {
	var out abi.AIChatResult
	if c.cfgErr != nil {
		return out, c.cfgErr
	}
	if user == nil || user.ID <= 0 {
		// §10.4：匿名应用（access=public 且未登录）调身份相关能力一律拒。
		return out, apperr.New(apperr.CodeAuthRequired, "匿名请求不能调用 AI").
			WithHint("应用若允许匿名，请引导用户登录后再使用 AI 功能")
	}
	if c.d.minter == nil {
		return out, apperr.New(apperr.CodeInternal, "AI 能力未配置数据库").
			WithHint("宿主启动时必须把平台主库（api_tokens 所在）交给 aichat.New")
	}
	messages, e := validateChatParams(p)
	if e != nil {
		return out, e
	}
	model, e := c.resolveModel(p.Model)
	if e != nil {
		return out, e
	}
	payload, err := json.Marshal(upstreamChatRequest{
		Model:    model,
		Messages: messages,
		// stream=false：宿主函数是同步请求/应答，没有流式语义。
		Stream: false,
	})
	if err != nil {
		return out, apperr.New(apperr.CodeInternal, "AI 请求体构造失败").WithCause(err)
	}
	if len(payload) > limits.AIChatMaxBodyBytes {
		return out, apperr.New(apperr.CodeValidation, "AI 请求体超过上限").
			WithDetail("size", len(payload)).
			WithDetail("max", limits.AIChatMaxBodyBytes).
			WithHint("拆分请求：单次 ai.chat 的 messages 总量上限 1 MiB")
	}

	token, e := c.tokenFor(ctx, user.ID)
	if e != nil {
		return out, e
	}

	// 预算：ai.chat 单独 30 s（§4.4/§7.3），**不计入 guest 计时**。
	reqCtx, cancel := context.WithTimeout(ctx, c.d.budget)
	defer cancel()
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, c.endpoint(), strings.NewReader(string(payload)))
	if err != nil {
		return out, apperr.New(apperr.CodeInternal, "AI 请求构造失败").WithCause(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	// 身份注入：令牌由**宿主**铸造，应用拿不到也传不进（AIChatParams 无令牌字段，
	// 多余字段会被严格解析拒掉）。
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := c.http.Do(req)
	if err != nil {
		return out, c.transportError(ctx, reqCtx, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, limits.AppResponseBodyMaxBytes+1))
	if err != nil {
		return out, apperr.New(apperr.CodeInternal, "AI 上游响应读取失败").WithCause(err)
	}
	if int64(len(body)) > limits.AppResponseBodyMaxBytes {
		return out, apperr.New(apperr.CodeInternal, "AI 上游响应过大")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return out, mapUpstreamFailure(resp, body)
	}
	return parseChatResult(body, model)
}

// ===== 令牌 =====

// WithSessionKey 把应用子域会话标识绑进 ctx。
//
// 为什么用 ctx：`capapi.AI.Chat` 的签名只有 (ctx, user, params)，而令牌必须按
// 「(会话, 用户)」铸造与吊销（§4.7 / §10.4 第 46 项）。会话是**请求级事实**，
// 由 edge/runtime 在进入请求时绑定一次：
//
//	ctx = aichat.WithSessionKey(req.Context(), appSession.ID)
//
// 不绑定也能工作（同一用户共用一个令牌），但 RevokeSession 就无从定位 ——
// 生产路径必须绑定。
func WithSessionKey(ctx context.Context, sessionKey string) context.Context {
	if sessionKey == "" {
		return ctx
	}
	return context.WithValue(ctx, sessionKeyCtx{}, sessionKey)
}

// SessionKeyFrom 取出 ctx 里绑定的应用子域会话标识（未绑定返回空串）。
func SessionKeyFrom(ctx context.Context) string {
	v, _ := ctx.Value(sessionKeyCtx{}).(string)
	return v
}

type sessionKeyCtx struct{}

// tokenFor 返回 (会话, 用户) 当前可用的令牌明文，必要时铸造。
func (c *Client) tokenFor(ctx context.Context, userID int64) (string, *apperr.Error) {
	if err := ctx.Err(); err != nil {
		return "", apperr.New(apperr.CodeModuleKilled, "请求已取消").WithCause(err)
	}
	key := tokenKey{userID: userID, session: SessionKeyFrom(ctx)}
	now := c.d.now()

	c.mu.Lock()
	defer c.mu.Unlock()
	c.sweepLocked(now)
	if tok, ok := c.tokens[key]; ok && now.Before(tok.expiresAt.Add(-c.renewBefore)) {
		return tok.raw, nil
	}

	buf := make([]byte, rawTokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", apperr.New(apperr.CodeInternal, "令牌随机源不可用").WithCause(err)
	}
	raw := hex.EncodeToString(buf)
	expiresAt := now.Add(c.ttl)
	id, err := c.d.minter(c.db, userID, raw, expiresAt)
	if err != nil {
		return "", apperr.New(apperr.CodeInternal, "AI 令牌铸造失败").WithCause(err)
	}
	tok := &sessionToken{raw: raw, id: id, expiresAt: expiresAt}
	if prev, ok := c.tokens[key]; ok {
		// 旧行仍然有效（续期是在到期前做的）⇒ 记进 stale，等它过期再删，
		// 避免删掉在飞请求正在使用的那张令牌。
		if expired(now, prev.expiresAt) {
			c.dropLocked(prev.id)
		} else {
			tok.stale = append(tok.stale, staleToken{id: prev.id, expiresAt: prev.expiresAt})
		}
		tok.stale = append(tok.stale, prev.stale...)
	}
	c.tokens[key] = tok
	return raw, nil
}

// sweepLocked 回收"已经过期、不可能再被任何在飞请求使用"的行，并丢弃过期条目。
// 调用方必须持有 c.mu。
func (c *Client) sweepLocked(now time.Time) {
	for key, tok := range c.tokens {
		keep := tok.stale[:0]
		for _, st := range tok.stale {
			if expired(now, st.expiresAt) {
				c.dropLocked(st.id)
				continue
			}
			keep = append(keep, st)
		}
		tok.stale = keep
		if expired(now, tok.expiresAt) {
			// 条目自身已过期：明文不再可用（网关也拒），删行并忘记它。
			c.dropLocked(tok.id)
			delete(c.tokens, key)
		}
	}
}

// expired 是"这张令牌行已经不可能被任何在飞请求使用"的判据。
//
// 必须与 serverauth.VerifyToken 的判据**逐字一致**（`time.Now().After(tok.ExpiresAt)`
// ⇒ 恰好等于到期时刻仍算有效）。差一个等号就会在到期瞬间删掉一张还能用的行，
// 让那个在飞请求撞 401。
func expired(now, expiresAt time.Time) bool { return now.After(expiresAt) }

// dropLocked 删除一张令牌行；失败只计数不外抛（§4.9 fire-and-forget + 失败计数）。
func (c *Client) dropLocked(id int64) {
	// dropper 与主库同生共死（New 里一起注入）；这里只判 dropper，
	// 因为测试会用假表替换掉这一对依赖。
	if c.d.dropper == nil {
		return
	}
	if err := c.d.dropper(c.db, id); err != nil {
		c.revokeFailures.Add(1)
	}
}

// RevokeSession 立即吊销某个应用子域会话的全部在手令牌（登出调用，§10.4 第 46 项）。
//
// 语义：内存条目先丢，再删 DB 行 —— 即使删行失败，明文也只存在于本进程内存里，
// 丢掉条目后没有任何人能再用它；删行失败会被 RevokeFailures 计数。
//
// 边界：只能吊销**本进程铸造的**令牌。进程重启后内存失忆（明文本来就没落盘），
// 那些行会在 45 min 内自然到期（R36 明确不给 api_tokens 加列，故无法按会话查询它们）。
func (c *Client) RevokeSession(sessionKey string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for key, tok := range c.tokens {
		if key.session != sessionKey {
			continue
		}
		c.revokeEntryLocked(tok)
		delete(c.tokens, key)
	}
}

// RevokeUser 立即吊销某用户在本进程内的全部应用令牌（禁用/离职/管理员处置）。
func (c *Client) RevokeUser(userID int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for key, tok := range c.tokens {
		if key.userID != userID {
			continue
		}
		c.revokeEntryLocked(tok)
		delete(c.tokens, key)
	}
}

func (c *Client) revokeEntryLocked(tok *sessionToken) {
	c.dropLocked(tok.id)
	for _, st := range tok.stale {
		c.dropLocked(st.id)
	}
}

// RevokeFailures 返回"删行失败"累计次数（运维/审计观测用）。
func (c *Client) RevokeFailures() int64 { return c.revokeFailures.Load() }

// deleteTokenRow 删除一行令牌。
//
// 为什么是 DELETE 而不是 serverstore.RevokeTokenByID 的 `revoked=1`：
// 本模块要的是"行不累积"，置位 revoked 只是让行永久留在表里。DELETE 同样
// 让令牌立即失效（BearerAuth 查不到行即拒），且不触碰表结构（§4.7：不加列）。
// `?` 会被 serverstore 的 rewrite 层转成 PG 的 `$1`（全仓 SQL 统一写法）。
func deleteTokenRow(db *sql.DB, tokenID int64) error {
	_, err := db.Exec("DELETE FROM api_tokens WHERE id = ?", tokenID)
	return err
}

// ===== 默认模型（模型由服务端裁决，§4.7）=====

// lookupDefaultModel 解析平台默认模型：先看设置，再用"第一个可用模型"兜底
// （与 bootstrap 同口径；不复制第二份实现，直接复用 llmgateway 的模型目录）。
func lookupDefaultModel(db *sql.DB) (string, error) {
	if db == nil {
		return "", nil
	}
	models, err := llmgateway.ListModels(db)
	if err != nil {
		return "", err
	}
	if v, ok, err := serverstore.GetSetting(db, defaultModelSetting); err == nil && ok {
		if v = strings.TrimSpace(v); llmgateway.ModelEnabled(models, v) {
			return v, nil
		}
	} else if err != nil {
		return "", err
	}
	if len(models) > 0 {
		return models[0].ID, nil
	}
	return "", nil
}

func (c *Client) resolveModel(requested string) (string, *apperr.Error) {
	if m := strings.TrimSpace(requested); m != "" {
		return m, nil
	}
	model, err := c.d.defaultModel(c.db)
	if err != nil {
		return "", apperr.New(apperr.CodeInternal, "默认模型查询失败").WithCause(err)
	}
	if model == "" {
		return "", apperr.New(apperr.CodeValidation, "未指定 model，且平台没有可用的默认模型").
			WithDetail("field", "model").
			WithHint("要么在 ai.chat 里显式传 model，要么让管理员在管理后台配置默认模型")
	}
	return model, nil
}

// ===== 请求/响应 =====

// upstreamChatRequest 是发给 /v1/chat/completions 的最小体。
//
// **不注入系统提示**（§4.7「msgs 由应用自建，平台不注入系统提示」）：
// 这里就是应用给的 messages 原样，宿主不追加、不修改、不排序。
type upstreamChatRequest struct {
	Model    string            `json:"model"`
	Messages []abi.ChatMessage `json:"messages"`
	Stream   bool              `json:"stream"`
}

type upstreamChatResponse struct {
	Model   string `json:"model"`
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens     int64 `json:"prompt_tokens"`
		CompletionTokens int64 `json:"completion_tokens"`
		TotalTokens      int64 `json:"total_tokens"`
	} `json:"usage"`
	Error json.RawMessage `json:"error"`
}

// upstreamErrorEnvelope 只取错误码（平台上自己的错误信封形态：{"error":{"code":…}}）。
// **不读 message** —— 上游文案一律不透出（§4.7）。
type upstreamErrorEnvelope struct {
	Error struct {
		Code string `json:"code"`
	} `json:"error"`
}

// parseChatResult 解析上游 2xx 响应。
//
// 失败一律 INTERNAL 且不带上游原文：200 但没有 choices 属于上游协议异常，
// 不是"内容为空"（§7.4 硬断言精神：绝不把失败报成成功）。
func parseChatResult(body []byte, requestedModel string) (abi.AIChatResult, error) {
	var out abi.AIChatResult
	var parsed upstreamChatResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return out, apperr.New(apperr.CodeInternal, "AI 上游响应格式错误").WithCause(err)
	}
	if len(parsed.Choices) == 0 {
		return out, apperr.New(apperr.CodeInternal, "AI 上游响应缺少 choices").
			WithHint("上游返回了非预期结构；请在诊断页查看该应用的失败记录")
	}
	out.Content = parsed.Choices[0].Message.Content
	out.Model = parsed.Model
	if out.Model == "" {
		out.Model = requestedModel
	}
	if parsed.Usage != nil {
		out.Usage = &abi.AIUsageView{
			PromptTokens:     parsed.Usage.PromptTokens,
			CompletionTokens: parsed.Usage.CompletionTokens,
			TotalTokens:      parsed.Usage.TotalTokens,
		}
	}
	return out, nil
}

// mapUpstreamFailure 把网关的失败映射成平台错误码（§7.4）。
//
// 判据只用**状态码 + 平台自己的错误码**，不解析上游文本：
//   - 429 + BALANCE_EXHAUSTED ⇒ 余额（网关既有闸门与结算失败都是这个组合）；
//   - 402 ⇒ 余额（§7.4 表定义的 402 语义）；
//   - 其余 429 ⇒ 用户级限流（60 次/分 / 在途 32）。
//
// 4xx（如"模型不存在"）与 5xx 都归 INTERNAL：本模块不透出上游原文，
// 也不替应用解释平台内部状态；见交付说明里对这条口径的说明。
func mapUpstreamFailure(resp *http.Response, body []byte) *apperr.Error {
	var env upstreamErrorEnvelope
	_ = json.Unmarshal(body, &env)
	code := env.Error.Code

	switch {
	case resp.StatusCode == http.StatusPaymentRequired:
		return balanceError()
	case resp.StatusCode == http.StatusTooManyRequests && code == string(apperr.CodeBalanceExhaust):
		return balanceError()
	case resp.StatusCode == http.StatusTooManyRequests:
		e := apperr.New(apperr.CodeAIRateLimited, "AI 调用过于频繁").
			WithDetail("retry_after_seconds", retryAfterSeconds(resp))
		return e.WithHint("平台对每个使用者有速率上限（60 次/分）与在途上限；稍后重试即可")
	}
	// 其余一律 INTERNAL：**不带上游原文**，也不带上游状态码以外的内部细节。
	return apperr.New(apperr.CodeInternal, "AI 调用失败").
		WithDetail("upstream_status", resp.StatusCode).
		WithHint("这是平台侧的上游调用失败；请稍后重试，持续失败请查看该应用的诊断记录")
}

// balanceError 是余额不足的统一形态：**不暴露具体余额数值**（§10.3 第 38b 项）。
func balanceError() *apperr.Error {
	return apperr.New(apperr.CodeAIBalanceInsufficient, "AI 余额不足").
		WithHint("请在桌面客户端查看余额，或联系管理员充值").
		WithHint("应用侧不可能拿到余额数值：额度入口只在桌面客户端（R36）")
}

// retryAfterSeconds 读 Retry-After（只认秒数形态；HTTP-date 形态回落默认值）。
func retryAfterSeconds(resp *http.Response) int {
	raw := strings.TrimSpace(resp.Header.Get("Retry-After"))
	if raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			return n
		}
	}
	return limits.RetryAfterSeconds
}

// transportError 区分三种传输期失败：
//   - 调用方 ctx 已结束 ⇒ MODULE_KILLED（请求/模块被杀，不是 AI 慢）；
//   - 本函数自己的预算到点 ⇒ HOST_CALL_OVER_BUDGET（§7.4）；
//   - 其它 ⇒ INTERNAL。
func (c *Client) transportError(parent, budgeted context.Context, err error) *apperr.Error {
	if parent.Err() != nil {
		return apperr.New(apperr.CodeModuleKilled, "请求已取消，AI 调用中止").WithCause(parent.Err())
	}
	if budgeted.Err() == context.DeadlineExceeded {
		return apperr.New(apperr.CodeHostCallOverBudget, "AI 调用超过宿主预算").
			WithDetail("budget_ms", c.d.budget.Milliseconds()).
			WithHint("ai.chat 的宿主预算是 30 s；请缩小单次请求（减少 messages 或改用更快的模型）")
	}
	return apperr.New(apperr.CodeInternal, "AI 上游不可达").WithCause(err)
}

// ===== 参数与装配校验 =====

// validateChatParams 严格校验参数（消息条数、角色、整体体积）。
func validateChatParams(p abi.AIChatParams) ([]abi.ChatMessage, *apperr.Error) {
	if len(p.Messages) == 0 {
		return nil, apperr.New(apperr.CodeValidation, "ai.chat 的 messages 不能为空").
			WithDetail("field", "messages")
	}
	if len(p.Messages) > limits.AIChatMaxMessages {
		return nil, apperr.New(apperr.CodeValidation, "ai.chat 的 messages 条数超过上限").
			WithDetail("field", "messages").
			WithDetail("count", len(p.Messages)).
			WithDetail("max", limits.AIChatMaxMessages).
			WithHint("长上下文请先自行摘要，或拆成多次调用")
	}
	for i, m := range p.Messages {
		if strings.TrimSpace(m.Role) == "" {
			return nil, apperr.New(apperr.CodeValidation, "ai.chat 的 messages 缺少 role").
				WithDetail("field", "messages").
				WithDetail("index", i).
				WithHint("每条消息必须有 role（system/user/assistant）")
		}
	}
	return p.Messages, nil
}

func normalizeBaseURL(raw string) string {
	return strings.TrimRight(strings.TrimSpace(raw), "/")
}

// endpoint 拼出网关地址；BaseURL 带不带 `/v1` 都接受（少一种配置错法）。
func (c *Client) endpoint() string {
	if strings.HasSuffix(c.baseURL, "/v1") {
		return c.baseURL + "/chat/completions"
	}
	return c.baseURL + "/v1/chat/completions"
}

// validateBaseURL 校验装配参数并挡掉最危险的一种误配：
// 把用户 Bearer 令牌用**明文 http** 发往非回环地址（等于把员工凭据交给路径上的任何人）。
func validateBaseURL(baseURL string, allowPlaintextRemote bool) *apperr.Error {
	if baseURL == "" {
		return apperr.New(apperr.CodeInternal, "AI 网关地址未配置").
			WithHint("宿主启动时必须提供自身地址（如 http://127.0.0.1:8080）")
	}
	u, err := url.Parse(baseURL)
	if err != nil {
		return apperr.New(apperr.CodeInternal, "AI 网关地址非法").WithCause(err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return apperr.New(apperr.CodeInternal, "AI 网关地址必须是 http/https").
			WithDetail("scheme", u.Scheme)
	}
	if u.Host == "" {
		return apperr.New(apperr.CodeInternal, "AI 网关地址缺少主机名")
	}
	if u.Scheme == "http" && !allowPlaintextRemote && !isLoopbackHost(u.Hostname()) {
		return apperr.New(apperr.CodeInternal, "拒绝把用户令牌用明文 http 发往非回环地址").
			WithDetail("host", u.Hostname()).
			WithHint("把 AI 网关地址改成 https，或改成 127.0.0.1/localhost（服务端调自己）").
			WithHint("确需明文跨机调用时显式设置 Options.AllowPlaintextRemote（自担凭据泄露风险）")
	}
	return nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(strings.Trim(host, "[]"))
	return ip != nil && ip.IsLoopback()
}
