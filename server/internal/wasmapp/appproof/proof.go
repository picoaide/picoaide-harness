package appproof

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// tokenVersion 是 proof 的线格式版本（换格式必须改它，旧 token 会被判 ErrMalformed）。
const tokenVersion = "v1"

// InstallMessagePrefix 是**安装签名**待签消息的第一行。
//
// 待签消息 = 下面五段用 "\n" 连接（**末尾无换行**）：
//
//	appproof-install-v1
//	<install_id>
//	<nonce>
//	<ts（十进制 unix 秒）>
//	<serverURL（scheme://host[:port]，小写 scheme、无尾斜杠）>
//
// 客户端（L2）必须用**同一份**拼装（见 InstallMessage）；字段顺序与分隔符是线格式，
// 改动等于让所有在手客户端签不出有效证明。
const InstallMessagePrefix = "appproof-install-v1"

// InstallMessage 拼装安装签名的待签字节（客户端与服务端共用的唯一实现）。
func InstallMessage(installID, nonce string, ts int64, serverURL string) []byte {
	return []byte(strings.Join([]string{
		InstallMessagePrefix, installID, nonce, strconv.FormatInt(ts, 10), serverURL,
	}, "\n"))
}

// Claims 是 proof 里携带的绑定信息（契约 §23.1：绑 (user_id, bearer hash,
// install_id, serverURL, app_id, exp, jti)）。
//
// 为什么绑 **app_id**（R2S-2/N2）：不绑的话一张 proof 在 15 min 内可跨应用重放
// —— 应用之间是不同 origin、不同作者的信任域，"能打开 A"不该蕴含"能打开 B"。
type Claims struct {
	V   int    `json:"v"`
	UID int64  `json:"uid"`
	BH  string `json:"bh"`
	IID string `json:"iid"`
	SRV string `json:"srv"`
	App string `json:"app"`
	Exp int64  `json:"exp"`
	JTI string `json:"jti"`
}

// parseToken 拆开线格式 `v1.<kid>.<payload>.<sig>`。
func parseToken(token string) (kid string, payload, sig []byte, err error) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 4 || parts[0] != tokenVersion {
		return "", nil, nil, ErrMalformed
	}
	kid = parts[1]
	if kid == "" {
		return "", nil, nil, ErrMalformed
	}
	payload, err = base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || len(payload) == 0 {
		return "", nil, nil, ErrMalformed
	}
	sig, err = base64.RawURLEncoding.DecodeString(parts[3])
	if err != nil || len(sig) != ed25519.SignatureSize {
		return "", nil, nil, ErrMalformed
	}
	return kid, payload, sig, nil
}

// encodeToken 组装线格式 token。
func encodeToken(kid string, payload, sig []byte) string {
	return strings.Join([]string{
		tokenVersion, kid,
		base64.RawURLEncoding.EncodeToString(payload),
		base64.RawURLEncoding.EncodeToString(sig),
	}, ".")
}

// verifyToken 验签并解析 claims（**不**做时间与绑定判定 —— 那两件事的判据由调用方
// 按"缺什么报什么"的顺序分开做，见 Service.Verify）。
func (s *Service) verifyToken(token string) (*Claims, error) {
	kid, payload, sig, err := parseToken(token)
	if err != nil {
		return nil, err
	}
	if !s.ring.Verify(kid, payload, sig) {
		// kid 不在环里（老于保留窗口 / 伪造）或签名不符 —— 对外都是"这份证明不是
		// 本部署签发的"，因此与结构非法归一类。
		return nil, ErrMalformed
	}
	var c Claims
	if err := json.Unmarshal(payload, &c); err != nil || c.V != 1 {
		return nil, ErrMalformed
	}
	return &c, nil
}

// newJTI 生成一次性的 jti（16 字节随机，hex）。
func newJTI() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("appproof: 生成 jti: %w", err)
	}
	return hex.EncodeToString(buf), nil
}

// validInstallID 校验 install_id 的形状。
//
// 它是**客户端生成**的标识（不是安全边界，安全来自签名），因此形状只要够严到
// "能安全地当 map 键与文件键"即可：长度 8..64、URL-safe 字符集。
func validInstallID(id string) bool {
	if len(id) < 8 || len(id) > 64 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '-', c == '_', c == '.':
		default:
			return false
		}
	}
	return true
}

// decodePublicKey 解析客户端提交的安装公钥（Ed25519，32 字节，标准 base64）。
//
// 失败一律返回 `ErrKeyMalformed`（`ErrMalformed` 的子类）：公钥编码/长度问题必须在
// 对外 reason 上与"签名不符"分开 —— 否则对接方会被 `signature_invalid` 带去查签名
// 消息拼装，而病根其实是"公钥被 SPKI/DER 包了一层（44 字节）"。
func decodePublicKey(raw string) (ed25519.PublicKey, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, fmt.Errorf("%w: 缺少安装公钥", ErrKeyMalformed)
	}
	// 兼容标准与 URL-safe 两种 base64（客户端可能不带 padding）。
	for _, enc := range []*base64.Encoding{
		base64.StdEncoding, base64.RawStdEncoding,
		base64.URLEncoding, base64.RawURLEncoding,
	} {
		if b, err := enc.DecodeString(raw); err == nil {
			if len(b) != ed25519.PublicKeySize {
				return nil, fmt.Errorf("%w: 长度 %d，want %d（公钥是 raw Ed25519 32 字节，"+
					"不是 SPKI/DER 包装后的 44 字节，也不要 PEM）",
					ErrKeyMalformed, len(b), ed25519.PublicKeySize)
			}
			return ed25519.PublicKey(b), nil
		}
	}
	return nil, fmt.Errorf("%w: 不是合法 base64", ErrKeyMalformed)
}

// formatTS 把时刻写成 proof 里的 unix 秒（唯一格式）。
func formatTS(t time.Time) int64 { return t.UTC().Unix() }
