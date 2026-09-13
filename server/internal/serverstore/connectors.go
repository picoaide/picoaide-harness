package serverstore

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// Connector 是服务端连接器目录的一行(定义 JSON 与客户端 ConnectorDef 对齐)。
type Connector struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	AuthMode    string `json:"auth_mode"`
	Definition  string `json:"definition"`
	Enabled     bool   `json:"enabled"`
	UpdatedAt   string `json:"updated_at"`
	CreatedAt   string `json:"created_at"`
}

var (
// ErrValidation: 连接器参数不合法(名称/编号/模式/定义 JSON)。
// ErrNotFound: 连接器不存在。
// 均复用 errors.go 的包级错误(避免重复定义)。
)

// connectorIDRe: id 作为路径段/客户端键,限小写字母数字连字符。
var connectorIDRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)

// connectorAuthModes 是合法的认证模式(与客户端 ConnectorAuthMode 对齐)。
var connectorAuthModes = map[string]bool{
	"oauth": true, "device": true, "token": true, "server-side": true,
}

func validateConnector(c *Connector) error {
	if !connectorIDRe.MatchString(c.ID) {
		return ErrValidation
	}
	if strings.TrimSpace(c.Name) == "" {
		return ErrValidation
	}
	if !connectorAuthModes[c.AuthMode] {
		return ErrValidation
	}
	if strings.TrimSpace(c.Definition) == "" {
		return ErrValidation
	}
	var probe map[string]any
	if err := json.Unmarshal([]byte(c.Definition), &probe); err != nil {
		return ErrValidation
	}
	// 必填结构:mcp 非空数组;每项必须含 serverName。
	mcp, ok := probe["mcp"].([]any)
	if !ok || len(mcp) == 0 {
		return ErrValidation
	}
	if err := validateConnectorMCP(mcp); err != nil {
		return err
	}
	// tokenFields / settings 的 key 是**同一条注入通道**(客户端
	// buildStdioEnv 会把凭据里 key 命中已声明字段名的值直接写进子进程 env),
	// 必须与 mcp[].env 过同一套 denylist。2026-09-13:此前只校验 env,
	// 一份 {"tokenFields":[{"key":"NODE_OPTIONS"}]} 的定义即可在每台员工
	// 机器上向 MCP 子进程注入引导变量(与客户端 policy.ts 同源缺口)。
	return validateConnectorCredentialFields(probe)
}

// 客户端会拿定义 JSON 直接 spawn 子进程/发起出站请求,所以服务端也必须校验
// "决定行为的字段"(FIX-02:客户端不假设服务端可信)。两侧规则同源:
// 客户端 packages/host/connectors/src/policy.ts 与
// packages/host/connectors/src/outbound.ts。
var (
	// connectorServerNameRe: MCP serverName 是客户端工具命名空间的一部分
	// (mcp__<serverName>__<tool>),限小写字母数字连字符。
	connectorServerNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	// connectorDeniedEnvKeys: 进程引导/加载器钩子与代理键,连接器定义不得覆盖。
	connectorDeniedEnvKeys = map[string]bool{
		"PATH": true, "NODE_OPTIONS": true, "NODE_PATH": true,
		"LD_PRELOAD": true, "LD_LIBRARY_PATH": true, "LD_AUDIT": true,
		"PYTHONPATH": true, "PYTHONSTARTUP": true, "BASH_ENV": true,
		"ENV": true, "SHELL": true, "COMSPEC": true,
		"HTTP_PROXY": true, "HTTPS_PROXY": true, "ALL_PROXY": true, "NO_PROXY": true,
		"NODE_TLS_REJECT_UNAUTHORIZED": true, "NODE_EXTRA_CA_CERTS": true,
	}
	// connectorDeniedEnvPrefixes: 产品自有命名空间。
	connectorDeniedEnvPrefixes = []string{"DSH_", "ELECTRON_", "PICOAIDE_"}
	// connectorMetadataHosts: 按名字指向云元数据服务的常见主机名。
	connectorMetadataHosts = map[string]bool{
		"metadata": true, "metadata.google.internal": true, "metadata.goog": true,
		"instance-data": true, "instance-data.ec2.internal": true,
	}
)

