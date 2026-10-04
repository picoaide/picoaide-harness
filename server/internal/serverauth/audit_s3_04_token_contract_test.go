package serverauth

// S3-04 的判据（审计 2026-10-04，P2）：**测试镜像树必须服务与生产树同一条契约**。
//
// 缺陷现场：`GET /api/server/admin/users/:id/tokens` 在生产树（internal/router →
// `AdminHandlers.ListUserTokens` → `listUserTokensPaged`）落的是 `?page=&size=` 分页契约
// （`{tokens,page,size,total,has_more}`、size 越界 **400**），而 `RegisterAdminRoutes`
// 这条**测试镜像树**绑的是旧的无分页实现（忽略 `?page/&size`，固定 500 条 +
// `{tokens,total,truncated}`）。`internal/router/parity_test.go` 的镜像对拍只比
// (method, path)，两条树的路径逐字相同 ⇒ **恒绿**，而所有走镜像树的用例测的都不是
// 生产 handler、生产契约（分页/越界 400）在镜像面上永远测不到。
//
// 处置（二选一里的 ①）：把镜像也指向生产实现、删掉旧实现 —— "同一读取面只允许一套
// 契约"。本文件是那条判据的**行为级**证据：它挂在**镜像树**（`adminRouter` 走
// `RegisterAdminRoutes`）上，断言的都是"生产契约才有"的现象：
//
//	① `?size=` 越界必须 400 —— 旧实现忽略 size 参数，会回 200（本判据必红）；
//	② 合法 `?page=&size=` 必须按页返回，且响应带 page/size/total/has_more
//	   —— 旧实现恒回同一批 500 条、没有 page/size/has_more（本判据必红）。
//
// 与 `TestR15CTokenListWiringUsesPagedHandler`（供给面源码级接线）互补：那一条钉
// "生产供给面绑的是分页实现"，本一条钉"镜像树真的在服务同一份契约"。
// 逐路由的 handler 身份对拍在 internal/router 的
// TestAdminRouteMirrorsBindProductionHandlers（判据面 = 运行时 handler 名）。

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

func TestMirrorAdminTreeServesPagedTokenContract(t *testing.T) {
	// adminRouter 走的是 **RegisterAdminRoutes 镜像树**（与生产树无关的那一棵）。
	r, db := adminRouter(t)
	hdr := adminLoginHdr(t, r)

	const total = 7
	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: "tokmirror", Source: "local", Status: 1})
	if err != nil {
		t.Fatalf("建用户: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO api_tokens (user_id, token_hash, name, expires_at)
		SELECT ?, ? || '-' || g, 'desktop', now() + interval '90 days' FROM generate_series(1, ?) g`,
		uid, "s304-tokmirror", total); err != nil {
		t.Fatalf("灌令牌: %v", err)
	}
	base := fmt.Sprintf("/api/server/admin/users/%d/tokens", uid)

	// ① 越界 size ⇒ 400 VALIDATION。旧的无分页实现忽略 size（回 200 + 固定 500 条视图）
	//    ⇒ 这一条会把"镜像留在旧实现上"直接打红。
	w, out := doJSON(t, r, "GET", base+"?size=99999", "", hdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("镜像树上 size=99999 应 400（分页契约），实得 %d —— 镜像树绑的不是生产实现："+
			"同一条路径在两棵树里有两套响应契约（S3-04）\n%s", w.Code, w.Body.String())
	}
	if e, _ := out["error"].(map[string]any); e == nil || e["code"] != "VALIDATION" {
		t.Fatalf("越界 size 的错误信封应为 VALIDATION，实得 %s", w.Body.String())
	}

	// ② 合法分页请求：必须真的按页返回（offset 生效），且四个分页元数据字段齐全。
	//    total=7 / size=3 ⇒ 第 3 页只剩 1 条且 has_more=false；旧实现忽略分页参数，
	//    两页都会把 7 条一次给全。
	for _, tc := range []struct {
		query   string
		page    float64
		want    int
		hasMore bool
	}{
		{"page=1&size=3", 1, 3, true},
		{"page=3&size=3", 3, 1, false},
	} {
		w, out := doJSON(t, r, "GET", base+"?"+tc.query, "", hdr)
		if w.Code != http.StatusOK {
			t.Fatalf("%s 应 200，实得 %d：%s", tc.query, w.Code, w.Body.String())
		}
		items, _ := out["tokens"].([]any)
		if len(items) != tc.want {
			t.Fatalf("%s 返回 %d 条，want %d（total=%d；旧实现忽略 page/size，"+
				"会把 %d 条一次给全）", tc.query, len(items), tc.want, total, total)
		}
		for field, want := range map[string]float64{"page": tc.page, "size": 3, "total": total} {
			got, ok := out[field].(float64)
			if !ok {
				t.Fatalf("%s: 响应缺少分页元数据 %q（旧契约只有 tokens/total/truncated）：%s",
					tc.query, field, w.Body.String())
			}
			if got != want {
				t.Fatalf("%s: %s = %v, want %v", tc.query, field, got, want)
			}
		}
		hasMore, ok := out["has_more"].(bool)
		if !ok {
			t.Fatalf("%s: 响应缺少 has_more（分页契约的必有字段）：%s", tc.query, w.Body.String())
		}
		if hasMore != tc.hasMore {
			t.Fatalf("%s: has_more = %v, want %v", tc.query, hasMore, tc.hasMore)
		}
	}
}
