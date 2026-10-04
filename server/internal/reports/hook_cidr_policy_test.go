package reports

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// 2026-10-04 审计(v2.8.1 → HEAD,C3-07 的同族补集):月报 webhook 的 SSRF 名单
// `blockedHookCIDRs` 比连接器侧那张表(server/internal/serverstore/connectors.go
// 的 connectorBlockedNetworks)**更早、更宽** —— 少了 NAT64 `64:ff9b::/96`、
// discard `100::/64`、文档段 `2001:db8::/32`(连接器表 2026-09-13 就补了),
// 以及 C3-07 新补的四个:6to4 `2002::/16`、Teredo `2001::/32`、
// local-use NAT64 `64:ff9b:1::/48`、弃用站点本地 `fec0::/10`。
//
// 这不是"只用于日志/提示"的名单(判定依据,不是猜测):
//   - `validateHookURL`(:231)在建单与每次推送前调用,返回 error 即不发请求
//     (PushWebhook :338 在 `pushClient.Do` 之前);
//   - `pushClient` 的 Transport(:104-111)把 `DialContext` 换成
//     `safeHookDialContext`(:193,按解析出的 IP 逐条复检)、把 `Proxy` 换成
//     `safeHookProxyFromEnvironment`(:124,在选定代理**之前**复检真正的目标);
//   - `checkHookTargetAllowed`(:138)是代理路径上的同一套判定。
//
// 所以这三个判据都打在真实拦截面上:`hookHostAllowed`(唯一判定)、
// `validateHookURL`(建单/推送入口)、`checkHookTargetAllowed`(代理路径入口)。

// hookCIDRCase 一行语料:一个必须被拒的前缀 + 该前缀里一个代表性地址。
// 地址不是随手的字符串 —— 用例先自检"它确实落在声明的网段里",否则这段语料
// 可能因为某个地址被别的规则(IsPrivate/IsLoopback)拒掉而变成空判据。
type hookCIDRCase struct {
	cidr    string
	address string
	why     string
}

// hookTransitionCorpus 是本次补齐的 7 条(全部来自连接器侧口径)。
var hookTransitionCorpus = []hookCIDRCase{
	{"2001::/32", "2001::1", "Teredo(RFC 4380;地址位域里藏着服务端/客户端 IPv4)"},
	{"2002::/16", "2002:7f00:1::", "6to4(RFC 3056;这段恰好指着 127.0.0.1)"},
	{"64:ff9b::/96", "64:ff9b::a00:1", "NAT64(RFC 6052;这段指着 10.0.0.1)"},
	{"64:ff9b:1::/48", "64:ff9b:1::1", "local-use NAT64(RFC 8215)"},
	{"100::/64", "100::1", "丢弃前缀(RFC 6666)"},
	{"2001:db8::/32", "2001:db8::1", "文档段(RFC 3849;不承载真实服务)"},
	{"fec0::/10", "fec0::1", "站点本地(RFC 3879 弃用;fc00::/7 的定址祖先)"},
}

// TestHookBlockedCIDRsRefuseTransitionAndDocumentationTargets:补齐的每一条都必须
// 在**所有三个** webhook 出站入口上被拒。
func TestHookBlockedCIDRsRefuseTransitionAndDocumentationTargets(t *testing.T) {
	for _, c := range hookTransitionCorpus {
		_, network, err := net.ParseCIDR(c.cidr)
		if err != nil {
			t.Fatalf("语料网段 %q 解析失败: %v", c.cidr, err)
		}
		ip := net.ParseIP(c.address)
		if ip == nil {
			t.Fatalf("语料地址 %q 不是合法 IP", c.address)
		}
		if !network.Contains(ip) {
			t.Fatalf("语料自检失败: %s 不在 %s 内(%s)—— 这条语料证明不了该网段被覆盖", c.address, c.cidr, c.why)
		}
		if hookHostAllowed(ip) {
			t.Errorf("hookHostAllowed(%s) = true, want false(%s 在 %s 内;webhook 名单缺这一段)",
				c.address, c.why, c.cidr)
		}
		raw := "http://[" + c.address + "]/hook"
		if err := validateHookURL(raw); err == nil {
			t.Errorf("validateHookURL(%q) = nil, want error(%s;建单/推送入口放行了 %s)",
				raw, c.why, c.cidr)
		}
		if err := checkHookTargetAllowed(context.Background(), c.address); err == nil {
			t.Errorf("checkHookTargetAllowed(%q) = nil, want error(%s;代理路径入口放行了 %s)",
				c.address, c.why, c.cidr)
		}
	}
}

