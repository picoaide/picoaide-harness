// Package appcfg 解析并校验**应用配置文件** `picoaide.app.json`（设计基线 §4.2 /
// R25 / R26 / R38 / §10.5 第 56b–56f 项）。
//
// 文件随 publish 一起提交、**不计入 32 MiB wasm 上限**、上限 64 KiB
// （limits.AppConfigMaxBytes）；发布期与静态资源一起抽到
// `<data_root>/apps/<app_id>/assets/<release_id>/`，应用用
// `assets.read("picoaide.app.json")` 读自己的配置（§4.2）。
//
// 三条容易搞错的语义：
//   - `access` 缺省 **`login`**（R25，2026-09-18 收敛为三模式）：写漏了不会意外
//     变成匿名可达；`public` / `login` / `whitelist` 之外的值一律拒。
//   - `access="whitelist"` 且 `whitelist` 为空 ⇒ 拒（§10.5 第 56c 项）：这种应用对
//     **所有人**都不可用，属于发布期就该拦下的形态。注意 `login`（登录后全员）是
//     合法模式，平台**不再**因为"登录已开但名单为空"拒发布（旧规则已废止）。
//   - `owner` 是**负责人声明字段**（给应用中心显示"谁能拍板"），**不是平台归属**。
//     平台归属在 `apps.owner`，取自登录态、不可伪造（§7.1 身份契约 / R27 的
//     `is_publisher` 也来自登录态而非本文件）。两者同名不同物，不要互相推导。
//
// 兼容 shim（必须保留）：已发布版本里的 `config_json` 与随包 `picoaide.app.json`
// 还是旧 schema（`login_required` / `visible`）。Parse 接受旧形态并在内存里映射成
// `access`，**不报 unknown field**；映射成功即可，写出去（重新发布）的就是新 schema。
// 迁移 0071 会把库里的旧 JSON 就地改写；旧字段因此只是"读得到"的历史形态。
package appcfg

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 顶层字段名（§4.2 新 schema 的字段集合是**封闭**的：多一个即拒，见 Parse 的未知字段检查）。
const (
	FieldAccess          = "access"
	FieldWhitelist       = "whitelist"
	FieldPurpose         = "purpose"
	FieldDataSensitivity = "data_sensitivity"
	FieldOwner           = "owner"
)

// 旧 schema 的字段名（**兼容 shim**）。它们不进 KnownFields —— 报错提示只列新
// schema；Parse 接受它们并按下表映射：
//
//	login_required=false                      ⇒ access=public
//	login_required=true  + whitelist 非空      ⇒ access=whitelist
//	login_required=true  + whitelist 空        ⇒ access=login
//	login_required 缺失（旧缺省 true）+ 名单非空 ⇒ access=whitelist，否则 login
//	visible                                    ⇒ 一律忽略（2026-09-18 起目录不再过滤）
const (
	legacyFieldLoginRequired = "login_required"
	legacyFieldVisible       = "visible"
)

// KnownFields 是 `picoaide.app.json` 允许出现的全部顶层字段（顺序即报错提示顺序；
// 与 appcfgspec.go 的 ConfigFields() 逐项一致，由门禁用例守）。
var KnownFields = []string{
	FieldAccess,
	FieldWhitelist,
	FieldPurpose,
	FieldDataSensitivity,
	FieldOwner,
}

// Access 是访问模式（§4.2 / R25，2026-09-18 用户拍板收敛为三模式）。
//
// 它同时是**帧内 auth.mode 的来源**（§7.1）与应用中心目录显示的"访问级别"。
type Access string

const (
	// AccessPublic 允许匿名：未登录时帧内 user 为 null，身份相关宿主调用 AUTH_REQUIRED。
	AccessPublic Access = "public"
	// AccessLogin 要求登录（**缺省**）：未登录 302 主站换票；登录后全员可用。
	AccessLogin Access = "login"
	// AccessWhitelist 要求登录 + 名单准入；**平台不比对名单**（R24），
	// 名单由应用自己读配置文件判定。
	AccessWhitelist Access = "whitelist"
)

