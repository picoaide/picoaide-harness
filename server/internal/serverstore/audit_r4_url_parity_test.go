package serverstore

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// N5(2026-09-13 第三轮独立复核 §3.3 / 清单 N5,P2):Go 侧 connectorURLAllowed /
// connectorBlockedIP 与客户端 packages/host/connectors/src/outbound.ts 的地址
// 分类不一致(56 条语料里 16 条差异)。
//
// 两个方向的后果:
//   - **服务端更宽**(CGNAT 100.64/10、0.0.0.0/8、192.0.0.0/24、文档段、
//     240/4、NAT64 64:ff9b::/96、100::/64、2001:db8::/32):管理端能保存,
//     客户端静默丢弃 → 「保存成功但连接器消失」;
//   - **服务端更宽 + 真绕过**:`https://[fe80::1%25eth0]/mcp` —— net.ParseIP
//     遇 `%zone` 返回 nil,于是链路本地 IPv6 退化成一枚「域名」被放行。
//
// 修法:以客户端为权威,把地址段分类**逐条镜像**到 Go(见
// connectorBlockedNetworks),并在判定前处理 zone-id。本文件是三件套回归:
//  1. 段清单防漂移(解析客户端源码,任一侧增删段 → 失败);
//  2. ≥56 条语料逐条对拍(客户端权威值 + 服务端期望值,差异必须已登记);
//  3. 真绕过用例(fe80 zone)、IPv4-mapped、保留段边界。

// r4URLCase 是语料的一行。
type r4URLCase struct {
	url string
	// client = 客户端 assertOutboundUrlAllowed 的判定(权威口径)。
	client bool
	// server = Go connectorURLAllowed 的期望判定。
	server bool
	// why 非空 = 已登记的「WHATWG 归一化差异」(服务端只允许更严)。
	why string
}

