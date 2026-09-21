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
	// SubFields 是**对象型字段**的子字段（当前只有 `window` 用到）。
	//
	// 存在的理由：`config_fields` 与 Config 结构体逐项对拍（顶层字段一一对应），
	// 因此对象内部的字段在那里没有位置；而客户端要在表单里渲染它们、技能文档要逐个
	// 解释它们 —— 那就必须有一份机器可读的，而不是"两处散文各写一遍"。
	SubFields []FieldSpec `json:"sub_fields,omitempty"`
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
	// AccessDefault / AccessValues 是 access 的缺省与**可写**取值（§4.2 / R25 + §4.4）。
	//
	// ⚠️ AccessValues 的取值来源是 `AccessWritableValues`（login|whitelist），
	// **不是**内部的 `AccessValues`（含历史只读的 public）—— R1-DAT-8/UX-13：
	// 字段规格是**作者契约**，列出 public 会让作者以为还能写它（写入侧 422 拒绝，
	// 而且平台已无匿名面）。历史 public 的读取兼容写在 appcfg.go 的 parse 里，
	// 与"规格怎么写"是两件事。
	AccessDefault string   `json:"access_default"`
	AccessValues  []string `json:"access_values"`
	// ConfigFields / PublishFields 是两张有序表（顺序即文档顺序）。
	ConfigFields  []FieldSpec `json:"config_fields"`
	PublishFields []FieldSpec `json:"publish_fields"`
	// WindowFields 是 `window` 对象的三个子字段（§6 新增），以**路径名**给出
	// （`window.ratio` / `window.width` / `window.height`）。
	//
	// 为什么单列一张表而不是塞进 ConfigFields：ConfigFields 与 Config 结构体的
	// json 标签**逐项逐序一一对应**（门禁用例 (b) 反射对拍），而 window 在结构体里
	// 是**一个**对象字段 —— 把三个子字段平铺进去会让那条对拍失效。子字段因此有
	// 自己的表（消费方 = 客户端表单/预校验与技能文档），并由同一条门禁断言它与
	// `window` 条目的 sub_fields 同源。
	WindowFields []FieldSpec `json:"window_fields"`
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
			Values:   append([]string(nil), AccessWritableValues...),
			Desc: "访问模式。login=要求登录，登录后全员可用（**缺省**）；" +
				"whitelist=要求登录 + 名单准入（**平台不比对名单**，由应用自己读 whitelist 判定）。" +
				"取值只有这两个：平台没有匿名面（应用只在桌面客户端内可用，一律要求登录）",
			Hints: []string{
				"写漏了按 login 处理：缺省只会'要求登录'，不会意外变成匿名可达",
				"历史版本里写过的 `\"public\"` **读取侧仍按 login 执行**（存量应用不会 500），但新版本不得再写它（422 拒绝）",
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
		{
			Key:      FieldSensitiveColumns,
			Type:     "string[]",
			Required: false,
			Default:  "[]",
			Max:      limits.AppConfigSensitiveColumnsMax,
			Desc: "**额外**声明为敏感的列名：平台默认按列名启发式脱敏（token/password/phone/realname…），" +
				"启发式覆盖不到的业务词汇（工位号/宿舍/客户编号…）在这里补充。声明是**加法**：" +
				"声明的列一定脱敏，启发式照旧生效；没有\"取消脱敏\"的开关",
			Hints: []string{
				"写**列名本身**（与 `db.define` 里的名字一致），如 [\"workstation_no\", \"dorm_room\"]；列名匹配不区分大小写",
				"条目去重按大小写不敏感（`Phone` 与 `phone` 是同一列）；含空串或超过 64 字节的条目直接拒（422）",
				"声明了但结果集里没有这一列**不算错误**（列改名/还没建表都属正常）：它只是这次不参与脱敏，" +
					"`masked_columns` 也只在真的遮住它时才提到它",
				"**更新版本**时省略本字段 = 沿用上一版声明的列；显式给 `[]` 才是清空声明（默认启发式仍然生效）",
				"作用面 = 作者/管理员的**数据浏览**面（`GET …/rows` 的默认视图）：声明让 AI 与作者看到 `***` 而不是明文；" +
					"显式 `unmask=1` 仍可看原值（该次调用单独审计）",
				"它不是访问控制：应用自己的代码读自己的库不受影响（平台不做行/列级过滤，R15）",
			},
		},
		{
			Key:      FieldWindow,
			Type:     "object",
			Required: false,
			Desc: "窗口的**默认尺寸与强制宽高比**（子字段见 `window_fields`）：" +
				"`window.ratio` 是客户端 resize 时强制锁定的比例（\"W:H\" 或浮点，" +
				"合法区间 0.25–4.0）；`window.width` / `window.height` 是首次打开的默认尺寸" +
				"（缺省 1280×720，写了 ratio 时按比例校正）",
			Hints: []string{
				"ratio 越界（<0.25 / >4.0 / 0 / 负 / 非数字）⇒ 发布期 `APP_CONFIG_INVALID`（不是留到运行期）",
				"ratio 与 width/height 冲突时**以 ratio 为准**：只保留你显式给出的那一边，另一边按比例推导",
				"整个 `window` 缺席 = 沿用上一版生效值（与其它字段同一条继承规则）；显式 `null` 才是清空",
				"未知子键会被拒（例如 `window.zoom`）—— 平台不会静默忽略你没被支持的写法",
			},
			SubFields: WindowFields(),
		},
	}
}