// connectorEnvKeyAllowed: 与客户端 isDeniedEnvKey 同规则(Windows 环境变量名
// 大小写不敏感,故统一大写比较;两侧都先归一化,否则 " NODE_OPTIONS " 就是
// 一条绕过路径)。
//
// P2(审计 r5 §4):键名里出现 `=`(**含尾随**)一律拒绝。
// 根因:POSIX/libuv 写子进程环境是 `key=value`,子进程按**第一个** `=` 切名 ⇒
//
//	{"NODE_OPTIONS=": "--require /tmp/evil.js"}  →  子进程 NODE_OPTIONS="=--require …"
//
// 也就是"受保护变量确实被定义"(实测 HOME=/、PATH=、DSH_*=/ELECTRON_*= 同理),
// denylist 的语义("服务端下发的定义绝不能设置这些变量名")被击穿;Node 侧因为
// 值被加了 `=` 前缀而丢弃选项(实测未达成 RCE),但对非 Node 子进程/包装脚本
// 依然有效。'=' 不是合法的环境变量名字符,拒绝它零可用性损失。
func connectorEnvKeyAllowed(key string) bool {
	if strings.ContainsRune(key, '=') {
		return false
	}
	upper := strings.ToUpper(connectorEnvKeyNormalize(key))
	if upper == "" {
		return false
	}
	if connectorDeniedEnvKeys[upper] {
		return false
	}
	for _, prefix := range connectorDeniedEnvPrefixes {
		if strings.HasPrefix(upper, prefix) {
			return false
		}
	}
	return true
}

// connectorEnvKeyTrimCutset 是 **JS String.prototype.trim()** 会剥掉的空白集合
// (WhiteSpace + LineTerminator,逐码位):TAB/LF/VT/FF/CR/SP、NBSP(U+00A0)、
// Ogham 空格(U+1680)、U+2000..U+200A、行/段分隔符(U+2028/U+2029)、
// U+202F、U+205F、全角空格(U+3000)、BOM(U+FEFF)。
//
// P2(审计 r5 §4)残余分歧:Go 的 strings.TrimSpace 走 unicode.IsSpace,它**多**
// 认一个 U+0085(NEL)—— 客户端 trim 不剥 U+0085,服务端却把 "NODE_OPTIONS\u0085"
// 归一成受保护键判拒,出现"管理端保存失败、客户端其实放行"的分叉。现在改用
// JS 的集合(唯一实现):U+0085 两侧都不剥。安全性不受影响 ——
// `NODE_OPTIONS\u0085` 是一个**不同名字**的变量(POSIX 环境名除 NUL 与 '='
// 外任意字节),子进程不会把它读成 NODE_OPTIONS。
const connectorEnvKeyTrimCutset = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004" +
	"\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

// connectorEnvKeyNormalize 把环境键归一化到与客户端可比较的形态(2026-09-13
// N6,第三轮独立复核 §3.2):`\uFEFFNODE_OPTIONS` 曾被服务端放行、客户端拒收。
//
// 根因:Go 的 strings.TrimSpace 走 unicode.IsSpace,而 U+FEFF(BOM / 零宽不换行
// 空格)**不是** Unicode White_Space;JS 的 String.trim() 剥的是 WhiteSpace +
// LineTerminator,其中含 U+FEFF —— 客户端于是把 "\uFEFFNODE_OPTIONS" 归一成
// "NODE_OPTIONS" 判拒、目录解析直接丢弃该连接器(管理端保存成功、客户端静默
// 消失)。
//
// 归一化 = ①剥掉不可见格式字符(BOM / 零宽 / 双向控制,见
// connectorEnvKeyInvisible);②按 **JS 的空白集合** trim(见
// connectorEnvKeyTrimCutset)。两个方向都安全:用户看得见的键名不受影响,而任何
// "看起来等于受保护键"的隐形变形都会落到同一个比较值上。
func connectorEnvKeyNormalize(key string) string {
	// 热路径:绝大多数键不含不可见字符,少一次扫描/分配。
	if strings.ContainsFunc(key, connectorEnvKeyInvisible) {
		key = strings.Map(func(r rune) rune {
			if connectorEnvKeyInvisible(r) {
				return -1
			}
			return r
		}, key)
	}
	return strings.Trim(key, connectorEnvKeyTrimCutset)
}