// r4URLCorpus:第三轮复核的 56 条基线语料 + 保留段边界 / 映射形态 / WHATWG
// 数字主机等追加语料。client 列来自真客户端代码(outbound.ts)运行结果。
var r4URLCorpus = []r4URLCase{
	{"https://example.com/mcp", true, true, ""},
	{"https://example.com./mcp", true, true, ""},
	{"http://example.com/mcp", false, false, ""},
	{"http://localhost:8080/mcp", true, true, ""},
	{"http://localhost.:8080/mcp", true, true, ""},
	{"https://localhost/mcp", true, true, ""},
	{"https://localhost./mcp", true, true, ""},
	{"https://metadata.google.internal/x", false, false, ""},
	{"https://metadata.google.internal./x", false, false, ""},
	{"https://METADATA.GOOGLE.INTERNAL./x", false, false, ""},
	{"https://metadata.google.internal../x", true, true, ""},
	{"https://metadata.google.internal:443/x", false, false, ""},
	{"https://instance-data/x", false, false, ""},
	{"https://instance-data./x", false, false, ""},
	{"https://instance-data.ec2.internal./x", false, false, ""},
	{"https://metadata.goog./x", false, false, ""},
	{"https://user:pass@example.com/x", false, false, ""},
	{"https://user@example.com/x", false, false, ""},
	{"https://user:pass@metadata.google.internal./x", false, false, ""},
	{"http://169.254.169.254/latest/meta-data", false, false, ""},
	{"https://169.254.169.254./x", false, false, ""},
	{"http://[::ffff:169.254.169.254]/x", false, false, ""},
	{"https://[::ffff:a9fe:a9fe]/x", false, false, ""},
	{"http://127.0.0.1:9000/mcp", true, true, ""},
	{"https://127.0.0.1/x", true, true, ""},
	{"https://127.0.0.1./x", true, true, ""},
	{"http://[::1]:9000/mcp", true, true, ""},
	{"https://[::ffff:127.0.0.1]/x", true, true, ""},
	// 真绕过:zone-id 形态的链路本地 IPv6(修复前 go=true)。
	{"https://[fe80::1%25eth0]/mcp", false, false, ""},
	{"https://[fe80::1%eth0]/mcp", false, false, ""},
	{"https://[fe80::1]/mcp", false, false, ""},
	{"https://10.0.0.5/mcp", false, false, ""},
	{"https://192.168.1.1/x", false, false, ""},
	{"https://172.16.0.1/x", false, false, ""},
	// WHATWG 把 0x7f.1 / 2130706433 / 0177.0.0.1 归一成 127.0.0.1(回环 ⇒ https 放行);
	// Go 的 isObfuscatedIPv4 一律拒绝 —— 服务端更严,登记为可接受差异。
	{"https://0x7f.1/x", true, false, "WHATWG 十六进制 IPv4 归一(0x7f.1→127.0.0.1),Go 侧一律拒绝伪装 IP"},
	{"https://2130706433/x", true, false, "WHATWG 十进制整数 IPv4 归一(→127.0.0.1),Go 侧一律拒绝伪装 IP"},
	{"https://0177.0.0.1/x", true, false, "WHATWG 八进制 IPv4 归一(→127.0.0.1),Go 侧一律拒绝伪装 IP"},
	{"https://0.0.0.0/x", false, false, ""},
	{"https://100.64.0.1/x", false, false, ""},
	{"https://[fc00::1]/x", false, false, ""},
	{"https://example.com:8443/x", true, true, ""},
	{"ftp://example.com/x", false, false, ""},
	{"file:///etc/passwd", false, false, ""},
	{"//example.com/x", false, false, ""},
	// WHATWG 把 https:///x 解析成 host=x(可用);Go 的 url.Parse 得到空 host ⇒ 拒绝。
	{"https:///x", true, false, "WHATWG 空 authority 解析(https:///x→host=x),Go url.Parse 得空 host ⇒ 拒绝"},
	{"https://example.com", true, true, ""},
	{"https://0.1.2.3/x", false, false, ""},
	{"https://192.0.0.1/x", false, false, ""},
	{"https://192.0.2.1/x", false, false, ""},
	{"https://198.18.0.1/x", false, false, ""},
	{"https://198.51.100.1/x", false, false, ""},
	{"https://203.0.113.1/x", false, false, ""},
	{"https://240.0.0.1/x", false, false, ""},
	{"https://224.0.0.1/x", false, false, ""},
	{"https://[64:ff9b::1]/x", false, false, ""},
	{"https://[100::1]/x", false, false, ""},
	{"https://[2001:db8::1]/x", false, false, ""},
	// ---- 追加:保留段边界 / 映射形态 / 根点 ----
	{"http://100.64.0.1:8080/mcp", false, false, ""},
	{"http://localhost.evil.com/mcp", false, false, ""},
	{"https://localhost.evil.com/mcp", true, true, ""},
	{"https://sub.localhost/mcp", true, true, ""},
	{"http://myhost.localhost:1234/mcp", true, true, ""},
	{"https://198.18.1.1/x", false, false, ""},
	{"https://198.19.255.255/x", false, false, ""},
	{"https://198.20.0.1/x", true, true, ""},
	{"https://[::ffff:10.0.0.1]/x", false, false, ""},
	{"https://[::]/x", false, false, ""},
	{"https://[ff02::1]/x", false, false, ""},
	{"https://[ff01::1]/x", false, false, ""},
	{"https://[::ffff:8.8.8.8]/x", true, true, ""},
	{"https://192.0.0.8/x", false, false, ""},
	{"https://192.0.1.1/x", true, true, ""},
	{"https://100.63.255.255/x", true, true, ""},
	{"https://100.128.0.1/x", true, true, ""},
	{"https://239.255.255.255/x", false, false, ""},
	{"https://255.255.255.255/x", false, false, ""},
	{"https://[64:ff9b::8.8.8.8]/x", false, false, ""},
	{"https://[2001:db8:1234::1]/x", false, false, ""},
	{"https://[2001:db9::1]/x", true, true, ""},
	{"https://169.254.0.1/x", false, false, ""},
	{"https://172.32.0.1/x", true, true, ""},
	{"https://172.15.255.255/x", true, true, ""},
	{"https://0.255.255.255/x", false, false, ""},
	{"https://[fe80::1%25]/x", false, false, ""},
	{"https://fb00::1/x", false, false, ""},
	{"https://[fd12:3456::1]/x", false, false, ""},
	{"https://[fe80:0:0:0:0:0:0:1]/x", false, false, ""},
	// 公网 IPv6(带/不带 zone):zone-id 在 WHATWG 里无法表达,两侧一致拒绝。
	{"https://[2606:4700::1111]/x", true, true, ""},
	{"https://[2606:4700::1111%25eth0]/x", false, false, ""},
	{"https://exa%25mple.com/x", false, false, ""},
	// WHATWG"以数字结尾 ⇒ 必须解析成 IPv4":客户端 new URL 抛错,Go 同口径拒绝。
	{"https://example.123/x", false, false, ""},
	{"https://1.2.3.4.5/x", false, false, ""},
	{"https://999.1.1.1/x", false, false, ""},
	{"https://123/x", false, false, ""},
	{"https://010.1.1.1/x", true, false, "WHATWG 八进制 IPv4 归一(010→8),Go 侧一律拒绝伪装 IP"},
	{"https://0x7f.1./x", true, false, "WHATWG 十六进制归一 + 根点归一(→127.0.0.1),Go 侧拒绝伪装 IP"},
	{"https://example.com123/x", true, true, ""},
	{"https://1.2.3.4:0/x", true, true, ""},
	{"http://[::1]/x", true, true, ""},
	{"https://0.0.0.0:443/x", false, false, ""},
	// scheme 大小写:WHATWG 与 Go url.Parse 都归一成小写,两侧一致。
	{"HTTPS://example.com/mcp", true, true, ""},
	{"HtTp://127.0.0.1:9000/mcp", true, true, ""},
	{"HTTP://example.com/mcp", false, false, ""},
	{"HTTPS://100.64.0.1/x", false, false, ""},
	{"HTTPS://169.254.169.254/x", false, false, ""},
	{"https://metadata/x", false, false, ""},
	{"http://metadata/x", false, false, ""},
	{"https://instance-data.ec2.internal/x", false, false, ""},
	{"https://[::1%25eth0]/x", false, false, ""},
	{"https://[::ffff:100.64.0.1]/x", false, false, ""},
	{"https://[::ffff:192.168.0.1]/x", false, false, ""},
	{"https://0.0.0.0./x", false, false, ""},
	{"http://100.64.0.1/x", false, false, ""},
	{"http://192.0.0.1/x", false, false, ""},
	{"https://2606:4700::1111/x", false, false, ""},
	{"https://fe80::1/x", false, false, ""},
	{"https://[fe80::1.]/x", false, false, ""},
}

