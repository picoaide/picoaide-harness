package llmgateway

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// P3 回归:余额响应体必须有上限(此前 json.NewDecoder 直读 resp.Body)。
// 上游返回超大体时解码在 1MB 处截断 → 报错,不会把整个响应读进内存。
func TestFetchDeepSeekBalanceBoundsResponseBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// 先写一个足够长的字符串字段(> maxBalanceBody),再收尾。
		fmt.Fprint(w, `{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"`)
		fmt.Fprint(w, strings.Repeat("9", 2<<20))
		fmt.Fprint(w, `"}]}`)
	}))
	defer srv.Close()

	if _, _, err := fetchDeepSeekBalance(srv.URL, "sk-test"); err == nil {
		t.Fatal("oversized balance body decoded without error, want truncation error")
	}
}

// 正常小响应仍然可解析(上限不改变正常语义)。
func TestFetchDeepSeekBalanceNormal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"is_available": true,
			"balance_infos": []map[string]string{{
				"currency": "CNY", "total_balance": "12.34",
			}},
		})
	}))
	defer srv.Close()

	ok, infos, err := fetchDeepSeekBalance(srv.URL, "sk-test")
	if err != nil {
		t.Fatal(err)
	}
	if !ok || len(infos) != 1 || infos[0].TotalBalance != "12.34" {
		t.Fatalf("balance = %v %+v", ok, infos)
	}
}
