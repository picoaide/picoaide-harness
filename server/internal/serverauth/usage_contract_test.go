package serverauth

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// 跨语言契约守卫(2026-09-11):`/api/client/v2/auth/usage` 的键集合必须与客户端
// 唯一契约 `packages/client/account-card/src/usage-contract.ts` 的
// USAGE_PAYLOAD_KEYS 完全一致。任一侧增删字段而不同步 → 本用例失败。
//
// 背景:此前客户端有两份手写 interface 且都没有 balance 字段,服务端改了字段
// 只会静默失效(旧 E2E fixture 多包一层 data 就造成过"字段全空但测试通过")。
func TestUsagePayloadContractMatchesClient(t *testing.T) {
	r, db, cleanup := newTestAPI(t)
	defer cleanup()
	createUser(t, db, "alice", "Alice@123", false)
	token := loginToken(t, r, "alice", "Alice@123")
	w, out := doJSON(t, r, "GET", "/api/client/v2/auth/usage", "",
		map[string]string{"Authorization": "Bearer " + token})
	if w.Code != http.StatusOK {
		t.Fatalf("usage status = %d body=%s", w.Code, w.Body.String())
	}
	serverKeys := make([]string, 0, len(out))
	for k := range out {
		serverKeys = append(serverKeys, k)
	}
	sort.Strings(serverKeys)

	clientKeys := usageContractKeys(t)
	if len(clientKeys) == 0 {
		t.Fatal("未能从 usage-contract.ts 解析 USAGE_PAYLOAD_KEYS")
	}
	if strings.Join(serverKeys, ",") != strings.Join(clientKeys, ",") {
		t.Fatalf("契约漂移:\n server = %v\n client = %v\n"+
			"两侧必须同步(server/internal/serverauth/handler.go ↔ packages/client/account-card/src/usage-contract.ts)",
			serverKeys, clientKeys)
	}
}

// usageContractKeys 从客户端契约文件解析 USAGE_PAYLOAD_KEYS(仓库内相对路径)。
func usageContractKeys(t *testing.T) []string {
	t.Helper()
	// 测试工作目录 = server/internal/serverauth;契约在仓库根的 packages/ 下。
	candidates := []string{
		filepath.Join("..", "..", "..", "packages", "client", "account-card", "src", "usage-contract.ts"),
		filepath.Join("..", "..", "packages", "client", "account-card", "src", "usage-contract.ts"),
	}
	var raw []byte
	var err error
	for _, c := range candidates {
		if raw, err = os.ReadFile(c); err == nil {
			break
		}
	}
	if err != nil {
		t.Skipf("客户端契约文件不可达(独立构建 server 目录时跳过): %v", err)
	}
	re := regexp.MustCompile(`(?s)USAGE_PAYLOAD_KEYS\s*=\s*\[(.*?)\]`)
	m := re.FindSubmatch(raw)
	if m == nil {
		t.Fatalf("usage-contract.ts 中找不到 USAGE_PAYLOAD_KEYS")
	}
	var keys []string
	for _, line := range strings.Split(string(m[1]), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "//") {
			continue
		}
		line = strings.TrimSuffix(strings.TrimSpace(strings.TrimSuffix(line, ",")), ",")
		if uq, uerr := strconvUnquote(line); uerr == nil {
			keys = append(keys, uq)
		}
	}
	sort.Strings(keys)
	return keys
}

// strconvUnquote 解析 TS 里的单引号字符串字面量。
func strconvUnquote(s string) (string, error) {
	var out string
	if err := json.Unmarshal([]byte(`"`+strings.Trim(s, `'"`)+`"`), &out); err != nil {
		return "", err
	}
	return out, nil
}