// WindowFields 返回 `window` 对象的子字段表（§6；有序 = 文档顺序）。
//
// 键名用**路径形态**（`window.ratio`）：§6 的表格与客户端文案用的就是它，
// 而 JSON 里的形态是嵌套对象（`{"window":{"ratio":…}}`）—— 两者是同一份契约的
// 两种写法，转换规则只有一条：去掉前缀 `window.` 就是对象里的键。
func WindowFields() []FieldSpec {
	return []FieldSpec{
		{
			Key:  FieldWindow + ".ratio",
			Type: "string",
			Desc: `强制锁定的宽高比：写 "W:H"（如 "16:9"）或浮点数（如 1.7778）；` +
				"合法区间 0.25–4.0（越界/0/负/非数字 ⇒ `APP_CONFIG_INVALID`）",
			Hints: []string{
				"窗口 resize 时按它约束比例：这是**强制**项，不是建议",
				"只给 ratio 时按默认宽度 1280 推高度（16:9 ⇒ 1280×720）",
			},
		},
		{
			Key:      FieldWindow + ".width",
			Type:     "string",
			Required: false,
			Desc:     "首次打开的窗口宽度（像素，正整数）：缺省 1280；与 ratio 冲突时以 ratio 为准",
			Hints: []string{
				"合法区间见 `window_fields` 的 max（越界 ⇒ `APP_CONFIG_INVALID`）",
				`写字符串（"1280px"）或小数一律拒`,
			},
		},
		{
			Key:      FieldWindow + ".height",
			Type:     "string",
			Required: false,
			Desc:     "首次打开的窗口高度（像素，正整数）：缺省 720；与 ratio 冲突时以 ratio 为准",
			Hints:    []string{"只写 height 时宽度按 ratio 推导"},
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
			Desc: "应用标识（客户端内即 `<渠道 app 源 scheme>://<app_id>` 的 host 段）：" +
				"小写字母/数字/连字符，不超过 63 个字符，" +
				"不得纯数字、不得以 xn-- 开头、不得是保留字；**不能改名**",
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
			Hints:        []string{"app_id 只能小写 ASCII（它也是应用地址的 host 段）；人看的名字写在这里"},
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
				"**更新版本**时 config 里**缺席**的字段沿用上一版生效值（access/whitelist/purpose/data_sensitivity/owner/sensitive_columns 逐字段各自沿用）；显式给值——包括显式空串——以提交为准",
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
		// 顶层 access_values 与字段表里的 access.values **同源同值**（都由
		// AccessWritableValues 派生）—— 两处各写一遍会让"规格文件自己不自洽"。
		AccessValues:  append([]string(nil), AccessWritableValues...),
		ConfigFields:  ConfigFields(),
		PublishFields: PublishFields(),
		WindowFields:  WindowFields(),
	}
}
