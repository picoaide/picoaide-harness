package llmgateway

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"

	"github.com/picoaide/picoaide/internal/util"
)

// ---------------------------------------------------------------------------
// 错误上报 DSN 准入校验(2026-09-16,GlitchTip 收集为空缺陷 R2)
//
// 背景:webadmin 与 setGatewayConfig 此前对 `web.error_reporting_dsn` **零校验**
// —— 现场 `http://cc82…@localhost:8000/1`(GlitchTip 缺 GLITCHTIP_DOMAIN 时后台
// 展示的值)被照收不误并提示"已保存"。而 DSN 是下发给**员工客户端**的:指向
// localhost 的 DSN 会让每台客户端把事件发往**自己的电脑**,必然 ECONNREFUSED,
// 且客户端把 init 失败降级(旧实现连日志都没有)⇒ 后台永远收不到、也永远不知道。
//
// 设计边界(PLAN §2.16 红线):
//   - **不改** `util/netguard.go`:它的"允许私网"是跨需求既定策略(网关上游/
//     余额/报表共用),为 DSN 收紧会波及全部出站面。规则只落在本文件。
//   - **硬拒绝** 环回 / 链路本地 / 云 metadata / unspecified —— 这些地址从
//     客户端视角永远不可能指向真实 GlitchTip。
//   - **只告警不拒绝** 私网(10/8、172.16/12、192.168/16、fc00::/7)与 http://
//     —— 企业内网自建 GlitchTip 是合法主场景。
//   - 本函数**不做 DNS 解析**:DSN 主机可能是内网域名或保存时 DNS 暂不可用;
//     解析失败不应拦住合法配置(与 validateUpstreamBaseURL 的取舍一致)。
// ---------------------------------------------------------------------------

// ErrorReportingDSNVerdict 是 DSN 校验结论(与 TS 侧同一套语料共用)。
type ErrorReportingDSNVerdict string

const (
	// ErrorReportingDSNAccept 合法且无告警。
	ErrorReportingDSNAccept ErrorReportingDSNVerdict = "accept"
	// ErrorReportingDSNWarn 合法但有风险(私网/明文 http),由 handler 透出给管理员。
	ErrorReportingDSNWarn ErrorReportingDSNVerdict = "warn"
	// ErrorReportingDSNReject 必然不可用,拒绝保存。
	ErrorReportingDSNReject ErrorReportingDSNVerdict = "reject"
)

