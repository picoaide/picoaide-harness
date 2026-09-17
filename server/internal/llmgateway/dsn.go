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
//   - **接受面 = 客户端 SDK 真能解析的形状**(2026-09-17,S10-2):主机只允许
//     ASCII 的 `[A-Za-z0-9._-]`。中文域名/全角写法(IDN)与 IPv6 字面量一律拒绝
//     —— @sentry/utils 的 DSN_REGEX 是 ASCII-only,这两类让 makeDsn 返回
//     undefined,SDK 连 transport 都不建,放行等于"保存了一个永远零上报的配置"。
//     同一条判据还覆盖协议大小写、公钥/私钥字符集(`\w`)、userinfo 里多余的 '@'
//     与空端口(2026-09-17 修复轮 2)—— 它们都是"Go 能解析、SDK 解析不了"的位置。
//   - **项目 ID 与端点取自 SDK 真正切的那一段**(2026-09-17 修复轮 3,r3v 复核):
//     SDK 的 `(.+)` 是 authority 之后那个 '/' 之后的**整段**(query/fragment 在内),
//     端点 path 也逐字来自它 —— 详见 errorReportingDSNRemainder。
//   - **接受面 = 客户端 SDK 真能发得出去**(2026-09-17 修复轮 5,r4v 复核):
//     "SDK 解析得了"只是必要条件 —— `?`/`#` 落在路径前缀里的 DSN(makeDsn 能成功)
//     拼出的 envelope URL 会被 @sentry/node 的 `new URL(...)` + `pathname+search`
//     截断,`/api/<项目ID>/envelope/` 与 sentry_key 一起丢,事件必然 404。这类一律
//     拒绝(见 ErrorReportingDSNProjectQueryMessage / errErrorReportingDSNProjectQuery)。
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
	// ErrorReportingDSNEmptyPortMessage 显式端口为空(`host:` / `[::1]:`)。
	//
	// 2026-09-17(S10-2 修复轮 2):Go 的 `url.Parse` 把"冒号后没有数字"当成**没有
	// 端口**照收(u.Host 末尾留一个 ':'、u.Port() 返回空),而客户端 SDK 的正则是
	// `(?::(\d+))?` —— 端口位必须是数字,空端口让 makeDsn 返回 undefined、
	// baseclient 连 transport 都不建。与 F-14 同类(配置必然零上报),但成因不同,
	// 所以单独一条文案。
	ErrorReportingDSNEmptyPortMessage = "错误上报 DSN 的端口不能为空(: 后面必须跟 1-65535 的数字,不用端口就整个省略):客户端 Sentry SDK 解析不了空端口,保存后一个事件都发不出去"
	// ErrorReportingDSNSchemeCaseMessage 协议大小写(`HTTPS://`)。
	//
	// 2026-09-17(S10-2 修复轮 2):Go 的 `url.Parse` 会把 scheme 小写化,所以旧实现
	// 的大小写比较永远通过;但**入库并下发给客户端的是原始串**,而 SDK 的
	// validateDsn 要求 protocol 恰为小写 http/https —— `HTTPS://` 让 makeDsn
	// 返回 undefined。判定必须看原文。
	ErrorReportingDSNSchemeCaseMessage = "错误上报 DSN 的协议必须小写(http:// 或 https://):客户端 Sentry SDK 只接受小写协议,HTTPS:// 会被判为非法,保存后一个事件都发不出去"
	// ErrorReportingDSNKeyCharsMessage 公钥(与可选私钥)的字符集不在 SDK 正则内。
	//
	// 2026-09-17(S10-2 修复轮 2):@sentry/utils 的 DSN_REGEX 里 userinfo 组是
	// `(?:(\w+)(?::(\w+)?)?@)`(`\w` = 字母/数字/下划线,ASCII-only)。公钥里的
	// `-`/`.`/`%`、私钥里的非 `\w` 字符、userinfo 里多出来的 `@` 都会让整串匹配
	// 失败 ⇒ makeDsn undefined ⇒ 客户端一个事件都不发,而保存返回 200 {ok:true}。
	ErrorReportingDSNKeyCharsMessage = "错误上报 DSN 的公钥(与可选的私钥)只能是字母、数字或下划线:客户端 Sentry SDK 的正则是 \\w,含 '-'、'.'、'%' 等字符或 userinfo 里多出的 '@' 都会让 SDK 解析失败,保存后一个事件都发不出去"
	// ErrorReportingDSNKeyMessage 缺少公钥。
	ErrorReportingDSNKeyMessage = "错误上报 DSN 缺少公钥(格式:{协议}://{公钥}@{主机}/{项目ID})"
	// ErrorReportingDSNProjectMessage 项目 ID 不是正整数。
	ErrorReportingDSNProjectMessage = "错误上报 DSN 的项目 ID 必须是正整数(格式:{协议}://{公钥}@{主机}/{项目ID})"
	// ErrorReportingDSNProjectQueryMessage `?`/`#` 出现在项目 ID 段之前(即落在路径前缀里)。
	//
	// 2026-09-17(S10-2 修复轮 5,r4v 复核):修复轮 3 把项目 ID/前缀放宽成
	// authority 之后的**整段剩余**(含 query/fragment)以对齐 SDK 的
	// `split('/').pop()`,但那只保证"SDK 解析得了",不保证"事件送得到":
	// `https://key@host/1?x=/2` 让 SDK 的 path 变成 `1?x=`、项目 ID 变成 2,
	// 基端点拼成 `https://host/1?x=/api/2/envelope/?sentry_key=…`;而 @sentry/node
	// 的 transports/http.js 是 `new URL(options.url)` 后发 `pathname+search`
	// —— pathname 只剩 `/1`,查询串里的 `/api/2/envelope/` 对路由不可见,
	// `sentry_key` 一并被吞。保存仍回 200 {ok:true},后台永远空白(= S10-2 要
	// 消灭的"零上报假绿")。判据因此收紧为"实际请求路径必须还含
	// `/api/{项目ID}/envelope/`":首个 `?`/`#` 落在最后一个 '/' 之前(等价于
	// 切出的 prefix 含 `?`/`#`)一律拒。项目 ID 段自身带 `?`/`#`(`/1?x=2`)不受影响
	// —— 那种写法 prefix 为空,端点仍是干净的 `/api/1/envelope/`。
	ErrorReportingDSNProjectQueryMessage = "错误上报 DSN 的 ? 或 # 出现在最后一个 / 之前:客户端 SDK 会把 ? / # 之后的内容当成项目 ID,拼出的请求路径里 /api/{项目ID}/envelope/ 段会被查询串/锚点吞掉(连带 sentry_key),保存后一个事件都发不出去;请删掉 ? / # 及其后的内容,或把它挪到项目 ID 之后"
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
	// ErrorReportingDSNUnsupportedHostMessage 主机形态客户端 SDK 解析不了。
	//
	// 2026-09-17(S10-2):接受面必须等于"客户端 SDK 真能解析的形状"。客户端下发
	// 的 DSN 不经 WHATWG URL,而是 @sentry/utils 的 **ASCII-only** DSN_REGEX
	// (host = `[\w.-]+`);中文域名(IDN)/全角写法与 IPv6 字面量都会让 makeDsn
	// 返回 undefined,@sentry/core 的 baseclient 因 `_dsn` 为空**根本不建
	// transport** —— 一个事件都发不出去,而保存时返回的是 200 {ok:true}。
	// 实测:dsnFromString('https://key@glitchtip.中国/1') 与
	// dsnFromString('https://key@[2001:db8::1]/1') 都是 undefined。
	ErrorReportingDSNUnsupportedHostMessage = "错误上报 DSN 的主机名只支持 ASCII 域名或 IPv4 地址:客户端 Sentry SDK 解析不了中文域名(IDN)与 IPv6 字面量,保存后一个事件都发不出去"
)

