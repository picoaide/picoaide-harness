# Channel Pack + Auto Model Sync 实施计划

> **2026-08-19 注记**:自研 Electron 客户端(desktop/)与浏览器插件已下线删除,仓库仅保留服务端接口与 webadmin 管理端。本文档为历史设计与计划,服务端相关部分仍有效,客户端相关部分不再适用。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 服务端引入内置预置渠道包(每渠道一个文件,先 deepseek),自动从上游 `/models` 拉取模型并上架/下架,为 DeepSeek 强制注入思考模式参数,客户端经 OpenAI 兼容接口直用。

**Architecture:** 新增 `internal/llmgateway/channels/`(Channel 接口 + 注册表 + deepseek 实现)+ `sync.go`(定时同步器);`gateway_providers` 加 `channel` 列(迁移 0010);网关 `forward` 前按渠道/模型注入请求参数;webadmin 网关页加渠道下拉、模型能力展示、手动同步。

**Tech Stack:** Go 1.26、gin、modernc sqlite、React+shadcn(webadmin)、vitest/go test。

---

## 文件结构

- `internal/llmgateway/channels/channel.go` — Channel 接口、ModelInfo、注册表、公共注入逻辑
- `internal/llmgateway/channels/deepseek.go` — deepseek 渠道
- `internal/llmgateway/channels/channel_test.go` — 接口/注册表/deepseek 单测
- `internal/llmgateway/sync.go` — SyncOnce + SyncLoop(注入 fetchFn 可测)
- `internal/llmgateway/sync_test.go` — 同步测试
- `internal/serverstore/migrations/0010_channel.sql` — 迁移
- `internal/serverstore/gateway.go` — GatewayProvider 加 Channel 字段、SQL 列、SyncProviderModels 扩展
- `internal/llmgateway/handler.go` — forward 前注入渠道参数
- `internal/llmgateway/handler_test.go` — 注入测试
- `internal/llmgateway/admin.go` — provider channel 字段、channels 列表、手动同步端点
- `internal/llmgateway/admin_test.go` — 对应测试
- `cmd/server/main.go` — 启动 SyncLoop
- `webadmin/src/pages/Gateway.tsx` — 渠道下拉、模型能力展示、立即同步按钮
- `webadmin/src/App.tsx`(如需)

---

### Task 1: 迁移 0010 + GatewayProvider.Channel

**Files:**
- Create: `internal/serverstore/migrations/0010_channel.sql`
- Modify: `internal/serverstore/gateway.go`

- [ ] **Step 1: 写失败测试**

修改 `internal/serverstore/gateway_test.go`(若不存在则新建),断言 Channel 字段可读写:

```go
func TestGatewayProviderChannelField(t *testing.T) {
	db, err := EnsureMigrated(fmt.Sprintf("%s/ch.db", t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	p := &GatewayProvider{Name: "deepseek", BaseURL: "https://api.deepseek.com", APIKeyEnc: "enc:x", Models: []string{"m1"}, Channel: "deepseek", Enabled: 1}
	id, err := AddGatewayProvider(db, p)
	if err != nil {
		t.Fatal(err)
	}
	got, err := GetGatewayProvider(db, id)
	if err != nil {
		t.Fatal(err)
	}
	if got.Channel != "deepseek" {
		t.Fatalf("Channel = %q, want deepseek", got.Channel)
	}
}
```

(确保文件 import `fmt`、`testing`。)

- [ ] **Step 2: 运行测试确认失败**

Run: `go test ./internal/serverstore/ -run TestGatewayProviderChannelField -v`
Expected: FAIL,`no such column: channel` 或编译错误(GatewayProvider 无 Channel 字段)

- [ ] **Step 3: 创建迁移文件**

Create `internal/serverstore/migrations/0010_channel.sql`:

```sql
ALTER TABLE gateway_providers ADD COLUMN channel TEXT NOT NULL DEFAULT '';
```

- [ ] **Step 4: 扩展 GatewayProvider 结构与 SQL**

`internal/serverstore/gateway.go`:
- struct 加字段 `Channel string`
- `scanProvider` 的 Scan 列表加 `&p.Channel`(列顺序:`id, name, base_url, api_key_enc, models, enabled, channel`)
- `ListGatewayProviders`/`GetGatewayProvider`/`AddGatewayProvider`/`UpdateGatewayProvider` 的 SQL 加 `channel` 列与 `p.Channel` 值

注意:SQLite 对 ALTER TABLE 加列,旧的 `SELECT id, name, base_url, api_key_enc, models, enabled` 不报错,但需更新为含 channel 才能读到新值。

- [ ] **Step 5: 运行测试确认通过**

Run: `go test ./internal/serverstore/ -run TestGatewayProviderChannelField -v`
Expected: PASS

