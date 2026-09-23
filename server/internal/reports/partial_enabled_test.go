package reports

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// A-11（2026-09-23 R3-A 审计，P2）：**部分更新省略 `enabled` = 保持现值**。
//
// 修复前 `update` 把"body 没有 enabled"回落成 `true` ⇒ 一次只想改名字的更新会把
// **已停用**的月报订阅静默复活，而它在下一个整点就会被调度器真的推送出去。
//
// 判据三条：
//
//	① 省略 ⇒ 保持停用（不复活）；
//	② 显式给值 ⇒ 以 body 为准（PATCH 语义不是"永远忽略 enabled"）；
//	③ 不存在的 id 仍是 404（先读现值不得把 404 吞掉）。
func TestUpdateKeepsEnabledWhenOmitted(t *testing.T) {
	r, db, sess, csrf := newReportTestRouter(t)

	// 建订阅（显式启用）→ 再显式停用。
	w := reqJSON(t, r, "POST", "/api/server/admin/report-subscriptions",
		`{"name":"月报","hook_url":"https://example.com/hook","enabled":true}`, sess, csrf)
	if w.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", w.Code, w.Body.String())
	}
	var created struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatalf("解析 create 响应失败: %v", err)
	}
	path := "/api/server/admin/report-subscriptions/" + strconv.FormatInt(created.ID, 10)
	if w := reqJSON(t, r, "PUT", path, `{"name":"月报","enabled":false}`, sess, csrf); w.Code != http.StatusOK {
		t.Fatalf("disable = %d %s", w.Code, w.Body.String())
	}
	if got := subscriptionEnabled(t, db, created.ID); got {
		t.Fatal("显式 enabled=false 未生效")
	}

	// ① 只改名字（**不带 enabled**）⇒ 必须仍是停用。
	if w := reqJSON(t, r, "PUT", path, `{"name":"月报（改名）"}`, sess, csrf); w.Code != http.StatusOK {
		t.Fatalf("patch = %d %s", w.Code, w.Body.String())
	}
	if got := subscriptionEnabled(t, db, created.ID); got {
		t.Fatal("省略 enabled 把已停用的订阅静默复活了（A-11）")
	}

	// ② 反向：显式 enabled=true 仍然生效。
	if w := reqJSON(t, r, "PUT", path, `{"name":"月报（改名）","enabled":true}`, sess, csrf); w.Code != http.StatusOK {
		t.Fatalf("re-enable = %d %s", w.Code, w.Body.String())
	}
	if got := subscriptionEnabled(t, db, created.ID); !got {
		t.Fatal("显式 enabled=true 必须生效")
	}

	// ③ 反向：不存在的 id ⇒ 404（不是 500，也不是静默成功）。
	if w := reqJSON(t, r, "PUT", "/api/server/admin/report-subscriptions/999999",
		`{"name":"幽灵"}`, sess, csrf); w.Code != http.StatusNotFound {
		t.Fatalf("更新不存在的订阅 = %d, want 404（%s）", w.Code, w.Body.String())
	}
}

// subscriptionEnabled 读一条订阅当前的启用状态（列表里找，与 handler 的兜底同源）。
func subscriptionEnabled(t *testing.T, db *sql.DB, id int64) bool {
	t.Helper()
	subs, err := serverstore.ListReportSubscriptions(db)
	if err != nil {
		t.Fatalf("读订阅失败: %v", err)
	}
	for _, s := range subs {
		if s.ID == id {
			return s.Enabled
		}
	}
	t.Fatalf("订阅 %d 不存在", id)
	return false
}
