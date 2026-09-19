package session

import (
	"net"
	"net/http"
	"strings"

	"golang.org/x/net/publicsuffix"
)

// 本文件是「应用基域」判定的**唯一真源**（2026-09-19 第三轮对抗审计 A-1/A-2/A-6 修复）。
//
// 为什么不能把"浏览器会不会存这条 Cookie"外包给 net/http（旧 cookieDomainWritable 的做法）：
// 那个判据实际问的是 `http.Cookie.String()` 的**序列化**行为，而 go1.26 的
// `isCookieDomainName` 去掉了结尾 `partlen == 0` 判据 ⇒ 尾点域被放行；它也从不区分
// "公网后缀 / 单标签 / localhost"。这些形态**服务端写得出去、浏览器整条丢弃**
// （RFC 6265 §5.3 第 6 步：Domain 必须与响应主机 domain-match，且必须是
// "registry-controlled domain"）——服务端 200 + 零 ERROR + 零审计，兑换恒失败，
// 即审计所称的"静默死"。真 Chromium 实测（temp/audit-round3/A/chromium-cookie-probe2.mjs）：
// `Domain=apps.example.com.` / `Domain=intranet` / `Domain=com` / `Domain=localhost`
// 全部 DROPPED，控制组 `Domain=apps.example.com` STORED。
//
// 因此判据自己实现，两层共用**同一份形状实现**（canonicalHostOnly）：
//  1. 形状：小写、去空白、剥 scheme、剥端口（Cookie 作用域不含端口）、剥尾点；
//  2. 策略：拒空标签/单标签/公网后缀/localhost/非法字符/超长/IP 字面量/**多尾点**。
//
// 三条消费路径**同源**（cmd/server 的表驱动用例钉住"同一输入同一结论"）：
//   - 运行期签发：ticketNonceDecision / cookieDomainWritable（拒绝 ⇒ 500 + ERROR + 审计，
//     绝不静默退化成 host-only）；
//   - 控制台保存：normalizeBaseDomain（拒绝 ⇒ 400 信封 + hints）与 Apply 的第三条
//     fail-closed 自检（基域可承载 Cookie **且**与对外地址同域）；
//   - 启动期：`PICOAI_APPS_BASE_DOMAIN` 走同一个 InspectAppBaseDomain（拒绝 ⇒ 拒绝启动）。

// 基域拒绝原因码（稳定、机器可读）：控制台 details.reason、日志、审计、测试共用一份。
const (
	// reasonBaseDomainEmptyHost：归一化后拿不到主机名（空值 / 只有端口 / 裸 IPv6）。
	reasonBaseDomainEmptyHost = "empty_host"
	// reasonBaseDomainWildcard：`*.example.com`（通配符是证书与 DNS 侧的事）。
	reasonBaseDomainWildcard = "wildcard_not_allowed"
	// reasonBaseDomainNotBareHost：带路径/查询，或 IPv6 字面量（方括号写法）。
	reasonBaseDomainNotBareHost = "not_a_bare_host"
	// reasonBaseDomainMultipleDots：结尾有 ≥2 个点（`apps.example.com..`）——歧义写法一律拒。
	reasonBaseDomainMultipleDots = "multiple_trailing_dots"
	// reasonBaseDomainIP：IP 字面量（拼不出子域名，浏览器也不接受 IP 上的 Domain Cookie）。
	reasonBaseDomainIP = "ip_not_allowed"
	// reasonBaseDomainSingleLabel：单标签（`intranet`）——无法承载 `<应用名>.` 前缀。
	reasonBaseDomainSingleLabel = "single_label"
	// reasonBaseDomainBadLabel：空标签/超长标签/非法字符/连字符在首尾/下划线。
	reasonBaseDomainBadLabel = "bad_label"
	// reasonBaseDomainTooLong：总长超过 253。
	reasonBaseDomainTooLong = "too_long"
	// reasonBaseDomainPublicSuffix：本身是公网后缀（`com`、`co.uk`、`github.io`）。
	reasonBaseDomainPublicSuffix = "public_suffix"
	// reasonBaseDomainReservedHost：保留主机名（`localhost`、`.local` 这类 mDNS 域）。
	reasonBaseDomainReservedHost = "reserved_host"
)

