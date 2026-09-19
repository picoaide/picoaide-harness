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
// 基线是"上一版**生效**配置"（api 侧传 apps.config_json，R1-pm-9 之后它只由
// approved 版本写入），不是最新一次提交：待审版本的配置没有被任何人批准过，
// 不该成为下一版的默认值。

// ParseUpdate 解析**更新发布**的配置：提交里缺席的字段从上一版生效配置继承，
// 然后走与 Parse **完全相同**的解析与校验路径（合并结果仍是这份字节）。
//
// previousConfigJSON 是上一版生效配置的 `config_json`（api 侧的继承基线）：
//   - 空串/空白 = 没有基线（首版、或基线不可用）⇒ 与 Parse(data) 逐字等价；
//   - 坏 JSON = 不继承（缺省回落 login，即更严格的一侧），且**不**因为投影坏行
//     而拒绝发布 —— 投影是显示面，作者不该为平台侧的坏行付出一次发布失败。
//
// 返回值与 Parse 同族：合并后的对象仍然要过未知字段检查、取值范围检查、
// 语义检查（如 access=whitelist 需要名单）—— 继承不会绕过任何一条。
func ParseUpdate(data []byte, previousConfigJSON string) (Config, *apperr.Error) {
	base := inheritBaseline(previousConfigJSON)
	if base == nil {
		return Parse(data)
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
	return Parse(merged)
}

// mergeMissing 把 base 里**提交未给出**的字段填进提交对象。
//
// 旧 schema 的例外：提交里出现 `login_required` / `visible` 时，access 轴（access 与
// whitelist）**整条不继承**。旧形态的 `login_required=true` 就是"要求登录"的显式
// 声明，而旧 schema 的 access 取值由 shim 依据 login_required + whitelist 落定 ——
// 若让继承来的 `access` 抢在它前面，一次旧客户端的更新就会把 `login_required=true`
// 静默变成上一版的 public（放宽），正是本次要修的缺陷的镜像形态。
// 此时 access/whitelist 由 decode 的兼容 shim 按旧语义落定，与本次变更之前逐字相同。
func mergeMissing(submitted, base map[string]json.RawMessage) map[string]json.RawMessage {
	out := make(map[string]json.RawMessage, len(submitted)+len(base))
	for k, v := range submitted {
		out[k] = v
	}
	legacyAccessAxis := hasKey(out, legacyFieldLoginRequired) || hasKey(out, legacyFieldVisible)
	for _, k := range KnownFields {
		if _, ok := out[k]; ok {
			continue
		}
		if legacyAccessAxis && (k == FieldAccess || k == FieldWhitelist) {
			continue
		}
		if v, ok := base[k]; ok {
			out[k] = v
		}
	}
	return out
}

// inheritBaseline 把上一版的 `config_json` 归一化成"可继承字段 → 原始值"的 map。
//
//   - 旧 schema 的行先经 decode 映射成新 schema（"重新发布后写出的就是新 schema"
//     这条既有承诺在继承上同样成立）；
//   - **空值不算上一版给过的值**：access 非法、whitelist 为空、声明为空白串一律丢弃
//     —— "上一版没有这项"不能被继承成"上一版给了一个空串"，否则缺省语义会被抹掉。
//
// 返回 nil 表示没有可用的基线（缺失/坏 JSON/全部字段为空）。
func inheritBaseline(previousConfigJSON string) map[string]json.RawMessage {
	if strings.TrimSpace(previousConfigJSON) == "" {
		return nil
	}
	prev, perr := decode([]byte(previousConfigJSON))
	if perr != nil {
		return nil
	}
	canon, err := json.Marshal(prev)
	if err != nil {
		return nil
	}
	var base map[string]json.RawMessage
	if err := json.Unmarshal(canon, &base); err != nil {
		return nil
	}
	for k, raw := range base {
		switch k {
		case FieldWhitelist:
			var list []string
			if json.Unmarshal(raw, &list) != nil || len(list) == 0 {
				delete(base, k)
			}
		case FieldAccess:
			var s string
			if json.Unmarshal(raw, &s) != nil || !ValidAccess(Access(s)) {
				delete(base, k)
			}
		default:
			var s string
			if json.Unmarshal(raw, &s) != nil || strings.TrimSpace(s) == "" {
				delete(base, k)
			}
		}
	}
	if len(base) == 0 {
		return nil
	}
	return base
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

func hasKey(m map[string]json.RawMessage, k string) bool {
	_, ok := m[k]
	return ok
}
