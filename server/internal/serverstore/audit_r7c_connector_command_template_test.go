package serverstore

// R7 第三轮复核 N-3(P1,executed-repro):F-6 为解开误伤而打开了**真实代码执行面**。
//
// 第二轮把 PAGER/GIT_PAGER/EDITOR/VISUAL/GIT_EDITOR/GIT_SEQUENCE_EDITOR 移出
// denylist,理由是"这一族命名的是子进程用来分页/编辑的**程序**"。前半句只对
// **值恰好是一个程序名**时成立:git 把 GIT_EDITOR/EDITOR/GIT_SEQUENCE_EDITOR
// 交给 `sh -c` 执行,而**无 TTY 也执行**(MCP stdio 子进程拿到的正是管道而不是
// pty)。复核员实测 `GIT_EDITOR='sh -c "id > f"'` 以子进程权限落地;本批次补充
// 实测 `GIT_SEQUENCE_EDITOR` 同样在无 TTY 下执行(`git rebase -i`,夹具已有
// HEAD~2),`MANPAGER`/`PAGER` 在有 TTY 时执行,`LESSOPEN` 在**无 TTY**下执行。
//
// 修法:按**值**分级(而不是按键分级,也不是把 6 个键改回 denylist —— 那会让
// `EDITOR=vim` 也不可用,正是 F-6 要避免的误伤):
//   - 命令模板族 = 显式 6 键 ∪ 一切 `*PAGER` / `*EDITOR` 拼写(只封名单正是
//     "换个写法就穿透"的形态:MANPAGER/SYSTEMD_PAGER/SVN_EDITOR 都是同一个钩子);
//   - 值必须是单个程序名:字符合集只有 ASCII 字母数字 + `_ . / \ : + -`
//     (无任何空白 ⇒ 一个 argv[0] 不会变成一整条命令行),basename 不得是命令
//     解释器(`EDITOR=sh` 会让 git 把"被编辑的文件"当脚本执行);
//   - `LESSOPEN`/`LESSCLOSE` 是 `less` 执行的命令模板(%s/%t),在无 TTY 下实测
//     执行 ⇒ 与 BROWSER 同形,硬拒绝。
//
// 两侧(policy.ts ↔ connectors.go)必须同判,否则就是"管理端保存成功、员工端
// 静默丢弃",本文件的 TestConnectorCommandTemplatePolicyMatchesClientPolicy
// 逐字守卫。

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"testing"
)

// connectorCommandTemplateTierKeys 是被值分级的显式层(第二轮 F-6 开放的 6 键)。
var connectorCommandTemplateTierKeys = []string{
	"PAGER", "GIT_PAGER", "EDITOR", "VISUAL", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR",
}

// connectorCommandTemplateAliasKeys 是**同一个钩子的另一种拼写**(不在显式层,
// 但必须被形状判据覆盖;否则"把 EDITOR 的活交给另一个未封禁键"即可绕过)。
var connectorCommandTemplateAliasKeys = []string{
	"MANPAGER", "SYSTEMD_PAGER", "PSQL_PAGER", "MYSQL_PAGER", "BAT_PAGER",
	"SVN_EDITOR", "HGEDITOR", "NPM_CONFIG_EDITOR",
}

