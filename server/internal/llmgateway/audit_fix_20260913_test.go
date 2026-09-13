package llmgateway

// 审计 2026-09-13 P2-8/P2-11/P3-3 的永久回归测试。

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/llmgateway/channels"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// P2-11:单用户并发准入必须有界且正确归还(旧实现无任何准入闸门)。
func TestAuditFixPerUserInflightIsBounded(t *testing.T) {
	const max = 3
	var releases []func()
	for i := 0; i < max; i++ {
		rel, ok := gatewayInflight.acquire(42, max)
		if !ok {
			t.Fatalf("第 %d 个并发应放行", i+1)
		}
		releases = append(releases, rel)
	}
	if _, ok := gatewayInflight.acquire(42, max); ok {
		t.Fatal("超出上限仍放行(单员工可无限并发打满全站)")
	}
	// 其它用户不受影响
	if rel, ok := gatewayInflight.acquire(43, max); !ok {
		t.Fatal("其它用户被误伤")
	} else {
		rel()
	}
	releases[0]()
	if rel, ok := gatewayInflight.acquire(42, max); !ok {
		t.Fatal("归还后应可再次获取")
	} else {
		rel()
	}
	for _, rel := range releases[1:] {
		rel()
	}
	// 归零后键应被清理(表不随用户数增长)
	gatewayInflight.mu.Lock()
	if n := len(gatewayInflight.active); n != 0 {
		gatewayInflight.mu.Unlock()
		t.Fatalf("计数归零后仍残留 %d 个键", n)
	}
	gatewayInflight.mu.Unlock()
}

// P2-8:pending 清理阈值必须远超流式请求的真实上限(旧值 1h 会让长流零计费)。
func TestAuditFixPendingUsageRetentionExceedsStreamLifetime(t *testing.T) {
	if pendingUsageRetention < 2*time.Hour {
		t.Fatalf("pendingUsageRetention = %v, 至少应 2h(否则长流 pending 行被删后回填必失败)", pendingUsageRetention)
	}
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: "p2", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	// 插入一条 2 小时前的 pending 行(0 token,kind=chat)
	id, err := serverstore.RecordUsageKind(db, uid, "m", 0, 0, billingKindChat)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE usage SET created_at = now() - interval '2 hours' WHERE id = ?`, id); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.CleanupPendingUsage(db, time.Now().Add(-pendingUsageRetention)); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM usage WHERE id = ?`, id).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatal("2 小时前的 pending 行被清理(阈值过短,长流回填会失败)")
	}
	// 真正的残留(超过阈值)仍要清理
	if err := serverstore.CleanupPendingUsage(db, time.Now().Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM usage WHERE id = ?`, id).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatal("超期 pending 行未被清理")
	}
}

// P3-3:余额查询不得跟随重定向(与报表 webhook 同口径)。
func TestAuditFixBalanceClientRejectsRedirect(t *testing.T) {
	if balanceHTTPClient.CheckRedirect == nil {
		t.Fatal("余额查询 client 未禁止重定向(可被上游 302 引向内网)")
	}
	req, _ := http.NewRequest(http.MethodGet, "http://example.com/user/balance", nil)
	if err := balanceHTTPClient.CheckRedirect(req, nil); err != http.ErrUseLastResponse {
		t.Fatalf("CheckRedirect = %v, want ErrUseLastResponse", err)
	}
}

// P2-5:渠道同步必须打 provider **自己的 base_url** —— 旧实现一律用渠道硬编码
// URL(api.deepseek.com),于是"channel=deepseek + 自定义 base_url"的自建代理
// 会被每小时把自家 key 发往厂商端点。
func TestAuditFixProviderSyncUsesOwnBaseURL(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()

	ch, ok := channels.Get("deepseek")
	if !ok {
		t.Fatal("deepseek 渠道未注册")
	}
	// provider 配了自定义 base_url(自建代理)
	p := &serverstore.GatewayProvider{
		ID: 1, Name: "self-hosted", BaseURL: "https://proxy.internal.example/v1",
		Channel: "deepseek", Enabled: 1,
	}
	if _, err := db.Exec(`INSERT INTO gateway_providers (id, name, base_url, api_key_enc, models, channel, protocol)
		VALUES (1, 'self-hosted', 'https://proxy.internal.example/v1', 'k', '[]', 'deepseek', 'openai')`); err != nil {
		t.Fatal(err)
	}
	var hit string
	fetchFn := func(url string) ([]byte, error) {
		hit = url
		return []byte(`{"data":[{"id":"m1","owned_by":"x"}]}`), nil
	}
	res := SyncProvider(db, ch, p, "proxy-secret-key", fetchFn)
	if res.Error != "" {
		t.Fatalf("sync error: %s", res.Error)
	}
	if !strings.HasPrefix(hit, "https://proxy.internal.example/v1") {
		t.Fatalf("同步打到了 %q —— 必须用 provider 自己的 base_url(否则自定义代理的 key 会被发往渠道厂商端点)", hit)
	}
	if strings.Contains(hit, "api.deepseek.com") {
		t.Fatalf("同步打到渠道硬编码 URL: %q", hit)
	}
}