// AppBaseDomainVerdict 是一次基域判定的完整结果（判定 + 依据 + 可行动作）。
type AppBaseDomainVerdict struct {
	// Host 是归一化后的主机名（小写、无端口、无尾点）。`Reason == ""` 时可用；
	// 输入为空（= 关闭应用子域）时也是空串且 `Reason == ""`。
	Host string
	// Insecure 表示输入显式写了 `http://`（明文部署）。
	Insecure bool
	// HadPort 表示输入带了端口（端口一律忽略：Cookie 的作用域不含端口）。控制台的
	// **拼写规则**据此要求规范写法（见 cmd/server 的 normalizeBaseDomain），
	// 而 env / 运行期路径接受并归一化掉它 —— 判据（能不能承载 Cookie）不受影响。
	HadPort bool
	// Reason 非空 = 拒绝（取值见 reasonBaseDomain* 常量）。
	Reason string
	// Message 是一句话说明（控制台 / 日志）。
	Message string
	// Hint 是**可行动作**（控制台 hints / 启动期错误文案）。
	//
	// 文案纪律与 ticketNonceRemedy* 相同：只准写运维/管理员**真的能做**的动作，
	// 不得指向任何 Go 字段或平台不存在的开关。
	Hint string
}

// Value 返回可直接落库 / 生效的规范值（空串 = 关闭应用子域；`http://` 前缀 = 明文部署）。
func (v AppBaseDomainVerdict) Value() string {
	if v.Host == "" {
		return ""
	}
	if v.Insecure {
		return "http://" + v.Host
	}
	return v.Host
}

// rejectBaseDomain 构造一个拒绝判定。
func rejectBaseDomain(reason, message, hint string) AppBaseDomainVerdict {
	return AppBaseDomainVerdict{Reason: reason, Message: message, Hint: hint}
}

