package llmgateway

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"log"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// 网关文件的自动回收（2026-09-22）
// ---------------------------------------------------------------------------
//
// 为什么需要：上游 Files 配额是**每 API key**（全组织共享 25 GiB / 10000 个文件），
// 而我们把"文件过期"收敛到了平台上限（`gateway.file_expiry_days`，缺省 7 天，见
// enforceFileExpiry）。收敛只写在**台账**里 —— 上游那份对象仍然存在到它自己的
// `expires_after`（可能是 30 天或永久），所以必须有执行者在上限到点时去上游删掉，
// 否则配额会被"已经不可访问、但还占着"的文件慢慢吃光（官方客户端在配额不足时
// 会删最旧的 `dsh-` 文件，那是我们不想依赖的兜底）。
//
// 语义边界：
//   - 只处理台账里**已过期**的行（`expires_at <= now()`），也就是网关已经拒绝授权的那些；
//     认领是**打标记**（`reaping_at`）而不是删行：崩在"删上游"与"收尾"之间时行还在，
//     下一轮可重新认领并重删（404 = 成功），不会留下"永无凭据"的孤儿对象（R7 N11）；
//   - 上游删除用服务端持有的 key，best-effort：404（上游自己过期了）算成功，其它
//     失败只记日志、**保留行**下轮重试（不删行 = 不会漏掉这个文件的清理责任）；
//   - 每轮批量有上限（默认 500），避免一次扫太多把上游打爆。

// FileReaperInterval 是回收器默认扫描间隔。5 分钟：上限到点后最多多占 5 分钟配额，
// 对 25 GiB / 10000 文件的量级足够；调大只会让"已过期但仍占配额"的窗口变长。
const FileReaperInterval = 5 * time.Minute

