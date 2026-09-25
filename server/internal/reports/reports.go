// Package reports 月度用量报表:生成上月汇总(费用/请求/模型 TOP/用户 TOP/部门汇总),
// 按订阅推送到企业 webhook,并在每月(或停机补跑)自动触发。2026-09 P1。
package reports

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ReportBody 月度报表 JSON 结构(推送/测试共用)。
type ReportBody struct {
	Type        string                          `json:"type"` // monthly_usage_report
	Period      string                          `json:"period"`
	GeneratedAt string                          `json:"generated_at"`
	Total       ReportTotal                     `json:"total"`
	TopModels   []serverstore.UsageAggregateRow `json:"top_models"`
	TopUsers    []serverstore.UsageAggregateRow `json:"top_users"`
	Departments []serverstore.UsageAggregateRow `json:"departments"`
}

// ReportTotal 总计口径(tokens 为 chat 输入+输出,不含 embedding)。
type ReportTotal struct {
	Cost     float64 `json:"cost"`
	Requests int64   `json:"requests"`
	Tokens   int64   `json:"tokens"`
}

const (
	// TypeMonthly 报表类型标识。
	TypeMonthly = "monthly_usage_report"
	// PushTimeout 推送超时。
	PushTimeout = 10 * time.Second
)

// pushClient 推送 HTTP 客户端(测试可替换)。P2-19:
//   - 禁止跟随重定向(302/303 可把请求引向内网目标,绕过建单时的校验);
//   - 连接阶段按解析出的 IP 复检(防 DNS rebinding:建单时公网、发送时内网)。
var pushClient = &http.Client{
	Timeout:       PushTimeout,
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	Transport:     newPushTransport(),
}

// allowPrivateHookHosts 允许 webhook 指向回环/私网地址(仅测试注入;生产恒 false)。
var allowPrivateHookHosts = false

// blockedHookCIDRs 不得作为 webhook 目标的内网/保留网段(SSRF 防护)。
// 覆盖:未指定/回环/私网/链路本地/CGNAT/文档与基准测试网段/组播/保留。
var blockedHookCIDRs = func() []*net.IPNet {
	var out []*net.IPNet
	for _, c := range []string{
		"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
		"172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16",
		"198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
		"::/128", "::1/128", "fc00::/7", "fe80::/10", "ff00::/8",
	} {
		if _, n, err := net.ParseCIDR(c); err == nil {
			out = append(out, n)
		}
	}
	return out
}()

// hookHostAllowed 判定一个 IP 是否可作为 webhook 目标(仅公网地址)。
func hookHostAllowed(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() {
		return false
	}
	for _, n := range blockedHookCIDRs {
		if n.Contains(ip) {
			return false
		}
	}
	return true
}

// newPushTransport 构造带 SSRF 复检的推送传输层。
//
// FIX-09(审计 2026-09-12,P1):与 util.SafeOutboundTransport 同源 —— 只设
// DialContext 的护栏在配了 HTTP(S)_PROXY 的部署里完全空转:走代理时
// DialContext 连的是**代理**,目标只出现在请求行 / CONNECT 里,于是
// `http://169.254.169.254/...` 这类 webhook 会被代理照常取回。
// 修法:t.Proxy 换成代理感知包装,在选定代理**之前**复检真正的目标。
func newPushTransport() *http.Transport {
	base, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		base = &http.Transport{}
	}
	t := base.Clone()
	t.DialContext = safeHookDialContext
	t.Proxy = safeHookProxyFromEnvironment
	return t
}