- [ ] **Step 6: 全量 serverstore 回归**

Run: `go test ./internal/serverstore/`
Expected: ok

- [ ] **Step 7: Commit**

```bash
git add internal/serverstore/migrations/0010_channel.sql internal/serverstore/gateway.go internal/serverstore/gateway_test.go
git commit -m "feat: add channel column to gateway_providers (migration 0010)"
```

---

### Task 2: Channel 接口 + 注册表 + 注入公共逻辑

**Files:**
- Create: `internal/llmgateway/channels/channel.go`
- Create: `internal/llmgateway/channels/channel_test.go`

- [ ] **Step 1: 写失败测试**

Create `internal/llmgateway/channels/channel_test.go`:

```go
package channels

import (
	"context"
	"testing"
)

type stubChannel struct{ name, base string }

func (s stubChannel) Name() string                       { return s.name }
func (s stubChannel) BaseURL() string                    { return s.base }
func (s stubChannel) FetchModels(ctx context.Context, apiKey string, fetchFn func(url string) ([]byte, error)) ([]ModelInfo, error) {
	return []ModelInfo{{ID: "m1"}}, nil
}
func (s stubChannel) RequestOverrides(modelID string) (map[string]any, []string) {
	return map[string]any{"thinking": map[string]any{"type": "enabled"}}, []string{"temperature"}
}
func (s stubChannel) DefaultModelCaps() (int64, int64) { return 1048576, 393216 }

func TestRegistryLookup(t *testing.T) {
	if _, ok := Get("deepseek"); !ok {
		t.Fatal("Get(deepseek) not found")
	}
	if _, ok := Get("nope"); ok {
		t.Fatal("Get(nope) should be missing")
	}
	if len(All()) == 0 {
		t.Fatal("All() empty")
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `go test ./internal/llmgateway/channels/`
Expected: 编译失败(`package channels is not in std` / 目录不存在)。先 `mkdir -p internal/llmgateway/channels` 再跑。

- [ ] **Step 3: 写 Channel 接口与注册表**

Create `internal/llmgateway/channels/channel.go`:

```go
package channels

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sort"
)

// ModelInfo 是从上游拉取的单个模型信息。长度字段 0 表示未知,用渠道预设兜底。
type ModelInfo struct {
	ID          string
	DisplayName string
	ContextLen  int64
	MaxOutput   int64
}

type Channel interface {
	Name() string
	BaseURL() string
	// GET /models,解析 OpenAI 兼容 data[];fetchFn 可注入便于测试
	FetchModels(ctx context.Context, apiKey string, fetchFn func(url string) ([]byte, error)) ([]ModelInfo, error)
	// 请求体覆盖:overrides 深合并进请求体,removeKeys 从请求体删除
	RequestOverrides(modelID string) (overrides map[string]any, removeKeys []string)
	// 能力预设(FetchModels 响应无值时的兜底)
	DefaultModelCaps() (contextLen, maxOutput int64)
}

var registry = map[string]Channel{}

// Register 由各渠道包 init() 调用。
func Register(c Channel) { registry[c.Name()] = c }

// Get 按名取渠道。
func Get(name string) (Channel, bool) { c, ok := registry[name]; return c, ok }

// All 返回已注册渠道名(排序)。
func All() []string {
	names := make([]string, 0, len(registry))
	for n := range registry {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// HTTPFetch 默认 fetchFn:GET url + Bearer key,返回响应体。
func HTTPFetch(url, apiKey string) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errUpstream
	}
	return io.ReadAll(resp.Body)
}

type oaiModelsResponse struct {
	Data []struct {
		ID string `json:"id"`
	} `json:"data"`
}

