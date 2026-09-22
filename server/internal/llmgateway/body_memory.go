package llmgateway

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// 出站体加工的数值、内存闸门与"整 body map 往返"的唯一实现（2026-09-22）
// ---------------------------------------------------------------------------
//
// 背景（审计 2026-09-22 F 路 P1-3 / P2-3）：聊天类端点要把客户端请求体解析成
// `map[string]any` 才能做两件事（注入官方用户标识 + 校验 file_id 归属）。这条路径有两个
// 结构性问题：
//
//  1. **放大**：`map[string]any` 往返的瞬时内存是请求体字节的数倍（实测见
//     `TestBodyRewritePeakAmplification`），而请求体上限是 64MiB，且解析发生在限流/余额
//     闸门**之前** —— 并发叠加时 RSS 会被单方面推高；
//  2. **次数**：同一份体在候选 provider 循环里还会被 `applyChannelOverrides` /
//     `applyMaxTokensDefault` / `applyStreamUsageRequest` 各自再整体往返一次。
//
// 本文件的三个不变量：
//   - 所有"整 body map 往返"只走 `rewriteJSONObjectBody` 一个实现（放大的唯一来源）；
//   - 每次往返都必须先过进程级**在飞字节闸门**（`bodyParseGate`），超了直接 503
//     （fail-closed、可重试），而不是让内存无上限叠加；
//   - 两个可配数值（引用数上限、在飞字节预算）都来自 `settings`，管理后台可改，
//     进程内 10s TTL 缓存（改完最多 10s 生效；保存时主动失效）。

const (
	// SettingMaxFileRefs / SettingBodyParseBudgetMB 是网关页可配的两个键。
	SettingMaxFileRefs       = "gateway.max_file_refs"
	SettingBodyParseBudgetMB = "gateway.body_parse_budget_mb"

	// DefaultMaxFileRefsPerRequest：单请求 file_id 引用数上限的缺省值。
	//
	// **与官方口径对齐**：官方 vision 文档给出"单请求最多 600 张图"
	// （`guides/vision.md`），600 就是这条护栏的缺省值 —— 我们的归属校验只做"这个 id
	// 是不是你传的"，绝不能比上游更严（审计 2026-09-22 R4 N-2：缺省 256 会让
	// 257~600 张图的合法请求被本地 400，而它们本可以正常出图）。
	DefaultMaxFileRefsPerRequest = 600
	// MaxMaxFileRefsPerRequest：上限值的允许范围（0/非法 ⇒ 回落缺省，不允许关闭闸门）。
	MaxMaxFileRefsPerRequest = 4096

	// DefaultBodyParseBudgetMB：进程级"同时在加工的请求体字节"预算（MiB）。
	//
	// 语义是**客户端请求体字节**，不是 RSS。实测（BenchmarkBodyRewritePeakAmplification，
	// 1.2MB 密对象体）：整趟 map 往返的总分配 ≈28× 请求体，峰值活跃堆约 6~8×。
	// 缺省 128MiB ⇒ 最坏同时两个 64MiB 慢路径体（峰值约 1~2GiB），小机器可下调到
	// 下限 64MiB（一次一个），大机器按 `可用内存 ÷ 8` 上调。
	DefaultBodyParseBudgetMB = 128
	// MinBodyParseBudgetMB：至少能容纳一个 64MiB 上限请求体（否则谁都过不去）。
	MinBodyParseBudgetMB = 64
	MaxBodyParseBudgetMB = 8192

	// gatewayLimitsTTL：进程内缓存的有效期。管理端保存后立即 InvalidateGatewayLimits()。
	gatewayLimitsTTL = 10 * time.Second
)

// gatewayLimits 是两个可配数值的进程内快照。
type gatewayLimits struct {
	maxFileRefs int
	budgetBytes int64
}

var gatewayLimitsCache struct {
	mu     sync.Mutex
	loaded bool
	at     time.Time
	val    gatewayLimits
}

// gatewayLimitsFor 读两个可配数值（10s TTL 缓存）。
//
// db == nil（测试里直接调 helper）⇒ 返回缺省值，不触碰数据库。
// 读库失败/值非法 ⇒ 回落缺省值：这两个值只影响"允许多大/多少"，回落缺省是保守方向
// （缺省值本身就是闸门，不是"关闸门"）。
func gatewayLimitsFor(db *sql.DB) gatewayLimits {
	def := gatewayLimits{
		maxFileRefs: DefaultMaxFileRefsPerRequest,
		budgetBytes: int64(DefaultBodyParseBudgetMB) << 20,
	}
	if db == nil {
		return def
	}
	gatewayLimitsCache.mu.Lock()
	defer gatewayLimitsCache.mu.Unlock()
	if gatewayLimitsCache.loaded && time.Since(gatewayLimitsCache.at) < gatewayLimitsTTL {
		return gatewayLimitsCache.val
	}
	out := def
	if all, err := serverstore.GetAllSettings(db); err == nil {
		if n, err := strconv.Atoi(strings.TrimSpace(all[SettingMaxFileRefs])); err == nil && n > 0 && n <= MaxMaxFileRefsPerRequest {
			out.maxFileRefs = n
		}
		if n, err := strconv.Atoi(strings.TrimSpace(all[SettingBodyParseBudgetMB])); err == nil && n >= MinBodyParseBudgetMB && n <= MaxBodyParseBudgetMB {
			out.budgetBytes = int64(n) << 20
		}
	}
	gatewayLimitsCache.val = out
	gatewayLimitsCache.at = time.Now()
	gatewayLimitsCache.loaded = true
	return out
}