// AccessDefault 是 `access` 缺失时的缺省值。
//
// 取 login（登录后全员）：写漏了只会"要求登录"，不会意外变成匿名可达；
// 旧 schema 的 `login_required` 缺省 true 在映射后同样落在 login/whitelist 上
// （见包注释的映射表），两条规则方向一致。
const AccessDefault = AccessLogin

// AccessValues 是 access 的封闭取值（顺序即文档顺序）。
var AccessValues = []string{string(AccessPublic), string(AccessLogin), string(AccessWhitelist)}

// Config 是应用配置文件的解析结果。
//
// 字段的 JSON 名是**外部契约**（作者手写、skill 模板生成），改名即破坏已发布应用。
type Config struct {
	// Access 是访问模式（三选一，缺省 login）。旧 schema 的 login_required/visible
	// 在 Parse 里映射/忽略，不落进本结构体 —— 新写出的 JSON 只有 access。
	Access Access `json:"access"`
	// Whitelist 是作者手填的准入名单（R26）：**平台不校验账号是否存在**，
	// 也不提供任何目录能力。语义 = "**给应用自己读的名单**"（R24：平台不比对）；
	// access=whitelist 时名单为空即拒（§10.5 第 56c 项）。
	Whitelist []string `json:"whitelist"`
	// Purpose 是用途声明（首次发布必填）。
	Purpose string `json:"purpose"`
	// DataSensitivity 是数据敏感度声明（首次发布必填）。
	DataSensitivity string `json:"data_sensitivity"`
	// Owner 是**负责人**声明（首次发布必填）：写"这个应用出问题找谁"。
	// 不是平台归属 —— 平台归属在 apps.owner，取自登录态、不可伪造。
	Owner string `json:"owner"`
}

// AuthMode 把配置映射成帧内 `auth.mode`（§7.1）。
//
// 注意：缺省值由 Parse 落定（缺失的 access → login，R25）；
// **不要手工构造 Config 来决定鉴权**——零值 Config 的 Access 是空串，映射落在
// login（最严格的一侧，绝不意外公开）。生产路径一律走 Parse。
func (c Config) AuthMode() abi.AuthMode {
	switch c.Access {
	case AccessPublic:
		return abi.AuthModePublic
	case AccessWhitelist:
		return abi.AuthModeWhitelist
	default:
		// login 与"未解析的零值"都要求登录（fail-closed）。
		return abi.AuthModeLogin
	}
}

// Public 报告该应用是否允许匿名访问（帧内 user 为 null）。
func (c Config) Public() bool { return c.Access == AccessPublic }

// RequiresLogin 报告未登录时是否必须先走换票（public 之外都要）。
func (c Config) RequiresLogin() bool { return c.Access != AccessPublic }

// ValidAccess 报告 s 是否是合法的 access 取值。
func ValidAccess(s Access) bool {
	for _, v := range AccessValues {
		if string(s) == v {
			return true
		}
	}
	return false
}

// AccessOfConfigJSON 从库里已有行的 `config_json` 投影里取 access
// （应用中心目录与运维面显示"访问级别"用，见 api/read.go 与 api/admin.go）。
//
// 为什么单独一个入口：投影列里可能还是旧 schema（迁移 0071 之前的行、或迁移
// 未覆盖的异常行），也可能为空/坏 JSON。解析失败一律回落 login —— 缺省即最严格，
// 不会因为一次投影读取失败就把应用标成"公开"。
//
// ⚠️ 它**只用于显示**：鉴权与发布一律走 Parse（Parse 还会做语义校验）。
func AccessOfConfigJSON(raw string) Access {
	if strings.TrimSpace(raw) == "" {
		return AccessDefault
	}
	c, e := decode([]byte(raw))
	if e != nil {
		return AccessDefault
	}
	return c.Access
}

