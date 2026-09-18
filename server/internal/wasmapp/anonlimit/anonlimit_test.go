package anonlimit

import (
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 变异验证：
//   - 去掉每 IP 桶（只留全局）⇒ TestPerIPBucketIndependent 必红；
//   - 去掉全局桶 ⇒ TestGlobalBucketExhausts 必红；
//   - 自检里去掉 EXPLICIT 判断 ⇒ TestCheckTrustedProxiesRejectsComposeDefault 必红；
//   - MaxIPBuckets 淘汰逻辑改为不淘汰 ⇒ TestIPBucketsBounded 必红；
//   - 淘汰改回"每个新 IP 两次全表扫描" ⇒ TestEvictionCostIsAmortized 必红；
//   - 淘汰不再走 LRU（随便删）⇒ TestEvictionIsLRU 必红；
//   - 淘汰后放宽全局桶 ⇒ TestEvictionKeepsGlobalHardCap 必红。

type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time      { return c.t }
func (c *fakeClock) add(d time.Duration) { c.t = c.t.Add(d) }

func TestDefaultsComeFromLimits(t *testing.T) {
	o := DefaultOptions()
	eq(t, "GlobalRatePerMin", o.GlobalRatePerMin, limits.AnonGlobalRatePerMin)
	eq(t, "GlobalRatePerMin(doc)", o.GlobalRatePerMin, 3000)
	eq(t, "PerIPRatePerMin", o.PerIPRatePerMin, limits.AnonPerIPRatePerMin)
	eq(t, "PerIPRatePerMin(doc)", o.PerIPRatePerMin, 60)
}

func eq(t *testing.T, name string, got, want int) {
	t.Helper()
	if got != want {
		t.Fatalf("%s=%d want %d（§4.6）", name, got, want)
	}
}

// TestGlobalBucketExhausts：§10.3 第 48 项的一半 —— 全局桶打满即 429。
func TestGlobalBucketExhausts(t *testing.T) {
	clk := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	l := New(Options{
		GlobalRatePerMin: 60, GlobalBurst: 5,
		PerIPRatePerMin: 6000, PerIPBurst: 100000, // 每 IP 桶故意放宽，隔离出全局桶
		MaxIPBuckets: 16, Now: clk.now,
	})
	for i := 0; i < 5; i++ {
		if ok, _ := l.Allow("10.0.0." + itoa(i)); !ok {
			t.Fatalf("第 %d 次应放行（全局桶容量 5）", i+1)
		}
	}
	ok, wait := l.Allow("10.0.0.99")
	if ok {
		t.Fatal("全局桶打满后必须拒绝（§4.6 全局匿名令牌桶）")
	}
	if wait <= 0 {
		t.Fatalf("拒绝时必须给出正等待时长，got %v", wait)
	}
	// 过 1 秒（60 次/分 ⇒ 1 个令牌）后应恢复。
	clk.add(time.Second)
	if ok, _ := l.Allow("10.0.0.99"); !ok {
		t.Fatal("令牌桶应按速率恢复")
	}
}

// TestPerIPBucketIndependent：每 IP 桶互相独立（§4.6「每 IP 60 次/分」）。
func TestPerIPBucketIndependent(t *testing.T) {
	clk := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	l := New(Options{
		GlobalRatePerMin: 100000, GlobalBurst: 100000,
		PerIPRatePerMin: 60, PerIPBurst: 3,
		MaxIPBuckets: 64, Now: clk.now,
	})
	for i := 0; i < 3; i++ {
		if ok, _ := l.Allow("192.0.2.7"); !ok {
			t.Fatalf("同一 IP 第 %d 次应放行", i+1)
		}
	}
	if ok, _ := l.Allow("192.0.2.7"); ok {
		t.Fatal("同一 IP 超过每 IP 桶容量必须拒绝")
	}
	// 另一个 IP 不受影响（这正是"反代错配会让全组织共用一个桶"的判据）。
	if ok, _ := l.Allow("192.0.2.8"); !ok {
		t.Fatal("不同 IP 必须各自计数 —— 否则就是本仓已发生过的同族事故")
	}
}

// TestIPBucketsBounded：海量源 IP 不会让内存无界增长。
func TestIPBucketsBounded(t *testing.T) {
	clk := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	l := New(Options{
		GlobalRatePerMin: 1000000, GlobalBurst: 1000000,
		PerIPRatePerMin: 60, PerIPBurst: 5,
		MaxIPBuckets: 32, Now: clk.now,
	})
	for i := 0; i < 500; i++ {
		l.Allow("198.51.100." + itoa(i%256) + "-" + itoa(i))
	}
	if got := l.Stats().IPBuckets; got > 32 {
		t.Fatalf("每 IP 桶数=%d，必须被 MaxIPBuckets=32 限制", got)
	}
}

// TestRejectedCounter：拒绝计数可观测（§4.9）。
func TestRejectedCounter(t *testing.T) {
	clk := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	l := New(Options{GlobalRatePerMin: 1, GlobalBurst: 1, PerIPRatePerMin: 1, PerIPBurst: 1, Now: clk.now})
	l.Allow("203.0.113.1")
	l.Allow("203.0.113.1") // 必然被拒
	if l.Stats().Rejected == 0 {
		t.Fatal("拒绝数必须被计数")
	}
}

// ===== 启动自检（R35 / §4.6）=====

func TestCheckTrustedProxiesDisabledIsNoop(t *testing.T) {
	env := map[string]string{}
	if err := CheckTrustedProxies(func(k string) string { return env[k] }, false); err != nil {
		t.Fatalf("未启用子域时不应校验：%v", err)
	}
}

func TestCheckTrustedProxiesRejectsEmpty(t *testing.T) {
	env := map[string]string{}
	err := CheckTrustedProxies(func(k string) string { return env[k] }, true)
	if err == nil {
		t.Fatal("启用子域却未配置可信代理 ⇒ 必须拒绝启动（R35）")
	}
}

// TestCheckTrustedProxiesRejectsComposeDefault 是这条自检的**核心判据**：
// compose 兜底注入的 172.28.0.2 与管理员显式配置必须被区分开（§4.6 警告）。
func TestCheckTrustedProxiesRejectsComposeDefault(t *testing.T) {
	env := map[string]string{
		EnvTrustedProxies: "172.28.0.2",
		// 模拟 compose：${PICOAI_TRUSTED_PROXIES:-172.28.0.2} + ${PICOAI_TRUSTED_PROXIES:+1}
		// 管理员没在 .env 写 ⇒ EXPLICIT 为空。
		EnvTrustedProxiesExplicit: "",
	}
	err := CheckTrustedProxies(func(k string) string { return env[k] }, true)
	if err == nil {
		t.Fatal("compose 默认值不得当作显式配置（R35 明确要求可区分）")
	}
	if err.Details["value"] != "172.28.0.2" {
		t.Fatalf("错误应回显被拒的值，got %v", err.Details)
	}
}

func TestCheckTrustedProxiesAcceptsExplicit(t *testing.T) {
	env := map[string]string{
		EnvTrustedProxies:         "172.28.0.2, 10.1.0.0/16",
		EnvTrustedProxiesExplicit: "1",
	}
	if err := CheckTrustedProxies(func(k string) string { return env[k] }, true); err != nil {
		t.Fatalf("显式配置的 IP/CIDR 列表应通过：%v", err)
	}
}

func TestCheckTrustedProxiesRejectsGarbage(t *testing.T) {
	env := map[string]string{
		EnvTrustedProxies:         "not-an-ip",
		EnvTrustedProxiesExplicit: "1",
	}
	err := CheckTrustedProxies(func(k string) string { return env[k] }, true)
	if err == nil {
		t.Fatal("无法解析的项必须拒绝启动（错配会让 ClientIP 静默回落 RemoteAddr）")
	}
}

func TestSubdomainsEnabled(t *testing.T) {
	if SubdomainsEnabled("") || SubdomainsEnabled("   ") {
		t.Fatal("空基域 = 未启用应用子域")
	}
	if !SubdomainsEnabled("apps.example.com") {
		t.Fatal("配置了基域 = 启用应用子域")
	}
}

// ===== 审计修复回归（P2-4：桶满后每个新 IP 两次 O(8192) 全表扫描）=====

// TestEvictionCostIsAmortized 是 P2-4 的**性能回归**。
//
// 判据用"淘汰路径触碰的桶数"（操作计数）而不是绝对耗时 —— 机器差异会让
// 绝对毫秒阈值假红。桶满（生产值 8192）后 1000 个新 IP 的总操作数必须被**摊销**
// 到一个批次量级，而不是 1000 × O(8192)。
//
// 变异：把 evictLocked 改回"每次 Allow 都全表扫两遍" ⇒ 本用例立即变红
// （1000 个新 IP ≈ 16.4M 次触碰，上限是 ~2×1024）。
func TestEvictionCostIsAmortized(t *testing.T) {
	clk := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	const maxBuckets = 8192 // 生产值：DefaultOptions().MaxIPBuckets
	l := New(Options{
		GlobalRatePerMin: 100000000, GlobalBurst: 100000000, // 隔离出"淘汰成本"这一项
		PerIPRatePerMin: 60, PerIPBurst: 60,
		MaxIPBuckets: maxBuckets, Now: clk.now,
	})
	ipOf := func(i int) string { return "198.51." + itoa(i/256%256) + "." + itoa(i%256) + "#" + itoa(i) }

	// 先把桶表填到硬顶（每个 IP 一次请求；此时还不该触发淘汰）。
	for i := 0; i < maxBuckets; i++ {
		l.Allow(ipOf(i))
	}
	if got := l.Stats().IPBuckets; got != maxBuckets {
		t.Fatalf("填满后桶数=%d want %d", got, maxBuckets)
	}
	if got := l.EvictSteps(); got != 0 {
		t.Fatalf("未超上限时不该淘汰：steps=%d", got)
	}

	// 桶满状态下再打 1000 个**新** IP（就是审计的攻击形态）。
	before := l.EvictSteps()
	const newIPs = 1000
	for i := maxBuckets; i < maxBuckets+newIPs; i++ {
		l.Allow(ipOf(i))
	}
	steps := l.EvictSteps() - before
	// 一批 = MaxIPBuckets/8 = 1024 次摘除；1000 个新 IP 最多触发两批。
	if limit := int64(2 * (maxBuckets / 8)); steps > limit {
		t.Fatalf("桶满后 %d 个新 IP 的淘汰操作数=%d，超过摊销上限 %d——"+
			"说明淘汰又退化成每个新 IP 全表扫描（P2-4）", newIPs, steps, limit)
	}
	st := l.Stats()
	if st.IPBuckets > maxBuckets {
		t.Fatalf("内存必须有界：桶数=%d > %d", st.IPBuckets, maxBuckets)
	}
	if st.Evicted == 0 {
		t.Fatal("桶满后应有淘汰（Evicted 是桶上限真的在起作用的证据）")
	}
}

// TestEvictionKeepsGlobalHardCap：淘汰后行为**不放松** —— 换 IP 洪水仍然过不了
// 全局令牌桶（§4.6：全局 3000 次/分是硬顶，每 IP 桶只是细粒度层）。
func TestEvictionKeepsGlobalHardCap(t *testing.T) {
	clk := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	l := New(Options{
		GlobalRatePerMin: 60, GlobalBurst: 10,
		PerIPRatePerMin: 6000, PerIPBurst: 1000, // 每 IP 层故意放宽 ⇒ 只剩全局桶在拦
		MaxIPBuckets: 64, Now: clk.now,
	})
	allowed := 0
	for i := 0; i < 5000; i++ { // 远超桶上限的 IP 洪水
		if ok, _ := l.Allow("203.0.113." + itoa(i)); ok {
			allowed++
		}
	}
	if allowed > 10 {
		t.Fatalf("全局桶是硬顶：容量 10，实际放行 %d", allowed)
	}
	if got := l.Stats().IPBuckets; got > 64 {
		t.Fatalf("内存必须有界：桶数=%d > 64", got)
	}
	// 洪水过后，一个全新 IP 也必须被全局桶拦住（淘汰不会给攻击者开新额度）。
	if ok, _ := l.Allow("192.0.2.250"); ok {
		t.Fatal("全局桶耗尽后，全新 IP 也必须被拒（淘汰不放松全局硬顶）")
	}
}

// TestEvictionIsLRU：淘汰的是**最久未使用**的桶（不是任意桶）。
func TestEvictionIsLRU(t *testing.T) {
	clk := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	const maxBuckets = 8
	l := New(Options{
		GlobalRatePerMin: 1000000, GlobalBurst: 1000000,
		PerIPRatePerMin: 60, PerIPBurst: 3,
		MaxIPBuckets: maxBuckets, Now: clk.now,
	})
	// 8 个 IP：hot 最后一次被访问，cold 最早。
	for i := 0; i < maxBuckets; i++ {
		l.Allow("10.0.0." + itoa(i))
	}
	l.Allow("10.0.0.0") // hot 重新变成"最近使用"
	// 触发一批淘汰（MaxIPBuckets=8 ⇒ 批次 =1：挤掉最久未用的那个）。
	l.Allow("10.9.9.9")
	if _, ok := l.ips["10.0.0.1"]; ok {
		t.Fatal("应淘汰最久未使用的 10.0.0.1")
	}
	if _, ok := l.ips["10.0.0.0"]; !ok {
		t.Fatal("最近用过的桶不该被淘汰")
	}
	if _, ok := l.ips["10.9.9.9"]; !ok {
		t.Fatal("新 IP 必须被插入")
	}
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	if neg {
		return "-" + string(b)
	}
	return string(b)
}
