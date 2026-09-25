package serverauth

// R14-O · VC-F1：`collectDBStats` 的**第二半**（"每条读经已钉只读事务"）补判据。
//
// 被审形态（V14-C 复审，第十四轮）：lane K 的 R14-K · D-02 修了两件事 ——
//  ① 表名与语句从"变量拼接"改成**字面量**（有动态名尺子看着）；
//  ② 每条读各自经 `serverstore.NewUsageReadConn` 开一个**已钉**只读事务（防 shadow）。
// 第 ① 半有机械判据（`audit_r14k_dynamic_rel_test.go`），第 ② 半**没有行为判据**：
// 真 PG 探针证明同一句字面量在敌对 `search_path` 下裸池读 **3**（shadow 诱饵）
// 而经已钉只读事务读 **57**（public）—— 读错对象、`err=nil`、所有健康出口报绿。
//
// 复现口径的**诚实更正**（我自己实跑得到的，与 V14-C 的报告数字不同）：
//
//	V14-C 的 J7/J8 把"拆掉被测物仍绿"当成"零判据"的证据，但那是量具的产物：
//	  - J7 跑的是 `internal/serverauth`（这个包里本来就没有 hold-and-wait 判据，
//	    绿是必然的，不能证明"全仓零判据"）；
//	  - J8 的 `judge-attack.sh` 用 `${spec##*|}` 取包与正则，四段式 spec 会被截成
//	    **最后一段**（实际只跑了 `-run TestAuditR14K`），把
//	    `TestAuditR13GH3CrossPackageFamilySQLIsInventoried` 排除在外。
//	我实跑的结果是：**整段删掉** `NewUsageReadConn`（换回裸池）会被 R13GH3 的静态
//	"pin 记号"清单咬住（红：`internal/serverauth.collectDBStats 登记为 pinned，但函数体里
//	没有任何 pin 记号`）。所以"逐字面量 + 静态记号"这一层是有判据的。
//
// **真正零判据的是行为面**，两个形态（都在隔离副本里实跑过，见 run-f1.sh）：
//
//	A. 保留 pin 记号（`NewUsageReadConn` 照开照关）但读走裸池 —— 直接写 `db.QueryRow`
//	   落进 lane K 文本守卫的**区域**内，会被它咬住（我的 P0b 实测 RED）；但
//	B. 同一形态把池句柄**改个名字**（`poolDB := db; poolDB.QueryRow(t.count)`）
//	   ⇒ 修前的**全部**判据保持绿（文本守卫登记过的盲区②、R13GH3 静态清单、
//	   serverauth 的 `TestHandleServerInfo*`），而真 PG 上读的是 shadow。
//
// 本文件的判据（真 PG + 真 shadow + `collectDBStats` 的**返回值**）：
// 变异验证（实跑，见 temp/r14/laneO/run-f1.sh）：
//   - **修前**：把 `NewUsageReadConn` 换回裸池（字面量不动）⇒ 本文件之前的全部判据
//     GREEN（`TestHandleServerInfo*` 与 `TestAuditR13GH3|R13GE|R14K` 全绿）=假绿复现；
//   - **修后**：同一变异 ⇒ 本判据 RED（A/B/C 三处同时报「读自 shadow」）；
//   - **修后**：只读事务照开、但把 pin（`SET LOCAL search_path = public`）拿掉
//     ⇒ 本判据同样 RED（判据咬的是"读到了哪个库"，不是"有没有调某个函数"）。
//
// 诚实边界（如实登记）：
//   - 本判据只覆盖 `collectDBStats` 这条路径上的**行数**读面；`schemaVersion` 与
//     `pg_database_size` 不在已钉事务内（前者读 `schema_migrations`、后者读
//     `pg_catalog`，都不在族内关系集合里，且都没有映射到业务数字）。
//   - shadow 是"同名 + 任意列"的**行数诱饵**（只有 `COUNT(*)`，列形状无关），
//     不试图复刻真实表的列/约束：本判据关心的是"读的是哪个 schema"。

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/updatecheck"
)