// connectorEnvKeyInvisible 判定"不可见格式字符":这些码位本身不显示,插进
// 受保护键里可以做出视觉上完全相同、比较上不同的键名(copy-paste 攻击面),
// 所以归一化时整体剥掉。与客户端 normalizeEnvKey 的收紧目标集合一字不差:
// U+00AD 软连字符、U+180E 蒙古文元音分隔符、U+200B..U+200F(ZWS*/LRM/RLM)、
// U+202A..U+202E(双向嵌入/覆盖)、U+2060..U+2064(词连接符/不可见运算符)、
// U+2066..U+206F(双向隔离符/弃用格式符)、U+FEFF(BOM / 零宽不换行空格)。
func connectorEnvKeyInvisible(r rune) bool {
	switch {
	case r == '\u00AD' || r == '\u180E' || r == '\uFEFF':
		return true
	case r >= '\u200B' && r <= '\u200F':
		return true
	case r >= '\u202A' && r <= '\u202E':
		return true
	case r >= '\u2060' && r <= '\u2064':
		return true
	case r >= '\u2066' && r <= '\u206F':
		return true
	}
	return false
}

// connectorCredentialFieldLists 是凭据字段声明的两个容器(客户端
// declaredCredentialKeys 读取的正是这两个列表)。
var connectorCredentialFieldLists = []string{"tokenFields", "settings"}

// validateConnectorCredentialFields 校验 tokenFields[] / settings[] 的元素形状,
// 并拒绝任何 key 命中受保护环境键(denylist 与客户端 policy.ts 的
// DENIED_ENV_KEYS + DSH_/ELECTRON_/PICOAIDE_ 前缀逐条对齐,由
// TestConnectorDeniedEnvKeysMatchClientPolicy 守卫防漂移)。
//
// 为什么必须在这里拦:客户端把"定义里声明过的字段名"当成可信白名单
// (declaredCredentialKeys → buildStdioEnv 的 env[key] = value),所以声明
// NODE_OPTIONS / LD_PRELOAD / DSH_* 与直接写 mcp[].env 等价 —— 服务端 schema
// 必须把两条通道一起堵住。
func validateConnectorCredentialFields(probe map[string]any) error {
	for _, list := range connectorCredentialFieldLists {
		raw, present := probe[list]
		if !present {
			continue
		}
		items, ok := raw.([]any)
		if !ok {
			return ErrValidation
		}
		for _, item := range items {
			m, ok := item.(map[string]any)
			if !ok {
				return ErrValidation
			}
			key, ok := m["key"].(string)
			if !ok || !connectorEnvKeyAllowed(key) {
				return ErrValidation
			}
		}
	}
	return nil
}