// ParseOAIModels 解析 OpenAI 兼容 /models 响应。
func ParseOAIModels(body []byte) ([]ModelInfo, error) {
	var resp oaiModelsResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, err
	}
	out := make([]ModelInfo, 0, len(resp.Data))
	for _, m := range resp.Data {
		out = append(out, ModelInfo{ID: m.ID, DisplayName: m.ID})
	}
	return out, nil
}
```

在 `channel.go` 顶部加 `var errUpstream = errors.New("upstream error")`(import errors)。

- [ ] **Step 4: 运行测试确认通过**

Run: `go test ./internal/llmgateway/channels/`
Expected: 现在仍需 deepseek 注册才会过 `TestRegistryLookup` 的 `Get(deepseek)`。**先实现 deepseek(Task 3),再回来跑本测试**。为不阻塞,可暂时在 channel_test 用 stub 注册验证注册表机制:

在测试里先 `Register(stubChannel{name: "stub"})`,断言 `Get("stub")`。deepseek 就绪后再断言 deepseek。

调整 `TestRegistryLookup`:

```go
func TestRegistryLookup(t *testing.T) {
	Register(stubChannel{name: "stub", base: "http://stub"})
	if _, ok := Get("stub"); !ok {
		t.Fatal("Get(stub) not found")
	}
	if len(All()) == 0 {
		t.Fatal("All() empty")
	}
}
```

- [ ] **Step 5: Commit**

```bash
git add internal/llmgateway/channels/channel.go internal/llmgateway/channels/channel_test.go
git commit -m "feat: channel interface, registry, oai models parser"
```

---

### Task 3: DeepSeek 渠道

**Files:**
- Create: `internal/llmgateway/channels/deepseek.go`
- Modify: `internal/llmgateway/channels/channel_test.go`

- [ ] **Step 1: 写失败测试**

在 `channel_test.go` 加:

```go
func TestDeepSeekFetchModels(t *testing.T) {
	fetchFn := func(url string) ([]byte, error) {
		if url != "https://api.deepseek.com/models" {
			t.Fatalf("url = %s", url)
		}
		return []byte(`{"object":"list","data":[{"id":"deepseek-v4-flash"},{"id":"deepseek-v4-pro"}]}`), nil
	}
	ms, err := Get("deepseek").FetchModels(context.Background(), "k", fetchFn)
	if err != nil {
		t.Fatal(err)
	}
	if len(ms) != 2 || ms[0].ID != "deepseek-v4-flash" || ms[1].ID != "deepseek-v4-pro" {
		t.Fatalf("models = %+v", ms)
	}
}

func TestDeepSeekOverrides(t *testing.T) {
	ov, rm := Get("deepseek").RequestOverrides("deepseek-v4-flash")
	if ov["reasoning_effort"] != "max" {
		t.Fatalf("reasoning_effort = %v", ov["reasoning_effort"])
	}
	thinking, _ := ov["thinking"].(map[string]any)
	if thinking["type"] != "enabled" {
		t.Fatalf("thinking = %v", ov["thinking"])
	}
	want := map[string]bool{"temperature": true, "top_p": true, "presence_penalty": true, "frequency_penalty": true}
	if len(rm) != 4 {
		t.Fatalf("removeKeys = %v", rm)
	}
	for _, k := range rm {
		if !want[k] {
			t.Fatalf("unexpected removeKey %q", k)
		}
	}
}