// TestConnectorURLPolicyCorpus:逐条对拍。
func TestConnectorURLPolicyCorpus(t *testing.T) {
	if len(r4URLCorpus) < 56 {
		t.Fatalf("语料 = %d 条,要求 ≥56(第三轮复核基线 56 条)", len(r4URLCorpus))
	}
	diffs := 0
	for _, c := range r4URLCorpus {
		got := connectorURLAllowed(c.url)
		if got != c.server {
			t.Errorf("connectorURLAllowed(%q) = %v, want %v(client=%v why=%s)",
				c.url, got, c.server, c.client, c.why)
		}
		// 结构性不变量:服务端永远不得比客户端更宽(否则「保存成功但客户端丢弃」
		// 或真绕过);允许的差异只能是「服务端更严」且必须已登记 why。
		if c.client == false && c.server == true {
			t.Errorf("语料登记违反方向: %q 服务端比客户端更宽(client=false server=true)", c.url)
		}
		if c.server != c.client {
			if c.why == "" {
				t.Errorf("未登记的差异: %q client=%v server=%v", c.url, c.client, c.server)
			}
			if !(c.client && !c.server) {
				t.Errorf("差异方向必须是「服务端更严」: %q client=%v server=%v", c.url, c.client, c.server)
			}
			diffs++
		}
	}
	t.Logf("R4-URL-CORPUS|total=%d diffs=%d(全部为已登记 WHATWG 归一化差异)", len(r4URLCorpus), diffs)
}

// TestConnectorURLParityWithClientSource:跑真客户端代码(packages/host/connectors/
// src/outbound.ts,node 原生类型剥离)对同一语料判定。无 node 时跳过(仍保留上面的
// 金标语料 + 段清单防漂移)。
func TestConnectorURLParityWithClientSource(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node 不可用,跳过与客户端源码的实跑对拍: %v", err)
	}
	urls := make([]string, 0, len(r4URLCorpus))
	for _, c := range r4URLCorpus {
		urls = append(urls, c.url)
	}
	verdicts := r4RunClientURLVerdicts(t, node, urls)
	if len(verdicts) != len(urls) {
		t.Fatalf("客户端判定条数 = %d, want %d", len(verdicts), len(urls))
	}
	for i, c := range r4URLCorpus {
		if verdicts[i] != c.client {
			t.Errorf("客户端口径漂移: %q 现在 = %v,金标(client)= %v —— "+
				"客户端收紧/放宽后必须同步 Go 镜像表与金标语料(本用例是防漂移守卫,不是误报)",
				c.url, verdicts[i], c.client)
		}
	}
}

