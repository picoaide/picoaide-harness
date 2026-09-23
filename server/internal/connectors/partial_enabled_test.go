package connectors

import (
	"net/http"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// A-11（2026-09-23 R3-A 审计，P2）：**部分更新省略 `enabled` = 保持现值**。
//
// 修复前 `bindConnector` 把"body 没有 enabled"回落成 `true` ⇒ 一次只想改名字/描述的
// 更新会把**已停用**的连接器静默复活；而连接器一旦 enabled 就会随 bootstrap 下发给
// 全体客户端（停用是运维的紧急刹车，不能靠"记得带 enabled:false"来维持）。
//
// 判据三条：
//
//	① 省略 ⇒ 保持现值（停用状态不被复活）；
//	② 显式给值 ⇒ 以 body 为准（反向用例：PATCH 语义不是"忽略 enabled"）；
//	③ 创建路径不受影响（新对象缺省仍是启用）。
func TestUpdateKeepsEnabledWhenOmitted(t *testing.T) {
	r, db, hdr := setup(t)

	def := `{\"tokenFields\":[{\"key\":\"TOKEN\",\"label\":\"Token\",\"type\":\"password\",\"required\":true}],` +
		`\"mcp\":[{\"serverName\":\"patchy\",\"transport\":\"streamable-http\",\"url\":\"https://mcp.example.com\"}]}`

	// 建一个启用的连接器，再用显式 enabled=false 停用它。
	w, _ := doJSON(t, r, "POST", "/api/server/admin/connectors",
		`{"id":"patchy","name":"可停用","description":"初始","auth_mode":"token","definition":"`+def+`","enabled":true}`, hdr)
	if w.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", w.Code, w.Body.String())
	}
	w, out := doJSON(t, r, "PUT", "/api/server/admin/connectors/patchy",
		`{"name":"可停用","description":"停用","auth_mode":"token","definition":"`+def+`","enabled":false}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("disable = %d %s", w.Code, w.Body.String())
	}
	if out["connector"].(map[string]any)["enabled"] != false {
		t.Fatalf("显式 enabled=false 未生效：%v", out["connector"])
	}

	// ① 只改描述、**不带 enabled** ⇒ 必须仍是停用（修复前这里会变 true）。
	w, out = doJSON(t, r, "PUT", "/api/server/admin/connectors/patchy",
		`{"name":"可停用","description":"只改描述","auth_mode":"token","definition":"`+def+`"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("patch = %d %s", w.Code, w.Body.String())
	}
	if got := out["connector"].(map[string]any)["enabled"]; got != false {
		t.Fatalf("省略 enabled 必须保持停用，实得 enabled=%v（静默复活）", got)
	}
	conn, err := serverstore.GetConnector(db, "patchy")
	if err != nil {
		t.Fatalf("读回失败: %v", err)
	}
	if conn.Enabled {
		t.Fatal("库里仍是启用：省略 enabled 被当成了 true")
	}

	// 反向：显式 enabled=true 仍然生效（不是把该字段忽略掉）。
	w, out = doJSON(t, r, "PUT", "/api/server/admin/connectors/patchy",
		`{"name":"可停用","description":"重新启用","auth_mode":"token","definition":"`+def+`","enabled":true}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("re-enable = %d %s", w.Code, w.Body.String())
	}
	if got := out["connector"].(map[string]any)["enabled"]; got != true {
		t.Fatalf("显式 enabled=true 必须生效，实得 %v", got)
	}
	// 反向：更新不存在的 id 仍是 404（先读现值不得把 404 吞掉）。
	w, _ = doJSON(t, r, "PUT", "/api/server/admin/connectors/nope-connector",
		`{"name":"X","auth_mode":"token","definition":"`+def+`"}`, hdr)
	if w.Code != http.StatusNotFound {
		t.Fatalf("更新不存在的连接器 = %d, want 404（%s）", w.Code, w.Body.String())
	}
	// 反向：创建路径省略 enabled 仍是启用（新对象缺省语义不变）。
	w, out = doJSON(t, r, "POST", "/api/server/admin/connectors",
		`{"id":"fresh-one","name":"新对象","auth_mode":"token","definition":"`+def+`"}`, hdr)
	if w.Code != http.StatusCreated {
		t.Fatalf("create default = %d %s", w.Code, w.Body.String())
	}
	if got := out["connector"].(map[string]any)["enabled"]; got != true {
		t.Fatalf("创建省略 enabled 应为启用，实得 %v", got)
	}
}
