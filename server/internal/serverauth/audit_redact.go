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
//   - 不具备 ⇒ detail 里的凭据型 URL 折叠成 scheme://host/…（已脱敏）。
//
// 「凭据型 URL」的判定刻意取**宽**:report_subscription_* 动作里的一切 URL
// (历史行的形态就是「名称 + URL」),以及任何带凭据型查询参数/userinfo/
// webhook 路径的 URL。宁可多折一个无关地址,也不放过一个 key=…。

import (
	"strings"

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

// RedactAuditDetailForViewer 按查看者是否持 report:read 决定 detail 形状。
// canReadReport=true 时逐字节原样返回(含历史明文,供具备权限者追溯)。
func RedactAuditDetailForViewer(detail, action string, canReadReport bool) string {
	if canReadReport || detail == "" {
		return detail
	}
	var b strings.Builder
	rest := detail
	for {
		i := strings.Index(rest, "http://")
		j := strings.Index(rest, "https://")
		switch {
		case i < 0 && j < 0:
			b.WriteString(rest)
			return b.String()
		case i < 0 || (j >= 0 && j < i):
			i = j
		}
		b.WriteString(rest[:i])
		raw, tail := splitAuditURL(rest[i:])
		if auditURLNeedsRedaction(raw, action) {
			b.WriteString(redactAuditURL(raw))
		} else {
			b.WriteString(raw)
		}
		rest = tail
	}
}

// splitAuditURL 从 s(以 scheme 开头)切出 URL 本体与剩余文本。
// URL 以空白/引号/尖括号/中文标点结束。
func splitAuditURL(s string) (raw, tail string) {
	end := len(s)
	for i, r := range s {
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '"' || r == '\'' ||
			r == '<' || r == '>' || r == '）' || r == '」' || r == '】' || r == '，' || r == '。' || r == '、' {
			end = i
			break
		}
	}
	return s[:end], s[end:]
}

// auditURLNeedsRedaction 判断一个 URL 是否属于「凭据型」。
func auditURLNeedsRedaction(raw, action string) bool {
	// ① 报表订阅动作:历史行 detail 的形态就是「名称 + 明文 hook_url」。
	if strings.HasPrefix(action, "report_subscription") {
		return true
	}
	// ② userinfo(user:pass@host)。
	authority := raw
	if i := strings.Index(authority, "://"); i >= 0 {
		authority = authority[i+3:]
	}
	if k := strings.IndexAny(authority, "/?#"); k >= 0 {
		authority = authority[:k]
	}
	if strings.Contains(authority, "@") {
		return true
	}
	// ③ 凭据型查询参数。
	if i := strings.Index(raw, "?"); i >= 0 {
		q := raw[i+1:]
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
	// ④ webhook 路径形态。
	lower := strings.ToLower(raw)
	for _, marker := range auditWebhookPathMarkers {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

// redactAuditURL 保留 scheme://host(去掉 userinfo),其余折成固定尾巴。
// 解析不出来(极端形态)时整体折成占位符,绝不原样返回。
func redactAuditURL(raw string) string {
	i := strings.Index(raw, "://")
	if i < 0 {
		return "（地址已脱敏）"
	}
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
		return "（地址已脱敏）"
	}
	return raw[:i+3] + authority[:hostEnd] + auditRedactedSuffix
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