// connectorCommandTemplateShellValues 是同一个载荷的各种等价写法。
var connectorCommandTemplateShellValues = []string{
	`sh -c "id > /tmp/pwned"`, // 复核员实测的 RCE 形态
	`vim -c ":!id"`,           // 不含元字符,但已是多条 argv
	`sh ""`,                   // "sh + 空参数"
	`sh -c id`,
	`vim;id`, `vim|id`, `vim&&id`, `vim||id`, `vim&`,
	`vim>out`, `vim<in`, `vim>>out`,
	`vim$(id)`, "vim`id`", `vim$IFS`, `${IFS}vim`,
	"vim\nid", "vim\r\nid", "vim\tid", " vim", "vim ",
	"vim\u00a0id", "vim\u200bid", "vim\u3000id", "vim\u2028id",
	`vim%sid`, `vim%s`, `vim%s%s`,
	`"vim"`, `'vim'`, "vim #c", `vim!`, `vim~`, `vim*`, `vim?`, `vim[0]`,
	`vim(id)`, `vim{id}`, `vim=id`, `vim@id`, `vim,id`, `vim\`,
	`~/bin/vim`, `$EDITOR`, ``, `/usr/bin/`,
}

// connectorCommandTemplateSafeValues 是必须继续可用的合法值(F-6 的成果)。
var connectorCommandTemplateSafeValues = []string{
	"less", "more", "cat", "vim", "vi", "nano", "emacs", "code", "true", "false",
	"/usr/bin/less", "/usr/local/bin/nvim", `C:\tools\vim.exe`, "notepad.exe",
	"bat", "delta", "emacsclient", "less.exe", "my_pager", "pager-2",
}

// connectorCommandTemplateInterpreterProbes 是"单 token 但仍然是解释器"的 basename
// (生产表 connectorCommandTemplateInterpreters 的探针副本,故意不共用变量:删掉
// 生产表里的一行一定会让本用例变红)。
var connectorCommandTemplateInterpreterProbes = []string{
	"sh", "SH", "./sh", "/bin/sh", "bash", "dash", "zsh", "fish", "busybox",
	`C:\Windows\System32\cmd.exe`, "cmd", "powershell", "powershell.exe", "pwsh.exe",
	"python3", "python", "python3.12", "python.exe", "perl", "perl5.36", "ruby", "ruby3.2",
	"node", "node20", "node.exe", "nodejs", "php", "php8.2", "lua", "lua5.4",
	"tclsh8.6", "osascript", "mshta", "mshta.exe", "bash5", "wscript.exe",
}

// connectorEnvDefinition 生成一份只带一个 mcp.env 条目的定义 JSON。
func connectorEnvDefinition(t *testing.T, key, value string) string {
	t.Helper()
	raw, err := json.Marshal(map[string]any{
		"mcp": []any{map[string]any{
			"serverName": "sel",
			"transport":  "stdio",
			"command":    "npx",
			"env":        map[string]any{key: value},
		}},
	})
	if err != nil {
		t.Fatalf("marshal definition: %v", err)
	}
	return string(raw)
}

// TestConnectorCommandTemplateValueGateRejectsShellTemplates:每一个"命令模板"
// 键 × 每一种 shell 等价写法都必须被 validateConnector 拒绝(服务端放行 =
// 定义落库 = 员工端子进程执行)。
func TestConnectorCommandTemplateValueGateRejectsShellTemplates(t *testing.T) {
	keys := append(append([]string{}, connectorCommandTemplateTierKeys...), connectorCommandTemplateAliasKeys...)
	for _, key := range keys {
		// 键形状:全部命中命令模板族(显式层或 *PAGER/*EDITOR 拼写)。
		if !connectorCommandTemplateKey(key) {
			t.Errorf("connectorCommandTemplateKey(%q) = false, want true(命令模板族漏判)", key)
		}
		for _, value := range connectorCommandTemplateShellValues {
			if connectorCommandTemplateValueAllowed(key, value) {
				t.Errorf("connectorCommandTemplateValueAllowed(%q, %q) = true, want false", key, value)
			}
			c := &Connector{ID: "policy", Name: "Policy", AuthMode: "token",
				Definition: connectorEnvDefinition(t, key, value)}
			if err := validateConnector(c); !errors.Is(err, ErrValidation) {
				t.Errorf("%s=%q: err = %v, want ErrValidation(服务端收下 = 客户端丢弃)", key, value, err)
			}
		}
		// 合法值不得误伤(F-6 的成果必须保住)。
		for _, value := range connectorCommandTemplateSafeValues {
			if !connectorCommandTemplateValueAllowed(key, value) {
				t.Errorf("connectorCommandTemplateValueAllowed(%q, %q) = false, want true(合法值误伤)", key, value)
			}
			c := &Connector{ID: "policy", Name: "Policy", AuthMode: "token",
				Definition: connectorEnvDefinition(t, key, value)}
			if err := validateConnector(c); err != nil {
				t.Errorf("%s=%q: err = %v, want nil(合法定义被拒)", key, value, err)
			}
		}
		// 大小写/空白变形是同一个变量(Windows 环境名不区分大小写)。
		if connectorCommandTemplateValueAllowed(" "+strings.ToLower(key)+" ", "sh -c id") {
			t.Errorf("%q 的变形绕过了值分级", key)
		}
		if !connectorCommandTemplateValueAllowed(" "+strings.ToLower(key)+" ", "vim") {
			t.Errorf("%q 的合法值被误伤", key)
		}
	}
}

// TestConnectorCommandTemplateKeyShape:形状判据必须覆盖 `*PAGER`/`*EDITOR`
// 的所有拼写,而**不得**把无关键卷进来(后者会平白制造"管理端保存失败")。
func TestConnectorCommandTemplateKeyShape(t *testing.T) {
	for _, key := range []string{"EDITOR", "editor", " EDITOR ", "GIT_EDITOR", "MANPAGER",
		"systemd_pager", "SVN_EDITOR", "hgEditor", "NPM_CONFIG_EDITOR", "GIT_SEQUENCE_EDITOR"} {
		if !connectorCommandTemplateKey(key) {
			t.Errorf("connectorCommandTemplateKey(%q) = false, want true", key)
		}
	}
	for _, key := range []string{"", "   ", "GLITCHTIP_ORGANIZATION", "CRM_TOKEN", "KEEP",
		"EDITORIAL", "PAGERS", "VISUALS", "NODE_OPTIONS", "DSH_HOME"} {
		if connectorCommandTemplateKey(key) {
			t.Errorf("connectorCommandTemplateKey(%q) = true, want false(无关键被卷入值分级)", key)
		}
		if !connectorCommandTemplateValueAllowed(key, `sh -c "id"`) {
			t.Errorf("connectorCommandTemplateValueAllowed(%q, …) = false, want true(无关键的值不该被本判据管)", key)
		}
	}
}

// TestConnectorCommandTemplateInterpreterBasenames:单 token 的解释器同样拒绝
// (`GIT_EDITOR=sh` 会让 git 把被"编辑"的文件当脚本执行),而近似拼写不误伤。
func TestConnectorCommandTemplateInterpreterBasenames(t *testing.T) {
	for _, value := range connectorCommandTemplateInterpreterProbes {
		if connectorCommandTemplateValueAllowed("EDITOR", value) {
			t.Errorf("EDITOR=%q 是命令解释器,不应放行", value)
		}
		c := &Connector{ID: "policy", Name: "Policy", AuthMode: "token",
			Definition: connectorEnvDefinition(t, "EDITOR", value)}
		if err := validateConnector(c); !errors.Is(err, ErrValidation) {
			t.Errorf("EDITOR=%q: err = %v, want ErrValidation", value, err)
		}
	}
	for _, value := range []string{"shell", "pythonista", "node_modules_tool", "cmdlet", "vim", "nano", "true"} {
		if !connectorCommandTemplateValueAllowed("EDITOR", value) {
			t.Errorf("EDITOR=%q 不是解释器,被误伤", value)
		}
	}
}

// TestConnectorLessopenEquivalentChannelDenied:N-3 自查发现的**等价通道** ——
// `less` 会把 LESSOPEN 当命令模板执行(%s 替换),且实测在**无 TTY 的管道进程**
// 里同样执行:`LESSOPEN='|sh -c "id > flag" %s' less <file>` 落地。它与 BROWSER
// 同形(命令模板,不是"选一个程序"),必须在 denylist 里。
func TestConnectorLessopenEquivalentChannelDenied(t *testing.T) {
	for _, key := range []string{"LESSOPEN", "LESSCLOSE", "lessopen", " lessclose "} {
		if connectorEnvKeyAllowed(key) {
			t.Errorf("connectorEnvKeyAllowed(%q) = true, want false(LESSOPEN 族是命令模板)", key)
		}
		c := &Connector{ID: "policy", Name: "Policy", AuthMode: "token",
			Definition: connectorEnvDefinition(t, key, `|sh -c "id > /tmp/pwned" %s`)}
		if err := validateConnector(c); !errors.Is(err, ErrValidation) {
			t.Errorf("%s: err = %v, want ErrValidation", key, err)
		}
	}
}

// TestConnectorCommandTemplateValueGateBlocksPersistence:拒绝必须真的挡住落库
// (走真 PG 的 CreateConnector),同时合法值照常落库 —— 防"一律拒绝"式修复。
func TestConnectorCommandTemplateValueGateBlocksPersistence(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	evil := []*Connector{
		{ID: "evil-editor", Name: "Evil", AuthMode: "token",
			Definition: connectorEnvDefinition(t, "GIT_EDITOR", `sh -c "id > /tmp/pwned"`)},
		{ID: "evil-pager", Name: "Evil", AuthMode: "token",
			Definition: connectorEnvDefinition(t, "PAGER", "vim;id")},
		{ID: "evil-alias", Name: "Evil", AuthMode: "token",
			Definition: connectorEnvDefinition(t, "MANPAGER", `sh -c "id"`)},
	}
	for _, c := range evil {
		if err := CreateConnector(db, c); !errors.Is(err, ErrValidation) {
			t.Fatalf("CreateConnector(%s) err = %v, want ErrValidation", c.ID, err)
		}
		if _, err := GetConnector(db, c.ID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("被拒的连接器 %s 仍然落库: err = %v", c.ID, err)
		}
	}

	ok := &Connector{ID: "ok-editor", Name: "OK", AuthMode: "token",
		Definition: connectorEnvDefinition(t, "GIT_EDITOR", "vim")}
	if err := CreateConnector(db, ok); err != nil {
		t.Fatalf("合法 GIT_EDITOR=vim 被拒: %v", err)
	}
	if _, err := GetConnector(db, ok.ID); err != nil {
		t.Fatalf("合法连接器未落库: %v", err)
	}
}

// TestConnectorCommandTemplatePolicyMatchesClientPolicy 是防漂移守卫:值分级的
// 两个数据源(字符合集、解释器 basename 表)必须与客户端唯一策略源
// packages/host/connectors/src/policy.ts 的 SELECTOR_VALUE_ALLOWED_CHARS /
// SELECTOR_INTERPRETER_TOKENS **逐字**一致,且键形状判据(后缀规则)两侧同在。
// 独立构建 server 目录时 policy.ts 不可达 → Skip。
func TestConnectorCommandTemplatePolicyMatchesClientPolicy(t *testing.T) {
	raw := clientPolicySource(t)

	m := regexp.MustCompile(`(?s)SELECTOR_VALUE_ALLOWED_CHARS[^=]*=\s*'([^']*)'`).FindSubmatch(raw)
	if m == nil {
		t.Fatal("policy.ts 中找不到 SELECTOR_VALUE_ALLOWED_CHARS 字面量")
	}
	clientChars := strings.ReplaceAll(string(m[1]), `\\`, `\`)
	if clientChars != connectorCommandTemplateAllowedChars {
		t.Fatalf("命令模板值字符合集漂移:\n server = %q\n client = %q\n"+
			"两侧必须同步(server/internal/serverstore/connectors.go ↔ packages/host/connectors/src/policy.ts)",
			connectorCommandTemplateAllowedChars, clientChars)
	}
	if !strings.Contains(clientChars, `\`) || strings.ContainsAny(clientChars, " \t\n") {
		t.Fatalf("字符合集本身不合契约(需含反斜杠路径分隔符、且不得含空白): %q", clientChars)
	}

	clientTokens := tsStringLiterals(t, raw, `(?s)SELECTOR_INTERPRETER_TOKENS[^=]*=\s*\[(.*?)\]`)
	if strings.Join(clientTokens, ",") != strings.Join(connectorCommandTemplateInterpreters, ",") {
		t.Fatalf("解释器 basename 表漂移:\n server = %v\n client = %v",
			connectorCommandTemplateInterpreters, clientTokens)
	}

	// 键形状判据:两侧都必须按 `*PAGER` / `*EDITOR` 后缀判,而不是只认一个名单。
	for _, needle := range []string{"endsWith('PAGER')", "endsWith('EDITOR')"} {
		if !strings.Contains(string(raw), needle) {
			t.Fatalf("policy.ts 的键形状判据缺少 %s(只封名单 = 换个拼写就穿透)", needle)
		}
	}
	if !strings.Contains(string(raw), "isDeniedEnvEntry(key, value)") {
		t.Fatal("policy.ts 的 sanitizeMcpEnv 没有接入值分级 isDeniedEnvEntry(本地注入通道会静默放行)")
	}
}
