package capabilities

// R23-V3-B10（复审 2026-09-27，**P3**）的判据：能力中心的市场智能体清单在
// "取当前发布版本"这一步**依赖故障**时**静默丢条目**。
//
// ## 缺陷形态（判据要杀的东西）
//
//	capabilities.go  if err != nil || r == nil { continue }   ← 修前
//
// `CurrentMarketReleaseFor` 的**依赖故障**（`app_releases` 读不出来 / PG 抖动）与
// "这个 App 没有已审版本"被合并成同一处置 ⇒ 该智能体**直接从清单消失**：无日志、
// 无错误，调用方拿到 200 + 少一条。员工看到「能力中心少了一项」，而它与「该项真的
// 没有已审版本」**不可区分**。
//
// 复审（W3）当时只有读代码判定（置信中）；本用例把它跑成了端到端反例：
//
//	注入：让**这一个应用**的版本行在 per-app 查询里扫描失败
//	      （`ALTER COLUMN checksum DROP NOT NULL` + 该行 checksum=NULL，
//	       并把该行 deleted_at 置上 —— 兄弟查询的 `WHERE deleted_at IS NULL`
//	       会过滤掉它，于是故障被**外科式**限定在这一条身上）
//	实测（修前）：GET /api/client/v2/capabilities?source=market ⇒
//	      200 {"items":[]}（那一条消失、零日志、零错误）
//
// ## 修后契约（两条）
//
//	① 依赖故障 ⇒ **500 INTERNAL** + 日志（不得回 200 少一条）；
//	② `r == nil`（没有已审版本）⇒ **仍是 200 且不出现** —— 这是正常状态，
//	   不是故障（判据不许把这一档也变成 500，那会把正常空态变成全站不可用）。
//
// ## 变异（必须变红）
//
//   - 把分类合回 `if err != nil || r == nil { continue }` ⇒ ①红（200 + 少一条）；
//   - 把 `r == nil` 也当故障 ⇒ ②红（没有已审版本的应用会让整表 500）；
//   - 去掉 500 分支的日志 ⇒ ①的日志断言红。

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// bobHdr 取 bob 的 Bearer 头（bob 是市场内容的**被授权人**，不是归属人 ——
// 归属人走的是另一条分支（3b 的「我的」面），那里本来就有正确的分类）。
func bobHdr(userTokens map[string]string) map[string]string {
	return map[string]string{"Authorization": "Bearer " + userTokens["bob"]}
}

// TestMarketAgentListDoesNotSilentlyDropOnReleaseLookupFailure 是 B10 的端到端判据。
func TestMarketAgentListDoesNotSilentlyDropOnReleaseLookupFailure(t *testing.T) {
	r, db, _, userTokens := setupRouter(t)
	const name = "cap-agent-r23"

	if err := serverstore.UpsertApp(db, &serverstore.App{
		Kind: serverstore.AppKindAgent, AppID: name, Title: "能力中心哨兵智能体",
		Description: name, Owner: "alice", Channel: serverstore.AppChannelMarket, Enabled: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateRelease(db, &serverstore.Release{
		Kind: serverstore.AppKindAgent, AppID: name, Version: "1.0.0",
		Title: name, Description: name, Author: "alice", Publisher: "alice",
		Status: serverstore.ReleaseStatusApproved,
	}); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantApp(db, serverstore.AppKindAgent, name, "bob", "user"); err != nil {
		t.Fatal(err)
	}

	list := func() (int, []string) {
		t.Helper()
		w := doGet(t, r, "/api/client/v2/capabilities?source=market", bobHdr(userTokens))
		var out struct {
			Items []map[string]any `json:"items"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &out)
		got := []string{}
		for _, it := range out.Items {
			if s, _ := it["name"].(string); s != "" {
				got = append(got, s)
			}
		}
		return w.Code, got
	}
	has := func(names []string, want string) bool {
		for _, s := range names {
			if s == want {
				return true
			}
		}
		return false
	}

	// —— 对照：正常路径下这一条必须在清单里（否则后面的"消失"无从判断）。——
	if code, got := list(); code != http.StatusOK || !has(got, name) {
		t.Fatalf("对照不成立：正常路径 %d %v（want 200 且含 %q）", code, got, name)
	}

	// —— 判据①：让**这一个应用**的版本行读取失败（依赖故障）。——
	if _, err := db.Exec(`ALTER TABLE app_releases ALTER COLUMN checksum DROP NOT NULL`); err != nil {
		t.Fatalf("注入前置（放开 NOT NULL）: %v", err)
	}
	if _, err := db.Exec(`UPDATE app_releases SET checksum = NULL, deleted_at = now() WHERE app_id = $1`, name); err != nil {
		t.Fatalf("注入依赖故障: %v", err)
	}

	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	code, got := list()
	log.SetOutput(prev)

	if code != http.StatusInternalServerError {
		t.Fatalf("依赖故障下清单接口 = %d %v —— want 500。"+
			"修前这里回 200 且**静默少一条**（员工看到「能力中心少了一项」，"+
			"与「该项真的没有已审版本」不可区分）", code, got)
	}
	if !strings.Contains(buf.String(), "dependency, not a rejection") {
		t.Fatalf("依赖故障没有任何日志（抓到 %q）—— 排障时不可见", buf.String())
	}

	// —— 对照：把注入撤掉 ⇒ 这一条必须回来（证明"少了"确实由该故障引起）。——
	if _, err := db.Exec(`UPDATE app_releases SET checksum = COALESCE(checksum, ''), deleted_at = NULL WHERE app_id = $1`, name); err != nil {
		t.Fatalf("撤回注入: %v", err)
	}
	if code, got := list(); code != http.StatusOK || !has(got, name) {
		t.Fatalf("撤回注入后 %d %v（want 200 且含 %q）—— 判据的前置/后置不一致", code, got, name)
	}
}

// TestMarketAgentWithoutApprovedReleaseIsStillAnEmptyRowNotAnOutage 钉住 `r == nil` 那一档：
// **没有已审版本**是正常状态（那一行本就不该出现在分发面），不是故障 —— 判据不许把
// 它一起变成 500（否则一个只上传了待审版本的应用会让整个能力中心不可用）。
func TestMarketAgentWithoutApprovedReleaseIsStillAnEmptyRowNotAnOutage(t *testing.T) {
	r, db, _, userTokens := setupRouter(t)
	const name = "cap-agent-pending-only"

	if err := serverstore.UpsertApp(db, &serverstore.App{
		Kind: serverstore.AppKindAgent, AppID: name, Title: name, Description: name,
		Owner: "alice", Channel: serverstore.AppChannelMarket, Enabled: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateRelease(db, &serverstore.Release{
		Kind: serverstore.AppKindAgent, AppID: name, Version: "1.0.0",
		Title: name, Description: name, Author: "alice", Publisher: "alice",
		Status: serverstore.ReleaseStatusPending, // ★ 只有待审版本 ⇒ CurrentMarketReleaseFor 返回 (nil, nil)
	}); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantApp(db, serverstore.AppKindAgent, name, "bob", "user"); err != nil {
		t.Fatal(err)
	}

	w := doGet(t, r, "/api/client/v2/capabilities?source=market", bobHdr(userTokens))
	if w.Code != http.StatusOK {
		t.Fatalf("只有待审版本的应用让清单接口 = %d %s, want 200 —— "+
			"「没有已审版本」是正常空态，不是依赖故障", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), name) {
		t.Fatalf("待审版本的应用出现在分发面清单里：%s", w.Body.String())
	}
}
