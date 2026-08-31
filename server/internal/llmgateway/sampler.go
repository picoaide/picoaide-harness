package llmgateway

import (
	"database/sql"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// concurrencySampleInterval 采样间隔(生产 15s;测试注入更短避免拖慢)。
var concurrencySampleInterval = 15 * time.Second

// startConcurrencySampler 启动后台采样 goroutine:每 15s 读一次 meter
// 快照,将各模型 in-flight 数落库到 model_concurrency_stats(GREATEST
// 累计峰值,永不回退)。DB 为 nil(测试路由树)时返回 nil,不启动。
// 返回 stop 函数供测试优雅终止(生产进程生命周期内常驻)。
func (a *API) startConcurrencySampler(stop <-chan struct{}) {
	if a.DB == nil || a.conc == nil {
		return
	}
	go func() {
		ticker := time.NewTicker(concurrencySampleInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				snap := a.conc.snapshot()
				now := time.Now()
				for model, n := range snap {
					_ = serverstore.RecordConcurrencySample(a.DB, model, n, now)
				}
			case <-stop:
				return
			}
		}
	}()
}

// concurrencyPeaksForAdmin 读取近 N 天按模型并发峰值(供 server-info)。
func concurrencyPeaksForAdmin(db *sql.DB, days int) ([]serverstore.ModelConcurrencyPeak, error) {
	since := time.Now().AddDate(0, 0, -days)
	return serverstore.ModelConcurrencyPeaks(db, since)
}
