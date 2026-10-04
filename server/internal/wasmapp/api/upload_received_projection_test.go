package api

import (
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// 本文件是审计 V-P2P7 的 **F-C**（P3）的判据化（2026-10-04，修复代理 P2 收口）：
//
//	`details.received`（"已收到哪些片"）的**口径与排序**零判据。
//
// 核验方实测（V3：把客户端的 `const got = [...received].sort((a, b) => a - b)` 改成
// `[...received]`）⇒ Go 结构判据 + 自写 7 条 TS 判据 + 包内 71 条 TS 判据**全绿**。
// 后果量级不大（片通常按序 PUT，集合往往已经有序），但"口径"是**跨端契约**：
//
//   - **服务端**：`received` 是"**磁盘上真实存在**的片序号，升序、去重"
//     （`upload.go` 的注释逐字如此；权威是磁盘而不是 `meta.json` —— `openLocked` 每次都
//     用 `scanChunks` 与磁盘对齐，顺手补上"文件在、meta 里没有"的片）；
//   - **客户端**：把服务端给的集合投影成 `details.received`，且必须是**升序副本**
//     （`[...received].sort((a, b) => a - b)`）—— 副本（不就地改内部 Set）、升序（模型读到的
//     顺序稳定、可与人读的日志对拍）。
//
// 判据两半（各自独立）：
//
//	① `TestUploadReceivedProjectionMatchesDisk`（**服务端行为面**）：乱序 PUT（2,0,1）、
//	   重复 PUT（覆盖语义）、续传查询（GET）、以及"磁盘上删掉一片"之后重新查询 —— 每一步都
//	   断言 `received` **升序**、**去重**、且与**磁盘上真实的 Chunk 文件集合逐一相等**；
//	   `received_bytes` 与磁盘字节和一致。这就是"与真实分片落盘状态对拍"。
//	② `TestClientIncompleteEnvelopeSortsReceived`（**客户端源码结构面**）：`details.received`
//	   的值必须是**本函数内声明的标识符**，而该标识符必须被赋成 `[...received].sort(...)`
//	   且比较器升序（`a - b`）。这一半直接关上 V3（去掉排序 ⇒ 红；改成内联 `[...received]` ⇒ 红）。
//
// 变异验证（实跑见交付报告「核验后收口」）：
//   - `scanChunks` 的 `sort.Ints(out)` 改成**降序** ⇒ ① 红（升序断言）；
//   - `openLocked` 不再与磁盘对齐（`sess.Received = idx` 改成保留 meta 值）⇒
//     ① 的"磁盘删片后必须跟着收缩"红；
//   - 客户端去掉 `.sort(...)`（= 核验方的 V3）⇒ ② 红。
func TestUploadReceivedProjectionMatchesDisk(t *testing.T) {
	gin.SetMode(gin.TestMode)
	env := newUploadEnv(t)
	wasm := testGuestModule(t)
	chunk, parts := planThree(t, wasm)
	token := env.tokens["alice"]
	const appID = "received-projection-app"

	sess := env.createUpload(token, appID, "1.0.0", int64(len(wasm)), chunk)

	// 判据的形状：把"一次读到的 received 投影"与**磁盘**对拍。
	// `diskChunks` 直接读会话目录里的 `chunk-<i>` 文件（生产侧的唯一权威）；
	// `diskBytes` 顺便给出字节和。
	diskChunks := func() ([]int, int64) {
		dir := env.sessionDir(sess.UploadID)
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatalf("读会话目录失败: %v（判据的观测面缺失）", err)
		}
		var idx []int
		var sum int64
		for _, e := range entries {
			if e.IsDir() || !strings.HasPrefix(e.Name(), "chunk-") {
				continue
			}
			i, cerr := strconv.Atoi(strings.TrimPrefix(e.Name(), "chunk-"))
			if cerr != nil {
				continue
			}
			fi, ferr := e.Info()
			if ferr != nil {
				t.Fatalf("stat %s: %v", e.Name(), ferr)
			}
			idx = append(idx, i)
			sum += fi.Size()
		}
		sort.Ints(idx)
		return idx, sum
	}
	// checkProjection 断言一份投影（`received` + `received_bytes`）与磁盘逐一相等，
	// 且 received **升序、去重**（口径是契约的一部分：模型与日志都按这个顺序读）。
	checkProjection := func(t *testing.T, what string, got []int, gotBytes int64) {
		t.Helper()
		want, wantBytes := diskChunks()
		for i := 1; i < len(got); i++ {
			if got[i-1] >= got[i] {
				t.Fatalf("%s 的 received = %v **不是严格升序去重**（口径破坏：客户端与模型都按升序读，"+
					"服务端契约是「升序、去重」）", what, got)
			}
		}
		if len(got) != len(want) {
			t.Fatalf("%s 的 received = %v，而磁盘上的片 = %v：投影必须与**真实落盘状态**逐一相等"+
				"（权威是磁盘，不是 meta.json）", what, got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("%s 的 received = %v, want %v（磁盘）", what, got, want)
			}
		}
		if gotBytes != wantBytes {
			t.Fatalf("%s 的 received_bytes = %d, want %d（磁盘上那些片的字节和）", what, gotBytes, wantBytes)
		}
	}

	// ---- ① 乱序 PUT：2、0、1 ----
	//
	// 顺序是**故意打乱**的：`received` 的升序若只是"PU T 顺序的副作用"，这里立刻暴露。
	for _, idx := range []int{2, 0, 1} {
		out := env.putChunk(token, sess.UploadID, idx, parts[idx])
		checkProjection(t, "PUT #"+strconv.Itoa(idx)+" 的响应", out.Received, out.ReceivedBytes)
	}
	// 自校准：三片真的都在磁盘上（否则上面三轮"与磁盘对拍"是空转）。
	if idx, _ := diskChunks(); len(idx) != len(parts) {
		t.Fatalf("自校准失败：磁盘上只有 %d 片（want %d）—— 判据的观测面不对", len(idx), len(parts))
	}

	// ---- ② 重复 PUT 同一片（覆盖语义）：集合不变、不重复 ----
	out := env.putChunk(token, sess.UploadID, 1, parts[1])
	checkProjection(t, "重复 PUT #1 的响应", out.Received, out.ReceivedBytes)
	if len(out.Received) != len(parts) {
		t.Fatalf("重复 PUT 之后 received = %v（want %d 片）：同一序号是覆盖语义，不得出现重复项",
			out.Received, len(parts))
	}

	// ---- ③ 续传查询（GET）：同一份投影 ----
	st := env.status(token, sess.UploadID)
	if st.TotalBytes != int64(len(wasm)) {
		t.Fatalf("total_bytes = %d, want %d", st.TotalBytes, len(wasm))
	}
	checkProjection(t, "GET /uploads/:id 的响应", st.Received, st.ReceivedBytes)

	// ---- ④ 磁盘删掉一片 ⇒ 投影必须**跟着磁盘收缩**（权威是磁盘，不是 meta.json）----
	//
	// 这一半咬的是"received 只信 meta.json"的实现（`openLocked` 每次都 `scanChunks` 对齐，
	// 顺手补上"文件在、meta 里没有"的片；把对齐删掉就红）。
	victim := env.sessionDir(sess.UploadID) + "/chunk-1"
	if err := os.Remove(victim); err != nil {
		t.Fatalf("删掉磁盘上的第 1 片失败: %v", err)
	}
	st = env.status(token, sess.UploadID)
	checkProjection(t, "磁盘删片之后的 GET", st.Received, st.ReceivedBytes)
	if len(st.Received) != 2 {
		t.Fatalf("磁盘上少了一片之后 received = %v，want 2 个序号（投影必须与磁盘对拍）", st.Received)
	}
}