// connectorBlockedNetworks / connectorLoopbackNetworks 是客户端唯一策略源
// packages/host/connectors/src/outbound.ts 的 buildBlockedList() /
// buildLoopbackList() 的**逐条镜像**(顺序保持一致,便于人工对拍)。
//
// 2026-09-13 N5(第三轮独立复核 §3.3,P2):此前 Go 侧用 net.IP 的
// IsPrivate/IsLinkLocal*/IsMulticast/IsUnspecified 拼规则,覆盖面比客户端窄
// 一大截 —— CGNAT 100.64/10、0.0.0.0/8、192.0.0.0/24、192.0.2.0/24(文档段)、
// 198.18/15(基准测试)、198.51.100/24、203.0.113/24、240/4、NAT64
// 64:ff9b::/96、100::/64、2001:db8::/32 全部漏判。服务端比客户端宽 ⇒ 管理端
// 能保存、客户端静默丢弃(「保存成功但连接器消失」)。
//
// 现在改为镜像表 + 语义判据(见 connectorBlockedIP);防漂移守卫
// TestConnectorBlockedNetworksMatchClientOutbound 直接解析 outbound.ts 的
// 段清单逐条比对,任一侧增删段而不同步即失败。
var (
	connectorBlockedNetworks = []string{
		"0.0.0.0/8",      // 未指定/本网
		"10.0.0.0/8",     // 私网
		"100.64.0.0/10",  // CGNAT(RFC 6598)
		"169.254.0.0/16", // 链路本地/云元数据
		"172.16.0.0/12",  // 私网
		"192.0.0.0/24",   // IETF 协议分配
		"192.0.2.0/24",   // 文档段 TEST-NET-1
		"192.168.0.0/16", // 私网
		"198.18.0.0/15",  // 基准测试
		"198.51.100.0/24",
		"203.0.113.0/24", // 文档段 TEST-NET-3
		"224.0.0.0/4",    // 组播
		"240.0.0.0/4",    // 保留/广播
		"::/128",         // IPv6 未指定
		"64:ff9b::/96",   // NAT64
		"100::/64",       // 丢弃前缀
		"2001:db8::/32",  // 文档段
		"fc00::/7",       // 唯一本地
		"fe80::/10",      // 链路本地
		"ff00::/8",       // 组播
	}
	connectorLoopbackNetworks = []string{
		"127.0.0.0/8",
		"::1/128",
	}
	connectorBlockedIPNets  = connectorMustParseCIDRs(connectorBlockedNetworks)
	connectorLoopbackIPNets = connectorMustParseCIDRs(connectorLoopbackNetworks)
)

// connectorMustParseCIDRs 解析镜像表(常量,解析失败即编程错误 → panic)。
func connectorMustParseCIDRs(cidrs []string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(cidrs))
	for _, c := range cidrs {
		_, n, err := net.ParseCIDR(c)
		if err != nil {
			panic("serverstore: 非法出站策略镜像网段 " + c + ": " + err.Error())
		}
		out = append(out, n)
	}
	return out
}

