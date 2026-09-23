package serverauth

// R5-A-18（审计 2026-09-23，P1）：OIDC **流程启动**桶只对失败计数。
//
// 修前形态：/api/client/v2/auth/{oidc,openid}/login 与登录 IP 桶**共用实例**
// （loginIPLimiter + loginIPMaxAttempts），而 allow 对每一次被接受的调用无条件
// 记账 ⇒ 每一次**成功**的 SSO 登录都吃掉一格；该键全仓只有一处构造、零处 reset
// ⇒ 每个出口 IP 的 SSO 登录被永久压到 60 次/5 分钟（纯合法流量即触发，
// 一个 NAT 出口后面 60 人以上的组织早高峰必撞，且无 env 旋钮、无恢复路径）。
//
// 本文件钉住四件事（每条都能被"改回旧语义"单独点红）：
//
//	① 连续 N（= 3× 预算）次**成功**的流程启动，一次 429 都不许出现；
//	② 失败仍然吃预算：预算次失败之后第 N+1 次必须 429（含成功请求也被拒）；
//	③ 判定键 == 记账键 == 观测键（都用 oidcFlowBudgetKeyForHost 这一个构造点）；
//	④ 流程启动桶与登录 IP 桶**分开实例**、互不消费（两个方向都断言）；
//	⑤ **真实失败**出口每一条都记一次账（来源不可信 400 / provider 其它错误 502）；
//	⑥ **平台自身容量**的两条 429 出口（在途流程表满 / 单 IP 在途配额满）**不**吃
//	   失败预算，改记独立计数 + 独立审计动作（2026-09-23 R6-A-4：修前它们与真实
//	   失败共用失败预算，一个 NAT 出口能在登录潮里把自己的合法流量推成 5 分钟
//	   全组织 SSO 封锁）。
//
// 另有 provider 层的 TestOIDCFlowPerIPQuotaBoundsTableHogging：那一条是"只对失败
// 计数"之后**替代**旧"成功也记账"的防滥用面（一个 IP 不能灌满流程表）。

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// oidcFlowTestAPI 装一个只注册了浏览器方式（桩 provider）的 API。
//
// 桩 provider 的 AuthURL 不触网、不落库，所以用例可以放心打几百次；
// 只有 429 分支会写一条审计（有 PG 时是真写，测试库承接）。
func oidcFlowTestAPI(t *testing.T, p BrowserProvider) (*gin.Engine, *sql.DB, *API) {
	t.Helper()
	resetSharedLimitersForTest()
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	api := New(db)
	if p == nil {
		p = &fakeBrowserProvider{name: "oidc"}
	}
	api.RegisterBrowser(p)
	r := gin.New()
	// 与 cmd/server/main.go 同口径：可信代理只含回环 ⇒ 不可信来源伪造的
	// X-Forwarded-For 不参与 ClientIP（桶键按 RemoteAddr 的 host 部分解析）。
	if err := r.SetTrustedProxies([]string{"127.0.0.1", "::1"}); err != nil {
		t.Fatal(err)
	}
	api.RegisterRoutes(r)
	return r, db, api
}

