package serverauth

// R15C-R-01 ②（审计 2026-09-25，P1）的判据：管理端令牌列表**必须**分页，且
// `?size=` 越界**必须** 400。
//
// 修复前的实测形态（真 HTTP + 真 PG，子泳道 R 的 scale_probe）：1,001,883 行时
// 单次 `GET /api/server/admin/users/1/tokens` = 137,148,812 B（130.8 MiB）/ 2.29 s，
// 进程在飞堆 11 MB → 667 MB，3 并发 1,585.9 MB。行数没有上界（任何持证员工每次
// 登录插一行、成功登录清空失败预算）。
//
// 本文件的判据与"变异即红"的对应关系：
//   - 去掉 handler 的 size 校验 ⇒ TestR15CTokenListRejectsOversizePage 红；
//   - 去掉 DAO 的 LIMIT/OFFSET ⇒ TestR15CTokenListIsBoundedByPageSize /
//     SecondPageIsDistinct 红（1200 行会整份返回）；
//   - 把供给面接回旧的无分页实现 ⇒ TestR15CTokenListWiringUsesPagedHandler 红。

import (
	"database/sql"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// pagedTokenEngine 把**分页 handler 本体**挂到最小路由上（鉴权与权限申报由
// AdminRoute 的集中声明负责，不是本用例的对象）。
func pagedTokenEngine(db *sql.DB) *gin.Engine {
	gin.SetMode(gin.TestMode)
	a := &AdminAPI{DB: db}
	r := gin.New()
	r.GET("/api/server/admin/users/:id/tokens", a.listUserTokensPaged)
	return r
}

// seedPageTokens 建一个用户并插入 n 条未过期令牌，返回 (userID, 令牌总数)。
func seedPageTokens(t *testing.T, db *sql.DB, username string, n int) (int64, int64) {
	t.Helper()
	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: username, Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	// 单条 INSERT ... generate_series：逐条插入 1200 行要 30 s+，会把用例变成
	// 负载敏感的门禁噪音。
	if _, err := db.Exec(`INSERT INTO api_tokens (user_id, token_hash, name, expires_at)
		SELECT ?, ? || '-' || g, 'desktop', now() + interval '90 days' FROM generate_series(1, ?) g`,
		uid, fmt.Sprintf("r15c-%s", username), n); err != nil {
		t.Fatal(err)
	}
	return uid, int64(n)
}

func TestR15CTokenListIsBoundedByPageSize(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	r := pagedTokenEngine(db)
	uid, total := seedPageTokens(t, db, "tokpage", 1200)

	// ① 缺省页：不带 ?size= ⇒ 缺省 50 条（修复前会一次性返回全部 1200 条）。
	w, out := doJSON(t, r, "GET", fmt.Sprintf("/api/server/admin/users/%d/tokens", uid), "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("default page: %d %s", w.Code, w.Body.String())
	}
	items, _ := out["tokens"].([]any)
	if len(items) != serverstore.TokenListDefaultPageSize {
		t.Fatalf("缺省页应返回 %d 条, 实得 %d 条（DAO/handler 的 LIMIT 被拆掉就会变红）",
			serverstore.TokenListDefaultPageSize, len(items))
	}
	if got := int(out["size"].(float64)); got != serverstore.TokenListDefaultPageSize {
		t.Fatalf("size 元数据 = %d, want %d", got, serverstore.TokenListDefaultPageSize)
	}
	if got := int64(out["total"].(float64)); got != total {
		t.Fatalf("total = %d, want %d", got, total)
	}
	if has, _ := out["has_more"].(bool); !has {
		t.Fatal("has_more 必须为 true（还有 1150 条没返回）")
	}

	// ② 显式页：?size=200 是允许的最大页大小。
	w, out = doJSON(t, r, "GET", fmt.Sprintf("/api/server/admin/users/%d/tokens?size=%d",
		uid, serverstore.TokenListMaxPageSize), "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("size=max: %d %s", w.Code, w.Body.String())
	}
	if items, _ := out["tokens"].([]any); len(items) != serverstore.TokenListMaxPageSize {
		t.Fatalf("size=%d 应返回 %d 条, 实得 %d", serverstore.TokenListMaxPageSize,
			serverstore.TokenListMaxPageSize, len(items))
	}
	// ③ 响应体有界：1200 行表里一页 ≤ 64 KiB（修复前 1201 行 ~160 KiB 且随总行数线性增长）。
	if n := w.Body.Len(); n > 64*1024 {
		t.Fatalf("单页响应体 %d B 超过 64 KiB 上限（说明分页没有生效）", n)
	}
}

func TestR15CTokenListSecondPageIsDistinct(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	r := pagedTokenEngine(db)
	uid, _ := seedPageTokens(t, db, "tokpage2", 120)

	fetch := func(page int) []float64 {
		t.Helper()
		w, out := doJSON(t, r, "GET",
			fmt.Sprintf("/api/server/admin/users/%d/tokens?page=%d&size=50", uid, page), "", nil)
		if w.Code != http.StatusOK {
			t.Fatalf("page=%d: %d %s", page, w.Code, w.Body.String())
		}
		items, _ := out["tokens"].([]any)
		ids := make([]float64, 0, len(items))
		for _, it := range items {
			m, _ := it.(map[string]any)
			ids = append(ids, m["id"].(float64))
		}
		return ids
	}
	p1, p2 := fetch(1), fetch(2)
	if len(p1) != 50 || len(p2) != 50 {
		t.Fatalf("两页长度应为 50/50, 实得 %d/%d", len(p1), len(p2))
	}
	seen := map[float64]bool{}
	for _, id := range p1 {
		seen[id] = true
	}
	for _, id := range p2 {
		if seen[id] {
			t.Fatalf("第二页与第一页重复了令牌 id=%v（offset 被拆掉就会变红）", id)
		}
	}
	if p1[len(p1)-1] <= p2[0] {
		t.Fatalf("按 id 倒序分页断裂: 第一页最小 id=%v, 第二页最大 id=%v", p1[len(p1)-1], p2[0])
	}
}

func TestR15CTokenListRejectsOversizePage(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	r := pagedTokenEngine(db)
	uid, _ := seedPageTokens(t, db, "tokpage3", 3)
	base := fmt.Sprintf("/api/server/admin/users/%d/tokens", uid)

	for _, tc := range []struct {
		query string
		why   string
	}{
		{"?size=" + strconv.Itoa(serverstore.TokenListMaxPageSize+1), "超过最大页大小"},
		{"?size=1000000", "超大页（修复前的放大面本体）"},
		{"?size=0", "页大小为 0"},
		{"?size=-1", "负页大小"},
		{"?size=abc", "非数字"},
		{"?page=0", "页码为 0"},
		{"?page=-3", "负页码"},
		{"?page=abc", "页码非数字"},
	} {
		w, out := doJSON(t, r, "GET", base+tc.query, "", nil)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s (%s): 应 400, 实得 %d %s", tc.query, tc.why, w.Code, w.Body.String())
		}
		e, _ := out["error"].(map[string]any)
		if e == nil || e["code"] != "VALIDATION" {
			t.Fatalf("%s: 错误信封应为 VALIDATION, 实得 %s", tc.query, w.Body.String())
		}
	}
	// 反向对照：合法的最大页必须成功（判据不能靠"一律 400"变绿）。
	w, _ := doJSON(t, r, "GET", base+"?size="+strconv.Itoa(serverstore.TokenListMaxPageSize), "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("size=%d 应 200, 实得 %d", serverstore.TokenListMaxPageSize, w.Code)
	}
}