// InspectAppBaseDomain 归一化 + 校验一个应用基域配置值（**唯一真源**）。
//
// 接受：`example.com`、`apps.example.com`、`https://apps.example.com`、`http://…`
// （显式 http 表示明文部署）、大小写、**单个**结尾点（FQDN 根点，`apps.example.com.`）、
// 以及带端口的写法（端口一律忽略 —— Cookie 的作用域本来就不含端口）。
// 空串 = 关闭应用子域（合法，不是拒绝）。
//
// 拒绝：**多个**结尾点、通配符、路径/查询、IP、单标签、公网后缀、localhost/.local、
// 空标签/超长标签/非法字符（含下划线）、总长 > 253。
//
// # 结尾点规则（有意为之，非"碰巧如此"；2026-09-19 第三轮对抗审计 A-1 后经主控裁定）
//
//   - **一个**结尾点是 DNS 的 FQDN 绝对标记，等价于没有它 ⇒ 归一化后**接受**
//     （`apps.example.com.` / `apps.example.com.:8443` → `apps.example.com`）。
//     判据：归一化后的 Cookie Domain 是规范形态，真 Chromium 实测 **STORED**、子域匹配正常
//     ⇒ 不存在静默死。拒绝它反而会把"防御"变成可用性事故：存量 `.env` 里写了单个结尾点
//     的部署会在升级后**起不来**（可用性优先）。
//   - **两个及以上**结尾点（`apps.example.com..`，含 `..:8443`）是写法错误 ⇒ **fail-loud**。
//     判据：这是歧义写法，没有"用户想表达什么"的第二种解释。
//     历史原因（本规则针对的正是这个缺陷）：旧实现 `normalizeHostOnly` 只剥**一个**尾点、
//     且**端口在剥点之后**才切，于是 `apps.example.com..:8443` 残留成 `apps.example.com.`；
//     而 go1.26 的 `net/http` 恰好放宽了 `isCookieDomainName`（去掉结尾 `partlen == 0` 判据）
//     ⇒ 服务端照写 `Domain=apps.example.com.` 并返回 200、零 ERROR、零审计，浏览器按
//     RFC 6265 §5.3 第 6 步**整条丢弃**该 Cookie ⇒ 兑换恒失败（"静默死"）。
//
// 单尾点/端口只归一化、不拒绝；真正被拒的是"归一化之后仍然不是合法 Cookie 域"的形态。
func InspectAppBaseDomain(raw string) AppBaseDomainVerdict {
	v := strings.TrimSpace(raw)
	if v == "" {
		return AppBaseDomainVerdict{} // 空 = 关闭应用子域
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
		return rejectBaseDomain(reasonBaseDomainWildcard, "不要填通配符形式",
			"填主域名本身即可（例如 example.com）：平台会用「应用名 + . + 该域名」拼出每个应用的地址；"+
				"通配符是证书与 DNS 侧的事（需要 *.example.com 的通配证书）")
	}
	if strings.ContainsAny(v, "/?#") {
		return rejectBaseDomain(reasonBaseDomainNotBareHost, "基域只能是域名本身",
			"不要带路径或查询串（只填域名；端口会被忽略，也可以保留 http:// 前缀表示明文部署）")
	}
	shape := canonicalHostOnly(v)
	host, dots, reason := shape.Host, shape.TrailingDots, shape.Reason
	switch reason {
	case reasonBaseDomainEmptyHost:
		return rejectBaseDomain(reasonBaseDomainEmptyHost, "基域格式不合法",
			"填主域名，例如 example.com 或 apps.example.com")
	case reasonBaseDomainNotBareHost:
		return rejectBaseDomain(reasonBaseDomainNotBareHost, "基域只能是域名本身",
			"不要用 IPv6 字面量（方括号写法）：Cookie 的 Domain 只接受域名，应用地址也拼不出 IP 子域")
	}
	if dots > 1 {
		return rejectBaseDomain(reasonBaseDomainMultipleDots, "基域结尾有多个点",
			"去掉多余的结尾点（`apps.example.com..` 这类写法会被浏览器整条丢弃；"+
				"正确写法是 `apps.example.com`，单个结尾点 `apps.example.com.` 也接受）")
	}
	if net.ParseIP(host) != nil {
		return rejectBaseDomain(reasonBaseDomainIP, "基域不能是 IP 地址",
			"应用地址是「应用名 + . + 基域」，IP 拼不出子域名；请填企业域名")
	}
	labels := strings.Split(host, ".")
	// 保留名先判：`localhost` 是单标签，但它更该被报成"保留名"（运维要能一眼看出
	// "换成企业真实域名"这条动作，而不是"至少要两级"）。
	if last := labels[len(labels)-1]; last == "localhost" || last == "local" {
		return rejectBaseDomain(reasonBaseDomainReservedHost, "基域不能是 localhost / .local 这类保留名",
			"浏览器不会把 Domain=localhost（或 .local）的 Cookie 交给子域；请填企业的真实 DNS 域名")
	}
	if len(labels) < 2 {
		return rejectBaseDomain(reasonBaseDomainSingleLabel, "基域至少要两级",
			"例如 example.com；单标签（如 intranet）无法承载 <应用名>. 前缀，"+
				"浏览器也不会把 Domain=intranet 的 Cookie 交给 my-app.intranet")
	}
	for _, label := range labels {
		if label == "" || len(label) > 63 {
			return rejectBaseDomain(reasonBaseDomainBadLabel, "基域里有空的或过长的标签",
				"每一级标签 1–63 个字符，且不能为空（例如 apps.example.com）")
		}
		if strings.HasPrefix(label, "-") || strings.HasSuffix(label, "-") {
			return rejectBaseDomain(reasonBaseDomainBadLabel, "域名标签不能以连字符开头或结尾",
				"例如 app-center.example.com 合法，-app.example.com 不合法")
		}
		for _, r := range label {
			if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' {
				return rejectBaseDomain(reasonBaseDomainBadLabel, "域名只能用小写字母、数字与连字符",
					"不要用下划线或其它符号（域名规则如此，不是平台的额外限制）")
			}
		}
	}
	if len(host) > 253 {
		return rejectBaseDomain(reasonBaseDomainTooLong, "基域过长",
			"整个域名不超过 253 个字符（每一级标签不超过 63 个字符）")
	}
	if suffix, _ := publicsuffix.PublicSuffix(host); suffix == host {
		return rejectBaseDomain(reasonBaseDomainPublicSuffix, "基域不能是公网后缀本身",
			"`com`、`co.uk`、`github.io` 这类公网后缀不能承载 Domain Cookie"+
				"（浏览器按 registry-controlled domain 判定，会整条丢弃）；请填你自己拥有的域名，例如 example.com")
	}
	return AppBaseDomainVerdict{Host: host, Insecure: insecure, HadPort: shape.HadPort}
}

