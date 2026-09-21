package appcfg

import (
	"encoding/json"
	"strings"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
)

// 本文件实现**更新发布**的配置继承语义（R1-pm-10 / R1-uxc-8）。
//
// 产品意图（三处证据一致，因此服务端必须兑现它而不是改文案）：
//   - 生成物 references/app-config.md 明写 purpose/data_sensitivity/owner
//     "首次发布必填，**之后的版本可沿用**"；
//   - AI 工具描述 `wasm_app_publish` 明写"更新版本时可以省略未改动的（服务端沿用原值）"；
//   - 人工发布表单会预填上一版配置，并对 access 变更二次确认（表单路径本来就
//     "缺省=沿用"）。
//
// 缺陷形态（审计实测）：prepare 之前只解析**本次**提交的字节，缺 access 就走
// `decode` 的兼容缺省 ⇒ login。于是"给这个应用发个小修复"这样一句纯代码更新，
// 会把 whitelist（白名单）应用静默放宽成"登录后全员可用"，并把负责人/敏感度/用途清空。
//
// 语义（判据的分界）：**字段缺席才继承**；
//   - 显式给值（含显式空串 `""` / 空数组 `[]`）一律以提交为准 —— 显式覆盖是作者的
//     意图，必须能真的把 access 改成 login、把名单清空、把声明清空；
//   - 首版（没有上一版）没有可继承的基线 ⇒ 缺省仍是 login（既有语义不回归）。
//
// 基线的真源**只有一个**：最新 approved 版本的 `config_json`（api/publish.go 的
// inheritBase 走 serverstore.LatestApprovedWasmReleaseMeta，与交付面/审批面同源）。
// 它**不是** `apps.config_json` 这一列 —— 那一列是显示投影，首版待审时也曾被写入，
// 拿它当基线等于让一个没人批准过的配置成为后续版本的默认值（2026-09-19 审计 §1.2）。
//
// 旧 schema 的 `visible` / `login_required`（兼容 shim）**不参与"字段是否缺席"的
// 判定**：它们既不算 access 的显式声明（新字段恒优先），也不会阻止 access 轴从基线
// 继承。理由：`visible` 的语义是"一律忽略"（2026-09-18 起目录不再过滤），
// `login_required` 是旧客户端才会写的形态 —— 让它们关掉继承，等于让一个语义上无
// 效果/历史遗留的键决定"这次要不要沿用线上访问级别"，实测能把白名单应用静默放宽
// （审计 §1.3）。旧形态的映射仍保留在 decode 的 shim 里，但**只在没有 access 可依**
// （首版、无基线）时才生效，与本次变更之前逐字相同。

// ParseUpdate 解析**更新发布**的配置：提交里缺席的字段从上一版生效配置继承，
// 然后走与 Parse **完全相同**的解析与校验路径（合并结果仍是这份字节）。
//
// previousConfigJSON 是上一版生效配置的 `config_json`（api 侧的继承基线）：
//   - 空串/空白 = 没有基线（首版、或生效版本本来就没有配置）⇒ 与 Parse(data) 逐字等价；
//   - 非空但解析不了 = **拒绝发布**（BaselineUnusable，见 UnusableBaselineError）：
//     此时按 schema 缺省落 login 对白名单应用是**放宽**而不是收紧，不能猜。
//
// 返回值与 Parse 同族：合并后的对象仍然要过未知字段检查、取值范围检查、
// 语义检查（如 access=whitelist 需要名单）—— 继承不会绕过任何一条。
//
// 与 Parse 的唯一差别（2026-09-19 契约 §4.4）：这是**写入侧**入口 ⇒ 提交里显式写
// `access=public`（或旧 schema 的 `login_required=false`）一律被拒（parseSubmitted）；
// 而**基线**里的历史 public 在读取侧即 login，因此"省略 access 的纯代码更新"继承到
// 的是 login —— 既不会把 public 带进新版本，也不会因为基线是 public 而卡住一次更新。
func ParseUpdate(data []byte, previousConfigJSON string) (Config, *apperr.Error) {
	base, state := parseBaseline(previousConfigJSON)
	switch state {
	case BaselineUnusable:
		// 不猜：把"基线不明"翻译成 login，等于把一次数据损坏变成一次访问级别放宽。
		return Config{}, UnusableBaselineError()
	case BaselineAbsent:
		return parseSubmitted(data)
	}
	submitted, oerr := decodeObject(data)
	if oerr != nil {
		return Config{}, oerr
	}
	merged, merr := json.Marshal(mergeMissing(submitted, base))
	if merr != nil {
		// map[string]json.RawMessage 编码只可能因非法 RawMessage 失败，
		// 而两个来源都刚被 JSON 解码器验证过 ⇒ 到这里只可能是平台缺陷。
		return Config{}, bad("", "应用配置文件合并失败").WithCause(merr)
	}
	return parseSubmitted(merged)
}

// BaselineState 是继承基线的可用性三态（发布链路据此决定"能不能发"）。
type BaselineState int