// Parse 解析并校验配置文件字节。
//
// 检查分两层，**Parse 已经把不依赖"是否首版"的全部检查做完**（含
// whitelist 模式的名单非空检查，即内部调用 Validate(false)）：
// 这样调用方忘记调用 Validate 也不会把一个"对所有人不可用"的应用放进来。
// 首次发布特有的声明字段要求由调用方另行调用 Validate(true)。
//
// 失败一律 `APP_CONFIG_INVALID`(422)，details/hints 指名具体字段（§4.2 / §10.5 第 56b 项）。
func Parse(data []byte) (Config, *apperr.Error) {
	c, e := decode(data)
	if e != nil {
		return Config{}, e
	}
	if e := c.Validate(false); e != nil {
		return Config{}, e
	}
	return c, nil
}

// decode 只做 schema 解析与旧形态映射，**不做语义校验**（不检查"whitelist 模式必须
// 有名单"）。唯一的外部用途是 AccessOfConfigJSON（显示投影）：鉴权与发布一律走 Parse。
func decode(data []byte) (Config, *apperr.Error) {
	var c Config
	if len(data) > limits.AppConfigMaxBytes {
		return c, bad("", "应用配置文件超过大小上限").
			WithDetail("size", len(data)).
			WithDetail("max", limits.AppConfigMaxBytes).
			WithHint(fmt.Sprintf("%s 上限 %d KiB（不计入 wasm 体积上限），请精简声明文本",
				limits.AppConfigFileName, limits.AppConfigMaxBytes>>10))
	}
	// 顶层必须是 JSON 对象：用 map 逐字段解码，报错才能指名到具体字段
	// （直接 Decode 进结构体时，类型错误的字段名要靠正则从英文错误里抠）。
	var raw map[string]json.RawMessage
	dec := json.NewDecoder(bytes.NewReader(data))
	if err := dec.Decode(&raw); err != nil {
		return c, bad("", "应用配置文件不是合法 JSON").
			WithCause(err).
			WithHint(fmt.Sprintf("%s 必须是 UTF-8 JSON 对象，字段见 skill 模板（references/app-config.md）",
				limits.AppConfigFileName))
	}
	if dec.More() {
		return c, bad("", "应用配置文件在 JSON 对象之后还有多余内容").
			WithHint("一个文件只能有一个顶层 JSON 对象")
	}
	// `null` 解码进 map 是 nil 且不报错（`{}` 才是空 map）⇒ 单独拦一次，
	// 否则"顶层必须是 JSON 对象"这条契约会被 null 静默绕过。
	if raw == nil {
		return c, bad("", "应用配置文件的顶层必须是 JSON 对象").
			WithDetail("reason", "not_object").
			WithHint("写成 { ... }；字段见 skill 的 references/app-config.md")
	}
	for _, k := range sortedKeys(raw) {
		if !knownField(k) {
			return c, bad(k, fmt.Sprintf("未知顶层字段 %q", k)).
				WithDetail("reason", "unknown_field").
				WithHint("合法字段：" + strings.Join(KnownFields, ", ")).
				WithHint("拼错的字段不会生效，也不会被忽略：请对照 skill 里的字段规格（references/app-config.md）逐字校对")
		}
	}

	// 名单先解（旧形态的 access 映射要用到它）。
	if v, ok := raw[FieldWhitelist]; ok {
		if e := json.Unmarshal(v, &c.Whitelist); e != nil {
			return Config{}, bad(FieldWhitelist, "whitelist 必须是字符串数组").
				WithCause(e).
				WithHint("每个条目是一个账号（login 名），如 [\"zhangwei\", \"lisi\"]")
		}
	}
	// 名单归一化（去首尾空白、拒空串、去重）：平台的职责只是把"同一行写两遍"
	// 与"尾随空格"这类手写噪声消掉；**不改写大小写**，因为名单由应用自己
	// 逐字比对 user.username，宿主擅自规范化会造出作者看不见的差异。
	clean, e := normalizeWhitelist(c.Whitelist)
	if e != nil {
		return Config{}, e
	}
	c.Whitelist = clean

	// 旧 schema 字段：解析以确认形态合法（不合法要报错，不静默放过），
	// 但只在没有 access 时参与映射；visible 一律忽略。
	legacyLoginRequired := true // 旧 schema 的缺省（R25 原文：login_required 缺省 true）
	if v, ok := raw[legacyFieldLoginRequired]; ok {
		if e := decodeBool(v, legacyFieldLoginRequired, &legacyLoginRequired); e != nil {
			return Config{}, e
		}
	}
	if v, ok := raw[legacyFieldVisible]; ok {
		var ignored bool
		if e := decodeBool(v, legacyFieldVisible, &ignored); e != nil {
			return Config{}, e
		}
	}

	if v, ok := raw[FieldAccess]; ok {
		var s string
		if e := json.Unmarshal(v, &s); e != nil {
			return Config{}, bad(FieldAccess, "access 必须是字符串").
				WithCause(e).
				WithHint("三选一：" + accessHintValues())
		}
		c.Access = Access(s)
		if !ValidAccess(c.Access) {
			return Config{}, bad(FieldAccess, fmt.Sprintf("access 取值 %q 不合法", s)).
				WithDetail("reason", "bad_access").
				WithDetail("values", strings.Join(AccessValues, ",")).
				WithHint("三选一：" + accessHintValues())
		}
	} else {
		// 兼容 shim：旧 schema → 新 schema（映射成功即可，不报 unknown field）。
		switch {
		case !legacyLoginRequired:
			c.Access = AccessPublic
		case len(c.Whitelist) > 0:
			c.Access = AccessWhitelist
		default:
			c.Access = AccessLogin
		}
	}

	if e := decodeString(raw, FieldPurpose, &c.Purpose); e != nil {
		return Config{}, e
	}
	if e := decodeString(raw, FieldDataSensitivity, &c.DataSensitivity); e != nil {
		return Config{}, e
	}
	if e := decodeString(raw, FieldOwner, &c.Owner); e != nil {
		return Config{}, e
	}
	return c, nil
}