// safeHookProxyFromEnvironment 是 webhook 推送侧的代理感知包装。
//
// 这里额外解决一个**代理部署下合法 webhook 被整体打死**的问题:
// hookHostAllowed 只放行公网地址,而 DialContext 复检的是代理的地址 ——
// 企业内网代理(10.x/172.16.x)会被判为"不可访问",所有 webhook 永久失败。
// 因此:
//   - 目标复检挪到本函数(req.URL 才是真正的目标);
//   - 代理自身地址由 safeHookDialContext 放行(见 hookIsEnvProxyAddr),
//     代理是运维配置的部署事实,不是攻击者可控的目标;
//   - 于是"私网目标 + 公网代理"仍然被拦,"公网目标 + 私网代理"恢复正常。
func safeHookProxyFromEnvironment(req *http.Request) (*url.URL, error) {
	proxyURL, err := http.ProxyFromEnvironment(req)
	if err != nil || proxyURL == nil {
		return proxyURL, err
	}
	if terr := checkHookTargetAllowed(req.Context(), req.URL.Hostname()); terr != nil {
		return nil, terr
	}
	return proxyURL, nil
}

// checkHookTargetAllowed 复检一个 webhook 目标主机(与 safeHookDialContext
// 同一套判定,但取"任一候选被拒即拒"的 fail-closed 口径:代理路径无法逐 IP
// 重试)。
func checkHookTargetAllowed(ctx context.Context, host string) error {
	if allowPrivateHookHosts {
		return nil
	}
	host = strings.TrimSpace(host)
	if host == "" {
		return fmt.Errorf("webhook 目标地址不可访问")
	}
	if ip := net.ParseIP(host); ip != nil {
		if !hookHostAllowed(ip) {
			return fmt.Errorf("webhook 目标地址不可访问")
		}
		return nil
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return err
	}
	for _, ipa := range ips {
		if !hookHostAllowed(ipa.IP) {
			return fmt.Errorf("webhook 目标地址不可访问")
		}
	}
	return nil
}

// hookIsEnvProxyAddr 报告 addr(host:port)是否是当前环境变量配置的代理之一。
//
// 用途:走代理时 DialContext 拿到的地址是**代理**的地址,对它套用
// hookHostAllowed(仅公网)会把企业内网代理整个打死。代理地址来自部署方的
// HTTP(S)_PROXY,不是攻击者可控输入,因此这里放行直连。
func hookIsEnvProxyAddr(addr string) bool {
	addr = strings.ToLower(strings.TrimSpace(addr))
	if addr == "" {
		return false
	}
	for _, k := range []string{
		"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy",
	} {
		raw := strings.TrimSpace(os.Getenv(k))
		if raw == "" {
			continue
		}
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" {
			continue
		}
		if strings.ToLower(u.Host) == addr {
			return true
		}
	}
	return false
}

// safeHookDialContext 在建立连接时复检目标 IP(防 DNS rebinding)。
func safeHookDialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	// 走代理时这个 addr 是**代理**的地址(真正的 webhook 目标已在
	// safeHookProxyFromEnvironment 里复检过)。代理由部署方通过
	// HTTP(S)_PROXY 配置,套用"仅公网"判定会让内网代理下的 webhook 全部
	// 失败,因此这里直接放行。
	if hookIsEnvProxyAddr(addr) {
		d := &net.Dialer{Timeout: PushTimeout}
		return d.DialContext(ctx, network, addr)
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	var lastErr error
	for _, ipa := range ips {
		if !allowPrivateHookHosts && !hookHostAllowed(ipa.IP) {
			lastErr = fmt.Errorf("webhook 目标地址不可访问")
			continue
		}
		d := &net.Dialer{Timeout: PushTimeout}
		conn, derr := d.DialContext(ctx, network, net.JoinHostPort(ipa.IP.String(), port))
		if derr == nil {
			return conn, nil
		}
		lastErr = derr
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("webhook 目标无法解析")
	}
	return nil, lastErr
}

// validateHookURL 校验 webhook 目标:http(s) + 主机可解析 + 每个解析结果都是
// 公网地址(拒绝回环/私网/链路本地,SSRF)。测试通过 allowPrivateHookHosts 放行。
func validateHookURL(raw string) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return fmt.Errorf("URL 解析失败")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("必须是 http(s) URL")
	}
	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("缺少主机名")
	}
	if allowPrivateHookHosts {
		return nil
	}
	ips, err := net.DefaultResolver.LookupIPAddr(context.Background(), host)
	if err != nil || len(ips) == 0 {
		return fmt.Errorf("主机名无法解析")
	}
	for _, ipa := range ips {
		if !hookHostAllowed(ipa.IP) {
			return fmt.Errorf("不允许指向内网/回环地址")
		}
	}
	return nil
}