// 拒绝文案(与 webadmin `src/lib/dsn.ts` 逐字一致 —— 两侧共享
// testdata/dsn_corpus.json 对拍,任一侧漂移都会变红)。
const (
	// ErrorReportingDSNBlockedMessage 环回/链路本地/云 metadata/unspecified。
	ErrorReportingDSNBlockedMessage = "错误上报 DSN 不能指向本机或云元数据地址(localhost/127.0.0.1/::1):客户端会把事件发往自己的电脑,永远收不到"
	// ErrorReportingDSNSchemeMessage 协议不合法。
	ErrorReportingDSNSchemeMessage = "错误上报 DSN 必须以 http:// 或 https:// 开头"
	// ErrorReportingDSNMalformedMessage 无法解析为 URL 或缺少主机名。
	ErrorReportingDSNMalformedMessage = "错误上报 DSN 不是合法的 URL(格式:{协议}://{公钥}@{主机}/{项目ID})"
	// ErrorReportingDSNHostMessage 主机名不是合法域名/IP。
	//
	// 2026-09-16(修复轮 1,F-12):"格式非法"与"host 语义非法"拆成两条文案 ——
	// 前者是整串解析不了,后者是能解析但主机名本身不成立(如 0.0.0.0.0)。
	ErrorReportingDSNHostMessage = "错误上报 DSN 的主机名不是合法的域名或 IP 地址"
	// ErrorReportingDSNPortMessage 端口越界/为 0。
	//
	// 2026-09-16(修复轮 1,F-14):`:99999` / `:0` 这类端口**服务端放行但客户端
	// SDK 一条都不发**(@sentry/node 的 node transport 解析不了就换成 no-op
	// transport,连日志都只是 console.warn)⇒ 属于"配置必然不工作且不可见",拒绝。
	ErrorReportingDSNPortMessage = "错误上报 DSN 的端口必须是 1-65535 的数字(:0 与越界端口不会被客户端 SDK 接受,事件一条都发不出去)"
	// ErrorReportingDSNKeyMessage 缺少公钥。
	ErrorReportingDSNKeyMessage = "错误上报 DSN 缺少公钥(格式:{协议}://{公钥}@{主机}/{项目ID})"
	// ErrorReportingDSNProjectMessage 项目 ID 不是正整数。
	ErrorReportingDSNProjectMessage = "错误上报 DSN 的项目 ID 必须是正整数(格式:{协议}://{公钥}@{主机}/{项目ID})"
	// ErrorReportingDSNTooLongMessage 超过长度上限。
	//
	// 2026-09-16(修复轮 1,F-13):此前 8000+ 字符的 DSN 也会照收并入库(复核实证
	// stored_len=8025)。DSN 只由协议/public key/主机/项目 ID 组成,正常远小于
	// 这个上限;超长只可能是误粘贴或恶意填充,入库后既占空间又会被原样下发给
	// 每台客户端。
	ErrorReportingDSNTooLongMessage = "错误上报 DSN 过长(上限 2048 字符):DSN 只含协议/公钥/主机/项目 ID,正常不会超过这个长度"
	// ErrorReportingDSNEnabledWithoutDSNMessage 跨字段:启用上报但没有 DSN。
	//
	// 2026-09-16(修复轮 1,F-13):这是 R2("配置必然不工作却提示已保存")的
	// **跨字段**形态 —— 开关打开、DSN 为空时客户端 `initSentry('')` 直接返回,
	// 一个字节都不发,而 admin 看到的是"已保存"。
	ErrorReportingDSNEnabledWithoutDSNMessage = "启用客户端错误上报时必须填写 DSN:开关打开而 DSN 为空时客户端不会上报任何错误(后台会永远收不到,且看不出是配置问题)"
)

// ErrorReportingDSNMaxLength 是 DSN 的长度上限(字符)。
const ErrorReportingDSNMaxLength = 2048

// 告警文案(顺序固定:先 http 后私网;多条用 "；" 连接)。
const (
	// ErrorReportingDSNPlainHTTPMessage http 明文。
	ErrorReportingDSNPlainHTTPMessage = "使用 http:// 明文传输:仅当内网自建且无法启用 TLS 时才可用"
	// ErrorReportingDSNPrivateMessage 私网地址。
	ErrorReportingDSNPrivateMessage = "该地址属于内网私有网段:仅当客户端能访问该内网地址时才可用(内网自建场景合法)"
)

// ErrorReportingDSN 是一次 DSN 校验的完整结论。
type ErrorReportingDSN struct {
	// Verdict accept / warn / reject。
	Verdict ErrorReportingDSNVerdict
	// Message reject 时是拒绝原因;warn 时是告警文案;accept 时为空。
	Message string
	// Scheme 解析出的协议(小写);reject 时可能为空。
	Scheme string
	// Host 主机名(不含端口、不含 userinfo)。
	Host string
	// Port 显式端口,无端口时为空。
	Port string
	// PublicKey DSN 的 public key(userinfo 用户名)。
	PublicKey string
	// ProjectID 项目 ID(路径最后一段)。
	ProjectID string
	// StoreEndpoint 由 DSN 推导的 ingest 端点(不含 userinfo/secret)。
	StoreEndpoint string
}

// Rejected 报告结论是否应被拒绝保存。
func (d ErrorReportingDSN) Rejected() bool { return d.Verdict == ErrorReportingDSNReject }

func rejectDSN(message string) ErrorReportingDSN {
	return ErrorReportingDSN{Verdict: ErrorReportingDSNReject, Message: message}
}