// ReapExpiredGatewayFiles 执行一轮回收：删上游 + 删台账行，返回 (成功, 失败) 计数。
//
// 并发正确性（审计 2026-09-22 R6 P1-A + 2026-09-23 R4-C-1）：删除权是一个**带世代
// 号的令牌**，不会被"转手给新一代"夺取：
//
//  1. 每一行先经 `serverstore.ClaimExpiredGatewayFile` 在事务内 `FOR UPDATE` + 复检
//     过期 + **行世代 +1** 后打标记（无锁列表 + 无条件删行会在并发续期时把活行与上游
//     对象一起删掉）；
//  2. 认领在租约内时，登记路径（`RecordGatewayFileSize`）**拒绝转手** —— 同一个 id
//     的"新上传者"拿不到这一行（返回 `ErrGatewayFileReapClaimed`，上传路径据此放弃
//     这个 id）。这是 R4-C-1 的核心：过去"过期行可转手"会让新上传者的上游对象被在飞
//     的 DELETE 误删，而台账仍显示它有效；
//  3. 发上游 DELETE **之前**复检一次"世代未变 + 标记仍在租约内"（`GatewayFileReapClaimHeld`）；
//     收尾删行时**再**校验一次世代（`FinishReapedGatewayFile` 的谓词）—— 即 DELETE
//     前后各校验一次。任何一次发现世代变了就放弃（行留给新一代，日志点名 file_id + 世代）。
//
// 上游删除失败 ⇒ 释放回收标记（`ReleaseReapClaim`），行**从不删除** ⇒ 下一轮立刻可以
// 重新认领并重试（行是"还有清理责任"的唯一凭据；认领本身也不再删行，见
// `serverstore.ClaimExpiredGatewayFile` 的说明）。
func (a *API) ReapExpiredGatewayFiles(limit int) (deleted, failed int) {
	if a == nil || a.DB == nil {
		return 0, 0
	}
	// 上游可用性**先判**：规范化会把存量"永久"行（expires_at IS NULL）标成"已过期"，
	// 而上游不可用时我们根本删不掉对象 —— 提前标记只会让这些行在管理端看起来"可回收/
	// 已处理"，实际对象继续占着共享配额（把可见的泄漏面变成隐身的）。上游恢复后再补做。
	up, ok := fileUpstream(a.DB)
	if !ok {
		log.Printf("gateway: file reaper: no usable files upstream; skipping this round (no normalize/list)")
		return 0, 0
	}
	// 存量"永久"行按上限补齐，使它们可被回收（幂等，只动 NULL 行）。
	if n, err := serverstore.NormalizeLegacyPermanentGatewayFiles(a.DB, gatewayLimitsFor(a.DB).fileExpiry, limit); err != nil {
		log.Printf("gateway: file reaper: normalize legacy permanent rows failed: %v", err)
	} else if n > 0 {
		log.Printf("gateway: file reaper: %d legacy permanent file(s) capped to the platform retention limit", n)
	}
	ids, err := serverstore.ListExpiredGatewayFiles(a.DB, limit)
	if err != nil {
		log.Printf("gateway: file reaper: list expired rows failed: %v", err)
		return 0, 0
	}
	if len(ids) == 0 {
		return 0, 0
	}
	if fn := reapAfterListHook.load(); fn != nil {
		fn(ids) // 测试注入点：模拟"列表与认领之间"发生的并发续期
	}
	client := a.filesHTTPClient()
	for _, id := range ids {
		// 形状非法的台账行拼不出合法上游 URL：就地丢弃并继续（否则每轮挤占一个批次位，
		// 管理员列表里也会留下永远删不掉的幽灵行）。这是本地数据损坏，不计入 failed。
		if !validGatewayFileID(id) {
			log.Printf("gateway: file reaper: drop unusable ledger id")
			if derr := serverstore.DeleteGatewayFileRow(a.DB, id); derr != nil {
				log.Printf("gateway: file reaper: drop unusable ledger row failed: %v", derr)
			}
			continue
		}
		snap, claimed, err := serverstore.ClaimExpiredGatewayFile(a.DB, id)
		if err != nil {
			log.Printf("gateway: file reaper: claim expired row failed (id=%s): %v", id, err)
			failed++
			continue
		}
		if !claimed {
			continue // 已续期 / 已被别的路径处理 / 标记仍在租约内
		}
		// gen 是本次认领拿到的**世代号**（fencing token，R4-C-1）：删除权与它绑定，
		// 之后每一次"是否还能删"的判断都必须带上它。
		gen := snap.ReapGeneration
		if fn := reapRecheckHook.load(); fn != nil {
			fn(id) // 测试注入点：模拟"认领与复检之间"发生的并发上传
		}
		// 认领 = 打标记 + 世代 +1（行保留）。真正删上游对象之前必须复检**删除权是否
		// 仍归本次认领**：世代未变、标记仍在**且仍在租约内**（R4-C-1）。租约内上个
		// 传者的重新登记会被登记路径直接拒绝（ErrGatewayFileReapClaimed），所以这条
		// 复检在正常情况下恒真；它挡的是"认领已过期/已被重新认领"的失效世代。
		if held, err := serverstore.GatewayFileReapClaimHeld(a.DB, id, gen); err != nil {
			log.Printf("gateway: file reaper: recheck reap claim failed (id=%s gen=%d): %v", id, gen, err)
			failed++
			continue
		} else if !held {
			log.Printf("gateway: file reaper: file %s gen=%d: reap claim no longer held (re-registered, re-claimed or lease expired); upstream object kept", id, gen)
			continue
		}
		if err := deleteUpstreamFile(client, up, id); err != nil {
			log.Printf("gateway: file reaper: delete upstream file failed (id=%s gen=%d): %v", id, gen, err)
			// 释放标记让下一轮立刻重试（不必等租约过期）；行保留 = 清理责任不丢。
			if rerr := serverstore.ReleaseReapClaim(a.DB, id); rerr != nil {
				log.Printf("gateway: file reaper: release reap claim failed (id=%s gen=%d): %v", id, gen, rerr)
			}
			failed++
			continue
		}
		// 收尾：删掉仍带**本世代**标记的行。该谓词同时是 DELETE **返回之后**的第二次
		// 校验（R4-C-1 要求"DELETE 前与返回后都校验世代未变"）：世代变了就说明这一行
		// 已归新一代（被重新登记或重新认领），本世代放弃收尾 —— 行留在新一代手里，
		// 并把 file_id + 世代如实写进日志。
		finished, err := serverstore.FinishReapedGatewayFile(a.DB, id, gen)
		if err != nil {
			log.Printf("gateway: file reaper: finish reaped row failed (id=%s gen=%d): %v", id, gen, err)
			failed++
			continue
		}
		if !finished {
			log.Printf("gateway: file reaper: file %s gen=%d changed generation while the upstream delete was in flight; "+
				"upstream object deleted, ledger row left to the newer generation (abandoned reap)", id, gen)
		}
		deleted++
	}
	if deleted > 0 || failed > 0 {
		log.Printf("gateway: file reaper: %d expired file(s) reclaimed, %d failed (batch=%d)", deleted, failed, len(ids))
	}
	return deleted, failed
}