// hostShape 是"主机名形状"的解析结果（canonicalHostOnly 的返回值）。
type hostShape struct {
	// Host 是归一化主机名（小写、无端口、无尾点）。可能为空。
	Host string
	// TrailingDots 是被剥掉的结尾点个数（1 = FQDN 根点；≥2 = 歧义写法，策略层拒绝）。
	TrailingDots int
	// HadPort 表示输入带了端口（端口一律忽略，但控制台的**拼写规则**据此要求规范写法）。
	HadPort bool
	// Reason 非空 = 形状层拒绝（空值 / IPv6 方括号写法）。
	Reason string
}

// canonicalHostOnly 把输入折成「主机名形状」——归一化与闸门**共用的唯一形状实现**。
//
// 规则（顺序有意义）：小写 → 去空白 → 拒 IPv6 方括号写法 → **先**在第一个冒号处切掉端口
// （端口不参与 Cookie 作用域）→ **循环**剥掉结尾点并**记下个数**（个数必须留下来交给策略层，
// 这是"单尾点接受 / 多尾点拒绝"这条规则的判定依据）。
//
// 结尾点语义（**有意为之**，2026-09-19 第三轮审计 A-1 后经主控裁定）：
//   - **1 个** = FQDN 绝对标记（`apps.example.com.` ≡ `apps.example.com`）⇒ 归一化后**接受**
//     （可用性优先：归一化结果写出的是规范 Domain，真 Chromium 实测 STORED；拒绝会让存量
//     部署升级后起不来）；
//   - **≥2 个** = 写法错误 ⇒ 策略层 **fail-loud**（歧义写法没有第二种解释）。
//
// ⚠️ 顺序是这条规则的**核心**：旧实现先剥一个尾点、**端口在剥点之后**才切，导致
// `apps.example.com..:8443` 残留 `apps.example.com.` ⇒ 服务端 200 写出 `Domain=…com.`、
// 浏览器整条丢弃 ⇒ 零 ERROR 零审计的"静默死"。本函数把"切端口"放在"剥尾点"之前，
// 且循环剥尽后**只看个数**决定策略，两条路径不可能再分叉。
func canonicalHostOnly(raw string) hostShape {
	host := strings.ToLower(strings.TrimSpace(raw))
	if host == "" {
		return hostShape{Reason: reasonBaseDomainEmptyHost}
	}
	if strings.HasPrefix(host, "[") { // IPv6 字面量：Domain Cookie 无意义
		return hostShape{Reason: reasonBaseDomainNotBareHost}
	}
	hadPort := false
	if i := strings.IndexByte(host, ':'); i >= 0 {
		host, hadPort = host[:i], true
	}
	dots := 0
	for strings.HasSuffix(host, ".") {
		host = strings.TrimSuffix(host, ".")
		dots++
	}
	if host == "" {
		return hostShape{TrailingDots: dots, HadPort: hadPort, Reason: reasonBaseDomainEmptyHost}
	}
	return hostShape{Host: host, TrailingDots: dots, HadPort: hadPort}
}

