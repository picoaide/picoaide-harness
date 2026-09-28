// Package reports 月度用量报表:生成上月汇总(费用/请求/模型 TOP/用户 TOP/部门汇总),
// 按订阅推送到企业 webhook,并在每月(或停机补跑)自动触发。2026-09 P1。
package reports

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
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
//	④ **判定 / 生成 / 认领在同一临界区内**（R20A-S-04，审计 2026-09-25，**P1**）：
//	   ③ 的锁只罩住"投递那一瞬"是不够的 —— 判定用的是 `ListReportSubscriptions` 的
//	   **旧快照**、生成（秒级）插在判定与认领之间 ⇒ 两个实例只要 tick 相差 δ
//	   （多副本 / 滚动重叠发布 / 双活）就会各自拿"对方落账之前"的快照判定欠投、
//	   各自生成、各自认领（对方早已 release）⇒ **同一期被投两遍**。真双进程实测：
//	   同一期 `2026-08` 被投 101 次（A=41 + B=60），且认领**从未被拒**。
//
//	   修后每个候选订阅走**两阶段**，正确性来源 = **锁内新读 + 立刻重判**（锁只做互斥，
//	   不做正确性来源 —— 快照永远可能过期）：
//
//	    阶段一（持锁，只判定）：取该订阅的会话级 advisory lock → 在**同一条连接**上
//	      新读订阅行（GetReportSubscriptionOn）→ `SubscriptionDuePeriod` 重判；
//	      不欠投就立刻放锁走人。
//	    生成（**刻意不持锁**）：生成走 `*sql.DB`，而池上限可被配成 1 —— 持着认领连接
//	      再向池里要第二条连接就是 R14-K 的 hold-and-wait（池会自锁且不可恢复）。
//	      白生成一次报表的代价（秒级、纯读）换掉这一类死锁。
//	    阶段二（持锁，判定 + 投递 + 落账一体）：重新取锁 → 同一条连接上**再新读一次**
//	      → 仍然欠投、且期号与已生成的报表一致 → 才推 → 用认领连接落账
//	      （MarkReportAttemptOn，同一把锁内）→ 放锁。
//
//	   为什么两阶段仍然互斥：投递与落账都紧跟在"锁内新读 + 重判"之后，两个实例不可能
//	   同时通过阶段二的判定；阶段二读出来"不欠投"（对方已投成功 / 已进退避窗口）就跳过。
//	   期间期号若被别的实例改成另一期（对方补投成功并把游标推进到下一期），本轮放弃 ——
//	   下一 tick 会按新期号重来，不丢期也不会错投。
//
//	⑤ **单条订阅的失败不拖垮整批**（R22-V3-B1，复审 2026-09-26，**P2**）：修前"期号
//	   生成失败"是 `return ok, failed, err` —— **跳出整个候选循环**。一条被外部写坏的
//	   `pending_period`（`2026-99`）就是一次必然失败的生成，于是每一轮都停在这一条上，
//	   其余**健康订阅一期都投不出去**（真 PG 实测连续 5 轮 0 笔、健康订阅
//	   `fail_streak=0`、`last_error=''`：从未被尝试），且不修库就不自愈。
//	   修后生成失败降级为"**该订阅本轮**失败"：failed++ → `last_error` 留痕（锁内落账，
//	   带与投递失败同一套退避）→ `continue` 处理其余订阅。
//	   同一处还必须挡住"按不可信期号生成"本身：`SubscriptionDuePeriod` 的第三个返回值
//	   把不可信的 `pending_period` 上抛，本函数据此**不投那一条**并落 `last_error`。
//
//	   阶段二的两条判据**各自承重**（R21C-05，审计 2026-09-26，P3 的复核结论）：
//	   `!stillDue` 抓的是"对方已经投完最后一期"（游标清空 + last_run_at 落到本月 ⇒
//	   整条不再欠投），`freshPeriod != period` 抓的是"对方投完一期但**还欠下一期**"
//	   （游标从 2026-06 推进到 2026-07 ⇒ 仍然 due，但本轮生成的报表已经不是该投的那一期）。
//	   在 R21C-01 之前游标是单槽、成功即清空，"推进后仍 due"这一状态不可达 ⇒ 两条判据
//	   确实互相冗余（删任一条都不红）；游标改成逐期推进之后这个状态成为常态，
//	   删掉 `freshPeriod != period` 就会**多投一期**（把已经投出的那一期再投一遍）。
//	   判据：`report_multimonth_catchup_test.go` 的
//	   `TestPhaseTwoCriteriaAreNotRedundantUnderCursorSemantics`。
//
// 失败退避（S1-06 ①）由 `MarkReportAttempt` 落 `fail_streak`/`next_attempt_at` 承担：
// 永久坏的 webhook 不再每 tick 被重投。
func DispatchAll(ctx context.Context, db *sql.DB, month time.Time) (ok, failed int, err error) {
	list, err := serverstore.ListReportSubscriptions(db)
	if err != nil {
		return 0, 0, err
	}
	// 粗筛只用来"少抢锁"：判据用的是快照，过期只会让候选**偏多**（真正欠不欠投由
	// 下面两次锁内新读决定）。**异常候选也要进来**（`anomaly != ""`）：形态非法的
	// `pending_period` 会让 `due=false`，若在这里就被滤掉，锁内那次"记 last_error"
	// 永远不会发生 ⇒ 坏行既投不出去、也不留任何可诊断痕迹（R22-V3-B1）。
	candidates := make([]int64, 0, len(list))
	for _, sub := range list {
		if _, due, anomaly := SubscriptionDuePeriod(month, sub); due || anomaly != "" {
			candidates = append(candidates, sub.ID)
		}
	}
	if len(candidates) == 0 {
		return 0, 0, nil
	}
	bodies := map[string]*ReportBody{}
	for _, id := range candidates {
		// —— 阶段一：锁内新读 + 重判（只判定，不生成、不投递）——
		period, due, anomaly, derr := inspectDueUnderLock(ctx, db, id, month)
		if derr != nil {
			// 认领面/读面出不来 ⇒ 不投（fail-closed：宁可下一轮再投，也不要两个实例同时投）。
			log.Printf("reports: inspect subscription %d: %v", id, derr)
			failed++
			continue
		}
		if anomaly != "" {
			// `pending_period` 不可信（形态非法 / 未来期号）。**留痕**（last_error + fail_streak，
			// **不设退避**；同一条值只写一次）已经在锁内落盘，这里只补日志与计数 ——
			// 原因文案见 classifyPendingPeriod（含恢复路径）。
			log.Printf("reports: subscription %d: %s", id, anomaly)
			if !due {
				// 形态非法：这一条本轮不投（等人工修库），其余订阅照常投 —— 这正是本条的修复点。
				failed++
				continue
			}
			// 未来期号：period 已由正常路径算出（= 当前应投期）⇒ 继续往下投，
			// 欠投期不因外部写坏的那一格被丢下。那一格**不被静默改写**（落账只在
			// "投出的正是游标那一期"时动它）—— 时钟走到它时自然收口（判据③ 钉住收敛）。
		}
		if !due {
			continue // 已投递 / 退避窗口内 / 已禁用 ⇒ 这一轮没事做
		}
		body, cached := bodies[period]
		if !cached {
			genBody, gerr := GenerateMonthlyReportForPeriod(db, period)
			if gerr != nil {
				// 单条订阅的期号生成失败**不得**终止整批（R22-V3-B1）：修前这里是
				// `return ok, failed, err`，于是一条坏行（或一次库故障）让其余订阅这一轮
				// 全部不投，而下一轮又在同一条上再次失败 ⇒ 全量停投且不自愈。
				// 现在降级成"这一条本轮失败"：failed++ → last_error 留痕（锁内落账）→
				// continue 处理其余订阅。
				//
				// 留痕分两档（R23-V3-B1）：**期号不可用**类（解析失败 / `SQLSTATE 22xxx`
				// 的日期越界）与"不可信游标"同一处置 —— 不设退避、不钉游标，人工改回合法值
				// 后**下一轮**就恢复（否则 22008 会先设下 1 小时/24 小时的退避窗口，
				// 与形态非法档明确写下的"改好即自愈"承诺相反）。其余（库故障 / 网络）
				// 才是可恢复失败，照常退避。
				failed++
				log.Printf("reports: subscription %d: generate report for period %s: %v", id, period, gerr)
				if periodUnusableError(gerr) {
					recordReportFailure(ctx, db, id, "", month, gerr.Error(), false)
				} else {
					recordReportFailure(ctx, db, id, period, month, gerr.Error(), true)
				}
				continue
			}
			body, bodies[period] = genBody, genBody
		}
		// —— 阶段二：重新取锁 → 再新读 → 仍欠投才推 + 落账（同一把锁内）——
		conn, claimed, cerr := claimReportDelivery(ctx, db, id)
		if cerr != nil {
			log.Printf("reports: claim subscription %d: %v", id, cerr)
			failed++
			continue
		}
		if !claimed {
			// 另一个实例正在投这一条 —— 这一轮跳过，而且**不是失败**（对方会落账）。
			log.Printf("reports: subscription %d is being delivered by another instance; skipped this round", id)
			continue
		}
		sub, serr := serverstore.GetReportSubscriptionOn(ctx, conn, id)
		if serr != nil {
			log.Printf("reports: re-read subscription %d under lock: %v", id, serr)
			failed++
			releaseReportDelivery(ctx, conn, id)
			continue
		}
		freshPeriod, stillDue, _ := SubscriptionDuePeriod(month, sub)
		if !stillDue {
			// 对方（另一个实例）在我们生成这段时间里已经投成功 / 进了退避窗口。
			log.Printf("reports: subscription %d no longer due after acquiring the claim; skipped this round", id)
			releaseReportDelivery(ctx, conn, id)
			continue
		}
		if freshPeriod != period {
			// 期号在两次读之间变了（对方补投成功 + 跨月）⇒ 本轮不投这一期，下一轮按新期号走。
			log.Printf("reports: subscription %d period changed %s → %s; skipped this round",
				id, period, freshPeriod)
			releaseReportDelivery(ctx, conn, id)
			continue
		}
		// 落账走**认领那一条连接**（MarkReportAttemptOn）：认领连接在整个投递期间被持有，
		// 再回池里要第二条就是 hold-and-wait（R14-K：池上限 = 并发数时自锁且不可恢复）。
		// 投递用的 hook_url 取**锁内新读**的那一份（管理员刚改过地址也能立刻生效）。
		perr := PushWebhook(ctx, sub.HookURL, body)
		if perr != nil {
			failed++
			// 落账失败**必须留痕**：投递已经发出去了，而"这一期已投"没落库 ⇒ 下一轮会**再投一次**
			// （R20A-S-04 的另一条入口：去重靠的就是这次落账）。修前这里与成功分支一样是 `_ =`，
			// 唯一的迹象是接收方又收到一遍。
			if merr := serverstore.MarkReportAttemptOn(ctx, conn, id, period, false, perr.Error(),
				ptrTime(nextAttemptAfterFailure(month, sub.FailStreak+1))); merr != nil {
				log.Printf("reports: subscription %d: recording the failed attempt did not land (%v) — "+
					"the next round may deliver the same period again", id, merr)
			}
		} else {
			ok++
			// 成功落账走 **MarkReportDeliveredOn**（而不是 MarkReportAttemptOn）：
			// 投出的期号之后若还有已到期的期号，`pending_period` 游标必须**推进**
			// 而不是清空 —— 否则跨月失败期间到期的中间各期永久丢失且无恢复路径
			// （R21C-01，P1；完整机理见 nextPendingAfterDelivery 的注释）。
			if merr := serverstore.MarkReportDeliveredOn(ctx, conn, id, period,
				nextPendingAfterDelivery(month, period)); merr != nil {
				log.Printf("reports: subscription %d: the delivery succeeded but recording it did not land (%v) — "+
					"the next round may deliver the same period again", id, merr)
			}
		}
		releaseReportDelivery(ctx, conn, id)
	}
	return ok, failed, nil
}

