package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ===========================================================================
// 我的版本（GET /api/client/v2/apps/wasm/:app_id/releases）—— R1-pm-3 的作者侧闭环
//
// 现场（独立审计 R1-pm-3 / R1-uxw-4）：`app_releases.reason` **写了没人读** ——
// 清单列集不含它、`WasmRelease` 结构体没有这个字段、审批队列也不下发、员工面更没有
// "我的版本"端点。审核开关一旦打开，作者发版后只看到发布那一刻的"待审核（线上仍是
// 旧版本）"，之后**永远**收不到结论；被拒也不知道理由，而版本号已经永久占位（§4.1）
// ⇒ 审核流程在作者侧退化成掷骰子。
//
// 本文件的四个判据缺一不可：
//  1. 发布者能查到**被拒版本与理由**（并区分 approved/pending/rejected 三态）；
//  2. 非发布者 404，且响应体与"应用不存在"**同形**（不泄露应用是否存在）；
//  3. 未登录 401（Bearer 中间件在 handler 之前）；
//  4. 不含制品字节（走清单投影；被拒行 archive 已释放 size=0）。
//
// ---- 变异验证（改回缺陷实现必红）----
//   - 去掉归属判定（release.go 的 `app.Owner != u.Username && !isSuperAdmin(u)`）
//     ⇒ TestMyReleasesOtherUserGets404WithoutExistenceLeak 红；
//   - 把 reason 从 `wasmReleaseListColumns`（serverstore/wasmapps.go）去掉
//     ⇒ TestMyReleasesPublisherSeesRejectedReason 红（理由变空串）；
//   - 把 `wg.GET("/:app_id/releases", …)` 从 internal/router 摘掉 ⇒ 本文件全部
//     用例在**生产路由**上 404（测试树逐条对齐生产路径，见 helpers_test.go 的 mount）。
// ---------------------------------------------------------------------------

// myReleaseRow 是"我的版本"的一行（跨语言契约：客户端 app-releases.ts 按它解析）。
type myReleaseRow struct {
	Version   string `json:"version"`
	Status    string `json:"status"`
	Reason    string `json:"reason"`
	CreatedAt string `json:"created_at"`
	Current   bool   `json:"current"`
	Checksum  string `json:"checksum"`
	Size      int64  `json:"size"`
}

type myReleasesView struct {
	AppID          string         `json:"app_id"`
	CurrentVersion string         `json:"current_version"`
	ReviewRequired bool           `json:"review_required"`
	Releases       []myReleaseRow `json:"releases"`
}

// myReleasesPath 是员工面的版本清单路径（与 internal/router 的申报逐字一致）。
func myReleasesPath(appID string) string {
	return "/api/client/v2/apps/wasm/" + appID + "/releases"
}

func (e *testEnv) myReleases(appID, token string) myReleasesView {
	e.t.Helper()
	var out myReleasesView
	e.decodeJSON(e.req(http.MethodGet, myReleasesPath(appID), token, nil), http.StatusOK, &out)
	return out
}

// row 取某个版本的行（缺失即失败——本文件里"版本行不见了"永远是缺陷信号）。
func (v myReleasesView) row(t *testing.T, version string) myReleaseRow {
	t.Helper()
	for _, r := range v.Releases {
		if r.Version == version {
			return r
		}
	}
	t.Fatalf("版本清单里没有 %s：%+v", version, v.Releases)
	return myReleaseRow{}
}

