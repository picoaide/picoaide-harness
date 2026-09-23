package llmgateway

// 2026-09-23(P0-2):PUT /api/server/admin/providers/:id 的原子性。
//
// 缺陷形态(已复现):handler 先在 autocommit 下写 provider 行(**含密钥轮换**),
// 随后才同步该渠道/上游的模型清单;清单同步失败时直接 500 返回,而 provider 行
// 已经落库。后果三连:
//  1. 密钥已轮换,管理端却以为保存失败(运维看到 500 会重试或回滚上游密钥);
//  2. 零审计 —— audit 写在成功路径末尾,该分支根本走不到;
//  3. 新 provider 名/新清单可被路由命中而 models 表没有对应行(或行被剪枝),
//     用量按 0 元计费。
//
// 触发条件之一(本用例采用的确定性注入):模型名里带一个 NUL。JSON 里 `\u0000`
// 是合法转义,Go 解码后就是字符串里的 0x00 字节,而 PG 的 TEXT/VARCHAR 拒绝
// 0x00(`invalid byte sequence for encoding "UTF8": 0x00`)⇒ SyncProviderModels
// 的 INSERT 必失败。**该注入不依赖任何外部网络**,也不依赖上游目录内容。
//
// 判据:失败后必须**逐字等于操作前的状态** —— provider 行(含 api_key_enc)/
// 该上游全部模型行(价格/展示名/参数/模态)/审计条数 三者一字不差。