// inspectDueUnderLock 在**该订阅的 advisory lock 内**新读订阅行并重判"是否欠投"。
//
// 读与判定都落在**认领那一条连接**上（GetReportSubscriptionOn(ctx, conn, …)）：
//   - 语义上：锁内新读才是"当前真实状态"，快照（ListReportSubscriptions）永远可能过期；
//   - 工程上：用 `*sql.DB` 读会向池里再要一条连接 —— 池上限 = 1 时持锁 + 要连接就是
//     R14-K 的 hold-and-wait（自锁且不可恢复）。
//
// 返回 (期号, 是否欠投, 不可信原因, 错误)；锁一定被释放（包括读失败的分支）。
//
// 第三个返回值非空 = `pending_period` 不可信（见 classifyPendingPeriod）。**判定与
// 记账在同一个临界区里做完**：持锁时把原因写进 `last_error`（`MarkReportAttemptOn`），
// 否则两个实例/两轮之间会互相覆盖（与投递落账同一纪律）。
// `nextAttemptAt` 传 nil ⇒ **不设退避**：这是可诊断的"外部写坏"状态，修好库值后
// **下一轮**就该恢复投递，不需要重启、也不该等一个退避窗口。
// `period` 传空 ⇒ `MarkReportAttemptOn` 的 CASE 谓词保证**不动** `pending_period`
// （不可信的值原样留着等人工修；未来期号那一格由随后的正常投递推进/清空）。
func inspectDueUnderLock(ctx context.Context, db *sql.DB, id int64, month time.Time) (string, bool, string, error) {
	conn, claimed, err := claimReportDelivery(ctx, db, id)
	if err != nil {
		return "", false, "", err
	}
	if !claimed {
		// 另一个实例正在处理这一条 —— 这是正常并发，不是错误（对方会给出结论）。
		log.Printf("reports: subscription %d is being inspected by another instance; skipped this round", id)
		return "", false, "", nil
	}
	defer releaseReportDelivery(ctx, conn, id)
	sub, rerr := serverstore.GetReportSubscriptionOn(ctx, conn, id)
	if rerr != nil {
		return "", false, "", rerr
	}
	period, due, anomaly := SubscriptionDuePeriod(month, sub)
	if anomaly != "" && sub.LastError != serverstore.SanitizeReportError(anomaly) {
		// 同一条不可信值已经留在 `last_error` 里 ⇒ **不重复写**：一个永久坏值否则会每 tick
		// 改写同一行并把 `fail_streak` 无限推高（`failed` 计数与日志仍然每轮都有，
		// 可观测性不受影响）。值被改成另一个坏值时文案不同 ⇒ 照常重新留痕。
		if merr := serverstore.MarkReportAttemptOn(ctx, conn, id, "", false, anomaly, nil); merr != nil {
			log.Printf("reports: subscription %d: recording the pending_period anomaly did not land (%v) — "+
				"the bad cursor stays undiagnosed in last_error", id, merr)
		}
	}
	return period, due, anomaly, nil
}