// normalizeHostOnly 把主机名归一成**比较与 Cookie Domain 共用的唯一形状**：
// 小写、去尾点（循环剥尽）、剥端口。空串 = 取不出主机名（空值 / IPv6 字面量）。
//
// 与 InspectAppBaseDomain 共用同一个形状实现（canonicalHostOnly）；区别只在**策略**：
// 本函数是宽松归一化（给"主站源"这类只做比较的输入用），策略判定（单标签/公网后缀/
// 多尾点/IP …）由 InspectAppBaseDomain 负责 —— 应用基域一律走策略判定，
// 绝不拿"归一化成功"当"能承载 Cookie"。
//
// 为什么需要它（R2-2，2026-09-19 第二轮审计 §1.2）：
//   - `PICOAI_APPS_BASE_DOMAIN=apps.example.com:8443` 与 `http://127.0.0.1:8080`
//     这两种写法都被 Options.BaseDomain 的注释明确支持，但端口不参与 Cookie 的作用域；
//   - 旧实现里 baseHost 只做 normalizeDomain（保留端口）而 mainHost 走 originHost
//     （剥端口）⇒ 基域与对外地址**写成同一个值**也被判成"不同域"（500 + 文案指错方向）；
//   - derive 出来的 `Domain=<host>:<port>` 会被 net/http 静默省略整个属性 ⇒ Cookie
//     退化成 host-only ⇒ 子域兑换恒失败，且零 ERROR 零审计（静默死）。
func normalizeHostOnly(raw string) string {
	return canonicalHostOnly(raw).Host
}

// cookieDomainWritable 报告 host 能否作为 Set-Cookie 的 Domain 属性真正下发。
//
// 判据 = **自己实现的合法 Cookie 域判据**（InspectAppBaseDomain：循环剥尾点、拒多尾点、
// 拒空标签/单标签/公网后缀/localhost、标签字符集、标签与总长上限）＋"必须是规范形态"
// （非规范写法由配置层归一化，判定层不猜）。
//
// 为什么不再把 net/http 的序列化判断当唯一判据（A-1 的根因）：那是"服务端写得出去"，
// 不等于"浏览器会存"。现在 net/http 只剩**最后一道保险**：万一它将来又收紧规则，
// 这条兜底仍然会拒绝（但"能不能写出去"不再由它定义策略）。
//
// IP 字面量同样拒：net/http 对裸 IPv4 会照写 `Domain=127.0.0.1`，而浏览器按
// RFC 6265 §5.3 只接受"与响应主机 domain-match 的域名"，IP 一律丢弃整条 Set-Cookie
// ⇒ 又是一种"服务端自认为发了、浏览器根本没存"的静默死。
func cookieDomainWritable(host string) bool {
	verdict := InspectAppBaseDomain(host)
	if verdict.Reason != "" || verdict.Host == "" || verdict.Host != host {
		return false
	}
	probe := http.Cookie{Name: TicketNonceCookieName, Value: "probe", Path: "/", Domain: verdict.Host}
	return strings.Contains(probe.String(), "Domain=")
}

// TicketNonceCapability 是"本部署能否下发换票 nonce Cookie"的**判定结果**（唯一真源）。
//
// 两个消费方共用它，因此不可能分叉：
//   - 运行期：`Manager.ticketNonceDecision`（签发侧 fail-closed 的依据）；
//   - 配置期：控制台保存路径的**第三条 fail-closed 自检**（Apply）—— 基域可承载 Cookie
//     **且**与对外地址同域，否则管理员能存下一个"登录可见应用必 500"的组合，
//     错误要等员工换票时才暴露（2026-09-19 第三轮审计 A-6）。
type TicketNonceCapability struct {
	// Usable 为真表示：基域可承载 Cookie Domain，且对外地址与该基域同域（或未配置 ⇒ 按基域推导）。
	Usable bool
	// CookieDomain 是 Usable 时 Cookie 的 Domain 属性（= 归一化后的基域主机名）。
	CookieDomain string
	// MainOrigin 是本次判定依据的主站源（配置值；Derived 时为按基域推导出的值）。
	MainOrigin string
	// Derived 表示 MainOrigin 是按应用基域推导的（对外地址未配置 / 取不出主机名）。
	Derived bool
	// Reason 是 Usable 为假时的原因（进日志与审计）。
	Reason string
	// Remedy 是 Usable 为假时给运维的**可执行动作**（唯一真源见 ticketNonceRemedy* 常量）。
	Remedy string
}

