// Package appcfg 解析并校验**应用配置文件** `picoaide.app.json`（设计基线 §4.2 /
// R25 / R26 / R38 / §10.5 第 56b–56f 项）。
//
// 文件随 publish 一起提交、**不计入 32 MiB wasm 上限**、上限 64 KiB
// （limits.AppConfigMaxBytes）；发布期与静态资源一起抽到
// `<data_root>/apps/<app_id>/assets/<release_id>/`，应用用
// `assets.read("picoaide.app.json")` 读自己的配置（§4.2）。
//
// 三条容易搞错的语义：
//   - `access` 缺省 **`login`**（R25，2026-09-18 收敛为三模式；2026-09-19 契约 §4.4
//     再收敛为**两模式**）：写漏了不会意外变成匿名可达。**写侧只接受
//     `login|whitelist`**；`public` 是历史值 —— **读取侧**按 `login` 处理（存量应用不
//     失效、不 500），但新版本不得再写（见 parseSubmitted / publicAccessRejected）。
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
	"math"
	"sort"
	"strconv"
	"strings"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 顶层字段名（§4.2 新 schema 的字段集合是**封闭**的：多一个即拒，见 Parse 的未知字段检查）。
const (
	FieldAccess    = "access"
	FieldWhitelist = "whitelist"
	FieldPurpose   = "purpose"
	// FieldWindow 是**窗口**对象（§6 新增：ratio/width/height 三个子字段）。
	//
	// 顶层是一个对象而不是三个扁平键：作者写的是
	//
	//	{"window": {"ratio": "16:9", "width": 1280, "height": 720}}
	//
	// 而字段规格（appcfgspec.go 的 sub_fields）与 §6 的表格用的是
	// `window.ratio` / `window.width` / `window.height` 这种**路径名** ——
	// 两者是同一份契约的两种写法（对象形态 vs 路径形态），不要在这里再发明第三种。
	FieldWindow          = "window"
	FieldDataSensitivity = "data_sensitivity"
	FieldOwner           = "owner"
	// FieldSensitiveColumns 是**作者声明的额外敏感列**（默认脱敏的启发式之外的补充）。
	//
	// 为什么需要它（§5.9 第 8 点后半）：平台默认按**列名启发式**脱敏
	//（api/rows.go 的 isSensitiveColumn），启发式再全也覆盖不了每个业务词汇
	//（"工位号"/"宿舍"/"客户编号"…）。作者最清楚哪一列指认到人，因此给他一条
	// **声明**通道：声明是**加法**（只增不减 —— 声明的列一定脱敏，启发式照旧生效），
	// 也是保守方向（多遮一列只影响排障观感，少遮一列会让 PII 进模型上下文）。
	FieldSensitiveColumns = "sensitive_columns"
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
	FieldSensitiveColumns,
	FieldWindow,
}

// 窗口尺寸/比例的合法区间（§6 冻结）。
//
// 为什么这些常量住在 appcfg 而**不进** `limits`：`limits` 的每个数值都有一整套
// 逐字节生成物（limits.json/limits.md/appcfg.json/技能 references），而 W1 只允许
// 做 appcfg 侧那一次重生成；这些是**作者契约**的取值边界（与 limits 的"平台资源
// 上限"不是一回事），改它们只需要重跑 appcfg 生成物。
const (
	// WindowRatioMin / WindowRatioMax 是 ratio 的合法闭区间（§6：0.25–4.0）。
	WindowRatioMin = 0.25
	WindowRatioMax = 4.0
	// WindowDefaultWidth / WindowDefaultHeight 是作者没写尺寸时的默认值（§6：1280×720）。
	WindowDefaultWidth  = 1280
	WindowDefaultHeight = 720
	// WindowSizeMin / WindowSizeMax 是 width/height 的合法像素区间。
	//
	// 下界 320 是"小于它布局必然不可用"，上界 7680（8K 宽）是"再大就不是应用窗口了"。
	// 区间存在的意义是**发布期就能拦住**手滑多打一个 0 的尺寸（运行期表现为窗口
	// 开在屏幕外/被系统裁剪，作者只会收到"打不开"）。
	WindowSizeMin = 320
	WindowSizeMax = 7680
)

// Access 是访问模式（§4.2 / R25；2026-09-18 收敛为三模式，2026-09-19 契约 §4.4
// 收敛为**写侧两模式**）。
//
// 它同时是**帧内 auth.mode 的来源**（§7.1）与应用中心目录显示的"访问级别"。
type Access string

