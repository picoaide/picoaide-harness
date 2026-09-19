// 本文件是**应用配置文件字段与发布载荷字段的单一真源**（设计基线 §4.2 / §6.2 /
// §5.5「数值单一真源」的同一条纪律，只是对象从"上限数字"换成"字段规格"）。
//
// 为什么需要它：字段规格此前只存在于**散文（SKILL / 作者文档）与服务端错误 hints**
// 里，三者各写一份 ⇒ 审计实测到真实不一致（`title` 服务端首版必填、SKILL 没写；
// `data_sensitivity` 的"缺省"只写在 UI 里）。现在：
//
//	appcfgspec.go（本文件，唯一真源）
//	  ├─ appcfg.json                      —— 机器可读（TS 侧工具参数/表单预校验、跨语言对拍）
//	  ├─ SKILL references/app-config.md   —— 作者/AI 看的字段表（从本表生成）
//	  └─ 服务端错误 hints                  —— 字段名从本表取（api/publish.go）
//
// 生成物由 `cmd/picoaide-limits-gen` 一并写出（一个生成器、一次 `-check` 门禁），
// `appcfgspec_gen_test.go` 守住五条：
//
//	(a) 生成物逐字节一致；        (b) 表覆盖 Config 结构体的每个 json 字段（反射，双向）；
//	(c) access 三取值/缺省与 §4.2/abi 一致；(d) SKILL 里的字段名全部来自生成物；
//	(e) title 的"首版必填"必须在表里（审计查出的真实不一致，回归锁定）。
//
// 维护规则：新增/改名任何字段时改本表并重新生成 —— 忘改会被上面五条抓住。
package appcfg