// Validate 校验语义规则。requireDeclarations=true 表示**首次发布**：
// purpose / data_sensitivity / owner 必须非空（§4.2），否则 MISSING_FIELD；
// 非首版可以沿用（调用方传 false），此时这三个字段允许为空/缺失。
//
// `access="whitelist"` 且 whitelist 为空一律拒（§4.2 / §10.5 第 56c 项），
// 与是否首版无关 —— 否则应用对所有人不可用，而作者要到用户报错才知道。
// **不再有**"login_required=true 且名单为空 ⇒ 拒"这条旧规则：登录后全员现在是
// 合法模式（`access="login"`），见 §10.5 第 56c 项 2026-09-18 的变更说明。
func (c Config) Validate(requireDeclarations bool) *apperr.Error {
	if !ValidAccess(c.Access) {
		return bad(FieldAccess, "access 未设置或取值不合法").
			WithDetail("reason", "bad_access").
			WithHint("三选一：" + accessHintValues()).
			WithHint("生产路径一律走 Parse：它会落定缺省值（login）并校验取值")
	}
	if c.Access == AccessWhitelist && len(c.Whitelist) == 0 {
		return bad(FieldWhitelist, "access=\"whitelist\" 但没有配置名单：该应用对所有人都不可用").
			WithDetail("reason", "empty_whitelist").
			WithHint("二选一：①把 `access` 改成 \"login\"（登录后全员可用，这是缺省模式）；" +
				"②在 `whitelist` 里填入允许使用的账号").
			WithHint("名单只能手填已知账号——平台不校验账号是否存在，也不提供员工名录（R26）")
	}
	if len(c.Whitelist) > limits.AppConfigWhitelistMax {
		return bad(FieldWhitelist, "whitelist 条目数超过上限").
			WithDetail("count", len(c.Whitelist)).
			WithDetail("max", limits.AppConfigWhitelistMax).
			WithHint(fmt.Sprintf("白名单上限 %d 条；超过说明不该用白名单做准入（R26：平台不提供员工目录）",
				limits.AppConfigWhitelistMax))
	}
	if requireDeclarations {
		for _, f := range []struct {
			name string
			val  string
		}{
			{FieldPurpose, c.Purpose},
			{FieldDataSensitivity, c.DataSensitivity},
			{FieldOwner, c.Owner},
		} {
			if strings.TrimSpace(f.val) == "" {
				return apperr.New(apperr.CodeMissingField, fmt.Sprintf("首次发布必须填写 %s", f.name)).
					WithDetail("field", f.name).
					WithDetail("reason", "missing_declaration").
					WithHint("这三个字段只在首次发布时必填，之后的版本可以沿用").
					WithHint("用途/数据敏感度/负责人用于应用中心与事后追责，不是平台归属（平台归属取自登录态）")
			}
		}
	}
	return nil
}