func TestDeepSeekCaps(t *testing.T) {
	cl, mo := Get("deepseek").DefaultModelCaps()
	if cl != 1048576 || mo != 393216 {
		t.Fatalf("caps = %d/%d", cl, mo)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `go test ./internal/llmgateway/channels/ -run TestDeepSeek`
Expected: FAIL(`Get("deepseek")` 不存在)

- [ ] **Step 3: 实现 deepseek.go**

Create `internal/llmgateway/channels/deepseek.go`:

```go
package channels

import "context"

// DeepSeek 渠道:官方 OpenAI 兼容 API。
type DeepSeek struct{}

func init() { Register(DeepSeek{}) }

func (DeepSeek) Name() string    { return "deepseek" }
func (DeepSeek) BaseURL() string { return "https://api.deepseek.com" }

// FetchModels:GET https://api.deepseek.com/models,解析 OpenAI 兼容响应。
// deepseek /models 只返回 id/owned_by,不含长度字段(已实测),长度走预设。
func (d DeepSeek) FetchModels(ctx context.Context, apiKey string, fetchFn func(url string) ([]byte, error)) ([]ModelInfo, error) {
	f := fetchFn
	if f == nil {
		f = func(url string) ([]byte, error) { return HTTPFetch(url, apiKey) }
	}
	body, err := f(d.BaseURL() + "/models")
	if err != nil {
		return nil, err
	}
	return ParseOAIModels(body)
}

// RequestOverrides:强制思考模式 max;思考模式不支持 4 个采样参数,删除。
func (d DeepSeek) RequestOverrides(modelID string) (map[string]any, []string) {
	return map[string]any{
		"thinking":        map[string]any{"type": "enabled"},
		"reasoning_effort": "max",
	}, []string{"temperature", "top_p", "presence_penalty", "frequency_penalty"}
}

// DefaultModelCaps:上下文 1M、输出 384K(deepseek 官方模型表)。
func (d DeepSeek) DefaultModelCaps() (int64, int64) { return 1048576, 393216 }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `go test ./internal/llmgateway/channels/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/llmgateway/channels/deepseek.go internal/llmgateway/channels/channel_test.go
git commit -m "feat: deepseek channel (thinking mode max, oai /models)"
```

---

### Task 4: 同步器 SyncOnce + SyncLoop

**Files:**
- Create: `internal/llmgateway/sync.go`
- Create: `internal/llmgateway/sync_test.go`

- [ ] **Step 1: 写失败测试**

Create `internal/llmgateway/sync_test.go`:

```go
package llmgateway

import (
	"database/sql"
	"fmt"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

func syncTestDB(t *testing.T) (*sql.DB, int64) {
	t.Helper()
	db, err := serverstore.EnsureMigrated(fmt.Sprintf("%s/sync.db", t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	// 建 deepseek provider(带 key),直接写库以跳过 API
	enc := encryptSecret("sk-test")
	if err != nil {
		t.Fatal(err)
	}
	p := &serverstore.GatewayProvider{Name: "deepseek", BaseURL: "https://api.deepseek.com", APIKeyEnc: enc, Channel: "deepseek", Enabled: 1}
	id, err := serverstore.AddGatewayProvider(db, p)
	if err != nil {
		t.Fatal(err)
	}
	return db, id
}

func TestSyncOnceAddsNewModels(t *testing.T) {
	db, pid := syncTestDB(t)
	fetchFn := func(url string) ([]byte, error) {
		return []byte(`{"data":[{"id":"deepseek-v4-flash"},{"id":"deepseek-v4-pro"}]}`), nil
	}
	if err := SyncOnce(db, fetchFn); err != nil {
		t.Fatal(err)
	}
	models, err := serverstore.ListModels(db)
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 {
		t.Fatalf("models = %+v", models)
	}
	_ = pid
}

func TestSyncOnceRemovesGoneModels(t *testing.T) {
	db, _ := syncTestDB(t)
	// 先上架 2 个
	fetchFn := func(url string) ([]byte, error) {
		return []byte(`{"data":[{"id":"deepseek-v4-flash"},{"id":"deepseek-v4-pro"}]}`), nil
	}
	if err := SyncOnce(db, fetchFn); err != nil {
		t.Fatal(err)
	}
	// 上游只剩 1 个 → flash 下架
	fetchFn2 := func(url string) ([]byte, error) {
		return []byte(`{"data":[{"id":"deepseek-v4-pro"}]}`), nil
	}
	if err := SyncOnce(db, fetchFn2); err != nil {
		t.Fatal(err)
	}
	models, _ := serverstore.ListModels(db)
	if len(models) != 1 || models[0].ID != "deepseek-v4-pro" {
		t.Fatalf("models after removal = %+v", models)
	}
}

func TestSyncOnceFetchFailureSkips(t *testing.T) {
	db, _ := syncTestDB(t)
	fetchFn := func(url string) ([]byte, error) {
		return nil, fmt.Errorf("boom")
	}
	if err := SyncOnce(db, fetchFn); err != nil {
		t.Fatalf("SyncOnce should tolerate fetch failure, got %v", err)
	}
	models, _ := serverstore.ListModels(db)
	if len(models) != 0 {
		t.Fatalf("no models expected, got %+v", models)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `go test ./internal/llmgateway/ -run TestSyncOnce`
Expected: 编译失败(`SyncOnce undefined`)

- [ ] **Step 3: 实现 sync.go**

Create `internal/llmgateway/sync.go`:

```go
package llmgateway

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"time"

	"github.com/picoaide/picoaide/internal/llmgateway/channels"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// SyncResult 描述一个 provider 的同步结果。
type SyncResult struct {
	Provider string `json:"provider"`
	Added    int    `json:"added"`
	Removed  int    `json:"removed"`
	Error    string `json:"error,omitempty"`
}

// SyncOnce 对所有 enabled 且含 key 的 provider 拉取模型并同步 models 表。
// 单个 provider 失败不影响其他。fetchFn 可注入便于测试;nil 时用 HTTPFetch。
func SyncOnce(db *sql.DB, fetchFn func(url string) ([]byte, error)) ([]SyncResult, error) {
	providers, err := serverstore.ListGatewayProviders(db)
	if err != nil {
		return nil, err
	}
	var results []SyncResult
	for i := range providers {
		p := &providers[i]
		if p.Enabled != 1 || p.APIKeyEnc == "" || p.Channel == "" {
			continue
		}
		ch, ok := channels.Get(p.Channel)
		if !ok {
			results = append(results, SyncResult{Provider: p.Name, Error: "unknown channel"})
			continue
		}
		key, err := DecryptSecret(p.APIKeyEnc)
		if err != nil {
			results = append(results, SyncResult{Provider: p.Name, Error: err.Error()})
			continue
		}
		res := syncProvider(db, ch, p, key, fetchFn)
		results = append(results, res)
	}
	return results, nil
}

func syncProvider(db *sql.DB, ch channels.Channel, p *serverstore.GatewayProvider, key string, fetchFn func(url string) ([]byte, error)) SyncResult {
	f := fetchFn
	if f == nil {
		f = func(url string) ([]byte, error) { return channels.HTTPFetch(url, key) }
	}
	models, err := ch.FetchModels(context.Background(), key, f)
	if err != nil {
		return SyncResult{Provider: p.Name, Error: err.Error()}
	}
	cl, mo := ch.DefaultModelCaps()
	type caps struct {
		ContextLength int64 `json:"context_length"`
		MaxOutput     int64 `json:"max_output"`
	}
	byID := make(map[string]int64, len(models))
	var newNames []string
	for _, m := range models {
		if _, dup := byID[m.ID]; dup {
			continue
		}
		byID[m.ID] = 1
		cln, mon := m.ContextLen, m.MaxOutput
		if cln == 0 {
			cln = cl
		}
		if mon == 0 {
			mon = mo
		}
		params, _ := json.Marshal(caps{ContextLength: cln, MaxOutput: mon})
		if err := serverstore.SyncProviderModel(db, p.ID, m.ID, string(params)); err != nil {
			return SyncResult{Provider: p.Name, Error: err.Error()}
		}
		newNames = append(newNames, m.ID)
	}
	removed, err := serverstore.RemoveMissingProviderModels(db, p.ID, newNames)
	if err != nil {
		return SyncResult{Provider: p.Name, Error: err.Error()}
	}
	return SyncResult{Provider: p.Name, Added: len(newNames), Removed: removed}
}

// SyncLoop 定时执行 SyncOnce,固定间隔。
func SyncLoop(db *sql.DB, interval time.Duration, fetchFn func(url string) ([]byte, error)) {
	if interval <= 0 {
		interval = time.Hour
	}
	for {
		if _, err := SyncOnce(db, fetchFn); err != nil {
			log.Printf("gateway sync: %v", err)
		}
		time.Sleep(interval)
	}
}
```

(注:`SyncProviderModel`/`RemoveMissingProviderModels` 在 Task 5 实现。)

- [ ] **Step 4: 运行测试(允许失败)**

Run: `go test ./internal/llmgateway/ -run TestSyncOnce`
Expected: 编译失败(`SyncProviderModel undefined`)——继续 Task 5。

- [ ] **Step 5: Commit 中间状态**

```bash
git add internal/llmgateway/sync.go internal/llmgateway/sync_test.go
git commit -m "feat: model sync once/loop (wip: serverstore helpers)"
```

---

### Task 5: serverstore 同步辅助函数

**Files:**
- Modify: `internal/serverstore/gateway.go`

- [ ] **Step 1: 写失败测试**

在 `internal/serverstore/gateway_test.go`(Task 1 建)追加:

```go
func TestSyncProviderModelAndRemoveMissing(t *testing.T) {
	db, err := EnsureMigrated(fmt.Sprintf("%s/sync2.db", t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	p := &GatewayProvider{Name: "deepseek", BaseURL: "https://api.deepseek.com", APIKeyEnc: "enc:x", Channel: "deepseek", Enabled: 1}
	pid, err := AddGatewayProvider(db, p)
	if err != nil {
		t.Fatal(err)
	}
	if err := SyncProviderModel(db, pid, "deepseek-v4-flash", `{"context_length":1048576}`); err != nil {
		t.Fatal(err)
	}
	if err := SyncProviderModel(db, pid, "deepseek-v4-pro", `{"max_output":393216}`); err != nil {
		t.Fatal(err)
	}
	removed, err := RemoveMissingProviderModels(db, pid, []string{"deepseek-v4-pro"})
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("removed = %d, want 1", removed)
	}
	models, _ := ListModels(db)
	if len(models) != 1 || models[0].ID != "deepseek-v4-pro" {
		t.Fatalf("models = %+v", models)
	}
	// default_model 被删时重置
	if err := SetSetting(db, "gateway.default_model", "deepseek-v4-pro"); err != nil {
		t.Fatal(err)
	}
	removed, err = RemoveMissingProviderModels(db, pid, nil)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("removed2 = %d", removed)
	}
	v, ok, _ := GetSetting(db, "gateway.default_model")
	if !ok || v != "" {
		t.Fatalf("default_model = %q ok=%v", v, ok)
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `go test ./internal/serverstore/ -run TestSyncProviderModelAndRemoveMissing`
Expected: 编译失败(`SyncProviderModel undefined`)

- [ ] **Step 3: 实现**

`internal/serverstore/gateway.go` 追加:

```go
// SyncProviderModel upsert 一个模型的 display_name 与 default_params(幂等)。
func SyncProviderModel(db *sql.DB, providerID int64, name, defaultParams string) error {
	_, err := db.Exec(`INSERT INTO models (name, provider_id, display_name, default_params)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(name) DO UPDATE SET display_name=excluded.display_name, default_params=excluded.default_params`,
		name, providerID, name, defaultParams)
	return err
}

// RemoveMissingProviderModels 删除 provider 下不在 keep 列表中的模型。
// 若被删的是 gateway.default_model,重置为空串。返回删除数量。
func RemoveMissingProviderModels(db *sql.DB, providerID int64, keep []string) (int, error) {
	tx, err := db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	// 构建 keep 集合
	keepSet := make(map[string]bool, len(keep))
	for _, k := range keep {
		keepSet[k] = true
	}
	rows, err := tx.Query(`SELECT id, name FROM models WHERE provider_id = ?`, providerID)
	if err != nil {
		return 0, err
	}
	type row struct {
		id   int64
		name string
	}
	var doomed []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.name); err != nil {
			rows.Close()
			return 0, err
		}
		if !keepSet[r.name] {
			doomed = append(doomed, r)
		}
	}
	rows.Close()

	deletedDefault := false
	for _, r := range doomed {
		if _, err := tx.Exec("DELETE FROM models WHERE id = ?", r.id); err != nil {
			return 0, err
		}
		// default_model 被删 → 稍后重置
		var dm string
		if err := tx.QueryRow("SELECT value FROM settings WHERE key = 'gateway.default_model'").Scan(&dm); err == nil && dm == r.name {
			deletedDefault = true
		}
	}
	if deletedDefault {
		if _, err := tx.Exec("UPDATE settings SET value = '' WHERE key = 'gateway.default_model'"); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return len(doomed), nil
}
```

注意:`settings.value` 可能为 NULL;`Scan(&dm)` 若 NULL 会 err,此时 `err == nil &&` 短路,不会误判。若表里无该 key,`err != nil` 同样跳过。

- [ ] **Step 4: 运行测试确认通过**

Run: `go test ./internal/serverstore/ -run TestSyncProviderModelAndRemoveMissing -v`
Expected: PASS

- [ ] **Step 5: 回到 Task 4 测试**

Run: `go test ./internal/llmgateway/ -run TestSyncOnce -v`
Expected: PASS(`RemoveMissingProviderModels` 已实现,Task 4 测试跑通)

- [ ] **Step 6: Commit**

```bash
git add internal/serverstore/gateway.go internal/serverstore/gateway_test.go internal/llmgateway/sync.go
git commit -m "feat: serverstore model upsert/remove-missing helpers + sync wiring"
```

---

### Task 6: 网关转发前注入渠道参数

**Files:**
- Modify: `internal/llmgateway/handler.go`
- Modify: `internal/llmgateway/handler_test.go`

- [ ] **Step 1: 写失败测试**

`internal/llmgateway/handler_test.go` 追加(复用已有 upstream 测试 setup,若复杂则用最小 mock):

```go
func TestApplyChannelOverrides(t *testing.T) {
	body := []byte(`{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hi"}],"temperature":0.7}`)
	overrides := map[string]any{"thinking": map[string]any{"type": "enabled"}, "reasoning_effort": "max"}
	removeKeys := []string{"temperature"}
	out, err := applyChannelOverrides(body, overrides, removeKeys)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatal(err)
	}
	if m["reasoning_effort"] != "max" {
		t.Fatalf("reasoning_effort = %v", m["reasoning_effort"])
	}
	if _, ok := m["temperature"]; ok {
		t.Fatal("temperature should be removed")
	}
	th, _ := m["thinking"].(map[string]any)
	if th["type"] != "enabled" {
		t.Fatalf("thinking = %v", m["thinking"])
	}
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `go test ./internal/llmgateway/ -run TestApplyChannelOverrides`
Expected: 编译失败(`applyChannelOverrides undefined`)

- [ ] **Step 3: 实现**

`internal/llmgateway/handler.go` 加:

```go
// applyChannelOverrides 深合并 overrides 进请求体,并删除 removeKeys 中的键。
func applyChannelOverrides(raw []byte, overrides map[string]any, removeKeys []string) ([]byte, error) {
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return raw, err
	}
	for _, k := range removeKeys {
		delete(body, k)
	}
	deepMerge(body, overrides)
	return json.Marshal(body)
}

// deepMerge 将 src 合并进 dst(嵌套 map 递归合并,标量覆盖)。
func deepMerge(dst, src map[string]any) {
	for k, v := range src {
		if sv, ok := v.(map[string]any); ok {
			if dv, ok := dst[k].(map[string]any); ok {
				deepMerge(dv, sv)
				continue
			}
			// 目标无此嵌套键 → 深拷贝一层
			cp := map[string]any{}
			deepMerge(cp, sv)
			dst[k] = cp
			continue
		}
		dst[k] = v
	}
}
```

`handler.go` 顶部 import 已有 `encoding/json`。

- [ ] **Step 4: 在 forward 中接入**

`forward` 签名需拿到 provider 的 channel 与 model。改 `handleChatCompletions` 中调用:

```go
// forward 前注入渠道参数
if up.Channel != "" {
	if ch, ok := channels.Get(up.Channel); ok {
		ov, rm := ch.RequestOverrides(req.Model)
		if raw2, err := applyChannelOverrides(raw, ov, rm); err == nil {
			raw = raw2
		}
	}
}
```

需在 `handleChatCompletions` 内、`a.forward(...)` 调用前插入。`Upstream` 结构加 `Channel string` 字段(`upstream.go`),`LoadUpstreams` 的 Scan 加 `channel` 列。

- [ ] **Step 5: 运行测试确认通过**

Run: `go test ./internal/llmgateway/ -run TestApplyChannelOverrides -v`
Expected: PASS

- [ ] **Step 6: 全量回归**

Run: `go test ./internal/llmgateway/`
Expected: ok

- [ ] **Step 7: Commit**

```bash
git add internal/llmgateway/handler.go internal/llmgateway/upstream.go internal/llmgateway/handler_test.go
git commit -m "feat: inject channel overrides into gateway requests"
```

---

### Task 7: provider 管理支持 channel + 手动同步端点

**Files:**
- Modify: `internal/llmgateway/admin.go`
- Modify: `internal/llmgateway/admin_test.go`

- [ ] **Step 1: 写失败测试**

`admin_test.go` 的 `TestAdminProviders` 追加 channel 断言:

```go
// create provider with channel
w, out := adminReq(t, r, "POST", "/api/admin/providers",
	`{"name":"deepseek","base_url":"https://api.deepseek.com","api_key":"sk","models":[],"channel":"deepseek"}`, hdr)
if w.Code != http.StatusOK {
	t.Fatalf("create channel provider: %d %s", w.Code, w.Body.String())
}
p := out["provider"].(map[string]any)
if p["channel"] != "deepseek" {
	t.Fatalf("channel = %v", p["channel"])
}
// channels list
w, out = adminReq(t, r, "GET", "/api/admin/channels", "", hdr)
if w.Code != http.StatusOK {
	t.Fatalf("channels: %d", w.Code)
}
if arr, ok := out["channels"].([]any); !ok || len(arr) == 0 {
	t.Fatalf("channels = %v", out)
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `go test ./internal/llmgateway/ -run TestAdminProviders`
Expected: FAIL(`channel` 未回显 或 /api/admin/channels 404)

- [ ] **Step 3: 实现**

`admin.go`:
- `providerReq` 加 `Channel string json:"channel"`
- `createProvider`/`updateProvider`:保存 `p.Channel`;若 `req.BaseURL==""` 且 channel 存在,用 `channels.Get(cn).BaseURL()` 填充
- `providerJSON` 加 `channel`
- 路由加 `GET /channels` → 返回 `{"channels": channels.All()}`;`POST /providers/:id/sync` → 单 provider 同步;`POST /providers/sync-all` → `SyncOnce` 返回 results

```go
// listChannelsAdmin
func listChannelsAdmin(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"channels": channels.All()})
}

// syncOneAdmin:同步单个 provider
func syncOneAdmin(c *gin.Context, db *sql.DB) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	p, err := serverstore.GetGatewayProvider(db, id)
	if errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "上游不存在")
		return
	}
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	ch, ok := channels.Get(p.Channel)
	if !ok {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "渠道不存在")
		return
	}
	key, err := DecryptSecret(p.APIKeyEnc)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "密钥解密失败")
		return
	}
	res := syncProvider(db, ch, p, key, nil)
	c.JSON(http.StatusOK, gin.H{"result": res})
}
```

(注:`syncProvider` 需从 `sync.go` 导出为可复用,或复制内联;建议导出为 `SyncProviderResult`。计划 Task 4 的 `syncProvider` 改为导出函数 `SyncProvider(db, ch, p, key, fetchFn) SyncResult`。)

- [ ] **Step 4: 运行测试确认通过**

Run: `go test ./internal/llmgateway/ -run TestAdminProviders -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/llmgateway/admin.go internal/llmgateway/admin_test.go internal/llmgateway/sync.go
git commit -m "feat: provider channel field, channels list, manual sync endpoints"
```

---

### Task 8: main.go 启动 SyncLoop

**Files:**
- Modify: `cmd/server/main.go`

- [ ] **Step 1: 实现**

`cmd/server/main.go` 在 `RegisterRoutes` 后加:

```go
// 渠道模型自动同步(固定间隔 1 小时)
go llmgateway.SyncLoop(db, time.Hour, nil)
```

需 import `github.com/picoaide/picoaide/internal/llmgateway`(已 import)与 `time`(已 import)。

- [ ] **Step 2: 构建验证**

Run: `go build ./...`
Expected: 成功

- [ ] **Step 3: Commit**

```bash
git add cmd/server/main.go
git commit -m "feat: start model sync loop at server boot"
```

---

### Task 9: webadmin 网关页(渠道下拉 + 能力展示 + 立即同步)

**Files:**
- Modify: `webadmin/src/pages/Gateway.tsx`
- Modify: `webadmin/src/App.tsx`(如需要)

- [ ] **Step 1: 渠道下拉**

- 页面加载时 `GET /api/admin/channels` → 存 `channels: string[]`
- provider 表单加"渠道"下拉(`Select`),选中 `onValueChange` 填 base_url(选 deepseek 填 `https://api.deepseek.com`,若 base_url 为空或已是该渠道默认则覆盖)
- `provForm` 加 `channel`;`createProvider` body 加 `channel`