// errPeriodUnusable 标记"这一期号不可用"（形态非法 / 超出报表数据模型可表示的区间）——
// 与"库故障/网络"这类**可恢复**失败分开处置的依据（R23-V3-B1）。
var errPeriodUnusable = errors.New("报表期号不可用")

// periodUnusableError 报告"这一次生成失败"是否属于**期号不可用**类。
//
// 两来源：
//
//   - `GenerateMonthlyReportForPeriod` 的解析失败（`errPeriodUnusable` 包裹）；
//   - PostgreSQL 的日期越界族 —— 实测 `pending_period='0000-01'` 时聚合 SQL 报
//     `date/time field value out of range: "0000-01-01" (SQLSTATE 22008)`。
//     `22007`（invalid_datetime_format）/`22003`（numeric_value_out_of_range）同属
//     "喂进去的日期/数值本身越界"，一并按本档处理（口径 = **改库值即可恢复**）。
//
// 用 `errors.As` 取 `*pgconn.PgError` 判码，不做错误串匹配（错误串的形状由驱动决定，
// 且本仓已有"对错误串判 SQLSTATE"会静默永不命中的教训）。
func periodUnusableError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, errPeriodUnusable) {
		return true
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "22007", "22008", "22003":
			return true
		}
	}
	return false
}

