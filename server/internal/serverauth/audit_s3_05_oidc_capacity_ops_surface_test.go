package serverauth

// S3-05 的判据（审计 2026-10-04，P2）：OIDC 容量拒绝计数必须**真的**能被运维面读到。
//
// 缺陷现场：`OIDCFlowCapacityRejections()` 有定义、有自增点，注释写着「计数经
// OIDCFlowCapacityRejections() 读，供探针/运维区分『被限流』与『平台容量到顶』」，
// 而全仓**唯一读者是包内判据**（`audit_20260923_oidc_flow_bucket_test.go`）——
// 没有任何 HTTP 端点、`/readyz`/`server-info` 字段或日志行读它。这正是本仓列为
// 高发形态的"算出来了却没出口 / 有能力没接线"。
//
// 处置（二选一里的 ①）：挂到**既有**运维面 `GET /api/server/admin/server-info` 的
// `oidc.capacity_rejections`（与 `balance.admission_rejections` 同款：子系统记账、
// 装配层只读），不新造端点。
//
// 判据分三段（缺一不可）：
//  1. **端到端**：真实触发 N 次容量拒绝（走真实的 OIDC 流程启动路径，provider 返回
//     容量哨兵）⇒ server-info 的响应体里必须出现 `oidc.capacity_rejections == N`；
//  2. **同一真源**：响应里的数必须**等于**包级读数（`OIDCFlowCapacityRejections()`），
//     而不是另记一份或恒 0 —— 变异读数即红；
//  3. **反方向**：没有容量拒绝时该字段仍在、且为 0（"字段不存在"与"读数是 0"必须
//     可区分：前者会让运维脚本把"探针漂移"读成"一切正常"）。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

// oidcCapacityServerInfoRouter 把 server-info handler 挂成最小路由（与
// audit_r14o_sysinfo_shadow_read_test.go 同款；UpdateChecker 换成不触网的桩）。
func oidcCapacityServerInfoRouter(db *AdminAPI) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/server-info", db.handleServerInfo)
	return r
}

// oidcCapacityFromServerInfo 取响应体里的 oidc.capacity_rejections。
// @returns (值, 字段是否存在)。
func oidcCapacityFromServerInfo(t *testing.T, r *gin.Engine) (int64, bool) {
	t.Helper()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/server-info", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("server-info = %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		OIDC *struct {
			CapacityRejections int64 `json:"capacity_rejections"`
		} `json:"oidc"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("解析 server-info: %v", err)
	}
	if resp.OIDC == nil {
		return 0, false
	}
	return resp.OIDC.CapacityRejections, true
}

// TestOIDCCapacityRejectionsAreReadableFromServerInfo 是 S3-05 的主判据。
func TestOIDCCapacityRejectionsAreReadableFromServerInfo(t *testing.T) {
	// ① 反方向先行：没有任何容量拒绝时，字段必须**存在且为 0**（不是一个缺失的键）。
	_, cleanDB, _ := oidcFlowTestAPI(t, &flowFlipProvider{name: "oidc"})
	adminClean := oidcCapacityServerInfoRouter(&AdminAPI{DB: cleanDB, UpdateChecker: r14oNoopChecker{}})
	if got, ok := oidcCapacityFromServerInfo(t, adminClean); !ok {
		t.Fatalf("server-info 响应里没有 oidc.capacity_rejections 字段 —— 计数没有运维出口" +
			"（S3-05 原缺陷形态：算出来了却没接线）")
	} else if got != 0 {
		t.Fatalf("容量拒绝计数初值 = %d, want 0（包级单例未在统一复位入口清零？）", got)
	}

	// ② 真实触发 N 次容量拒绝（provider 回容量哨兵 ⇒ 流程启动被平台容量拒绝）。
	prov := &flowFlipProvider{name: "oidc", err: errOIDCFlowTableFull}
	r, db, api := oidcFlowTestAPI(t, prov)
	const ip = "203.0.113.71"
	const n = 5
	for i := 0; i < n; i++ {
		if w := flowLogin(t, r, ip, ""); w.Code != http.StatusTooManyRequests {
			t.Fatalf("第 %d 次容量拒绝 = %d, want 429", i+1, w.Code)
		}
	}
	if got := OIDCFlowCapacityRejections(); got != n {
		t.Fatalf("包级读数 = %d, want %d（触发路径没记账）", got, n)
	}

	// ③ 同一真源：运维面上读到的数必须等于包级读数。
	//    admin 用**同一个库**（server-info 的其它字段要读库；计数本身是进程级的，
	//    与库无关 —— 这里显式用同一个 db 以免引入无关差异）。
	admin := oidcCapacityServerInfoRouter(&AdminAPI{DB: db, UpdateChecker: r14oNoopChecker{}})
	got, ok := oidcCapacityFromServerInfo(t, admin)
	if !ok {
		t.Fatalf("server-info 响应里没有 oidc.capacity_rejections 字段 —— 计数没有运维出口（S3-05）")
	}
	if got != n {
		t.Fatalf("server-info 的 oidc.capacity_rejections = %d, want %d（=%d 次真实容量拒绝）"+
			"—— 运维面读的不是那份真实计数", got, n, n)
	}
	if got != OIDCFlowCapacityRejections() {
		t.Fatalf("运维面读数 %d ≠ 包级读数 %d —— 两处各记一份（本仓禁止的真源分裂）",
			got, OIDCFlowCapacityRejections())
	}
	_ = api
}
