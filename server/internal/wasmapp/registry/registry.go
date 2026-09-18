// Package registry 实现 WASM 应用的**标识与版本规则**（设计基线 §4.1）
// 与随之而来的制品配额检查（§5.3）。
//
// 这里只做"纯规则"，不碰数据库：调用方（api 层）负责在写库前后调用它，
// 因此规则可以被穷举测试，也不会与 DAO 的 SQL 语义纠缠。
//
// 为什么 app_id 规则比技能/智能体的更严（§4.1）：
// **app_id 本身就是域名标签**（R3）⇒ 它同时受 DNS 规则、浏览器同源策略与
// 企业域名资产三条约束；一个疏忽就是"应用占用了企业既有主机名"或
// "应用拿到一个证书覆盖不到的域名"。
package registry

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

var (
	appIDRe   = regexp.MustCompile(limits.AppIDPattern)
	versionRe = regexp.MustCompile(limits.VersionPattern)
	// allDigits 用于"不得纯数字"（避免 IP 形态，§4.1）。
	allDigits = regexp.MustCompile(`^[0-9]+$`)
)

// KindWasmApp 是 wasm 应用在统一应用模型里的 kind 取值（§13）。
const KindWasmApp = "wasm_app"

// reservedSet 是保留字集合（构建一次；内容来自 limits，唯一真源）。
var reservedSet = func() map[string]struct{} {
	m := make(map[string]struct{}, len(limits.ReservedAppIDs))
	for _, w := range limits.ReservedAppIDs {
		m[w] = struct{}{}
	}
	return m
}()

// CheckAppIDShape 只校验 app_id 的**形态**（空 / 长度 / 字符集），不做业务规则。
//
// 拆出来的理由（FIX-28）：换票端点（session 包）拿到的 `app` 参数是**外部入参**，
// 必须先过形态闸再谈"存不存在"；而它同时又要过业务规则（纯数字 / `xn--` / 保留字 /
// 企业既有主机名）。两处共用同一份形态正则，才不会漂移出"POST 接受、子域 404"
// 这种分叉状态。
//
// **大小写敏感**：只接受小写。理由是这个串随后会被直接拿去拼域名与做跳转，
// 静默小写化会让调用方手里的"原串"与实际使用的 app_id 不一致 —— 那正是
// "签出一张绑真实应用、却跳到另一个主机名的票"的成因（见 session.sanitizeAppID）。
// 域名标签本身不区分大小写，但 app_id 是**标识**，规范形态只有一种。
func CheckAppIDShape(id string) *apperr.Error {
	if id == "" {
		return apperr.New(apperr.CodeInvalidAppID, "app_id 不能为空").
			WithHint("app_id 就是域名标签：小写字母/数字/连字符，≤63 字符")
	}
	if len(id) > limits.MaxAppIDLen {
		return apperr.New(apperr.CodeInvalidAppID, "app_id 过长").
			WithDetail("max_len", limits.MaxAppIDLen).WithDetail("actual_len", len(id)).
			WithHint("app_id 是域名标签，受 DNS 的 63 字符上限约束")
	}
	if !appIDRe.MatchString(id) {
		return apperr.New(apperr.CodeInvalidAppID, "app_id 含非法字符").
			WithDetail("pattern", limits.AppIDPattern).
			WithHint("只允许小写字母、数字与单个连字符分隔（不得有连续连字符、不得以连字符开头或结尾）")
	}
	return nil
}

// ValidateAppID 校验 app_id（§4.1 + §10.5 第 52/53/53b 项）。
//
// extraReserved 是**部署期注入的企业已知主机名**（基域是平台资产，不能占）。
func ValidateAppID(id string, extraReserved []string) *apperr.Error {
	if aerr := CheckAppIDShape(id); aerr != nil {
		return aerr
	}
	if allDigits.MatchString(id) {
		return apperr.New(apperr.CodeInvalidAppID, "app_id 不能是纯数字").
			WithHint("纯数字形态会被误认成 IP 地址，请换一个含字母的名字")
	}
	if strings.HasPrefix(id, "xn--") {
		return apperr.New(apperr.CodeInvalidAppID, "app_id 不能以 xn-- 开头").
			WithHint("xn-- 是 punycode 前缀，保留给国际化域名")
	}
	if _, ok := reservedSet[id]; ok {
		return apperr.New(apperr.CodeInvalidAppID, "app_id 是平台保留字").
			WithDetail("reserved", id).
			WithHint("该名字是平台/企业既有主机名，请换一个名字")
	}
	for _, r := range extraReserved {
		if strings.EqualFold(strings.TrimSpace(r), id) {
			return apperr.New(apperr.CodeInvalidAppID, "app_id 与企业既有主机名冲突").
				WithDetail("reserved", id).
				WithHint("该主机名已在企业 DNS 中使用，请换一个名字")
		}
	}
	return nil
}

