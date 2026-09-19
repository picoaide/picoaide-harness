package llmgateway

// 审计 2026-09-19(P2-3):后台同步链路必须看得见 provider 级错误。
//
// 缺陷形态(上一提交引入的可见性缺口,已实测复现):SyncProvider 的 fail-closed
// ("读取模型排除名单失败(已跳过本轮同步)")只进 SyncResult.Error,而 SyncLoop
// 只看 SyncIteration 的**顶层** error ⇒ 名单持久损坏时该 provider 静默停更,
// 只有管理员手点同步才看得见(把"静默复活"换成了"静默停更")。
//
// 修法:SyncLoop 的每一跳改为调用 syncIterationLogged —— 顶层 error 的日志
// ("gateway sync: %v")逐字保留,并逐 provider 补一条失败日志。抽成独立函数
// 是为了可测:用例直接调用它并捕获真实 log 输出,不必起 goroutine + sleep
// (那种写法慢,而且会把 SyncLoop 永久跑在测试进程里)。
//
// 判据:fail-closed 的错误真的进日志(带 provider 名与错误原文);每跳每
// provider 至多一行(不刷屏);Skipped(设计内状态)不打失败行;返回语义不变。

import (
	"bytes"
	"database/sql"
	"log"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// audit0919Catalog 是渠道同步用的固定目录(2 个模型)。
func audit0919Catalog(string) ([]byte, error) {
	return []byte(`{"data":[{"id":"deepseek-chat"},{"id":"deepseek-reasoner"}]}`), nil
}

// audit0919CaptureLog 捕获 fn 期间标准 logger 的输出(真实 logger,不是接口桩:
// 断言的就是"运维在 stderr/journal 里能看到什么")。
func audit0919CaptureLog(t *testing.T, fn func()) string {
	t.Helper()
	var buf bytes.Buffer
	prevOut := log.Writer()
	prevFlags := log.Flags()
	log.SetOutput(&buf)
	defer func() {
		log.SetOutput(prevOut)
		log.SetFlags(prevFlags)
	}()
	fn()
	return buf.String()
}

// audit0919ChannelProviderWithBrokenExcludedList 建一个渠道型上游,删掉一个模型
// (进排除名单),再把名单写成坏 JSON ⇒ 下一跳 SyncProvider fail-closed。
// 返回 (providerID, 排除名单 settings 键)。
func audit0919ChannelProviderWithBrokenExcludedList(t *testing.T, r http.Handler, db *sql.DB, hdr map[string]string) (int64, string) {
	t.Helper()
	if w, _ := adminReq(t, r, "POST", "/api/server/admin/providers",
		`{"name":"deepseek","api_key":"sk","channel":"deepseek"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create channel provider: %d %s", w.Code, w.Body.String())
	}
	var providerID, chatModelID int64
	if err := db.QueryRow(`SELECT id FROM gateway_providers WHERE name = 'deepseek'`).Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT id FROM models WHERE name = 'deepseek-chat'`).Scan(&chatModelID); err != nil {
		t.Fatal(err)
	}
	if w, _ := adminReq(t, r, "DELETE", "/api/server/admin/models/"+strconv.FormatInt(chatModelID, 10), "", hdr); w.Code != http.StatusOK {
		t.Fatalf("delete channel model: %d", w.Code)
	}
	key := "gateway.excluded_models." + strconv.FormatInt(providerID, 10)
	if _, err := db.Exec(`UPDATE settings SET value = '{not-json' WHERE key = ?`, key); err != nil {
		t.Fatal(err)
	}
	serverstore.InvalidateSettings()
	return providerID, key
}

// TestSyncIterationLogsProviderFailClosedError:fail-closed 的错误必须进日志,
// 且每跳每 provider 至多一行。
func TestSyncIterationLogsProviderFailClosedError(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()
	_, key := audit0919ChannelProviderWithBrokenExcludedList(t, r, db, hdr)

	out := audit0919CaptureLog(t, func() { syncIterationLogged(db, audit0919Catalog) })
	if !strings.Contains(out, "gateway sync: provider deepseek 同步失败") {
		t.Fatalf("P2-3 未修:provider 级错误没有进日志, log=%q", out)
	}
	if !strings.Contains(out, "排除名单") {
		t.Fatalf("失败日志没带错误原文, log=%q", out)
	}
	// 每跳每 provider 一行(不随模型条数放大,不刷屏)。
	if n := strings.Count(out, "同步失败"); n != 1 {
		t.Fatalf("一跳打了 %d 条失败日志, want 1: %q", n, out)
	}
	out2 := audit0919CaptureLog(t, func() { syncIterationLogged(db, audit0919Catalog) })
	if n := strings.Count(out+out2, "同步失败"); n != 2 {
		t.Fatalf("两跳共 %d 条失败日志, want 2(每跳一行): %q", n, out2)
	}

	// 返回语义不变:错误仍在 SyncResult 里(SyncLoop 只是多打一行日志)。
	results, err := SyncOnce(db, audit0919Catalog)
	if err != nil {
		t.Fatalf("SyncOnce 顶层 error = %v, want nil(单 provider 失败不影响整轮)", err)
	}
	if len(results) != 1 || results[0].Skipped || results[0].Error == "" {
		t.Fatalf("SyncResult 语义被改: %+v", results)
	}

	// 负向对照:名单恢复可读后同一跳不再打失败行。
	if _, err := db.Exec(`UPDATE settings SET value = ? WHERE key = ?`, `["deepseek-chat"]`, key); err != nil {
		t.Fatal(err)
	}
	serverstore.InvalidateSettings()
	out3 := audit0919CaptureLog(t, func() { syncIterationLogged(db, audit0919Catalog) })
	if strings.Contains(out3, "同步失败") {
		t.Fatalf("名单可读时不应打失败行, log=%q", out3)
	}
}

// TestSyncIterationDoesNotLogSkippedManualProvider:手动型上游的 Error 是
// 设计内说明(Skipped=true),不是失败 ⇒ 不打失败行,否则每个手动上游每小时
// 刷一行噪音;但返回语义(说明仍在结果里)不变。
func TestSyncIterationDoesNotLogSkippedManualProvider(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()
	if w, _ := adminReq(t, r, "POST", "/api/server/admin/providers",
		`{"name":"manual","base_url":"https://upstream.example.com","api_key":"sk","models":["m1"]}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create manual provider: %d %s", w.Code, w.Body.String())
	}

	out := audit0919CaptureLog(t, func() { syncIterationLogged(db, audit0919Catalog) })
	if strings.Contains(out, "同步失败") {
		t.Fatalf("Skipped 被当成失败打日志: %q", out)
	}

	results, err := SyncOnce(db, audit0919Catalog)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, res := range results {
		if res.Provider == "manual" && res.Skipped && res.Error != "" {
			found = true
		}
	}
	if !found {
		t.Fatalf("手动型上游的 Skipped 说明丢了(返回语义被改): %+v", results)
	}
}

// TestSyncIterationTopLevelErrorStillLogged:SyncIteration 顶层 error 的日志
// 逐字保留 —— 补逐 provider 日志不得取代它。
func TestSyncIterationTopLevelErrorStillLogged(t *testing.T) {
	_, db, _ := adminTestSetup(t)
	defer db.Close()

	if _, err := db.Exec(`ALTER TABLE gateway_providers RENAME TO audit0919_gp_bak`); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := db.Exec(`ALTER TABLE audit0919_gp_bak RENAME TO gateway_providers`); err != nil {
			t.Errorf("restore gateway_providers: %v", err)
		}
	}()

	out := audit0919CaptureLog(t, func() { syncIterationLogged(db, audit0919Catalog) })
	if !strings.Contains(out, "gateway sync: ") || !strings.Contains(out, "gateway_providers") {
		t.Fatalf("顶层 error 日志丢失或改文案, log=%q", out)
	}
	if strings.Contains(out, "同步失败") {
		t.Fatalf("顶层失败时不应打 provider 失败行(results 为 nil): %q", out)
	}
}