// InspectErrorReportingDSN 校验并解析一个错误上报 DSN。
//
// 空串 = 未启用(允许清空),直接 accept。
//
// 2026-09-16(修复轮 1,F-06/F-12/F-14)在这一版补了三件事,且 webadmin 侧
// `src/lib/dsn.ts` 必须**逐字同改**(同一份语料对拍):
//  1. **主机名归一化**:去尾点(localhost. 与 localhost 等价)、小写、并把
//     WHATWG 认可的 IPv4 数字写法(127.1 / 2130706433 / 0177.0.0.1 /
//     017700000001 / 0x7f000001 / 0x7f.0.0.1)折算成点分四段再判定,否则环回
//     等价写法会被放行 —— 实测这些写法在客户端**全部解析到 127.0.0.1**;
//  2. **端口范围**:1-65535(端口 0 / 越界端口客户端 SDK 一条都不发);
//  3. **公钥按解码后判定**:`%20` 这类只有空白的名义 userinfo 视为没有公钥。
func InspectErrorReportingDSN(raw string) ErrorReportingDSN {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		// 空 = 不启用:允许清空既有配置。
		return ErrorReportingDSN{Verdict: ErrorReportingDSNAccept}
	}
	// 长度上限(F-13):先于任何解析,避免用超长输入喂解析器。
	if len(raw) > ErrorReportingDSNMaxLength {
		return rejectDSN(ErrorReportingDSNTooLongMessage)
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return rejectDSN(ErrorReportingDSNMalformedMessage)
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return rejectDSN(ErrorReportingDSNSchemeMessage)
	}
	// 端口:显式给出时必须落在 1-65535(空 = 默认端口)。
	if port := u.Port(); port != "" {
		n, convErr := strconv.Atoi(port)
		if convErr != nil || n < 1 || n > 65535 {
			return rejectDSN(ErrorReportingDSNPortMessage)
		}
	}
	// 公钥:DSN 形如 {协议}://{公钥}[:{私钥}]@{主机}/{项目ID}。
	// `u.User.Username()` 已做百分号解码,所以 `%20` 这类会变成空白 → 视为缺失。
	if u.User == nil || strings.TrimSpace(u.User.Username()) == "" {
		return rejectDSN(ErrorReportingDSNKeyMessage)
	}
	projectID, prefix, perr := splitErrorReportingDSNPath(u.Path)
	if perr != nil {
		return rejectDSN(ErrorReportingDSNProjectMessage)
	}
	rawHost := u.Hostname()
	if rawHost == "" {
		return rejectDSN(ErrorReportingDSNMalformedMessage)
	}
	host, hostErr := normalizeErrorReportingDSNHost(rawHost)
	if hostErr != nil {
		return rejectDSN(ErrorReportingDSNHostMessage)
	}
	// 环回/链路本地/云 metadata/unspecified:从客户端视角永远不可用。
	if blockedErrorReportingDSNHost(host) {
		return rejectDSN(ErrorReportingDSNBlockedMessage)
	}

	verdict := ErrorReportingDSNAccept
	warnings := make([]string, 0, 2)
	if scheme == "http" {
		warnings = append(warnings, ErrorReportingDSNPlainHTTPMessage)
	}
	if privateErrorReportingDSNHost(host) {
		warnings = append(warnings, ErrorReportingDSNPrivateMessage)
	}
	if len(warnings) > 0 {
		verdict = ErrorReportingDSNWarn
	}
	portPart := ""
	if p := u.Port(); p != "" {
		portPart = ":" + p
	}
	if prefix != "" {
		prefix = "/" + prefix
	}
	return ErrorReportingDSN{
		Verdict:       verdict,
		Message:       strings.Join(warnings, "；"),
		Scheme:        scheme,
		Host:          host,
		Port:          u.Port(),
		PublicKey:     u.User.Username(),
		ProjectID:     projectID,
		StoreEndpoint: fmt.Sprintf("%s://%s%s%s/api/%s/store/", scheme, host, portPart, prefix, projectID),
	}
}