// TestMyReleasesPublisherSeesRejectedReason：**核心判据** —— 被拒理由必须能到作者手里。
//
// 三态各断言一次（rejected 带理由 / approved 空理由且 current / pending 空理由），
// 因为"理由字段永远有值"和"永远是空串"都能骗过只看单行的用例。
func TestMyReleasesPublisherSeesRejectedReason(t *testing.T) {
	e := newTestEnv(t)
	// 关闭审核时发布 ⇒ 基线版本直接生效（current=1.0.0）。
	e.publishOK(e.tokens["alice"], "mine-tool", "1.0.0", testGuestModule(t), goodConfig())
	// 打开审核后发布 ⇒ 停在 pending（线上仍旧版本）。
	e.setReviewRequired(true)
	e.publishOK(e.tokens["alice"], "mine-tool", "1.1.0", testGuestModule(t), goodConfig())

	// ---- 待审态：作者要能看见"哪个版本在等、线上还是哪一版" ----
	pending := e.myReleases("mine-tool", e.tokens["alice"])
	if pending.AppID != "mine-tool" || pending.CurrentVersion != "1.0.0" || !pending.ReviewRequired {
		t.Fatalf("清单头部不对（app_id/current_version/review_required）：%+v", pending)
	}
	if len(pending.Releases) != 2 {
		t.Fatalf("应列出两版，得到 %+v", pending.Releases)
	}
	if row := pending.row(t, "1.1.0"); row.Status != serverstore.ReleaseStatusPending || row.Reason != "" || row.Current {
		t.Fatalf("待审行应是 pending/无理由/非 current：%+v", row)
	}
	if row := pending.row(t, "1.0.0"); row.Status != serverstore.ReleaseStatusApproved || !row.Current {
		t.Fatalf("生效行应是 approved/current：%+v", row)
	}

	// ---- 被拒：管理员写下理由 ⇒ 作者**必须**读到它 ----
	const reason = "用途声明与数据敏感度不匹配：请补充数据来源说明后重发"
	e.decodeJSON(e.req(http.MethodPost,
		"/api/server/admin/wasm-apps/mine-tool/releases/1.1.0/reject", "",
		map[string]any{"reason": reason}), http.StatusOK, &struct {
		Status string `json:"status"`
	}{})

	after := e.myReleases("mine-tool", e.tokens["alice"])
	rejected := after.row(t, "1.1.0")
	if rejected.Status != serverstore.ReleaseStatusRejected {
		t.Fatalf("被拒版本状态应为 rejected，得到 %q", rejected.Status)
	}
	if rejected.Reason != reason {
		t.Fatalf("作者必须拿到被拒理由：reason = %q, want %q（R1-pm-3 的全部意义）", rejected.Reason, reason)
	}
	// 拒绝不动生效版本：作者据此知道"线上还是 1.0.0"。
	if after.CurrentVersion != "1.0.0" {
		t.Fatalf("拒绝不应改变当前生效版本，得到 %q", after.CurrentVersion)
	}
	if row := after.row(t, "1.0.0"); !row.Current || row.Reason != "" {
		t.Fatalf("生效行不应带审核理由（approved 时 reason 被清空）：%+v", row)
	}
	// 被拒 = 释放归档（N-4）：作者看到 size=0，而不是一个永远下不下来的体积。
	if rejected.Size != 0 {
		t.Fatalf("被拒版本的 size 应为 0（拒绝即释放归档）：%d", rejected.Size)
	}

	// ---- 不含制品字节：清单是元数据投影，行里不得出现 wasm/archive/config 键 ----
	w := e.req(http.MethodGet, myReleasesPath("mine-tool"), e.tokens["alice"], nil)
	var raw struct {
		Releases []map[string]any `json:"releases"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("响应不是 JSON：%v", err)
	}
	wantKeys := map[string]bool{
		"version": true, "status": true, "reason": true, "created_at": true,
		"current": true, "checksum": true, "size": true,
	}
	for _, row := range raw.Releases {
		if len(row) != len(wantKeys) {
			t.Fatalf("行字段集合与契约不符（多给/少给都是契约漂移）：%v", row)
		}
		for key := range row {
			if !wantKeys[key] {
				t.Fatalf("行里出现了契约外的字段 %q（制品字节/config 都不该在这里）：%v", key, row)
			}
		}
	}
}

// TestMyReleasesOtherUserGets404WithoutExistenceLeak：非发布者**看不到任何东西**，
// 而且"这个应用存在但不是你的"与"这个应用不存在"必须给出**同形**响应
// （同状态、同结构、同文案，只有调用方自己填进去的 app_id 不同）——
// 沿用 notFoundApp 的既有纪律：404 不能变成存在性探针。
func TestMyReleasesOtherUserGets404WithoutExistenceLeak(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "leak-tool", "1.0.0", testGuestModule(t), goodConfig())

	// 他人（bob，普通员工）拿到 404。
	denied := e.req(http.MethodGet, myReleasesPath("leak-tool"), e.tokens["bob"], nil)
	deniedErr := e.decodeErr(denied, http.StatusNotFound)
	if deniedErr.Error.Code != "NOT_FOUND" {
		t.Fatalf("非发布者的 code = %q, want NOT_FOUND", deniedErr.Error.Code)
	}

	// 不存在的应用：逐字节同形（把调用方自己填的 app_id 归一化后比较）。
	missing := e.req(http.MethodGet, myReleasesPath("no-such-app-zz"), e.tokens["bob"], nil)
	e.decodeErr(missing, http.StatusNotFound)
	normalize := func(body, id string) string { return strings.ReplaceAll(body, id, "<APP>") }
	if got, want := normalize(missing.Body.String(), "no-such-app-zz"), normalize(denied.Body.String(), "leak-tool"); got != want {
		t.Fatalf("「不是你的」与「不存在」必须同形（否则 404 变成存在性探针）：\n  不存在 = %s\n  不是你的 = %s", got, want)
	}
	// 响应体里不得泄漏任何只有"存在"才会有的内容（唯一被回显的是调用方自己填的
	// app_id，所以上面那条同形比较要先把 app_id 归一化掉）。
	for _, secret := range []string{"1.0.0", "releases", "checksum", "size", "alice"} {
		if strings.Contains(denied.Body.String(), secret) {
			t.Fatalf("404 响应体泄漏了存在性线索 %q：%s", secret, denied.Body.String())
		}
	}

	// 平台管理员照旧放行（ownedApp 的既有语义：super_admin 可管理任意应用）。
	if view := e.myReleases("leak-tool", e.tokens["boss"]); len(view.Releases) != 1 {
		t.Fatalf("管理员应能读到版本清单，得到 %+v", view)
	}
}

// TestMyReleasesRequiresAuth：未登录 401（Bearer 中间件先于 handler），且是 JSON 信封。
func TestMyReleasesRequiresAuth(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "auth-tool", "1.0.0", testGuestModule(t), goodConfig())
	eb := e.decodeErr(e.req(http.MethodGet, myReleasesPath("auth-tool"), "", nil), http.StatusUnauthorized)
	if eb.Error.Code == "" {
		t.Fatalf("401 必须是 JSON 错误信封：%+v", eb)
	}
}

// TestMyReleasesSurvivesRetirement：退役（软删）后的只读面与 export/diagnostics 一致
// —— 保留期内作者仍要能回看"当初为什么被拒"，否则 R1-pm-3 只是把黑洞推迟到删除那一刻。
func TestMyReleasesSurvivesRetirement(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "retire-mine", "1.0.0", testGuestModule(t), goodConfig())
	e.decodeJSON(e.req(http.MethodDelete, "/api/client/v2/apps/wasm/retire-mine", e.tokens["alice"], nil),
		http.StatusOK, &struct {
			App struct {
				Deleted bool `json:"deleted"`
			} `json:"app"`
		}{})
	view := e.myReleases("retire-mine", e.tokens["alice"])
	if len(view.Releases) != 1 || view.Releases[0].Version != "1.0.0" {
		t.Fatalf("退役后作者仍应能读自己的版本清单：%+v", view)
	}
}