const (
	// AccessPublic 是**历史值，只读**：允许匿名（未登录时帧内 user 为 null）。
	//
	// 2026-09-19 契约 §4.4：应用只在桌面客户端内、一律要求登录 ⇒ 平台**不再有匿名面**。
	// 这个取值仍然能被读出来（存量已发布版本的配置里写着它，读取侧不得因此 500），
	// 但语义上**等同于 login**（RequiresLogin 为真、AuthMode 为 login），
	// 而且**发布/校验一律拒**（见 parseSubmitted）。
	AccessPublic Access = "public"
	// AccessLogin 要求登录（**缺省**）：登录后全员可用。
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

// AccessValues 是平台**认识**的全部 access 取值（顺序即文档顺序）——
// 读取侧口径（历史版本里可能写着 public），**不是**可写集合。
//
// 可写集合见 AccessWritableValues：发布/校验只接受 login|whitelist。
// ⚠️ 生成物（internal/wasmapp/appcfg/appcfg.json 与 skill 的 references/app-config.md）
// 里的取值表来自本变量，因此它们当前仍列出历史值 public；契约 §4.4 的收敛要等
// 下一次重生成时把 appcfgspec.go 的 access.Values 指向 AccessWritableValues
// （生成由 C2 统一执行，见任务书 §3 的 C2 格）。
var AccessValues = []string{string(AccessPublic), string(AccessLogin), string(AccessWhitelist)}

// AccessWritableValues 是**发布/校验**接受的 access 取值（2026-09-19 契约 §4.4）。
//
// 之所以与 AccessValues 分开：收敛的方向是"写入面收紧、读取面兼容"——
// 历史 public 必须继续可读（否则存量应用每请求 500），但新版本不得再写。
var AccessWritableValues = []string{string(AccessLogin), string(AccessWhitelist)}

// Config 是应用配置文件的解析结果。
//
// 字段的 JSON 名是**外部契约**（作者手写、skill 模板生成），改名即破坏已发布应用。
type Config struct {
	// Access 是访问模式（缺省 login；写侧只接受 login|whitelist，历史 public 只读）。
	// 旧 schema 的 login_required/visible 在 Parse 里映射/忽略，不落进本结构体
	// —— 新写出的 JSON 只有 access。
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
	// SensitiveColumns 是作者**声明的额外敏感列**（默认启发式之外的补充）。
	//
	// 语义（§5.9 第 8 点后半）：
	//   - **加法**：声明的列一定脱敏，而默认启发式照旧生效 —— 声明不能"取消"任何列的
	//     脱敏（没有反向开关：让作者把一列标成"不敏感"等于给 PII 开一条出口，
	//     而平台无法复核他的判断）；
	//   - **大小写不敏感匹配**（SQLite 列名本身不区分大小写，平台的启发式也先 ToLower）；
	//     但**保留作者写的原样**（与 whitelist 同一条纪律：不改写大小写，避免造出
	//     作者看不见的差异）；
	//   - 归一化：去首尾空白、拒空串、**按大小写不敏感去重**（保留首次出现）；
	//   - 声明的列**不在结果集里**不算错误（作者可能声明的是一张还没建的表上的列，
	//     或者列被改名了）—— 它只是不参与这次的脱敏，`masked_columns` 也不会提到它。
	//     为什么静默：这是"多遮一层"的声明面，判错方向是"没遮住一列不存在的列"，
	//     而发布期硬校验"这个列必须存在"需要在发布时读应用库（发布链路不碰应用数据）。
	SensitiveColumns []string `json:"sensitive_columns"`
	// Window 是窗口的**默认尺寸与强制宽高比**（§6 新增）。
	//
	// nil = 作者没写 ⇒ 客户端按 WindowDefaultWidth×Height 开窗（见 ResolvedWindow）。
	// 用指针而不是零值结构体：`{"window":{}}`（写了但空）与"整块缺席"在
	// **版本继承**（inherit.go：缺席=沿用上一版）下语义不同，零值会让两者不可区分。
	Window *WindowConfig `json:"window,omitempty"`
}

// WindowConfig 是 `window` 对象的解析结果（§6）。
//
// 三个子字段的取值规则（**唯一真源**，客户端与技能文档都从这里派生）：
//
//	ratio   —— `"W:H"`（如 "16:9"）或浮点（如 1.7778）；合法区间 [0.25, 4.0]；
//	           0/负/过大/非数字 ⇒ 发布期 APP_CONFIG_INVALID（§6 的硬限制）。
//	           **强制锁定**：客户端 resize 时按它约束窗口比例。
//	width   —— 首次打开的窗口宽度（像素，可省略）。
//	height  —— 首次打开的窗口高度（像素，可省略）。
//
// ratio 与 width/height 冲突时**以 ratio 为准**（§6 的措辞是"按 ratio 校正"）：
// 只保留作者显式给出的那一边，另一边按比例推导（见 ResolvedWindow）。
type WindowConfig struct {
	// Ratio 是宽/高比（0 = 未设置）。解析期已把 "W:H" 折算成浮点。
	Ratio float64 `json:"ratio,omitempty"`
	// Width / Height 是像素尺寸（0 = 未设置）。
	Width  int `json:"width,omitempty"`
	Height int `json:"height,omitempty"`
}

// ResolvedWindow 返回**最终生效**的窗口尺寸（把缺省值与 ratio 校正一次算清）。
//
// 规则（§6："缺省 1280×720 并按 ratio 校正"）：
//  1. 起点 = 作者给的值，缺省 WindowDefaultWidth×WindowDefaultHeight；
//  2. 没写 ratio ⇒ 原样返回（不做任何校正）；
//  3. 写了 ratio ⇒ 以**作者显式给出的那一边**为准推另一边：
//     只给了 width ⇒ height = round(width/ratio)；只给了 height ⇒ width = round(height*ratio)；
//     两个都给了 ⇒ 以 width 为准（宽度是更常用的锚），height = round(width/ratio)；
//     两个都没给 ⇒ 以默认宽度 1280 为锚，height = round(1280/ratio)。
//
// 返回值恒为正整数（ratio 已在 Validate 里保证落在 [0.25,4.0]，不会除出 0）。
func (c Config) ResolvedWindow() (width, height int) {
	width, height = WindowDefaultWidth, WindowDefaultHeight
	if c.Window == nil || c.Window.Ratio <= 0 {
		if c.Window != nil && c.Window.Width > 0 {
			width = c.Window.Width
		}
		if c.Window != nil && c.Window.Height > 0 {
			height = c.Window.Height
		}
		return width, height
	}
	ratio := c.Window.Ratio
	switch {
	case c.Window.Width > 0:
		width = c.Window.Width
		height = int(float64(width)/ratio + 0.5)
	case c.Window.Height > 0:
		height = c.Window.Height
		width = int(float64(height)*ratio + 0.5)
	default:
		width = WindowDefaultWidth
		height = int(float64(width)/ratio + 0.5)
	}
	if width < 1 {
		width = 1
	}
	if height < 1 {
		height = 1
	}
	return width, height
}

// AuthMode 把配置映射成帧内 `auth.mode`（§7.1）。
//
// 2026-09-19 契约 §4.4：历史 `public` 在**读取侧当作 login** —— 帧里必须如实告诉
// 应用"本平台一律要求登录"，否则应用会按 public 渲染匿名界面，而平台其实已经认证过
// 身份（user 非 null）。因此这里 public 映射到 login，而不是原值。
//
// 注意：缺省值由 Parse 落定（缺失的 access → login，R25）；
// **不要手工构造 Config 来决定鉴权**——零值 Config 的 Access 是空串，映射落在
// login（最严格的一侧，绝不意外公开）。生产路径一律走 Parse。
func (c Config) AuthMode() abi.AuthMode {
	switch c.Access {
	case AccessWhitelist:
		return abi.AuthModeWhitelist
	default:
		// login、历史 public 与"未解析的零值"都要求登录（fail-closed）。
		return abi.AuthModeLogin
	}
}

// Public 报告该应用是否允许匿名访问（帧内 user 为 null）。
//
// **恒为 false**（2026-09-19 契约 §4.4）：平台不再有匿名面，历史 public 读取侧即
// login。保留本方法是为了让"谁还在问匿名"这件事在编译期可见。
func (c Config) Public() bool { return false }

// RequiresLogin 报告未登录时是否必须先登录（契约 §4.4）。
//
// **恒为 true**：应用只在桌面客户端内可用，且客户端请求一律持员工 bearer
// （`POST /api/client/v2/apps/wasm/:app_id/request` 由 BearerAuth 保护）。
// 历史 public 在读取侧即 login ⇒ 没有任何配置能让平台放行匿名。
func (c Config) RequiresLogin() bool { return true }

// ValidAccess 报告 s 是否是平台**认识**的 access 取值（读取侧口径，含历史 public）。
//
// 写入面的判定见 WritableAccess —— 认识 ≠ 可写。
func ValidAccess(s Access) bool {
	for _, v := range AccessValues {
		if string(s) == v {
			return true
		}
	}
	return false
}

// IsLegacyPublicAccess 判定一个 access 取值是否是**历史公开档位**（只读兼容）。
//
// 为什么要有这个函数（而不是让调用方直接比常量）：这个取值是**读侧兼容口径的一部分**
// （读取侧把它当 login 执行、写侧拒绝它），语义属于本包。服务端唯一还需要"识别它"的
// 另一处是 W4 的一次性磁盘资产改写（`appseed`）—— 那里只该问"这是不是历史取值"，
// 不该自己拼字面量、也不该直接引用常量（否则"历史取值的语义"就有了两个作者）。
func IsLegacyPublicAccess(s string) bool {
	return Access(s) == AccessPublic
}

// WritableAccess 报告 s 是否是**发布/校验**接受的 access 取值（2026-09-19 契约 §4.4）。
//
// 只有 login|whitelist：`public` 被明确拒绝（parseSubmitted 给出结构化
// APP_CONFIG_INVALID + hints，而不是静默改写成 login）。
func WritableAccess(s Access) bool {
	for _, v := range AccessWritableValues {
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

// Parse 解析并校验配置文件字节（**读取侧**口径）。
//
// 检查分两层，**Parse 已经把不依赖"是否首版"的全部检查做完**（含
// whitelist 模式的名单非空检查，即内部调用 Validate(false)）：
// 这样调用方忘记调用 Validate 也不会把一个"对所有人不可用"的应用放进来。
// 首次发布特有的声明字段要求由调用方另行调用 Validate(true)。
//
// 读取侧与写入侧的差别只有一条（2026-09-19 契约 §4.4）：**历史 `public` 在这里被
// 接受**（存量已发布版本的 `picoaide.app.json` 就写着它，拒绝会让应用每请求 500），
// 但它的语义已经是 login（RequiresLogin/AuthMode）。写入侧走 parseSubmitted，
// 那里 public 被明确拒绝。
//
// 失败一律 `APP_CONFIG_INVALID`(422)，details/hints 指名具体字段（§4.2 / §10.5 第 56b 项）。
func Parse(data []byte) (Config, *apperr.Error) {
	return parseAs(data, accessRead)
}

// parseSubmitted 是**写入侧**（发布/校验）的解析入口：与 Parse 逐条相同，
// 除了显式/映射出的 `access=public` 一律拒（契约 §4.4「新版本不得再写 public」）。
func parseSubmitted(data []byte) (Config, *apperr.Error) {
	return parseAs(data, accessWrite)
}

// accessMode 区分读取侧与写入侧（唯一差别见 parseSubmitted 的注释）。
type accessMode int

const (
	// accessRead 读取侧：接受历史 public（语义等同 login）。
	accessRead accessMode = iota
	// accessWrite 写入侧：public 一律拒。
	accessWrite
)

func parseAs(data []byte, mode accessMode) (Config, *apperr.Error) {
	c, e := decodeAs(data, mode)
	if e != nil {
		return Config{}, e
	}
	if e := c.Validate(false); e != nil {
		return Config{}, e
	}
	return c, nil
}

// decodeObject 把配置字节解成"字段 → 原始值"的 map，并完成**形态**检查
// （体积上限 / 合法 JSON / 顶层必须是对象 / 对象之后无多余内容）。
//
// 它是 decode 与 ParseUpdate（更新发布的字段继承）共用的第一步：两者对"什么样的
// 字节算一份配置"必须给出**逐字相同**的结论，否则"先合并再解析"会绕开某条检查。
func decodeObject(data []byte) (map[string]json.RawMessage, *apperr.Error) {
	if len(data) > limits.AppConfigMaxBytes {
		return nil, bad("", "应用配置文件超过大小上限").
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
		return nil, bad("", "应用配置文件不是合法 JSON").
			WithCause(err).
			WithHint(fmt.Sprintf("%s 必须是 UTF-8 JSON 对象，字段见 skill 模板（references/app-config.md）",
				limits.AppConfigFileName))
	}
	if dec.More() {
		return nil, bad("", "应用配置文件在 JSON 对象之后还有多余内容").
			WithHint("一个文件只能有一个顶层 JSON 对象")
	}
	// `null` 解码进 map 是 nil 且不报错（`{}` 才是空 map）⇒ 单独拦一次，
	// 否则"顶层必须是 JSON 对象"这条契约会被 null 静默绕过。
	if raw == nil {
		return nil, bad("", "应用配置文件的顶层必须是 JSON 对象").
			WithDetail("reason", "not_object").
			WithHint("写成 { ... }；字段见 skill 的 references/app-config.md")
	}
	return raw, nil
}

// decode 只做 schema 解析与旧形态映射（**读取侧**），**不做语义校验**（不检查
// "whitelist 模式必须有名单"）。外部用途是显示投影（AccessOfConfigJSON /
// DeclarationsOfConfigJSON）与继承基线（parseBaseline）：鉴权走 Parse、发布走 parseSubmitted。
func decode(data []byte) (Config, *apperr.Error) { return decodeAs(data, accessRead) }

// decodeAs 是 decode 的实现：mode 只影响 `access=public` 的处置（读取侧接受、
// 写入侧拒绝），其余逐条相同 —— 两条路对"什么样的字节算一份配置"必须给出同一个结论。
func decodeAs(data []byte, mode accessMode) (Config, *apperr.Error) {
	var c Config
	raw, oerr := decodeObject(data)
	if oerr != nil {
		return c, oerr
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

	// 声明敏感列：与 whitelist 同一条归一化纪律（去空白/拒空串/去重），
	// 但去重是**大小写不敏感**的（列名匹配本身不区分大小写，见 Config.SensitiveColumns）。
	if v, ok := raw[FieldSensitiveColumns]; ok {
		if e := json.Unmarshal(v, &c.SensitiveColumns); e != nil {
			return Config{}, bad(FieldSensitiveColumns, "sensitive_columns 必须是字符串数组").
				WithCause(e).
				WithHint(`每个条目是一个**列名**，如 ["workstation_no", "dorm_room"]`)
		}
	}
	declared, e := normalizeSensitiveColumns(c.SensitiveColumns)
	if e != nil {
		return Config{}, e
	}
	c.SensitiveColumns = declared

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
				WithHint("二选一：" + accessHintValues())
		}
		c.Access = Access(s)
		if !ValidAccess(c.Access) {
			return Config{}, bad(FieldAccess, fmt.Sprintf("access 取值 %q 不合法", s)).
				WithDetail("reason", "bad_access").
				WithDetail("values", strings.Join(AccessValues, ",")).
				WithHint("二选一：" + accessHintValues())
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
	// 写入侧（发布/校验）：历史 public 不得再写进新版本（契约 §4.4）。
	// 显式 `"access":"public"` 与旧 schema `login_required=false` 映射出的 public
	// 在这里得到**同一个**结构化错误 —— 两者都是"这次提交要求匿名"，都得拒。
	if mode == accessWrite && c.Access == AccessPublic {
		return Config{}, publicAccessRejected()
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
	if e := decodeWindow(raw, &c); e != nil {
		return Config{}, e
	}
	return c, nil
}

// decodeWindow 解析 `window` 对象（§6）。
//
// 三条形态规则（每条都对应一个可单独点红的判据）：
//   - **未知子键即拒**：`{"window":{"zoom":2}}` 是"作者以为平台会认"的典型形态，
//     静默忽略会让作者以为生效了（与顶层未知字段同一条纪律）；
//   - `ratio` 收 `"W:H"` 或数字：字符串按 `:` 拆两段比例（都必须是正数）；
//   - `width`/`height` 必须是**正整数**（浮点/字符串/0/负一律拒，不做四舍五入猜测）。
func decodeWindow(raw map[string]json.RawMessage, c *Config) *apperr.Error {
	body, ok := raw[FieldWindow]
	if !ok {
		return nil // 缺席：交给版本继承（inherit.go）与缺省值
	}
	trimmed := strings.TrimSpace(string(body))
	if trimmed == "" || trimmed == "null" {
		// 显式 `null` = 显式清空（与"缺席=沿用上一版"不同，这条语义由 inherit 承接）。
		c.Window = nil
		return nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(body, &obj); err != nil {
		return bad(FieldWindow, "window 必须是对象").
			WithCause(err).
			WithHint(`形如 {"window":{"ratio":"16:9","width":1280,"height":720}}`)
	}
	out := &WindowConfig{}
	for key, val := range obj {
		switch key {
		case "ratio":
			ratio, e := decodeWindowRatio(val)
			if e != nil {
				return e
			}
			// 取值域**在这里**就判（而不是留给 validateWindow 的 `Ratio != 0` 分支）：
			// 显式写 `"ratio": 0` 与"没写 ratio"在解析结果里都是 0.0，靠零值无法区分
			// —— 那会让"0"这条最常见的畸形输入悄悄通过（实测踩过）。
			if e := validateWindowRatio(ratio); e != nil {
				return e
			}
			out.Ratio = ratio
		case "width":
			n, e := decodeWindowPixels(val, "width")
			if e != nil {
				return e
			}
			out.Width = n
		case "height":
			n, e := decodeWindowPixels(val, "height")
			if e != nil {
				return e
			}
			out.Height = n
		default:
			return bad(FieldWindow, fmt.Sprintf("window 里的 %q 不是已知字段", key)).
				WithDetail("field", "window."+key).
				WithHint("只认三个子字段：window.ratio / window.width / window.height")
		}
	}
	// 校验放到 Validate（与其它字段同一条路径：Parse 只负责形态与取值域）。
	if e := validateWindow(out); e != nil {
		return e
	}
	c.Window = out
	return nil
}

// decodeWindowRatio 解析 ratio：`"W:H"` 或数字（§6）。
func decodeWindowRatio(val json.RawMessage) (float64, *apperr.Error) {
	text := strings.TrimSpace(string(val))
	if text == "" || text == "null" {
		return 0, bad(FieldWindow, "window.ratio 不能为空").
			WithDetail("field", "window.ratio").
			WithHint(`写 "W:H"（如 "16:9"）或浮点数（如 1.7778）`)
	}
	// 数字形态（不许字符串数字：`"1.5"` 与 `1.5` 是两种输入，收两种会让文档说不清）。
	if text[0] != '"' {
		var f float64
		if err := json.Unmarshal(val, &f); err != nil {
			return 0, bad(FieldWindow, `window.ratio 必须是数字或 "W:H" 字符串`).
				WithDetail("field", "window.ratio").
				WithHint(`示例：1.7778 或 "16:9"`)
		}
		return f, nil
	}
	var spec string
	if err := json.Unmarshal(val, &spec); err != nil {
		return 0, bad(FieldWindow, "window.ratio 不是合法字符串").WithDetail("field", "window.ratio")
	}
	w, h, ok := strings.Cut(strings.TrimSpace(spec), ":")
	if !ok {
		return 0, bad(FieldWindow, `window.ratio 字符串必须是 "宽:高" 形态`).
			WithDetail("field", "window.ratio").
			WithDetail("value", clipSpecValue(spec)).
			WithHint(`示例："16:9"、"4:3"；也可以直接写浮点数`)
	}
	wn, werr := strconv.ParseFloat(strings.TrimSpace(w), 64)
	hn, herr := strconv.ParseFloat(strings.TrimSpace(h), 64)
	if werr != nil || herr != nil || wn <= 0 || hn <= 0 {
		return 0, bad(FieldWindow, `window.ratio 的 "宽:高" 两侧都必须是正数`).
			WithDetail("field", "window.ratio").
			WithDetail("value", clipSpecValue(spec)).
			WithHint(`示例："16:9"（两侧都是正数）`)
	}
	return wn / hn, nil
}

// decodeWindowPixels 解析 width/height（正整数像素）。
func decodeWindowPixels(val json.RawMessage, name string) (int, *apperr.Error) {
	var f float64
	if err := json.Unmarshal(val, &f); err != nil {
		return 0, bad(FieldWindow, fmt.Sprintf("window.%s 必须是整数像素值", name)).
			WithDetail("field", "window."+name).
			WithHint(`示例：1280；不要写字符串（"1280px" 之类一律拒）`)
	}
	if f != float64(int(f)) {
		return 0, bad(FieldWindow, fmt.Sprintf("window.%s 必须是整数（像素没有小数）", name)).
			WithDetail("field", "window."+name)
	}
	return int(f), nil
}

// validateWindow 校验 window 的取值域（§6 的硬限制）。
//
// 与 `access` 的收敛同一条纪律：**能发布期拒的绝不留给运行期**。ratio 越界在这里
// 是 APP_CONFIG_INVALID（422），而不是等客户端开出一个畸形窗口。
func validateWindow(w *WindowConfig) *apperr.Error {
	if w == nil {
		return nil
	}
	// 0 = 未设置（作者没写 ratio）⇒ 不判；显式写 0 在 decodeWindow 里已被
	// validateWindowRatio 拒掉（零值无法区分两者，所以两条路径都要有）。
	if w.Ratio != 0 {
		if e := validateWindowRatio(w.Ratio); e != nil {
			return e
		}
	}
	for _, dim := range []struct {
		name string
		val  int
	}{{"width", w.Width}, {"height", w.Height}} {
		if dim.val == 0 {
			continue
		}
		if dim.val < WindowSizeMin || dim.val > WindowSizeMax {
			return bad(FieldWindow, fmt.Sprintf("window.%s 必须在 %d 到 %d 像素之间（当前 %d）",
				dim.name, WindowSizeMin, WindowSizeMax, dim.val)).
				WithDetail("field", "window."+dim.name).
				WithDetail("reason", "size_out_of_range").
				WithDetail("min", WindowSizeMin).
				WithDetail("max", WindowSizeMax)
		}
	}
	return nil
}

// validateWindowRatio 校验比例取值域（§6 的硬限制：0.25–4.0，0/负/非数字拒）。
func validateWindowRatio(ratio float64) *apperr.Error {
	if math.IsNaN(ratio) || math.IsInf(ratio, 0) || ratio < WindowRatioMin || ratio > WindowRatioMax {
		return bad(FieldWindow, fmt.Sprintf("window.ratio 必须在 %.2f 到 %.1f 之间（当前 %v）",
			WindowRatioMin, WindowRatioMax, ratio)).
			WithDetail("field", "window.ratio").
			WithDetail("reason", "ratio_out_of_range").
			WithDetail("min", WindowRatioMin).
			WithDetail("max", WindowRatioMax).
			WithHint("0/负/过大/非数字都不是合法比例；窗口比例是**强制锁定**项，越界会让窗口不可用")
	}
	return nil
}

// clipSpecValue 截断回显的作者输入（避免把超长/畸形内容原样回显）。
func clipSpecValue(s string) string {
	const max = 32
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
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
			WithHint("二选一：" + accessHintValues()).
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
	if len(c.SensitiveColumns) > limits.AppConfigSensitiveColumnsMax {
		return bad(FieldSensitiveColumns, "sensitive_columns 条目数超过上限").
			WithDetail("count", len(c.SensitiveColumns)).
			WithDetail("max", limits.AppConfigSensitiveColumnsMax).
			WithHint(fmt.Sprintf("声明上限 %d 条；超过说明该往默认脱敏的启发式上补（列名含 token/phone/realname 等词根即自动命中），"+
				"而不是把整张表的列都列进来", limits.AppConfigSensitiveColumnsMax))
	}
	// 单条长度在这里判（**唯一**的上限落点，与 whitelist 的条目数上限同一条分工：
	// normalize 只管形态）—— `Parse`/`parseSubmitted` 都会调用本函数，因此发布、
	// 校验、继承合并三条写入路径全部覆盖；直接构造的 Config（seed/测试）也覆盖。
	for i, name := range c.SensitiveColumns {
		if s := strings.TrimSpace(name); len(s) > limits.AppConfigSensitiveColumnMaxBytes {
			return bad(FieldSensitiveColumns, "sensitive_columns 的条目超过长度上限").
				WithDetail("reason", "entry_too_long").
				WithDetail("index", i).
				WithDetail("bytes", len(s)).
				WithDetail("max_bytes", limits.AppConfigSensitiveColumnMaxBytes).
				WithHint(fmt.Sprintf("每个条目只写**列名本身**（如 workstation_no）；超过 %d 字节说明整行/整段被粘了进来",
					limits.AppConfigSensitiveColumnMaxBytes))
		}
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

// accessHintValues 是 access 的二选一提示（唯一实现，供多处报错复用）。
//
// `whitelist` 那句必须写清**平台不比对名单**（R24）：说成"要求登录 + 名单准入"
// 会让作者以为填了名单平台就会拦，于是他写出一个对所有人开放的应用 ——
// 客户端的同名文案（`locales.ts` 的 `appCenter.access.whitelistHint`）已经是正确
// 口径（"平台不比对名单、由应用自己判"），这里的服务端 hint 与它对齐。
//
// 这里**不再列 public**（2026-09-19 契约 §4.4）：历史 public 的说明只在
// publicAccessRejected 里给一次，混进"合法取值"提示会让作者以为还能写。
func accessHintValues() string {
	return fmt.Sprintf("`access` = %q（要求登录，登录后全员可用，缺省）｜ %q（要求登录；名单只给应用自己读，平台不比对）",
		AccessLogin, AccessWhitelist)
}

// publicAccessRejected 是"写入侧不接受 access=public"的结构化错误（契约 §4.4）。
//
// 用 APP_CONFIG_INVALID(422) 而不是静默改写成 login：静默改写会让作者以为"我要求
// 匿名"被平台接受了，而实际得到的是一个要求登录的应用（与 inherit.go 头部那条
// "不猜访问级别"的纪律同一方向）。
func publicAccessRejected() *apperr.Error {
	return bad(FieldAccess, `access="public" 不再可用：应用只在桌面客户端内，且一律要求登录`).
		WithDetail("reason", "public_not_allowed").
		WithDetail("values", strings.Join(AccessWritableValues, ",")).
		WithHint("把 `access` 改成 \"login\"（登录后全员可用，缺省）或 \"whitelist\"（要求登录；名单由应用自己判）").
		WithHint("平台已删除匿名面：应用请求必须持员工令牌（浏览器也不再能打开应用，只有桌面客户端内可用）").
		WithHint("**历史** public 配置在读取侧按 login 处理（存量应用照常运行、不会 500），但新版本不得再写 public")
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

// normalizeSensitiveColumns 归一化作者声明的敏感列：去首尾空白、拒空串、
// **按大小写不敏感去重**（保留首次出现的原样写法）。
//
// 分工与 whitelist 逐字相同（normalize 只管**形态**，Validate 管**取值域/上限**）：
//   - 空串一律拒：`[""]` 是"从表格里粘了一列空行"的形态，静默丢掉会让作者以为已经
//     声明了某列；而空串永远匹配不到任何列，接受它等于接受一条"看起来声明了、实际
//     什么也没做"的记录；
//   - 去重不区分大小写：`["Phone"]` 与 `["phone"]` 是同一列（SQLite 列名不区分大小写，
//     启发式也先 ToLower），留两条会让 `masked_columns` 与配置里的条目数对不上；
//   - **长度与条目数上限不在这里判**（Validate 的职责）：它们是语义边界，而
//     normalize 在**读取侧**也会跑 —— 把上限塞进来会让一条手改过的存量行
//     从"能读"变成"每次请求都失败"，与"读取侧兼容"的纪律相反。
func normalizeSensitiveColumns(in []string) ([]string, *apperr.Error) {
	if len(in) == 0 {
		return nil, nil
	}
	out := make([]string, 0, len(in))
	seen := make(map[string]struct{}, len(in))
	for i, raw := range in {
		s := strings.TrimSpace(raw)
		if s == "" {
			return nil, bad(FieldSensitiveColumns, "sensitive_columns 含空条目").
				WithDetail("reason", "empty_entry").
				WithDetail("index", i).
				WithHint("去掉空行；每行一个列名（不要写空串占位）")
		}
		key := strings.ToLower(s)
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, s)
	}
	return out, nil
}

// SensitiveColumnSet 把声明列表转成**大小写不敏感**的匹配集合（宿主脱敏路径用）。
//
// 为什么不在这里做前缀/子串匹配：声明是**逐字**的（作者写的就是那一列的名字），
// 而启发式才负责"像密码的列"这种模糊判定。两者是不同强度的两条通道，混在一起会让
// "我声明的是 `no`" 意外遮掉 `order_no`。
//
// 空列表返回 nil（调用方可直接用 `_, ok := set[...]` 判，无需额外分支）。
func SensitiveColumnSet(declared []string) map[string]struct{} {
	if len(declared) == 0 {
		return nil
	}
	out := make(map[string]struct{}, len(declared))
	for _, name := range declared {
		s := strings.TrimSpace(name)
		if s == "" {
			continue
		}
		out[strings.ToLower(s)] = struct{}{}
	}
	return out
}

// DeclaredSensitiveColumn 报告列名是否被作者**声明**为敏感（大小写不敏感、逐字匹配）。
func DeclaredSensitiveColumn(set map[string]struct{}, name string) bool {
	if len(set) == 0 {
		return false
	}
	_, ok := set[strings.ToLower(strings.TrimSpace(name))]
	return ok
}

// SensitiveColumnsOfConfigJSON 从 `config_json` 投影里取作者声明的敏感列（唯一入口）。
//
// 与 AccessOfConfigJSON / DeclarationsOfConfigJSON 同一条纪律：
//   - 解析失败/空值一律回落**空名单**（"坏行不编造"）—— 回落方向是"只用默认启发式"，
//     不会因为一次投影读取失败就把某些列**取消**脱敏（声明本身是加法，不存在"取消"）；
//   - **只用于脱敏判定**：鉴权与发布一律走 Parse（Parse 还会做语义校验）。
//
// 生产路径的 `config_json` 是 `apps` 行的**已生效配置投影**（只有 approved 版本才写，
// 见 api/publish.go 的 F1）：待审版本不会改变脱敏口径，与目录显示同一条纪律。
func SensitiveColumnsOfConfigJSON(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	c, e := decode([]byte(raw))
	if e != nil {
		return nil
	}
	return c.SensitiveColumns
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