// normalizeErrorReportingDSNHost 归一化主机名并校验其形状。
//
// 归一化三件事(与 webadmin `dsn.ts` 的 normalizeHost 必须一致):
//   - 去**全部**尾点(`localhost.` / `localhost..` → `localhost`,RFC 6761 里
//     尾点是"绝对域名"写法,与不带尾点解析结果相同);
//   - 小写(主机名大小写不敏感);
//   - IPv4 **数字写法**折算成点分四段(1-4 段、十进制/`0x` 十六进制/前导 `0`
//     八进制)。判定规则照 WHATWG URL 的 "ends in a number ⇒ IPv4 parser":
//     末段是数字就必须整体解析成 IPv4,解析不了即非法(这条同时挡住
//     `0.0.0.0.0` 这种 5 段写法 —— 客户端 `new URL` 会直接抛错)。
//
// 非数字末段按域名处理:只做形状校验(标签非空、字符集、长度上限),不做 DNS。
func normalizeErrorReportingDSNHost(host string) (string, error) {
	trimmed := strings.ToLower(strings.TrimRight(host, "."))
	if trimmed == "" {
		return "", errors.New("empty host")
	}
	// IPv6 字面量(url.Hostname 已脱去方括号)含冒号,不走 IPv4/域名规则。
	if strings.Contains(trimmed, ":") {
		if net.ParseIP(trimmed) == nil {
			return "", errors.New("invalid ipv6 literal")
		}
		return trimmed, nil
	}
	if numericErrorReportingDSNLastLabel(trimmed) {
		ip, ok := parseErrorReportingDSNIPv4Number(trimmed)
		if !ok {
			return "", errors.New("invalid ipv4 number notation")
		}
		return ip, nil
	}
	if !validErrorReportingDSNHostname(trimmed) {
		return "", errors.New("invalid hostname")
	}
	return trimmed, nil
}

// numericErrorReportingDSNLastLabel 报告最后一个标签是否是数字(十进制或 0x 十六进制)。
// 这是 WHATWG "host ends in a number" 的判据,决定要不要走 IPv4 数字解析。
func numericErrorReportingDSNLastLabel(host string) bool {
	labels := strings.Split(host, ".")
	last := labels[len(labels)-1]
	if last == "" {
		return false
	}
	if strings.HasPrefix(last, "0x") || strings.HasPrefix(last, "0X") {
		return len(last) > 2 && isHexDigits(last[2:])
	}
	return isDecimalDigits(last)
}

func isDecimalDigits(value string) bool {
	for _, r := range value {
		if r < '0' || r > '9' {
			return false
		}
	}
	return value != ""
}

func isHexDigits(value string) bool {
	for _, r := range value {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'f', r >= 'A' && r <= 'F':
		default:
			return false
		}
	}
	return value != ""
}

// parseErrorReportingDSNIPv4Number 按 WHATWG 的 IPv4 数字规则解析(1-4 段):
// 每段十进制 / `0x` 十六进制 / 前导 0 八进制;非末段不得超过 255;数值总宽
// 由段数决定(末段可覆盖剩余字节)。返回点分四段字符串。
func parseErrorReportingDSNIPv4Number(host string) (string, bool) {
	labels := strings.Split(host, ".")
	if len(labels) == 0 || len(labels) > 4 {
		return "", false
	}
	values := make([]uint64, 0, len(labels))
	for _, label := range labels {
		value, ok := parseErrorReportingDSNIPv4Label(label)
		if !ok {
			return "", false
		}
		values = append(values, value)
	}
	for _, value := range values[:len(values)-1] {
		if value > 0xff {
			return "", false
		}
	}
	// 末段可用位数 = 剩余字节数(段数越少,末段越大)。
	last := values[len(values)-1]
	limit := uint64(1)
	for i := len(values); i <= 4; i++ {
		limit *= 256
	}
	if last >= limit {
		return "", false
	}
	total := last
	for i, value := range values[:len(values)-1] {
		shift := uint(8 * (3 - i))
		total += value << shift
	}
	return fmt.Sprintf("%d.%d.%d.%d", (total>>24)&0xff, (total>>16)&0xff, (total>>8)&0xff, total&0xff), true
}

