package marketplace

import (
	"database/sql"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

// seedMCP adds an enabled plugin with encrypted credentials and a disabled
// one; returns their ids.
func seedMCP(t *testing.T, db *sql.DB, api *API) (int64, int64) {
	t.Helper()
	key, err := util.EnsureMasterKey(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	env := EncryptEnv(key, map[string]string{
		"API_KEY": "secret-123",
		"TIMEOUT": "30",
	})
	headers := EncryptEnv(key, map[string]string{"Authorization": "Bearer hdr-secret"})
	id, err := serverstore.AddMCPServer(db, &serverstore.MCPServer{
		Name: "files", Description: "files plugin", Transport: "stdio",
		Command: "node", Args: []string{"server.js"},
		Env: env, Headers: headers, Enabled: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	off, err := serverstore.AddMCPServer(db, &serverstore.MCPServer{
		Name: "hidden", Description: "off", Transport: "stdio", Enabled: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	return id, off
}

func TestMCPAPI(t *testing.T) {
	r, db, token, api := newTestRouter(t)
	id, offID := seedMCP(t, db, api)

	// list: enabled only, all env/headers values masked
	w := doReq(r, "GET", "/api/marketplace/mcp", token)
	if w.Code != http.StatusOK {
		t.Fatalf("list status = %d, body %s", w.Code, w.Body.String())
	}
	var list struct {
		MCP []map[string]any `json:"mcp"`
	}
	decodeJSON(t, w, &list)
	if len(list.MCP) != 1 {
		t.Fatalf("mcp list = %+v", list.MCP)
	}
	m := list.MCP[0]
	if m["name"] != "files" || m["command"] != "node" || m["description"] != "files plugin" {
		t.Fatalf("mcp entry = %+v", m)
	}
	env, _ := m["env"].(map[string]any)
	hdr, _ := m["headers"].(map[string]any)
	if env["API_KEY"] != "***" || env["TIMEOUT"] != "***" || hdr["Authorization"] != "***" {
		t.Fatalf("masked env/headers = %v %v", env, hdr)
	}

	// config: full decrypted env/headers with a valid token
	w = doReq(r, "GET", "/api/marketplace/mcp/"+strconv.FormatInt(id, 10)+"/config", token)
	if w.Code != http.StatusOK {
		t.Fatalf("config status = %d, body %s", w.Code, w.Body.String())
	}
	var cfg struct {
		Config struct {
			Env     map[string]string `json:"env"`
			Headers map[string]string `json:"headers"`
		} `json:"config"`
	}
	decodeJSON(t, w, &cfg)
	if cfg.Config.Env["API_KEY"] != "secret-123" || cfg.Config.Env["TIMEOUT"] != "30" {
		t.Fatalf("decrypted env = %v", cfg.Config.Env)
	}
	if cfg.Config.Headers["Authorization"] != "Bearer hdr-secret" {
		t.Fatalf("decrypted headers = %v", cfg.Config.Headers)
	}

	// no token -> 401
	for _, p := range []string{"/api/marketplace/mcp", "/api/marketplace/mcp/" + strconv.FormatInt(id, 10) + "/config"} {
		if w := doReq(r, "GET", p, ""); w.Code != http.StatusUnauthorized {
			t.Fatalf("no-token %s = %d", p, w.Code)
		}
	}

	// disabled plugin -> 404
	w = doReq(r, "GET", "/api/marketplace/mcp/"+strconv.FormatInt(offID, 10)+"/config", token)
	if w.Code != http.StatusNotFound || !hasErrCode(w, "NOT_FOUND") {
		t.Fatalf("disabled config = %d, body %s", w.Code, w.Body.String())
	}
	// unknown id -> 404
	w = doReq(r, "GET", "/api/marketplace/mcp/99999/config", token)
	if w.Code != http.StatusNotFound || !hasErrCode(w, "NOT_FOUND") {
		t.Fatalf("unknown config = %d, body %s", w.Code, w.Body.String())
	}
	// bad id -> 400
	if w := doReq(r, "GET", "/api/marketplace/mcp/abc/config", token); w.Code != http.StatusBadRequest {
		t.Fatalf("bad id = %d", w.Code)
	}

	// rate limit: only 2 fetches allowed per window
	api.configRateLimit = 2
	path := "/api/marketplace/mcp/" + strconv.FormatInt(id, 10) + "/config"
	if w := doReq(r, "GET", path, token); w.Code != http.StatusOK {
		t.Fatalf("fetch 2 = %d", w.Code)
	}
	if w := doReq(r, "GET", path, token); w.Code != http.StatusTooManyRequests || !hasErrCode(w, "RATE_LIMITED") {
		t.Fatalf("fetch 3 = %d, body %s", w.Code, w.Body.String())
	}
}

// C-11: the check-then-act window between "allowed?" and "count" must be
// closed — concurrent fetches may never exceed the per-user budget.
func TestMCPConfigLimitConcurrent(t *testing.T) {
	r, db, token, api := newTestRouter(t)
	id, _ := seedMCP(t, db, api)
	api.configRateLimit = 2
	path := "/api/marketplace/mcp/" + strconv.FormatInt(id, 10) + "/config"

	var ok, limited int32
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := doReq(r, "GET", path, token)
			switch w.Code {
			case http.StatusOK:
				atomic.AddInt32(&ok, 1)
			case http.StatusTooManyRequests:
				atomic.AddInt32(&limited, 1)
			}
		}()
	}
	wg.Wait()
	if ok != 2 || limited != 18 {
		t.Fatalf("ok=%d limited=%d, want exactly 2/18 (atomic budget take)", ok, limited)
	}
}

// C-11b: stale rate counters are pruned so the map cannot grow unbounded.
func TestMCPConfigLimitPrunesStale(t *testing.T) {
	api := NewAPI(nil, "")
	api.configHits[7] = &rateCounter{windowStart: time.Now().Add(-2 * time.Hour), count: 99}
	api.configHits[8] = &rateCounter{windowStart: time.Now(), count: 1}
	api.configTake(9) // any take prunes while the map is large
	if _, ok := api.configHits[7]; ok {
		t.Fatal("stale counter not pruned")
	}
	if _, ok := api.configHits[8]; !ok {
		t.Fatal("fresh counter wrongly pruned")
	}
}