// GenerateMonthlyReport 生成上一个月(month 为任意时刻,取其上月)的用量汇总。
// 口径与用量中心一致:费用=按模型定价折算(含 embedding),部门=当前归属树内合计。
// 月份按**北京月**取(serverstore.BeijingMonth):旧实现用 month.Location() 的
// 本机月界,UTC 容器在北京每月 1 日 00:00-08:00 会把报表算成上上个月。
func GenerateMonthlyReport(db *sql.DB, month time.Time) (*ReportBody, error) {
	start := serverstore.BeijingMonth(month)
	prev := start.AddDate(0, -1, 0)
	from := prev
	// 聚合层 to 语义为"截止日含当天"(内部 +1 天);报表需要严格的上月闭区间:
	// to = 本月 1 日前一天。
	to := start.AddDate(0, 0, -1)

	trend, err := serverstore.UsageAggregateWithLedger(db, from, to, "day")
	if err != nil {
		return nil, fmt.Errorf("aggregate trend: %w", err)
	}
	models, err := serverstore.UsageAggregateWithLedger(db, from, to, "model")
	if err != nil {
		return nil, fmt.Errorf("aggregate models: %w", err)
	}
	users, err := serverstore.UsageAggregateWithLedger(db, from, to, "user")
	if err != nil {
		return nil, fmt.Errorf("aggregate users: %w", err)
	}
	depts, err := serverstore.UsageAggregateWithLedger(db, from, to, "dept")
	if err != nil {
		return nil, fmt.Errorf("aggregate depts: %w", err)
	}

	body := &ReportBody{
		Type:        TypeMonthly,
		Period:      prev.Format("2006-01"),
		GeneratedAt: time.Now().Format(time.RFC3339),
		TopModels:   topByCost(models, 10),
		TopUsers:    topByCost(users, 10),
		Departments: topByCost(depts, 20),
	}
	for _, r := range trend {
		body.Total.Cost += r.Cost
		body.Total.Requests += r.Requests
		body.Total.Tokens += r.PromptTokens + r.CompletionTokens - r.EmbedTokens
	}
	return body, nil
}

// topByCost 费用降序取前 n。
//
// 2026-09-19(审计):旧实现只有 `Cost > Cost` 一个判据 —— 等值行(未定价模型
// cost 恒 0 最常见,用户/部门成本相同同理)之间**没有任何判据**,比较器因此
// 不是全序:等值组的先后只由"输入顺序 + sort 内部的比较/交换次序"决定,不是
// 数据的性质。实测(base 实现)对同一组行的输入做置换:**5 行**夹具(3 行同价
// 0 成本)的全部 120 个置换得到 12 种不同输出(A:5,B:0,C:0 / A:5,B:0,D:0 /
// A:5,B:0,E:0 / A:5,C:0,B:0 …),18 行与 25 行夹具各 200 个置换分别得到
// 78 与 200 种输出。这与"sort 用哪种算法"无关:len≤12 时标准库走插入排序,
// 插入排序同样逐次比较,非全序比较器下输出同样随输入顺序变化(旧注释把因果
// 挂在 pdqsort 的 len>12 分区阈值上,已实测证伪 —— 5 行夹具就在插入排序路径上)。
// 输入顺序从哪来:model/user 维度由聚合 SQL 的 `ORDER BY label` 固定(见
// UsageAggregateWithLedger),部门维度还会变(RegroupByDept 由 map 遍历构造)——
// 但无论输入是否固定,**等值边界上"取前 n"选谁都不是判据决定的**:第 n/n+1 名
// 等值时多一个零成本模型/部门就可能把本该入选的行挤出榜单。
// 口径与 internal/serverauth/usage_admin.go 的 usageOverview.top_models 一致:
// Cost 仍是唯一主判据、仍取前 n,等值时按 Label 升序(⇒ 比较器满足严格弱序,
// 输出由行集合唯一决定)。
func topByCost(rows []serverstore.UsageAggregateRow, n int) []serverstore.UsageAggregateRow {
	sorted := append([]serverstore.UsageAggregateRow{}, rows...)
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i].Cost != sorted[j].Cost {
			return sorted[i].Cost > sorted[j].Cost
		}
		return sorted[i].Label < sorted[j].Label
	})
	if len(sorted) > n {
		sorted = sorted[:n]
	}
	return sorted
}

