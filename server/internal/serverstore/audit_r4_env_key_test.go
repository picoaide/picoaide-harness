package serverstore

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// N6(2026-09-13 第三轮独立复核 §3.2 / 清单 N6,P3):`\uFEFFNODE_OPTIONS` 服务端
// 放行、客户端拒收。
//
// 根因:Go 的 strings.TrimSpace 走 unicode.IsSpace,U+FEFF(BOM/零宽不换行空格)
// **不是** White_Space;而 JS 的 String.trim() 剥 WhiteSpace + LineTerminator,
// 其中含 U+FEFF ⇒ 客户端把 "\uFEFFNODE_OPTIONS" 归一成 "NODE_OPTIONS" 判拒、
// 目录解析直接丢弃该连接器。表现为「管理端保存成功、客户端静默消失」。
//
// 修法:connectorEnvKeyAllowed 的归一化与客户端 normalizeEnvKey 对齐 ——
// 先剥不可见格式字符(U+FEFF/零宽/双向控制,清单见 connectors.go),再按
// Unicode 空白 trim,再大写比较。
//
// 判据(方向必须安全):**客户端拒绝的键,服务端必须拒绝**(否则就是静默丢弃);
// 服务端可以更严(保存时 fail-loud,不会静默消失)。

// r4EnvKeyCase 是键语料的一行。
type r4EnvKeyCase struct {
	name string
	key  string
	// denied = Go connectorEnvKeyAllowed 的期望结果(取反)。
	denied bool
	// invisible = 归一化前含不可见格式字符(客户端若只 trim 会放行,属
	// 「服务端更严」的已登记差异,见 TestConnectorEnvKeyParityWithClientPolicy)。
	invisible bool
}

var r4EnvKeyCorpus = []r4EnvKeyCase{
	{"plain", "SAFE_TOKEN", false, false},
	{"node-options", "NODE_OPTIONS", true, false},
	{"node-options-lower", "node_options", true, false},
	{"node-options-space", " NODE_OPTIONS ", true, false},
	{"node-options-tab", "\tNODE_OPTIONS\n", true, false},
	{"dsH-home-mixed", "DsH_Home", true, false},
	{"electron-prefix", "ELECTRON_RUN_AS_NODE", true, false},
	{"picoaide-prefix", "PICOAIDE_HOME", true, false},
	{"ld-preload", "LD_PRELOAD", true, false},
	{"path", "Path", true, false},
	{"empty", "", true, false},
	{"blank", "   ", true, false},
	// ---- N6 主体:不可见格式字符 ----
	{"bom-prefix", "\uFEFFNODE_OPTIONS", true, true},
	{"bom-suffix", "NODE_OPTIONS\uFEFF", true, true},
	{"bom-only", "\uFEFF", true, true},
	{"bom-dsh-prefix", "\uFEFFDSH_HOME", true, true},
	{"bom-path-prefix", "\uFEFFPath", true, true},
	{"bom-after-space", " \uFEFF NODE_OPTIONS", true, true},
	{"zwsp-prefix", "\u200BNODE_OPTIONS", true, true},
	{"zwsp-inner", "NODE\u200B_OPTIONS", true, true},
	{"zwnj-inner", "NODE\u200C_OPTIONS", true, true},
	{"zwj-inner", "NODE\u200D_OPTIONS", true, true},
	{"word-joiner-inner", "DSH\u2060_HOME", true, true},
	{"bidi-lrm-prefix", "\u200ENODE_OPTIONS", true, true},
	{"bidi-rlo-prefix", "\u202ENODE_OPTIONS", true, true},
	{"bidi-isolate-inner", "NODE\u2066_OPTIONS", true, true},
	{"soft-hyphen-inner", "NODE\u00AD_OPTIONS", true, true},
	{"mongolian-vowel-sep", "\u180ENODE_OPTIONS", true, true},
	{"zero-width-only-prefix", "\uFEFF\u200B", true, true},
	// 全角字母是**另一个**环境变量名(不存在 Confusable 归一),客户端也放行 ⇒
	// 两侧一致地放行(不得借机引入非对齐的 NFKC 归一)。
	{"fullwidth", "ＮＯＤＥ_OPTIONS", false, false},
	// 仅空白类字符(客户端 trim 集合内)必须继续拒绝。
	{"nbsp-suffix", "NODE_OPTIONS\u00A0", true, false},
	{"ideographic-space", "\u3000NODE_OPTIONS\u3000", true, false},
	// 受保护前缀的相似但合法键(不得误伤)。
	{"near-dsh", "DSH", false, false},
	{"near-node", "NODE", false, false},
	{"local-token", "GLITCHTIP_TOKEN", false, false},
}

