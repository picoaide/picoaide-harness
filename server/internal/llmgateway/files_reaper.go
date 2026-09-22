package llmgateway

import (
	"context"
	"database/sql"
	"io"
	"log"
	"net/http"
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
//   - 只删台账里**已过期**的行（`expires_at <= now()`），也就是网关已经拒绝授权的那些；
//   - 上游删除用服务端持有的 key，best-effort：404（上游自己过期了）算成功，其它
//     失败只记日志、**保留行**下轮重试（不删行 = 不会漏掉这个文件的清理责任）；
//   - 每轮批量有上限（默认 500），避免一次扫太多把上游打爆。

// FileReaperInterval 是回收器默认扫描间隔。5 分钟：上限到点后最多多占 5 分钟配额，
// 对 25 GiB / 10000 文件的量级足够；调大只会让"已过期但仍占配额"的窗口变长。
const FileReaperInterval = 5 * time.Minute

// ReapExpiredGatewayFiles 执行一轮回收：删上游 + 删台账行，返回 (成功, 失败) 计数。
//
// 失败时**保留台账行**，下一轮继续尝试 —— 行是"还有清理责任"的唯一凭据。
func (a *API) ReapExpiredGatewayFiles(limit int) (deleted, failed int) {
	if a == nil || a.DB == nil {
		return 0, 0
	}
	ids, err := serverstore.ListExpiredGatewayFiles(a.DB, limit)
	if err != nil {
		log.Printf("gateway: file reaper: list expired rows failed: %v", err)
		return 0, 0
	}
	if len(ids) == 0 {
		return 0, 0
	}
	up, ok := fileUpstream(a.DB)
	if !ok {
		log.Printf("gateway: file reaper: no usable files upstream; %d expired file(s) left for the next round", len(ids))
		return 0, len(ids)
	}
	client := a.filesHTTPClient()
	for _, id := range ids {
		if err := deleteUpstreamFile(client, up, id); err != nil {
			log.Printf("gateway: file reaper: delete upstream file failed: %v", err)
			failed++
			continue
		}
		if err := serverstore.DeleteGatewayFileRow(a.DB, id); err != nil {
			log.Printf("gateway: file reaper: delete ledger row failed: %v", err)
			failed++
			continue
		}
		deleted++
	}
	if deleted > 0 || failed > 0 {
		log.Printf("gateway: file reaper: %d expired file(s) reclaimed, %d failed (batch=%d)", deleted, failed, len(ids))
	}
	return deleted, failed
}

// deleteUpstreamFile 删上游文件：404 视为成功（上游已自然过期/被删）。
func deleteUpstreamFile(client *http.Client, up Upstream, fileID string) error {
	req, err := http.NewRequest(http.MethodDelete, filesURL(up.BaseURL, "/"+fileID), nil)
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
