package appproof

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/edge"
)

// Options 是 Service 的装配项。
type Options struct {
	// DataRoot 是平台数据根（密钥与注册表都落在它下面）。必填。
	DataRoot string
	// TTL 是 proof 的有效期（0 ⇒ DefaultTTL = 15 min）。
	TTL time.Duration
	// ReplayCapacity 是 jti/nonce 表的有界容量（0 ⇒ DefaultReplayCapacity）。
	ReplayCapacity int
	// ClockSkew 是安装签名时间戳允许的偏移（0 ⇒ defaultClockSkew = 5 min）。
	ClockSkew time.Duration
	// Now 注入时钟（测试用；nil ⇒ time.Now）。
	Now func() time.Time
}

// defaultClockSkew 是安装签名时间戳的允许偏移。
//
// 5 min 的取舍：客户端与服务器的时钟漂移在真实环境里是常态（虚拟机、容器、
// 手改系统时间），窗口太小会把"时钟慢了两分钟"变成"应用打不开"；窗口太大的代价
// 只是 nonce 表的有效窗口变长（nonce 一次性，重放仍被去重挡住）。
const defaultClockSkew = 5 * time.Minute

// Service 是 app-proof 的服务端实现（唯一的对外入口）。
type Service struct {
	ring     *KeyRing
	installs *InstallRegistry
	nonces   *ReplayGuard
	jti      *ReplayGuard
	ttl      time.Duration
	skew     time.Duration
	now      func() time.Time
}

// New 装配 app-proof（读/建签名密钥环与安装注册表）。
//
// 任一环节失败都必须让**启动**失败（调用方 log.Fatalf）：没有签名密钥就无法签发
// proof ⇒ 客户端所有应用请求 401，而"为什么"只会在启动日志里。这是 §23.1
// 「启动期自检：私钥可读」的落点。
func New(opt Options) (*Service, error) {
	now := opt.Now
	if now == nil {
		now = time.Now
	}
	ring, err := LoadOrCreateKeyRing(opt.DataRoot, now)
	if err != nil {
		return nil, err
	}
	installs, err := LoadInstallRegistry(opt.DataRoot, now)
	if err != nil {
		return nil, err
	}
	ttl := opt.TTL
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	skew := opt.ClockSkew
	if skew <= 0 {
		skew = defaultClockSkew
	}
	cap := opt.ReplayCapacity
	if cap <= 0 {
		cap = DefaultReplayCapacity
	}
	return &Service{
		ring:     ring,
		installs: installs,
		nonces:   NewReplayGuard(cap, ttl, now),
		jti:      NewReplayGuard(cap, ttl, now),
		ttl:      ttl,
		skew:     skew,
		now:      now,
	}, nil
}

// TTL 返回 proof 有效期（诊断/响应体用）。
func (s *Service) TTL() time.Duration { return s.ttl }

// KID 返回当前签发密钥的标识（诊断用，不泄露密钥材料）。
func (s *Service) KID() string { return s.ring.KID() }

// InstallRequest 是签发请求的入参（客户端提交）。
type InstallRequest struct {
	InstallID string `json:"install_id"`
	PublicKey string `json:"public_key"`
	Nonce     string `json:"nonce"`
	TS        int64  `json:"ts"`
	Signature string `json:"signature"`
}

// IssueResult 是签发结果。
type IssueResult struct {
	Proof     string `json:"proof"`
	ExpiresAt int64  `json:"expires_at"`
}

