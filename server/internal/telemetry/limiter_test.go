package telemetry

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// withLimits 替换限流阈值与限流器(测试隔离)。
func withLimits(t *testing.T, perUser, perSkill int) {
	t.Helper()
	prevUser, prevSkill, prevLimiter := perUserLimitPerMin, perSkillLimitPerMin, skillCallLimiter
	perUserLimitPerMin, perSkillLimitPerMin = perUser, perSkill
	skillCallLimiter = newCallLimiter(time.Minute)
	t.Cleanup(func() {
		perUserLimitPerMin, perSkillLimitPerMin, skillCallLimiter = prevUser, prevSkill, prevLimiter
	})
}

// P2-20 回归:同一用户超过每分钟上限后 429,且不再累加 calls(刷榜无效)。
func TestSkillCallRateLimitedPerUser(t *testing.T) {
	r, db, token := newTestEnv(t)
	withLimits(t, 2, 100)
	if _, err := serverstore.AddSkill(db, &serverstore.Skill{Name: "codeql", Version: "1.0.0", Enabled: 1, Archive: []byte("pkg")}); err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 2; i++ {
		if w := post(r, token, "/api/client/v2/telemetry/skill-call", `{"name":"codeql"}`); w.Code != http.StatusOK {
			t.Fatalf("call %d = %d %s", i+1, w.Code, w.Body.String())
		}
	}
	w := post(r, token, "/api/client/v2/telemetry/skill-call", `{"name":"codeql"}`)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("3rd call = %d, want 429", w.Code)
	}
	if !strings.Contains(w.Body.String(), "RATE_LIMITED") {
		t.Fatalf("429 body = %s, want RATE_LIMITED envelope", w.Body.String())
	}
	s, err := serverstore.GetSkill(db, "codeql")
	if err != nil {
		t.Fatal(err)
	}
	if s.Calls != 2 {
		t.Fatalf("calls = %d, want 2 (rate-limited report must not count)", s.Calls)
	}
}

// 单技能桶:同一技能反复上报受限,其他技能不受影响(防单 App 刷票)。
func TestSkillCallRateLimitedPerSkill(t *testing.T) {
	r, db, token := newTestEnv(t)
	withLimits(t, 100, 1)
	for _, name := range []string{"skill-a", "skill-b"} {
		if _, err := serverstore.AddSkill(db, &serverstore.Skill{Name: name, Version: "1.0.0", Enabled: 1, Archive: []byte("pkg")}); err != nil {
			t.Fatal(err)
		}
	}
	if w := post(r, token, "/api/client/v2/telemetry/skill-call", `{"name":"skill-a"}`); w.Code != http.StatusOK {
		t.Fatalf("skill-a first = %d", w.Code)
	}
	if w := post(r, token, "/api/client/v2/telemetry/skill-call", `{"name":"skill-a"}`); w.Code != http.StatusTooManyRequests {
		t.Fatalf("skill-a second = %d, want 429", w.Code)
	}
	if w := post(r, token, "/api/client/v2/telemetry/skill-call", `{"name":"skill-b"}`); w.Code != http.StatusOK {
		t.Fatalf("skill-b first = %d, want 200 (per-skill bucket)", w.Code)
	}
}

// 限流按用户隔离:一个账号被限不影响其他账号。
func TestSkillCallRateLimitIsPerUser(t *testing.T) {
	r, db, token := newTestEnv(t)
	withLimits(t, 1, 100)
	uid2, err := serverstore.CreateUserWithPassword(db, "bob", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	token2, err := serverauth.IssueToken(db, uid2)
	if err != nil {
		t.Fatal(err)
	}
	if w := post(r, token, "/api/client/v2/telemetry/skill-call", `{"name":"codeql"}`); w.Code != http.StatusOK {
		t.Fatalf("alice first = %d", w.Code)
	}
	if w := post(r, token, "/api/client/v2/telemetry/skill-call", `{"name":"codeql"}`); w.Code != http.StatusTooManyRequests {
		t.Fatalf("alice second = %d, want 429", w.Code)
	}
	if w := post(r, token2, "/api/client/v2/telemetry/skill-call", `{"name":"codeql"}`); w.Code != http.StatusOK {
		t.Fatalf("bob first = %d, want 200 (per-user bucket)", w.Code)
	}
}

// 非法请求不消耗上报预算(限流在校验之后)。
func TestSkillCallInvalidRequestDoesNotConsumeBudget(t *testing.T) {
	r, _, token := newTestEnv(t)
	withLimits(t, 1, 100)
	if w := post(r, token, "/api/client/v2/telemetry/skill-call", `{"name":"a/b"}`); w.Code != http.StatusBadRequest {
		t.Fatalf("invalid name = %d, want 400", w.Code)
	}
	if w := post(r, token, "/api/client/v2/telemetry/skill-call", `{"name":"codeql"}`); w.Code != http.StatusOK {
		t.Fatalf("valid call after invalid = %d, want 200", w.Code)
	}
}