// CheckTicketNonceCapability 判定 (应用基域, 服务端对外地址) 这个组合能否承载换票 nonce Cookie。
//
// 规则（与 ticket.go 的 ticketNonceDecision 注释逐条对应）：
//  1. 基域未配置 ⇒ 不可用（调用方在此之前已 404，本分支只为完备）；
//     1b. 基域归一化后**写不出合法的 Cookie Domain**（单标签 / 公网后缀 / IP / 下划线 /
//     多尾点 / localhost …）⇒ 不可用。**不降级成 host-only**：那正是"票恒兑换不了却
//     零信号"的形态；
//  2. 对外地址未配置 / 取不出主机名 ⇒ 按**应用基域**推导主站源（配置事实）⇒ 可用；
//  3. 对外地址主机名 == 基域，或是基域的**子域** ⇒ 可用（Cookie Domain = 基域）；
//  4. 其余（不同域）⇒ 不可用。
//
// @param baseDomain - 应用基域配置值（可带 scheme / 端口 / 大小写）。
// @param mainOrigin - 服务端配置的对外地址（空 = 未配置 ⇒ 按基域推导）。
// @returns 判定结果（Usable / CookieDomain / MainOrigin / Derived / Reason / Remedy）。
func CheckTicketNonceCapability(baseDomain, mainOrigin string) TicketNonceCapability {
	verdict := InspectAppBaseDomain(baseDomain)
	if verdict.Reason != "" {
		// 形状归一化得到的 host 仍然进 reason：运维要能一眼看出"哪一个值被拒"。
		// 后缀带上稳定原因码（single_label / public_suffix / multiple_trailing_dots …）。
		shown := verdict.Host
		if shown == "" {
			shown = strings.TrimSpace(baseDomain)
		}
		remedy := ticketNonceRemedyBaseDomain
		if verdict.Reason == reasonBaseDomainMultipleDots {
			// 这一档是"写法错误"而不是"域名不能用"：给出正确写法（点名环境变量），
			// 而不是泛泛地让人"换一个基域"。
			remedy = ticketNonceRemedyTrailingDots
		}
		return TicketNonceCapability{
			Reason: "base_domain_not_cookie_writable:" + shown + "(" + verdict.Reason + ")",
			Remedy: remedy,
		}
	}
	baseHost := verdict.Host
	if baseHost == "" {
		return TicketNonceCapability{Reason: "base_domain_unset", Remedy: ticketNonceRemedyAlignOrigin}
	}
	if !cookieDomainWritable(baseHost) {
		return TicketNonceCapability{
			Reason: "base_domain_not_cookie_writable:" + baseHost,
			Remedy: ticketNonceRemedyBaseDomain,
		}
	}
	// 推导用的 origin 保留配置里写的**端口与原始主机名**（诊断如实反映部署；
	// Cookie Domain 只用主机名）—— 与旧实现逐字一致，避免"日志里的源和配置不一样"。
	scheme, rawHost := ParseBaseDomain(baseDomain)
	configured := strings.TrimSpace(mainOrigin)
	if configured != "" {
		// originHost（ticket.go）：从 `scheme://host[:port][/path]` 里取主机名 —— 与
		// checkMainOrigin 用的那套规范化同源，否则同一个值会被判成两个域（R2-2）。
		if mainHost := originHost(configured); mainHost != "" {
			if mainHost == baseHost || strings.HasSuffix(mainHost, "."+baseHost) {
				return TicketNonceCapability{Usable: true, CookieDomain: baseHost, MainOrigin: configured}
			}
			return TicketNonceCapability{
				Reason:     "main_origin_not_same_domain_as_base:" + mainHost,
				Remedy:     ticketNonceRemedyAlignOrigin,
				MainOrigin: configured,
			}
		}
		// 配置了但取不出可用主机名（IPv6 字面量等）：Domain Cookie 在 IP 上没有意义
		// ⇒ 与"未配置"同等处理（推导出的是配置里的基域，仍然只来自配置）。
	}
	return TicketNonceCapability{
		Usable:       true,
		CookieDomain: baseHost,
		MainOrigin:   scheme + "://" + rawHost,
		Derived:      true,
	}
}
