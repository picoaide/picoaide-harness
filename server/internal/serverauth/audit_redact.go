package serverauth

// 审计读侧的按查看者脱敏(三轮残留①,2026-09-13)。
//
// 背景:≤v2.7.2-beta.7 的 reports handler 把订阅名称 + **明文 hook_url** 一起
// 写进 audit_logs.detail(0048 起是哈希链)。凭据本体进了不可变的历史行,
// 而 audit:read 是 auditor(只读角色)持有的权限 —— 收紧写入侧(report:read)
// 挡不住**已经写下的**历史行。
//
// 历史行不能改写:detail 参与哈希链(serverstore.auditHashPayload),任何
// UPDATE 都会让 VerifyAuditChain 在保留边界处报断链。因此唯一可行的口径是
// **读时脱敏**:由 /audit 的唯一读出口按查看者权限决定 detail 形状。
//
// 判据(与 reports 的 report:read 口径同源):
//   - 查看者持 report:read(super_admin)⇒ 读到审计原文(可追溯性不牺牲);
//   - 不具备 ⇒ detail 里的凭据型 URL 折叠成 scheme://host/…(已脱敏)。
//
// 「凭据型 URL」的判定刻意取**宽**:report_subscription_* 动作里的一切 URL
// (历史行的形态就是「名称 + URL」),以及任何带凭据型查询参数/userinfo/
// webhook 路径的 URL。宁可多折一个无关地址,也不放过一个 key=…。
//
// 2026-09-13 N7(第三轮独立复核 §4.2,P3):扫描原先只认小写 `http://` /
// `https://` 字面量,于是 `HTTPS://…?key=`(大小写)、`//host/…?key=`
// (协议相对)、`https%3A%2F%2F…%3Fkey%3D`(百分号编码)三种形态**根本不被
// 定位**,动作前缀规则(report_subscription*)也就永不触发。现在:
//   - scheme 定位大小写不敏感,且接受任意 scheme(`wss://` 也要能看见);
//   - 协议相对 `//host/…` 纳入定位(前后文边界判据见 auditSchemeCandidate);
//   - 百分号编码形态按**解码后**的语义分类,折叠时保留解码出的 scheme://host;
//   - report_subscription_* 动作对定位到的任何 URL(含自定义路径、无凭据
//     标记)无条件整体折叠。
// 当前写入侧不可达(报表订阅只接受小写 http(s) 前缀),属预防性收口。