// ---------------------------------------------------------------------------
// ② 客户端：`details.received` 必须是**升序副本**
// ---------------------------------------------------------------------------

// receivedFieldRe 抽取 `details` 里 `received:` 的**值**（要求是裸标识符：内联表达式会被
// 判红 —— 口径要求"先投影成一个具名值再放进信封"，这样"副本 + 排序"两件事都有落点）。
var receivedFieldRe = regexp.MustCompile(`(?m)^\s*received:\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*,`)

// TestClientIncompleteEnvelopeSortsReceived 是核验方 V3（去掉客户端排序 ⇒ 三侧全绿）的判据。
//
// 三条（缺一不可）：
//
//  1. `UPLOAD_INCOMPLETE` 信封的 `details.received` 值是**裸标识符**（不是内联展开的集合）；
//  2. 该标识符在 `uploadIncomplete` 函数体里被赋成 `[...received].sort(...)` ——
//     **副本**（不就地改动内部 Set）+ **排序**；
//  3. 比较器是**升序**（`a - b`）。
//
// 为什么读客户端源码：这条是跨端契约里"客户端那一半"（服务端那一半由
// `TestUploadReceivedProjectionMatchesDisk` 咬住），而本代理的文件面只有 Go 测试。
// 边界与 P7 的 Go 判据同：结构面证明"没有第二份会漂移的投影"，行为面在客户端套件里
// （`packages/host/enterprise/tests/wasm-apps.spec.ts`）。
func TestClientIncompleteEnvelopeSortsReceived(t *testing.T) {
	src := readWasmClientSource(t)

	// 1) 信封的 details.received ⇒ 裸标识符
	envelope := tsEnclosingWasmErrorBlock(t, src, "code: 'UPLOAD_INCOMPLETE'")
	details := tsBalancedBlock(t, envelope, "details:", "UPLOAD_INCOMPLETE 信封的 details")
	m := receivedFieldRe.FindStringSubmatch(details)
	if m == nil {
		t.Fatalf("在 `UPLOAD_INCOMPLETE` 信封的 details 里找不到 `received: <标识符>,`。\n"+
			"  本判据要求 received 是一个**具名值**（副本 + 排序的落点）：内联展开（`received: [...received]`）"+
			"或直接给内部集合（`received`）都会让\"排序/副本\"这两件事无处可查。\n  details=%s", details)
	}
	ident := m[1]

	// 2) + 3) 该标识符的定义：`[...received].sort(...)` 且升序
	body := tsFunctionBody(t, src, "const uploadIncomplete = (", "): WasmResponse => {",
		"uploadIncomplete")
	flat := strings.Join(strings.Fields(body), " ")
	want := ident + " = [...received].sort((a, b) => a - b)"
	if !strings.Contains(flat, want) {
		t.Fatalf("`uploadIncomplete` 里的 `%s` 不是「**升序副本**」：期望逐字\n"+
			"    const %s\n"+
			"  实际函数体（归一化空白）= %s\n"+
			"  口径（契约）：副本 = 不就地改动内部 Set；排序 = 模型与日志读到的顺序稳定（升序）。\n"+
			"  去掉 `.sort(...)`（核验方 V3）、改成降序、或改成内联 `received: [...received]` 都会在这里红。",
			ident, want, flat)
	}
	// 自校准（观测面自检）：抽到的确实是 `uploadIncomplete` 的函数体 —— 它必须既
	// 引用内部集合 `received`，又构造 `UPLOAD_INCOMPLETE` 信封。否则上面的断言是在别处
	// 匹配到的（判据退化成恒真）。
	if !strings.Contains(body, "received") || !strings.Contains(body, "'UPLOAD_INCOMPLETE'") ||
		!strings.Contains(body, "wasmError(") {
		t.Fatalf("从 `const uploadIncomplete = (` 起抽到的函数体不像 `uploadIncomplete`"+
			"（缺少 received / UPLOAD_INCOMPLETE / wasmError 之一）⇒ 抽取位置错了，"+
			"本判据会退化成恒真。函数体前 200 字节=%q", body[:min(200, len(body))])
	}
}

// tsFunctionBody 抽出从 marker 起、经 anchor（含 `{`）到配对 `}` 的函数体。
//
// 为什么需要 anchor：`uploadIncomplete` 的参数表里有**内联对象类型**（`{ status: number,
// text: string } | null`），"marker 之后第一个 `{`"会命中那个类型字面量 ⇒ 直接切错块。
func tsFunctionBody(t *testing.T, src, marker, anchor, what string) string {
	t.Helper()
	start := strings.Index(src, marker)
	if start < 0 {
		t.Fatalf("%s：找不到标记 %q（抽取面缺失，拒绝静默通过）", what, marker)
	}
	rest := src[start:]
	bodyAt := strings.Index(rest, anchor)
	if bodyAt < 0 {
		t.Fatalf("%s：找不到函数体锚点 %q（形态变了？必须回来更新判据）", what, anchor)
	}
	return tsBalancedFrom(t, rest[bodyAt+len(anchor)-1:], what)
}