// PushWebhook 推送报表到订阅地址(非 2xx = 错误)。
// P2-19:发送前再次校验目标(拒绝内网/回环),且不跟随重定向。
func PushWebhook(ctx context.Context, hookURL string, body *ReportBody) error {
	if err := validateHookURL(hookURL); err != nil {
		return fmt.Errorf("hook_url 不合法: %w", err)
	}
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, hookURL, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := pushClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("webhook status %d", resp.StatusCode)
	}
	return nil
}

// DispatchAll 生成报表并推送给**待补跑**的启用订阅;返回 成功/失败 计数。
//
// 三件事在这里一次做完（R19B-02 + R19A-S1-06/S1-07，审计 2026-09-25；判据面在
// delivery_policy.go，这里只做编排）：
//
//	① **订阅粒度过滤**（R19B-02，P1；第十八轮 R18C-03 修复引入的回归）：修前这里对
//	   **全部** enabled 订阅无条件重推，而唯一调用方 tryRun 的 should 判据是
//	   per-subscription 的（"任一订阅待补跑"就开跑）⇒ 只要有一个订阅持续失败，**健康**
//	   订阅每小时都会重收同一期月报（真实部署里每小时一轮、直到本北京月底，最坏约 700
//	   次真实出站 webhook）。过滤必须落在订阅粒度：只有 `SubscriptionDuePeriod` 说
//	   "欠投"的才推。
//	② **期号由策略给出**（R19A-S1-07）：每家的期号可能不同（有待补期号的补那一期），
//	   所以按**期号**生成报表（同一期只生成一次）。生成发生在"确实有欠投订阅"之后 ——
//	   修前先 `GenerateMonthlyReport` 一次全量聚合、再无条件推（稳态下每小时白跑）。
//	③ **投递认领**（R19A-S1-06 ②）：每个订阅推之前先取 PG advisory lock（按订阅 id），
//	   取不到 = 另一个实例正在投它 ⇒ 跳过（不计数、记一行日志）。修前两个实例同时 tick
//	   会把同一期投两遍。
//
// 失败退避（S1-06 ①）由 `MarkReportAttempt` 落 `fail_streak`/`next_attempt_at` 承担：
// 永久坏的 webhook 不再每 tick 被重投。
func DispatchAll(ctx context.Context, db *sql.DB, month time.Time) (ok, failed int, err error) {
	list, err := serverstore.ListReportSubscriptions(db)
	if err != nil {
		return 0, 0, err
	}
	type job struct {
		sub    serverstore.ReportSubscription
		period string
	}
	pending := make([]job, 0, len(list))
	for _, sub := range list {
		period, due := SubscriptionDuePeriod(month, sub)
		if !due {
			continue // 已投递 / 退避窗口内 / 已禁用 ⇒ 不欠投，绝不重推
		}
		pending = append(pending, job{sub: sub, period: period})
	}
	if len(pending) == 0 {
		return 0, 0, nil
	}
	bodies := map[string]*ReportBody{}
	for _, j := range pending {
		body, cached := bodies[j.period]
		if !cached {
			body, err = GenerateMonthlyReportForPeriod(db, j.period)
			if err != nil {
				return ok, failed, err
			}
			bodies[j.period] = body
		}
		conn, claimed, cerr := claimReportDelivery(ctx, db, j.sub.ID)
		if cerr != nil {
			// 认领面读不出来 ⇒ 不投（fail-closed：宁可下一轮再投，也不要两个实例同时投）。
			log.Printf("reports: claim subscription %d: %v", j.sub.ID, cerr)
			failed++
			continue
		}
		if !claimed {
			// 另一个实例正在投这一条 —— 这一轮跳过，而且**不是失败**（对方会落账）。
			log.Printf("reports: subscription %d is being delivered by another instance; skipped this round", j.sub.ID)
			continue
		}
		// 落账走**认领那一条连接**（MarkReportAttemptOn）：认领连接在整个投递期间被持有，
		// 再回池里要第二条就是 hold-and-wait（R14-K：池上限 = 并发数时自锁且不可恢复）。
		perr := PushWebhook(ctx, j.sub.HookURL, body)
		if perr != nil {
			failed++
			_ = serverstore.MarkReportAttemptOn(ctx, conn, j.sub.ID, j.period, false, perr.Error(),
				ptrTime(nextAttemptAfterFailure(month, j.sub.FailStreak+1)))
		} else {
			ok++
			_ = serverstore.MarkReportAttemptOn(ctx, conn, j.sub.ID, j.period, true, "", nil)
		}
		releaseReportDelivery(ctx, conn, j.sub.ID)
	}
	return ok, failed, nil
}