import (
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// auditSensitiveQueryParams 视为凭据的查询参数名(小写)。
// 覆盖钉钉/企微/飞书/Slack/通用机器人地址的常见形态。
var auditSensitiveQueryParams = map[string]bool{
	"key": true, "access_token": true, "token": true, "secret": true,
	"client_secret": true, "api_key": true, "apikey": true, "auth": true,
	"sign": true, "signature": true, "sig": true, "ticket": true,
	"password": true, "passwd": true, "pwd": true, "code": true,
	"hook_token": true, "webhook": true,
}

// auditWebhookPathMarkers 凭据藏在**路径**里的 webhook 形态(飞书 /bot/v2/hook/<uuid>)。
var auditWebhookPathMarkers = []string{
	"/webhook", "/robot/send", "/bot/v2/hook", "/hooks/", "/services/",
}

// auditRedactedSuffix 脱敏后的尾巴(保留 scheme+host,便于审计定位来源)。
const auditRedactedSuffix = "/…（已脱敏）"

// auditRedactedPlaceholder 连 scheme://host 都取不到时的整段占位符。
const auditRedactedPlaceholder = "（地址已脱敏）"

// auditSchemeCandidateRe 定位一个 URL 的**起点**,大小写不敏感:
//
//	<scheme>://        https://、HTTPS://、wss:// …
//	<scheme>%3a%2f%2f  https%3A%2F%2F(百分号编码的 scheme 与斜杠)
//	<scheme>:%2f%2f
//
// scheme 语法按 RFC 3986(`ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`)。
// `(?i)` 同时让 `%3a`/`%3A` 与 `%2f`/`%2F` 等价。
var auditSchemeCandidateRe = regexp.MustCompile(`(?i)[a-z][a-z0-9+.\-]*(?:%3a|:)(?:%2f|/){2}`)

// auditTokenTerminators 结束一个 URL token 的字符(空白/引号/尖括号/中文标点)。
// 与 splitAuditToken 同源。
func auditTokenTerminator(r rune) bool {
	switch r {
	case ' ', '\t', '\n', '\r', '"', '\'', '<', '>',
		'）', '」', '】', '，', '。', '、':
		return true
	}
	return false
}

// auditProtocolRelativeStarts 判定 s[i:] 是否是一个协议相对 URL(`//host/…`)的
// **起点**:前一个字符必须是"token 边界"(行首/空白/引号/括号/等号/冒号/中文
// 标点),否则 `https://` 里的 `//`、`a//b` 里的 `//` 都会被误当成起点。
func auditProtocolRelativeStarts(s string, i int) bool {
	if i+2 >= len(s) {
		return false
	}
	if r, _ := utf8.DecodeRuneInString(s[i+2:]); auditTokenTerminator(r) {
		return false // `//` 后面直接是分隔符 ⇒ 没有主机名
	}
	if i == 0 {
		return true
	}
	prev, size := utf8.DecodeLastRuneInString(s[:i])
	if size == 0 {
		return true
	}
	switch prev {
	case ' ', '\t', '\n', '\r', '"', '\'', '<', '>', '(', ')', '[', ']', '{', '}',
		'=', ',', ';', ':', '|',
		'（', '）', '「', '」', '【', '】', '，', '。', '、', '：', '；':
		return true
	}
	return false
}

// nextAuditURLCandidate 在 s 中找出最早出现的 URL 起点(下标),没有则 -1。
// 两种起点取更早者:带 scheme 的(含百分号编码形态)与协议相对形态。
func nextAuditURLCandidate(s string) int {
	best := -1
	if loc := auditSchemeCandidateRe.FindStringIndex(s); loc != nil {
		best = loc[0]
	}
	for i := 0; ; {
		j := strings.Index(s[i:], "//")
		if j < 0 {
			break
		}
		at := i + j
		if auditProtocolRelativeStarts(s, at) {
			// `//` 是按下标递增扫的,第一个合法起点就是最早的协议相对起点。
			if best < 0 || at < best {
				best = at
			}
			break
		}
		i = at + 2
	}
	return best
}

// RedactAuditDetailForViewer 按查看者是否持 report:read 决定 detail 形状。
// canReadReport=true 时逐字节原样返回(含历史明文,供具备权限者追溯)。
func RedactAuditDetailForViewer(detail, action string, canReadReport bool) string {
	if canReadReport || detail == "" {
		return detail
	}
	reportAction := strings.HasPrefix(action, "report_subscription")
	var b strings.Builder
	rest := detail
	for len(rest) > 0 {
		i := nextAuditURLCandidate(rest)
		if i < 0 {
			b.WriteString(rest)
			return b.String()
		}
		b.WriteString(rest[:i])
		raw, tail := splitAuditToken(rest[i:])
		if auditURLNeedsRedaction(raw, reportAction) {
			b.WriteString(redactAuditURL(raw))
		} else {
			b.WriteString(raw)
		}
		rest = tail
	}
	return b.String()
}

// splitAuditToken 从 s(以 URL 起点开头)切出 URL 本体与剩余文本。
// URL 以空白/引号/尖括号/中文标点结束。
func splitAuditToken(s string) (raw, tail string) {
	end := len(s)
	for i, r := range s {
		if auditTokenTerminator(r) {
			end = i
			break
		}
	}
	return s[:end], s[end:]
}

// auditURLNeedsRedaction 判断一个 URL 是否属于「凭据型」。
// reportAction=true(report_subscription_*)时任何 URL 都算。
func auditURLNeedsRedaction(raw string, reportAction bool) bool {
	// ① 报表订阅动作:历史行 detail 的形态就是「名称 + 明文 hook_url」。
	if reportAction {
		return true
	}
	// ② 协议相对 `//host/…`:按同一条分类规则判定(剥掉 `//` 后就是 authority+path)。
	target := raw
	if strings.HasPrefix(target, "//") {
		target = target[2:]
	}
	// ③ 百分号编码形态:分类按**解码后**的文本(折叠输出见 redactAuditURL)。
	if decoded := auditPercentDecode(target); decoded != target {
		target = decoded
	}
	// ④ userinfo(user:pass@host)。
	authority := target
	if i := strings.Index(authority, "://"); i >= 0 {
		authority = authority[i+3:]
	}
	if k := strings.IndexAny(authority, "/?#"); k >= 0 {
		authority = authority[:k]
	}
	if strings.Contains(authority, "@") {
		return true
	}
	// ⑤ 凭据型查询参数(参数名大小写不敏感)。片段(`#key=…`)同口径:浏览器
	//    不会把片段发给服务端,但审计 detail 里的 `#key=SECRET` 一样是凭据本体。
	for _, sep := range []byte{'?', '#'} {
		i := strings.IndexByte(target, sep)
		if i < 0 {
			continue
		}
		q := target[i+1:]
		if k := strings.IndexByte(q, '#'); k >= 0 {
			q = q[:k]
		}
		for _, kv := range strings.Split(q, "&") {
			name := strings.ToLower(strings.SplitN(kv, "=", 2)[0])
			if auditSensitiveQueryParams[name] {
				return true
			}
		}
	}
	// ⑥ webhook 路径形态。
	lower := strings.ToLower(target)
	for _, marker := range auditWebhookPathMarkers {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

// redactAuditURL 保留 scheme://host(去掉 userinfo),其余折成固定尾巴。
// 解析不出来(极端形态/百分号编码/协议相对取不到主机)时整体折成占位符,
// 绝不原样返回。
func redactAuditURL(raw string) string {
	// 协议相对:保留 `//host` 形状。
	if strings.HasPrefix(raw, "//") {
		return "//" + auditRedactedHost(raw[2:])
	}
	// 百分号编码(整串没有 `://` 字面量):用解码后的形态折叠,保留 scheme://host。
	if !strings.Contains(raw, "://") {
		if decoded := auditPercentDecode(raw); strings.Contains(decoded, "://") {
			if folded, ok := auditFoldDecodedURL(decoded); ok {
				return folded
			}
		}
		return auditRedactedPlaceholder
	}
	i := strings.Index(raw, "://")
	authority := raw[i+3:]
	if at := strings.IndexByte(authority, '@'); at >= 0 {
		authority = authority[at+1:] // userinfo 本身也是凭据,整段丢弃
	}
	hostEnd := len(authority)
	for k := 0; k < len(authority); k++ {
		if authority[k] == '/' || authority[k] == '?' || authority[k] == '#' {
			hostEnd = k
			break
		}
	}
	if hostEnd == 0 { // 只有 scheme:// 没有主机名
		return auditRedactedPlaceholder
	}
	return raw[:i+3] + authority[:hostEnd] + auditRedactedSuffix
}

// auditRedactedHost 从"authority+path"里取主机段并折叠。
func auditRedactedHost(authorityAndPath string) string {
	authority := authorityAndPath
	if at := strings.IndexByte(authority, '@'); at >= 0 {
		authority = authority[at+1:]
	}
	hostEnd := len(authority)
	for k := 0; k < len(authority); k++ {
		if authority[k] == '/' || authority[k] == '?' || authority[k] == '#' {
			hostEnd = k
			break
		}
	}
	if hostEnd == 0 {
		return auditRedactedPlaceholder
	}
	return authority[:hostEnd] + auditRedactedSuffix
}

// auditFoldDecodedURL 折叠一个解码出来的 URL(只保留 scheme://host)。
// 解码结果可能含控制字符(百分号编码可以编出任意字节),所以 scheme/host
// 段必须先过白名单 —— 脱敏输出是审计界面直接渲染的文本,不接受控制字符。
func auditFoldDecodedURL(decoded string) (string, bool) {
	i := strings.Index(decoded, "://")
	if i <= 0 {
		return "", false
	}
	scheme := decoded[:i]
	for k := 0; k < len(scheme); k++ {
		c := scheme[k]
		ok := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' ||
			(k > 0 && (c >= '0' && c <= '9' || c == '+' || c == '-' || c == '.'))
		if !ok {
			return "", false
		}
	}
	authority := decoded[i+3:]
	if at := strings.IndexByte(authority, '@'); at >= 0 {
		authority = authority[at+1:]
	}
	host := authority
	if k := strings.IndexAny(host, "/?#"); k >= 0 {
		host = host[:k]
	}
	if host == "" {
		return "", false
	}
	for k := 0; k < len(host); k++ {
		if host[k] <= 0x20 || host[k] == 0x7F {
			return "", false
		}
	}
	return scheme + "://" + host + auditRedactedSuffix, true
}

// auditPercentDecode 解码 %XX(非法序列原样保留),用于分类与折叠。
// 不解码 `+`(URL 路径/查询里 `+` 不是空格的合法编码)。
func auditPercentDecode(s string) string {
	if !strings.ContainsRune(s, '%') {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			hi, okHi := auditHexNibble(s[i+1])
			lo, okLo := auditHexNibble(s[i+2])
			if okHi && okLo {
				b.WriteByte(hi<<4 | lo)
				i += 2
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

func auditHexNibble(c byte) (byte, bool) {
	switch {
	case c >= '0' && c <= '9':
		return c - '0', true
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10, true
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10, true
	}
	return 0, false
}

// redactAuditEntryDetails 就地脱敏一页审计条目(读侧,不改库)。
func redactAuditEntryDetails(logs []serverstore.AuditLogEntry, canReadReport bool) {
	if canReadReport {
		return
	}
	for i := range logs {
		logs[i].Detail = RedactAuditDetailForViewer(logs[i].Detail, logs[i].Action, false)
	}
}