// r14oShadowSchema 是本判据专用的 shadow schema（与 r12n2 / r13ge / r14k 的分开，
// 避免并行用例互相 DROP）。
const r14oShadowSchema = "r14o_shadow"

// r14oShadowDecoyDelta 是 shadow 每张被遮表比 public **多**的行数：
// 固定 3 ⇒ 逐表可区分（0 vs 0 这种"分不出来"的夹具在这里被结构性排除）。
const r14oShadowDecoyDelta = 3

// r14oIdentRe 校验"表名形态"：collectDBStats 的表名必须来自函数内的**字面量表**
// （这正是 R14-K · D-02 的修法）。本判据顺手把这条钉住 —— 一旦有人把表名改回变量/
// 请求输入，这里会以"非字面量形态"当场失败，而不是把动态名拼进 DDL。
var r14oIdentRe = regexp.MustCompile(`^[a-z_][a-z0-9_]*$`)

// r14oHostilePool 造一个 `search_path = r14o_shadow, public` 的旁路池
// （与 r13geHostilePoolFor 同形态：走 DSN 的 `options=-csearch_path=…`，
// 而不是对单条连接 `SET`——池里每条连接都要带上它）。
func r14oHostilePool(t *testing.T, db *sql.DB, schema string) *sql.DB {
	t.Helper()
	var dbName string
	if err := db.QueryRow("SELECT current_database()").Scan(&dbName); err != nil {
		t.Fatalf("取当前库名: %v", err)
	}
	u, err := url.Parse(serverstore.PgTestDSN())
	if err != nil {
		t.Fatalf("解析 PG_DSN_TEST: %v", err)
	}
	u.Path = "/" + dbName
	q := u.Query()
	q.Set("options", "-csearch_path="+schema+",public")
	u.RawQuery = q.Encode()
	side, err := sql.Open("pgx", u.String())
	if err != nil {
		t.Fatalf("打开敌对池: %v", err)
	}
	t.Cleanup(func() { side.Close() })
	if err := side.Ping(); err != nil {
		t.Fatalf("敌对池 ping: %v", err)
	}
	var sp string
	if err := side.QueryRow("SHOW search_path").Scan(&sp); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(sp, schema) {
		t.Fatalf("敌对池 search_path=%q，第一段必须是 %s（夹具无效）", sp, schema)
	}
	return side
}