// accessHintValues 是 access 的三选一提示（唯一实现，供多处报错复用）。
func accessHintValues() string {
	return fmt.Sprintf("`access` = %q（允许匿名）｜ %q（要求登录，登录后全员可用，缺省）｜ %q（要求登录 + 名单）",
		AccessPublic, AccessLogin, AccessWhitelist)
}

// normalizeWhitelist 去首尾空白、拒空串、去重（保留首次出现的顺序）。
//
// 空串一律拒而不是静默丢弃：`[""]` 通常是"从表格里粘了一列空行"的形态，
// 静默丢掉会让作者以为已经授权了某人。
func normalizeWhitelist(in []string) ([]string, *apperr.Error) {
	if len(in) == 0 {
		return nil, nil
	}
	out := make([]string, 0, len(in))
	seen := make(map[string]struct{}, len(in))
	for i, raw := range in {
		s := strings.TrimSpace(raw)
		if s == "" {
			return nil, bad(FieldWhitelist, "whitelist 含空条目").
				WithDetail("reason", "empty_entry").
				WithDetail("index", i).
				WithHint("去掉空行；每行一个账号（不要写空串占位）")
		}
		if _, dup := seen[s]; dup {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out, nil
}

// knownField 报告 name 是否是可接受的顶层字段：新 schema 的字段，或旧 schema 的
// **兼容 shim** 字段（legacyFieldLoginRequired / legacyFieldVisible）。
//
// 旧字段必须在这里放行，否则"已发布版本里的旧 config_json"会被当成拼写错误拒掉
// （迁移 0071 之后库里的行已改写，但随包 picoaide.app.json 是发布期资产、
// 老版本永远存在）。
func knownField(name string) bool {
	if name == legacyFieldLoginRequired || name == legacyFieldVisible {
		return true
	}
	for _, f := range KnownFields {
		if f == name {
			return true
		}
	}
	return false
}

// sortedKeys 让报错稳定（map 迭代顺序随机会让同一个坏文件给出不同字段名的错误）。
func sortedKeys(m map[string]json.RawMessage) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func decodeBool(raw json.RawMessage, field string, dst *bool) *apperr.Error {
	if err := json.Unmarshal(raw, dst); err != nil {
		return bad(field, fmt.Sprintf("%s 必须是 true 或 false", field)).
			WithCause(err).
			WithHint("布尔字段不要写成字符串（\"true\"）或数字（1）")
	}
	return nil
}

func decodeString(raw map[string]json.RawMessage, field string, dst *string) *apperr.Error {
	v, ok := raw[field]
	if !ok {
		return nil
	}
	if err := json.Unmarshal(v, dst); err != nil {
		return bad(field, fmt.Sprintf("%s 必须是字符串", field)).
			WithCause(err).
			WithHint("声明类字段是自由文本字符串；不确定写什么就先写清用途与数据范围")
	}
	return nil
}

// bad 构造 APP_CONFIG_INVALID，并统一把"哪个字段"放进 details.field。
func bad(field, msg string) *apperr.Error {
	e := apperr.New(apperr.CodeAppConfigBad, msg)
	if field != "" {
		e.WithDetail("field", field)
	}
	e.WithHint(fmt.Sprintf("配置文件是 %s（随发布提交，改配置 = 发新版）；字段规格见 references/app-config.md",
		limits.AppConfigFileName))
	return e
}
