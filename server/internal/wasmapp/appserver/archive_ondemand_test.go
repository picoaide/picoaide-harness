package appserver

import (
	"context"
	"database/sql"
	"net/http"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ===========================================================================
// P0-3：请求路径不得每请求从 PostgreSQL 拉整份制品（archive TOAST 大字段）
//
// 现场（2026-09-19 审计）：serve.go 每请求调 LatestApprovedWasmRelease，而它用
// **含 archive 的全列**查询；模块缓存命中（暖机常态）时 rel.Wasm 没有任何读者
// —— 唯一读者是冷编译。代价是单请求瞬时堆可达 `并发 × 32 MiB`（默认档 32 并发
// ≈ 1 GiB），而四笔账里没有这一笔。
//
// 本文件用 **PostgreSQL 自己的 TOAST 访问计数**做端到端判据（不是源码断言、
// 也不是"看着像"的间接证据）：bytea 超过 ~2 KB 必然进 TOAST，读取它必须访问
// TOAST 块（命中与否都计数）——所以"暖机后的请求让 toast_blks_* 一动不动"
// 就是"没有读制品字节"的直接证据。
//
// 变异验证（改回旧实现必红）：
//   - 把 serve.go 的 LatestApprovedWasmReleaseMeta 换回全列查询
//     （LatestApprovedWasmReleaseFull）⇒ TestServeWarmCacheDoesNotReadReleaseArchive 红；
//   - 把 loadReleaseWasm 的按需加载挪到请求路径（每请求取字节）⇒ 同一条红。
// ---------------------------------------------------------------------------

// toastStats 读 app_releases 的 TOAST 访问计数（命中 + 物理读）。
//
// 为什么这是可靠判据：PG 的 pg_statio_user_tables.toast_blks_{hit,read} 记的是
// "这张表的 TOAST 表被访问的块数"，命中数同样计数 —— 只要真的读了 archive 就会涨，
// 与 shared_buffers 是否缓存无关。
type toastStat struct{ hit, read int64 }

// queryToastStats 读 pg_statio_user_tables 里 app_releases 那一行的 TOAST 计数。
func queryToastStats(t *testing.T, db *sql.DB) toastStat {
	t.Helper()
	// 统计刷盘有毫秒级延迟 ⇒ 读之前尽力催一次（PG 15+ 有该函数；更老的版本忽略错误）。
	_, _ = db.ExecContext(context.Background(), `SELECT pg_stat_force_next_flush()`)
	var s toastStat
	if err := db.QueryRowContext(context.Background(), `
		SELECT COALESCE(SUM(toast_blks_hit), 0), COALESCE(SUM(toast_blks_read), 0)
		FROM pg_statio_user_tables
		WHERE schemaname = 'public' AND relname = 'app_releases'`).Scan(&s.hit, &s.read); err != nil {
		t.Fatalf("读 TOAST 统计失败: %v", err)
	}
	return s
}

func (e *env) toastStats() toastStat {
	e.t.Helper()
	return queryToastStats(e.t, e.db)
}

func TestServeWarmCacheDoesNotReadReleaseArchive(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("toast")
	e.publishApp(appSpec{appID: appID})

	// ---- 暖机：首个请求必须冷编译（这一次读 archive 是**必要**的）----
	if rec := e.get(appID, "/"); rec.Code != http.StatusOK {
		t.Fatalf("暖机请求失败: %d body=%s", rec.Code, rec.Body.String())
	}
	if got := e.srv.CachedModuleCount(); got != 1 {
		t.Fatalf("暖机后模块缓存条目 = %d, want 1（否则后面的断言测的不是暖机路径）", got)
	}

	// ---- 暖机后的请求：不得再碰 TOAST ----
	before := e.toastStats()
	for i := 0; i < 3; i++ {
		if rec := e.get(appID, "/"); rec.Code != http.StatusOK {
			t.Fatalf("第 %d 次暖机请求失败: %d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
	after := e.toastStats()
	if after != before {
		t.Fatalf("模块缓存命中时不得再读制品字节（P0-3）：TOAST 访问 %+v → %+v（差 %d 命中 / %d 读）",
			before, after, after.hit-before.hit, after.read-before.read)
	}

	// ---- 正对照：直接读一次 archive 必须让计数器动 ----
	// 没有这一段，上面的"零增量"可能只是"统计没开"的假绿。
	//
	// （冷编译路径本来就会读一次：这也是本用例把测量窗口放在暖机之后的原因。）
	// ⚠️ 正对照必须**真的把字节取回来**（`SELECT archive`），不能用 octet_length：
	// 未压缩的 out-of-line 值，PG 直接从 TOAST 指针里读出长度，**不访问 TOAST 块**
	//（实测：octet_length 版本的正对照完全不涨，本用例第一版就栽在这里）。
	control := func() toastStat {
		var got []byte
		if err := e.db.QueryRowContext(context.Background(),
			`SELECT archive FROM app_releases WHERE kind = $1 AND app_id = $2`,
			serverstore.AppKindWasmApp, appID).Scan(&got); err != nil {
			t.Fatalf("正对照读取 archive 失败: %v", err)
		}
		if len(got) == 0 {
			t.Fatalf("正对照读到的制品为空，夹具失效")
		}
		return e.toastStats()
	}
	// 用包内既有的 waitFor（带超时 + 失败即 Fatal）。这里的条件本身会打印诊断，
	// 因此条件里**不**判定"是否变化"，只驱动轮询；判定在下面单独做。
	controlSeeingChange := false
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if control() != after {
			controlSeeingChange = true
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !controlSeeingChange {
		t.Fatalf("正对照没有让 TOAST 计数变化（%+v）：本环境的统计不可用，"+
			"上面的零增量断言没有意义（检查 track_counts / pg_statio_user_tables）", after)
	}
}

// TestLatestApprovedWasmReleaseMetaIsByteFree：服务层契约 —— 请求路径用的元数据
// 查询**不含** archive；需要字节时由 GetWasmRelease 按需取（冷编译路径）。
func TestLatestApprovedWasmReleaseMetaIsByteFree(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("meta")
	rel := e.publishApp(appSpec{appID: appID})
	if len(rel.Wasm) == 0 {
		t.Fatal("夹具失效：publishApp 返回的版本行应带制品字节")
	}
	ctx := context.Background()

	meta, err := serverstore.LatestApprovedWasmReleaseMeta(ctx, e.db, appID)
	if err != nil {
		t.Fatalf("LatestApprovedWasmReleaseMeta: %v", err)
	}
	if len(meta.Wasm) != 0 {
		t.Fatalf("请求路径的元数据查询不应携带制品字节，得到 %d 字节", len(meta.Wasm))
	}
	// 请求路径真正需要的字段一个都不能少（少了下一步就会 500）。
	if meta.ID != rel.ID || meta.Version != rel.Version || meta.Status != serverstore.ReleaseStatusApproved {
		t.Fatalf("元数据字段不完整: %+v", meta)
	}
	if meta.ConfigJSON != rel.ConfigJSON || meta.AssetsDir != rel.AssetsDir {
		t.Fatalf("元数据缺少 config_json/assets_dir（资源目录与准入判定要用）: %+v", meta)
	}
	if meta.Size != rel.Size || meta.Checksum != rel.Checksum {
		t.Fatalf("元数据缺少 size/checksum: %+v", meta)
	}
	// 冷编译路径按需取字节：同一版本仍能取到完整内容。
	full, err := serverstore.GetWasmRelease(ctx, e.db, appID, rel.Version)
	if err != nil {
		t.Fatalf("GetWasmRelease: %v", err)
	}
	if len(full.Wasm) != len(rel.Wasm) {
		t.Fatalf("按需加载的字节长度 = %d, want %d", len(full.Wasm), len(rel.Wasm))
	}
}
