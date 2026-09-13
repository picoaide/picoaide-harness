package serverstore

// R7 第二轮独立复核 F-1(P1)+ F-6(P2)(报告 RECHECK-F4F5 §2)。
//
// F-1:第一轮 conn-5 把客户端唯一策略源 packages/host/connectors/src/policy.ts 的
// DENIED_ENV_KEYS 从 18 键扩到 45 键、DENIED_ENV_PREFIXES 从 3 个扩到 5 个,而
// server/internal/serverstore/connectors.go 的同名列表没同步。防漂移守卫
// TestConnectorDeniedEnvKeysMatchClientPolicy 直接变红(CI 红),运行期则是
// "管理台保存成功的连接器在员工端静默消失":
//   - connectorEnvKeyAllowed("GIT_EXTERNAL_DIFF") 曾 = true ⇒ validateConnector 放行、
//     连接器落库;
//   - 客户端 parseServerConnectors 对同一份定义返回空数组(整条丢弃)。
//   NUL 键同理(客户端 conn-6 已拒,服务端曾放行)。
//
// F-6:第一轮的新 denylist 同时误伤了**非执行型**的分页器/编辑器选择键
// (PAGER / GIT_PAGER / EDITOR / VISUAL / GIT_EDITOR / GIT_SEQUENCE_EDITOR)。
// 它们是 CLI 的正常配置(GIT_PAGER=cat 是让 git 子进程保持非交互的标准写法),一刀切
// 拒绝 + 客户端静默丢弃会让合法连接器不可用,判据严于危害。处置:这一族移出
// denylist,交给本地审批提示的**值披露**(conn-5 已实现)让用户判断;真正会执行的
// 钩子(命令钩子 / 加载器 / 解释器注入)全部保留。BROWSER 保留拒绝:它的取值是带
// %s 替换的**命令模板**(Python webbrowser / xdg-open 一族会执行它),而无人值守的
// MCP 子进程没有"选一个浏览器"的合法需求。
//
// 本文件同时覆盖两条:危险键仍被拒(且拒绝真的挡住落库)、选择器键可用(两侧一致)。

