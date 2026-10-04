package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 本文件钉住客户端分片链**最后一跳**（`POST /apps/wasm/uploads/:id/complete`）在
// **传输层失败**（真断网 / 极端抖动 / 本跳出站计时器到点）时的信封语义。
//
// # 判据的由来（审计 FW-2 的客户端残余 → 修复代理 P2 钉旧语义 → 修复代理 P7 修掉它）
//
//	分片 PUT 那一段早已修好（独立审计 2026-09-18 P2-1）：会话一开，之后的传输失败一律回
//	**可续传**的 `UPLOAD_INCOMPLETE` + `details.upload_id`。但 `complete` 这一跳（此时
//	**所有分片都已经在服务端**，只剩最后一步）走的是通用出口 `gatewayFailure` ——
//	信封是 `GATEWAY_TIMEOUT` / `GATEWAY_UNAVAILABLE`，**不带** `upload_id`，hints 还是
//	那句通用的「重发同一条 publish」⇒ 模型/AI 拿不到续传把手，只能重开一次上传会话；
//	用户侧表现就是「白传一遍几百 MB」。同一条链路上两跳语义不一致 = 这就是 P7 修的缺陷。
//
// **P7 已落地（2026-10-04）**：本文件原为 P2 留下的**过渡性快照**（当时带着一个
// P7 过渡标记，钉的是「旧语义：不带 upload_id」；那个标记本单已删除，避免后人 grep
// 时误以为"还有一份没改造的过渡判据"）。按当时的约定，P7 落地时把它改成本文 ——
// A 段现在钉**新**语义（可续传、带 `upload_id`）。
// **B 段原样保留**：`gatewayFailure` 的函数体里仍然没有 `upload_id`，这一条既成立
// （通用出口服务的是「还没开会话就断了」的那些跳，那时根本没有 upload_id 可言），
// 也正是「通用出口 vs 可续传出口」的对照基线。
//
// # 现在钉的三条（任一条变了都会以明确的 Fatal/Error 报出来）
//
//	A. `complete` 跳的 `catch (cause)` 块体走**可续传出口**：`uploadIncomplete('complete', …)`，
//	   并把原网关信封（`gatewayFailure(cause)`）原样交给它 ⇒ 「这是传输失败」的分类不丢；
//	B. `gatewayFailure` 的函数体里**没有** `upload_id`（对照基线；它仍是通用出口）；
//	C. 可续传信封**只有一个构造点**（`code: 'UPLOAD_INCOMPLETE'` 恰好出现一次），该构造点
//	   带 `upload_id: uploadId` 与 `stage`，且两个出口（分片段 / complete 跳）都真的走它；
//	   附带反向对照：可续传信封只在「会话已开」之后出现（开会话那一跳手里还没有 id）。
//
// 为什么读源码而不只靠行为断言：本判据守的是**跨跳一致性**（两跳同一个信封构造点）。
// 行为面在 `packages/host/enterprise/tests/wasm-apps.spec.ts` 的 P7 用例里端到端跑
// （注入一次 complete 跳传输失败 ⇒ 同一个 upload_id 重发 ⇒ 201 且**零片重传**）。
// 两者一起：行为面证明「能用」，结构面证明「没有第二份会漂移的信封」。
//
// 变异验证（实跑见 temp/audit-v282/fixes/P7.md，全部只在 `cp -a` 隔离副本里做）：
//   - ① 把构造点里的 `upload_id: uploadId` 删掉（退回通用失败）⇒ 本文件 C 段红；
//   - ② 把可续传码 `UPLOAD_INCOMPLETE` 换成通用 `GATEWAY_TIMEOUT` ⇒ 本文件 C 段红
//     （扫描面自检：标记找不到即 Fatal，绝不静默通过）；
//   - ③ 把 A 段的 `uploadIncomplete('complete', …)` 改回 `return gatewayFailure(cause)`
//     ⇒ 本文件 A 段红。

// wasmClientSourceRel 是客户端分片编排的源码位置（仓库根相对）。
const wasmClientSourceRel = "packages/host/enterprise/src/wasm-apps.ts"

// resumableEnvelopeMarker 是可续传信封的**唯一**标记（构造点里的那个字面量）。
const resumableEnvelopeMarker = "code: 'UPLOAD_INCOMPLETE'"