// ErrorReportingDSNMaxLength 是 DSN 的长度上限(**UTF-8 字节**,与 `len(raw)` 同口径)。
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
	// 2026-09-17(修复轮 2):去首尾空白必须用**客户端**的口径(见 trimErrorReportingDSN),
	// 不能用 Go 的 strings.TrimSpace —— 后者多认 U+0085(NEL),会把
	// `"\u0085https://key@host/1"` 剥成合法值入库,而客户端 `dsn.trim()`
	// (ECMAScript)不剥它 ⇒ SDK 仍拿不到可解析的串。
	raw = trimErrorReportingDSN(raw)
	if raw == "" {
		// 空 = 不启用:允许清空既有配置。
		return ErrorReportingDSN{Verdict: ErrorReportingDSNAccept}
	}
	// 长度上限(F-13):先于任何解析,避免用超长输入喂解析器。
	if len(raw) > ErrorReportingDSNMaxLength {
		return rejectDSN(ErrorReportingDSNTooLongMessage)
	}
	// S10-2 修复轮 3(2026-09-17,r3v 复核):控制字符必须在**整串**上判。
	// `url.Parse` 的实现是「先按 '#' 切出 fragment,再对前半段查 CTL」
	// (net/url.Parse -> parse),所以 fragment 里的 0x00/0x07/0x7F 会被它放行;
	// 而下游 settings.value 是 PG TEXT,0x00 会让保存直接 500(「页面提示已保存、
	// 实际什么都没存」,与 SG-1 同一类)。webadmin 的 hasControlByte 一直是整串
	// 判定 —— 两侧对 `.../1#/a\u0000` 曾给出相反结论(扫掠 9 条)。round 3 起
	// fragment 参与项目 ID/端点推导,它的内容必须与 path 同标准。
	if hasControlByte(raw) {
		return rejectDSN(ErrorReportingDSNMalformedMessage)
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return rejectDSN(ErrorReportingDSNMalformedMessage)
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return rejectDSN(ErrorReportingDSNSchemeMessage)
	}
	// S10-2 修复轮 2(2026-09-17):协议大小写。Go 的 `url.Parse` 会把 scheme 小写化
	// (上面的比较因此永远通过),但下发给客户端的是**原始串** —— 必须看原文。
	if errorReportingDSNRawScheme(raw) != scheme {
		return rejectDSN(ErrorReportingDSNSchemeCaseMessage)
	}
	// 端口:显式给出时必须落在 1-65535(空 = 默认端口)。
	if port := u.Port(); port != "" {
		n, convErr := strconv.Atoi(port)
		if convErr != nil || n < 1 || n > 65535 {
			return rejectDSN(ErrorReportingDSNPortMessage)
		}
	}
	// S10-2 修复轮 2(2026-09-17):显式冒号但端口为空。`url.Parse` 认它是"没有端口"
	// (u.Host = "host:"),SDK 的 `(?::(\d+))?` 却需要数字 ⇒ 空端口解析不了。
	if strings.HasSuffix(u.Host, ":") {
		return rejectDSN(ErrorReportingDSNEmptyPortMessage)
	}
	// 公钥:DSN 形如 {协议}://{公钥}[:{私钥}]@{主机}/{项目ID}。
	// `u.User.Username()` 已做百分号解码,所以 `%20` 这类会变成空白 → 视为缺失。
	if u.User == nil || strings.TrimSpace(u.User.Username()) == "" {
		return rejectDSN(ErrorReportingDSNKeyMessage)
	}
	// S10-2 修复轮 2(2026-09-17):SDK 的 userinfo 正则 `(\w+)(?::(\w+)?)?@`。
	// 必须判**原文**里的 userinfo 段:url.User 已做百分号解码(`ke%79` → `key`),
	// 而 SDK 看到的是带 `%` 的原文,解码后的值判定会把 SDK 解析不了的串放行。
	if !sdkParseableErrorReportingDSNUserinfo(errorReportingDSNRawUserinfo(raw)) {
		return rejectDSN(ErrorReportingDSNKeyCharsMessage)
	}
	// 项目 ID:取 authority 之后的**全部原文剩余**(含 query 与 fragment)。
	// SDK 的 dsnFromString 把整段交给 `split('/').pop()`,所以 query/fragment 里的
	// '/' 会真正改变项目 ID 与端点 —— 语义必须与它同源(详见
	// splitErrorReportingDSNRemainder 注释)。
	projectID, prefix, perr := splitErrorReportingDSNRemainder(errorReportingDSNRemainder(raw))
	if perr != nil {
		if errors.Is(perr, errErrorReportingDSNProjectQuery) {
			return rejectDSN(ErrorReportingDSNProjectQueryMessage)
		}
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
	// S10-2(2026-09-17):SDK 可解析性 —— 中文域名(IDN)/全角写法与 IPv6 字面量
	// 客户端 SDK 一条都解析不了(见 ErrorReportingDSNUnsupportedHostMessage)。
	// 顺序刻意放在 blocked 之后:环回/链路本地/metadata 的 IPv6 写法仍给出更准确
	// 的"不能指向本机"文案,其余 IPv6 与 IDN 才落到"SDK 不支持"。
	if !sdkParseableErrorReportingDSNHost(host) {
		return rejectDSN(ErrorReportingDSNUnsupportedHostMessage)
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
	return ErrorReportingDSN{
		Verdict:       verdict,
		Message:       strings.Join(warnings, "；"),
		Scheme:        scheme,
		Host:          host,
		Port:          u.Port(),
		PublicKey:     u.User.Username(),
		ProjectID:     projectID,
		StoreEndpoint: errorReportingStoreEndpoint(scheme, host, u.Port(), prefix, projectID),
	}
}

// trimErrorReportingDSN 按**客户端**的口径去首尾空白(ECMAScript `String.prototype.trim`)。
//
// 2026-09-17(S10-2 修复轮 2):判定必须与客户端真正交给 SDK 的值逐字同源 ——
// 客户端 `initSentry` 做的是 `dsn.trim()`(error-reporting.ts),即 ECMAScript 的
// WhiteSpace+LineTerminator,而**不是** Go 的 `strings.TrimSpace`。两处差异都会
// 造成"服务端放行、客户端零上报":
//   - U+0085(NEL)在 Go 里算空白、在 ECMAScript 里不算 ⇒ 带 NEL 的串被服务端剥干净
//     入库,客户端 trim 不掉,SDK 的 DSN_REGEX 失配(扫掠实测);
//   - U+FEFF(BOM)在 ECMAScript 里算空白、在 Go 的 TrimSpace 里不算 ⇒ 尾随 BOM 的
//     串两端结论相反(TS 放行、Go 400)。
//
// 这里逐字镜像 ECMAScript 的集合(WhiteSpace + LineTerminator)。
func trimErrorReportingDSN(raw string) string {
	return strings.TrimFunc(raw, func(r rune) bool {
		switch r {
		case '\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\ufeff',
			'\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000':
			return true
		}
		// Unicode 空格分隔符(Zs)中除上面已列的:U+2000–U+200A。
		return r >= 0x2000 && r <= 0x200a
	})
}

// errorReportingDSNRawScheme 取 DSN 原文里写的协议(未小写化)。
//
// S10-2 修复轮 2(2026-09-17):`url.Parse` 会把 scheme 小写化,原始大小写只留在
// 原文里 —— 而 SDK 的 validateDsn 判的正是下发串(原文)。
func errorReportingDSNRawScheme(raw string) string {
	if i := strings.Index(raw, "://"); i >= 0 {
		return raw[:i]
	}
	return ""
}

// errorReportingDSNRawUserinfo 取 DSN 原文里的 userinfo 段(不含 '@')。
//
// S10-2 修复轮 2(2026-09-17):SDK 的 DSN_REGEX 作用在**原始串**上,而
// `u.User.Username()` 已经百分号解码(`ke%79` → `key`)——判定 SDK 兼容性必须
// 用原文,否则 `ke%79@` 这种 SDK 真解析不了的写法会被放行。按最后一个 '@' 切分
// (与 `parseAuthority`/SDK 正则同:正则里的 `\w` 不含 '@',多一个 '@' 必然失配)。
func errorReportingDSNRawUserinfo(raw string) string {
	authority := errorReportingDSNRawAuthority(raw)
	if i := strings.LastIndex(authority, "@"); i >= 0 {
		return authority[:i]
	}
	return ""
}

// errorReportingDSNRawAuthority 取 DSN 原文里的 authority(不含 '/'、'?'、'#')。
func errorReportingDSNRawAuthority(raw string) string {
	rest := raw
	if i := strings.Index(rest, "://"); i >= 0 {
		rest = rest[i+3:]
	}
	if i := strings.IndexAny(rest, "/?#"); i >= 0 {
		rest = rest[:i]
	}
	return rest
}

// errorReportingDSNRemainder 取 DSN 原文里 authority 之后、**首个 '/' 之后的全部剩余**
// (含 query 与 fragment),并像 SDK 一样截断到第一个行终止符。
//
// S10-2 修复轮 3(2026-09-17,r3v 复核):此前项目 ID 只从「'?'/'#' 之前的路径」切,
// 而 @sentry/utils 的 DSN_REGEX 是
//
//	/^(?:(\w+):)\/\/(?:(\w+)(?::(\w+)?)?@)([\w.-]+)(?::(\d+))?\/(.+)/
//
// —— 最后一个捕获组 `(.+)` 拿到的是 host[:port] 之后那个 '/' **之后的整段**(query
// 与 fragment 都在内),dsnFromString 再对它 `split('/')` 取 pop。于是:
//   - `https://key@host/1?x=http://y`、`/1?a=b/c`、`/1#/a` 的「项目 ID」是 `y`/`c`/`a`
//     ⇒ SDK 返回 undefined(makeDsn 失败 ⇒ 客户端连 transport 都不建,而服务端
//     回 200 {ok:true} —— 正是本轮要消灭的"零上报假绿");
//   - `https://key@host/1?x=/2` 与 `/1#/2` 的 SDK 项目 ID 是 **2**(不是 1),
//     `#/2` 更让 fragment 吞掉 API 路径(基端点 `https://host/1#/api/2/envelope/`)。
//
// 所以这里逐字镜像 SDK:authority 结束于第一个 '/'、'?' 或 '#'(与 url.Parse 同),
// 只有首个分隔符就是 '/' 时 SDK 的正则才匹配得上(否则 undefined,返回空串由调用方
// 按"项目 ID 非法"拒绝)。
//
// 行终止符截断:`(.+)` 里的 `.` **不匹配** \n、\r、U+2028、U+2029,首个行终止符之后
// 的字符对 SDK 完全不可见(既不进项目 ID 也不进 path)。ASCII 的 \n/\r 早在上面被
// hasControlByte 拦下,真正会走到这里的是 U+2028/U+2029 —— 不截断就会算出与客户端
// 不同的项目 ID(实测 `https://key@host/1\u2028/2`:SDK 记项目 1、旧实现记 2)。
func errorReportingDSNRemainder(raw string) string {
	rest := raw
	if i := strings.Index(rest, "://"); i >= 0 {
		rest = rest[i+3:]
	}
	i := strings.IndexAny(rest, "/?#")
	if i < 0 || rest[i] != '/' {
		return ""
	}
	remainder := rest[i+1:]
	if j := strings.IndexAny(remainder, "\n\r\u2028\u2029"); j >= 0 {
		remainder = remainder[:j]
	}
	return remainder
}

// hasControlByte 报告 s 里是否含 ASCII 控制字符(0x00-0x1F 与 0x7F)。
//
// S10-2 修复轮 3(2026-09-17):与 webadmin `dsn.ts` 的 hasControlByte 同口径。
// Go 的 `url.Parse` 漏掉 fragment 里的控制字符(先切 '#' 再查 CTL),不能只靠它。
func hasControlByte(s string) bool {
	for i := 0; i < len(s); i++ {
		if b := s[i]; b < 0x20 || b == 0x7f {
			return true
		}
	}
	return false
}

// sdkParseableErrorReportingDSNUserinfo 报告 userinfo 是否是客户端 SDK 能解析的形状。
//
// S10-2 修复轮 2(2026-09-17):@sentry/utils 的 DSN_REGEX 里 userinfo 组是
// `(?:(\w+)(?::(\w+)?)?@)`(`\w` = [A-Za-z0-9_],ASCII-only):
//   - 公钥必须 `\w+`:`my-key` / `key.secret` / `ke%79`(SDK 不解码)全部失配;
//   - 私钥可缺省;写了必须是 `\w*`(`key:sec-ret` 失配,`key:@host` 合法);
//   - userinfo 里多一个 '@' 也失配(正则的 `\w` 不含 '@')。
//
// 入参是 DSN 原文里的 userinfo 段(未解码)。
func sdkParseableErrorReportingDSNUserinfo(userinfo string) bool {
	publicKey, secret, hasSecret := strings.Cut(userinfo, ":")
	if publicKey == "" || !isSDKWord(publicKey) {
		return false
	}
	return !hasSecret || isSDKWord(secret)
}

// isSDKWord 报告 value 的每个字符是否都在 JS 正则的 `\w`([A-Za-z0-9_])里。
// 空串也算(调用方自行决定是否要求非空)。
func isSDKWord(value string) bool {
	for _, r := range value {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_':
		default:
			return false
		}
	}
	return true
}

