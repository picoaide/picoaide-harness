package capabilities

// R6-D P2-2 的**判据缺口**（复审 V1 §7.4 / §10-8，P2；基线 0a46570b7b）。
//
// 市场作者面（`source=own` 里的市场渠道行）有两道判据：
//
//	① 前置闸门 `marketOwnedBy(dists, viewer)` —— "这个调用者是否拥有该 kind 的
//	   **任意**一个应用行"，只为省掉 O(市场应用数) 的取数；
//	② 逐行 `dist.OwnedBy(viewer)` —— 真正的归属过滤，决定哪一行进结果。
//
// 既有用例（`r6d_market_author_face_test.go`）里，所有**非归属人**夹具都拥有
// **0 个**应用 ⇒ ①对它们短路，②一行都没执行过。后果（复审探针实测）：把
// `!dist.OwnedBy(u.Username) ||` 从逐行判据里删掉，整套 R6-D 用例**全绿**，
// 而真实的调用者会看到别人的市场行并带 `is_owner=true`（本例断言的就是它）。
//
// 本文件补的就是这个缺口：让**两个用户各自拥有一个同 kind 的市场应用**，于是
// 双方都过得了闸门①，逐行判据②必须真的把对方的行挡在外面。
//
// 变异验证（必须让本文件红）：删掉 2b/3b 分支逐行判据里的 `!dist.OwnedBy(...)`
// —— 两个夹具用户都拥有同 kind 应用 ⇒ 闸门放行 ⇒ 对方的行会带着 is_owner=true
// 出现在自己的「我的」里。

import (
	"encoding/json"
	"net/http"
	"reflect"
	"sort"
	"testing"

	"github.com/gin-gonic/gin"
)

// r6dOwnRows 返回 source=own 分区的**全部**条目（不用名字过滤：判据是"这个
// 分区里到底有谁"，漏进来的行必须是显式失败而不是被名字过滤掩盖）。
func r6dOwnRows(t *testing.T, r *gin.Engine, hdr map[string]string) []r6dItem {
	t.Helper()
	w := doGet(t, r, "/api/client/v2/capabilities?source=own", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("capabilities(source=own) = %d %s", w.Code, w.Body.String())
	}
	var body struct {
		Items []r6dItem `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body.Items
}

// r6dOwnSummary 把「我的」分区渲染成可比较的 "name:is_owner=…" 升序切片。
func r6dOwnSummary(t *testing.T, r *gin.Engine, hdr map[string]string) []string {
	t.Helper()
	out := []string{}
	for _, it := range r6dOwnRows(t, r, hdr) {
		flag := "is_owner=false"
		if it.IsOwner {
			flag = "is_owner=true"
		}
		out = append(out, it.Name+":"+flag)
	}
	sort.Strings(out)
	return out
}

// TestMarketOwnFaceFiltersEveryRowNotEveryCaller：两个同 kind 的市场应用归属两个
// 不同员工 ⇒ 逐行归属判据必须各自只放行自己那一行。
//
// 夹具刻意让 alice **被授权**访问 bob 的行（分发面她看得到）—— 这样"自己的
// 「我的」里没有别人的行"就不是"那行根本不存在"造成的假绿。
func TestMarketOwnFaceFiltersEveryRowNotEveryCaller(t *testing.T) {
	r, db, _, userTokens := setupRouter(t)
	defer db.Close()
	alice := map[string]string{"Authorization": "Bearer " + userTokens["alice"]}
	bob := map[string]string{"Authorization": "Bearer " + userTokens["bob"]}

	// 两个用户**各自拥有**一个同 kind 的市场应用（技能与智能体各一对）。
	// bob 的两行都授权给 alice：分发面可见 ⇒ 「我的」里的缺席只能由逐行归属判据解释。
	seedR6DMarketSkill(t, db, "r6d2-alice-skill", "alice", "alice")
	seedR6DMarketSkill(t, db, "r6d2-bob-skill", "bob", "alice")
	seedR6DMarketAgent(t, db, "r6d2-alice-agent", "alice", "alice")
	seedR6DMarketAgent(t, db, "r6d2-bob-agent", "bob", "alice")

	// 夹具有效性：闸门①对**双方**都必须放行（各自拥有同 kind 应用），且 bob 的行
	// 在 alice 的分发面里真实可见 —— 否则"我的里没有别人的行"是假绿。
	for _, name := range []string{"r6d2-bob-skill", "r6d2-bob-agent"} {
		if rows := r6dRows(t, r, alice, "market", name); len(rows) != 1 {
			t.Fatalf("夹具无效：alice 应当能在市场面看到被授权的 %s（实得 %d 行）", name, len(rows))
		}
	}

	for _, tc := range []struct {
		who   string
		hdr   map[string]string
		want  []string
		other []string
	}{
		{
			who:   "alice",
			hdr:   alice,
			want:  []string{"r6d2-alice-agent:is_owner=true", "r6d2-alice-skill:is_owner=true"},
			other: []string{"r6d2-bob-agent", "r6d2-bob-skill"},
		},
		{
			who:   "bob",
			hdr:   bob,
			want:  []string{"r6d2-bob-agent:is_owner=true", "r6d2-bob-skill:is_owner=true"},
			other: []string{"r6d2-alice-agent", "r6d2-alice-skill"},
		},
	} {
		got := r6dOwnSummary(t, r, tc.hdr)
		if !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("%s 的「我的」分区应恰好是自己的两行（且 is_owner=true）：got %v want %v\n"+
				"（前置闸门 marketOwnedBy 只决定「要不要取数」；真正的过滤是逐行 dist.OwnedBy —— "+
				"删掉它会让别人的市场行带着 is_owner=true 进来）", tc.who, got, tc.want)
		}
		for _, other := range tc.other {
			for _, row := range r6dOwnRows(t, r, tc.hdr) {
				if row.Name == other {
					t.Fatalf("%s 的「我的」里出现了 %s 的行（is_owner=%v）：逐行归属判据没有执行（R6-D P2-2 判据缺口）",
						tc.who, other, row.IsOwner)
				}
			}
		}
	}
}