- [ ] **Step 2: 模型能力展示**

模型表格加一列"能力":从模型行的 `default_params` 解析 `context_length`/`max_output`,格式化 `1M / 384K`。需 `GET /api/admin/models` 返回 `default_params`(服务端 `listModelsAdmin` 已用 `ListModels`——`Model` 结构体需加 `DefaultParams` 并在 JSON 输出)。检查 `internal/llmgateway/models.go` 的 `Model` struct,加字段:

```go
type Model struct {
	ID            string `json:"id"`
	DisplayName   string `json:"display_name"`
	DefaultParams string `json:"default_params"`
}
```

`ListModels` SQL 加 `m.default_params`。

- [ ] **Step 3: 立即同步按钮**

模型管理 Card 右上角加"立即同步"按钮 → `POST /api/admin/providers/sync-all`,成功后 `load()` 刷新。

- [ ] **Step 4: 构建验证**

Run: `cd webadmin && npm run build`
Expected: 成功

- [ ] **Step 5: Commit**

```bash
git add webadmin/src/pages/Gateway.tsx internal/llmgateway/models.go internal/llmgateway/admin.go
git commit -m "feat: webadmin channel select, model caps display, manual sync"
```

---

### Task 10: 端到端验证 + 全量回归

**Files:**
- 无新文件(使用现有 mock-upstream 或本地 deepseek key)