// Issue 校验安装签名并签发一份 proof。
//
// 校验顺序（每一步都对应一个可单独判红的判据，见 appproof_test.go）：
//
//	① 形状：install_id / nonce / 公钥 / 签名（不合法 ⇒ ErrMalformed）
//	② 时间：ts 与服务器时间偏移 ≤ ClockSkew（⇒ ErrExpired，客户端要重取时间）
//	③ nonce 一次性（⇒ ErrReplayed）—— **必须在验签之前**消费：否则同一份签名可以
//	   先被拿去验一个错误公钥、再被重放，nonce 就失去"一次性"的意义
//	④ 验签（用提交的公钥；⇒ ErrMalformed）
//	⑤ 注册表：未注册则登记，已注册必须同值（⇒ ErrMismatch）
//	⑥ 用部署密钥签发，绑 (uid, bearer hash, install_id, serverURL, app_id, exp, jti)
//
// appID 来自**路由路径**（调用方保证），绝不从请求体/头里取；serverURL 来自
// **本次请求的实际来源**（`ServerURL`）—— 用它而不是配置项的理由是：
// 客户端认定的"服务端地址"就是它实际打的那个地址，配置里写什么它并不知道。
func (s *Service) Issue(r *http.Request, userID int64, bearerHash, appID string, req InstallRequest) (*IssueResult, error) {
	if userID <= 0 || strings.TrimSpace(bearerHash) == "" {
		return nil, fmt.Errorf("appproof: 签发需要已认证的员工身份")
	}
	installID := strings.TrimSpace(req.InstallID)
	nonce := strings.TrimSpace(req.Nonce)
	if !validInstallID(installID) || nonce == "" || len(nonce) > maxNonceBytes {
		return nil, ErrMalformed
	}
	if req.TS <= 0 || strings.TrimSpace(req.Signature) == "" {
		return nil, ErrMalformed
	}
	pub, err := decodePublicKey(req.PublicKey)
	if err != nil {
		return nil, ErrMalformed
	}
	sig, err := decodeInstallSignature(req.Signature)
	if err != nil {
		return nil, ErrMalformed
	}

	now := s.now().UTC()
	if drift := now.Sub(time.Unix(req.TS, 0).UTC()); drift > s.skew || drift < -s.skew {
		return nil, ErrExpired
	}
	serverURL := ServerURL(r)
	if serverURL == "" {
		return nil, fmt.Errorf("appproof: 无法确定服务端地址（签发请求缺少 Host）")
	}
	// nonce 一次性：键里带上 install_id，避免不同安装的同名 nonce 互相顶掉。
	if !s.nonces.Consume(installID + ":" + nonce) {
		return nil, ErrReplayed
	}
	if !ed25519.Verify(pub, InstallMessage(installID, nonce, req.TS, serverURL), sig) {
		return nil, ErrMalformed
	}
	pubB64 := base64.StdEncoding.EncodeToString(pub)
	if err := s.installs.Register(userID, installID, pubB64); err != nil {
		return nil, err
	}

	claims := Claims{
		V:   1,
		UID: userID,
		// BH 只存 bearer 的 SHA-256（hex）：proof 泄了也换不回 bearer，而校验只需要
		// 逐字节比对（bearer 明文永远不进 proof）。
		BH:  bearerHash,
		IID: installID,
		SRV: serverURL,
		App: strings.ToLower(strings.TrimSpace(appID)),
		Exp: formatTS(now.Add(s.ttl)),
	}
	jti, err := newJTI()
	if err != nil {
		return nil, err
	}
	claims.JTI = jti
	payload, err := json.Marshal(claims)
	if err != nil {
		return nil, err
	}
	return &IssueResult{
		Proof:     encodeToken(s.ring.KID(), payload, s.ring.Sign(payload)),
		ExpiresAt: claims.Exp,
	}, nil
}

// maxNonceBytes 是 nonce 的长度上限（客户端用 16..32 字节随机即可）。
const maxNonceBytes = 128

