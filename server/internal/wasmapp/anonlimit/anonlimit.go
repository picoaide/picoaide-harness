// Package anonlimit 实现**匿名访问限流**与**可信代理启动自检**
// （设计基线 §4.6「匿名限流」行 + R35）。
//
// 为什么单独一个包：匿名应用（`access=public`）没有身份，唯一的滥用边界
// 就是"全局匿名桶 + 每 IP 桶"；而这两个桶的**分母**（客户端真实 IP）取决于
// 反向代理是否被信任。本仓已有同族事故：反代下 `RemoteAddr` 让全组织坍缩进同一个
// 限流桶，一次误配 = 全员 429。所以：
//
//  1. 运行时桶：全局 + 每 IP，两者都过才放行（§4.6：默认 3000 次/分 + 60 次/分）；
//  2. 启动自检（R35）：**启用应用子域却未显式配置 `PICOAI_TRUSTED_PROXIES` ⇒ 拒绝启动**。
//
// 自检必须能区分"compose 默认值"与"管理员显式配置"，否则要么永远拒启、要么形同虚设。
// 做法：`docker-compose.yml` 同时注入
//
//	PICOAI_TRUSTED_PROXIES:          ${PICOAI_TRUSTED_PROXIES:-172.28.0.2}
//	PICOAI_TRUSTED_PROXIES_EXPLICIT: ${PICOAI_TRUSTED_PROXIES:+1}
//
// 只有管理员在 `.env` 里显式写了 `PICOAI_TRUSTED_PROXIES` 时 EXPLICIT 才非空，
// 从而与"compose 兜底 172.28.0.2"区分开（既有登录限流的 `c.ClientIP()` 行为不变）。
package anonlimit

