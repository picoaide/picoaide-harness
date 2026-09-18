package main

import (
	"database/sql"
	"log"
	"net"
	"os"
	"strings"
	"sync/atomic"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/anonlimit"
	wasmapi "github.com/picoaide/picoaide/internal/wasmapp/api"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件是「应用泛域名」的运行期配置（2026-09-18 用户要求：
// 「管理端支持应用域名的泛域名配置 —— 应用名 + 泛域名就是应用的访问路径」）。
//
// 改造前的形态是**启动期环境变量**（`PICOAI_APPS_BASE_DOMAIN`）：
//   - `edge.HostGate` / `session` / `appserver` / `api` 各持一份不可变字符串；
//   - 未配置时 HostGate 干脆不安装。
// 那样"改一次基域 = 重新部署"，而控制台里根本看不到这一项。现在：
//   - 解析优先级：**控制台保存过（含显式清空）> 环境变量**；
//   - 持有者是 baseDomainHolder（原子读）：HostGate 每请求判一次，写路径只有控制台；
//   - HostGate **无条件常挂**（空基域时 MatchHost 全判主站，等价于没挂）；
//   - 启用时（保存成非空）**照跑**启动期的两条 fail-closed 自检，不过就拒绝保存。

// baseDomainHolder 持有当前应用基域（原子读，控制台可运行期改）。
type baseDomainHolder struct {
	db  *sql.DB
	env string

	value  atomic.Pointer[string]
	source atomic.Pointer[string]
}

// newBaseDomainHolder 解析初始值：控制台设置 > 环境变量 > 空（未启用子域）。
//
// 读设置失败（DB 抖动）不算致命：回落环境变量并在日志里说清楚 —— 基域读不出来
// 不该让整个服务端起不来（与"未配置"同一条降级路径）。
// @param db - 平台 PG 连接。
// @param envRaw - 环境变量取值（`PICOAI_APPS_BASE_DOMAIN`）。
// @returns 持有者（永远非 nil）。
func newBaseDomainHolder(db *sql.DB, envRaw string) *baseDomainHolder {
	h := &baseDomainHolder{db: db, env: strings.TrimSpace(envRaw)}
	value, source := "", "none"
	if raw, ok, err := serverstore.GetSetting(db, wasmapi.SettingAppsBaseDomain); err != nil {
		log.Printf("wasm: 读应用基域设置失败（回落环境变量）：%v", err)
		if h.env != "" {
			value, source = h.env, "env"
		}
	} else if ok {
		// 控制台保存过（哪怕是显式清空）⇒ 以它为准，不再看环境变量。
		value, source = strings.TrimSpace(raw), "setting"
	} else if h.env != "" {
		value, source = h.env, "env"
	}
	h.set(value, source)
	return h
}

// set 写入当前值（只在这里改，保证 value/source 成对更新）。
func (h *baseDomainHolder) set(value, source string) {
	v, s := value, source
	h.value.Store(&v)
	h.source.Store(&s)
}

// Get 返回当前应用基域（空 = 未启用应用子域）。HostGate 每请求调用，必须无锁快。
// @returns 当前基域（可能带 `http://` 前缀，见 normalizeBaseDomain）。
func (h *baseDomainHolder) Get() string {
	if p := h.value.Load(); p != nil {
		return *p
	}
	return ""
}

// Source 返回当前值的来源（"setting" / "env" / "none"），控制台展示用。
// @returns 来源标识。
func (h *baseDomainHolder) Source() string {
	if p := h.source.Load(); p != nil {
		return *p
	}
	return "none"
}

// Apply 保存应用基域：校验 → 启用时跑两条 fail-closed 自检 → 落库 → 生效。
//
// 为什么自检放在**这里**而不是只在启动时：启动自检保护的是"启用子域之后的运行期
// 语义"（匿名流量不许坍缩进同一个限流桶、内存四笔账不许超），而控制台让"启用"这件
// 事可以在运行期发生 —— 只在启动时挡住等于给了一条绕过它们的路（先不配基域启动、
// 再从控制台打开）。因此保存路径复用**同一批**判据，不另写一套。
// @param raw - 控制台提交的原始值（空串 = 关闭应用子域）。
// @returns nil 表示已生效；否则是可直接回给控制台的错误信封（带 hints）。
func (h *baseDomainHolder) Apply(raw string) *apperr.Error {
	next, aerr := normalizeBaseDomain(raw)
	if aerr != nil {
		return aerr
	}
	if next != "" {
		// R35：启用子域必须**显式**配置可信代理，否则全部匿名流量共用一个每 IP 桶。
		if err := anonlimit.CheckTrustedProxies(os.Getenv, true); err != nil {
			return apperr.From(err).WithDetail("field", "PICOAI_TRUSTED_PROXIES").
				WithHint("先在部署的 .env 里显式配置 PICOAI_TRUSTED_PROXIES（反代地址），再回来保存基域")
		}
		// §4.3：内存四笔账（实例池 + 编译峰值 + 上传峰值 + 缓存驻留）。
		if berr := checkStartupMemory(true, readMemAvailable(), log.Printf); berr != nil {
			return berr
		}
	}
	if h.db != nil {
		if err := serverstore.SetSetting(h.db, wasmapi.SettingAppsBaseDomain, next); err != nil {
			return apperr.New(apperr.CodeInternal, "保存应用基域失败").
				WithDetail("reason", err.Error()).
				WithHint("数据库写入失败；重试一次，仍失败请查看服务端日志")
		}
	}
	old := h.Get()
	h.set(next, "setting")
	log.Printf("wasm: 应用基域已更新 %q → %q（来源=控制台；应用访问地址 = 应用名 + %s）",
		old, next, domainSuffixForLog(next))
	return nil
}

// domainSuffixForLog 把基域渲染成日志里的可读后缀（未启用时给一句说明）。
// @param baseDomain - 当前基域。
// @returns 日志片段。
func domainSuffixForLog(baseDomain string) string {
	if baseDomain == "" {
		return "（已关闭应用子域）"
	}
	host := strings.TrimPrefix(strings.TrimPrefix(baseDomain, "https://"), "http://")
	return "." + host
}

// normalizeBaseDomain 校验并规范化控制台提交的基域。
//
// 接受：`example.com`、`apps.example.com`、`https://apps.example.com`、`http://…`
// （显式 http 表示明文部署，保留前缀）。空串 = 关闭应用子域（合法）。
// 拒绝：带端口/路径/查询、IP、单标签、非法字符、以及 `*.example.com`
// （通配符由证书与 DNS 侧配置，平台自己拼应用名）。
// @param raw - 原始输入。
// @returns 规范化后的值（可直接落库与解析）或错误信封。
func normalizeBaseDomain(raw string) (string, *apperr.Error) {
	v := strings.TrimSpace(raw)
	if v == "" {
		return "", nil
	}
	insecure := false
	lower := strings.ToLower(v)
	switch {
	case strings.HasPrefix(lower, "https://"):
		v = v[len("https://"):]
	case strings.HasPrefix(lower, "http://"):
		v = v[len("http://"):]
		insecure = true
	}
	if strings.HasPrefix(v, "*.") {
		return "", apperr.New(apperr.CodeValidation, "不要填通配符形式").
			WithDetail("reason", "wildcard_not_allowed").
			WithHint("填主域名本身即可（例如 example.com）：平台会用「应用名 + . + 该域名」拼出每个应用的地址；" +
				"通配符是证书与 DNS 侧的事（需要 *.example.com 的通配证书）")
	}
	v = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(v), "."))
	if v == "" {
		return "", apperr.New(apperr.CodeValidation, "基域格式不合法").
			WithDetail("reason", "empty_host").
			WithHint("填主域名，例如 example.com 或 apps.example.com")
	}
	if strings.ContainsAny(v, "/?#") || strings.Contains(v, ":") {
		return "", apperr.New(apperr.CodeValidation, "基域只能是域名本身").
			WithDetail("reason", "not_a_bare_host").
			WithHint("不要带端口、路径或查询串（只填域名，可带 http:// 前缀表示明文部署）")
	}
	if net.ParseIP(v) != nil {
		return "", apperr.New(apperr.CodeValidation, "基域不能是 IP 地址").
			WithDetail("reason", "ip_not_allowed").
			WithHint("应用地址是「应用名 + . + 基域」，IP 拼不出子域名；请填企业域名")
	}
	labels := strings.Split(v, ".")
	if len(labels) < 2 {
		return "", apperr.New(apperr.CodeValidation, "基域至少要两级").
			WithDetail("reason", "single_label").
			WithHint("例如 example.com；单标签（如 intranet）无法承载 <应用名>. 前缀")
	}
	for _, label := range labels {
		if label == "" || len(label) > 63 {
			return "", apperr.New(apperr.CodeValidation, "基域里有空的或过长的标签").
				WithDetail("reason", "bad_label").
				WithHint("每一级标签 1–63 个字符，且不能为空（例如 apps.example.com）")
		}
		if strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return "", apperr.New(apperr.CodeValidation, "域名标签不能以连字符开头或结尾").
				WithDetail("reason", "bad_label").
				WithHint("例如 app-center.example.com 合法，-app.example.com 不合法")
		}
		for _, r := range label {
			if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' {
				return "", apperr.New(apperr.CodeValidation, "域名只能用小写字母、数字与连字符").
					WithDetail("reason", "bad_label").
					WithHint("不要用下划线或其它符号（域名规则如此，不是平台的额外限制）")
			}
		}
	}
	// 与应用名同一条边界：别把平台保留字当基域（那会让 <保留字>.<基域> 的判别绕一圈）。
	if limit := int64(len(v)); limit > 253 {
		return "", apperr.New(apperr.CodeValidation, "基域过长").
			WithDetail("max", 253).WithDetail("actual", limit).
			WithHint("整个域名不超过 253 个字符")
	}
	_ = limits.AppIDPattern // 保留：基域校验与应用名边界由 registry 层各自负责，此处不复制正则
	if insecure {
		return "http://" + v, nil
	}
	return v, nil
}