// sdkParseableErrorReportingDSNHost 报告主机名是否是客户端 SDK 能解析的形态。
//
// S10-2(2026-09-17):@sentry/utils 的 DSN_REGEX 里 host 组是 `[\w.-]+`(ASCII-only),
// 因此:
//   - 含冒号 = IPv6 字面量,SDK 不接受;
//   - 非 ASCII 码位(IDN 中文域名、全角字母/全角点)同样解析不了 —— 要部署中文
//     域名请先转成 punycode(`xn--…`)形态再填,那种写法 SDK 能解析(语料有用例)。
//
// host 已由 normalizeErrorReportingDSNHost 小写化,这里只做字符集判定。
func sdkParseableErrorReportingDSNHost(host string) bool {
	if host == "" || strings.Contains(host, ":") {
		return false
	}
	for _, r := range host {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
		default:
			return false
		}
	}
	return true
}

// errorReportingStoreEndpoint 由协议/主机/端口/路径前缀/项目 ID 拼出 ingest 端点。
//
// S10-3(2026-09-17):字面 IPv6 主机的方括号必须补回 —— `u.Hostname()` 会剥掉
// 它们(Go 文档明确写了),直接拼接得到 `https://2001:db8::1/api/1/store/`,连
// Go 自己的 `http.NewRequest` 都报 `invalid port ":db8::1" after host`,
// "发送测试事件"永远走不到出站、回显给管理员的 endpoint 也是坏 URL。
// 判定仍用裸主机名,只有拼 URL 时按需补方括号。
//
// S10-2 修复轮 2(2026-09-17):prefix 由 `splitErrorReportingDSNRemainder` 从**原文剩余**
// 切出(不再来自解码后的 `u.Path`),所以 `/%2e%2e/1` 得到 `/%2e%2e/api/1/store/`
// —— 与客户端 SDK 的 `getBaseApiEndpoint`(path 取自原始串)一致,也不会把 `../`
// 交给 HTTP 客户端去规范化。修复轮 3 起 prefix 与 SDK 的 `path` 逐字相同;修复轮 5
// 起含 `?`/`#` 的 prefix 在 split 阶段就被拒(那类串的 envelope 路径会被查询串/
// 锚点截断,见 errErrorReportingDSNProjectQuery),这里拼出的端点总能被路由到。
func errorReportingStoreEndpoint(scheme, host, port, prefix, projectID string) string {
	if ip := net.ParseIP(host); ip != nil && strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	portPart := ""
	if port != "" {
		portPart = ":" + port
	}
	if prefix != "" {
		prefix = "/" + prefix
	}
	return fmt.Sprintf("%s://%s%s%s/api/%s/store/", scheme, host, portPart, prefix, projectID)
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
// 字符限 `a-z0-9-_` 与**非 ASCII 码位**。
//
// 2026-09-17(S10-2):非 ASCII 码位在这里仍然放行 —— 它们由
// sdkParseableErrorReportingDSNHost 统一拒成"SDK 解析不了 IDN/IPv6"的专用文案
// (比泛化的"不是合法的域名或 IP 地址"更能说明为什么不工作);中文域名的合法
// 部署方式是 punycode(`xn--…`)形态。
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

// splitErrorReportingDSNRemainder 取剩余串的最后一段作为项目 ID,并返回其余路径前缀。
//
// S10-2 修复轮 3(2026-09-17,r3v 复核)把入参从「'?'/'#' 之前的原文路径」放宽成
// `errorReportingDSNRemainder` 的**全部剩余**(query 与 fragment 在内),因为
// @sentry/utils 的 dsnFromString 做的正是:
//
//	const split = lastPath.split('/')            // lastPath = `(.+)` 捕获的整段
//	if (split.length > 1) { path = split.slice(0, -1).join('/'); projectId = split.pop() }
//	projectId.match(/^\d+/)                      // 只截前导数字
//	validateDsn: 非空 + /^\d+$/                  // 截完还不是纯数字 ⇒ undefined
//
// 逐条对应的既有规则(修复轮 2 定稿,这里只把"取哪一段"换成 SDK 的那一段):
//   - `/%31`   原文段 `%31` 没有前导数字 ⇒ 拒(SDK 同;此前用解码后的 `/1` 放行);
//   - `/+1`    原文段 `+1` 没有前导数字 ⇒ 拒(SDK 同;此前 `strconv.Atoi` 收正号);
//   - `/1%2F2` 前导数字 `1` ⇒ 收,项目 ID 记 `1`(SDK 同;此前 Go 解码成 `/1/2` 记 2);
//   - `/1abc`、`/1<U+FEFF>` 前导数字 `1` ⇒ 收(SDK 同,SDK 会截成项目 1);
//   - `/1/`    末段是空串 ⇒ 拒(SDK 的 `split.pop()` 得到 `""`,validateDsn 判
//     "projectId missing" ⇒ undefined;手工粘贴的常见形态)。
//
// 前缀同样保持**原文**且**逐字等于 SDK 的 path**(见 errorReportingStoreEndpoint),
// 但**不允许含 `?`/`#`**(修复轮 5):那种前缀会让 SDK 拼出的 envelope URL 被
// 客户端 HTTP 栈截断(见 errErrorReportingDSNProjectQuery)。
//
// 前导数字仍限制在 int64 且 > 0(策略上限,与 2048 字节上限同类):SDK 的
// `validateDsn` 对项目 ID 只要求 `^\d+$` 没有上限,但 22 位以上的项目 ID 只可能
// 是误粘贴 —— 两侧都拒,并由语料冻结。
func splitErrorReportingDSNRemainder(remainder string) (projectID string, prefix string, err error) {
	// 与 `lastPath.split('/')` 逐字同构:Go 的 Split("", "/") 也返回 [""],
	// 所以空剩余(如 `https://key@host/`)自然落到"末段是空串 ⇒ 拒"。
	segments := strings.Split(remainder, "/")
	segment := segments[len(segments)-1]
	if len(segments) > 1 {
		// slice(0, -1).join('/') —— 前导/中间的连续 '/' 产生的空段必须保留
		// (`https://key@host///1` 的 SDK path 是 `//`,端点 `https://host///api/1/envelope/`)。
		prefix = strings.Join(segments[:len(segments)-1], "/")
	}
	// S10-2 修复轮 5(2026-09-17,r4v 复核):`?`/`#` 落在路径前缀里 ⇒ 拒。
	//
	// 等价判据:首个 `?`/`#` 出现在**最后一个 '/' 之前**(它才会进 prefix;
	// 若在最后一个 '/' 之后,它就是项目 ID 段的一部分,不影响出站路径)。
	// 这一类此前被 SDK 可解析性放行 —— makeDsn 确实能成功,但 @sentry/node 的
	// transport 对新 URL 取 `pathname+search` 发请求,pathname 里已经不含
	// `/api/<项目ID>/envelope/`,`sentry_key` 也一并被吞(详见
	// ErrorReportingDSNProjectQueryMessage)。判定放在前导数字之前:整族
	// (`1?x=http://y`、`1?a=b/c`、`1#/a`、`1?x=/2`、`1#/2`)的根因都是这一条,
	// 统一给出"删掉 ? / # 及其后的内容"的可操作文案。
	if strings.ContainsAny(prefix, "?#") {
		return "", "", errErrorReportingDSNProjectQuery
	}
	digits := leadingASCIIDigits(segment)
	if digits == "" {
		return "", "", errors.New("project id must start with digits")
	}
	n, convErr := strconv.ParseInt(digits, 10, 64)
	if convErr != nil || n <= 0 {
		return "", "", errors.New("project id must be a positive integer")
	}
	return digits, prefix, nil
}

// errErrorReportingDSNProjectQuery 报告 `?`/`#` 落在项目 ID 段之前的路径前缀里。
//
// 2026-09-17(S10-2 修复轮 5,r4v 复核):修复轮 3 放宽成"SDK 能解析就收"时,
// 有 1,310 个新接受的输入在**实际投递**上不可用(`new URL(envelopeEndpoint)`
// 的 pathname 丢掉 `/api/<项目ID>/envelope/`)。接受面因此必须再收紧一条:
// 不只是"SDK 解析得了",还要"SDK 真发得出去"。r4v 的判据
// 「prefix 含 `?`/`#` ⟺ 不可投递」在 3,033/3,033 条已接受行上零反例。
var errErrorReportingDSNProjectQuery = errors.New("query or fragment precedes the project segment")

// leadingASCIIDigits 返回 value 的前导 ASCII 数字(`projectId.match(/^\d+/)` 的
// Go 版;SDK 的 `\d` 在非 unicode 模式下就是 [0-9],全角数字不算)。
func leadingASCIIDigits(value string) string {
	end := 0
	for end < len(value) && value[end] >= '0' && value[end] <= '9' {
		end++
	}
	return value[:end]
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