// flowLogin 发一次流程启动请求；来源 IP 由 RemoteAddr 决定（生产同口径）。
func flowLogin(t *testing.T, r *gin.Engine, ip, query string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/api/client/v2/auth/oidc/login"+query, nil)
	req.RemoteAddr = ip + ":54321"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// ① 连续成功不触发 429（修前第 oidcFlowStartMaxAttempts+1 次必 429）。
func TestOIDCFlowBucketCountsOnlyFailures(t *testing.T) {
	r, _, api := oidcFlowTestAPI(t, nil)
	const ip = "203.0.113.31"

	// 键用**唯一构造点**算出来：如果判定/记账键的形状与它不一致，
	// 下面的占用断言会读到 0（判定键 ≠ 记账键的历史缺陷形态）。
	key := oidcFlowBudgetKeyForHost(ip)

	n := 3 * oidcFlowStartMaxAttempts
	for i := 0; i < n; i++ {
		if w := flowLogin(t, r, ip, ""); w.Code != http.StatusFound {
			t.Fatalf("第 %d 次成功 SSO 流程启动 = %d %s，want 302（合法流量不得被限流）",
				i+1, w.Code, w.Body.String())
		}
	}
	if got := bucketLen(api.oidcFlowLimiter, key); got != 0 {
		t.Fatalf("成功路径占用了失败预算：%d 条，want 0（成功既不记账也不清账）", got)
	}
}

// ② 失败仍然吃预算，且预算耗尽后连**成功**的流程启动也被拒（防滥用不退化）。
func TestOIDCFlowBucketStillBlocksFailures(t *testing.T) {
	r, _, api := oidcFlowTestAPI(t, nil)
	const ip = "203.0.113.32"
	key := oidcFlowBudgetKeyForHost(ip)

	// 失败出口选"与信任边界无关"的那一条：http + 非回环 ⇒ 400（不依赖任何 env）。
	const badQuery = "?server=http://flow-fail.invalid"
	for i := 0; i < oidcFlowStartMaxAttempts; i++ {
		if w := flowLogin(t, r, ip, badQuery); w.Code != http.StatusBadRequest {
			t.Fatalf("第 %d 次失败出口状态 = %d %s，want 400", i+1, w.Code, w.Body.String())
		}
	}
	if got := bucketLen(api.oidcFlowLimiter, key); got != oidcFlowStartMaxAttempts {
		t.Fatalf("失败记账数 = %d，want %d（每个失败出口都必须记一次账）", got, oidcFlowStartMaxAttempts)
	}
	// 第 N+1 次失败 ⇒ 429。
	if w := flowLogin(t, r, ip, badQuery); w.Code != http.StatusTooManyRequests {
		t.Fatalf("预算耗尽后的失败 = %d，want 429", w.Code)
	}
	// 同一 IP 的**成功**流程启动此时也被拒（这就是"保留防滥用"的代价面：
	// 预算只由失败消耗，所以打到这里的只可能是持续失败的来源）。
	if w := flowLogin(t, r, ip, ""); w.Code != http.StatusTooManyRequests {
		t.Fatalf("预算耗尽后的成功流程启动 = %d，want 429", w.Code)
	}
	// 桶按来源 IP 计：另一个 IP 有完整预算。
	if w := flowLogin(t, r, "203.0.113.33", ""); w.Code != http.StatusFound {
		t.Fatalf("另一个来源 IP 的流程启动 = %d，want 302（桶必须按来源计）", w.Code)
	}
}

// ⑤ 每个**真实失败**出口都记一次账（表驱动：provider 返回什么错误，就归到哪个
// HTTP 码，但都必须记账）。
//
// ⚠️ 2026-09-23 R6-A-4：本表原本还列了「流程表满」与「单 IP 在途配额满」两行 ——
// 那两条**不是失败**，是平台自己的容量闸门说不。它们在登录潮里被合法流量触发，
// 记账等于"平台把自己的容量不足记成用户的错误"，并进一步把这个出口 IP 推向
// 5 分钟全组织封锁。两行的新归处见
// TestOIDCFlowCapacityRejectionsDoNotConsumeFailureBudget。
func TestOIDCFlowBucketRecordsEveryFailureExit(t *testing.T) {
	cases := []struct {
		name        string
		providerErr error
		wantStatus  int
	}{
		{"provider 其它错误", errors.New("idp unreachable"), http.StatusBadGateway},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			prov := &flowFlipProvider{name: "oidc", err: tc.providerErr}
			r, _, api := oidcFlowTestAPI(t, prov)
			const ip = "203.0.113.41"
			key := oidcFlowBudgetKeyForHost(ip)

			for i := 0; i < oidcFlowStartMaxAttempts; i++ {
				if w := flowLogin(t, r, ip, ""); w.Code != tc.wantStatus {
					t.Fatalf("第 %d 次失败状态 = %d %s，want %d", i+1, w.Code, w.Body.String(), tc.wantStatus)
				}
			}
			if got := bucketLen(api.oidcFlowLimiter, key); got != oidcFlowStartMaxAttempts {
				t.Fatalf("失败记账数 = %d，want %d（该出口漏记 ⇒ 限流可被静默绕过）",
					got, oidcFlowStartMaxAttempts)
			}
			// 预算耗尽后：provider 恢复成**会成功**的也必须 429（证明是限流器拦的，
			// 而不是 provider 一直在报错）。翻转的是同一个实例 —— 换 provider 对
			// 已注册的路由无效（见 flowFlipProvider 的注释）。
			prov.setErr(nil)
			if w := flowLogin(t, r, ip, ""); w.Code != http.StatusTooManyRequests {
				t.Fatalf("预算耗尽后（成功 provider）= %d，want 429", w.Code)
			}
		})
	}
}