// Verify 校验一份 proof 是否可用于 (userID, bearerHash, appID) 这次请求。
//
// 判定顺序（契约 §20.1 的三个对外码必须"缺什么报什么"）：
//
//	结构/签名非法 ⇒ ErrMalformed（对外 proof_mismatch，reason 区分）
//	已过期         ⇒ ErrExpired（对外 proof_expired）
//	绑定不符       ⇒ ErrMismatch（对外 proof_mismatch）
func (s *Service) Verify(r *http.Request, token string, userID int64, bearerHash, appID string) (*Claims, error) {
	if strings.TrimSpace(token) == "" {
		return nil, ErrMalformed
	}
	c, err := s.verifyToken(strings.TrimSpace(token))
	if err != nil {
		return nil, err
	}
	if formatTS(s.now()) >= c.Exp {
		return nil, ErrExpired
	}
	if c.UID != userID {
		return nil, ErrMismatch
	}
	if c.BH != bearerHash {
		return nil, ErrMismatch
	}
	if c.IID == "" || !validInstallID(c.IID) {
		return nil, ErrMismatch
	}
	if c.SRV != ServerURL(r) {
		return nil, ErrMismatch
	}
	if c.App != strings.ToLower(strings.TrimSpace(appID)) {
		return nil, ErrMismatch
	}
	return c, nil
}

// ConsumeJTI 消费 proof 的 jti（**非幂等请求**才调用，契约 §23.1 的成本取舍）。
//
// 返回 false = 这张 proof 的这一 jti 已经被用过（重放）。
// 幂等请求（GET/HEAD/OPTIONS）不查：TLS 下重复投递的代价可接受，而每次读请求都
// 写一张全局表会把读路径变成写路径。
func (s *Service) ConsumeJTI(c *Claims) bool {
	if s == nil || c == nil || c.JTI == "" {
		return true
	}
	return s.jti.Consume(c.JTI)
}

// decodeInstallSignature 解析安装签名（Ed25519 detached，标准 base64；容忍无 padding）。
func decodeInstallSignature(raw string) ([]byte, error) {
	raw = strings.TrimSpace(raw)
	for _, enc := range []*base64.Encoding{
		base64.StdEncoding, base64.RawStdEncoding,
		base64.URLEncoding, base64.RawURLEncoding,
	} {
		if b, err := enc.DecodeString(raw); err == nil {
			if len(b) != ed25519.SignatureSize {
				return nil, fmt.Errorf("appproof: 安装签名长度 %d，want %d", len(b), ed25519.SignatureSize)
			}
			return b, nil
		}
	}
	return nil, fmt.Errorf("appproof: 安装签名不是合法 base64")
}

// ServerURL 返回本次请求的**规范服务端地址**（proof 的 serverURL 绑定值）。
//
// 形态：`scheme://host[:port]`，scheme 取 TLS ⇒ X-Forwarded-Proto（反代终止 TLS）⇒ http，
// 默认端口省略、主机小写 —— 与客户端实际打的那个地址逐字符一致（配置里写什么，
// 客户端并不知道，所以绑定值不能来自配置）。
//
// ⚠️ 归一化复用 `edge.NormalizeOrigin`（小写 / 去尾斜杠 / 默认端口省略 / 丢路径），
// 只有"scheme 从请求怎么判定"这一处是三行本地逻辑。**不要**把它换成任何
// "按主机名推导自身源"的东西：`edge.SelfOrigin` 与整套主机名门控已随 W4 删除
// （总纲 §8.4），本函数是唯一还需要的"服务端自身地址"实现，它只认请求本身携带的
// 事实（Host + TLS/XFP），不查任何配置、不猜任何域名。
//
// 空串 = 连 Host 都没有（异常请求），调用方按校验失败处理。
func ServerURL(r *http.Request) string {
	if r == nil {
		return ""
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	} else if p := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")); p != "" {
		// 只取第一个值（逗号分隔的链里第一个是客户端侧协议）。
		if i := strings.IndexByte(p, ','); i >= 0 {
			p = p[:i]
		}
		scheme = strings.ToLower(strings.TrimSpace(p))
	}
	return edge.NormalizeOrigin(scheme + "://" + r.Host)
}
