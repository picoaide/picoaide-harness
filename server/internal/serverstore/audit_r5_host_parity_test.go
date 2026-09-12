package serverstore

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// R5(2026-09-13 第五轮独立对抗式复核 §3/§4):Go↔客户端的两个"解析层"分歧。
//
//	§3(P2)URL 主机解析层:`https://10。0。0。1/`(U+3002)、全角数字、
//	       `10.0.0.1<U+200B|U+00AD|U+FEFF>`、`https://example.com:99999/` 服务端
//	       放行而客户端静默丢弃(`new URL()` 归一/抛错)。第四轮只对齐了**网段
//	       清单**,没对齐**主机解析层**。
//	§4(P2)env 键名:含 `=`(含尾随)绕过 denylist;以及 Go 的 trim 比 JS 多剥
//	       U+0085(NEL)导致"集合一字不差"在 trim 层不成立。
//
// 判据(方向必须安全):**客户端拒绝的必须也拒绝**(否则"管理端保存成功、客户端
// 静默丢弃");允许的残余差异只能是「服务端更严」且逐条登记 why。

// r5HostCase 是主机层语料的一行。
type r5HostCase struct {
	url    string
	client bool   // 真客户端 isOutboundUrlAllowed(权威口径,由 node 实跑复核)
	server bool   // Go connectorURLAllowed 的期望判定
	why    string // 非空 = 已登记的「服务端更严」差异
}

// r5HostCorpus:复核报告 §3 的 5 条最小复现 + 同族形态(不可见字符全集合、
// 全角/点号变体、端口边界、反斜杠/制表符反向分歧、百分号编码主机)。
// client 列由真客户端 `new URL()` + isOutboundUrlAllowed 实跑得到(见
// TestR5ConnectorURLHostLayerParityWithClient,该用例会在测试期重跑一遍)。
var r5HostCorpus = []r5HostCase{
	// ---- 复核报告点名的 5 条 ----
	{"https://10。0。0。1/mcp", false, false, ""},       // U+3002 → 10.0.0.1(内网)
	{"https://１０.０.０.１/mcp", false, false, ""},       // 全角数字 → 10.0.0.1
	{"https://10.0.0.1\u200B/mcp", false, false, ""}, // 零宽空格
	{"https://10.0.0.1\u00AD/mcp", false, false, ""}, // 软连字符
	{"https://10.0.0.1\uFEFF/mcp", false, false, ""}, // BOM
	{"https://example.com:99999/mcp", false, false, ""},
	// ---- 同族:点号变体 / 全角 ----
	{"https://10．0．0．1/mcp", false, false, ""},  // U+FF0E
	{"https://10｡0｡0｡1/mcp", false, false, ""},  // U+FF61
	{"https://10.0.0.1。/mcp", false, false, ""}, // 尾随 U+3002(映射后是根点)
	{"https://ｅｘａｍｐｌｅ.com/x", true, true, ""},   // 全角字母 → example.com
	{"https://example.com\u3002/mcp", true, true, ""},
	{"https://𝟏𝟎.𝟎.𝟎.𝟏/x", false, false, ""}, // 数学粗体数字(客户端映射成 10.0.0.1)
	// ---- 同族:WHATWG 会剥的不可见字符(逐码位实测) ----
	{"https://10.0.0.1\u2060/mcp", false, false, ""}, // 词连接符
	{"https://example.com\u200B/x", true, true, ""},
	{"https://exa\u200Bmple.com/x", true, true, ""},
	{"https://metadata.google.internal\u200B/x", false, false, ""},
	{"https://metadata。google。internal/x", false, false, ""},
	{"https://198.18.0.1\u200B/x", false, false, ""},
	// ---- 同族:WHATWG **拒绝**(不剥)的不可见字符:两侧一致拒绝 ----
	{"https://10.0.0.1\u200C/mcp", false, false, ""},  // ZWNJ
	{"https://10.0.0.1\u200D/mcp", false, false, ""},  // ZWJ
	{"https://10.0.0.1\u200E/mcp", false, false, ""},  // LRM
	{"https://10.0.0.1\u200F/mcp", false, false, ""},  // RLM
	{"https://10.0.0.1\u202A/mcp", false, false, ""},  // LRE
	{"https://10.0.0.1\u202E/mcp", false, false, ""},  // RLO
	{"https://10.0.0.1\u2066/mcp", false, false, ""},  // LRI
	{"https://10.0.0.1\u2069/mcp", false, false, ""},  // PDI
	{"https://10.0.0.1\u0085/x", false, false, ""},    // NEL
	{"https://10.0.0.1\u00A0/x", false, false, ""},    // NBSP
	{"https://10.0.0.1\u2028/x", false, false, ""},    // 行分隔符
	{"https://example.com\u2024/x", false, false, ""}, // ONE DOT LEADER(客户端也不映射)
	// ---- 端口层 ----
	{"https://example.com:65535/mcp", true, true, ""},
	{"https://example.com:65536/mcp", false, false, ""},
	{"https://example.com:000080/x", true, true, ""}, // 前导零,值 80
	{"https://example.com:/mcp", true, true, ""},     // 空端口
	{"https://[::1]:99999/x", false, false, ""},
	{"https://example.com:0/mcp", true, false,
		"端口范围 1–65535:客户端接受 :0(WHATWG 把 special scheme 的端口 0 归 null),服务端拒绝"},
	// ---- 反向分歧(第四轮遗留:客户端更宽,方向安全)----
	{"https://example.com\\@10.0.0.1/mcp", true, true, "WHATWG special scheme 把 '\\' 当 '/';Go 侧现在同口径归一"},
	{"https://example.com\t/mcp", true, true, "WHATWG 去掉输入里的 TAB;Go 侧现在同口径归一"},
	// ---- 客户端抛错的其他形态(服务端必须同样拒绝)----
	{"https://exa mple.com/x", false, false, ""},
	{"https://10.0.0.1 /x", false, false, ""},
	{"https://user\u200B@example.com/x", false, false, ""},
	{"https://10.0.0.1%00/x", false, false, ""},
	{"https://example.com\u0000/x", false, false, ""},
	{"https://[::ffff:10.0.0.1\u200B]/x", false, false, ""},
	{"https://[fe80::1]\u200B/x", false, false, ""},
	// ---- 已登记的「服务端更严」(IDN / 伪装 IPv4)----
	{"https://exämple.com/x", true, false,
		"IDN:完整 UTS-46→punycode 需要 golang.org/x/net/idna,而 server/go.mod 不在可改范围;服务端拒绝非 ASCII 主机(不静默丢弃)"},
	{"https://例え.jp/x", true, false, "同上(IDN 非 ASCII 主机)"},
	{"https://xn--exmple-cua.com/x", true, true, ""}, // punycode 形态(已是 ASCII)照常放行
	{"https://0x7f.1\u200B/x", true, false, "剥不可见字符后是 0x7f.1 ⇒ 伪装 IPv4,服务端一律拒绝(同 r4 已登记口径)"},
	{"https://exa%6dple.com/x", true, false, "WHATWG 主机百分号解码(→example.com);Go 侧主机含 '%' 一律拒绝(更严)"},
}