- [ ] **Step 1: 用真实 deepseek key 验证同步**

```bash
# 起服务端
PICOAI_ADMIN_PASSWORD='x' bin/picoaide-server -addr :8080 -data /tmp/ds --bootstrap-admin admin &
# 建 provider(渠道 deepseek + 真实 key)
curl -s -X POST http://127.0.0.1:8080/api/admin/providers -H '...' -d '{"name":"deepseek","channel":"deepseek","api_key":"sk-..."}'
# 立即同步
curl -s -X POST http://127.0.0.1:8080/api/admin/providers/sync-all -H '...'
# 查模型
curl -s http://127.0.0.1:8080/api/admin/models -H '...'
```
Expected: models 出现 deepseek-v4-flash / deepseek-v4-pro,default_params 含 context_length=1048576/max_output=393216

- [ ] **Step 2: 验证客户端对话注入思考模式**

用客户端或直接 curl chat completions:
```bash
curl -s http://127.0.0.1:8080/v1/chat/completions -H "Authorization: Bearer <user token>" -H 'Content-Type: application/json' -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hi"}],"temperature":0.7}'
```
Expected: 返回含 reasoning_content(思考模式生效);temperature 被服务端删除

- [ ] **Step 3: 全量回归**

Run: `go test ./...` + `cd desktop && npm test && npm run typecheck`
Expected: 全绿

- [ ] **Step 4: Commit(如有遗留)**

```bash
git add -A
git commit -m "test: e2e channel sync with real deepseek key" 
```

---

## 自审

**Spec 覆盖:**
- 渠道包接口/注册表 → Task 2
- deepseek 渠道 → Task 3
- 自动轮询 SyncLoop → Task 4/8
- 自动上架/下架 + 删默认模型重置 → Task 4/5
- 请求注入思考模式 + 删禁用参数 → Task 6
- provider channel 字段 + 手动同步端点 → Task 7
- webadmin 渠道下拉/能力展示/立即同步 → Task 9
- 迁移 0010 → Task 1
- 不硬编码模型、/models 拉取 → Task 3 FetchModels / Task 4 同步
- 客户端 OpenAI 兼容直用 → 无需客户端改动(现有实现),Task 10 验证

**类型一致性:** `SyncOnce(db, fetchFn)` 在 Task 4/7/8 一致;`SyncProvider`/`SyncProviderResult` 命名在 Task 7 说明统一;`SyncProviderModel`/`RemoveMissingProviderModels` 签名在 Task 4/5 一致。

**占位符:** 无 TBD/TODO;`syncProvider` 导出命名在 Task 7 明示改动。