// InvalidateGatewayLimits 让下一次读取重新查库（管理端保存后调用；测试也用它复位）。
func InvalidateGatewayLimits() {
	gatewayLimitsCache.mu.Lock()
	gatewayLimitsCache.loaded = false
	gatewayLimitsCache.mu.Unlock()
}

// ParseMaxFileRefs / ParseBodyParseBudgetMB 供管理端保存前校验（返回 0/false 表示非法）。
func ParseMaxFileRefs(v string) (int, bool) {
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n <= 0 || n > MaxMaxFileRefsPerRequest {
		return 0, false
	}
	return n, true
}

func ParseBodyParseBudgetMB(v string) (int, bool) {
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil || n < MinBodyParseBudgetMB || n > MaxBodyParseBudgetMB {
		return 0, false
	}
	return n, true
}

// bodyParseGate 是进程级"在飞请求体字节"闸门。
//
// 为什么按字节而不是按请求数：一条 64MiB 的体与一条 64KiB 的体代价差三个数量级，
// 按条数限制挡不住内存。为什么是进程级而不是按用户：内存是进程共享资源，按用户限
// 只会让"每人 32 并发"叠加（`InFlightGuard`）——正是审计指出的缺口。
type bodyParseGate struct {
	mu       sync.Mutex
	inFlight int64
}

var globalBodyParseGate bodyParseGate

// acquire 申请 n 字节额度：成功返回 true，超预算返回 false（调用方必须 503）。
// n <= 0 视为成功（空体没有放大面）。
func (g *bodyParseGate) acquire(budget, n int64) bool {
	if n <= 0 {
		return true
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.inFlight+n > budget {
		return false
	}
	g.inFlight += n
	return true
}

func (g *bodyParseGate) release(n int64) {
	if n <= 0 {
		return
	}
	g.mu.Lock()
	g.inFlight -= n
	if g.inFlight < 0 {
		g.inFlight = 0 // 防御：任何路径都不该多释放
	}
	g.mu.Unlock()
}

// inFlightBytes 是当前在飞字节（诊断/测试口径）。
func (g *bodyParseGate) inFlightBytes() int64 {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.inFlight
}

var (
	// errBodyParseBusy：内存闸门拒绝 ⇒ 调用方必须返回 503 + code SERVER（可重试）。
	errBodyParseBusy = errors.New("gateway body parse budget exhausted")
	// errBodyNoChange：mutate 判定无需改动 ⇒ 原字节返回（零重编码，前缀缓存最友好）。
	errBodyNoChange = errors.New("gateway body unchanged")
)

// rewriteJSONObjectBody 是**所有**"整 body map 往返"的唯一实现：
// 申请内存额度 → 解析 → mutate → 编码（SetEscapeHTML(false)，尾部换行去掉）。
//
// 错误语义：
//   - mutate 返回 `errBodyNoChange` ⇒ 返回值是**原始字节**且 err == nil（调用方原样用）；
//   - `errBodyParseBusy` ⇒ 在飞额度不足，调用方 503（未解析、未分配）；
//   - 其它 error ⇒ 体不是合法 JSON 对象（由调用方决定 400 文案）。
//
// mutate 返回自定义错误时原样向上传递（例如"已经写过响应"的哨兵），不做重编码。
func rewriteJSONObjectBody(db *sql.DB, raw []byte, mutate func(map[string]any) error) ([]byte, error) {
	budget := gatewayLimitsFor(db).budgetBytes
	n := int64(len(raw))
	if !globalBodyParseGate.acquire(budget, n) {
		log.Printf("gateway: body rewrite rejected: in-flight=%dMiB budget=%dMiB request=%dMiB",
			globalBodyParseGate.inFlightBytes()>>20, budget>>20, n>>20)
		return nil, errBodyParseBusy
	}
	defer globalBodyParseGate.release(n)

	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber() // 保全大整数精度（float64 会让 >2^53 的整数在重编码时漂移）
	var body map[string]any
	if err := dec.Decode(&body); err != nil || body == nil {
		return nil, errNotJSONObject
	}
	if mutate != nil {
		switch err := mutate(body); {
		case err == nil:
		case errors.Is(err, errBodyNoChange):
			// "无需改动"不是错误：返回**原始字节**（零重编码，前缀缓存最友好）。
			return raw, nil
		default:
			return nil, err
		}
	}
	var buf bytes.Buffer
	buf.Grow(len(raw) + 32)
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false) // 正文里的 < > & 不再被转成 \u003c（输出膨胀 ~1.9× 的来源）
	if err := enc.Encode(body); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// errNotJSONObject：体是合法 JSON 但不是对象（数组/标量/`null`）。
var errNotJSONObject = errors.New("gateway body is not a JSON object")