import (
	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// FieldSpec 是**一个字段**的机器可读规格。
//
// 它同时描述两类字段（见 ConfigFields / PublishFields）：
//   - 应用配置文件 `picoaide.app.json` 的字段（作者手写、随发布提交）；
//   - 发布载荷（publish/validate 请求体）的字段。
//
// 两类的 Key 都是**外部契约**：改名即破坏已发布应用与已上线的客户端表单。
type FieldSpec struct {
	// Key 是 JSON 字段名（蛇形，逐字对外）。
	Key string `json:"key"`
	// Type 是取值形态：string | string[] | enum | object。
	Type string `json:"type"`
	// Required=true 表示**任何一次发布**都必须给（无条件必填）。
	Required bool `json:"required"`
	// RequiredWhen 是条件必填（空 = 无附加条件），取值见 RequiredWhen* 常量：
	//   first_release     —— 仅首次发布必填（之后的版本可沿用上一版）
	//   non_first_release —— 仅非首版必填
	//   access=whitelist  —— 当 access 取 whitelist 时必填
	RequiredWhen string `json:"required_when,omitempty"`
	// Default 是缺失时的语义缺省（没有缺省则为空串）。
	Default string `json:"default,omitempty"`
	// Values 是 enum 的封闭取值（顺序即文档顺序）。
	Values []string `json:"values,omitempty"`
	// Max 是**该字段自身**的上限（0 = 无上限）；数值一律来自 limits 包，
	// 服务端校验与本文档都由同一处取值。
	Max int `json:"max,omitempty"`
	// Desc 是一句话说明（写进生成物，面向作者与 AI）。
	Desc string `json:"desc"`
	// Hints 是可操作提示（同样是生成物的内容）。
	Hints []string `json:"hints,omitempty"`
}

// RequiredWhen 的封闭取值（不要手写字符串：门禁按这三个值校验表的自洽性）。
const (
	// RequiredWhenFirstRelease 见 FieldSpec.RequiredWhen。
	RequiredWhenFirstRelease = "first_release"
	// RequiredWhenNonFirstRelease 见 FieldSpec.RequiredWhen。
	RequiredWhenNonFirstRelease = "non_first_release"
	// RequiredWhenAccessWhitelist 见 FieldSpec.RequiredWhen。
	RequiredWhenAccessWhitelist = "access=whitelist"
)

// RequiredWhenValues 是 RequiredWhen 的封闭取值（门禁用例按它校验）。
var RequiredWhenValues = []string{
	RequiredWhenFirstRelease, RequiredWhenNonFirstRelease, RequiredWhenAccessWhitelist,
}

// Spec 是 `appcfg.json` 的顶层结构（机器可读产物）。
//
// 消费方：①TS 侧工具参数与表单预校验；②SKILL 生成（references/app-config.md）；
// ③跨语言对拍（access 取值必须与 abi.AuthMode* 一致）。
type Spec struct {
	// Schema 是产物自身的格式版本（消费方据此判断能否解析）。
	Schema string `json:"schema"`
	// ABIVersion 是帧协议版本（与 abi.ABIVersion 同源）。
	ABIVersion string `json:"abi_version"`
	// ConfigFile 是随包提交的配置文件名（limits.AppConfigFileName）。
	ConfigFile string `json:"config_file"`
	// AccessDefault / AccessValues 是 access 的缺省与封闭取值（§4.2 / R25）。
	AccessDefault string   `json:"access_default"`
	AccessValues  []string `json:"access_values"`
	// ConfigFields / PublishFields 是两张有序表（顺序即文档顺序）。
	ConfigFields  []FieldSpec `json:"config_fields"`
	PublishFields []FieldSpec `json:"publish_fields"`
}

// SpecSchema 是 appcfg.json 的格式版本（消费者做兼容判断用）。
const SpecSchema = "picoaide-app-config/1"

// ConfigFields 返回**应用配置文件**字段表（有序；顺序即文档与报错提示顺序）。
//
// 与 Config 结构体的 json 字段**一一对应**（双向），由门禁用例 (b) 用反射守住。
// 与 KnownFields（Parse 的未知字段白名单）逐项一致，由门禁用例守住。
func ConfigFields() []FieldSpec {
	return []FieldSpec{
		{
			Key:      FieldAccess,
			Type:     "enum",
			Required: false,
			Default:  string(AccessDefault),
			Values:   append([]string(nil), AccessValues...),
			Desc: "访问模式。public=允许匿名（未登录时帧内 user 为 null）；" +
				"login=要求登录，登录后全员可用（**缺省**）；" +
				"whitelist=要求登录 + 名单准入（**平台不比对名单**，由应用自己读 whitelist 判定）",
			Hints: []string{
				"写漏了按 login 处理：缺省只会'要求登录'，不会意外变成匿名可达",
				"**更新版本**时省略本字段 = **沿用上一版生效值**（不是回落 login）：纯代码更新不会改写线上访问级别",
				"要真的改访问级别就**显式**写出来（显式 `\"login\"` 才算改成登录后全员可用）；显式空串不是合法取值，会被拒",
				"应用中心**不按它过滤**：所有应用都列出来，条目里给出访问级别（供使用者判断该不该点）",
				"改 access = 发一个新版本（运行期改不了）",
			},
		},
		{
			Key:          FieldWhitelist,
			Type:         "string[]",
			Required:     false,
			RequiredWhen: RequiredWhenAccessWhitelist,
			Default:      "[]",
			Max:          limits.AppConfigWhitelistMax,
			Desc: "准入名单——**给应用自己读的名单**（平台不比对、也不校验账号是否存在）：" +
				"access=\"whitelist\" 时至少要有一个账号，否则拒绝发布",
			Hints: []string{
				"每个条目是一个账号（登录名 login），如 [\"zhangwei\", \"lisi\"]",
				"**更新版本**时省略本字段 = 沿用上一版的名单；显式给 `[]` 才是“清空名单”（access 仍是 whitelist 时会被拒）",
				"应用入口第一件事就该读它并比对；无权限页必须显示本人账号（作者发现拼错的唯一途径）",
				"含空串即拒（不要用空行占位）；条目数上限见 references/limits.md",
			},
		},
		{
			Key:          FieldPurpose,
			Type:         "string",
			RequiredWhen: RequiredWhenFirstRelease,
			Desc:         "一句话用途：应用中心与页面标题用（首次发布必填，之后的版本可沿用）",
			Hints:        []string{"写清楚「这个应用解决什么问题」，使用者据此决定要不要打开"},
		},
		{
			Key:          FieldDataSensitivity,
			Type:         "string",
			RequiredWhen: RequiredWhenFirstRelease,
			Desc:         "数据敏感度声明（如 internal）：用于事后追责与合规审查（首次发布必填，之后的版本可沿用）",
			Hints: []string{
				"平台**没有**这个字段的默认值：不要指望界面或平台替你填（留空会被首版必填校验拒）",
				"**更新版本**时省略本字段 = 沿用上一版；显式给空串才会把它清空（那不是“没填”，是“填了空”）",
				"它不改变任何运行时行为，只用于声明与追责",
			},
		},
		{
			Key:          FieldOwner,
			Type:         "string",
			RequiredWhen: RequiredWhenFirstRelease,
			Desc: "负责人声明（应用出问题找谁）：**不是平台归属** —— 平台归属取自登录态、" +
				"不可伪造（首次发布必填，之后的版本可沿用）",
			Hints: []string{"它与应用中心的'负责人'显示同源；平台不拿它做任何权限判断"},
		},
	}
}

// PublishFields 返回**发布载荷**字段表（publish/validate 请求体；有序）。
//
// 与 api/publish.go 的 uploadPayload 结构体一一对应，由门禁用例 (b) 的双向检查
// （另有 uploadPayload 侧的覆盖用例）守住；`title` 的"首版必填"是审计查出的
// 真实不一致（服务端首版必填、SKILL 没写），门禁用例 (e) 锁定。
func PublishFields() []FieldSpec {
	return []FieldSpec{
		{
			Key:      "app_id",
			Type:     "string",
			Required: true,
			Max:      limits.MaxAppIDLen,
			Desc: "应用标识 = 域名标签（`<app_id>.<应用基域>`）：小写字母/数字/连字符，" +
				"不超过 63 个字符，不得纯数字、不得以 xn-- 开头、不得是保留字；**不能改名**",
			Hints: []string{
				"也可以由路径 `/apps/wasm/:app_id/releases` 给出；两边都给时必须一致",
				"显示名（可中文）用 title，不要塞进 app_id",
			},
		},
		{
			Key:      "version",
			Type:     "string",
			Required: true,
			Desc:     "严格递增的 `x.y.z`（可带 `-prerelease`）：**失败的发布不占号**，已落行的版本永久占用",
			Hints:    []string{"编译/干跑失败后可以直接重发同一个版本号；已落行的版本换号重发"},
		},
		{
			Key:          "title",
			Type:         "string",
			Required:     false,
			RequiredWhen: RequiredWhenFirstRelease,
			Desc:         "应用中心显示名称（可中文）：**首次发布必填**，之后的版本可省略（沿用上一版）",
			Hints:        []string{"app_id 是域名标签不能中文；人看的名字写在这里"},
		},
		{
			Key:          "changelog",
			Type:         "string",
			Required:     false,
			RequiredWhen: RequiredWhenNonFirstRelease,
			Desc:         "本版改动说明：**非首版必填**（空即拒，422 MISSING_FIELD）",
			Hints:        []string{"首版可以省略（首版本身就是'新建'）"},
		},
		{
			Key:      "wasm_base64",
			Type:     "string",
			Required: true,
			Max:      limits.WasmMaxBytes,
			Desc: "wasm 模块的 base64 编码（`GOOS=wasip1 GOARCH=wasm` 的产物）：" +
				"解码后不超过 32 MiB；**平台不做构建**，本地编译后上传",
			Hints: []string{
				"载荷较大时改走分片上传 + 续传（片大小上限见 references/limits.md）",
				"导入面只允许 `wasi_snapshot_preview1`；组件模型（wasm32-*-component）产物直接拒",
			},
		},
		{
			Key:      "config",
			Type:     "object",
			Required: true,
			Max:      limits.AppConfigMaxBytes,
			Desc:     "应用配置文件的内容（即 `picoaide.app.json` 的对象形态）：字段见 `config_fields`",
			Hints: []string{
				"平台存的是**解析并归一化之后**的配置（名单去空白/去重、access 缺省落定）",
				"**更新版本**时 config 里**缺席**的字段沿用上一版生效值（access/whitelist/purpose/data_sensitivity/owner 逐字段各自沿用）；显式给值——包括显式空串——以提交为准",
				"首版没有可沿用的上一版：缺席的 `access` 按缺省 `login` 落定",
				"改任何一项都要发新版本（§10.5 第 56f 项）",
			},
		},
	}
}

// FieldNames 返回字段名列表（顺序即文档顺序）。服务端错误 hints 用它，避免手写字段清单。
func FieldNames(fields []FieldSpec) []string {
	out := make([]string, 0, len(fields))
	for _, f := range fields {
		out = append(out, f.Key)
	}
	return out
}

// Doc 返回 `appcfg.json` 的内容（生成器唯一的输入）。
func Doc() Spec {
	return Spec{
		Schema:        SpecSchema,
		ABIVersion:    abi.ABIVersion,
		ConfigFile:    limits.AppConfigFileName,
		AccessDefault: string(AccessDefault),
		AccessValues:  append([]string(nil), AccessValues...),
		ConfigFields:  ConfigFields(),
		PublishFields: PublishFields(),
	}
}