// TestR5ConnectorURLHostLayerCorpus:逐条对拍 + 方向不变量。
func TestR5ConnectorURLHostLayerCorpus(t *testing.T) {
	diffs := 0
	for _, c := range r5HostCorpus {
		got := connectorURLAllowed(c.url)
		if got != c.server {
			t.Errorf("connectorURLAllowed(%q) = %v, want %v(client=%v why=%s)",
				c.url, got, c.server, c.client, c.why)
		}
		if !c.client && c.server {
			t.Errorf("方向违规:%q 服务端比客户端更宽(client=false server=true)", c.url)
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
	t.Logf("R5-URL-HOST-CORPUS|total=%d diffs=%d(全部为已登记的服务端更严项)", len(r5HostCorpus), diffs)
}

// TestR5ConnectorURLHostLayerParityWithClient:跑**真客户端代码**对同一语料判定。
// 这是防漂移守卫:客户端收紧/放宽后必须同步 Go 镜像与金标(不是误报)。
func TestR5ConnectorURLHostLayerParityWithClient(t *testing.T) {
	node := r5RequireNode(t)
	urls := make([]string, 0, len(r5HostCorpus))
	for _, c := range r5HostCorpus {
		urls = append(urls, c.url)
	}
	verdicts := r4RunClientURLVerdicts(t, node, urls)
	if len(verdicts) != len(urls) {
		t.Fatalf("客户端判定条数 = %d, want %d", len(verdicts), len(urls))
	}
	var serverStricter []string
	for i, c := range r5HostCorpus {
		if verdicts[i] != c.client {
			t.Errorf("客户端口径漂移: %q 现在 = %v,金标(client)= %v —— 客户端行为变了,必须同步 Go 镜像表与本语料",
				c.url, verdicts[i], c.client)
		}
		if verdicts[i] && !connectorURLAllowed(c.url) {
			serverStricter = append(serverStricter, fmt.Sprintf("%q(%s)", c.url, c.why))
		}
	}
	t.Logf("R5-URL-HOST-PARITY|total=%d server_stricter=%d %v", len(urls), len(serverStricter), serverStricter)
}

// TestR5ConnectorURLHostNormalizeUnit:主机归一化的单元语义(点号变体/全角/
// 不可见字符/非 ASCII 拒绝)。
func TestR5ConnectorURLHostNormalizeUnit(t *testing.T) {
	cases := []struct {
		in, want string
		ok       bool
	}{
		{"example.com", "example.com", true},
		{"10。0。0。1", "10.0.0.1", true},
		{"10｡0｡0｡1", "10.0.0.1", true},
		{"10．0．0．1", "10.0.0.1", true},
		{"１０.０.０.１", "10.0.0.1", true},
		{"ｅｘａｍｐｌｅ.com", "example.com", true},
		{"10.0.0.1\u200B", "10.0.0.1", true},
		{"10.0.0.1\u00AD", "10.0.0.1", true},
		{"10.0.0.1\uFEFF", "10.0.0.1", true},
		{"meta\u2060data.google.internal", "metadata.google.internal", true},
		// 客户端拒绝的不可见字符:不剥 → 非 ASCII → 拒绝(不得悄悄归一成合法主机)。
		{"10.0.0.1\u200E", "", false},
		{"10.0.0.1\u202E", "", false},
		{"example.com\u2024", "", false},
		{"exämple.com", "", false},
		{"例え.jp", "", false},
	}
	for _, c := range cases {
		got, ok := connectorHostNormalize(c.in)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("connectorHostNormalize(%q) = (%q, %v), want (%q, %v)", c.in, got, ok, c.want, c.ok)
		}
	}
}

// ---------------------------------------------------------------------------
// §4:env 键名含 '=' + U+0085 与 JS trim 对齐
// ---------------------------------------------------------------------------

// TestR5ConnectorEnvKeyEqualsSignRejected:键名含 '='(含尾随)一律拒绝 ——
// libuv 写 `key=value`,子进程按第一个 '=' 切名,`NODE_OPTIONS=` 会把受保护变量
// 真的定义成 `=…`(实测复现见复核报告 §4)。
func TestR5ConnectorEnvKeyEqualsSignRejected(t *testing.T) {
	// 单元:任意位置(含尾随/中缀/仅等号/受保护前缀)都拒。
	for _, key := range []string{
		"NODE_OPTIONS=", "=", "=NODE_OPTIONS", "NODE_OPTIONS=--require /tmp/evil.js",
		"PATH=", "HOME=", "DSH_HOME=", "ELECTRON_RUN_AS_NODE=", "PICOAIDE_X=",
		"SAFE=", "A=B", "NODE_OPTIONS\u200B=", "NODE_OPTIONS =\t",
	} {
		if connectorEnvKeyAllowed(key) {
			t.Errorf("含 '=' 的键名被放行: %q", key)
		}
	}
	// 合法键不得误伤。
	for _, key := range []string{"SAFE_TOKEN", "CRM_REGION", "NODE", "DSH", "PATHX"} {
		if !connectorEnvKeyAllowed(key) {
			t.Errorf("合法键被拒: %q", key)
		}
	}

	// 端到端:三条声明通道 + mcp env 都必须拒绝,且不落库。
	db, cleanup := NewTestDB(t)
	defer cleanup()
	defs := []string{
		`{"tokenFields":[{"key":"NODE_OPTIONS=","label":"x"}],"mcp":[{"serverName":"x","transport":"stdio","command":"npx"}]}`,
		`{"settings":[{"key":"PATH="}],"mcp":[{"serverName":"x","transport":"stdio","command":"npx"}]}`,
		`{"mcp":[{"serverName":"x","transport":"stdio","command":"npx","env":{"NODE_OPTIONS=":"--require /tmp/evil.js"}}]}`,
		`{"mcp":[{"serverName":"x","transport":"stdio","command":"npx","env":{"DSH_HOME=":"/evil"}}]}`,
	}
	for i, def := range defs {
		c := &Connector{ID: "r5-eq", Name: "N", AuthMode: "token", Definition: def}
		if err := validateConnector(c); !errors.Is(err, ErrValidation) {
			t.Errorf("定义 %d: validateConnector = %v, want ErrValidation", i, err)
		}
		if err := CreateConnector(db, c); !errors.Is(err, ErrValidation) {
			t.Errorf("定义 %d: CreateConnector = %v, want ErrValidation", i, err)
		}
	}
	if _, err := GetConnector(db, "r5-eq"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("含 '=' 键的连接器仍然落库: %v", err)
	}
	// 合法连接器照常落库(防"一律拒绝"式修复)。
	ok := &Connector{ID: "r5-eq-ok", Name: "OK", AuthMode: "token",
		Definition: `{"tokenFields":[{"key":"CRM_TOKEN"}],"mcp":[{"serverName":"ok","transport":"stdio","command":"npx","env":{"CRM_REGION":"cn"}}]}`}
	if err := CreateConnector(db, ok); err != nil {
		t.Fatalf("合法连接器被拒: %v", err)
	}
}

// TestR5ConnectorEnvKeyTrimSetEqualsJS:String.trim() 的空白集合必须与 Go 的
// connectorEnvKeyTrimCutset **逐码位一致**(穷举全 Unicode)。第四轮的残余分歧
// 是 U+0085(NEL):Go 的 unicode.IsSpace 认它、JS 不认 —— 现在两侧一致。
func TestR5ConnectorEnvKeyTrimSetEqualsJS(t *testing.T) {
	node := r5RequireNode(t)
	jsSet := r5RunNodeIntSet(t, node, `
const out = [];
for (let cp = 0; cp <= 0x10FFFF; cp++) {
  const s = String.fromCodePoint(cp);
  if (s.trim() === '' && s.length > 0) out.push(cp);
}
console.log(JSON.stringify(out));
`)
	goSet := map[int]bool{}
	for _, r := range connectorEnvKeyTrimCutset {
		goSet[int(r)] = true
		// 行为一致性:该码位单独成键时归一化后必须是空串(即真的被 trim 掉)。
		if got := connectorEnvKeyNormalize(string(r)); got != "" {
			t.Errorf("trim 集合成员 U+%04X 未被归一化剥掉: %q", r, got)
		}
	}
	// Go 侧不得多剥:任何不在 cutset 里的码位,若 JS 不 trim 而 Go 剥了 → 有分歧。
	// (Go 的 trim 只由 cutset 决定,所以集合相等即行为相等;这里额外穷举验证
	// "JS trim 的码位都在 Go 集合里、反之亦然"。)
	var onlyJS, onlyGo []int
	for cp := range jsSet {
		if !goSet[cp] {
			onlyJS = append(onlyJS, cp)
		}
	}
	for cp := range goSet {
		if !jsSet[cp] {
			onlyGo = append(onlyGo, cp)
		}
	}
	sort.Ints(onlyJS)
	sort.Ints(onlyGo)
	t.Logf("R5-ENVKEY-TRIM|js=%d go=%d onlyJS=%v onlyGo=%v", len(jsSet), len(goSet), r5HexList(onlyJS), r5HexList(onlyGo))
	if len(onlyJS) != 0 || len(onlyGo) != 0 {
		t.Fatalf("trim 集合不一致:仅 JS=%v 仅 Go=%v", r5HexList(onlyJS), r5HexList(onlyGo))
	}

	// U+0085 专项:Go 不得再把它当空白剥掉(否则 "NODE_OPTIONS\u0085" 会被归一成
	// 受保护键判拒,而客户端放行 = 管理端保存失败的分叉)。
	if connectorEnvKeyNormalize("NODE_OPTIONS\u0085") != "NODE_OPTIONS\u0085" {
		t.Fatalf("U+0085 仍被 Go 剥掉: %q", connectorEnvKeyNormalize("NODE_OPTIONS\u0085"))
	}
}

// TestR5ConnectorEnvKeyParityGoNeverWider:真客户端 isDeniedEnvKey 对键语料判定:
// 客户端拒绝 ⇒ 服务端必须拒绝。'=' 与 U+0085 两条本轮修复项都在语料里。
// (客户端侧的 '=' 修复由并行任务负责:若客户端已收紧,则两侧一致;若尚未,
// 服务端更严并登记 —— 两种状态都不得出现"客户端拒绝、服务端放行"。)
func TestR5ConnectorEnvKeyParityGoNeverWider(t *testing.T) {
	node := r5RequireNode(t)
	keys := []string{
		"NODE_OPTIONS=", "=", "PATH=", "DSH_HOME=", "SAFE=X", "NODE_OPTIONS\u200B=",
		"NODE_OPTIONS", "\uFEFFNODE_OPTIONS", "NODE_OPTIONS\u200B", " NODE_OPTIONS ",
		"NODE_OPTIONS\u0085", "\u0085NODE_OPTIONS", "SAFE_TOKEN", "ＮＯＤＥ_OPTIONS",
		"NODE_OPTIONS\u00A0", "NODE_OPTIONS\u3000",
	}
	jsDenied := r5RunNodeBoolList(t, node, keys)
	if len(jsDenied) != len(keys) {
		t.Fatalf("客户端判定条数 = %d, want %d", len(jsDenied), len(keys))
	}
	var stricter []string
	for i, k := range keys {
		goDenied := !connectorEnvKeyAllowed(k)
		if jsDenied[i] && !goDenied {
			t.Errorf("服务端比客户端更宽: 键=%q 客户端拒绝而服务端放行(保存成功但客户端丢弃)", k)
		}
		if goDenied && !jsDenied[i] {
			stricter = append(stricter, fmt.Sprintf("%q", k))
		}
	}
	t.Logf("R5-ENVKEY-PARITY|keys=%d server_stricter=%v", len(keys), stricter)
}

// ---- 夹具 ----

func r5RequireNode(t *testing.T) string {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node 不可用,跳过与真客户端源码的对拍: %v", err)
	}
	return node
}