// ⑥ 平台自身的**容量拒绝**不吃失败预算（2026-09-23 R6-A-4）。
//
// 修前形态：AuthURL 的两条容量哨兵（errOIDCFlowTableFull / errOIDCFlowQuotaPerIP）
// 与真实失败共用一个 recordFlowFailure() ⇒
//
//	· 一个 NAT 出口的在途流程凑到 oidcMaxFlowsPerIP（100；流程在 HandleCallback
//	  之前占位最长 10 分钟）之后，第 101 人起的**每一个**合法登录尝试都既回 429、
//	  又吃掉一格失败预算；
//	· 累计 60 次（oidcFlowStartMaxAttempts）就把整个出口 IP 的 SSO 再封 5 分钟
//	  —— 平台自己的容量闸门把受害者推向"疑似攻击者"的判定（自我强化，纯合法
//	  流量即可触发，且没有任何 env 旋钮）。
//
// 判据（三条，缺一条就说明两条通道又被合并了）：
//  1. 打满 3× 预算次容量拒绝之后，**失败桶占用必须仍是 0**；
//  2. 容量拒绝单独计数（API.OIDCFlowCapacityRejections）；
//  3. 日志可区分：审计动作是 `oidc_flow_capacity`，**不是** `login_fail`。
//
// 反证（同一次运行）：容量拒绝打满 3× 预算之后，一次**正常**的流程启动仍然 302
// —— 修前它会是 429（被自己的容量拒绝封死）。
func TestOIDCFlowCapacityRejectionsDoNotConsumeFailureBudget(t *testing.T) {
	for _, tc := range []struct {
		name        string
		providerErr error
		reason      string
	}{
		{"在途流程表满", errOIDCFlowTableFull, "flow_table_full"},
		{"单 IP 在途配额满", errOIDCFlowQuotaPerIP, "per_ip_quota"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			prov := &flowFlipProvider{name: "oidc", err: tc.providerErr}
			r, db, api := oidcFlowTestAPI(t, prov)
			const ip = "203.0.113.61"
			key := oidcFlowBudgetKeyForHost(ip)

			n := 3 * oidcFlowStartMaxAttempts
			for i := 0; i < n; i++ {
				if w := flowLogin(t, r, ip, ""); w.Code != http.StatusTooManyRequests {
					t.Fatalf("第 %d 次容量拒绝 = %d %s，want 429", i+1, w.Code, w.Body.String())
				}
			}
			if got := bucketLen(api.oidcFlowLimiter, key); got != 0 {
				t.Fatalf("容量拒绝吃掉了失败预算：占用 %d 条，want 0（R6-A-4：这会让出口 IP 自我封锁）", got)
			}
			if got := api.OIDCFlowCapacityRejections(); got != int64(n) {
				t.Fatalf("容量拒绝计数 = %d，want %d（容量拒绝必须走独立计数）", got, n)
			}
			// 日志可区分：容量拒绝记在 oidc_flow_capacity，不混进 login_fail。
			var capacityRows, failRows int
			if err := db.QueryRow(
				"SELECT COUNT(*) FROM audit_logs WHERE action = 'oidc_flow_capacity' AND detail LIKE ?",
				"%reason="+tc.reason+"%").Scan(&capacityRows); err != nil {
				t.Fatal(err)
			}
			if err := db.QueryRow(
				"SELECT COUNT(*) FROM audit_logs WHERE action = 'login_fail'").Scan(&failRows); err != nil {
				t.Fatal(err)
			}
			if capacityRows != n {
				t.Fatalf("审计里 oidc_flow_capacity 行数 = %d，want %d", capacityRows, n)
			}
			if failRows != 0 {
				t.Fatalf("容量拒绝写进了 login_fail：%d 行，want 0", failRows)
			}
			// 反证：容量拒绝没有把这个出口封死 —— 翻转同一个 provider 实例成"成功"。
			prov.setErr(nil)
			if w := flowLogin(t, r, ip, ""); w.Code != http.StatusFound {
				t.Fatalf("容量拒绝打满后正常流程 = %d %s，want 302（容量拒绝不得变成封锁）", w.Code, w.Body.String())
			}
		})
	}
}