// r14oBuildShadow 为 `collectDBStats` 返回的**每一张**表造一份"同名 + 诱饵行数"的
// shadow 表：行数 = public 真值 + r14oShadowDecoyDelta。
//
// 列形状无所谓（被执行的语句只有 `SELECT COUNT(*)`），所以这里刻意用最简表形态：
// 诱饵要的是"数字长得像真的、但与 public 不同"，不是"复刻 schema"。
func r14oBuildShadow(t *testing.T, db *sql.DB, public dbStats) {
	t.Helper()
	if len(public.Tables) < 5 {
		t.Fatalf("public 侧只统计到 %d 张表（下限 5）——夹具前提不成立", len(public.Tables))
	}
	if _, err := db.Exec("DROP SCHEMA IF EXISTS " + r14oShadowSchema + " CASCADE"); err != nil {
		t.Fatalf("清 shadow: %v", err)
	}
	if _, err := db.Exec("CREATE SCHEMA " + r14oShadowSchema); err != nil {
		t.Fatalf("建 shadow: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec("DROP SCHEMA IF EXISTS " + r14oShadowSchema + " CASCADE") })
	for name, rows := range public.Tables {
		if !r14oIdentRe.MatchString(name) {
			t.Fatalf("collectDBStats 返回了非字面量形态的表名 %q —— 表名必须来自函数内的字面量表", name)
		}
		rel := r14oShadowSchema + "." + name
		if _, err := db.Exec(fmt.Sprintf("CREATE TABLE %s (r14o_marker int)", rel)); err != nil {
			t.Fatalf("造 shadow.%s: %v", name, err)
		}
		if _, err := db.Exec(fmt.Sprintf(
			"INSERT INTO %s SELECT g FROM generate_series(1, $1) g", rel), rows+r14oShadowDecoyDelta); err != nil {
			t.Fatalf("播 shadow.%s 诱饵: %v", name, err)
		}
	}
}

// r14oNoopChecker 让 handleServerInfo 不触网（默认 checker 会真的请求 GitHub Releases）。
type r14oNoopChecker struct{}

func (r14oNoopChecker) Check(context.Context, string) (*updatecheck.Result, error) {
	return nil, updatecheck.ErrUnavailable
}

// TestAuditR14OServerInfoStatsReadPublic 是 VC-F1 的主判据（A + C）。
func TestAuditR14OServerInfoStatsReadPublic(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()

	// public 真值（干净池）。先造几行"像真的"业务数据，让每张表的行数不再是 0：
	// 诱饵与真值都可分辨（夹具反向自证见下面 C 段）。
	if _, err := serverstore.CreateUser(db, &serverstore.User{
		Username: "r14o-stats-a", Source: "local", Status: 1, Role: serverstore.RoleUser}); err != nil {
		t.Fatalf("造 public 用户: %v", err)
	}
	if _, err := serverstore.CreateUser(db, &serverstore.User{
		Username: "r14o-stats-b", Source: "local", Status: 1, Role: serverstore.RoleUser}); err != nil {
		t.Fatalf("造 public 用户: %v", err)
	}
	if err := serverstore.SetSetting(db, "r14o.stats.marker", "1"); err != nil {
		t.Fatalf("造 public setting: %v", err)
	}

	want, err := collectDBStats(db)
	if err != nil {
		t.Fatalf("collectDBStats(public): %v", err)
	}
	if want.Tables["users"] < 2 {
		t.Fatalf("夹具前提不成立：public users=%d（want ≥2）", want.Tables["users"])
	}

	r14oBuildShadow(t, db, want)
	side := r14oHostilePool(t, db, r14oShadowSchema)

	// ---------------------------------------------------------------- C. 夹具反向自证
	//
	// 对**裸池**执行与 collectDBStats 逐字相同的字面量 SQL：必须读到 shadow 的诱饵
	// （public + delta）。这条断言是"夹具真的在遮蔽"的证据，也是"两条路径给出不同
	// 数字"的真 PG 对照；它一旦失效（shadow 没生效 / 诱饵没播上），本判据会**当场
	// 失败**，而不是让主判据退化成恒真。
	decoySeen := 0
	for name, publicRows := range want.Tables {
		var bare int64
		if err := side.QueryRow("SELECT COUNT(*) FROM " + name).Scan(&bare); err != nil {
			t.Fatalf("裸池读 shadow.%s: %v", name, err)
		}
		if bare != publicRows+r14oShadowDecoyDelta {
			t.Fatalf("夹具反向自证失败：裸池读 %s = %d，期望 shadow 诱饵 %d（= public %d + %d）"+
				" —— shadow 没生效或诱饵没播上，主判据会退化成恒真",
				name, bare, publicRows+r14oShadowDecoyDelta, publicRows, r14oShadowDecoyDelta)
		}
		if bare != publicRows {
			decoySeen++
		}
	}
	if decoySeen != len(want.Tables) {
		t.Fatalf("夹具反向自证失败：%d/%d 张表的诱饵与 public 真值不可区分", len(want.Tables)-decoySeen, len(want.Tables))
	}

	// 同一句字面量经**已钉只读事务**读：必须回到 public（这正是被测物要做的事）。
	var pinned int64
	rd, err := serverstore.NewUsageReadConn(side)
	if err != nil {
		t.Fatalf("NewUsageReadConn(敌对池): %v", err)
	}
	if err := rd.QueryRow("SELECT COUNT(*) FROM users").Scan(&pinned); err != nil {
		t.Fatalf("已钉读 users: %v", err)
	}
	_ = rd.Close()
	if pinned != want.Tables["users"] {
		t.Fatalf("已钉只读事务读 users = %d，want public %d —— pin 未生效（夹具或实现坏了）",
			pinned, want.Tables["users"])
	}
	t.Logf("真 PG 对照：public users=%d / 裸池读=%d（shadow 诱饵） / 已钉只读事务读=%d（public）",
		want.Tables["users"], want.Tables["users"]+r14oShadowDecoyDelta, pinned)

	// ---------------------------------------------------------------- A. 主判据
	got, err := collectDBStats(side)
	if err != nil {
		t.Fatalf("collectDBStats(敌对池): %v", err)
	}
	var mismatched []string
	for name, wantRows := range want.Tables {
		gotRows, ok := got.Tables[name]
		if !ok {
			mismatched = append(mismatched, fmt.Sprintf("%s: 缺失（public=%d）", name, wantRows))
			continue
		}
		if gotRows != wantRows {
			mismatched = append(mismatched, fmt.Sprintf("%s: got=%d want=%d(public) 诱饵=%d",
				name, gotRows, wantRows, wantRows+r14oShadowDecoyDelta))
		}
	}
	if len(mismatched) > 0 {
		t.Errorf("collectDBStats 在敌对 search_path 下**逐表行数**读自 shadow（每表诱饵 = public+%d）：\n  %s\n"+
			"⇒ 表名是字面量**不够**：每条读必须经 serverstore.NewUsageReadConn（唯一 pin 实现）"+
			"开一个已钉只读事务 —— 否则 D-02 的行为原样复发（读错对象、err=nil、所有健康出口报绿）。",
			r14oShadowDecoyDelta, strings.Join(mismatched, "\n  "))
	}
	if got.TotalRows != want.TotalRows {
		t.Errorf("TotalRows 读自 shadow：got=%d want=%d（public）", got.TotalRows, want.TotalRows)
	}
}

// TestAuditR14OServerInfoHandlerReadsPublic 是 VC-F1 的 API 面判据（B）：
// 管理端「服务器信息」响应里的 db.tables 每个数字都必须来自 public。
func TestAuditR14OServerInfoHandlerReadsPublic(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()

	if _, err := serverstore.CreateUser(db, &serverstore.User{
		Username: "r14o-handler-a", Source: "local", Status: 1, Role: serverstore.RoleUser}); err != nil {
		t.Fatalf("造 public 用户: %v", err)
	}
	want, err := collectDBStats(db)
	if err != nil {
		t.Fatalf("collectDBStats(public): %v", err)
	}
	r14oBuildShadow(t, db, want)
	side := r14oHostilePool(t, db, r14oShadowSchema)

	a := &AdminAPI{DB: side, UpdateChecker: r14oNoopChecker{}}
	r := gin.New()
	r.GET("/server-info", a.handleServerInfo)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/server-info", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		DB struct {
			Tables    map[string]int64 `json:"tables"`
			TotalRows int64            `json:"total_rows"`
		} `json:"db"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	var mismatched []string
	for name, wantRows := range want.Tables {
		if got := resp.DB.Tables[name]; got != wantRows {
			mismatched = append(mismatched, fmt.Sprintf("%s: got=%d want=%d(public)", name, got, wantRows))
		}
	}
	if len(mismatched) > 0 {
		t.Errorf("handleServerInfo 的 db.tables 读自 shadow（半真半假：同一响应里两组数字来自两个库）：\n  %s",
			strings.Join(mismatched, "\n  "))
	}
	if resp.DB.TotalRows != want.TotalRows {
		t.Errorf("db.total_rows 读自 shadow：got=%d want=%d", resp.DB.TotalRows, want.TotalRows)
	}
}