// TestConnectorBlockedNetworksMatchClientOutbound:段清单防漂移 —— 直接解析
// outbound.ts 的 buildBlockedList()/buildLoopbackList(),与 Go 镜像表逐条比对。
func TestConnectorBlockedNetworksMatchClientOutbound(t *testing.T) {
	raw := r4ReadClientOutbound(t)
	clientBlocked := r4ParseArraySubnets(t, raw, "buildBlockedList")
	clientLoopback := r4ParseLoopbackSubnets(t, raw)
	if len(clientBlocked) == 0 || len(clientLoopback) == 0 {
		t.Fatal("未能从 outbound.ts 解析 BLOCKED/LOOPBACK 段清单")
	}
	serverBlocked := append([]string(nil), connectorBlockedNetworks...)
	sort.Strings(serverBlocked)
	sort.Strings(clientBlocked)
	if strings.Join(serverBlocked, ",") != strings.Join(clientBlocked, ",") {
		t.Fatalf("保留段清单漂移:\n server = %v\n client = %v\n"+
			"两侧必须逐条一致(server/internal/serverstore/connectors.go ↔ packages/host/connectors/src/outbound.ts)",
			serverBlocked, clientBlocked)
	}
	serverLoopback := append([]string(nil), connectorLoopbackNetworks...)
	sort.Strings(serverLoopback)
	sort.Strings(clientLoopback)
	if strings.Join(serverLoopback, ",") != strings.Join(clientLoopback, ",") {
		t.Fatalf("回环段清单漂移:\n server = %v\n client = %v", serverLoopback, clientLoopback)
	}
	// 客户端元数据主机名单也必须镜像(名字口径与根点归一同款)。
	names := r4ParseStringLiterals(t, raw, `(?s)const METADATA_HOSTNAMES = new Set\(\[(.*?)\]\)`)
	sort.Strings(names)
	if len(names) == 0 {
		t.Fatal("未能从 outbound.ts 解析 METADATA_HOSTNAMES")
	}
	for _, n := range names {
		if !connectorMetadataHosts[strings.ToLower(n)] {
			t.Errorf("元数据主机名单漂移:客户端有 %q,Go 镜像表没有", n)
		}
	}
	if len(connectorMetadataHosts) != len(names) {
		t.Errorf("元数据主机名单条数不一致: server=%d client=%d", len(connectorMetadataHosts), len(names))
	}
}

// TestConnectorURLZoneIDBypassRejected:真绕过用例(第三轮复核的唯一实际绕过)。
func TestConnectorURLZoneIDBypassRejected(t *testing.T) {
	for _, raw := range []string{
		"https://[fe80::1%25eth0]/mcp", // WHATWG 百分号编码 zone
		"https://[fe80::1%eth0]/mcp",   // 裸 zone(url.Parse 直接拒)
		"https://[fe80::1%25]/mcp",
		"https://[fe80::1%25eth0]:8443/mcp",
		"https://[FE80::1%25ETH0]/mcp",
		"http://[fe80::1%25eth0]:9000/mcp",
		"https://[fe80::a%25eth0]/x",
		"https://[ff02::1%25eth0]/x",
		"https://[64:ff9b::1%25eth0]/x",
		"https://[::ffff:169.254.169.254%25eth0]/x",
		// zone 后面是公网地址同样拒绝:WHATWG 无法表达 zone-id,放行只会
		// 「保存成功、客户端静默丢弃」。
		"https://[2606:4700::1111%25eth0]/x",
	} {
		if connectorURLAllowed(raw) {
			t.Errorf("zone-id 形态未拦: connectorURLAllowed(%q) = true(链路本地/保留段绕过或客户端不可表达)", raw)
		}
	}
	// 剥 zone 后的地址本身仍是合法公网 ⇒ 不带 zone 时照常放行(不得连带误伤)。
	if !connectorURLAllowed("https://[2606:4700::1111]/x") {
		t.Error("公网 IPv6(不带 zone)被误拒")
	}
}

// ---- 夹具 ----

func r4ReadClientOutbound(t *testing.T) []byte {
	t.Helper()
	rel := filepath.Join("packages", "host", "connectors", "src", "outbound.ts")
	for _, c := range []string{filepath.Join("..", "..", "..", rel), filepath.Join("..", "..", rel)} {
		if raw, err := os.ReadFile(c); err == nil {
			return raw
		}
	}
	t.Skip("客户端 outbound.ts 不可达(独立构建 server 目录时跳过)")
	return nil
}

