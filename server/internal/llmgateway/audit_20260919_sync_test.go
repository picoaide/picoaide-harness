package llmgateway

// 审计 2026-09-19:同步路径的两处"读取失败静默降级"。
//
// ⑤ 排除名单 fail-open(真缺口):`GetExcludedModels` 读失败时 `excluded = nil`
// ⇒ 名单变空 ⇒ 本轮同步把管理员删掉的渠道同步模型**重新建回来**,绕过 H2。
// 排除名单是 H2("管理员删过的渠道同步模型不得被自动复活")的**唯一载体**;
// 同文件上文对"空模型列表"反而很谨慎(`len(models)==0` 直接 return,不当成
// "全部下架"),两种"空"的处理方向相反 ⇒ 这处是漏的。
//
// 修法:读失败时 fail-closed —— 跳过该 provider 并在结果里报错(不静默清空
// 名单、也不改其余 provider 的行为)。
//
// 计数基线 `syncedModelNames` 失败时同样静默退化成空集合,但它只影响 Added
// 计数(报成全量新增),**不改库**;收紧它会让"同步"因一次统计读失败而整体
// 失败,代价大于收益 ⇒ 判定"计数偏差可接受",只补日志(见 sync.go)。
//
// ⑥ httpFetch15s 的 ctx 必须**按调用**创建。
// 缺陷形态:ctx/cancel 建在闭包外、cancel 在闭包内 defer ⇒ 同一闭包第二次
// 调用拿到已取消的 ctx,立即以 `context canceled` 失败(看起来像上游抖动,
// 极难排查)。当前 3 个调用点都是"建一次闭包只调一次"⇒ 不可达,但这是随时会被
// 下一个重构打破的陷阱;修法(把 ctx 挪进闭包体)对现有单次调用逐字行为不变。

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// syncExcludedCatalog 是渠道同步用的固定目录(2 个模型)。
func syncExcludedCatalog(string) ([]byte, error) {
	return []byte(`{"data":[{"id":"deepseek-chat"},{"id":"deepseek-reasoner"}]}`), nil
}

// TestSyncProviderExcludedListFailClosed:排除名单读不出来时必须跳过同步
// (不得当成"名单为空"把删掉的模型复活)。
func TestSyncProviderExcludedListFailClosed(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	// 渠道型上游:创建即同步 2 个模型。
	if w, _ := adminReq(t, r, "POST", "/api/server/admin/providers",
		`{"name":"deepseek","api_key":"sk","channel":"deepseek"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("create channel provider: %d", w.Code)
	}
	models := func() []string {
		t.Helper()
		rows, err := db.Query(`SELECT name FROM models ORDER BY name`)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []string
		for rows.Next() {
			var n string
			if err := rows.Scan(&n); err != nil {
				t.Fatal(err)
			}
			out = append(out, n)
		}
		return out
	}
	if got := models(); len(got) != 2 {
		t.Fatalf("models after channel sync = %v, want 2", got)
	}
	var providerID, chatModelID int64
	if err := db.QueryRow(`SELECT id FROM gateway_providers WHERE name = 'deepseek'`).Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT id FROM models WHERE name = 'deepseek-chat'`).Scan(&chatModelID); err != nil {
		t.Fatal(err)
	}
	// 管理端删除 deepseek-chat ⇒ 进排除名单(H2)。
	if w, _ := adminReq(t, r, "DELETE", "/api/server/admin/models/"+strconv.FormatInt(chatModelID, 10), "", hdr); w.Code != http.StatusOK {
		t.Fatalf("delete channel model: %d", w.Code)
	}
	excludedKey := "gateway.excluded_models." + strconv.FormatInt(providerID, 10)
	var excludedRaw string
	if err := db.QueryRow(`SELECT value FROM settings WHERE key = ?`, excludedKey).Scan(&excludedRaw); err != nil {
		t.Fatalf("排除名单未写入(前置条件不成立): %v", err)
	}
	if !strings.Contains(excludedRaw, "deepseek-chat") {
		t.Fatalf("排除名单内容异常: %q", excludedRaw)
	}

	// 破坏排除名单(读得出来但解析不了 —— 与"settings 行损坏"同一触发面),
	// 然后清掉 settings 缓存让下一轮真的去读。
	if _, err := db.Exec(`UPDATE settings SET value = ? WHERE key = ?`, "{not-json", excludedKey); err != nil {
		t.Fatal(err)
	}
	serverstore.InvalidateSettings()

	results, err := SyncOnce(db, syncExcludedCatalog)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 {
		t.Fatalf("results = %+v, want 1", results)
	}
	if results[0].Error == "" {
		t.Fatalf("排除名单读失败必须报错跳过(fail-closed), got %+v", results[0])
	}
	if got := models(); len(got) != 1 || got[0] != "deepseek-reasoner" {
		t.Fatalf("被删模型被复活(排除名单 fail-open): models = %v, want [deepseek-reasoner]", got)
	}

	// 名单恢复可读后:同步照常进行,且仍不复活被删模型(H2 本身不退化)。
	if _, err := db.Exec(`UPDATE settings SET value = ? WHERE key = ?`, `["deepseek-chat"]`, excludedKey); err != nil {
		t.Fatal(err)
	}
	serverstore.InvalidateSettings()
	results, err = SyncOnce(db, syncExcludedCatalog)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Error != "" {
		t.Fatalf("名单可读时不应报错: %+v", results)
	}
	if got := models(); len(got) != 1 || got[0] != "deepseek-reasoner" {
		t.Fatalf("H2 退化:models = %v, want [deepseek-reasoner]", got)
	}
}

// TestHTTPFetch15sCreatesContextPerCall:同一个闭包被多次调用不得复用已取消的 ctx。
func TestHTTPFetch15sCreatesContextPerCall(t *testing.T) {
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if err := r.Context().Err(); err != nil {
			t.Errorf("上游收到的请求 context 已取消: %v", err)
		}
		w.Write([]byte(`{"data":[]}`))
	}))
	defer srv.Close()

	f := httpFetch15s("k")
	for i := 1; i <= 3; i++ {
		body, err := f(srv.URL)
		if err != nil {
			t.Fatalf("第 %d 次调用失败(闭包复用了上一次已 cancel 的 ctx): %v", i, err)
		}
		if len(body) == 0 {
			t.Fatalf("第 %d 次调用返回空 body", i)
		}
	}
	if hits != 3 {
		t.Fatalf("上游命中 %d 次, want 3", hits)
	}
}
