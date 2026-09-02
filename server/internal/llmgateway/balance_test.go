package llmgateway

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestBalanceSupports(t *testing.T) {
	cases := []struct {
		base, name string
		want       bool
	}{
		{"https://api.deepseek.com", "DeepSeek", true},
		{"https://api.deepseek.com/v1", "deepseek-official", true},
		{"https://api.openai.com", "OpenAI", false},
		{"https://my-proxy.example.com", "DeepSeek Proxy", true}, // 名称含 deepseek → 支持
	}
	for _, c := range cases {
		if got := balanceSupports(c.base, c.name); got != c.want {
			t.Fatalf("balanceSupports(%q,%q) = %v, want %v", c.base, c.name, got, c.want)
		}
	}
}

func TestFetchDeepSeekBalance(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/user/balance" {
			t.Fatalf("path = %q, want /user/balance", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer sk-test" {
			t.Fatalf("auth = %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"110.00","granted_balance":"10.00","topped_up_balance":"100.00"}]}`))
	}))
	defer srv.Close()

	old := balanceHTTPClient
	defer func() { balanceHTTPClient = old }()
	balanceHTTPClient = srv.Client()

	avail, infos, err := fetchDeepSeekBalance(srv.URL, "sk-test")
	if err != nil {
		t.Fatal(err)
	}
	if !avail || len(infos) != 1 {
		t.Fatalf("avail/infos = %v %v", avail, infos)
	}
	if infos[0].Currency != "CNY" || infos[0].TotalBalance != "110.00" {
		t.Fatalf("info = %+v", infos[0])
	}
}

func TestFetchDeepSeekBalanceUpstreamError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
	}))
	defer srv.Close()
	old := balanceHTTPClient
	defer func() { balanceHTTPClient = old }()
	balanceHTTPClient = srv.Client()

	if _, _, err := fetchDeepSeekBalance(srv.URL, "sk"); err == nil {
		t.Fatal("want error on non-200")
	}
}