// r4ParseArraySubnets:抓 `function <fn>()` 整个函数体,扫描所有
// `['<network>', <prefix>]` 段声明(buildBlockedList 里 IPv4/IPv6 两个循环)。
func r4ParseArraySubnets(t *testing.T, raw []byte, fn string) []string {
	t.Helper()
	m := regexp.MustCompile(`(?s)function ` + fn + `\(\)(.*?)\n\}`).FindSubmatch(raw)
	if m == nil {
		t.Fatalf("outbound.ts 中找不到 function %s()", fn)
	}
	return r4ScanSubnetLiterals(string(m[1]))
}

// r4ScanSubnetLiterals:逐行抓 `'<literal>', <prefix>` 形态的段声明。
func r4ScanSubnetLiterals(body string) []string {
	var out []string
	lit := regexp.MustCompile(`'(0x[0-9a-fA-F]+|[0-9a-fA-F:.]+)'\s*,\s*(\d+)`)
	for _, line := range strings.Split(body, "\n") {
		if i := strings.Index(line, "//"); i >= 0 {
			line = line[:i]
		}
		for _, sub := range lit.FindAllStringSubmatch(line, -1) {
			out = append(out, sub[1]+"/"+sub[2])
		}
	}
	return out
}

// r4ParseLoopbackSubnets:客户端 buildLoopbackList() 用的是逐条 addSubnet
// 调用(不是数组循环),单独解析。
func r4ParseLoopbackSubnets(t *testing.T, raw []byte) []string {
	t.Helper()
	m := regexp.MustCompile(`(?s)function buildLoopbackList\(\)(.*?)\n\}`).FindSubmatch(raw)
	if m == nil {
		t.Fatal("outbound.ts 中找不到 buildLoopbackList()")
	}
	var out []string
	lit := regexp.MustCompile(`addSubnet\('([^']+)',\s*(\d+)`)
	for _, line := range strings.Split(string(m[1]), "\n") {
		if i := strings.Index(line, "//"); i >= 0 {
			line = line[:i]
		}
		if sub := lit.FindStringSubmatch(line); sub != nil {
			out = append(out, sub[1]+"/"+sub[2])
		}
	}
	return out
}

func r4ParseStringLiterals(t *testing.T, raw []byte, pattern string) []string {
	t.Helper()
	m := regexp.MustCompile(pattern).FindSubmatch(raw)
	if m == nil {
		t.Fatalf("outbound.ts 中找不到 %s", pattern)
	}
	var out []string
	for _, line := range strings.Split(string(m[1]), "\n") {
		if i := strings.Index(line, "//"); i >= 0 {
			line = line[:i]
		}
		for _, lit := range regexp.MustCompile(`'([^']*)'`).FindAllStringSubmatch(line, -1) {
			out = append(out, lit[1])
		}
	}
	return out
}

// r4RunClientURLVerdicts 用真客户端代码跑语料(一次性 node 进程)。
func r4RunClientURLVerdicts(t *testing.T, node string, urls []string) []bool {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("解析仓库根: %v", err)
	}
	module := filepath.ToSlash(filepath.Join(root, "packages", "host", "connectors", "src", "outbound.ts"))
	if _, err := os.Stat(module); err != nil {
		t.Skipf("客户端 outbound.ts 不可达: %v", err)
	}
	payload, err := json.Marshal(urls)
	if err != nil {
		t.Fatalf("编码语料: %v", err)
	}
	script := "import { isOutboundUrlAllowed } from " + r4JSString(module) + "\n" +
		"const urls = " + string(payload) + "\n" +
		"console.log(JSON.stringify(urls.map(u => isOutboundUrlAllowed(u))))\n"
	dir := t.TempDir()
	path := filepath.Join(dir, "r4-url-parity.mjs")
	if err := os.WriteFile(path, []byte(script), 0o600); err != nil {
		t.Fatalf("写对拍脚本: %v", err)
	}
	cmd := exec.Command(node, path)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Skipf("node 无法加载客户端 outbound.ts(类型剥离不可用?): %v\n%s", err, out)
	}
	line := strings.TrimSpace(string(out))
	if i := strings.LastIndexByte(line, '\n'); i >= 0 {
		line = strings.TrimSpace(line[i+1:])
	}
	var verdicts []bool
	if err := json.Unmarshal([]byte(line), &verdicts); err != nil {
		t.Fatalf("解析客户端判定失败: %v\n输出=%s", err, out)
	}
	return verdicts
}

func r4JSString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