// recordReportFailure 在**该订阅的锁内**记录"这一条本轮失败"（R22-V3-B1 的
// 另一半；R23-V3-B1 把"是否退避"变成显式参数）。
//
// 为什么必须持锁再写（而不是直接 `db.Exec`）：投递路径的记账纪律是"认领连接上落账"
// （R14-K hold-and-wait 守则），这里写的是**同一行**，必须与认领互斥，否则会与另一个
// 实例的成功落账互相覆盖。
//
// `period` 非空 ⇒ 若该订阅的 `pending_period` 还是空，这一期会被钉成欠投游标
// （`MarkReportAttemptOn` 的 CASE 谓词）⇒ 下一轮继续补投它，不丢期。
// **不可信期号档必须传空**：那一格本身不可信，拿它去钉游标等于把坏值洗成"待投期"。
//
// `retry` 决定要不要设退避窗口：
//
//	true —— 可恢复失败（库故障 / 网络 / webhook 类）：`fail_streak+1` 对应的
//	        `reportRetryDelay`（首次 1 小时、之后按天）；
//	false —— **期号不可用**档：`next_attempt_at` 置 NULL，人工把库值改回合法期号后
//	        下一轮就恢复（不需要重启、也不该等一个退避窗口）。它同时**清掉**此前
//	        可能已设下的退避 —— 恢复路径的承诺必须对"先失败过几次"同样成立。
//
// 落账失败只记日志：这是"失败之上的失败"，绝不能再把异常抛回调用方（那会把一条订阅的
// 问题重新升级成整轮中止 —— 正是本条要消除的形态）。
//
// `now` 用调用方传进来的**调度时钟**（与投递失败路径的 `nextAttemptAfterFailure(month, …)`
// 同一个基准），不在这里另取 `time.Now()`：判据用注入时钟推进月份，混用真实时钟会让
// 退避窗口与调度时钟错位。
func recordReportFailure(ctx context.Context, db *sql.DB, id int64, period string, now time.Time, reason string, retry bool) {
	conn, claimed, cerr := claimReportDelivery(ctx, db, id)
	if cerr != nil {
		log.Printf("reports: subscription %d: claim to record the failure: %v", id, cerr)
		return
	}
	if !claimed {
		return // 另一个实例正持有这一条：它会给出结论，本轮不重复记账
	}
	defer releaseReportDelivery(ctx, conn, id)
	sub, serr := serverstore.GetReportSubscriptionOn(ctx, conn, id)
	if serr != nil {
		log.Printf("reports: subscription %d: re-read to record the failure: %v", id, serr)
		return
	}
	var next *time.Time
	if retry {
		next = ptrTime(nextAttemptAfterFailure(now, sub.FailStreak+1))
	}
	if merr := serverstore.MarkReportAttemptOn(ctx, conn, id, period, false, reason, next); merr != nil {
		log.Printf("reports: subscription %d: recording the failure did not land (%v) — "+
			"the next round will try the same period again", id, merr)
	}
}