// ④ 两个桶分开实例、互不消费（两个方向都断言）。
func TestOIDCFlowBucketIsSeparateFromLoginIPBudget(t *testing.T) {
	r, db, api := oidcFlowTestAPI(t, nil)
	// 两个方向各用一个来源 IP：方向 1 会把**流程桶**打满（60 次失败），
	// 若复用同一个 IP，方向 2 的 429 会来自流程桶而不是登录 IP 桶（假红）。
	const ipFlow = "203.0.113.34"
	const ipLogin = "203.0.113.35"

	if api.oidcFlowLimiter == api.loginIPLimiter {
		t.Fatal("流程启动桶必须与登录 IP 桶**分开实例**（共用会让两套语义互相偷预算）")
	}

	// 方向 1：60 次失败的流程启动不得消耗登录 IP 桶（修前它们共用一张表）。
	const badQuery = "?server=http://flow-fail.invalid"
	for i := 0; i < oidcFlowStartMaxAttempts; i++ {
		if w := flowLogin(t, r, ipFlow, badQuery); w.Code != http.StatusBadRequest {
			t.Fatalf("第 %d 次失败出口状态 = %d，want 400", i+1, w.Code)
		}
	}
	if got := bucketLen(sharedLoginIPLimiter(), loginIPBudgetKeyForHost(db, ipFlow)); got != 0 {
		t.Fatalf("流程启动失败污染了登录 IP 桶：%d 条，want 0", got)
	}

	// 方向 2：登录 IP 桶打满之后，流程启动仍必须有完整预算。
	// （直接记账而不真的打 60 次错密：那要跑 60 次 argon2id(64MiB)，与判据无关。）
	loginIPKey := loginIPBudgetKeyForHost(db, ipLogin)
	for i := 0; i < loginIPMaxAttempts; i++ {
		api.loginIPLimiter.record(loginIPKey)
	}
	if got := bucketLen(api.loginIPLimiter, loginIPKey); got != loginIPMaxAttempts {
		t.Fatalf("预置登录 IP 桶失败：%d 条，want %d", got, loginIPMaxAttempts)
	}
	if w := flowLogin(t, r, ipLogin, ""); w.Code != http.StatusFound {
		t.Fatalf("登录 IP 桶饱和时流程启动 = %d %s，want 302（两个桶互不消费）", w.Code, w.Body.String())
	}
}

