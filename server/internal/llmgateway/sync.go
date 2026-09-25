package llmgateway

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"strings"
	"time"

	"github.com/picoaide/picoaide/internal/llmgateway/channels"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// SyncResult 描述一个 provider 的同步结果。
type SyncResult struct {
	Provider string `json:"provider"`
	Added    int    `json:"added"`
	Removed  int    `json:"removed"`
	// Skipped:手动型上游无需同步(审计修复 L8),供前端折叠展示而非逐条报错。
	Skipped bool   `json:"skipped,omitempty"`
	Error   string `json:"error,omitempty"`
}

// httpFetch15s 返回带 15s 请求内超时的 fetchFn(审计修复 M5):慢/黑洞上游
// 不得把 admin 同步请求挂到 channels.HTTPFetch 的 120s 客户端超时。
// 与 syncProviderNow 即时同步口径一致;测试经 syncFetchFn 注入。
//
// 2026-09-19:ctx/cancel **按调用**创建。此前建在闭包外、cancel 在闭包内 defer
// ⇒ 同一闭包第二次调用必然拿到已取消的 ctx、立刻以 `context canceled` 失败
// (看起来像上游抖动,极难排查)。当前 3 个调用点都是"建一次闭包只调一次"所以
// 不可达,但这是随时会被下一个重构打破的陷阱;按调用创建对单次调用逐字等价,
// 且未调用时不再挂着一个永不 cancel 的 15s timer。
func httpFetch15s(key string) func(url string) ([]byte, error) {
	return func(url string) ([]byte, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return channels.HTTPFetch(ctx, url, key)
	}
}

// SyncOnce 对所有 enabled 且含 key 的 provider 拉取模型并同步 models 表。
// 单个 provider 失败不影响其他。fetchFn 可注入便于测试;nil 时用 HTTPFetch。
func SyncOnce(db *sql.DB, fetchFn func(url string) ([]byte, error)) ([]SyncResult, error) {
	providers, err := serverstore.ListGatewayProviders(db)
	if err != nil {
		return nil, err
	}
	var results []SyncResult
	for i := range providers {
		p := &providers[i]
		if p.Enabled != 1 || p.APIKeyEnc == "" {
			continue
		}
		if p.Channel == "" {
			// 手动型上游:模型来自创建时填写的列表,无需也绝不能自动同步;
			// 但 sync-all 必须明确说明,否则管理员以为同步无效。标记 Skipped
			// 供前端折叠为一行汇总(审计修复 L8)。
			results = append(results, SyncResult{Provider: p.Name, Skipped: true, Error: "手动型上游无需同步(模型来自模型列表)"})
			continue
		}
		ch, ok := channels.Get(p.Channel)
		if !ok {
			results = append(results, SyncResult{Provider: p.Name, Error: "unknown channel"})
			continue
		}
		key, err := DecryptSecret(p.APIKeyEnc)
		if err != nil {
			results = append(results, SyncResult{Provider: p.Name, Error: err.Error()})
			continue
		}
		results = append(results, SyncProvider(db, ch, p, key, fetchFn))
	}
	return results, nil
}

// SyncProvider 同步单个 provider 的模型,返回结果。
// added = 本次真正新增的模型数(此前不在目录中的),removed = 上游不再提供
// 而被清理的模型数(审计修复 M5:此前 added 恒为全量目录数,误导运维)。
// 排除名单中的模型(管理端删除的渠道同步模型)跳过,防止被 SyncLoop 复活
// (审计修复 H2)。
func SyncProvider(db *sql.DB, ch channels.Channel, p *serverstore.GatewayProvider, key string, fetchFn func(url string) ([]byte, error)) SyncResult {
	f := fetchFn
	if f == nil {
		f = httpFetch15s(key)
	}
	// P2-5(审计 2026-09-13):同步必须打到**该 provider 自己的 base_url**。
	// 旧实现一律用渠道的硬编码 URL(如 api.deepseek.com),而 admin.go 允许
	// "channel=deepseek + 自定义 base_url" ⇒ 自建代理的 key 会被每小时自动
	// 发往厂商端点。只有 provider 未配 base_url(或与渠道默认一致)时才用
	// 渠道实现(它的解析/默认能力才适用)。
	var models []channels.ModelInfo
	var err error
	customBase := strings.TrimRight(strings.TrimSpace(p.BaseURL), "/")
	if customBase != "" && customBase != strings.TrimRight(ch.BaseURL(), "/") {
		var raw []byte
		raw, err = f(customBase + "/models")
		if err == nil {
			models, err = channels.ParseOAIModels(raw)
		}
	} else {
		models, err = ch.FetchModels(context.Background(), key, f)
	}
	if err != nil {
		return SyncResult{Provider: p.Name, Error: err.Error()}
	}
	// 空列表可能是上游瞬时异常,不当作"模型全部下架"清空目录
	if len(models) == 0 {
		return SyncResult{Provider: p.Name, Added: 0, Removed: 0}
	}
	// 排除名单:管理端删除的渠道同步模型不自动恢复(审计修复 H2)
	//
	// 2026-09-19(审计):读失败必须 fail-closed **跳过本轮同步**。此前
	// `excluded = nil` 把"读不出来"当成"名单为空" ⇒ SyncLoop 的下一跳就把
	// 管理员删掉的模型重新建回来,绕过 H2(排除名单是该修复的唯一载体)。
	// 与上文"空模型列表不当成全部下架"同一条纪律:拿不准就不动目录。
	excluded, err := serverstore.GetExcludedModels(db, p.ID)
	if err != nil {
		return SyncResult{Provider: p.Name, Error: "读取模型排除名单失败(已跳过本轮同步):" + err.Error()}
	}
	excludedSet := make(map[string]bool, len(excluded))
	for _, e := range excluded {
		excludedSet[e] = true
	}
	// 同步前目录集合:计算 added 的基线(审计修复 M5)。
	// 读失败时退化成空集合 ⇒ added 报成全量新增(仅计数偏差,不改库)。
	// 判定:可接受 —— 为一次统计读失败而让整个 provider 同步失败,代价大于收益;
	// 因此保留该降级,只把它记进日志以免静默。
	//
	// R13-GH3：这条基线读的是族内关系(`models`)⇒ 必须经唯一 pin 实现读
	// （旧实现是裸池：shadow schema 在场时基线读自 shadow，Added 计数与真实目录
	// 脱钩，而这里的降级路径让它更隐蔽）。读失败仍按原语义降级。
	beforeSet := make(map[string]bool)
	var beforeErr error
	if err := serverstore.WithUsageSearchPathRead(db, func(tx *sql.Tx) error {
		before, err := syncedModelNames(tx, p.ID)
		if err != nil {
			return err
		}
		for _, n := range before {
			beforeSet[n] = true
		}
		return nil
	}); err != nil {
		beforeErr = err
		beforeSet = make(map[string]bool)
		log.Printf("gateway sync: provider %d 同步前模型清单读取失败,Added 计数可能偏大: %v", p.ID, beforeErr)
	}
	cl, mo := ch.DefaultModelCaps()
	type caps struct {
		ContextLength int64 `json:"context_length"`
		MaxOutput     int64 `json:"max_output"`
	}
	seen := make(map[string]bool, len(models))
	var newNames []string
	added := 0
	for _, m := range models {
		if seen[m.ID] || excludedSet[m.ID] {
			continue
		}
		seen[m.ID] = true
		cln, mon := m.ContextLen, m.MaxOutput
		if cln == 0 {
			cln = cl
		}
		if mon == 0 {
			mon = mo
		}
		params, _ := json.Marshal(caps{ContextLength: cln, MaxOutput: mon})
		if err := serverstore.SyncProviderModel(db, p.ID, m.ID, string(params)); err != nil {
			return SyncResult{Provider: p.Name, Error: err.Error()}
		}
		if !beforeSet[m.ID] {
			added++
		}
		newNames = append(newNames, m.ID)
	}
	removed, err := serverstore.RemoveMissingProviderModels(db, p.ID, newNames)
	if err != nil {
		return SyncResult{Provider: p.Name, Error: err.Error()}
	}
	return SyncResult{Provider: p.Name, Added: added, Removed: removed}
}