// ptrTime 取 time.Time 的地址（MarkReportAttempt 的"退避到何时"参数）。
func ptrTime(t time.Time) *time.Time { return &t }

// GenerateMonthlyReportForPeriod 生成**指定期号**（`YYYY-MM`，北京月）的月报。
//
// 期号是 `pending_period` 的存储形态，所以补投路径必须能按期号生成（R19A-S1-07）：
// 修前只能传"现在"，于是 `GenerateMonthlyReport` 永远取"当前月的上一月"，跨月的
// 那一期再也回不来。实现上一行不重复：期号 → 该期结束后的那个月 → 复用同一份生成器。
//
// 解析**绝不能经过 `time.Local`**（R21F-01，审计 2026-09-26，P2）：修前是
// `time.ParseInLocation("2006-01", period, time.Local)`，得到的是**本地**月首零点，
// 而 `GenerateMonthlyReport` 按**北京月**取上月。部署时区东于 UTC+8 时（`Asia/Tokyo`
// / `Australia/Sydney`），本地月首零点在北京还停在**上个月最后一天 23:00**
// ⇒ `BeijingMonth` 少算一个月，生成的期号比请求的期号再早一期（静默、无报错；
// 真库实测：请求 `2026-02` 生成 `Period=2026-01`，请求 `2026-01` 生成 `2025-12`）。
func GenerateMonthlyReportForPeriod(db *sql.DB, period string) (*ReportBody, error) {
	month, err := parseBeijingPeriod(period)
	if err != nil {
		return nil, fmt.Errorf("%w（want YYYY-MM）: %q", errPeriodUnusable, period)
	}
	// 期号 = month 所在北京月；把它当"下一月的 1 日"喂给 GenerateMonthlyReport，
	// 后者取 prev = month 所在月 ⇒ 期号与内容都对齐。月算术在**北京日期值**空间做
	// （Location=UTC 的 1 日：无 DST 缺口，且日=1 不会被 AddDate 归一化）。
	return GenerateMonthlyReport(db, serverstore.BeijingMonthInstant(month.AddDate(0, 1, 0)))
}