// ptrTime 取 time.Time 的地址（MarkReportAttempt 的"退避到何时"参数）。
func ptrTime(t time.Time) *time.Time { return &t }

// GenerateMonthlyReportForPeriod 生成**指定期号**（`YYYY-MM`，北京月）的月报。
//
// 期号是 `pending_period` 的存储形态，所以补投路径必须能按期号生成（R19A-S1-07）：
// 修前只能传"现在"，于是 `GenerateMonthlyReport` 永远取"当前月的上一月"，跨月的
// 那一期再也回不来。实现上一行不重复：期号 → 该期结束后的那个月 → 复用同一份生成器。
func GenerateMonthlyReportForPeriod(db *sql.DB, period string) (*ReportBody, error) {
	start, err := time.ParseInLocation("2006-01", period, time.Local)
	if err != nil {
		return nil, fmt.Errorf("报表期号不合法（want YYYY-MM）: %q", period)
	}
	// 期号 = start 所在月；把它当"下一月的 1 日"喂给 GenerateMonthlyReport，
	// 后者取 prev = start 所在月 ⇒ 期号与内容都对齐。
	return GenerateMonthlyReport(db, start.AddDate(0, 1, 0))
}

// ShouldRunMonthly 判断该订阅这一轮要不要投递月报：
// lastRunAt 为空（从未成功投递），或 lastRunAt 所在**北京月**早于 now 所在北京月
// （停机跨月 / 新部署补跑）。与 GenerateMonthlyReport 同一套月口径（见
// serverstore.BeijingMonth）；旧实现比较两个 time.Time 的 Year()/Month() 分量 ——
// 那是**各自 Location 的**本地月，UTC 容器在北京每月 1 日 00:00-08:00 会把两个月
// 算成同一个月 → 漏跑。
//
// 语义（R18C-03，审计 2026-09-25，P2 修正后）：`lastRunAt` 是**最近一次成功**投递的
// 时刻（失败只写 last_error，见 serverstore.MarkReportRun）。因此：
//   - 投递成功一次 ⇒ 本月内不再重复投（幂等锚）；
//   - 投递失败 ⇒ 该订阅本月内**仍然待补跑**，调度器每小时那一轮会重新生成**同一期**
//     （GenerateMonthlyReport 取的是"上月"，在本月内不变）并重投 —— 这正是 webadmin
//     对管理员的承诺"失败会自动重试"。
//
// 残留：失败若持续跨过月界，下一轮生成的是最新一期，被跨过的那一期不再补投
// （单靠一个时间戳表达不了"待补期号"，闭合需要加列，本轮不引入迁移）。
func ShouldRunMonthly(now time.Time, lastRunAt *time.Time) bool {
	if lastRunAt == nil {
		return true
	}
	return serverstore.BeijingMonth(*lastRunAt).Before(serverstore.BeijingMonth(now))
}