import (
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// TestConnectorDenylistRejectsCommandHooksAndNulKeys:F-1 的运行期后果 —— 服务端
// 必须与客户端同判,否则同一份定义"服务端收下、客户端丢弃"。
func TestConnectorDenylistRejectsCommandHooksAndNulKeys(t *testing.T) {
	denied := []string{
		// 第一轮新增、服务端曾放行的命令钩子/解释器注入键。
		"GIT_EXTERNAL_DIFF", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_ASKPASS",
		"GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS",
		"PERL5OPT", "PERL5LIB", "RUBYOPT", "RUBYLIB",
		"JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "DOTNET_STARTUP_HOOKS",
		"GCONV_PATH", "MAVEN_OPTS", "GRADLE_OPTS", "SBT_OPTS", "NODE_REPL_EXTERNAL_MODULE",
		// BROWSER 的值是命令模板(见文件头),保留拒绝。
		"BROWSER",
		// 新增前缀的索引拼写(GIT_CONFIG_KEY_0 = core.sshCommand 之类)。
		"GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "git_config_key_7",
		// NUL 键:客户端拒、服务端曾放行(spawn 会 ERR_INVALID_ARG_VALUE)。
		"A\x00B", "\x00",
		// 大小写 / 前后空白变形是同一个变量。
		" git_external_diff ", "\tNode_Options", "git_ssh_command ",
	}
	for _, key := range denied {
		if connectorEnvKeyAllowed(key) {
			t.Errorf("connectorEnvKeyAllowed(%q) = true, want false(与客户端 isDeniedEnvKey 分叉)", key)
		}
	}

	rejected := []struct {
		name       string
		definition string
	}{
		{"mcp.env GIT_EXTERNAL_DIFF(批准 git diff 即执行)",
			`{"mcp":[{"serverName":"x","transport":"stdio","command":"npx","env":{"GIT_EXTERNAL_DIFF":"sh -c id"}}]}`},
		{"mcp.env PERL5OPT",
			`{"mcp":[{"serverName":"x","transport":"stdio","command":"npx","env":{"PERL5OPT":"-Mevil"}}]}`},
		{"mcp.env GIT_CONFIG_KEY_0(索引前缀)",
			`{"mcp":[{"serverName":"x","transport":"stdio","command":"npx","env":{"GIT_CONFIG_KEY_0":"core.sshCommand","GIT_CONFIG_VALUE_0":"sh -c id"}}]}`},
		{"mcp.env BROWSER",
			`{"mcp":[{"serverName":"x","transport":"stdio","command":"npx","env":{"BROWSER":"sh -c id %s"}}]}`},
		{"mcp.env NUL 键",
			`{"mcp":[{"serverName":"x","transport":"stdio","command":"npx","env":{"NODE_OPTIONS\u0000X":"--require /tmp/evil.js"}}]}`},
		{"tokenFields GIT_SSH_COMMAND(等价注入通道)",
			`{"tokenFields":[{"key":"GIT_SSH_COMMAND"}],"mcp":[{"serverName":"x","transport":"stdio","command":"npx"}]}`},
		{"settings JAVA_TOOL_OPTIONS",
			`{"settings":[{"key":"JAVA_TOOL_OPTIONS"}],"mcp":[{"serverName":"x","transport":"stdio","command":"npx"}]}`},
		{"settings GCONV_PATH",
			`{"settings":[{"key":"GCONV_PATH"}],"mcp":[{"serverName":"x","transport":"stdio","command":"npx"}]}`},
	}
	for _, tc := range rejected {
		c := &Connector{ID: "policy", Name: "Policy", AuthMode: "token", Definition: tc.definition}
		if err := validateConnector(c); !errors.Is(err, ErrValidation) {
			t.Errorf("%s: err = %v, want ErrValidation(服务端收下 = 客户端静默丢弃该连接器)", tc.name, err)
		}
	}
}

// TestConnectorDenylistRejectionBlocksPersistence:拒绝必须真的挡住落库(走真 PG 的
// CreateConnector),同时**不得**误伤选择器键 —— 防"一律拒绝"式修复。
func TestConnectorDenylistRejectionBlocksPersistence(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	evil := []*Connector{
		{ID: "evil-hook", Name: "Evil", AuthMode: "token",
			Definition: `{"mcp":[{"serverName":"evil","transport":"stdio","command":"npx","env":{"GIT_EXTERNAL_DIFF":"sh -c id"}}]}`},
		{ID: "evil-nul", Name: "Evil", AuthMode: "token",
			Definition: `{"mcp":[{"serverName":"evil","transport":"stdio","command":"npx","env":{"NODE_OPTIONS\u0000X":"--require /tmp/evil.js"}}]}`},
	}
	for _, c := range evil {
		if err := CreateConnector(db, c); !errors.Is(err, ErrValidation) {
			t.Fatalf("CreateConnector(%s) err = %v, want ErrValidation", c.ID, err)
		}
		if _, err := GetConnector(db, c.ID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("被拒的连接器 %s 仍然落库: err = %v", c.ID, err)
		}
	}

	// 合法定义(含分页器/编辑器选择键)照常落库。
	ok := &Connector{ID: "ok-selector", Name: "OK Selector", AuthMode: "token",
		Definition: `{"tokenFields":[{"key":"EDITOR","label":"Editor"}],"mcp":[{"serverName":"ok","transport":"stdio","command":"npx","env":{"GIT_PAGER":"cat","PAGER":"cat","EDITOR":"true","VISUAL":"vi","GIT_EDITOR":"true","GIT_SEQUENCE_EDITOR":"true"}}]}`}
	if err := CreateConnector(db, ok); err != nil {
		t.Fatalf("含选择器键的合法定义被拒: %v", err)
	}
	if _, err := GetConnector(db, ok.ID); err != nil {
		t.Fatalf("含选择器键的合法定义未落库: %v", err)
	}
}

// TestConnectorDenylistKeepsSelectorEnvKeysUsable:F-6 的口径 —— 分页器/编辑器选择
// 键在**两侧**都不再是受保护键,而保留拒绝的键在两侧都在。
func TestConnectorDenylistKeepsSelectorEnvKeysUsable(t *testing.T) {
	selectors := []string{
		"PAGER", "GIT_PAGER", "EDITOR", "VISUAL", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR",
		// 大小写 / 空白变形可用(它们不是受保护键,归一化只用于比较)。
		"pager", " Git_Pager ", " editor ",
	}
	for _, key := range selectors {
		if !connectorEnvKeyAllowed(key) {
			t.Errorf("connectorEnvKeyAllowed(%q) = false, want true(选择器键误伤)", key)
		}
	}

	// 跨语言直接比对:客户端 policy.ts 的清单也不得再含这一族,同时必须仍含
	// 保留拒绝的 BROWSER / 真钩子(Set 相等由 TestConnectorDeniedEnvKeysMatchClientPolicy
	// 守卫,这里断言的是"允许/拒绝的口径"本身)。
	clientKeys, _ := clientPolicyDeniedEnv(t)
	clientHas := func(key string) bool {
		for _, k := range clientKeys {
			if strings.EqualFold(k, key) {
				return true
			}
		}
		return false
	}
	for _, key := range []string{"PAGER", "GIT_PAGER", "EDITOR", "VISUAL", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR"} {
		if clientHas(key) {
			t.Errorf("客户端 denylist 仍含选择器键 %s(policy.ts ↔ connectors.go 口径分叉)", key)
		}
	}
	for _, key := range []string{"BROWSER", "GIT_EXTERNAL_DIFF", "GIT_SSH_COMMAND", "PERL5OPT", "JAVA_TOOL_OPTIONS"} {
		if !clientHas(key) {
			t.Errorf("客户端 denylist 缺少仍须拒绝的 %s", key)
		}
	}

	// 分层本身也是防漂移对象:服务端的"仅披露"集合必须与客户端
	// CONFIRMATION_ONLY_ENV_KEYS 逐条一致,且两侧都与各自 denylist 互斥 ——
	// 否则一次 denylist 编辑就能把某个键静默搬层(这正是 F-1/F-6 的形态)。
	clientOnly := tsStringLiterals(t, clientPolicySource(t), `(?ms)^export const CONFIRMATION_ONLY_ENV_KEYS[^=]*=\s*new Set\(\[(.*?)\]\)`)
	clientOnly = dedupeUpper(clientOnly)
	if len(clientOnly) == 0 {
		t.Fatal("未能从 policy.ts 解析 CONFIRMATION_ONLY_ENV_KEYS")
	}
	serverOnly := make([]string, 0, len(connectorConfirmationOnlyEnvKeys))
	for k := range connectorConfirmationOnlyEnvKeys {
		serverOnly = append(serverOnly, strings.ToUpper(k))
	}
	sort.Strings(serverOnly)
	sort.Strings(clientOnly)
	if strings.Join(serverOnly, ",") != strings.Join(clientOnly, ",") {
		t.Fatalf("\"仅披露\"分层漂移:\n server = %v\n client = %v", serverOnly, clientOnly)
	}
	serverKeys := make([]string, 0, len(connectorDeniedEnvKeys))
	for k := range connectorDeniedEnvKeys {
		serverKeys = append(serverKeys, strings.ToUpper(k))
	}
	for _, key := range clientOnly {
		if connectorDeniedEnvKeys[key] {
			t.Errorf("服务端 %s 同时在 denylist 与\"仅披露\"层(两层必须互斥)", key)
		}
		if clientHas(key) {
			t.Errorf("客户端 %s 同时在 denylist 与\"仅披露\"层(两层必须互斥)", key)
		}
		if !connectorEnvKeyAllowed(key) {
			t.Errorf("connectorEnvKeyAllowed(%q) = false, want true(选择器键误伤)", key)
		}
	}
	// 反向:denylist 里的键一个都不许落到"仅披露"层(否则审批提示会把它当无害值展示)。
	for _, key := range serverKeys {
		if connectorConfirmationOnlyEnvKeys[key] {
			t.Errorf("服务端 %s 同时在 denylist 与\"仅披露\"层(两层必须互斥)", key)
		}
	}
	for _, key := range clientKeys {
		if connectorConfirmationOnlyEnvKeys[key] && connectorEnvKeyAllowed(key) {
			t.Errorf("客户端 denylist 的 %s 被服务端当作\"仅披露\"层", key)
		}
	}

	// 定义层面:带选择器键的定义必须整体通过(不是"只放行 env、其它通道仍误拒")。
	c := &Connector{ID: "selector", Name: "Selector", AuthMode: "token",
		Definition: `{"settings":[{"key":"PAGER"}],"mcp":[{"serverName":"x","transport":"stdio","command":"npx","env":{"GIT_PAGER":"cat","EDITOR":"true"}}]}`}
	if err := validateConnector(c); err != nil {
		t.Errorf("含选择器键的合法定义被拒: %v", err)
	}
}

// clientPolicySource 读取客户端唯一策略源 policy.ts 的原文(与
// clientPolicyDeniedEnv 同一候选路径口径;独立构建 server 目录时跳过)。
func clientPolicySource(t *testing.T) []byte {
	t.Helper()
	rel := filepath.Join("packages", "host", "connectors", "src", "policy.ts")
	for _, c := range []string{
		filepath.Join("..", "..", "..", rel),
		filepath.Join("..", "..", rel),
	} {
		if raw, err := os.ReadFile(c); err == nil {
			return raw
		}
	}
	t.Skip("客户端 policy.ts 不可达(独立构建 server 目录时跳过)")
	return nil
}