import (
	"container/list"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// EnvTrustedProxies / EnvTrustedProxiesExplicit 是自检读取的两个环境变量名。
const (
	EnvTrustedProxies         = "PICOAI_TRUSTED_PROXIES"
	EnvTrustedProxiesExplicit = "PICOAI_TRUSTED_PROXIES_EXPLICIT"
)

// Options 是限流器配置（零值用 limits 缺省）。
type Options struct {
	GlobalRatePerMin int
	GlobalBurst      int
	PerIPRatePerMin  int
	PerIPBurst       int
	// MaxIPBuckets 是每 IP 桶的数量上限（防"海量源 IP"把内存打爆）。
	// 超出后按"最近最少使用"淘汰；被淘汰的 IP 重新计数只会更严，不会更松。
	MaxIPBuckets int
	// Now 可注入时钟（测试用）。
	Now func() time.Time
}

// DefaultOptions 返回与 limits 包一致的缺省配置。
func DefaultOptions() Options {
	return Options{
		GlobalRatePerMin: limits.AnonGlobalRatePerMin,
		GlobalBurst:      limits.AnonGlobalBurst,
		PerIPRatePerMin:  limits.AnonPerIPRatePerMin,
		PerIPBurst:       limits.AnonPerIPBurst,
		MaxIPBuckets:     8192,
		Now:              time.Now,
	}
}

func (o Options) withDefaults() Options {
	d := DefaultOptions()
	if o.GlobalRatePerMin <= 0 {
		o.GlobalRatePerMin = d.GlobalRatePerMin
	}
	if o.GlobalBurst <= 0 {
		o.GlobalBurst = d.GlobalBurst
	}
	if o.PerIPRatePerMin <= 0 {
		o.PerIPRatePerMin = d.PerIPRatePerMin
	}
	if o.PerIPBurst <= 0 {
		o.PerIPBurst = d.PerIPBurst
	}
	if o.MaxIPBuckets <= 0 {
		o.MaxIPBuckets = d.MaxIPBuckets
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	return o
}

// Limiter 是"全局 + 每 IP"双层令牌桶。
type Limiter struct {
	opt Options

	mu     sync.Mutex
	global bucket
	ips    map[string]*ipBucket
	// lru 是 IP 桶的最近使用顺序（Front = 最近用过，Back = 最久没用）。
	//
	// 为什么需要它（审计 P2-4）：此前每次 `Allow` 遇到新 IP 且表满时都做**两次
	// O(N) 全表扫描**（先扫"空闲 >10 分钟"、再逐个扫找最旧），8192 桶时单次
	// 865 µs 且持全局锁 —— 被拒的请求也要付这笔钱。改成 LRU 链表后：
	// 每次访问 O(1) 移到表头、淘汰从表尾批量摘 O(1)/个，成本被摊销到"每批新 IP"。
	lru *list.List
	// Rejected 是累计拒绝数（§4.9 可观测；不落库，进程内存态）。
	rejected int64
	// evicted 是累计淘汰的 IP 桶数（可观测）。
	evicted int64
	// evictSteps 是淘汰路径累计触碰的桶数（**性能回归口径**：判据用"操作次数"
	// 而不是绝对耗时，机器差异会让绝对阈值假红）。
	evictSteps int64
}

type bucket struct {
	tokens   float64
	last     time.Time
	capacity float64
	ratePerS float64
}

type ipBucket struct {
	bucket
	// elem 是该桶在 lru 里的位置（淘汰时从表尾摘、访问时移到表头）。
	elem *list.Element // 元素值是 ip string
}

// New 创建限流器。
func New(opt Options) *Limiter {
	o := opt.withDefaults()
	now := o.Now()
	l := &Limiter{opt: o, ips: map[string]*ipBucket{}, lru: list.New()}
	l.global = newBucket(float64(o.GlobalBurst), float64(o.GlobalRatePerMin)/60.0, now)
	return l
}

func newBucket(capacity, ratePerS float64, now time.Time) bucket {
	return bucket{tokens: capacity, last: now, capacity: capacity, ratePerS: ratePerS}
}

// take 尝试取一个令牌，返回是否成功与需要等待多久。
func (b *bucket) take(now time.Time) (bool, time.Duration) {
	elapsed := now.Sub(b.last).Seconds()
	if elapsed > 0 {
		b.tokens += elapsed * b.ratePerS
		if b.tokens > b.capacity {
			b.tokens = b.capacity
		}
		b.last = now
	}
	if b.tokens >= 1 {
		b.tokens--
		return true, 0
	}
	need := 1 - b.tokens
	wait := time.Duration(need / b.ratePerS * float64(time.Second))
	if wait < time.Second {
		wait = time.Second
	}
	return false, wait
}

// Allow 判定一次匿名请求是否放行。
//
// 顺序：**先扣每 IP 桶，再扣全局桶**（先细后粗）。若全局桶已满而每 IP 桶还有余量，
// 每 IP 的令牌已被扣掉 —— 这是有意的保守取舍（宁可少放行，不放过）。
func (l *Limiter) Allow(ip string) (bool, time.Duration) {
	now := l.opt.Now()
	if ip == "" {
		ip = "unknown"
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, exists := l.ips[ip]; !exists && len(l.ips) >= l.opt.MaxIPBuckets {
		// 摊销：一次腾出一个**批次**，接下来的 MaxIPBuckets/8 个新 IP 都不必再淘汰。
		// 硬顶不变（插入后 len(ips) ≤ MaxIPBuckets），只是把"每个新 IP 两次全表扫描"
		// 摊成"每批一次 O(批大小) 的表尾摘除"。
		l.evictLocked()
	}

	b := l.ipBucketLocked(ip, now)
	okIP, waitIP := b.take(now)
	if !okIP {
		l.rejected++
		return false, waitIP
	}
	okGlobal, waitGlobal := l.global.take(now)
	if !okGlobal {
		l.rejected++
		return false, waitGlobal
	}
	return true, 0
}

func (l *Limiter) ipBucketLocked(ip string, now time.Time) *ipBucket {
	b, ok := l.ips[ip]
	if !ok {
		b = &ipBucket{bucket: newBucket(float64(l.opt.PerIPBurst), float64(l.opt.PerIPRatePerMin)/60.0, now)}
		b.elem = l.lru.PushFront(ip)
		l.ips[ip] = b
		return b
	}
	// 命中即刷新 LRU 位置（O(1)：链表元素指针就在桶里）。
	l.lru.MoveToFront(b.elem)
	return b
}

// evictBatchDivisor 决定一次批量淘汰的规模：一次淘汰 MaxIPBuckets/8 个，
// 即淘汰后水位降到 7/8（7168/8192）。
//
// 为什么批量而不是"插一个踢一个"：见 Limiter.lru 的注释（审计 P2-4 的 865 µs/新 IP）。
// 为什么是 1/8 而不是更大：淘汰是 LRU 语义（每个新 IP 平均仍挤掉一个旧桶），
// 批量只影响"什么时候做这件事"，不改变"谁被挤掉"；批次越大，单次停顿越大
// （8192 桶时 1/8 = 1024 次链表摘除，仍是微秒级）。
const evictBatchDivisor = 8

// evictLocked 从 LRU 表尾批量摘除最久未使用的桶。
//
// 内存仍有界：调用点在"新 IP 且 len(ips) >= MaxIPBuckets"时，摘到一个批次后
// 插入 ⇒ len(ips) 恒 ≤ MaxIPBuckets。
//
// 行为不放松：被淘汰的 IP 下次访问从满桶重新开始（单次放宽），但**全局桶仍是硬顶**
// —— 攻击者无论换多少 IP，能放行的总量仍受全局令牌桶（§4.6：3000 次/分）约束。
// 淘汰的是"最久没用过"的那些：它们要么已经停止访问，要么令牌早已回满。
func (l *Limiter) evictLocked() {
	batch := l.opt.MaxIPBuckets / evictBatchDivisor
	if batch < 1 {
		batch = 1
	}
	target := l.opt.MaxIPBuckets - batch
	for len(l.ips) > target {
		back := l.lru.Back()
		if back == nil {
			return // 链表与 map 应当同步；防御性返回而不是死循环
		}
		ip, _ := back.Value.(string)
		l.lru.Remove(back)
		delete(l.ips, ip)
		l.evicted++
		l.evictSteps++
	}
}

// Stats 返回限流水位（观测面用）。
type Stats struct {
	IPBuckets int   `json:"ip_buckets"`
	Rejected  int64 `json:"rejected"`
	// Evicted 是累计被 LRU 淘汰的 IP 桶数（桶满即淘汰 ⇒ 这个数说明桶上限在被使用）。
	Evicted int64 `json:"evicted"`
	// GlobalTokens 是全局桶剩余令牌（向下取整）。
	GlobalTokens int `json:"global_tokens"`
}

// Stats 返回水位。
func (l *Limiter) Stats() Stats {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.global.refill(l.opt.Now())
	return Stats{IPBuckets: len(l.ips), Rejected: l.rejected, Evicted: l.evicted, GlobalTokens: int(l.global.tokens)}
}

// EvictSteps 返回淘汰路径累计触碰的桶数（**性能回归口径**）。
//
// 判据是"桶满状态下每个新 IP 的淘汰操作数 ≤ 一个小的常数"（见
// TestEvictionCostIsAmortized）：用操作计数而不是绝对耗时，避免机器差异假红。
func (l *Limiter) EvictSteps() int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.evictSteps
}

func (b *bucket) refill(now time.Time) {
	elapsed := now.Sub(b.last).Seconds()
	if elapsed <= 0 {
		return
	}
	b.tokens += elapsed * b.ratePerS
	if b.tokens > b.capacity {
		b.tokens = b.capacity
	}
	b.last = now
}

// ===== 启动自检（R35）=====

// CheckTrustedProxies 是"启用应用子域"时的启动自检。
//
// 返回非 nil ⇒ **拒绝启动**。规则（R35 + §4.6）：
//  1. 未启用子域 ⇒ 不校验（不影响既有部署）；
//  2. `PICOAI_TRUSTED_PROXIES` 为空 ⇒ 拒（缺省只信回环会让全部匿名流量坍缩进同一桶）；
//  3. 值来自 compose 兜底（`PICOAI_TRUSTED_PROXIES_EXPLICIT` 为空）⇒ 拒，
//     错误信息明确指出"这是 compose 默认值，请在 .env 显式配置"；
//  4. 每项必须能解析为 IP 或 CIDR ⇒ 否则拒（错配会让 `c.ClientIP()` 静默回落 RemoteAddr）。
func CheckTrustedProxies(getenv func(string) string, subdomainsEnabled bool) *apperr.Error {
	if getenv == nil {
		return apperr.New(apperr.CodeInternal, "缺少环境读取函数")
	}
	if !subdomainsEnabled {
		return nil
	}
	raw := strings.TrimSpace(getenv(EnvTrustedProxies))
	if raw == "" {
		return apperr.New(apperr.CodeValidation, "已启用应用子域，但未配置 PICOAI_TRUSTED_PROXIES").
			WithHint("在部署 .env 里显式写出前置反向代理的地址/CIDR（例如 172.28.0.2），否则全部匿名流量会被算作同一个来源").
			WithHint("该自检的作用是防止「全组织共享一个匿名限流桶」——本仓已有同族事故")
	}
	if strings.TrimSpace(getenv(EnvTrustedProxiesExplicit)) == "" {
		return apperr.New(apperr.CodeValidation, "PICOAI_TRUSTED_PROXIES 来自 compose 默认值，不能作为可信代理依据").
			WithDetail("value", raw).
			WithHint("在部署 .env 里显式设置 PICOAI_TRUSTED_PROXIES=<代理 IP 或 CIDR 列表>（compose 的默认值不算显式配置）")
	}
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if net.ParseIP(item) != nil {
			continue
		}
		if _, _, err := net.ParseCIDR(item); err == nil {
			continue
		}
		return apperr.New(apperr.CodeValidation, fmt.Sprintf("PICOAI_TRUSTED_PROXIES 含无法解析的项：%q", item)).
			WithHint("每一项必须是 IP 或 CIDR（逗号分隔）")
	}
	return nil
}

// SubdomainsEnabled 由配置面决定（是否配置了应用基域）。此函数只做"是否配了"的判断，
// 不解析域名合法性（那是 edge 包的职责）。
func SubdomainsEnabled(baseDomain string) bool {
	return strings.TrimSpace(baseDomain) != ""
}