import (
	"database/sql"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// providerPutState 是"操作前后必须逐字一致"的观测面。
type providerPutState struct {
	Provider string // gateway_providers 整行(全部列)
	Models   string // 该上游的模型行(按 name 排序,全部运营方配置列)
	AuditAll int    // audit_logs 总条数
	AuditPut int    // action='provider_update' 条数
}

// gatewayProviderRowDump 把 provider 行**全部列**拼成可逐字比较的字符串。
// 用 COALESCE 把 NULL 归一成空串,避免 sql.NullString 影响比较。
func gatewayProviderRowDump(t *testing.T, db *sql.DB, id int64) string {
	t.Helper()
	var name, baseURL, key, models, channel, protocol string
	var enabled int
	if err := db.QueryRow(`SELECT name, base_url, api_key_enc, models, enabled,
		COALESCE(channel, ''), COALESCE(protocol, '') FROM gateway_providers WHERE id = ?`, id).
		Scan(&name, &baseURL, &key, &models, &enabled, &channel, &protocol); err != nil {
		t.Fatalf("读 provider 行失败: %v", err)
	}
	return fmt.Sprintf("name=%s|base_url=%s|api_key_enc=%s|models=%s|enabled=%d|channel=%s|protocol=%s",
		name, baseURL, key, models, enabled, channel, protocol)
}

// providerModelRowsDump 把该上游下全部模型行的**运营方配置列**拼成字符串。
func providerModelRowsDump(t *testing.T, db *sql.DB, providerID int64) string {
	t.Helper()
	rows, err := db.Query(`SELECT name, COALESCE(display_name, ''),
		COALESCE(CAST(input_price_per_1m AS TEXT), '-'), COALESCE(CAST(output_price_per_1m AS TEXT), '-'),
		COALESCE(CAST(cache_input_price_per_1m AS TEXT), '-'), COALESCE(CAST(offpeak_discount AS TEXT), '-'),
		COALESCE(default_params, ''), COALESCE(input_modalities, ''), catalog_missing
		FROM models WHERE provider_id = ? ORDER BY name`, providerID)
	if err != nil {
		t.Fatalf("读模型行失败: %v", err)
	}
	defer rows.Close()
	var b strings.Builder
	for rows.Next() {
		var name, display, in, out, cache, off, params, mods string
		var missing bool
		if err := rows.Scan(&name, &display, &in, &out, &cache, &off, &params, &mods, &missing); err != nil {
			t.Fatalf("扫描模型行失败: %v", err)
		}
		fmt.Fprintf(&b, "%s[display=%s,in=%s,out=%s,cache=%s,off=%s,params=%s,mods=%s,missing=%v]\n",
			name, display, in, out, cache, off, params, mods, missing)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("遍历模型行失败: %v", err)
	}
	return b.String()
}

// providerRowField 从 gatewayProviderRowDump 的结果里取一个字段(测试内部用)。
func providerRowField(dump, key string) string {
	for _, part := range strings.Split(dump, "|") {
		if v, ok := strings.CutPrefix(part, key+"="); ok {
			return v
		}
	}
	return ""
}

// providerPutSnapshot 采集一次完整的"副作用观测面"。
func providerPutSnapshot(t *testing.T, db *sql.DB, providerID int64) providerPutState {
	t.Helper()
	var st providerPutState
	st.Provider = gatewayProviderRowDump(t, db, providerID)
	st.Models = providerModelRowsDump(t, db, providerID)
	if err := db.QueryRow(`SELECT COUNT(*) FROM audit_logs`).Scan(&st.AuditAll); err != nil {
		t.Fatalf("读审计总数失败: %v", err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM audit_logs WHERE action = 'provider_update'`).Scan(&st.AuditPut); err != nil {
		t.Fatalf("读 provider_update 审计数失败: %v", err)
	}
	return st
}

// putProviderBodyWithNULModel 是"清单同步必然失败"的 PUT 请求体:改名 + 轮换密钥
// + 清单里混入一个含 NUL 的模型名。raw string 里的 `\u0000` 是 JSON 转义本身
// (Go 不解释 raw string),解码后即一个 0x00 字节。
const putProviderBodyWithNULModel = `{"name":"renamed","base_url":"http://x","api_key":"rotated-key",` +
	`"enabled":true,"protocol":"openai","models":["m1","bad\u0000name"]}`

// TestAdminProviderUpdateSyncFailureHasNoSideEffects 是本次修复的核心判据:
// 清单同步失败 ⇒ 整体回滚,provider 行/密钥/模型行/审计**一字不动**。
func TestAdminProviderUpdateSyncFailureHasNoSideEffects(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	// 手动型上游(不触发渠道出网同步),m1 带完整运营方配置作为哨兵。
	if w, _ := adminReq(t, r, "POST", "/api/server/admin/providers",
		`{"name":"manual","base_url":"http://x","api_key":"orig-key","models":["m1"]}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("建上游: %d %s", w.Code, w.Body.String())
	}
	var modelID int64
	if err := db.QueryRow(`SELECT id FROM models WHERE name = 'm1'`).Scan(&modelID); err != nil {
		t.Fatalf("m1 未建行: %v", err)
	}
	if w, _ := adminReq(t, r, "PUT", fmt.Sprintf("/api/server/admin/models/%d", modelID),
		`{"display_name":"m1 展示名","default_params":"{\"max_output\":123}","input_modalities":["text","image"],`+
			`"input_price_per_1m":30,"output_price_per_1m":60}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("给 m1 定价: %d %s", w.Code, w.Body.String())
	}

	before := providerPutSnapshot(t, db, 1)

	w, out := adminReq(t, r, "PUT", "/api/server/admin/providers/1", putProviderBodyWithNULModel, hdr)
	// 失败仍是同一个失败(500 INTERNAL 模型同步失败):若它退化成"写库前就被拦"
	// (例如 400 VALIDATION),下面的"无副作用"断言就会因**根本没走到写库**而
	// 假绿 —— 这条断言是防假绿的前置条件,必须保留。
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("PUT 含 NUL 模型名的清单: 状态 = %d %s, want 500(清单同步失败)", w.Code, w.Body.String())
	}
	errObj, ok := out["error"].(map[string]any)
	if !ok {
		t.Fatalf("失败响应不是 {\"error\":{...}} 信封: %s", w.Body.String())
	}
	if errObj["code"] != "INTERNAL" || errObj["message"] != "模型同步失败" {
		t.Fatalf("失败信封 = %v, want code=INTERNAL message=模型同步失败", errObj)
	}

	after := providerPutSnapshot(t, db, 1)
	if after.Provider != before.Provider {
		t.Fatalf("清单同步失败后 provider 行被改动(密钥/名字/清单已落库):\n before=%s\n after =%s",
			before.Provider, after.Provider)
	}
	if after.Models != before.Models {
		t.Fatalf("清单同步失败后模型行被改动:\n before=%s\n after =%s", before.Models, after.Models)
	}
	if after.AuditAll != before.AuditAll || after.AuditPut != before.AuditPut {
		t.Fatalf("清单同步失败却写了审计: audit_logs %d→%d, provider_update %d→%d",
			before.AuditAll, after.AuditAll, before.AuditPut, after.AuditPut)
	}

	// 正向对照:同一路由的**成功**路径必须照旧落库 + 落审计(证明上面的"零副作用"
	// 不是"整个写路径都坏了"造成的假绿,也钉住审计动作名与明细字段不变)。
	// 密钥断言用"与操作前不同"而不是明文:库里存的是密文(enc:v1:…)。
	keyBefore := providerRowField(before.Provider, "api_key_enc")
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/providers/1",
		`{"name":"renamed","base_url":"http://x","api_key":"rotated-key","enabled":true,"protocol":"openai","models":["m1"]}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("正常 PUT: %d %s", w.Code, w.Body.String())
	}
	okRow := gatewayProviderRowDump(t, db, 1)
	if providerRowField(okRow, "name") != "renamed" {
		t.Fatalf("成功路径未改名: %s", okRow)
	}
	if got := providerRowField(okRow, "api_key_enc"); got == keyBefore || got == "" {
		t.Fatalf("成功路径未轮换密钥(api_key_enc 未变): %s", okRow)
	}
	var detail string
	if err := db.QueryRow(`SELECT detail FROM audit_logs WHERE action = 'provider_update' ORDER BY id DESC LIMIT 1`).
		Scan(&detail); err != nil {
		t.Fatalf("成功路径缺 provider_update 审计: %v", err)
	}
	if !strings.Contains(detail, "name:manual→renamed") || !strings.Contains(detail, "api_key:已更换") {
		t.Fatalf("审计明细 = %q, want 含 name:manual→renamed 与 api_key:已更换", detail)
	}
	// 哈希链必须仍然自洽:事务内审计写入(AuditLogTx)与异步 worker 必须共用同一
	// 份链口径(同 payload、同 advisory lock、同 EscapeControl),任何漂移都会让
	// 校验器报断链 —— 那是比"少一条审计"更严重的合规事故。
	if broken, err := serverstore.VerifyAuditChain(db); err != nil || broken != 0 {
		t.Fatalf("审计哈希链校验失败: broken=%d err=%v", broken, err)
	}
}

// TestAdminProviderUpdateChannelSyncFailureStaysNonFatal 钉住"没有被过度修复"的
// 那一半契约:渠道型上游保存后的**出网**同步失败仍旧只报在响应体的 sync.error
// 里(HTTP 200 + provider 已保存),不因为这次原子化改造变成回滚。
// 出网动作(15s 上限的目录拉取)不可能塞进数据库事务,它的失败语义就是"保存成功、
// 同步待重试" —— 与手动型的清单同步失败(500 + 回滚)是两回事。
func TestAdminProviderUpdateChannelSyncFailureStaysNonFatal(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	// 建渠道型上游(创建路径自带一次同步,注入的 fetchFn 返回固定目录)。
	if w, _ := adminReq(t, r, "POST", "/api/server/admin/providers",
		`{"name":"chan","api_key":"sk","channel":"deepseek"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("建渠道上游: %d %s", w.Code, w.Body.String())
	}
	// 之后所有出网同步一律失败。
	prev := syncFetchFn
	syncFetchFn = func(string) ([]byte, error) { return nil, fmt.Errorf("upstream down") }
	t.Cleanup(func() { syncFetchFn = prev })

	w, out := adminReq(t, r, "PUT", "/api/server/admin/providers/1",
		`{"name":"chan2","enabled":true}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("渠道同步失败不得让保存失败: 状态 = %d %s", w.Code, w.Body.String())
	}
	if got := gatewayProviderRowDump(t, db, 1); !strings.Contains(got, "name=chan2") {
		t.Fatalf("渠道型上游改名未落库: %s", got)
	}
	sync, ok := out["sync"].(map[string]any)
	if !ok {
		t.Fatalf("响应缺 sync 结果: %s", w.Body.String())
	}
	if s, _ := sync["error"].(string); s == "" {
		t.Fatalf("sync.error 为空,出网失败被吞: %v", sync)
	}
}