// parseErrorReportingDSNIPv4Label 解析单个标签的数值(空/非法字符/溢出都返回 false)。
func parseErrorReportingDSNIPv4Label(label string) (uint64, bool) {
	if label == "" {
		return 0, false
	}
	if strings.HasPrefix(label, "0x") || strings.HasPrefix(label, "0X") {
		if len(label) <= 2 || !isHexDigits(label[2:]) {
			return 0, false
		}
		value, err := strconv.ParseUint(label[2:], 16, 64)
		return value, err == nil
	}
	if !isDecimalDigits(label) {
		return 0, false
	}
	// 前导 0(且不止一位)= 八进制(WHATWG 同)。
	if len(label) > 1 && label[0] == '0' {
		value, err := strconv.ParseUint(label, 8, 64)
		return value, err == nil
	}
	value, err := strconv.ParseUint(label, 10, 64)
	return value, err == nil
}

// validErrorReportingDSNHostname 校验域名的形状(不做 DNS 解析)。
//
// 规则刻意保守但**不收紧既有接受面**:标签非空、单标签 ≤63 字符、总长 ≤253,
// 字符限 `a-z0-9-_` 与**非 ASCII 码位**(IDN 域名 —— 改动前这类主机是被接受的,
// 客户端 `new URL` 会自己做 punycode;收紧它会平白拒掉合法的中文/IDN 部署)。
func validErrorReportingDSNHostname(host string) bool {
	if len(host) > 253 {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if label == "" || len(label) > 63 {
			return false
		}
		for _, r := range label {
			switch {
			case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_', r >= 0x80:
			default:
				return false
			}
		}
	}
	return true
}

// splitErrorReportingDSNPath 取路径最后一段作为项目 ID,并返回其余路径前缀。
func splitErrorReportingDSNPath(path string) (projectID string, prefix string, err error) {
	trimmed := strings.Trim(path, "/")
	if trimmed == "" {
		return "", "", errors.New("empty dsn path")
	}
	idx := strings.LastIndex(trimmed, "/")
	if idx < 0 {
		projectID = trimmed
	} else {
		projectID = trimmed[idx+1:]
		prefix = trimmed[:idx]
	}
	n, convErr := strconv.Atoi(projectID)
	if convErr != nil || n <= 0 {
		return "", "", errors.New("project id must be a positive integer")
	}
	return projectID, prefix, nil
}

// blockedErrorReportingDSNHost 报告主机名是否属于"必然不可用"的地址类别。
func blockedErrorReportingDSNHost(host string) bool {
	lowered := strings.ToLower(host)
	// localhost 及其子域(RFC 6761 保留:*.localhost 一律解析到环回)。
	if lowered == "localhost" || strings.HasSuffix(lowered, ".localhost") {
		return true
	}
	if util.IsBlockedOutboundHost(lowered) {
		return true
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	// 环回:127.0.0.0/8(含 127.1.2.3 这类缩写)、::1、::ffff:127.0.0.1。
	if ip.IsLoopback() {
		return true
	}
	// 链路本地 / 云 metadata / unspecified(0.0.0.0、::、fe80::/10、
	// 169.254.0.0/16、100.100.100.200、fd00:ec2::/64)。
	return util.IsBlockedOutboundIP(ip)
}

// privateErrorReportingDSNHost 报告主机名是否是私网字面 IP(RFC 1918 + ULA)。
// 域名一律返回 false(不做 DNS 解析,见文件头说明)。
func privateErrorReportingDSNHost(host string) bool {
	ip := net.ParseIP(host)
	return ip != nil && ip.IsPrivate()
}

// ValidateErrorReportingDSN 校验错误上报 DSN,不合法时返回可直接透出给管理员
// 的错误(拒绝类文案与 webadmin 侧逐字一致)。
//
// 私网/http 属于"合法但告警",**不**返回错误 —— 需要告警文案的调用方用
// InspectErrorReportingDSN。
func ValidateErrorReportingDSN(raw string) error {
	inspection := InspectErrorReportingDSN(raw)
	if inspection.Rejected() {
		return errors.New(inspection.Message)
	}
	return nil
}
