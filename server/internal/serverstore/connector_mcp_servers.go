package serverstore

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// 标准 MCP 配置（mcpServers）→ 规范 ConnectorDef 的**唯一**归一化实现。
//
// 背景（2026-10-08）：各厂商给自己的 MCP 服务器写的配置是同一份事实标准
// （Claude Desktop / Cursor / 各家官方文档）：
//
//	{"mcpServers": {"neo-crm": {"type": "streamableHttp", "url": "https://…/mcp"}}}
//
// 而我们的连接器定义（客户端 ConnectorDef）要多两个协议词：mcp[].serverName
// （工具命名空间 mcp__<serverName>__<tool> 的来源）与 transport（stdio 的
// 判别）。管理员不该为了填这两个词去读我们的协议文档，所以**服务端在写入时
// 归一**：库里永远只有规范形状，客户端只需要认一份形状（parseServerConnectors
// 是既有的信任边界，不新增第二条解析路径）。
//
// 归一化只做"形状翻译"，不做策略判定：命令、环境变量、出站 URL 仍由
// validateConnector → validateConnectorMCP/validateStdioServer 逐条把关
// （denylist 与出站策略的判据不在这里复制一份）。

// connectorMCPServerKeys 是标准 MCP 配置里允许出现在单个 server 项上的键。
//
// 未列出的键一律**拒绝**而不是忽略：`{"type":"streamableHttp","url":"…",
// "header":{"X-Key":"…"}}`（少写 s）或 `"alwaysAllow"` 这类键若被静默丢掉，
// 管理员看到的是"保存成功但行为不对"，那正是这个功能要消灭的体验。
var connectorMCPServerKeys = map[string]bool{
	"type": true, "url": true, "headers": true,
	"command": true, "args": true, "env": true,
}

// connectorReservedTopKeys 是规范 ConnectorDef 的顶层键：出现它们就说明这份
// JSON 已经是我们自己的形状（或"标准形状 + 我们的可选字段"），不能再按
// 裸映射（serverName → 项）解释。
var connectorReservedTopKeys = map[string]bool{
	"authMode": true, "auth": true, "tokenFields": true, "settings": true,
	"examples": true, "icon": true, "name": true, "description": true, "mcp": true,
}

// connectorTransportAliases: 标准配置的 type 写法 → 我们的 transport。
//
// 与 webadmin 导入框的别名表是同一份口径（Connectors.tsx 的
// transportAlias）：那份管界面回显，这份管落库。`sse` 故意不在表里 ——
// 客户端只实现了 stdio 与 streamable-http 两种传输（policy.ts 的
// mcpServerProblem），把 sse 映射成 streamable-http 会让一个说 SSE 的
// 端点在我们这里静默降级成"连不上"，不如当场拒绝并点名。
var connectorTransportAliases = map[string]string{
	"streamableHttp":  "streamable-http",
	"streamable-http": "streamable-http",
	"streamable_http": "streamable-http",
	"http":            "streamable-http",
	"stdio":           "stdio",
}

// normalizeConnector 把写入的 definition 归一成规范形状，并让 auth_mode 与
// 定义里的 authMode 自洽。
//
// 规则（行字段优先，与客户端 parseServerConnectors 的 `auth_mode || authMode`
// 同序）：行上给了 auth_mode 就用它并写回定义；行上没给就取定义里的 authMode；
// 两者都没有 → `auto`（"该鉴权鉴权"：连接时按端点自述决定公开/标准 MCP OAuth）。
func normalizeConnector(c *Connector) error {
	if c == nil {
		return ErrValidation
	}
	canonical, declared, err := normalizeConnectorDefinition(c.Definition)
	if err != nil {
		return err
	}
	effective := strings.TrimSpace(c.AuthMode)
	if effective == "" {
		effective = declared
	}
	if effective == "" {
		effective = "auto"
	}
	c.AuthMode = effective
	c.Definition = withAuthMode(canonical, effective)
	return nil
}

// withAuthMode 在规范定义里写入（或改写）顶层 authMode，保持"行字段 == 定义
// 字段"这一条不变量。整份 JSON 会被重新序列化：encoding/json 对 map 按键排序，
// 所以同样的输入永远得到同样的字节（判据可做逐字节比较）。
func withAuthMode(canonical, authMode string) string {
	var top map[string]any
	if err := json.Unmarshal([]byte(canonical), &top); err != nil || top == nil {
		// 归一化的产物必定是可解析的对象；走到这里说明前面的实现坏了。
		return canonical
	}
	top["authMode"] = authMode
	encoded, err := json.Marshal(top)
	if err != nil {
		return canonical
	}
	return string(encoded)
}