// parseBeijingPeriod 把期号 `YYYY-MM` 解析成该**北京月**的月首「北京日期值」
// （Location=UTC、年月日即北京日历月的 1 日 —— 与 `serverstore.BeijingMonth`
// 的产物同一表示；表示约定见 serverstore/beijing.go 文件头的「两种时间表示」）。
//
// 期号是**标签**而不是时刻（它由 `delivery_policy.CurrentPeriod` 以
// `BeijingMonth(now).AddDate(0,-1,0).Format("2006-01")` 生成），所以只能取字面年月：
// `time.Parse` 的 UTC 结果与进程 TZ 无关，把它的 y/m 分量**重新锚**成北京月首即可
// （与 `serverstore.ParseLocalDay` 的「字面日期 + 显式锚点」同范式，但锚点在北京月，
// 两者语义不可混用 —— 一个期号绝不是"本地某个月的 1 日零点"）。
//
// 校验的严格性与修前逐字一致：layout `2006-01` 要求定长零填充，且不接受多余字符
// （`2026-2` / `2026-13` / `2026-02-01` / `x` 全部报错）。
func parseBeijingPeriod(period string) (time.Time, error) {
	label, err := time.Parse("2006-01", period)
	if err != nil {
		return time.Time{}, err
	}
	return time.Date(label.Year(), label.Month(), 1, 0, 0, 0, 0, time.UTC), nil
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
// 原先记在这里的残留（"失败若持续跨过月界，下一轮生成的是最新一期，被跨过的那一期
// 不再补投，闭合需要加列"）已由 R21C-01 闭合：`pending_period` 是**最早未投递期号**
// 的游标，成功投出一期之后由 `nextPendingAfterDelivery` 推进到下一期，逐 tick 按序
// 补齐（不再有"被跨过的一期"）。本函数只回答"本北京月内是否已成功投过"。
func ShouldRunMonthly(now time.Time, lastRunAt *time.Time) bool {
	if lastRunAt == nil {
		return true
	}
	return serverstore.BeijingMonth(*lastRunAt).Before(serverstore.BeijingMonth(now))
}