// TestHookBlockedCIDRsStillAllowPublicTargets:反向对照 —— 补齐不能把公网目标一起
// 打死(用字面量,不依赖测试机的 DNS/fake-IP)。
func TestHookBlockedCIDRsStillAllowPublicTargets(t *testing.T) {
	for _, raw := range []string{
		"https://1.1.1.1/hook",
		"https://8.8.8.8:8443/hook",
		"https://[2606:4700:4700::1111]/hook",
		"https://[2001:4860:4860::8888]/hook", // 2001::/16 里但在 Teredo 的 /32 之外
	} {
		if err := validateHookURL(raw); err != nil {
			t.Errorf("validateHookURL(%q) = %v, want nil(公网目标被误拒)", raw, err)
		}
	}
	for _, host := range []string{"1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"} {
		if err := checkHookTargetAllowed(context.Background(), host); err != nil {
			t.Errorf("checkHookTargetAllowed(%q) = %v, want nil(公网目标被误拒)", host, err)
		}
	}
	if !hookHostAllowed(net.ParseIP("2001:4860:4860::8888")) {
		t.Error("hookHostAllowed(2001:4860:4860::8888) = false, want true(2001::/32 之外的公网地址被误杀)")
	}
}

// TestHookBlockedCIDRCoversConnectorBlockedNetworks:防漂移守卫 —— webhook 名单必须
// **覆盖**连接器侧镜像表(server/internal/serverstore/connectors.go 的
// connectorBlockedNetworks)。方向是单向的、也是安全上唯一站得住的方向:webhook
// 目标只允许公网(回环也拒),连接器策略额外允许"回环 http"(本地开发),所以
// 「连接器拒的 ⇒ webhook 也拒」必须成立;反向不成立(127/8、::1 只在 webhook 表里)。
//
// 扫描面取自真实源文件(与 serverstore 侧解析 outbound.ts 的守卫同一形态):
// 解析不到/条目数缩水一律 fail-loud,不得静默通过 —— 这条 finding 的成因正是
// 「两张表各写一份、没人对拍」。
func TestHookBlockedCIDRCoversConnectorBlockedNetworks(t *testing.T) {
	connector := hookReadConnectorBlockedNetworks(t)
	hook := make(map[string]struct{}, len(blockedHookCIDRs))
	for _, n := range blockedHookCIDRs {
		hook[n.String()] = struct{}{}
	}
	if len(blockedHookCIDRs) != len(blockedHookCIDRList) {
		t.Fatalf("webhook 名单解析条数 = %d,声明 = %d —— 有网段被静默丢弃(防护无声消失)",
			len(blockedHookCIDRs), len(blockedHookCIDRList))
	}
	for _, c := range connector {
		_, network, err := net.ParseCIDR(c)
		if err != nil {
			t.Fatalf("连接器侧网段 %q 解析失败: %v", c, err)
		}
		if _, ok := hook[network.String()]; !ok {
			t.Errorf("webhook SSRF 名单缺 %s(连接器侧 connectorBlockedNetworks 已有):"+
				"两侧必须同族口径,否则同一个地址「连接器拒绝、月报 webhook 放行」", c)
		}
	}
}

// hookReadConnectorBlockedNetworks 从连接器侧 Go 镜像表里读出段清单。
func hookReadConnectorBlockedNetworks(t *testing.T) []string {
	t.Helper()
	path := filepath.Join("..", "serverstore", "connectors.go")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取连接器侧镜像表失败(%s): %v —— 扫描面取不到时必须失败", path, err)
	}
	const marker = "connectorBlockedNetworks = []string{"
	text := string(raw)
	start := strings.Index(text, marker)
	if start < 0 {
		t.Fatalf("%s 里找不到 %q —— 表改名/搬走时本判据必须失败而不是空跑", path, marker)
	}
	rest := text[start+len(marker):]
	end := strings.Index(rest, "\n\t}")
	if end < 0 {
		t.Fatalf("%s 的 %s 块找不到结束行", path, marker)
	}
	var out []string
	for _, m := range regexp.MustCompile(`"([^"]+)"`).FindAllStringSubmatch(rest[:end], -1) {
		if _, _, err := net.ParseCIDR(m[1]); err == nil {
			out = append(out, m[1])
		}
	}
	if len(out) < 20 {
		t.Fatalf("从 %s 只解析出 %d 条网段(应 ≥20 条)—— 扫描面缩水必须失败", path, len(out))
	}
	return out
}