// reapHookBox 是测试注入点的无锁存储。
//
// 回收器跑在常驻 goroutine 里（StartFileReaper），而测试会从**另一个** goroutine
// 设置/清除钩子 —— 裸包级 var 在 `go test -race` 下就是 DATA RACE（生产者/消费者之间
// 没有任何同步边）。用 atomic.Pointer 存函数值：生产恒为空（store 只在测试里调用），
// 语义与裸 var 逐字相同（nil = 未注入）。判据见 files_reaper_test.go 的
// TestFilesReaperHooksAreRaceFree（用 -race 复跑）。
type reapHookBox[T any] struct{ p atomic.Pointer[T] }

func (b *reapHookBox[T]) store(fn T) { b.p.Store(&fn) }

func (b *reapHookBox[T]) load() T {
	if f := b.p.Load(); f != nil {
		return *f
	}
	var zero T
	return zero
}

// reapAfterListHook 只在测试里注入：在"列出候选"与"逐行认领"之间插一步，
// 用来确定性地复现"列表之后被续期"（认领时的过期复检就是为这个窗口存在的）。
var reapAfterListHook reapHookBox[func(ids []string)]

// reapRecheckHook 只在测试里注入：在"认领成功"与"复检是否被重新登记"之间插一步，
// 用来确定性地复现并发上传（生产恒为空）。
var reapRecheckHook reapHookBox[func(fileID string)]

// fileDeleteTimeout 是单次上游删除的整请求预算（含读响应体）。
//
// 为什么必须有：transport 只设了 ResponseHeaderTimeout（120s），响应体没有截止时间 ——
// 上游回了头就不再发字节时，`io.Copy` 会**永久**挂住；回收器只有一条协程，一次挂死
// 等于整个自动回收停摆（过期文件继续占着上游配额）。测试可注入。
var fileDeleteTimeout = 30 * time.Second

// errUnusableReapFileID：台账行里的 id 形状非法（无法拼出合法上游 URL）。
var errUnusableReapFileID = errors.New("reaper: unusable file id shape")

// deleteUpstreamFile 删上游文件：404/410 视为成功（上游已自然过期/被删）。
func deleteUpstreamFile(client *http.Client, up Upstream, fileID string) error {
	// 形状白名单与 retrieve/delete 入口同源：台账里的 id 会被拼进上游 URL，
	// 畸形 id（点段/编码穿越）绝不能进 URL（回收器也不能成为例外）。
	if !validGatewayFileID(fileID) {
		return errUnusableReapFileID
	}
	ctx, cancel := context.WithTimeout(context.Background(), fileDeleteTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, filesURL(up.BaseURL, "/"+fileID), nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+up.APIKey)
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone {
		return nil
	}
	if resp.StatusCode >= 300 {
		return &reaperStatusError{status: resp.StatusCode}
	}
	return nil
}

type reaperStatusError struct{ status int }

func (e *reaperStatusError) Error() string {
	return "upstream delete failed with status " + http.StatusText(e.status)
}

// StartFileReaper 起一个常驻回收协程（cmd/server 在启动时调用；ctx 取消即退出）。
//
// 启动时先跑一轮：进程可能停了几天，堆积的过期文件不需要再等一个间隔。
// 只依赖 db：内部自建一个最小 API（回收只需要 DB 与出站 client）。
func StartFileReaper(ctx context.Context, db *sql.DB, interval time.Duration) {
	if db == nil {
		return
	}
	api := &API{DB: db, client: &http.Client{Transport: newUpstreamTransport()}}
	if interval <= 0 {
		interval = FileReaperInterval
	}
	go func() {
		_, _ = api.ReapExpiredGatewayFiles(0)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_, _ = api.ReapExpiredGatewayFiles(0)
			}
		}
	}()
}