// normalizeConnectorDefinition 返回规范形状的 definition 与其中声明的 authMode
// （可能为空 = 未声明）。
//
// 接受的输入：
//   - 规范形状（含 `mcp` 数组）→ 原样返回（**不重排、不加字段**，避免既有行
//     在无关编辑里被改写）；
//   - `{"mcpServers": {…}}`（标准形状，可再带我们的可选键 examples/tokenFields…）；
//   - 裸映射 `{"neo-crm": {…}}`（用户手写时的常见省写）。
func normalizeConnectorDefinition(definition string) (string, string, error) {
	if strings.TrimSpace(definition) == "" {
		return "", "", ErrValidation
	}
	var top map[string]any
	if err := json.Unmarshal([]byte(definition), &top); err != nil || top == nil {
		return "", "", fmt.Errorf("%w: 定义 JSON 无法解析为对象", ErrValidation)
	}
	declared, _ := top["authMode"].(string)
	if raw, present := top["mcp"]; present {
		if _, ok := raw.([]any); !ok {
			return "", "", fmt.Errorf("%w: 定义里的 mcp 必须是数组", ErrValidation)
		}
		// 已是规范形状：原样放行，由 validateConnector 逐条判。
		return definition, declared, nil
	}
	servers, err := mcpServersOf(top)
	if err != nil {
		return "", "", err
	}
	names := make([]string, 0, len(servers))
	for name := range servers {
		names = append(names, name)
	}
	sort.Strings(names)
	entries := make([]any, 0, len(names))
	for _, name := range names {
		raw, ok := servers[name].(map[string]any)
		if !ok {
			return "", "", fmt.Errorf("%w: MCP server %q 的配置必须是对象", ErrValidation, name)
		}
		entry, err := canonicalMCPServerEntry(name, raw)
		if err != nil {
			return "", "", err
		}
		entries = append(entries, entry)
	}
	if len(entries) == 0 {
		return "", "", fmt.Errorf("%w: 没有配置任何 MCP server", ErrValidation)
	}
	out := map[string]any{}
	for key, value := range top {
		if key == "mcpServers" {
			continue
		}
		if _, isServer := servers[key]; isServer {
			continue
		}
		out[key] = value
	}
	out["mcp"] = entries
	encoded, err := json.Marshal(out)
	if err != nil {
		return "", "", fmt.Errorf("%w: 定义无法序列化", ErrValidation)
	}
	return string(encoded), declared, nil
}

// mcpServersOf 取出 serverName → 项 的映射：优先标准形状的 `mcpServers`，
// 其次把顶层本身当映射（裸写法）。
func mcpServersOf(top map[string]any) (map[string]any, error) {
	if raw, present := top["mcpServers"]; present {
		servers, ok := raw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("%w: mcpServers 必须是对象（serverName → 配置）", ErrValidation)
		}
		return servers, nil
	}
	for key := range top {
		if connectorReservedTopKeys[key] {
			return nil, fmt.Errorf(
				"%w: 定义里既没有 mcp 数组也没有 mcpServers 对象（见到的是 %q）", ErrValidation, key)
		}
	}
	if len(top) == 0 {
		return nil, fmt.Errorf("%w: 定义里没有 MCP server", ErrValidation)
	}
	return top, nil
}

// canonicalMCPServerEntry 把一条标准项翻成 mcp[] 的一项。
func canonicalMCPServerEntry(name string, raw map[string]any) (map[string]any, error) {
	if !connectorServerNameRe.MatchString(name) {
		return nil, fmt.Errorf(
			"%w: MCP server 名 %q 不合法（小写字母/数字/连字符，以字母数字开头，≤64 字符）", ErrValidation, name)
	}
	if unknown := unknownMCPServerKeys(raw); len(unknown) > 0 {
		return nil, fmt.Errorf(
			"%w: MCP server %q 含不支持的键 %s（支持 type/url/headers/command/args/env）",
			ErrValidation, name, strings.Join(unknown, ", "))
	}
	transport := ""
	if rawType, present := raw["type"]; present {
		text, ok := rawType.(string)
		if !ok {
			return nil, fmt.Errorf("%w: MCP server %q 的 type 必须是字符串", ErrValidation, name)
		}
		mapped, ok := connectorTransportAliases[text]
		if !ok {
			return nil, fmt.Errorf(
				"%w: MCP server %q 的 type %q 不支持（支持 streamableHttp/http/stdio）", ErrValidation, name, text)
		}
		transport = mapped
	}
	command, _ := raw["command"].(string)
	target, _ := raw["url"].(string)
	hasCommand := strings.TrimSpace(command) != ""
	hasURL := strings.TrimSpace(target) != ""
	if transport == "" {
		switch {
		case hasCommand && hasURL:
			return nil, fmt.Errorf("%w: MCP server %q 同时给了 url 与 command，无法判断传输", ErrValidation, name)
		case hasCommand:
			transport = "stdio"
		case hasURL:
			transport = "streamable-http"
		default:
			return nil, fmt.Errorf("%w: MCP server %q 缺少 url 或 command", ErrValidation, name)
		}
	}
	entry := map[string]any{"serverName": name, "transport": transport}
	switch transport {
	case "streamable-http":
		if !hasURL {
			return nil, fmt.Errorf("%w: MCP server %q 声明为 streamable-http 但没有 url", ErrValidation, name)
		}
		if hasCommand {
			return nil, fmt.Errorf("%w: MCP server %q 声明为 streamable-http 却带了 command", ErrValidation, name)
		}
		entry["url"] = target
		if headers, present := raw["headers"]; present {
			entry["headers"] = headers
		}
	case "stdio":
		if !hasCommand {
			return nil, fmt.Errorf("%w: MCP server %q 声明为 stdio 但没有 command", ErrValidation, name)
		}
		if hasURL {
			return nil, fmt.Errorf("%w: MCP server %q 声明为 stdio 却带了 url", ErrValidation, name)
		}
		entry["command"] = command
		if args, present := raw["args"]; present {
			entry["args"] = args
		}
		if env, present := raw["env"]; present {
			entry["env"] = env
		}
	}
	return entry, nil
}

// unknownMCPServerKeys 返回项上未登记的键（排序，便于稳定报错）。
func unknownMCPServerKeys(raw map[string]any) []string {
	var unknown []string
	for key := range raw {
		if !connectorMCPServerKeys[key] {
			unknown = append(unknown, key)
		}
	}
	sort.Strings(unknown)
	return unknown
}