// pendingUsageRetention 是流式 pending 行的保留时长(P2-8)。
const pendingUsageRetention = 6 * time.Hour

// SyncIteration runs one model sync plus pending-usage cleanup (C-9): stale
// zero-token rows from interrupted streams are purged on every tick, not
// only at startup.
func SyncIteration(db *sql.DB, fetchFn func(url string) ([]byte, error)) ([]SyncResult, error) {
	// P2-8(审计 2026-09-13):清理阈值必须**远超**流式请求的真实上限。
	// 旧值 1 小时:停留 >1h 的流(长报告/慢上游/客户端挂住)其 pending 行会被
	// 删除,之后回填必然失败 ⇒ 已转发内容整段零计费。流本身有 90s 空闲超时,
	// 正常流不会接近 6h;这里留足余量,同时仍能回收真正的中断残留。
	if err := serverstore.CleanupPendingUsage(db, time.Now().Add(-pendingUsageRetention)); err != nil {
		log.Printf("gateway: cleanup pending usage: %v", err)
	}
	return SyncOnce(db, fetchFn)
}

// syncIterationLogged 执行一轮同步,并把**逐 provider 的**错误写进日志。
//
// 2026-09-19(P2-3):SyncProvider 的 fail-closed(例如"读取模型排除名单失败
// (已跳过本轮同步)")此前只进 SyncResult.Error,而 SyncLoop 只看 SyncIteration
// 的**顶层** error ⇒ 名单持久损坏时该 provider 静默停更,只有管理员手点同步
// 才看得见(把上一提交的"静默复活"换成了"静默停更")。这条日志是该错误在
// 后台链路唯一的出口。
//
// 判据与取舍:
//   - 每跳每 provider **至多一行**(Error 非空才打),线上间隔 1h ⇒ 不会刷爆
//     日志;行内同时给出 provider 名与错误原文,可直接定位到 settings 行。
//   - Skipped(手动型上游无需同步,Error 是设计内说明)不算失败,**不打**失败行,
//     否则每个手动上游每小时刷一行噪音;它的说明在 sync-all 响应里照旧。
//   - 不改变 SyncIteration / SyncProvider 的返回语义(仍原样返回 results/error);
//     SyncIteration 顶层 error 的日志("gateway sync: %v")逐字不变。
//
// 抽成独立函数只为可测:用例直接调用它并捕获真实 log 输出,不必起 goroutine +
// sleep(那种写法既慢又会把 SyncLoop 永久跑在测试进程里)。
func syncIterationLogged(db *sql.DB, fetchFn func(url string) ([]byte, error)) {
	results, err := SyncIteration(db, fetchFn)
	if err != nil {
		log.Printf("gateway sync: %v", err)
	}
	for _, r := range results {
		if r.Skipped || r.Error == "" {
			continue
		}
		log.Printf("gateway sync: provider %s 同步失败: %s", r.Provider, r.Error)
	}
}

// SyncLoop 定时执行 SyncIteration,固定间隔。
func SyncLoop(db *sql.DB, interval time.Duration, fetchFn func(url string) ([]byte, error)) {
	if interval <= 0 {
		interval = time.Hour
	}
	for {
		syncIterationLogged(db, fetchFn)
		time.Sleep(interval)
	}
}