// r5RunNodeScript 把脚本写成临时 .mjs 并取**最后一行**输出(与 r4 helper 同口径)。
func r5RunNodeScript(t *testing.T, node, script string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "r5-parity.mjs")
	if err := os.WriteFile(path, []byte(script), 0o600); err != nil {
		t.Fatalf("写对拍脚本: %v", err)
	}
	out, err := exec.Command(node, path).CombinedOutput()
	if err != nil {
		t.Skipf("node 执行失败(类型剥离不可用?): %v\n%s", err, out)
	}
	line := strings.TrimSpace(string(out))
	if i := strings.LastIndexByte(line, '\n'); i >= 0 {
		line = strings.TrimSpace(line[i+1:])
	}
	return line
}

func r5RunNodeIntSet(t *testing.T, node, script string) map[int]bool {
	t.Helper()
	out := r5RunNodeScript(t, node, script)
	var cps []int
	if err := json.Unmarshal([]byte(out), &cps); err != nil {
		t.Fatalf("解析 node 输出失败: %v\n输出=%s", err, out)
	}
	set := map[int]bool{}
	for _, cp := range cps {
		set[cp] = true
	}
	return set
}

func r5RunNodeBoolList(t *testing.T, node string, keys []string) []bool {
	t.Helper()
	payload, err := json.Marshal(keys)
	if err != nil {
		t.Fatal(err)
	}
	script := "import { isDeniedEnvKey } from " + r4JSString(r5ClientModule(t, "policy.ts")) + "\n" +
		"const keys = " + string(payload) + "\n" +
		"console.log(JSON.stringify(keys.map(k => isDeniedEnvKey(k))))\n"
	out := r5RunNodeScript(t, node, script)
	var denied []bool
	if err := json.Unmarshal([]byte(out), &denied); err != nil {
		t.Fatalf("解析客户端判定失败: %v\n输出=%s", err, out)
	}
	return denied
}