// TestCompleteHopTransportFailureIsResumable 钉住客户端 `complete` 跳传输失败的**新语义**：
// 信封可续传（`UPLOAD_INCOMPLETE` + `details.upload_id`），且与分片段共用同一个构造点。
//
// 判据读客户端源码（Go 侧读 TS 有先例：`internal/archiveutil/reserved_device_name_parity_test.go`）；
// 这里读的**不是**「某个字符串出现过」，而是三处**结构**（见文件头 A/B/C）。
func TestCompleteHopTransportFailureIsResumable(t *testing.T) {
	src := readWasmClientSource(t)

	// ---- A. complete 跳的 catch 块：走可续传出口，且不丢原网关信封 ----
	const hopMarker = "const completeBudget = perCallBudget()"
	hopIdx := strings.Index(src, hopMarker)
	if hopIdx < 0 {
		t.Fatalf("在 %s 里找不到 complete 跳的预算声明 %q —— 客户端分片编排被改名/搬到别处了。"+
			"本判据钉的是「这一跳的传输失败信封**可续传**（带 upload_id）」这条语义，"+
			"形态变了就必须回来重新登记（不许静默通过）", wasmClientSourceRel, hopMarker)
	}
	catchIdx := strings.Index(src[hopIdx:], "catch (cause)")
	if catchIdx < 0 {
		t.Fatalf("%s 的 complete 跳里找不到 `catch (cause)` —— 传输失败的收口形态变了，"+
			"必须重新登记（本判据的存在意义就是「这条语义有人看着」）", wasmClientSourceRel)
	}
	catchBody := tsBalancedBlock(t, src[hopIdx+catchIdx:], "{", wasmClientSourceRel+" 的 complete 跳 catch")
	got := strings.Join(strings.Fields(catchBody), " ")
	if got == "return gatewayFailure(cause)" {
		t.Errorf("complete 跳的传输失败又回到了通用出口 `return gatewayFailure(cause)`：" +
			"那个信封**不带** `upload_id`（本文件 B 段钉着 gatewayFailure 的函数体里没有它），" +
			"模型/AI 只能重开一次上传会话 ⇒ 用户侧表现为「白传一遍几百 MB」（审计 FW-2 的客户端残余）。\n" +
			"  正确形态：`return uploadIncomplete('complete', gatewayFailure(cause), null)` ——" +
			"  可续传信封 + 原网关码经 `transport_code` 带出（分类不丢）。")
	}
	if !strings.Contains(got, "uploadIncomplete('complete'") {
		t.Errorf("complete 跳的 catch 没有走可续传出口 `uploadIncomplete('complete', …)`；实际块体 = `%s`。\n"+
			"  这一跳的传输失败必须回带 `details.upload_id` 的 `UPLOAD_INCOMPLETE`"+
			"（分片都已收到，重发只会重跑最后一跳）；"+
			"端到端判据 = packages/host/enterprise/tests/wasm-apps.spec.ts 的 P7 用例。", got)
	}
	if !strings.Contains(got, "gatewayFailure(cause)") {
		t.Errorf("complete 跳的 catch 里看不到 `gatewayFailure(cause)`：原网关信封（`GATEWAY_TIMEOUT` / "+
			"`GATEWAY_UNAVAILABLE`）必须作为 `transport_code` 的来源保留 —— 外层码统一成可续传，"+
			"但「这是传输失败、不是服务端拒了某一跳」这条分类不能丢。实际块体 = `%s`", got)
	}

	// ---- B. 通用出口仍然装不下续传把手（对照基线，未变） ----
	gfBody := tsBalancedBlock(t, src,
		"function gatewayFailure(cause: unknown): WasmResponse", wasmClientSourceRel+" 的 gatewayFailure")
	if strings.Contains(gfBody, "upload_id") {
		t.Errorf("`gatewayFailure` 的函数体里出现了 `upload_id`：它是**通用**出口" +
			"（服务的是「还没开会话就断了」的那些跳，那时根本没有 upload_id 可言）。" +
			"把续传把手塞进通用出口会让「这一跳到底该不该续传」变得不可读 —— " +
			"可续传信封 `uploadIncomplete` 才是正确落点。")
	}
	// 自校准：这个函数体确实取到了内容（否则上面那条 Contains 是空转）。
	if !strings.Contains(gfBody, "GATEWAY_TIMEOUT") || !strings.Contains(gfBody, "GATEWAY_UNAVAILABLE") {
		t.Fatalf("从 %s 抽到的 `gatewayFailure` 函数体不含两个网关码 ⇒ 抽取位置错了，"+
			"本判据的上一条断言会退化成恒真（判据的扫描面自检）", wasmClientSourceRel)
	}

	// ---- C. 可续传信封只有一个构造点，且带 upload_id / stage，两个出口都走它 ----
	if n := strings.Count(src, resumableEnvelopeMarker); n != 1 {
		t.Fatalf("`%s` 在 %s 里出现了 %d 次，本判据登记的是**恰好 1 次**"+
			"（P7 把两个出口收敛成同一个构造点：分片段与 complete 跳各写一份 = 迟早再漂一次）。"+
			"新增/拆分出口时回来重新登记", resumableEnvelopeMarker, wasmClientSourceRel, n)
	}
	envelope := tsEnclosingWasmErrorBlock(t, src, resumableEnvelopeMarker)
	if !strings.Contains(envelope, "upload_id: uploadId") {
		t.Errorf("`%s` 的信封里没有 `upload_id: uploadId`：可续传的**唯一**凭据必须在"+
			"（分片段与 complete 跳都靠它；缺了它模型只能重开一次上传会话）。", resumableEnvelopeMarker)
	}
	if !strings.Contains(envelope, "stage") {
		t.Errorf("`%s` 的信封里没有 `stage`：两个出口共用同一个构造点之后，"+
			"「是哪一段断的」只能靠它区分（续传提示不同：补缺失片 vs 只重跑最后一跳）。",
			resumableEnvelopeMarker)
	}
	// 两个出口都必须真的走这个构造点（否则「收敛成一个构造点」只是空话）。
	chunksBranch := tsBalancedBlock(t, src,
		"if (!slices.every((_, index) => received.has(index))) {",
		wasmClientSourceRel+" 的分片未收齐分支")
	chunksGot := strings.Join(strings.Fields(chunksBranch), " ")
	if !strings.Contains(chunksGot, "uploadIncomplete('chunks'") {
		t.Errorf("分片未收齐分支没有走 `uploadIncomplete('chunks', …)`：实际的块体 = `%s`。\n"+
			"  分片段的传输失败同样是可续传语义（独立审计 2026-09-18 P2-1），不许退回通用网关信封。",
			chunksGot)
	}
	// 反向对照（防「一律回可续传信封」式的退化）：开会话那一跳失败时手里**还没有** id，
	// 仍必须回通用网关信封 —— 所以可续传信封的调用点全部排在「会话已开」之后。
	opened := strings.Index(src, "uploadId = id")
	if opened < 0 {
		t.Fatalf("%s 里找不到开会话成功后的 `uploadId = id` —— 抽取面缺失，拒绝静默通过", wasmClientSourceRel)
	}
	if first := strings.Index(src, "uploadIncomplete('"); first < 0 || first < opened {
		t.Errorf("可续传信封的第一个调用点出现在「会话已开（`uploadId = id`）」之前："+
			"开会话本身失败时手里没有 upload_id，回可续传信封会把一个空 id 交给模型。"+
			"（first=%d, session-opened=%d）", first, opened)
	}
}

