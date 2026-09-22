package llmgateway

import (
	"bytes"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// 出站体加工的数值与内存闸门（2026-09-22 审计 F 路 P1-3 / P2-3 的修复面）。

// resetBodyParseGate 把进程级闸门恢复到"空闲 + 缓存失效"，供用例之间隔离。
func resetBodyParseGate(t *testing.T) {
	t.Helper()
	t.Cleanup(func() {
		globalBodyParseGate.zeroForTest()
		InvalidateGatewayLimits()
	})
	globalBodyParseGate.zeroForTest()
	InvalidateGatewayLimits()
}

// TestBodyParseGateBlocksOverBudget:闸门被占满时，慢路径（含 file_id 的体）必须
// fail-closed 返回 503 + code SERVER（可重试），而不是继续分配内存。
func TestBodyParseGateBlocksOverBudget(t *testing.T) {
	resetBodyParseGate(t)
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
	if err := serverstore.RecordGatewayFile(gw.db, "file-abc", gw.uidA, nil); err != nil {
		t.Fatal(err)
	}
	// 把预算压到最小值，并整块占满 —— 相当于"已有别的请求在加工大请求体"。
	if err := serverstore.SetSetting(gw.db, SettingBodyParseBudgetMB, "64"); err != nil {
		t.Fatal(err)
	}
	InvalidateGatewayLimits()
	budget := int64(MinBodyParseBudgetMB) << 20
	releaseGate, ok := globalBodyParseGate.acquire(budget, budget)
	if !ok {
		t.Fatal("占满闸门失败（夹具问题）")
	}
	defer releaseGate()

	reqBody := `{"model":"deepseek-chat","messages":[{"role":"user","content":[{"type":"file","file_id":"file-abc"}]}]}`
	w := doPost(t, gw.r, "/v1/chat/completions", reqBody, gw.tokenA, nil)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("闸门占满时应 503，实得 %d (%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"code":"SERVER"`) {
		t.Fatalf("503 的 code 必须是 SERVER（客户端按可重试处理）: %s", w.Body.String())
	}
	if up.hits.Load() != 0 {
		t.Fatalf("被闸门拒绝的请求不应触达上游（%d 次）", up.hits.Load())
	}
}

// TestBodyParseGateReleasesAfterRewrite:正常放行后额度必须归还（否则闸门会慢性泄漏，
// 最终所有大请求全 503）。
func TestBodyParseGateReleasesAfterRewrite(t *testing.T) {
	resetBodyParseGate(t)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	body := []byte(`{"model":"m","messages":[]}`)
	if _, err := rewriteJSONObjectBody(db, body, func(m map[string]any) error {
		m["user_id"] = "u1"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if n := globalBodyParseGate.inFlightBytes(); n != 0 {
		t.Fatalf("往返结束后在飞字节应为 0，实得 %d", n)
	}
	// 解析失败的路径同样要归还（早退不得泄漏）。
	if _, err := rewriteJSONObjectBody(db, []byte(`{"broken":`), nil); err == nil {
		t.Fatal("坏 JSON 应报错")
	}
	if n := globalBodyParseGate.inFlightBytes(); n != 0 {
		t.Fatalf("失败路径泄漏了 %d 字节额度", n)
	}
}

// TestGatewayLimitsDefaultsAndOverrides：两个可配数值的读取口径 —— 缺省、
// 合法覆盖、非法值回落缺省、保存后失效缓存立即生效。
func TestGatewayLimitsDefaultsAndOverrides(t *testing.T) {
	resetBodyParseGate(t)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	if got := gatewayLimitsFor(nil); got.maxFileRefs != DefaultMaxFileRefsPerRequest ||
		got.budgetBytes != int64(DefaultBodyParseBudgetMB)<<20 {
		t.Fatalf("nil db 应回落缺省: %+v", got)
	}
	if got := gatewayLimitsFor(db); got.maxFileRefs != DefaultMaxFileRefsPerRequest {
		t.Fatalf("空库应缺省: %+v", got)
	}
	if err := serverstore.SetSetting(db, SettingMaxFileRefs, "8"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, SettingBodyParseBudgetMB, "512"); err != nil {
		t.Fatal(err)
	}
	InvalidateGatewayLimits()
	got := gatewayLimitsFor(db)
	if got.maxFileRefs != 8 || got.budgetBytes != 512<<20 {
		t.Fatalf("合法覆盖未生效: %+v", got)
	}
	// 非法值（0 / 越界 / 非数字）一律回落缺省，而不是关掉闸门。
	for _, bad := range []string{"0", "-1", "999999", "abc", " "} {
		if err := serverstore.SetSetting(db, SettingMaxFileRefs, bad); err != nil {
			t.Fatal(err)
		}
		if err := serverstore.SetSetting(db, SettingBodyParseBudgetMB, bad); err != nil {
			t.Fatal(err)
		}
		InvalidateGatewayLimits()
		if got := gatewayLimitsFor(db); got.maxFileRefs != DefaultMaxFileRefsPerRequest ||
			got.budgetBytes != int64(DefaultBodyParseBudgetMB)<<20 {
			t.Fatalf("非法值 %q 未回落缺省: %+v", bad, got)
		}
	}
}

// TestMaxFileRefsSettingApplies：引用上限是**运行期可配**的（管理后台），
// 且比较发生在归属查询之前（超限不查库）。
func TestMaxFileRefsSettingApplies(t *testing.T) {
	resetBodyParseGate(t)
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
	if err := serverstore.SetSetting(gw.db, SettingMaxFileRefs, "2"); err != nil {
		t.Fatal(err)
	}
	InvalidateGatewayLimits()
	for i := 0; i < 3; i++ {
		if err := serverstore.RecordGatewayFile(gw.db, "file-own-"+string(rune('a'+i)), gw.uidA, nil); err != nil {
			t.Fatal(err)
		}
	}
	body := `{"model":"deepseek-chat","messages":[{"role":"user","content":[{"type":"file","file_id":"file-own-a"},{"type":"file","file_id":"file-own-b"},{"type":"file","file_id":"file-own-c"}]}]}`
	w := doPost(t, gw.r, "/v1/chat/completions", body, gw.tokenA, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("上限 2 时引用 3 个应 400，实得 %d (%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "上限 2 个") {
		t.Fatalf("错误文案应回显生效上限: %s", w.Body.String())
	}
	two := `{"model":"deepseek-chat","messages":[{"role":"user","content":[{"type":"file","file_id":"file-own-a"},{"type":"file","file_id":"file-own-b"}]}]}`
	if w := doPost(t, gw.r, "/v1/chat/completions", two, gw.tokenA, nil); w.Code != http.StatusOK {
		t.Fatalf("上限内应放行，实得 %d (%s)", w.Code, w.Body.String())
	}
}

// TestRewriteJSONObjectBodyErrorTaxonomy：唯一往返实现的错误分类（调用方据此决定
// 400/503），以及"无需改动 ⇒ 原字节"的语义。
func TestRewriteJSONObjectBodyErrorTaxonomy(t *testing.T) {
	resetBodyParseGate(t)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	if _, err := rewriteJSONObjectBody(db, []byte(`not json`), nil); err == nil {
		t.Fatal("非法 JSON 必须报错")
	}
	if _, err := rewriteJSONObjectBody(db, []byte(`[1,2]`), nil); err == nil {
		t.Fatal("非对象必须报错")
	}
	if _, err := rewriteJSONObjectBody(db, []byte(`null`), nil); err == nil {
		t.Fatal("null 必须报错")
	}
	raw := []byte(`{"b":2,"a":1}`)
	out, err := rewriteJSONObjectBody(db, raw, func(map[string]any) error { return errBodyNoChange })
	if err != nil {
		t.Fatal(err)
	}
	if string(out) != string(raw) {
		t.Fatalf("errBodyNoChange 应返回原始字节: %s", out)
	}
	// 大整数保真（UseNumber）+ HTML 不转义（SetEscapeHTML(false)）。
	out, err = rewriteJSONObjectBody(db, []byte(`{"n":12345678901234567890,"s":"<a>&b"}`), func(m map[string]any) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	var back map[string]json.RawMessage
	if err := json.Unmarshal(out, &back); err != nil {
		t.Fatal(err)
	}
	if string(back["n"]) != "12345678901234567890" {
		t.Fatalf("大整数漂移: %s", back["n"])
	}
	if !strings.Contains(string(out), "<a>&b") {
		t.Fatalf("HTML 转义未关闭: %s", out)
	}
}

// BenchmarkBodyRewritePeakAmplification 量"整 body map 往返"的**峰值活跃堆**放大倍数，
// 用于给 `DefaultBodyParseBudgetMB` 的说明提供实测依据（闸门按请求体字节计，
// 内存约为它的数倍）。跑法：
//
//	go test ./internal/llmgateway/ -run '^$' -bench BenchmarkBodyRewritePeakAmplification -benchmem
func BenchmarkBodyRewritePeakAmplification(b *testing.B) {
	// 构造一个"密对象"体（大量小键值），这正是审计 F 路测出最坏放大的形态。
	var sb strings.Builder
	sb.WriteString(`{"model":"m","messages":[{"role":"user","content":[`)
	for i := 0; i < 40_000; i++ {
		if i > 0 {
			sb.WriteString(",")
		}
		sb.WriteString(`{"type":"text","text":"xxxx"}`)
	}
	sb.WriteString(`]}],"file_id":"file-abc"}`)
	raw := []byte(sb.String())

	report := func(b *testing.B) {
		b.SetBytes(int64(len(raw)))
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			if _, err := rewriteJSONObjectBody(nil, raw, func(m map[string]any) error {
				m["user_id"] = "u1"
				return nil
			}); err != nil {
				b.Fatal(err)
			}
		}
	}
	report(b)
	b.Logf("body=%d bytes, 峰值放大见 benchmem 的 B/op（实测约 6~8× 峰值活跃堆）", len(raw))
}

// TestGatewayConfigRoundTripsBodyGates：管理端 PUT/GET 与运行期读取的闭环 ——
// 保存后立即可配（InvalidateGatewayLimits 生效）、越界值被 400 拦下且不落库。
func TestGatewayConfigRoundTripsBodyGates(t *testing.T) {
	resetBodyParseGate(t)
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	// 先"热"一次缓存（读到缺省值）⇒ 保存后必须由 admin 侧的 InvalidateGatewayLimits
	// 才能看到新值；删掉那行接线本用例即红（审计 2026-09-22 R4：该接线此前无判据）。
	if got := gatewayLimitsFor(db); got.maxFileRefs != DefaultMaxFileRefsPerRequest {
		t.Fatalf("预热缓存应读到缺省值: %+v", got)
	}
	put := func(body string) *httptest.ResponseRecorder {
		t.Helper()
		w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", body, hdr)
		return w
	}
	if w := put(`{"max_file_refs":"64","body_parse_budget_mb":"512"}`); w.Code != http.StatusOK {
		t.Fatalf("合法值应 200，实得 %d (%s)", w.Code, w.Body.String())
	}
	if got := gatewayLimitsFor(db); got.maxFileRefs != 64 || got.budgetBytes != 512<<20 {
		t.Fatalf("保存后运行期未生效: %+v", got)
	}
	for _, bad := range []string{
		`{"max_file_refs":"0"}`, `{"max_file_refs":"4097"}`, `{"max_file_refs":"abc"}`,
		`{"body_parse_budget_mb":"32"}`, `{"body_parse_budget_mb":"8193"}`,
		// 文件保留上限（2026-09-22）：1~30 天，0/31/非数字一律拒。
		`{"file_expiry_days":"0"}`, `{"file_expiry_days":"31"}`, `{"file_expiry_days":"7d"}`,
	} {
		if w := put(bad); w.Code != http.StatusBadRequest {
			t.Fatalf("越界值 %s 应 400，实得 %d (%s)", bad, w.Code, w.Body.String())
		}
	}
	if got := gatewayLimitsFor(db); got.maxFileRefs != 64 || got.budgetBytes != 512<<20 {
		t.Fatalf("被拒的提交改了配置: %+v", got)
	}
	// 合法值：保存后运行期立刻按新上限收敛（缓存已预热过）。
	if w := put(`{"file_expiry_days":"3"}`); w.Code != http.StatusOK {
		t.Fatalf("合法保留期应 200，实得 %d (%s)", w.Code, w.Body.String())
	}
	if got := gatewayLimitsFor(db).fileExpiry; got != 3*24*time.Hour {
		t.Fatalf("保留上限未生效: %v", got)
	}
	exp, clamped := enforceFileExpiry(db, nil)
	if !clamped || exp == nil || time.Until(*exp) > 4*24*time.Hour {
		t.Fatalf("改动后未按 3 天收敛: %v clamped=%v", exp, clamped)
	}
	// GET 必须回显生效值（管理端看到的数字 = 运行期用的数字）。
	w, out := adminReq(t, r, "GET", "/api/server/admin/gateway", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("GET %d", w.Code)
	}
	if out["max_file_refs"] != "64" || out["body_parse_budget_mb"] != "512" {
		t.Fatalf("GET 回显 = %v / %v, want 64 / 512", out["max_file_refs"], out["body_parse_budget_mb"])
	}
	if out["file_expiry_days"] != "3" {
		t.Fatalf("GET 回显 file_expiry_days = %v, want 3", out["file_expiry_days"])
	}
}

// TestBodyParseGateCoversCandidateLoopEdits：闸门不只在 prepare 阶段生效 ——
// 候选循环里的三次整 body 编辑（渠道覆盖 / max_tokens 默认 / 流式 usage 注入）
// 同样要过闸门；打满时必须 503 SERVER，并且**不能留下 pending usage 悬挂行**
// （流式请求在循环前已插入 pending 行，早退必须清掉）。
//
// 夹具要点：请求体 ≥64KiB 且不含 file_id / user_id / `\u` ⇒ prepare 走零重编码快路径
// **不占额度**；于是"闸门被占满"只会在循环内的编辑上暴露。
func TestBodyParseGateCoversCandidateLoopEdits(t *testing.T) {
	resetBodyParseGate(t)
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	// 把模型的 default_params 清空 ⇒ 候选循环里**只有**流式 usage 注入这一处会占额度；
	// 否则 `applyMaxTokensDefault` 会先撞上闸门，判据就分不清是哪一处的处理生效了
	// （变异验证实测：不清空时"删掉流式分支"仍绿 —— 判据被另一处兜住）。
	if _, err := db.Exec(`UPDATE models SET default_params = '' WHERE name = 'deepseek-chat'`); err != nil {
		t.Fatal(err)
	}

	if err := serverstore.SetSetting(db, SettingBodyParseBudgetMB, "64"); err != nil {
		t.Fatal(err)
	}
	InvalidateGatewayLimits()
	budget := int64(MinBodyParseBudgetMB) << 20
	releaseGate, ok := globalBodyParseGate.acquire(budget, budget)
	if !ok {
		t.Fatal("占满闸门失败（夹具问题）")
	}
	defer releaseGate()

	filler := strings.Repeat("x", 96<<10) // ≥ fastPathMinBytes，且不含触发慢路径的子串
	body := `{"model":"deepseek-chat","messages":[{"role":"user","content":"` + filler + `"}],"stream":true}`
	w := doPost(t, r, "/v1/chat/completions", body, token, nil)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("循环内编辑撞闸门时应 503，实得 %d (%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"code":"SERVER"`) {
		t.Fatalf("code 必须是 SERVER: %s", w.Body.String())
	}
	var rows int
	if err := db.QueryRow(`SELECT count(*) FROM usage`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("早退路径留下了 %d 条 pending usage 行（悬挂行会永久为零计费）", rows)
	}
}

// ---------------------------------------------------------------------------
// 第 4 轮复审（F 路 R4）新发现 N-1~N-5 的判据
// ---------------------------------------------------------------------------

// TestSanitizeUsesNumberDecoder（N-1）：净化闸门与出站加工必须**同一套解码口径**。
// 普通 `json.Unmarshal` 把数字解成 float64，遇到 `1e400` 这类合法 JSON 会报错，
// 于是 fail-closed 的调用方把一份**合法请求**判成"请求体不是合法 JSON"而 400。
func TestSanitizeUsesNumberDecoder(t *testing.T) {
	// 合法 JSON：越界数值 + 顶层 `dsh_` 字样（触发净化解析路径）。
	body := []byte(`{"temperature":1e400,"model":"m","dsh_session_log":"x"}`)
	out, err := sanitizeOutboundBody(nil, body)
	if err != nil {
		t.Fatalf("合法 JSON 被净化闸门拒绝（N-1 回归）：%s", body)
	}
	if bytes.Contains(out, []byte("dsh_session_log")) {
		t.Fatalf("私有扩展字段未被剔除: %s", out)
	}
	// 越界数值必须逐字保真（UseNumber 的直接证据）。
	if !bytes.Contains(out, []byte("1e400")) {
		t.Fatalf("越界数值在重编码时漂移: %s", out)
	}
}

// TestFastPathJSONKeyDetection（N-4/N-5）：快路径的两个边界 ——
// ①`"user_id" :`（冒号前空白）也要判成"客户端自带"；②只有空白的大空对象不得尾插。
func TestFastPathJSONKeyDetection(t *testing.T) {
	pad := strings.Repeat("x", fastPathMinBytes)
	base := func(extra string) []byte {
		return []byte(`{"model":"m","messages":[{"role":"user","content":"` + pad + `"}]` + extra + `}`)
	}
	if !containsJSONKey(base(`,"user_id" : "spoofed"`), "user_id") {
		t.Fatal("`\"user_id\" :` 未被判成键（N-5 回归）")
	}
	// 判据必须打在**真实代码路径**上：`"user_id" :` 形态不得走快路径（否则出站体
	// 出现两个同名键）。变异验证实测：只测 containsJSONKey 时，把 fastPathUserID
	// 的判据退回 `"key":` 仍绿 —— 那是判据打偏，不是实现正确。
	if _, ok := fastPathUserID(base(`,"user_id" : "spoofed"`), 7, identityOpenAI); ok {
		t.Fatal("`\"user_id\" :` 形态走了快路径（会拼出重复键）")
	}
	if _, ok := fastPathUserID(base(`,"user_id":"spoofed"`), 7, identityOpenAI); ok {
		t.Fatal("标准自带形态走了快路径（应交给慢路径覆盖）")
	}
	if _, ok := fastPathUserID(base(``), 7, identityOpenAI); !ok {
		t.Fatal("不自带该键时应走快路径")
	}
	if !containsJSONKey(base(`,"user_id":"spoofed"`), "user_id") {
		t.Fatal("标准形态未被判成键")
	}
	if containsJSONKey(base(``), "user_id") {
		t.Fatal("没有该键时误判为自带（会让快路径永不命中）")
	}
	if containsJSONKey(base(`,"note":"user_id is a field"`), "user_id") {
		t.Fatal("只出现在**值**里的键名被误判为键")
	}
	// Responses 形态：正文里的 "role":"user" 不构成 `user` 键。
	if containsJSONKey(base(``), "user") {
		t.Fatal("`\"role\":\"user\"` 被误判成 user 键")
	}
	// 只有空白的大空对象：不得走快路径（否则拼出非法 JSON）。
	blank := []byte(`{` + strings.Repeat(" ", fastPathMinBytes+10) + `}`)
	if out, ok := fastPathUserID(blank, 1, identityOpenAI); ok {
		t.Fatalf("空白大空对象走了快路径，产物非法: %q", string(out[:40]))
	}
}

// TestSanitizeGoesThroughBodyGate（R5-1，第 4 轮复审）：净化必须与其它整 body 往返
// **共用同一个内存闸门**。旧实现自带 `json.Marshal` 且不过闸门 ⇒ 客户端只要加一个
// 顶层 `dsh_` 前缀键就能绕过内存闸门（实测闸门占满时仍 200 并完成整 body 往返），
// 而且默认 HTML 转义会把出站体放大到 6×（上游有 48/64MiB 口径）。
func TestSanitizeGoesThroughBodyGate(t *testing.T) {
	resetBodyParseGate(t)
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	if _, err := db.Exec(`UPDATE models SET default_params = '' WHERE name = 'deepseek-chat'`); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, SettingBodyParseBudgetMB, "64"); err != nil {
		t.Fatal(err)
	}
	InvalidateGatewayLimits()
	budget := int64(MinBodyParseBudgetMB) << 20
	releaseGate, ok := globalBodyParseGate.acquire(budget, budget)
	if !ok {
		t.Fatal("占满闸门失败（夹具问题）")
	}
	defer releaseGate()

	// ① 带顶层 `dsh_` 键（客户端可控）⇒ 净化也要占额度 ⇒ 503（旧实现这里 200）。
	filler := strings.Repeat("x", 96<<10)
	body := `{"model":"deepseek-chat","messages":[{"role":"user","content":"` + filler + `"}],"dsh_x":1}`
	w := doPost(t, r, "/v1/chat/completions", body, token, nil)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("净化路径绕过了内存闸门（%d）：%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"code":"SERVER"`) {
		t.Fatalf("code 必须是 SERVER（可重试）: %s", w.Body.String())
	}
	if upBody, _ := f.gotBody.Load().(string); upBody != "" {
		t.Fatalf("被闸门拒绝的请求不应触达上游: %s", upBody)
	}
}

// TestSanitizeDoesNotEscapeHTML（R5-1 的另一半）：净化重编码必须与加工侧同口径
// （`SetEscapeHTML(false)`），否则 HTML 密集正文 + `dsh_` 键会把出站体放大到 6×。
func TestSanitizeDoesNotEscapeHTML(t *testing.T) {
	resetBodyParseGate(t)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	// HTML 密集正文 + 一个顶层 `dsh_` 键（强制走剔除路径）。
	dense := strings.Repeat(`<div class='a'>&amp;</div>`, 5000)
	body := []byte(`{"model":"m","dsh_x":1,"messages":[{"role":"user","content":"` + dense + `"}]}`)
	out, err := sanitizeOutboundBody(db, body)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(out, []byte("dsh_x")) {
		t.Fatalf("dsh_ 键未剔除")
	}
	if n := float64(len(out)) / float64(len(body)); n > 1.05 {
		t.Fatalf("出站体膨胀 %.2f×（应≈1.00×，说明 HTML 转义没关）: in=%d out=%d", n, len(body), len(out))
	}
	if !bytes.Contains(out, []byte(`<div class='a'>`)) {
		t.Fatal("正文被转义，出站体不再是原文")
	}
}

// TestFastPathSkipsEscapedAndReferencedBodies（R4 P1-2）：快路径的两条**安全短路**
// 必须有行为覆盖 —— 删掉 `file_id` 或 `\u` 短路后旧判据全绿（审计实测：200 且他人
// file_id 出现在上游实收字节里）。这里用 ≥64KiB 的真实体逐条打穿。
func TestFastPathSkipsEscapedAndReferencedBodies(t *testing.T) {
	resetBodyParseGate(t)
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
	// A 的文件；B 将被拒绝。
	if err := serverstore.RecordGatewayFile(gw.db, "file-victim", gw.uidA, nil); err != nil {
		t.Fatal(err)
	}
	filler := strings.Repeat("x", 70<<10)

	// ① 大体积 + 真实（他人的）file_id 引用 ⇒ 必须 404，且零转发。
	body := `{"model":"deepseek-chat","messages":[{"role":"user","content":[{"type":"text","text":"` + filler + `"},{"type":"file","file_id":"file-victim"}]}]}`
	if _, ok := fastPathUserID([]byte(body), 2, identityOpenAI); ok {
		t.Fatal("含 file_id 的大体走了快路径（会跳过归属校验）")
	}
	if w := doPost(t, gw.r, "/v1/chat/completions", body, gw.tokenB, nil); w.Code != http.StatusNotFound {
		t.Fatalf("引用他人文件 status = %d (%s), want 404", w.Code, w.Body.String())
	}
	if up.hits.Load() != 0 {
		t.Fatalf("越权请求触达了上游（%d 次）", up.hits.Load())
	}

	// ② 大体积 + `\u` 转义键名（`file\u005fid`）⇒ 必须回落慢路径并被拦下。
	esc := `{"model":"deepseek-chat","messages":[{"role":"user","content":[{"type":"text","text":"` + filler + `"},{"type":"file","file\u005fid":"file-victim"}]}]}`
	if _, ok := fastPathUserID([]byte(esc), 2, identityOpenAI); ok {
		t.Fatal("含 \\u 转义的大体走了快路径（会漏掉转义后的引用）")
	}
	if w := doPost(t, gw.r, "/v1/chat/completions", esc, gw.tokenB, nil); w.Code != http.StatusNotFound {
		t.Fatalf("转义键名引用他人文件 status = %d (%s), want 404", w.Code, w.Body.String())
	}
	if up.hits.Load() != 0 {
		t.Fatalf("转义越权请求触达了上游（%d 次）", up.hits.Load())
	}
	// ③ 反向对照：同样的体（无引用）必须正常走通（证明 ①② 不是整体拒绝）。
	ok := `{"model":"deepseek-chat","messages":[{"role":"user","content":"` + filler + `"}]}`
	if _, ok2 := fastPathUserID([]byte(ok), 2, identityOpenAI); !ok2 {
		t.Fatal("无引用的大体应走快路径")
	}
	if w := doPost(t, gw.r, "/v1/chat/completions", ok, gw.tokenA, nil); w.Code != http.StatusOK {
		t.Fatalf("正常大体积请求 status = %d (%s)", w.Code, w.Body.String())
	}
}

// TestBodyParseGateTiersProtectSmallRequests（R4 P2 公平性）：单个员工用大体灌满
// 大体池后，**其他员工的普通小请求**仍必须走通 —— 否则一个租户能让全公司对话 503。
func TestBodyParseGateTiersProtectSmallRequests(t *testing.T) {
	resetBodyParseGate(t)
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
	if _, err := gw.db.Exec(`UPDATE models SET default_params = ''`); err != nil {
		t.Fatal(err)
	}

	// 直接占满"大体池"（不碰小体池）：模拟某员工灌 64MiB 级请求体。
	budget := int64(DefaultBodyParseBudgetMB) << 20
	_, largeCap := bodyParseTiers(budget)
	rel, ok := globalBodyParseGate.acquire(budget, largeCap)
	if !ok {
		t.Fatal("占满大体池失败（夹具问题）")
	}
	defer rel()

	// 其他员工的普通小请求（几 KB + 一个自己的 file_id ⇒ 慢路径）必须 200。
	if err := serverstore.RecordGatewayFile(gw.db, "file-mine", gw.uidA, nil); err != nil {
		t.Fatal(err)
	}
	small := `{"model":"deepseek-chat","messages":[{"role":"user","content":[{"type":"file","file_id":"file-mine"}]}]}`
	if w := doPost(t, gw.r, "/v1/chat/completions", small, gw.tokenA, nil); w.Code != http.StatusOK {
		t.Fatalf("大体池占满后，普通小请求被饿死（%d %s）—— 分档没生效", w.Code, w.Body.String())
	}
	// 大体仍然被拒（池子是硬上限）。
	big := `{"model":"deepseek-chat","messages":[{"role":"user","content":"` + strings.Repeat("x", 2<<20) + `"}],"dsh_x":1}`
	if w := doPost(t, gw.r, "/v1/chat/completions", big, gw.tokenA, nil); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("大体池占满时大请求应 503，实得 %d", w.Code)
	}
}

// TestGatewayLimitsCacheIsPerDB（R4 P2）：进程内缓存必须按库分键，否则测试/多库
// 场景会读到别的库的配置（审计实测 db2 读到 db1 的值）。
func TestGatewayLimitsCacheIsPerDB(t *testing.T) {
	resetBodyParseGate(t)
	db1, cleanup1 := serverstore.NewTestDB(t)
	t.Cleanup(cleanup1)
	db2, cleanup2 := serverstore.NewTestDB(t)
	t.Cleanup(cleanup2)

	if err := serverstore.SetSetting(db1, SettingMaxFileRefs, "111"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db2, SettingMaxFileRefs, "222"); err != nil {
		t.Fatal(err)
	}
	InvalidateGatewayLimits()
	if got := gatewayLimitsFor(db1).maxFileRefs; got != 111 {
		t.Fatalf("db1 = %d", got)
	}
	if got := gatewayLimitsFor(db2).maxFileRefs; got != 222 {
		t.Fatalf("db2 读到了 db1 的缓存值（%d）", got)
	}
	if got := gatewayLimitsFor(db1).maxFileRefs; got != 111 {
		t.Fatalf("回到 db1 = %d", got)
	}
}

// ---------------------------------------------------------------------------
// 文件保留上限 + 管理端清理面（2026-09-22 新需求）
// ---------------------------------------------------------------------------

// TestFileExpiryIsClampedToPlatformCap：客户端没带过期时间、或要得比上限更久，
// 一律按 `gateway.file_expiry_days` 收敛（缺省 7 天）—— 上游配额是全组织共享的
// （25 GiB / 10000 文件），保留期不能任人拉长；更早的保留期则尊重客户端。
func TestFileExpiryIsClampedToPlatformCap(t *testing.T) {
	resetBodyParseGate(t)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	// 缺省 7 天：无过期时间 ⇒ 收敛到 ~7 天。
	exp, clamped := enforceFileExpiry(db, nil)
	if !clamped || exp == nil {
		t.Fatalf("无过期时间必须收敛: exp=%v clamped=%v", exp, clamped)
	}
	if d := time.Until(*exp); d < 6*24*time.Hour || d > 8*24*time.Hour {
		t.Fatalf("收敛结果应接近 7 天，实得 %v", d)
	}
	// 上游给 30 天 ⇒ 收敛。
	far := time.Now().Add(30 * 24 * time.Hour)
	exp, clamped = enforceFileExpiry(db, &far)
	if !clamped || exp == nil || exp.After(far) {
		t.Fatalf("30 天必须收敛: exp=%v clamped=%v", exp, clamped)
	}
	// 上游给 1 天 ⇒ 尊重客户端（更早）。
	near := time.Now().Add(24 * time.Hour)
	exp, clamped = enforceFileExpiry(db, &near)
	if clamped || exp == nil || !exp.Equal(near) {
		t.Fatalf("更早的保留期不该被改写: exp=%v clamped=%v", exp, clamped)
	}
	// 改成 1 天 ⇒ 上限立即生效（保存后缓存失效由 admin 接线保证，这里手动失效）。
	if err := serverstore.SetSetting(db, SettingFileExpiryDays, "1"); err != nil {
		t.Fatal(err)
	}
	InvalidateGatewayLimits()
	exp, clamped = enforceFileExpiry(db, &far)
	if !clamped || time.Until(*exp) > 25*time.Hour {
		t.Fatalf("上限改成 1 天后应立刻收敛: %v", time.Until(*exp))
	}
}

// TestReapExpiredGatewayFiles：回收器只删**已过期**的行，且上游 404 视为成功；
// 上游失败时**保留行**（行是"还有清理责任"的唯一凭据）。
func TestReapExpiredGatewayFiles(t *testing.T) {
	resetBodyParseGate(t)
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	past := time.Now().Add(-time.Minute)
	future := time.Now().Add(time.Hour)
	if err := serverstore.RecordGatewayFile(gw.db, "file-expired-1", gw.uidA, &past); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.RecordGatewayFile(gw.db, "file-expired-2", gw.uidB, &past); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.RecordGatewayFile(gw.db, "file-live", gw.uidA, &future); err != nil {
		t.Fatal(err)
	}
	api := &API{DB: gw.db, client: &http.Client{}}
	deleted, failed := api.ReapExpiredGatewayFiles(0)
	if deleted != 2 || failed != 0 {
		t.Fatalf("reap = deleted %d failed %d, want 2/0", deleted, failed)
	}
	if up.deletes.Load() != 2 {
		t.Fatalf("上游删除调用 = %d, want 2", up.deletes.Load())
	}
	var left int
	if err := gw.db.QueryRow(`SELECT count(*) FROM gateway_files`).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != 1 {
		t.Fatalf("未过期的行必须保留（left=%d）", left)
	}
	// 幂等：再跑一轮无事发生。
	if deleted, failed := api.ReapExpiredGatewayFiles(0); deleted != 0 || failed != 0 {
		t.Fatalf("第二轮应无事发生: %d/%d", deleted, failed)
	}
}

// TestAdminGatewayFilesEndpoints：管理端「网关文件」面的读/删/清理闭环
// （按员工过滤、搜索、排序、汇总、单删、按条件批量清理 + 审计）。
func TestAdminGatewayFilesEndpoints(t *testing.T) {
	resetBodyParseGate(t)
	r, db, hdr := adminTestSetup(t)
	defer db.Close()
	// 删除/清理要真的往上游发 DELETE ⇒ 需要一个可用的 files 上游（deepseek 系）。
	up := newFakeFilesUpstream(t)
	if _, err := db.Exec(
		`INSERT INTO gateway_providers (name, base_url, api_key_enc, models) VALUES (?, ?, ?, '["deepseek-chat"]')`,
		"deepseek-official", up.srv.URL, upstreamKey,
	); err != nil {
		t.Fatal(err)
	}
	InvalidateUpstreams()
	alice, err := serverstore.CreateUser(db, &serverstore.User{Username: "files-alice", DisplayName: "Alice", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	bob, err := serverstore.CreateUser(db, &serverstore.User{Username: "files-bob", DisplayName: "Bob", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-time.Minute)
	future := time.Now().Add(time.Hour)
	seed := []struct {
		id   string
		user int64
		exp  *time.Time
		size int64
	}{
		{"file-a1", alice, &future, 1000},
		{"file-a2", alice, &past, 2000},
		{"file-b1", bob, &future, 3000},
	}
	for _, s := range seed {
		if err := serverstore.RecordGatewayFileSize(db, s.id, s.user, s.exp, s.size); err != nil {
			t.Fatal(err)
		}
	}

	// ① 列表：全量 3 条 + 合计。
	w, out := adminReq(t, r, "GET", "/api/server/admin/gateway/files", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("list %d %s", w.Code, w.Body.String())
	}
	if n, _ := out["total"].(float64); int(n) != 3 {
		t.Fatalf("total = %v, want 3", out["total"])
	}
	// ② 按员工过滤（用户名）。
	w, out = adminReq(t, r, "GET", "/api/server/admin/gateway/files?user=files-alice", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("filter %d", w.Code)
	}
	if n, _ := out["total"].(float64); int(n) != 2 {
		t.Fatalf("按员工过滤 total = %v, want 2", out["total"])
	}
	// ③ 搜索 file_id 子串。
	_, out = adminReq(t, r, "GET", "/api/server/admin/gateway/files?q=a2", "", hdr)
	if n, _ := out["total"].(float64); int(n) != 1 {
		t.Fatalf("搜索 total = %v, want 1", out["total"])
	}
	// ④ 状态过滤：已过期 1 条。
	_, out = adminReq(t, r, "GET", "/api/server/admin/gateway/files?state=expired", "", hdr)
	if n, _ := out["total"].(float64); int(n) != 1 {
		t.Fatalf("过期过滤 total = %v, want 1", out["total"])
	}
	// ⑤ 用户名查不到 ⇒ 空集（不能退化成全量）。
	_, out = adminReq(t, r, "GET", "/api/server/admin/gateway/files?user=nobody-here", "", hdr)
	if n, _ := out["total"].(float64); int(n) != 0 {
		t.Fatalf("未知用户 total = %v, want 0", out["total"])
	}
	// ⑥ 汇总：按字节降序，Bob 3KB 在 Alice 3KB 之前/之后都合法，但合计必须对。
	_, out = adminReq(t, r, "GET", "/api/server/admin/gateway/files/summary", "", hdr)
	rows, _ := out["rows"].([]any)
	if len(rows) != 2 {
		t.Fatalf("summary rows = %d, want 2", len(rows))
	}
	totals, _ := out["totals"].(map[string]any)
	if n, _ := totals["files"].(float64); int(n) != 3 {
		t.Fatalf("totals.files = %v", totals["files"])
	}
	if n, _ := totals["bytes"].(float64); int(n) != 6000 {
		t.Fatalf("totals.bytes = %v, want 6000", totals["bytes"])
	}
	// ⑦ 单删（上游删除 + 台账删行 + 审计）。
	w, out = adminReq(t, r, "DELETE", "/api/server/admin/gateway/files/file-a1", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("delete %d %s", w.Code, w.Body.String())
	}
	// ⑧ 清理必须有条件（空 body ⇒ 400，防误清全量）。
	w, _ = adminReq(t, r, "POST", "/api/server/admin/gateway/files/purge", `{}`, hdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("无条件清理应 400，实得 %d", w.Code)
	}
	// ⑨ 按员工 + 已过期清理。
	w, out = adminReq(t, r, "POST", "/api/server/admin/gateway/files/purge", `{"user":"files-alice","state":"expired"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("purge %d %s", w.Code, w.Body.String())
	}
	if n, _ := out["deleted"].(float64); int(n) != 1 {
		t.Fatalf("purge deleted = %v, want 1", out["deleted"])
	}
	var left int
	if err := db.QueryRow(`SELECT count(*) FROM gateway_files`).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != 1 {
		t.Fatalf("清理后应只剩 Bob 的 1 条（left=%d）", left)
	}
	if up.deletes.Load() != 2 {
		t.Fatalf("上游 DELETE 次数 = %d, want 2（单删 1 + 批量清理 1）", up.deletes.Load())
	}
	// ⑩ 审计留痕。
	var audits int
	if err := db.QueryRow(`SELECT count(*) FROM audit_logs WHERE action IN ('gateway_file_delete','gateway_file_purge')`).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if audits < 2 {
		t.Fatalf("审计行 = %d, want ≥2", audits)
	}
}

// ---------------------------------------------------------------------------
// 上传体过期时间重写（用户 2026-09-22 定案：让**上游也按上限保存**）
// ---------------------------------------------------------------------------

// parseUploadedForm 把假上游收到的上传体解析成 (字段 → 值, 文件名 → 内容)。
func parseUploadedForm(t *testing.T, up *fakeFilesUpstream) (map[string]string, map[string]string) {
	t.Helper()
	raw, _ := up.body.Load().(string)
	ct, _ := up.ctype.Load().(string)
	_, params, err := mime.ParseMediaType(ct)
	if err != nil {
		t.Fatalf("上游 Content-Type 非法: %q (%v)", ct, err)
	}
	mr := multipart.NewReader(strings.NewReader(raw), params["boundary"])
	fields := map[string]string{}
	files := map[string]string{}
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("上游收到的不是合法 multipart: %v", err)
		}
		b, _ := io.ReadAll(part)
		if part.FileName() != "" {
			files[part.FileName()] = string(b)
			continue
		}
		fields[part.FormName()] = string(b)
	}
	return fields, files
}

// TestUploadForcesExpiryCapUpstream：三种形态都必须让**上游收到**收进上限的过期时间：
// ①客户端要 30 天 ⇒ 改成上限；②客户端要 1 天 ⇒ 原样保留（更早的保留期尊重客户端）；
// ③客户端完全没带 ⇒ 补上 anchor + seconds。
func TestUploadForcesExpiryCapUpstream(t *testing.T) {
	resetBodyParseGate(t)
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
	capSeconds := int64(DefaultFileExpiryDays) * 24 * 3600

	upload := func(seconds string, withExpiry bool) (map[string]string, map[string]string) {
		t.Helper()
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		_ = mw.WriteField("purpose", "user_data")
		if withExpiry {
			_ = mw.WriteField("expires_after[anchor]", "created_at")
			_ = mw.WriteField("expires_after[seconds]", seconds)
		}
		fw, err := mw.CreateFormFile("file", "image.webp")
		if err != nil {
			t.Fatal(err)
		}
		_, _ = fw.Write([]byte("payload-bytes"))
		if err := mw.Close(); err != nil {
			t.Fatal(err)
		}
		if w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", bytes.NewReader(buf.Bytes()), gw.tokenA, mw.FormDataContentType()); w.Code != http.StatusOK {
			t.Fatalf("上传失败: %d %s", w.Code, w.Body.String())
		}
		return parseUploadedForm(t, up)
	}

	// ① 30 天 ⇒ 上限。
	fields, files := upload("2592000", true)
	if fields["expires_after[seconds]"] != strconv.FormatInt(capSeconds, 10) {
		t.Fatalf("30 天未被收敛: %q", fields["expires_after[seconds]"])
	}
	if fields["expires_after[anchor]"] != "created_at" {
		t.Fatalf("锚点被破坏: %q", fields["expires_after[anchor]"])
	}
	if files["image.webp"] != "payload-bytes" {
		t.Fatalf("文件内容被破坏: %q", files["image.webp"])
	}
	if fields["purpose"] != "user_data" {
		t.Fatalf("其它字段被破坏: %v", fields)
	}

	// ② 1 天 ⇒ 原样。
	fields, _ = upload("86400", true)
	if fields["expires_after[seconds]"] != "86400" {
		t.Fatalf("更早的保留期不该被改写: %q", fields["expires_after[seconds]"])
	}

	// ③ 完全没带 ⇒ 补上两个字段，且文件内容不变。
	fields, files = upload("", false)
	if fields["expires_after[seconds]"] != strconv.FormatInt(capSeconds, 10) {
		t.Fatalf("缺省未补上限: %v", fields)
	}
	if fields["expires_after[anchor]"] != "created_at" {
		t.Fatalf("缺省未补锚点: %v", fields)
	}
	if files["image.webp"] != "payload-bytes" {
		t.Fatalf("补字段时破坏了文件内容: %q", files["image.webp"])
	}
}

// TestUploadExpiryCapIsConfigurable：把上限改成 1 天后，上传体里的 seconds 也要跟着变
// （配置项真的作用在出站体上，而不是只影响台账）。
func TestUploadExpiryCapIsConfigurable(t *testing.T) {
	resetBodyParseGate(t)
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
	if err := serverstore.SetSetting(gw.db, SettingFileExpiryDays, "1"); err != nil {
		t.Fatal(err)
	}
	InvalidateGatewayLimits()

	body, ct := multipartBytes(t, "x") // 客户端要 86400（=1 天）：恰好等于上限，保留
	if w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", bytes.NewReader(body), gw.tokenA, ct); w.Code != http.StatusOK {
		t.Fatalf("上传失败: %d %s", w.Code, w.Body.String())
	}
	fields, _ := parseUploadedForm(t, up)
	if fields["expires_after[seconds]"] != "86400" {
		t.Fatalf("上限 1 天时客户端要 86400 应保留: %q", fields["expires_after[seconds]"])
	}
	// 再改成 30 天：客户端要 30 天（2592000）与上限相等 ⇒ 保留；说明上限值确实随配置变。
	if err := serverstore.SetSetting(gw.db, SettingFileExpiryDays, "30"); err != nil {
		t.Fatal(err)
	}
	InvalidateGatewayLimits()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	_ = mw.WriteField("expires_after[seconds]", "2592000")
	fw, _ := mw.CreateFormFile("file", "f.bin")
	_, _ = fw.Write([]byte("y"))
	_ = mw.Close()
	if w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", bytes.NewReader(buf.Bytes()), gw.tokenA, mw.FormDataContentType()); w.Code != http.StatusOK {
		t.Fatalf("上传失败: %d %s", w.Code, w.Body.String())
	}
	fields, _ = parseUploadedForm(t, up)
	if fields["expires_after[seconds]"] != "2592000" {
		t.Fatalf("上限 30 天时 30 天请求应保留: %q", fields["expires_after[seconds]"])
	}
}

// TestUploadRewriteFailsClosedOnMemoryGate：重写要占用内存闸门（原文 + 新体 ≈ 2×），
// 闸门打满时必须是 503 SERVER 且**不触达上游**（不能悄悄退回流式转发把上限放过去）。
func TestUploadRewriteFailsClosedOnMemoryGate(t *testing.T) {
	resetBodyParseGate(t)
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
	if err := serverstore.SetSetting(gw.db, SettingBodyParseBudgetMB, "64"); err != nil {
		t.Fatal(err)
	}
	InvalidateGatewayLimits()
	budget := int64(MinBodyParseBudgetMB) << 20
	rel, ok := globalBodyParseGate.acquire(budget, budget)
	if !ok {
		t.Fatal("占满闸门失败（夹具问题）")
	}
	defer rel()

	body, ct := multipartBytes(t, strings.Repeat("z", 8<<10))
	w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", bytes.NewReader(body), gw.tokenA, ct)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("闸门占满时上传应 503，实得 %d (%s)", w.Code, w.Body.String())
	}
	if up.hits.Load() != 0 {
		t.Fatalf("被闸门拒绝的上传不应触达上游（%d 次）", up.hits.Load())
	}
}

// TestNonMultipartUploadPassesThrough：非 multipart 体（畸形 Content-Type）**原样转发**，
// 由上游去拒绝 —— 上传重写不得把"上游能处理的请求"变成我们的新错误面。
func TestNonMultipartUploadPassesThrough(t *testing.T) {
	resetBodyParseGate(t)
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	raw := `{"not":"multipart"}`
	w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", strings.NewReader(raw), gw.tokenA, "application/json")
	if w.Code != http.StatusOK {
		t.Fatalf("非 multipart 上传应原样转发（%d %s）", w.Code, w.Body.String())
	}
	if got, _ := up.body.Load().(string); got != raw {
		t.Fatalf("体被改动了:\n got=%q\nwant=%q", got, raw)
	}
	if ct, _ := up.ctype.Load().(string); ct != "application/json" {
		t.Fatalf("Content-Type 被改动: %q", ct)
	}
}

// ---------------------------------------------------------------------------
// 第 6 轮审计（R6）P1/P2 的判据
// ---------------------------------------------------------------------------

// TestReaperDoesNotDeleteRenewedFile（R6 P1-A）：并发续期（同一 file_id 被重新登记
// 为未来过期）时，回收器**不得**删掉上游对象。
//
// 两段判据：①认领前已续期 ⇒ claim 直接失败（行与对象都不动）；
// ②认领与上游删除之间被重新登记（用测试注入点确定性复现）⇒ 跳过上游删除。
func TestReaperDoesNotDeleteRenewedFile(t *testing.T) {
	resetBodyParseGate(t)
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
	api := &API{DB: gw.db, client: &http.Client{}}

	// ① 认领前已续期。
	past := time.Now().Add(-time.Minute)
	future := time.Now().Add(time.Hour)
	if err := serverstore.RecordGatewayFile(gw.db, "file-renewed", gw.uidA, &past); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.RecordGatewayFile(gw.db, "file-renewed", gw.uidA, &future); err != nil {
		t.Fatal(err)
	}
	if deleted, _ := api.ReapExpiredGatewayFiles(0); deleted != 0 {
		t.Fatalf("已续期的行被回收（deleted=%d）", deleted)
	}
	var rows int
	if err := gw.db.QueryRow(`SELECT count(*) FROM gateway_files WHERE file_id = 'file-renewed'`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 {
		t.Fatalf("已续期的行被删掉了（rows=%d）", rows)
	}

	// ② 认领与上游删除之间被重新登记。
	if err := serverstore.RecordGatewayFile(gw.db, "file-race", gw.uidA, &past); err != nil {
		t.Fatal(err)
	}
	reapRecheckHook = func(id string) {
		if id != "file-race" {
			return
		}
		reapRecheckHook = nil
		// 模拟并发上传：同一个 id 被重新登记为未来过期。
		if err := serverstore.RecordGatewayFile(gw.db, id, gw.uidB, &future); err != nil {
			t.Errorf("re-register: %v", err)
		}
	}
	t.Cleanup(func() { reapRecheckHook = nil })
	before := up.deletes.Load()
	if deleted, _ := api.ReapExpiredGatewayFiles(0); deleted != 0 {
		t.Fatalf("被重新登记的文件不该计入回收（deleted=%d）", deleted)
	}
	if up.deletes.Load() != before {
		t.Fatalf("被重新登记的文件的上游对象被删了（deletes %d → %d）", before, up.deletes.Load())
	}
	if exists, err := serverstore.GatewayFileRowExists(gw.db, "file-race"); err != nil || !exists {
		t.Fatalf("重新登记的行必须保留: exists=%v err=%v", exists, err)
	}
}

// TestReaperRestoresRowOnUpstreamFailure（R6 测试盲区 M6）：上游删除失败时必须把台账行
// **写回**（行是"还有清理责任"的唯一凭据），下一轮才能重试。
func TestReaperRestoresRowOnUpstreamFailure(t *testing.T) {
	resetBodyParseGate(t)
	up := newFakeFilesUpstream(t)
	up.respond = func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodDelete {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"file-x"}`))
	}
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
	api := &API{DB: gw.db, client: &http.Client{}}

	past := time.Now().Add(-time.Minute)
	if err := serverstore.RecordGatewayFile(gw.db, "file-fails", gw.uidA, &past); err != nil {
		t.Fatal(err)
	}
	deleted, failed := api.ReapExpiredGatewayFiles(0)
	if deleted != 0 || failed != 1 {
		t.Fatalf("reap = %d/%d, want 0/1", deleted, failed)
	}
	if exists, err := serverstore.GatewayFileRowExists(gw.db, "file-fails"); err != nil || !exists {
		t.Fatalf("上游删除失败后必须写回台账行: exists=%v err=%v", exists, err)
	}
	// 上游恢复后下一轮能清掉（幂等重试）。
	up.respond = nil
	if deleted, failed := api.ReapExpiredGatewayFiles(0); deleted != 1 || failed != 0 {
		t.Fatalf("第二轮 = %d/%d, want 1/0", deleted, failed)
	}
}

// TestReaperNormalizesLegacyPermanentRows（R6 P2）：改造前"永久"（expires_at IS NULL）
// 的存量行必须被补上上限，否则它们永远不会被回收。
func TestReaperNormalizesLegacyPermanentRows(t *testing.T) {
	resetBodyParseGate(t)
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
	api := &API{DB: gw.db, client: &http.Client{}}

	if err := serverstore.RecordGatewayFile(gw.db, "file-legacy-perm", gw.uidA, nil); err != nil {
		t.Fatal(err)
	}
	// 把 created_at 推到 30 天前 ⇒ 补上限（7 天）后立刻过期。
	if _, err := gw.db.Exec(`UPDATE gateway_files SET created_at = now() - interval '30 days' WHERE file_id = 'file-legacy-perm'`); err != nil {
		t.Fatal(err)
	}
	if deleted, _ := api.ReapExpiredGatewayFiles(0); deleted != 1 {
		t.Fatalf("存量永久行未被补齐并回收（deleted=%d）", deleted)
	}
}

// TestAdminUserFilterIsUsernameOnly（R6 P1-B）：`user=` 只按用户名解，`user_id=` 才是 ID；
// 用户名恰好是数字时不得过滤到 id 相同的另一个人。
func TestAdminUserFilterIsUsernameOnly(t *testing.T) {
	resetBodyParseGate(t)
	r, db, hdr := adminTestSetup(t)
	defer db.Close()
	// 删除/清理要真的往上游发 DELETE ⇒ 需要一个可用的 files 上游（deepseek 系）。
	up := newFakeFilesUpstream(t)
	if _, err := db.Exec(
		`INSERT INTO gateway_providers (name, base_url, api_key_enc, models) VALUES (?, ?, ?, '["deepseek-chat"]')`,
		"deepseek-official", up.srv.URL, upstreamKey,
	); err != nil {
		t.Fatal(err)
	}
	InvalidateUpstreams()
	numeric, err := serverstore.CreateUser(db, &serverstore.User{Username: "2", DisplayName: "数字用户名", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	other, err := serverstore.CreateUser(db, &serverstore.User{Username: "other", DisplayName: "另一个人", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(time.Hour)
	if err := serverstore.RecordGatewayFile(db, "file-num", numeric, &future); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.RecordGatewayFile(db, "file-other", other, &future); err != nil {
		t.Fatal(err)
	}

	_, out := adminReq(t, r, "GET", "/api/server/admin/gateway/files?user=2", "", hdr)
	rows, _ := out["rows"].([]any)
	if len(rows) != 1 {
		t.Fatalf("user=2 应只命中用户名 2 的那一行，实得 %d 行", len(rows))
	}
	if id, _ := rows[0].(map[string]any)["file_id"].(string); id != "file-num" {
		t.Fatalf("user=2 命中了错误的人: %v", rows[0])
	}
	_, out = adminReq(t, r, "GET", "/api/server/admin/gateway/files?user_id="+strconv.FormatInt(other, 10), "", hdr)
	rows, _ = out["rows"].([]any)
	if len(rows) != 1 {
		t.Fatalf("user_id=%d 应命中 1 行，实得 %d", other, len(rows))
	}
	// purge 用数字用户名也不得删错人。
	w, out := adminReq(t, r, "POST", "/api/server/admin/gateway/files/purge", `{"user":"2","state":"active"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("purge 数字用户名: %d %s", w.Code, w.Body.String())
	}
	if n, _ := out["deleted"].(float64); int(n) != 1 {
		t.Fatalf("purge deleted = %v, want 1", out["deleted"])
	}
	if exists, _ := serverstore.GatewayFileRowExists(db, "file-other"); !exists {
		t.Fatal("purge 删错了人（other 的行被删）")
	}
}

// TestAdminSummarySortsByRequestedKey（R6 P1-C）：三档排序都必须按请求的键生效
// （旧实现位置下标全部错位一列）。
func TestAdminSummarySortsByRequestedKey(t *testing.T) {
	resetBodyParseGate(t)
	r, db, hdr := adminTestSetup(t)
	defer db.Close()
	alice, _ := serverstore.CreateUser(db, &serverstore.User{Username: "sum-alice", Source: "local", Status: 1})
	bob, _ := serverstore.CreateUser(db, &serverstore.User{Username: "sum-bob", Source: "local", Status: 1})
	future := time.Now().Add(time.Hour)
	// bob：1 个大文件；alice：3 个小文件（bytes 与 files 的排序结果相反）。
	if err := serverstore.RecordGatewayFileSize(db, "sum-b1", bob, &future, 10<<20); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if err := serverstore.RecordGatewayFileSize(db, "sum-a"+strconv.Itoa(i), alice, &future, 1024); err != nil {
			t.Fatal(err)
		}
	}
	first := func(q string) string {
		t.Helper()
		_, out := adminReq(t, r, "GET", "/api/server/admin/gateway/files/summary?"+q, "", hdr)
		rows, _ := out["rows"].([]any)
		if len(rows) != 2 {
			t.Fatalf("%s: rows=%d", q, len(rows))
		}
		m, _ := rows[0].(map[string]any)
		name, _ := m["username"].(string)
		return name
	}
	if got := first("sort=bytes&order=desc"); got != "sum-bob" {
		t.Fatalf("按占用降序首行 = %s, want sum-bob（排序错位）", got)
	}
	if got := first("sort=files&order=desc"); got != "sum-alice" {
		t.Fatalf("按文件数降序首行 = %s, want sum-alice", got)
	}
	if got := first("sort=username&order=asc"); got != "sum-alice" {
		t.Fatalf("按用户名升序首行 = %s, want sum-alice", got)
	}
}

// TestAdminPurgeActiveRequiresUser（R6 P1-D）：删**有效**文件的批量清理必须指名员工，
// 否则一个请求就能清掉全组织的有效文件；未知 state 必须 400（不能静默扩大范围）。
func TestAdminPurgeActiveRequiresUser(t *testing.T) {
	resetBodyParseGate(t)
	r, db, hdr := adminTestSetup(t)
	defer db.Close()
	// 删除/清理要真的往上游发 DELETE ⇒ 需要一个可用的 files 上游（deepseek 系）。
	up := newFakeFilesUpstream(t)
	if _, err := db.Exec(
		`INSERT INTO gateway_providers (name, base_url, api_key_enc, models) VALUES (?, ?, ?, '["deepseek-chat"]')`,
		"deepseek-official", up.srv.URL, upstreamKey,
	); err != nil {
		t.Fatal(err)
	}
	InvalidateUpstreams()
	alice, _ := serverstore.CreateUser(db, &serverstore.User{Username: "purge-alice", Source: "local", Status: 1})
	bob, _ := serverstore.CreateUser(db, &serverstore.User{Username: "purge-bob", Source: "local", Status: 1})
	future := time.Now().Add(time.Hour)
	for _, seed := range []struct {
		id  string
		uid int64
	}{{"pa", alice}, {"pb", alice}, {"pc", bob}} {
		if err := serverstore.RecordGatewayFile(db, seed.id, seed.uid, &future); err != nil {
			t.Fatal(err)
		}
	}
	w, _ := adminReq(t, r, "POST", "/api/server/admin/gateway/files/purge", `{"state":"active"}`, hdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("无条件删有效文件应 400，实得 %d (%s)", w.Code, w.Body.String())
	}
	var left int
	if err := db.QueryRow(`SELECT count(*) FROM gateway_files`).Scan(&left); err != nil {
		t.Fatal(err)
	}
	if left != 3 {
		t.Fatalf("被拒的请求删了文件（left=%d）", left)
	}
	for _, bad := range []string{`{"state":"weird"}`, `{"state":"expired","user":"no-such-user"}`} {
		if w, _ := adminReq(t, r, "POST", "/api/server/admin/gateway/files/purge", bad, hdr); w.Code != http.StatusBadRequest {
			t.Fatalf("%s 应 400，实得 %d", bad, w.Code)
		}
	}
	// 指名员工后允许删他的有效文件（只删他的）。
	w, out := adminReq(t, r, "POST", "/api/server/admin/gateway/files/purge", `{"state":"active","user":"purge-alice"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("指定员工的有效文件清理应 200，实得 %d (%s)", w.Code, w.Body.String())
	}
	if n, _ := out["deleted"].(float64); int(n) != 2 {
		t.Fatalf("deleted = %v, want 2", out["deleted"])
	}
	if exists, _ := serverstore.GatewayFileRowExists(db, "pc"); !exists {
		t.Fatal("删到了别的员工的文件")
	}
}

// TestAdminDeleteExpiredFileByID（R6 P2）：过期行也允许管理员按 id 删除（列表里那一行
// 同样有删除按钮），不再因"过期 = 不存在"而 404。
func TestAdminDeleteExpiredFileByID(t *testing.T) {
	resetBodyParseGate(t)
	r, db, hdr := adminTestSetup(t)
	defer db.Close()
	up := newFakeFilesUpstream(t)
	if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models) VALUES (?, ?, ?, '["deepseek-chat"]')`,
		"deepseek-official", up.srv.URL, upstreamKey); err != nil {
		t.Fatal(err)
	}
	InvalidateUpstreams()
	past := time.Now().Add(-time.Minute)
	if err := serverstore.RecordGatewayFile(db, "file-expired-del", 1, &past); err != nil {
		t.Fatal(err)
	}
	if w, _ := adminReq(t, r, "DELETE", "/api/server/admin/gateway/files/file-expired-del", "", hdr); w.Code != http.StatusOK {
		t.Fatalf("删过期行应 200，实得 %d (%s)", w.Code, w.Body.String())
	}
	if exists, _ := serverstore.GatewayFileRowExists(db, "file-expired-del"); exists {
		t.Fatal("过期行没被删掉")
	}
}

// TestUploadRewriteKeepsPartHeadersAndAvoidsDuplicates（R6 P1-E/P1-F）：真实客户端形态
// （purpose→anchor→seconds→file）下必须**恰好一份** anchor/seconds，且 file part 的
// Content-Type 原样保留（旧实现强制 octet-stream）。
func TestUploadRewriteKeepsPartHeadersAndAvoidsDuplicates(t *testing.T) {
	resetBodyParseGate(t)
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	_ = mw.WriteField("purpose", "user_data")
	_ = mw.WriteField("expires_after[anchor]", "created_at")
	_ = mw.WriteField("expires_after[seconds]", "2592000") // 30 天 ⇒ 收敛
	fw, err := mw.CreatePart(map[string][]string{
		"Content-Disposition": {`form-data; name="file"; filename="image.webp"`},
		"Content-Type":        {"image/webp"},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = fw.Write([]byte("WEBP-BYTES"))
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	if w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", bytes.NewReader(buf.Bytes()), gw.tokenA, mw.FormDataContentType()); w.Code != http.StatusOK {
		t.Fatalf("上传失败: %d %s", w.Code, w.Body.String())
	}

	raw, _ := up.body.Load().(string)
	ct, _ := up.ctype.Load().(string)
	_, params, _ := mime.ParseMediaType(ct)
	mr := multipart.NewReader(strings.NewReader(raw), params["boundary"])
	counts := map[string]int{}
	fileCT := ""
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("上游收到非法 multipart: %v", err)
		}
		b, _ := io.ReadAll(part)
		if part.FileName() != "" {
			fileCT = part.Header.Get("Content-Type")
			if string(b) != "WEBP-BYTES" {
				t.Fatalf("文件字节被破坏: %q", b)
			}
			continue
		}
		counts[part.FormName()]++
		_ = b
	}
	if counts["expires_after[anchor]"] != 1 || counts["expires_after[seconds]"] != 1 {
		t.Fatalf("过期字段重复或缺失: %v（真实客户端形态必须各恰好一份）", counts)
	}
	if fileCT != "image/webp" {
		t.Fatalf("file part 的 Content-Type 丢失/被覆写: %q", fileCT)
	}
}

// TestUploadExpiryJSONEdges（R6 P2）：整对象写法的两个边界 —— 超大 seconds 必须收敛
// （float 比较，避免 int64 溢出）；超过体积上限时**整段原样转发**而不是截断改写。
func TestUploadExpiryJSONEdges(t *testing.T) {
	resetBodyParseGate(t)
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
	capSeconds := int64(DefaultFileExpiryDays) * 24 * 3600

	upload := func(expiryJSON string) (map[string]string, string) {
		t.Helper()
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		_ = mw.WriteField("expires_after", expiryJSON)
		fw, _ := mw.CreateFormFile("file", "f.bin")
		_, _ = fw.Write([]byte("z"))
		_ = mw.Close()
		if w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", bytes.NewReader(buf.Bytes()), gw.tokenA, mw.FormDataContentType()); w.Code != http.StatusOK {
			t.Fatalf("上传失败: %d %s", w.Code, w.Body.String())
		}
		raw, _ := up.body.Load().(string)
		ct, _ := up.ctype.Load().(string)
		fields, _ := parseUploadedForm(t, up)
		return fields, raw + ct
	}

	fields, _ := upload(`{"anchor":"created_at","seconds":1e300}`)
	if fields["expires_after"] == "" {
		t.Fatalf("expires_after 字段丢失: %v", fields)
	}
	var obj map[string]any
	if err := json.Unmarshal([]byte(fields["expires_after"]), &obj); err != nil {
		t.Fatal(err)
	}
	if n, _ := obj["seconds"].(float64); int64(n) != capSeconds {
		t.Fatalf("1e300 未被收敛到上限: %v", obj["seconds"])
	}
	// 超长 JSON：原样转发（不截断改写）——把整段体与原文对拍。
	big := `{"anchor":"created_at","seconds":2592000,"pad":"` + strings.Repeat("x", maxExpiryJSONBytes+10) + `"}`
	fields, _ = upload(big)
	if fields["expires_after"] != big {
		t.Fatalf("超长 expires_after 未原样转发（被截断改写）: len=%d want=%d", len(fields["expires_after"]), len(big))
	}
	// 只给 seconds、不给 anchor ⇒ 必须补 anchor。
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	_ = mw.WriteField("expires_after[seconds]", "2592000")
	fw, _ := mw.CreateFormFile("file", "g.bin")
	_, _ = fw.Write([]byte("w"))
	_ = mw.Close()
	if w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", bytes.NewReader(buf.Bytes()), gw.tokenA, mw.FormDataContentType()); w.Code != http.StatusOK {
		t.Fatalf("上传失败: %d %s", w.Code, w.Body.String())
	}
	fields, _ = parseUploadedForm(t, up)
	if fields["expires_after[anchor]"] != "created_at" {
		t.Fatalf("只给 seconds 时必须补 anchor: %v", fields)
	}
	if fields["expires_after[seconds]"] != strconv.FormatInt(capSeconds, 10) {
		t.Fatalf("seconds 未收敛: %v", fields)
	}
}

// TestNonMultipartUploadAlsoUsesGate（R6 P1-G）：非 multipart 的原样转发路径也必须占
// 内存额度，否则它成了闸门的后门。
func TestNonMultipartUploadAlsoUsesGate(t *testing.T) {
	resetBodyParseGate(t)
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
	if err := serverstore.SetSetting(gw.db, SettingBodyParseBudgetMB, "64"); err != nil {
		t.Fatal(err)
	}
	InvalidateGatewayLimits()
	budget := int64(MinBodyParseBudgetMB) << 20
	rel, ok := globalBodyParseGate.acquire(budget, budget)
	if !ok {
		t.Fatal("占满闸门失败（夹具问题）")
	}
	defer rel()

	w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", strings.NewReader(`{"a":1}`), gw.tokenA, "application/json")
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("闸门占满时非 multipart 上传也应 503，实得 %d (%s)", w.Code, w.Body.String())
	}
	if up.hits.Load() != 0 {
		t.Fatalf("被闸门拒绝的上传不应触达上游（%d 次）", up.hits.Load())
	}
}
