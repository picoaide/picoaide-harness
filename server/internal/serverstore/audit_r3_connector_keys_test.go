package serverstore

import (
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// FIX-02 同族缺口(2026-09-13 独立复核确认仍存在):连接器定义的
// tokenFields[].key / settings[].key 没有过环境键 denylist。
//
// 缺陷形态:客户端 buildStdioEnv 会把**凭据里 key 命中已声明字段名**的值直接
// 注入子进程 env(`env[key] = value`),而 declaredCredentialKeys 只收集
// tokenFields/settings 的 key —— 于是一份
//
//	{"tokenFields":[{"key":"NODE_OPTIONS",...}],"mcp":[{"serverName":"x",
//	 "transport":"stdio","command":"npx"}]}
//
// 的定义可以让管理员(或任何能写 connectors 行的人)在每台员工机器上向 MCP
// 子进程注入 NODE_OPTIONS/LD_PRELOAD/DSH_* 等引导变量 = 任意代码执行。
// 服务端 validateConnector 校验了 mcp[].env,却漏了这两处等价入口。
//
// 修法:tokenFields/settings 的 key 必须与 mcp[].env 走同一套
// connectorEnvKeyAllowed(大小写不敏感 + trim),denylist 与客户端
// packages/host/connectors/src/policy.ts 逐条对齐。
func TestConnectorCredentialFieldKeysRejected(t *testing.T) {
	rejected := []struct {
		name       string
		definition string
	}{
		{"tokenFields NODE_OPTIONS(=客户端同源 bug 的注入原语)",
			`{"tokenFields":[{"key":"NODE_OPTIONS","label":"x","type":"text","required":true}],"mcp":[{"serverName":"x","transport":"stdio","command":"npx"}]}`},
		{"tokenFields 小写 node_options",
			`{"tokenFields":[{"key":"node_options"}],"mcp":[{"serverName":"x","transport":"stdio","command":"npx"}]}`},
		{"tokenFields 前后空白 + 混合大小写",
			`{"tokenFields":[{"key":" Node_Options "}],"mcp":[{"serverName":"x","transport":"stdio","command":"npx"}]}`},
		{"tokenFields PATH",
			`{"tokenFields":[{"key":"PATH"}],"mcp":[{"serverName":"x","transport":"stdio","command":"npx"}]}`},
		{"tokenFields LD_PRELOAD",
			`{"tokenFields":[{"key":"LD_PRELOAD"}],"mcp":[{"serverName":"x","transport":"stdio","command":"npx"}]}`},
		{"tokenFields HTTP_PROXY",
			`{"tokenFields":[{"key":"HTTP_PROXY"}],"mcp":[{"serverName":"x","transport":"stdio","command":"npx"}]}`},
		{"tokenFields DSH_ 前缀",
			`{"tokenFields":[{"key":"DSH_HOME"}],"mcp":[{"serverName":"x","transport":"stdio","command":"npx"}]}`},
		{"settings NODE_OPTIONS",
			`{"settings":[{"key":"NODE_OPTIONS","label":"x"}],"mcp":[{"serverName":"x","transport":"stdio","command":"npx"}]}`},
		{"settings ELECTRON_ 前缀",
			`{"settings":[{"key":"ELECTRON_RUN_AS_NODE"}],"mcp":[{"serverName":"x","transport":"stdio","command":"npx"}]}`},
		{"settings PICOAIDE_ 前缀",
			`{"settings":[{"key":"PICOAIDE_CONNECTOR_ACCESS_TOKEN"}],"mcp":[{"serverName":"x","transport":"stdio","command":"npx"}]}`},
		{"settings 小写 dsh_ 前缀 + 空白",
			`{"settings":[{"key":" dsh_home "}],"mcp":[{"serverName":"x","transport":"stdio","command":"npx"}]}`},
		{"tokenFields 元素不是对象",
			`{"tokenFields":["NODE_OPTIONS"],"mcp":[{"serverName":"x","transport":"stdio","command":"npx"}]}`},
		{"settings 元素缺 key",
			`{"settings":[{"label":"no key"}],"mcp":[{"serverName":"x","transport":"stdio","command":"npx"}]}`},
		{"tokenFields key 非字符串",
			`{"tokenFields":[{"key":123}],"mcp":[{"serverName":"x","transport":"stdio","command":"npx"}]}`},
	}
	for _, tc := range rejected {
		c := &Connector{ID: "policy", Name: "Policy", AuthMode: "token", Definition: tc.definition}
		if err := validateConnector(c); !errors.Is(err, ErrValidation) {
			t.Errorf("%s: err = %v, want ErrValidation(基线放行 = 可注入受保护环境变量)", tc.name, err)
		}
	}
}

// TestConnectorCredentialFieldKeysAccepted: 合法定义(含 0042 三个真实种子)
// 必须继续通过 —— 收紧 denylist 不得误伤既有连接器。
func TestConnectorCredentialFieldKeysAccepted(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	// 0042 种子:moka / glitchtip / sales-easy 的真实 DB 行。
	seeds, err := ListConnectors(db)
	if err != nil {
		t.Fatalf("list connectors: %v", err)
	}
	if len(seeds) < 3 {
		t.Fatalf("0042 种子 = %d 行, want >= 3", len(seeds))
	}
	for i := range seeds {
		if err := validateConnector(&seeds[i]); err != nil {
			t.Errorf("0042 种子 %s 被新校验误拒: %v", seeds[i].ID, err)
		}
	}

	// 本地声明的合法字段名(含大小写/前缀相似但非受保护)。
	accepted := []struct {
		name       string
		definition string
	}{
		{"token + settings 合法字段",
			`{"tokenFields":[{"key":"GLITCHTIP_TOKEN","label":"Token","type":"password","required":true}],"settings":[{"key":"GLITCHTIP_ORGANIZATION","label":"组织","type":"text","required":true}],"mcp":[{"serverName":"glitchtip","transport":"stdio","command":"npx","args":["-y","glitchtip-mcp"]}]}`},
		{"小写自有键", `{"settings":[{"key":"my_setting"}],"mcp":[{"serverName":"x","transport":"stdio","command":"npx"}]}`},
		{"DSH / NODE 前缀相似但不在 denylist", `{"settings":[{"key":"DSH"},{"key":"NODE"}],"mcp":[{"serverName":"x","transport":"stdio","command":"npx"}]}`},
		{"streamable-http 也带合法字段", `{"tokenFields":[{"key":"CRM_TOKEN"}],"mcp":[{"serverName":"x","transport":"streamable-http","url":"https://mcp.example.com"}]}`},
	}
	for _, tc := range accepted {
		c := &Connector{ID: "policy", Name: "Policy", AuthMode: "token", Definition: tc.definition}
		if err := validateConnector(c); err != nil {
			t.Errorf("%s: err = %v, want nil", tc.name, err)
		}
	}
}

// TestConnectorCredentialFieldKeysPersisted: 拒绝必须真的挡住落库
// (走真 PG 的 CreateConnector),不是只在单测里拒绝。
func TestConnectorCredentialFieldKeysPersisted(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	c := &Connector{ID: "evil-cred", Name: "Evil", AuthMode: "token",
		Definition: `{"tokenFields":[{"key":"NODE_OPTIONS","label":"x"}],"mcp":[{"serverName":"evil","transport":"stdio","command":"npx"}]}`}
	if err := CreateConnector(db, c); !errors.Is(err, ErrValidation) {
		t.Fatalf("CreateConnector err = %v, want ErrValidation", err)
	}
	if _, err := GetConnector(db, "evil-cred"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("被拒的连接器仍然落库: err = %v", err)
	}

	// 合法字段名照常落库(同一路径,防"一律拒绝"式修复)。
	ok := &Connector{ID: "ok-cred", Name: "OK", AuthMode: "token",
		Definition: `{"tokenFields":[{"key":"CRM_TOKEN","label":"Token"}],"mcp":[{"serverName":"ok","transport":"stdio","command":"npx"}]}`}
	if err := CreateConnector(db, ok); err != nil {
		t.Fatalf("合法 tokenFields 被拒: %v", err)
	}
	if _, err := GetConnector(db, "ok-cred"); err != nil {
		t.Fatalf("合法 tokenFields 未落库: %v", err)
	}
}

// TestConnectorDeniedEnvKeysMatchClientPolicy 是防漂移守卫:服务端 denylist 必须
// 与客户端唯一策略源 packages/host/connectors/src/policy.ts 的
// DENIED_ENV_KEYS + DENIED_ENV_PREFIXES **逐条**一致(任一侧增删键而不同步 →
// 本用例失败)。与 serverauth 的跨语言契约守卫同一口径:独立构建 server 目录
// 时文件不可达 → Skip。
func TestConnectorDeniedEnvKeysMatchClientPolicy(t *testing.T) {
	keys, prefixes := clientPolicyDeniedEnv(t)
	if len(keys) == 0 || len(prefixes) == 0 {
		t.Fatal("未能从 policy.ts 解析 DENIED_ENV_KEYS / DENIED_ENV_PREFIXES")
	}
	serverKeys := make([]string, 0, len(connectorDeniedEnvKeys))
	for k := range connectorDeniedEnvKeys {
		serverKeys = append(serverKeys, strings.ToUpper(k))
	}
	sort.Strings(serverKeys)
	sort.Strings(keys)
	if strings.Join(serverKeys, ",") != strings.Join(keys, ",") {
		t.Fatalf("denylist 漂移:\n server = %v\n client = %v\n"+
			"两侧必须同步(server/internal/serverstore/connectors.go ↔ packages/host/connectors/src/policy.ts)",
			serverKeys, keys)
	}
	serverPrefixes := append([]string(nil), connectorDeniedEnvPrefixes...)
	sort.Strings(serverPrefixes)
	if strings.Join(serverPrefixes, ",") != strings.Join(prefixes, ",") {
		t.Fatalf("denylist 前缀漂移:\n server = %v\n client = %v", serverPrefixes, prefixes)
	}

	// 规则本身也必须同源:大小写不敏感 + trim。
	for _, key := range []string{" node_options ", "\tPath\n", "Dsh_Home", " electron_run_as_node "} {
		if connectorEnvKeyAllowed(key) {
			t.Errorf("connectorEnvKeyAllowed(%q) = true, want false(trim + 大小写不敏感)", key)
		}
	}
	for _, key := range []string{"", "   ", "\t", "PATH", "path"} {
		if connectorEnvKeyAllowed(key) {
			t.Errorf("connectorEnvKeyAllowed(%q) = true, want false(空键/受保护键)", key)
		}
	}
}

// clientPolicyDeniedEnv 从客户端 policy.ts 解析两份清单(仓库内相对路径,
// 与 serverauth/usage_contract_test.go 的跨语言契约守卫同一候选路径口径)。
func clientPolicyDeniedEnv(t *testing.T) (keys, prefixes []string) {
	t.Helper()
	rel := filepath.Join("packages", "host", "connectors", "src", "policy.ts")
	candidates := []string{
		filepath.Join("..", "..", "..", rel),
		filepath.Join("..", "..", rel),
	}
	var raw []byte
	var err error
	for _, c := range candidates {
		if raw, err = os.ReadFile(c); err == nil {
			break
		}
	}
	if err != nil {
		t.Skipf("客户端 policy.ts 不可达(独立构建 server 目录时跳过): %v", err)
	}
	keys = tsStringLiterals(t, raw, `(?s)DENIED_ENV_KEYS[^=]*=\s*new Set\(\[(.*?)\]\)`)
	prefixes = tsStringLiterals(t, raw, `(?s)DENIED_ENV_PREFIXES[^=]*=\s*\[(.*?)\]`)
	keys = dedupeUpper(keys)
	prefixes = dedupeUpper(prefixes)
	return keys, prefixes
}

// tsStringLiterals 取出正则捕获组里的单引号字符串字面量(忽略注释行)。
func tsStringLiterals(t *testing.T, raw []byte, pattern string) []string {
	t.Helper()
	m := regexp.MustCompile(pattern).FindSubmatch(raw)
	if m == nil {
		t.Fatalf("policy.ts 中找不到 %s", pattern)
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

func dedupeUpper(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, s := range in {
		u := strings.ToUpper(strings.TrimSpace(s))
		if u == "" || seen[u] {
			continue
		}
		seen[u] = true
		out = append(out, u)
	}
	return out
}