const (
	// BaselineAbsent：没有可继承的基线 —— 首版（没有任何版本）、没有任何 approved
	// 版本、或生效版本本来就没有配置文件（空 `config_json`）。
	//
	// 空 `config_json` 归到"没有基线"而不是"不可用"：这样的生效版本按
	// AccessOfConfigJSON 也是 login（它从未声明过访问模式），"缺省=login"与它自身
	// 一致，不构成任何放宽。
	BaselineAbsent BaselineState = iota
	// BaselineUsable：基线可解析，提交里缺席的字段按它继承。
	BaselineUsable
	// BaselineUnusable：**存在**基线字节但解析不了 —— 平台无法确定"上一版生效的
	// 访问级别是什么"。
	//
	// 方向必须说对：此时按 schema 缺省落 login，**对白名单应用是放宽**（whitelist =
	// 登录 + 名单，login = 登录后全员），不是"更严格的一侧"。因此发布链路 fail-closed：
	// api/publish.go 的 inheritBase 在这里**拒绝发布**并给出可操作错误，
	// ParseUpdate 自己也不接受不可用基线（UnusableBaselineError）。
	BaselineUnusable
)

// BaselineStateOf 只读地报告 previousConfigJSON 能否作为继承基线（不解析提交字节）。
//
// 用途：发布链路把"基线不可用"翻译成**点名版本号**的可操作错误（api/publish.go 的
// inheritBase）—— ParseUpdate 只拿得到字节，报不出"是哪一版坏了"。
func BaselineStateOf(previousConfigJSON string) BaselineState {
	_, state := parseBaseline(previousConfigJSON)
	return state
}

// UnusableBaselineError 是"基线不可用 ⇒ 拒绝发布"的结构化错误（唯一实现：判据与
// 文案在这里，api 层负责补上"坏的是哪一版"的 details）。
//
// 为什么拒绝而不是回落 login（2026-09-19 审计 §1.4 的二选一，选前者）：
//   - **方向**：回落 login 对 whitelist 应用是放宽，而这条链路的全部意义就是
//     "代码更新不得改写访问级别"；
//   - **可诊断性**：静默放宽在作者侧零信号（只有一条 access_change 审计行），
//     拒绝会当场告诉他"上一版的配置没读出来、继承没有发生"；
//   - **代价可控**：生产链路上每个 approved 版本的 `config_json` 都出自本包的
//     Parse（发布）或 appseed 的 Parse（播种），所以"不可用基线"只可能来自手工改库
//     或迁移 0071 明确跳过的坏行 —— 正是最不该猜的一类输入。恢复路径写在 hints 里。
func UnusableBaselineError() *apperr.Error {
	return apperr.New(apperr.CodeAppConfigBad,
		"该应用已生效版本的配置无法解析（平台侧数据问题），不能确定要沿用的配置：已拒绝发布").
		WithDetail("reason", "baseline_unusable").
		WithHint("坏的是**已生效版本**的 config_json，不是本次提交：基线不明时缺席的 access 会回落 login，" +
			"对白名单（whitelist）应用等于放宽，所以平台宁可拒发而不是猜").
		WithHint("恢复路径：让管理员检查该应用最新已通过版本的 config_json（app_releases 行）并修正，" +
			"或先审批一个配置完整的历史待审版本 —— 它会成为新的继承基线，之后即可正常发布").
		WithHint("本次若**显式**写全 access/whitelist/三个声明，也要先修好那一行再发：平台不对坏行做猜测")
}

// mergeMissing 把 base 里**提交未给出**的字段填进提交对象。
//
// 只有"提交里真的没有这个键"才填：显式给值（含显式空串与空数组）是作者的意图，
// 必须原样保留。旧 schema 的 `visible` / `login_required` **不参与这个判定**
// （判据见文件头）：带了它们不等于"access 已声明"，也不等于"这次不继承 access 轴"。
func mergeMissing(submitted, base map[string]json.RawMessage) map[string]json.RawMessage {
	// 容量提示只按**平台常量字段表**取。2026-09-21（CodeQL #95 `go/allocation-size-overflow`）：
	// 原来写的是 `len(submitted)+len(base)` —— 两个"可能很大的值"相加后直接当分配尺寸，
	// 是静态分析眼里的溢出算术面（实践中不可能，但容量提示本来就只是省几次扩容的优化，
	// 没有任何理由为它留一条算术路径；`submitted` 的键数由请求体决定）。
	out := make(map[string]json.RawMessage, len(KnownFields))
	for k, v := range submitted {
		out[k] = v
	}
	for _, k := range KnownFields {
		if _, ok := out[k]; ok {
			continue
		}
		if v, ok := base[k]; ok {
			out[k] = v
		}
	}
	return out
}

