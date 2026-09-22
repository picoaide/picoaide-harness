package llmgateway

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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
	} {
		if w := put(bad); w.Code != http.StatusBadRequest {
			t.Fatalf("越界值 %s 应 400，实得 %d (%s)", bad, w.Code, w.Body.String())
		}
	}
	if got := gatewayLimitsFor(db); got.maxFileRefs != 64 || got.budgetBytes != 512<<20 {
		t.Fatalf("被拒的提交改了配置: %+v", got)
	}
	// GET 必须回显生效值（管理端看到的数字 = 运行期用的数字）。
	w, out := adminReq(t, r, "GET", "/api/server/admin/gateway", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("GET %d", w.Code)
	}
	if out["max_file_refs"] != "64" || out["body_parse_budget_mb"] != "512" {
		t.Fatalf("GET 回显 = %v / %v, want 64 / 512", out["max_file_refs"], out["body_parse_budget_mb"])
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