// ValidateVersion 校验版本号（§4.1 + §10.5 第 54 项）。
func ValidateVersion(v string) *apperr.Error {
	if v == "" {
		return apperr.New(apperr.CodeVersionInvalid, "版本号不能为空").
			WithHint("版本号必须是 x.y.z（可带 -prerelease），且严格递增")
	}
	if !versionRe.MatchString(v) {
		return apperr.New(apperr.CodeVersionInvalid, "版本号格式非法").
			WithDetail("pattern", limits.VersionPattern).WithDetail("version", v).
			WithHint("必须是 x.y.z 形态，例如 1.0.0 / 2.3.1-beta.1")
	}
	return nil
}

// CompareVersions 比较两个合法版本号的先后（-1 / 0 / 1）。
//
// 规则（§4.1「必须严格递增」）：
//   - 先比 x.y.z 数值；
//   - 数值相同时：**无 prerelease > 有 prerelease**（1.0.0 > 1.0.0-beta.1，语义化版本）；
//   - 都有 prerelease 时按点分段比较：纯数字段按数值比，否则按字典序；数字段 < 非数字段。
//
// 调用方必须先 ValidateVersion，本函数不检查格式（非法输入返回 0 并视为相等，
// 由调用方的校验兜住）。
func CompareVersions(a, b string) int {
	am, bm := splitVersion(a), splitVersion(b)
	for i := 0; i < 3; i++ {
		if am.core[i] != bm.core[i] {
			if am.core[i] < bm.core[i] {
				return -1
			}
			return 1
		}
	}
	// 数值相同：无 prerelease 的更大。
	if am.pre == "" && bm.pre == "" {
		return 0
	}
	if am.pre == "" {
		return 1
	}
	if bm.pre == "" {
		return -1
	}
	return comparePre(am.pre, bm.pre)
}

// MustBeNewer 判定 candidate 是否严格新于 current（§10.5 第 54 项）。
func MustBeNewer(candidate, current string) *apperr.Error {
	if current == "" {
		return nil // 首个版本
	}
	if CompareVersions(candidate, current) <= 0 {
		return apperr.New(apperr.CodeVersionNotNewer, "版本号必须严格递增").
			WithDetail("candidate", candidate).WithDetail("current", current).
			WithHint("已落行的版本号永久占号（包括被拒与软删的版本）")
	}
	return nil
}

type parsedVersion struct {
	core [3]int
	pre  string
}

func splitVersion(v string) parsedVersion {
	core, pre := v, ""
	if i := strings.IndexByte(v, '-'); i >= 0 {
		core, pre = v[:i], v[i+1:]
	}
	var p parsedVersion
	parts := strings.Split(core, ".")
	for i := 0; i < 3 && i < len(parts); i++ {
		n, _ := strconv.Atoi(parts[i])
		p.core[i] = n
	}
	p.pre = pre
	return p
}

func comparePre(a, b string) int {
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(as) && i < len(bs); i++ {
		x, y := as[i], bs[i]
		xn, xErr := strconv.Atoi(x)
		yn, yErr := strconv.Atoi(y)
		switch {
		case xErr == nil && yErr == nil:
			if xn != yn {
				if xn < yn {
					return -1
				}
				return 1
			}
		case xErr == nil: // 数字段 < 非数字段（语义化版本 §11.4）
			return -1
		case yErr == nil:
			return 1
		default:
			if x != y {
				if x < y {
					return -1
				}
				return 1
			}
		}
	}
	switch {
	case len(as) < len(bs):
		return -1
	case len(as) > len(bs):
		return 1
	}
	return 0
}

// ValidateChangelog 校验 changelog（§4.1：非首版必填，空即拒 422 MISSING_FIELD）。
func ValidateChangelog(changelog string, isFirstRelease bool) *apperr.Error {
	if isFirstRelease {
		return nil
	}
	if strings.TrimSpace(changelog) == "" {
		return apperr.New(apperr.CodeMissingField, "非首版必须填写更新说明").
			WithDetail("field", "changelog").
			WithHint("写清这一版改了什么，便于使用者决定是否升级")
	}
	return nil
}

// CheckArtifactQuota 校验每用户制品总量（§5.3：1 GiB，PG BYTEA 口径，含全部版本）。
//
// usedBytes 是**已占用**字节；incomingBytes 是本次要新增的字节。
func CheckArtifactQuota(usedBytes, incomingBytes int64) *apperr.Error {
	if incomingBytes < 0 {
		incomingBytes = 0
	}
	if usedBytes+incomingBytes <= limits.ArtifactQuotaPerUserBytes {
		return nil
	}
	return apperr.New(apperr.CodeValidation, "制品总量超出配额").
		WithDetail("quota_bytes", int64(limits.ArtifactQuotaPerUserBytes)).
		WithDetail("used_bytes", usedBytes).
		WithDetail("incoming_bytes", incomingBytes).
		WithHint("每用户全部应用的全部版本合计上限 1 GiB；请删除不再使用的版本或联系平台管理员扩容")
}

// NormalizeAppID 把用户输入的 app_id 归一到入库形态（小写、去空白）。
//
// **不改名**是硬规则（§4.1）：归一化只在创建时发生，已存在的 app_id 一律原样使用。
func NormalizeAppID(id string) string {
	return strings.ToLower(strings.TrimSpace(id))
}