// TestR15CTokenListWiringUsesPagedHandler 是**装配**判据：`AdminHandlers` 供给面
// （生产路由表 internal/router 唯一取 handler 的入口）绑定的必须是分页实现。
//
// 为什么需要它：分页实现放在新文件里、由 handlers.go 的供给面接线；若那一行被改回
// 旧的无分页实现（admin.go 的 listUserTokens），上面三个用例（直接挂分页 handler）
// 仍然全绿 —— 判据必须落在接线上。serverauth 包不能 import internal/router（成环），
// 因此这里读供给面源码断言绑定关系（与本仓既有的接线类守卫同形，例如
// packages/host/desktop/tests/subagent-runner-env.spec.ts 的源码级接线断言）。
func TestR15CTokenListWiringUsesPagedHandler(t *testing.T) {
	raw, err := os.ReadFile("handlers.go")
	if err != nil {
		t.Fatalf("读 handlers.go: %v", err)
	}
	src := string(raw)
	if !strings.Contains(src, "ListUserTokens:    a.listUserTokensPaged") {
		t.Fatal("AdminHandlers 供给面必须把 ListUserTokens 绑到分页实现 a.listUserTokensPaged" +
			"（改回 a.listUserTokens ⇒ 生产路由恢复无分页读取面，本判据必红）")
	}
	// 反向对照：供给面里不得再出现旧实现作为 ListUserTokens 的绑定。
	if strings.Contains(src, "ListUserTokens:    a.listUserTokens,") {
		t.Fatal("ListUserTokens 不得绑回旧的无分页实现")
	}
	// 行为对照：供给面给出的 handler 必须就是分页的那个（用 400 判据区分两者）。
	api := &AdminAPI{DB: nil}
	h := api.Handlers()
	if h.ListUserTokens == nil {
		t.Fatal("AdminHandlers.ListUserTokens 未接线")
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/server/admin/users/:id/tokens", h.ListUserTokens)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/server/admin/users/1/tokens?size=99999", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("供给面的 ListUserTokens 对 size=99999 应 400（分页实现），实得 %d —— "+
			"绑到旧实现时这里会是 500/200，本判据即红", w.Code)
	}
}
