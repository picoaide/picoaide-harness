package api

// 头白名单单一真源（R1-CLI-5 / R2I-11）与生成物对拍的判据。
//
// 三条：
//
//	① **生成物与真源逐字节一致**（改了 headerspec.go 不重跑生成器 ⇒ 红）——
//	   这是"客户端拿到的快照会不会过期"的唯一保险；
//	② **白名单只有一份定义**：`clientRequestHeaders`（校验用）必须由
//	   `EnvelopeRequestHeaders`（契约真源）派生，且没有任何第二处字面量；
//	③ 生成物里的头**就是**校验时接受的头（端到端：拿生成物里的每一项发一次请求）。

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
)

// TestHeadersArtifactMatchesSource 是生成物的逐字节门禁。
//
// 变异：改 EnvelopeRequestHeaders 却不重跑 `go generate ./internal/wasmapp/api` ⇒ 红；
// 手改 wasm-app-headers.json ⇒ 红。
func TestHeadersArtifactMatchesSource(t *testing.T) {
	path := filepath.Join(testServerRoot(t), "internal", "wasmapp", "api", headersArtifactName)
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读生成物 %s: %v（先跑 `go generate ./internal/wasmapp/api`）", path, err)
	}
	want := RenderHeadersJSON()
	if !bytes.Equal(got, want) {
		t.Fatalf("%s 与真源不一致（改了 headerspec.go 就要重跑 `go generate ./internal/wasmapp/api`）\n got=%s\nwant=%s",
			headersArtifactName, got, want)
	}
}

// headersArtifactName 是生成物文件名（用例与生成器共用一份字面量）。
//
// 生成器住在 cmd/（不能 import 测试文件常量），所以这里与 cmd 里的常量**必须一致**；
// 不一致时本用例会因为读不到文件而红（可发现），因此不引入第三处校验。
const headersArtifactName = "wasm-app-headers.json"

// TestHeadersArtifactParsesAndIsSorted 钉住生成物的**形状**（消费方是别的语言的包）。
func TestHeadersArtifactParsesAndIsSorted(t *testing.T) {
	var doc HeadersDoc
	if err := json.Unmarshal(RenderHeadersJSON(), &doc); err != nil {
		t.Fatalf("生成物不是合法 JSON: %v", err)
	}
	if doc.Schema != HeadersSpecSchema {
		t.Fatalf("schema = %q, want %q", doc.Schema, HeadersSpecSchema)
	}
	if len(doc.RequestHeaders) == 0 {
		t.Fatal("request_headers 不得为空")
	}
	// 顺序必须稳定（= 真源顺序），否则生成物每次都可能不同、无法对拍。
	if !reflect.DeepEqual(doc.RequestHeaders, EnvelopeRequestHeaders) {
		t.Fatalf("request_headers = %v, want %v（顺序即真源顺序）", doc.RequestHeaders, EnvelopeRequestHeaders)
	}
	if doc.Limits.HeaderCountMax != maxClientHeaderCount ||
		doc.Limits.HeaderValueBytesMax != maxClientHeaderBytes {
		t.Fatalf("limits 与 clientreq.go 的常量不同源: %+v", doc.Limits)
	}
	if doc.PlatformHeaders.ProofRequest != proofHeader {
		t.Fatalf("platform_headers.proof_request = %q, want %q", doc.PlatformHeaders.ProofRequest, proofHeader)
	}
}

// TestEnvelopeWhitelistHasNoSecondDefinition 是"单一真源"的结构断言。
//
// 手法：白名单的**唯一真源**是有序切片 `EnvelopeRequestHeaders`；校验视图
// `clientRequestHeaders` 必须是它的派生（少一个/多一个都红）。变异：在
// clientRequestHeaders 里手写一个字面量条目 ⇒ 红。
func TestEnvelopeWhitelistHasNoSecondDefinition(t *testing.T) {
	derived := make([]string, 0, len(clientRequestHeaders))
	for k := range clientRequestHeaders {
		derived = append(derived, k)
	}
	sort.Strings(derived)
	want := SortedEnvelopeHeaders()
	if !reflect.DeepEqual(derived, want) {
		t.Fatalf("校验视图 = %v, want %v（必须由 EnvelopeRequestHeaders 派生）", derived, want)
	}
	// 几张"绝不该在里面"的头：实测自定义协议下浏览器不发它们（契约 §3），
	// 放进来只会给伪造留面。变异：把 cookie/referer 加回白名单 ⇒ 红。
	for _, banned := range []string{"cookie", "referer", "sec-fetch-site", "sec-fetch-mode",
		"host", "authorization", "x-pico-app-proof"} {
		if _, ok := clientRequestHeaders[banned]; ok {
			t.Errorf("白名单不得包含 %q（平台/浏览器语义头，见 headerspec.go 的注释）", banned)
		}
	}
}

// TestEnvelopeWhitelistEndToEnd 用**生成物本身**驱动一次真实请求：
// 每一项都必须被接受（否则"客户端按生成物转发 ⇒ 400"就是必然）。
func TestEnvelopeWhitelistEndToEnd(t *testing.T) {
	e := newClientEnv(t, true)
	headers := map[string]string{}
	for _, h := range EnvelopeRequestHeaders {
		headers[h] = "v"
	}
	env := okEnvelope("demo")
	env.Headers = headers
	rec := e.post("demo", env)
	if rec.Code != http.StatusOK {
		t.Fatalf("生成物里的每个头都必须被接受，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	if e.hook.called != 1 {
		t.Fatal("带全量白名单的请求必须走到应用管线")
	}
}