func r5HexList(cps []int) []string {
	out := make([]string, 0, len(cps))
	for _, cp := range cps {
		out = append(out, fmt.Sprintf("U+%04X", cp))
	}
	return out
}

// r5ClientModule 解析 packages/host/connectors/src/<name> 的绝对路径。
func r5ClientModule(t *testing.T, name string) string {
	t.Helper()
	rel := filepath.Join("packages", "host", "connectors", "src", name)
	for _, prefix := range []string{filepath.Join("..", "..", ".."), filepath.Join("..", "..")} {
		p := filepath.Join(prefix, rel)
		if _, err := os.Stat(p); err == nil {
			abs, err := filepath.Abs(p)
			if err != nil {
				t.Fatalf("解析路径: %v", err)
			}
			return abs
		}
	}
	t.Skipf("客户端 %s 不可达(独立构建 server 目录时跳过)", rel)
	return ""
}

// TestR5ConnectorURLHostForbiddenChars:WHATWG forbidden host code point 的
// 服务端镜像(只针对域名形态;IPv6 字面量单独处理)。
func TestR5ConnectorURLHostForbiddenChars(t *testing.T) {
	for _, raw := range []string{
		"https://exa%20mple.com/x", // 空格(百分号编码)
		"https://exa%09mple.com/x", // TAB(百分号编码)
		"https://example.com%2Fx/x",
		"https://example.com%3Fx/x",
		"https://example.com%40x/x",
		"https://example.com%5Ex/x",
		"https://example.com%7Cx/x",
	} {
		if connectorURLAllowed(raw) {
			t.Errorf("forbidden host code point 形态被放行: %q", raw)
		}
	}
	// 正常主机不得误伤。
	for _, raw := range []string{
		"https://example.com/x", "https://sub.example.com/x", "https://example.com./x",
		"https://[2606:4700::1111]/x",
	} {
		if !connectorURLAllowed(raw) {
			t.Errorf("正常主机被误拒: %q", raw)
		}
	}
}