// flowFlipProvider 是**行为可翻转**的桩 provider：AuthURL 失败与否由 err 在运行期
// 决定（用于"逐个失败出口的记账"断言，以及"限流器拦的、不是 provider 一直在报错"
// 的反证）。
//
// 为什么必须可翻转：路由在**注册时**就把 provider 实例捕获进闭包
// （RegisterRoutes 的 `for _, p := range a.browsers` + `handleOIDCLoginWith(p)`），
// 之后 `RegisterBrowser` 换一个同名 provider 对已注册的 `/oidc/login` 完全无效。
// 换 provider 的做法看着像反证，实际什么都不改（R5 的 ⑤ 用例末尾原本就是这个形态）。
type flowFlipProvider struct {
	name string
	mu   sync.Mutex
	err  error
}

func (p *flowFlipProvider) Name() string { return p.name }
func (p *flowFlipProvider) setErr(err error) {
	p.mu.Lock()
	p.err = err
	p.mu.Unlock()
}
func (p *flowFlipProvider) AuthURL(state, _, _ string) (string, error) {
	p.mu.Lock()
	err := p.err
	p.mu.Unlock()
	if err != nil {
		return "", err
	}
	return "https://idp.example/auth?state=" + state, nil
}
func (p *flowFlipProvider) HandleCallback(string, string) (UserInfo, error) {
	return UserInfo{}, nil
}
func (p *flowFlipProvider) Configure(map[string]string) error { return nil }

// ⑤' provider 层：单 IP 在途流程配额（"只对失败计数"之后的防滥用面）。
//
// 场景：一个 IP 反复建流程却从不回调消费，试图灌满共享流程表
// （表满即 fail-closed ⇒ 全组织 10 分钟 TTL 内起不了新流程）。
// 配额与速率无关，所以合法用户（流程秒级被回调消费）永远碰不到它。
func TestOIDCFlowPerIPQuotaBoundsTableHogging(t *testing.T) {
	p := &OIDCProvider{name: "oidc"}
	p.flows = map[string]*oidcFlow{}
	const hog = "203.0.113.51"

	for i := 0; i < oidcMaxFlowsPerIP; i++ {
		if _, err := p.AuthURL(fmt.Sprintf("hog-%d", i), "", hog); err != nil {
			t.Fatalf("配额内第 %d 条流程应被接受: %v", i+1, err)
		}
	}
	if _, err := p.AuthURL("hog-over", "", hog); !errors.Is(err, errOIDCFlowQuotaPerIP) {
		t.Fatalf("单 IP 超过在途配额必须拒（否则一个 IP 就能灌满流程表）: %v", err)
	}
	// 配额是按来源计的：另一个 IP 不受影响（表还没满）。
	if _, err := p.AuthURL("other-0", "", "203.0.113.52"); err != nil {
		t.Fatalf("另一个来源 IP 应仍有配额: %v", err)
	}
	// 回调消费掉一条之后，该 IP 立刻恢复名额（配额不是"一次用满就永久拉黑"）。
	// 桩 provider 没有 token endpoint，Exchange 必然报错，但 state 已被删除。
	_, _ = p.HandleCallback("code", "hog-0")
	if _, err := p.AuthURL("hog-after-callback", "", hog); err != nil {
		t.Fatalf("消费一条流程后该 IP 应恢复配额: %v", err)
	}
	// 空 clientIP 共用同一个"未知来源"桶（fail-closed：调用方忘了解析 IP 时
	// 不会静默跳过配额，而是所有此类调用共享一份配额）。
	for i := 0; i < oidcMaxFlowsPerIP; i++ {
		if _, err := p.AuthURL(fmt.Sprintf("noip-%d", i), "", ""); err != nil {
			t.Fatalf("空来源 IP 的第 %d 条流程应被接受: %v", i+1, err)
		}
	}
	if _, err := p.AuthURL("noip-over", "", ""); !errors.Is(err, errOIDCFlowQuotaPerIP) {
		t.Fatalf("空来源 IP 也必须受配额约束（fail-closed）: %v", err)
	}
}