// parseBaseline 把上一版的 `config_json` 归一化成"可继承字段 → 原始值"的 map 并给出
// 可用性三态。
//
//   - 旧 schema 的行先经 decode 映射成新 schema（"重新发布后写出的就是新 schema"
//     这条既有承诺在继承上同样成立）；
//   - **历史 public 归一化成 login**（2026-09-19 契约 §4.4 的读取侧口径）：继承出来的
//     新版本因此写 login —— 既不会把已被取消的 public 带进新版本（写入侧本来就会拒），
//     也不会让一次纯代码更新因为"基线里有个已废除的取值"而失败；
//   - **空值不算上一版给过的值**：access 非法、whitelist/敏感列声明为空、window 为
//     `{}`、声明类文本为空白串一律丢弃 —— "上一版没有这项"不能被继承成"上一版给了一个
//     空值"，否则缺省语义会被抹掉（判据按**字段类型**分支，见 baselineValueUsable）；
//   - 解析不了 ⇒ BaselineUnusable（**不是**"没有基线"）：调用方必须 fail-closed。
func parseBaseline(previousConfigJSON string) (map[string]json.RawMessage, BaselineState) {
	if strings.TrimSpace(previousConfigJSON) == "" {
		return nil, BaselineAbsent
	}
	prev, perr := decode([]byte(previousConfigJSON))
	if perr != nil {
		return nil, BaselineUnusable
	}
	if prev.Access == AccessPublic {
		prev.Access = AccessLogin
	}
	canon, err := json.Marshal(prev)
	if err != nil {
		return nil, BaselineUnusable
	}
	var base map[string]json.RawMessage
	if err := json.Unmarshal(canon, &base); err != nil {
		return nil, BaselineUnusable
	}
	for k, raw := range base {
		if !baselineValueUsable(k, raw) {
			delete(base, k)
		}
	}
	if len(base) == 0 {
		return nil, BaselineAbsent
	}
	return base, BaselineUsable
}

// baselineValueUsable 判定上一版某个字段的值能不能作为**继承基线**。
//
// 两类"不可用"：
//   - **不是那个类型的值**（对象被当成字符串解码、数组被当成字符串解码…）；
//   - **空值不算"上一版给过值"**：`""` / `[]` / `{}` / 非法 access 一律不算 ——
//     "上一版没有这项"不能被继承成"上一版给了一个空值"，否则 schema 缺省语义会被抹掉。
//
// ⚠️ 按字段**类型**分支（而不是"字符串兜底"）是这段代码的**硬要求**：兜底写法会让
// 非字符串字段（`window` 对象、`whitelist`/`sensitive_columns` 数组）解码失败并被
// `delete` —— 表现是"上一版声明过的字段在一次纯代码更新里静默消失"，而新版本看起来
// 一切正常（2026-09-21 实测：`window` 就是这样被丢掉的，与生成物里"整个 window 缺席 =
// 沿用上一版生效值"的承诺直接矛盾）。
//
// 覆盖纪律：`KnownFields` 的**每个**字段都必须在这里有显式分支，由
// TestBaselineEveryKnownFieldHasTypedBranch 双向钉住（新增字段忘了登记 ⇒ 红）。
// `default` 因此理论上不可达；真到了那里就**不继承**（拿不准的东西不往新版本里带），
// 而不是像旧实现那样"按字符串试试看"。
func baselineValueUsable(key string, raw json.RawMessage) bool {
	switch key {
	case FieldWhitelist, FieldSensitiveColumns:
		// 同族数组字段（准入名单 / 声明敏感列）：两者语义逐条相同 —— 非空数组才算给过值。
		var list []string
		return json.Unmarshal(raw, &list) == nil && len(list) > 0
	case FieldWindow:
		// 对象字段：`{}` 与"缺席"在继承上同义（都没有可沿用的取值），
		// 显式 `null` 在 decodeWindow 里是"清空"，同样不算给过值。
		var obj map[string]json.RawMessage
		return json.Unmarshal(raw, &obj) == nil && len(obj) > 0
	case FieldAccess:
		var s string
		return json.Unmarshal(raw, &s) == nil && ValidAccess(Access(s))
	case FieldPurpose, FieldDataSensitivity, FieldOwner:
		// 自由文本声明字段：空白串不算给过值（见本文件头部"空值不算上一版给过的值"）。
		var s string
		return json.Unmarshal(raw, &s) == nil && strings.TrimSpace(s) != ""
	default:
		return false
	}
}

// DeclarationsOfConfigJSON 从 `config_json` 投影里取 purpose / data_sensitivity。
//
// 用途只有一个：审核（approve/reject）把 apps 行的**投影**重算为"最新 approved
// 版本"的配置时，这两列与 config_json 必须同时回到同一版（它们是同一份配置的
// 三个投影列）。解析失败回落空串，与 AccessOfConfigJSON 的"坏行不编造"同向。
func DeclarationsOfConfigJSON(raw string) (purpose, sensitivity string) {
	if strings.TrimSpace(raw) == "" {
		return "", ""
	}
	c, e := decode([]byte(raw))
	if e != nil {
		return "", ""
	}
	return c.Purpose, c.DataSensitivity
}