// readWasmClientSource 读客户端分片编排源码（缺文件即 Fatal：仓库结构事故，不是环境差异）。
func readWasmClientSource(t *testing.T) string {
	t.Helper()
	candidates := []string{
		filepath.Join("..", "..", "..", "..", filepath.FromSlash(wasmClientSourceRel)),
		filepath.Join("..", "..", "..", filepath.FromSlash(wasmClientSourceRel)),
		filepath.FromSlash(wasmClientSourceRel),
	}
	for _, c := range candidates {
		if raw, err := os.ReadFile(c); err == nil {
			return string(raw)
		}
	}
	wd, _ := os.Getwd()
	t.Fatalf("客户端源码 %s 不可达（测试工作目录 = %s，候选 %v）—— 这是仓库结构事故"+
		"（文件被改名/搬走），不是环境差异", wasmClientSourceRel, wd, candidates)
	return ""
}

// tsBalancedBlock 从 marker 起取**第一个** `{` 到与它配对的 `}` 之间的内容。
//
// 只做括号配对（对这几段短代码足够）：判据的「形状」由上面的 marker 与断言固定，
// 任何搬动/改名都会让 marker 落空 ⇒ Fatal，不会静默通过。
func tsBalancedBlock(t *testing.T, src, marker, what string) string {
	t.Helper()
	start := strings.Index(src, marker)
	if start < 0 {
		t.Fatalf("%s：找不到标记 %q（抽取面缺失，拒绝静默通过）", what, marker)
	}
	open := strings.Index(src[start:], "{")
	if open < 0 {
		t.Fatalf("%s：标记 %q 之后没有 `{`", what, marker)
	}
	return tsBalancedFrom(t, src[start+open:], what)
}

// tsEnclosingWasmErrorBlock 找 marker **之前最近**的 `wasmError({`，返回它配对的块体
// （= 那条信封的完整字段表）。
func tsEnclosingWasmErrorBlock(t *testing.T, src, marker string) string {
	t.Helper()
	mi := strings.Index(src, marker)
	if mi < 0 {
		t.Fatalf("%s 里找不到 %q —— 可续传信封的形态变了，必须重新登记", wasmClientSourceRel, marker)
	}
	const open = "wasmError({"
	ci := strings.LastIndex(src[:mi], open)
	if ci < 0 {
		t.Fatalf("%q 之前找不到 `%s`（信封不再由 wasmError 构造？）—— 必须重新登记", marker, open)
	}
	body := tsBalancedFrom(t, src[ci+len(open)-1:], wasmClientSourceRel+" 的 "+marker+" 信封")
	if !strings.Contains(body, "details") {
		t.Fatalf("%q 的信封块里没有 details（抽取位置错了？）—— 抽取面自检失败", marker)
	}
	return body
}

// tsBalancedFrom 从 s[0] == '{' 起做括号配对，返回块体（不含两端花括号）。
func tsBalancedFrom(t *testing.T, s, what string) string {
	t.Helper()
	if !strings.HasPrefix(s, "{") {
		t.Fatalf("%s：抽取位置不是 `{`（实现错误）", what)
	}
	depth := 0
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return s[1:i]
			}
		}
	}
	t.Fatalf("%s：花括号不配对（源码被截断？）", what)
	return ""
}