// connectorIPInAny 判定 IP 是否落在任一网段。net.IPNet.Contains 会先用
// To4() 归一(v4-mapped `::ffff:10.0.0.1` 因此按 10/8 命中,与客户端显式
// 重查 IPv4-mapped 的语义一致)。
func connectorIPInAny(ip net.IP, nets []*net.IPNet) bool {
	for _, n := range nets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// connectorIPIsLoopback:回环单独一张表(策略允许「回环 http」,见
// connectorURLAllowed),与客户端 LOOPBACK_ADDRESSES 同口径。
func connectorIPIsLoopback(ip net.IP) bool {
	return connectorIPInAny(ip, connectorLoopbackIPNets)
}

// connectorBlockedIP: 非公网字面地址(私网/链路本地/元数据/多播/保留)。
// 回环单独处理:策略允许"回环 http"(本地开发),故这里不拦回环。
// 段清单与客户端 buildBlockedList() 逐条一致(见上)。
func connectorBlockedIP(ip net.IP) bool {
	if connectorIPIsLoopback(ip) {
		return false
	}
	return connectorIPInAny(ip, connectorBlockedIPNets)
}

// connectorURLPreprocess 抹平"WHATWG 解析器与 Go url.Parse 的输入预处理差异"
// (P2,审计 r5 §3)。客户端用 `new URL()`,它在解析前做三件事,Go 都不做:
//
//  1. 去掉输入里**所有** ASCII TAB/LF/CR(WHATWG "remove all ASCII tab or
//     newline")⇒ `https://example.com\t/mcp` 客户端认成 example.com,Go 的
//     url.Parse 直接报错(服务端更严但没有必要:客户端会真的连过去);
//  2. 去掉首尾的 C0 控制符与空格(WHATWG "trim C0 control or space");
//  3. http/https 属 **special scheme**:`\` 一律按 `/` 解析 ⇒
//     `https://example.com\@10.0.0.1/mcp` 客户端看到的主机是 example.com
//     (路径是 /@10.0.0.1/mcp),Go 的 url.Parse 会把 `\@` 当 userinfo 分隔,
//     得到主机 10.0.0.1 → 判定为内网拒绝(方向安全,但与客户端行为不一致)。
//
// 三步都只是**输入归一**,不改变判定强度:归一后 Go 与客户端看到同一个主机。
func connectorURLPreprocess(raw string) string {
	raw = strings.Map(func(r rune) rune {
		switch r {
		case '\t', '\n', '\r':
			return -1
		}
		return r
	}, raw)
	raw = strings.TrimFunc(raw, func(r rune) bool { return r <= 0x20 })
	return strings.ReplaceAll(raw, `\`, `/`)
}

// connectorHostIgnored 判定"WHATWG/UTS-46 在主机名里直接丢弃的字符"。
// 集合是**实测**出来的(对真客户端 `new URL()` 逐码位验证):
//
//	剥掉(U+00AD/U+180E/U+200B/U+2060-2064/U+206A-206F/U+FEFF)
//	  → `https://10.0.0.1\u200B/mcp` 客户端主机 = 10.0.0.1(内网 ⇒ 拒)
//	**不剥**(U+200C/U+200D/U+200E/U+200F/U+202A-202E/U+2066-2069)
//	  → 客户端 `new URL()` 直接抛错(Invalid URL)
//
// 所以它**不等于** connectorEnvKeyInvisible(环境键那边按客户端 normalizeEnvKey
// 的集合);不剥的那些码位在本函数返回 false 后由"非 ASCII 一律拒绝"兜住,判定
// 不会比客户端更宽。
func connectorHostIgnored(r rune) bool {
	switch {
	case r == '\u00AD' || r == '\u180E' || r == '\uFEFF':
		return true
	case r == '\u200B':
		return true
	case r >= '\u2060' && r <= '\u2064':
		return true
	case r >= '\u206A' && r <= '\u206F':
		return true
	}
	return false
}

// connectorHostNormalize 把主机名归一成 WHATWG 的形态(UTS-46 **子集**)。
//
// 覆盖(逐条对真客户端验证过):
//   - 点号变体:`。`U+3002 / `．`U+FF0E / `｡`U+FF61 → '.'(全角句点已在下面的
//     全角区间里,这里显式列出 U+3002/U+FF61);
//   - 全角 ASCII:U+FF01..U+FF5E → U+0021..U+007E(全角数字/字母 ⇒ `１０.０.０.１`
//     → 10.0.0.1);
//   - 不可见格式字符按 connectorHostIgnored 剥掉;
//   - **其余非 ASCII 一律拒绝**(返回 ok=false)。
//
// 第 4 条是取舍:完整 UTS-46(→ punycode)需要 golang.org/x/net/idna,而
// server/go.mod **不在本轮可改范围**(引它会把 `// indirect` 改成直接依赖,
// 动整个 module 的依赖面),故按兜底口径处理:非 ASCII 主机(Pure IDN,如
// `exämple.com`/`例え.jp`)服务端 fail-loud 拒绝 —— 客户端放行,属"服务端更严"
// 的已登记差异(不会出现"管理端保存成功、客户端静默丢弃"),代价是 IDN 连接器
// 暂时无法在管理端保存。要恢复 IDN:允许改 server/go.mod 后换成
// `idna.Lookup.ToASCII`(UTS-46 + punycode)。
//
// 方向性保证:只要**不**剥客户端会拒绝的字符(见 connectorHostIgnored),服务端
// 的主机判定永远不会比客户端更宽。
func connectorHostNormalize(host string) (string, bool) {
	if isASCIIHost(host) && !strings.ContainsFunc(host, connectorHostIgnored) {
		return host, true // 热路径:纯 ASCII 且无不可见字符
	}
	var b strings.Builder
	b.Grow(len(host))
	for _, r := range host {
		switch {
		case connectorHostIgnored(r):
			continue
		case r == '\u3002' || r == '\uFF61':
			b.WriteByte('.')
		case r >= 0xFF01 && r <= 0xFF5E:
			b.WriteRune(r - 0xFEE0)
		case r > 0x7F:
			return "", false // 非 ASCII:不适合本子集,拒绝(见函数注释)
		default:
			b.WriteRune(r)
		}
	}
	return b.String(), true
}

// isASCIIHost 报告字符串是否全为 ASCII(热路径判定,免一次 rune 扫描)。
func isASCIIHost(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] > 0x7F {
			return false
		}
	}
	return true
}

// connectorForbiddenHostChars 是 WHATWG 的 forbidden host code point 集合里
// **能在 Go 的 Hostname() 结果里出现**的那些(空格 / '#' / '/' / ':' / '<' /
// '>' / '?' / '@' / '[' / ']' / '^' / '|' / NUL)。TAB/LF/CR 在预处理里已去掉、
// `\` 已换成 `/`。命中即拒绝:客户端 `new URL()` 对这些形态直接抛错
// (例如 `https://exa%20mple.com/` 服务端曾按域名放行)。
// 只用于**域名形态**(IPv6 字面量含 ':',单独走 net.ParseIP)。
const connectorForbiddenHostChars = "\x00 #/:<>?@[\\]^|"

// connectorURLAllowed: 出站策略的 Go 侧镜像(https,或回环 http;
// 拒绝私网/链路本地/元数据/保留段)。与客户端 assertOutboundUrlAllowed 同规则。
func connectorURLAllowed(raw string) bool {
	parsed, err := url.Parse(connectorURLPreprocess(raw))
	if err != nil || parsed.Host == "" {
		return false
	}
	if parsed.User != nil || parsed.Scheme == "" {
		return false
	}
	isHTTPS := parsed.Scheme == "https"
	isHTTP := parsed.Scheme == "http"
	if !isHTTPS && !isHTTP {
		return false
	}
	// 端口范围(P2,审计 r5 §3):WHATWG 对 >65535 的端口直接抛错(客户端静默
	// 丢弃该连接器),Go 的 url.Parse 只校验"是数字" ⇒ `https://example.com:99999/`
	// 服务端放行。这里按 1–65535 校验(与需求口径一致;客户端接受 `:0`,服务端
	// 拒它,属"服务端更严"的已登记差异 —— 端口 0 的 URL 无法真正建连)。
	if port := parsed.Port(); port != "" {
		n, perr := strconv.Atoi(port)
		if perr != nil || n < 1 || n > 65535 {
			return false
		}
	}
	host := parsed.Hostname()
	if host == "" {
		return false
	}
	// IPv6 字面量(`[::1]`、`[::ffff:10.0.0.1]`)由 net.ParseIP 校验,不做
	// UTS-46 归一(它含 ':',而 ':' 是域名形态的 forbidden code point)。
	if !strings.HasPrefix(parsed.Host, "[") {
		normalized, ok := connectorHostNormalize(host)
		if !ok {
			return false
		}
		host = normalized
		if strings.ContainsAny(host, connectorForbiddenHostChars) {
			return false
		}
	}
	// zone-id(IPv6 scope id)与主机名里的裸 '%' 一律拒绝(2026-09-13 N5):
	//   - **真绕过**:`https://[fe80::1%25eth0]/mcp` —— net.ParseIP 遇到 `%zone`
	//     返回 nil,不处理就会退化成"域名"被放行(链路本地地址直接可达);
	//   - 剥掉 %zone 后它能被正确分类(链路本地/保留段 ⇒ 必拦),但**即便剥完
	//     是公网地址也不能放行**:WHATWG URL 不支持 zone-id(客户端
	//     `new URL()` 直接抛错,实测 `[2606:4700::1111%25eth0]` = false),
	//     服务端放行只会造成"管理端保存成功、客户端静默丢弃"。
	// 所以 zone-id 形态整体拒绝 —— 比"剥完放行公网"更严,且零可用性损失
	// (客户端本来就无法表达)。
	if strings.ContainsRune(host, '%') {
		return false
	}
	// FQDN 根点归一(2026-09-13 审计 R3):`metadata.google.internal.` / `localhost.`
	// 与不带点的写法解析到同一目标,不归一就能绕过下面的名单;与客户端
	// classifyHost 的 `.replace(/\.$/,'')` 同口径。
	host = strings.TrimSuffix(host, ".")
	if host == "" {
		return false
	}
	if connectorMetadataHosts[strings.ToLower(host)] {
		return false
	}
	loopback := false
	if ip := net.ParseIP(host); ip != nil {
		loopback = connectorIPIsLoopback(ip)
		if connectorBlockedIP(ip) {
			return false
		}
	} else if isObfuscatedIPv4(host) {
		// url.Parse 不会把 0x7f.1 / 2130706433 / 0177.0.0.1 归一成点分十进制,
		// 这类"看起来是 IP"的主机名一律拒绝(客户端侧 WHATWG URL 会归一)。
		return false
	} else if connectorLastLabelNumeric(host) {
		// WHATWG 的"以数字结尾 ⇒ 必须是合法 IPv4"启发式(2026-09-13 N5):
		// `1.2.3.4.5` / `example.123` / `123.456.789` 这些主机名客户端
		// `new URL()` 直接抛错(无法表达),Go 的 url.Parse 却当普通域名放行 ——
		// 又一个"保存成功、客户端静默丢弃"。上面已排除"能解析成 IP"与"标签
		// 全是数字"两种情形,走到这里就是这类无法表达的主机,同口径拒绝。
		return false
	} else if strings.EqualFold(host, "localhost") || strings.HasSuffix(strings.ToLower(host), ".localhost") {
		loopback = true
	}
	if isHTTP && !loopback {
		return false
	}
	return true
}

// isObfuscatedIPv4: 主机名每个标签都是数字(十进制/0x 十六进制/0o 八进制)时,
// 视为伪装的 IPv4 字面量。真正的 DNS 名不会全部由数字标签组成。
func isObfuscatedIPv4(host string) bool {
	labels := strings.Split(host, ".")
	if len(labels) == 0 || len(labels) > 4 {
		return false
	}
	for _, label := range labels {
		if label == "" {
			return false
		}
		if _, err := strconv.ParseUint(label, 0, 64); err != nil {
			return false
		}
	}
	return true
}

// connectorLastLabelNumeric: 主机名最后一个标签是否全为 ASCII 数字。
// 与 WHATWG URL 的"以数字结尾"启发式同锚点(客户端会强制按 IPv4 解析,
// 解析失败即整个 URL 非法);Go 的 url.Parse 不做这件事,故这里显式拒绝
// 这类客户端无法表达的主机(见 connectorURLAllowed)。
func connectorLastLabelNumeric(host string) bool {
	label := host
	if i := strings.LastIndexByte(host, '.'); i >= 0 {
		label = host[i+1:]
	}
	if label == "" {
		return false
	}
	for i := 0; i < len(label); i++ {
		if label[i] < '0' || label[i] > '9' {
			return false
		}
	}
	return true
}

// validateConnectorMCP: 逐项校验 mcp[](形状 + 出站策略)。任一项不合规即整体拒绝。
func validateConnectorMCP(mcp []any) error {
	for _, item := range mcp {
		m, ok := item.(map[string]any)
		if !ok {
			return ErrValidation
		}
		name, _ := m["serverName"].(string)
		if !connectorServerNameRe.MatchString(name) {
			return ErrValidation
		}
		transport := "stdio"
		if raw, present := m["transport"]; present {
			value, ok := raw.(string)
			if !ok || (value != "stdio" && value != "streamable-http") {
				return ErrValidation
			}
			transport = value
		}
		if transport == "streamable-http" {
			target, _ := m["url"].(string)
			if !connectorURLAllowed(target) {
				return ErrValidation
			}
		} else {
			if err := validateStdioServer(m); err != nil {
				return err
			}
		}
		if raw, present := m["headers"]; present {
			headers, ok := raw.(map[string]any)
			if !ok {
				return ErrValidation
			}
			for _, value := range headers {
				if _, ok := value.(string); !ok {
					return ErrValidation
				}
			}
		}
	}
	return nil
}

// validateStdioServer: stdio 分支必须给出可执行的 command;args/env(若声明)
// 必须是字符串形态,且 env 不得触碰受保护的键。
func validateStdioServer(m map[string]any) error {
	command, _ := m["command"].(string)
	if strings.TrimSpace(command) == "" || strings.ContainsRune(command, 0) {
		return ErrValidation
	}
	if raw, present := m["args"]; present {
		args, ok := raw.([]any)
		if !ok {
			return ErrValidation
		}
		for _, arg := range args {
			if _, ok := arg.(string); !ok {
				return ErrValidation
			}
		}
	}
	if raw, present := m["env"]; present {
		env, ok := raw.(map[string]any)
		if !ok {
			return ErrValidation
		}
		for key, value := range env {
			if !connectorEnvKeyAllowed(key) {
				return ErrValidation
			}
			if _, ok := value.(string); !ok {
				return ErrValidation
			}
		}
	}
	return nil
}

// connectorColumns (无 definition 大字段时列表读;单行读全字段)。
const connectorColumns = `id, name, description, auth_mode, definition, enabled, updated_at, created_at`

func scanConnector(rows interface{ Scan(...any) error }) (*Connector, error) {
	var c Connector
	var enabled int
	var updatedAt, createdAt sql.NullString
	if err := rows.Scan(&c.ID, &c.Name, &c.Description, &c.AuthMode, &c.Definition, &enabled, &updatedAt, &createdAt); err != nil {
		return nil, err
	}
	c.Enabled = enabled != 0
	c.UpdatedAt = updatedAt.String
	c.CreatedAt = createdAt.String
	return &c, nil
}

// ListConnectors returns all connectors (admin, ordered by id).
// Definition 大字段一并返回——管理端编辑需要;客户端下发走
// ListEnabledConnectors(只返回定义 JSON,由 bootstrap 解析)。
func ListConnectors(db *sql.DB) ([]Connector, error) {
	rows, err := db.Query("SELECT " + connectorColumns + " FROM connectors ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Connector
	for rows.Next() {
		c, err := scanConnector(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	return out, rows.Err()
}

// ListEnabledConnectors returns only enabled connectors (bootstrap/下发),
// 定义 JSON 直接可用,无需二次 DTO。
func ListEnabledConnectors(db *sql.DB) ([]Connector, error) {
	rows, err := db.Query("SELECT " + connectorColumns + " FROM connectors WHERE enabled = 1 ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Connector
	for rows.Next() {
		c, err := scanConnector(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	return out, rows.Err()
}

// GetConnector returns one connector row by id.
func GetConnector(db *sql.DB, id string) (*Connector, error) {
	row := db.QueryRow("SELECT "+connectorColumns+" FROM connectors WHERE id = ?", id)
	c, err := scanConnector(row)
	if err == sql.ErrNoRows {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return c, nil
}

// CreateConnector inserts a new connector row (id conflict → ErrDuplicate)。
func CreateConnector(db *sql.DB, c *Connector) error {
	if err := validateConnector(c); err != nil {
		return err
	}
	// PG 兼容:先查存在性再插入(单用户管理端,无并发竞争)。
	if existing, err := GetConnector(db, c.ID); err == nil && existing != nil {
		return ErrDuplicate
	} else if err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	_, err := db.Exec(`INSERT INTO connectors (id, name, description, auth_mode, definition, enabled)
		VALUES (?, ?, ?, ?, ?, ?)`, c.ID, strings.TrimSpace(c.Name), c.Description, c.AuthMode, c.Definition, boolInt(c.Enabled))
	return err
}

// UpdateConnector updates name/description/auth_mode/definition/enabled.
func UpdateConnector(db *sql.DB, c *Connector) error {
	if err := validateConnector(c); err != nil {
		return err
	}
	res, err := db.Exec(`UPDATE connectors SET name=?, description=?, auth_mode=?, definition=?, enabled=?
		WHERE id=?`, strings.TrimSpace(c.Name), c.Description, c.AuthMode, c.Definition, boolInt(c.Enabled), c.ID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// SetConnectorEnabled toggles the enable flag (bootstrap 下发开关)。
func SetConnectorEnabled(db *sql.DB, id string, enabled bool) error {
	res, err := db.Exec("UPDATE connectors SET enabled = ? WHERE id = ?", boolInt(enabled), id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteConnector removes one connector row (bootstrap 不再下发)。
func DeleteConnector(db *sql.DB, id string) error {
	res, err := db.Exec("DELETE FROM connectors WHERE id = ?", id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