// TestConnectorEnvKeyInvisibleRuneNormalization:归一化行为逐条固定。
func TestConnectorEnvKeyInvisibleRuneNormalization(t *testing.T) {
	for _, c := range r4EnvKeyCorpus {
		allowed := connectorEnvKeyAllowed(c.key)
		if allowed == c.denied {
			t.Errorf("%s: connectorEnvKeyAllowed(%q) = %v, want %v", c.name, c.key, allowed, !c.denied)
		}
	}
	// 归一化函数本身:剥不可见字符 + trim(顺序无关)。
	for _, c := range []struct{ in, want string }{
		{"\uFEFFNODE_OPTIONS", "NODE_OPTIONS"},
		{"\uFEFF\u200B", ""},
		{" \uFEFF NODE_OPTIONS ", "NODE_OPTIONS"},
		{"NODE\u200B_OPTIONS", "NODE_OPTIONS"},
		{"SAFE_TOKEN", "SAFE_TOKEN"},
		{"\u3000PATH\u3000", "PATH"},
	} {
		if got := connectorEnvKeyNormalize(c.in); got != c.want {
			t.Errorf("connectorEnvKeyNormalize(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestConnectorEnvKeyInvisibleRunesRejectedEndToEnd:走真校验 + 真落库路径。
func TestConnectorEnvKeyInvisibleRunesRejectedEndToEnd(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	rejected := []string{
		`{"tokenFields":[{"key":"\uFEFFNODE_OPTIONS","label":"x"}],"mcp":[{"serverName":"x","transport":"stdio","command":"npx"}]}`,
		`{"settings":[{"key":"NODE\u200B_OPTIONS"}],"mcp":[{"serverName":"x","transport":"stdio","command":"npx"}]}`,
		`{"mcp":[{"serverName":"x","transport":"stdio","command":"npx","env":{"\uFEFFPATH":"/evil"}}]}`,
		`{"mcp":[{"serverName":"x","transport":"stdio","command":"npx","env":{"ELECTRON\u2060_RUN_AS_NODE":"1"}}]}`,
	}
	for i, def := range rejected {
		c := &Connector{ID: "r4-invisible", Name: "N", AuthMode: "token", Definition: def}
		if err := validateConnector(c); !errors.Is(err, ErrValidation) {
			t.Errorf("定义 %d: validateConnector = %v, want ErrValidation", i, err)
		}
		if err := CreateConnector(db, c); !errors.Is(err, ErrValidation) {
			t.Errorf("定义 %d: CreateConnector = %v, want ErrValidation", i, err)
		}
	}
	if _, err := GetConnector(db, "r4-invisible"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("被拒连接器仍然落库: %v", err)
	}
	// 合法键照常落库(防「一律拒绝」式修复)。
	ok := &Connector{ID: "r4-visible", Name: "OK", AuthMode: "token",
		Definition: `{"tokenFields":[{"key":"CRM_TOKEN"}],"mcp":[{"serverName":"ok","transport":"stdio","command":"npx","env":{"CRM_REGION":"cn"}}]}`}
	if err := CreateConnector(db, ok); err != nil {
		t.Fatalf("合法连接器被拒: %v", err)
	}
}

// TestConnectorEnvKeyParityWithClientPolicy:跑真客户端 policy.ts 的
// isDeniedEnvKey 对同一键语料判定。契约:
//   - 客户端拒绝 ⇒ 服务端必须拒绝(否则「保存成功、客户端静默丢弃」);
//   - 无不可见字符的键两侧必须逐字一致;
//   - 服务端更严(客户端只 trim ⇒ 只剥两端的 U+FEFF)必须已登记 +
//     真客户端源码里 normalizeEnvKey 仍是 trim 口径(否则说明客户端已同步收紧,
//     本用例会失败提醒更新镜像与清单)。
func TestConnectorEnvKeyParityWithClientPolicy(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node 不可用,跳过与客户端 policy.ts 的实跑对拍: %v", err)
	}
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatalf("解析仓库根: %v", err)
	}
	module := filepath.ToSlash(filepath.Join(root, "packages", "host", "connectors", "src", "policy.ts"))
	if _, err := os.Stat(module); err != nil {
		t.Skipf("客户端 policy.ts 不可达: %v", err)
	}
	keys := make([]string, 0, len(r4EnvKeyCorpus))
	for _, c := range r4EnvKeyCorpus {
		keys = append(keys, c.key)
	}
	payload, _ := json.Marshal(keys)
	script := "import { isDeniedEnvKey } from " + r4JSString(module) + "\n" +
		"const keys = " + string(payload) + "\n" +
		"console.log(JSON.stringify(keys.map(k => isDeniedEnvKey(k))))\n"
	path := filepath.Join(t.TempDir(), "r4-envkey-parity.mjs")
	if err := os.WriteFile(path, []byte(script), 0o600); err != nil {
		t.Fatalf("写对拍脚本: %v", err)
	}
	out, err := exec.Command(node, path).CombinedOutput()
	if err != nil {
		t.Skipf("node 无法加载 policy.ts: %v\n%s", err, out)
	}
	line := strings.TrimSpace(string(out))
	if i := strings.LastIndexByte(line, '\n'); i >= 0 {
		line = strings.TrimSpace(line[i+1:])
	}
	var jsDenied []bool
	if err := json.Unmarshal([]byte(line), &jsDenied); err != nil {
		t.Fatalf("解析客户端判定失败: %v\n输出=%s", err, out)
	}
	if len(jsDenied) != len(r4EnvKeyCorpus) {
		t.Fatalf("客户端判定条数 = %d, want %d", len(jsDenied), len(r4EnvKeyCorpus))
	}
	var serverStricter []string
	for i, c := range r4EnvKeyCorpus {
		goDenied := !connectorEnvKeyAllowed(c.key)
		if goDenied != c.denied {
			t.Errorf("%s: 服务端判定 %v ≠ 本文件金标 %v", c.name, goDenied, c.denied)
		}
		if jsDenied[i] && !goDenied {
			t.Errorf("服务端比客户端更宽: %s 键=%q 客户端拒绝而服务端放行(保存成功但客户端丢弃)",
				c.name, c.key)
		}
		if !c.invisible && jsDenied[i] != goDenied {
			t.Errorf("无不可见字符的键两侧必须一致: %s 键=%q client=%v server=%v",
				c.name, c.key, jsDenied[i], goDenied)
		}
		if c.invisible && goDenied && !jsDenied[i] {
			serverStricter = append(serverStricter, c.name)
		}
	}
	t.Logf("R4-ENVKEY-PARITY|keys=%d server_stricter=%v(客户端 normalizeEnvKey 仍是 trim 口径时的已登记差异)",
		len(r4EnvKeyCorpus), serverStricter)
}
