package llmgateway

// ===========================================================================
// RC4-1(第四轮复核 P1,批次 I1-underbill-residual):
// 载体键下的"字母表内文本"不得被剥成 384 token
//
// 报告点名的少收面:判据里的"像二进制"曾经等价于"base64 解码后可打印率
// < 95%"——而可打印率是**租户可控的文本属性**。只要把纯文本(长十六进制串、
// 均匀字母数字串、重复字符串)挂进已知的二进制载体键("data" / "b64_json" /
// "inline_data" / "url" 的 data: URI / Anthropic source.data),解码后的可打印
// 率就落进"像二进制"的区间,整段被折成 min(段长/4, 384) token:
//
//	4096 长十六进制串 @ "data"    → 399 token(字节口径 1039,少收 2.6×)
//	480 KiB 字母数字串 @ "data"   → 405 token(字节口径 122901,少收 303×)
//	12 MiB 字母数字串 @ "data"    → 404 token(字节口径 3145748,少收 7787×)
//
// 修复口径(rc4-1 ①②③):判据换成"租户难以伪造的取证"——
//
//	① 预算:被剥离字节有与危害同构的上界(单段 ≤ maxInlineBinaryPayloadBytes;
//	   "只有魔数、没有结构佐证"的载荷单请求 ≤ maxUnverifiedBinaryBytes);
//	② 魔数:解码前缀必须命中已知二进制容器魔数(JPEG/PNG/PDF/GIF/WebP/…),
//	   不匹配一律按文本计;
//	③ 文本:解码后整段的可打印率 ≥ maxBinaryTextPrintablePercent 一律按文本计
//	   (灰带 + "魔数 + 大段文本尾巴"的拼接都收敛在这里)。
//
// 本文件同时是"换等价写法"的自查矩阵(第三轮教训:只堵报告点名的那一条形态
// 等于没修),并且用**真图片字节**(标准库编码器输出)钉住 r7f1-1 不退化。
// ===========================================================================

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"net/http"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// 夹具:租户可控的"字母表内文本"与真图片字节
// ---------------------------------------------------------------------------

// rc4AlnumBlob 造 n 字节的均匀字母数字串:整段都在 base64 字母表内(所以会被
// 当成候选载荷),解码后可打印率却只有 ~37%(所以旧判据会把它当二进制)。
// 这是 rc3-2 / RC4-1 的标准伪装素材(报告的 480 KiB / 12 MiB 形态)。
func rc4AlnumBlob(n int) string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	var sb strings.Builder
	sb.Grow(n)
	x := uint32(0x9E3779B9)
	for i := 0; i < n; i++ {
		x = x*1664525 + 1013904223
		sb.WriteByte(alphabet[int((x>>16)%uint32(len(alphabet)))])
	}
	return sb.String()
}

// rc4WrapEscaped 把字符串按 width 折行,用 JSON 转义的 \n 连接(折行 base64 的
// 真实形态:载荷里出现两个字符的 `\n` 转义)。
func rc4WrapEscaped(s string, width int) string {
	var sb strings.Builder
	for i := 0; i < len(s); i += width {
		end := i + width
		if end > len(s) {
			end = len(s)
		}
		if i > 0 {
			sb.WriteString(`\n`)
		}
		sb.WriteString(s[i:end])
	}
	return sb.String()
}

// rc4Chunk 组装一个 PNG chunk(长度 + 类型 + 数据 + CRC32)。
func rc4Chunk(typ string, data []byte) []byte {
	out := make([]byte, 0, 12+len(data))
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(data)))
	out = append(out, hdr[:]...)
	out = append(out, typ...)
	out = append(out, data...)
	var crc [4]byte
	binary.BigEndian.PutUint32(crc[:], crc32.ChecksumIEEE(out[4:]))
	out = append(out, crc[:]...)
	return out
}

// rc4PNGBytes 造 n 字节的**结构合法 PNG**(签名 + IHDR + IDAT + IEND,CRC 链
// 正确)。用于需要精确控制体积的夹具:它必须走"已验证容器"的常规预算,而不是
// 被单段/未验证预算砍掉。IDAT 用确定性伪随机字节填充(容器结构合法即可,
// 不追求像素可解码);真图片字节见 rc4RealPNG / rc4RealJPEG / rc4RealGIF。
func rc4PNGBytes(n int) []byte {
	if n < 57 { // 比最小 PNG(8+25+12+12)还短:退回"魔数 + 伪随机"
		out := []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}
		x := uint32(0x12345678)
		for len(out) < n {
			x = x*1664525 + 1013904223
			out = append(out, byte(x>>24))
		}
		return out[:n]
	}
	out := make([]byte, 0, n)
	out = append(out, 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n')
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:4], 1)
	binary.BigEndian.PutUint32(ihdr[4:8], 1)
	ihdr[8], ihdr[9] = 8, 6 // bit depth 8 / RGBA
	out = append(out, rc4Chunk("IHDR", ihdr)...)
	idat := make([]byte, n-57)
	x := uint32(0x9E3779B9)
	for i := range idat {
		x = x*1664525 + 1013904223
		idat[i] = byte(x >> 24)
	}
	out = append(out, rc4Chunk("IDAT", idat)...)
	out = append(out, rc4Chunk("IEND", nil)...)
	return out
}

// rc4NoisyRGBA 造一张确定性噪声图(编码器输出因此是"真图片字节")。
func rc4NoisyRGBA(w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	x := uint32(0x12345678)
	for py := 0; py < h; py++ {
		for px := 0; px < w; px++ {
			x = x*1664525 + 1013904223
			img.SetRGBA(px, py, color.RGBA{uint8(x >> 24), uint8(x >> 16), uint8(x >> 8), 255})
		}
	}
	return img
}

// rc4RealPNG / rc4RealJPEG / rc4RealGIF 用标准库编码器产出**真图片字节**。
func rc4RealPNG(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestSpeed}
	if err := enc.Encode(&buf, rc4NoisyRGBA(w, h)); err != nil {
		t.Fatalf("png encode: %v", err)
	}
	return buf.Bytes()
}

func rc4RealJPEG(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, rc4NoisyRGBA(w, h), &jpeg.Options{Quality: 90}); err != nil {
		t.Fatalf("jpeg encode: %v", err)
	}
	return buf.Bytes()
}

func rc4RealGIF(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := gif.Encode(&buf, rc4NoisyRGBA(w, h), &gif.Options{NumColors: 256}); err != nil {
		t.Fatalf("gif encode: %v", err)
	}
	return buf.Bytes()
}

// rc4RealWebP 是一份**真 WebP 文件**(24×24 噪声,libwebp quality=50 输出)。
// Go 标准库没有 WebP 编码器,所以以字节常量内联(512 字节)。
const rc4RealWebPBase64 = "UklGRvgBAABXRUJQVlA4IOwBAABwCwCdASoYABgAPtFWpkwoJKOiKA1RABoJbACdMoMYOQP6ANsBzuX+A9QG8O+gB+s3WT/4" +
	"jzgLsCxBKgJrB6AeYGpBZrPmP2COZm9lX9TQxW6te2zP3xYCq75VwDbDxkF2Q8bgAPjyf6XKuJ7YKLhduEFPSVOLz6uQQ3Qm" +
	"Qyt99BjiMSTHPBB5UgRXCzkP61w/C4J1lIKSzHgWzBAeJ8XV/ql1PdY381nNBf/VkKsjwFxac86qSMea/WdmsFm/JwAnh2lr" +
	"jV6n0CfZMeE2lPxVtX1F2fG6X33+Msl6B90xE3uC33enLbWyi9R1VkFy2SAtD/eIz9RFqHewVYBHQYT4zV0zTmYvT2oLrCUF" +
	"BKnH+zchEehBvRmbpT1JfuS/q/P4rKghzT+w3CeqXt10wxD/gmylPgq0zFXjXs/UwaMnt49neIcR4baycS8KXNnsAmHdZ/P+" +
	"Ev7nFGwWRMOxwzLsaEyAGxJ2W0aMY4N6lwyuEr6Tqxpl3W/1UDDEoKCUnoRzViPJmIaHHfQFYXI8zKbHPJ+HAj+wG2LGJVEp" +
	"5KtDIuKHPdSbHDBVPnONVKH0EBYOTDZQX0GtBB5wtaygadUJxCTtc55uzK1Q1yeNM7tFsuzcYi3fl8up5TevF9c4N7dP6DBN" +
	"Fq7Pzv39AAA="

func rc4RealWebP(t *testing.T) []byte {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(rc4RealWebPBase64)
	if err != nil {
		t.Fatalf("webp fixture: %v", err)
	}
	return raw
}

// rc4ProgressiveJPEGBase64 是一份**渐进式 JPEG**(Pillow/libjpeg 输出,quality=70,
// 32×32 噪声)。Go 标准库的 image/jpeg 只产基线 JPEG,而渐进式的多个 SOS +
// 熵编码数据段正是标记链校验最容易写错的地方,所以单独固定一份外部编码器的
// 真字节(容器结构校验必须接受它,否则真实照片会被误判成文本而多收)。
const rc4ProgressiveJPEGBase64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEEx" +
	"NDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7" +
	"Ozs7Ozs7Ozs7Ozs7Ozv/wgARCAAgACADASIAAhEBAxEB/8QAFwABAQEBAAAAAAAAAAAAAAAAAgEDBP/EABUBAQEAAAAAAAAA" +
	"AAAAAAAAAAEA/9oADAMBAAIQAxAAAAEM6hj1ZVIS1Jcb/8QAHBAAAgIDAQEAAAAAAAAAAAAAAQIAEgMRIRNB/9oACAEBAAEF" +
	"AusS1hcTzEyFdlxt1tCOc0cm01WfGKtDyMWK2sv/xAAZEQADAAMAAAAAAAAAAAAAAAAAARESMXH/2gAIAQMBAT8Bxg3dEOn/" +
	"xAAbEQACAQUAAAAAAAAAAAAAAAAAEQECEiFBUf/aAAgBAgEBPwFKLji2Ipyf/8QAJhAAAgIBAgQHAQAAAAAAAAAAAREAAiEx" +
	"QRJRUmETIkJicYKhwf/aAAgBAQAGPwLwzVPTEVrHPLeYDXTkHMQVPiHiOBkbqA8fuz6pW9gQuYlqruYToNbPP5AK0+rj1Wr/" +
	"AJGD5Rzm3dWcJoHx6vaIkOyY3nU96if/xAAkEAEAAQMDAwUBAAAAAAAAAAABEQAhMUFRYXGRoYGx0eHw8f/aAAgBAQABPyHG" +
	"UUhUGv1806BvT9V2cUgggCiLSQTpnwUo3JE0ju0Welhx0Z06dKuJja2aQbHmpCBfMjImOsGrmjZthQzP69ulWkhbKZsmr++1" +
	"QE3YBdx6k/ryboiE040b7UWkMl6YlgpaSMzC4+8cd6smm5YSnx8a0vE4STzt37wBnUUbZvgtx71//9oADAMBAAIAAwAAABDS" +
	"6+T/xAAgEQACAgEEAwEAAAAAAAAAAAABESFBADFRYXGBoeHw/9oACAEDAQE/ECSK3qzP1Jo2beBN6JddcDeomRjAsnrj960v" +
	"DCgjBSvcAdy58Z//xAAeEQABAwUBAQAAAAAAAAAAAAABESExAEFxgZFR8f/aAAgBAgEBPxAmFBAXJG3f3dAqhhV98zLBLuWq" +
	"QTvPbPIs9GpLxdTyHiOOP//EABsQAQEBAAMBAQAAAAAAAAAAAAERIQAxQVFh/9oACAEBAAE/EBZYvwJeY0pjEc8NqpbCFTEA" +
	"haNKT4sYgorEuggekoLQ4qQTBimiQFkYsHrXimowIaAiIVEAojQehEMrUQCqgg+m7hcUal3w0qrrQgWs3kbtNjXS9wjSOlRp" +
	"DSymGCt8AXWhTROJAVAH7Czovu1R1HC0gLd5dVjUXRBEs4VW1CmCqEQuNYNO3eOR2xPskekEfibFOfmJTwNNx1ZYVAEXBEwA" +
	"VywVQ1A/vF0KQkKgii6HKotF4//Z"

// ---------------------------------------------------------------------------
// 断言助手
// ---------------------------------------------------------------------------

// rc4AssertNoStrip 断言这段请求体**一个字节都没被剥离**(全额 4 字节/token)。
func rc4AssertNoStrip(t *testing.T, body string) {
	t.Helper()
	textBytes, blobTokens := stripInlineBinaryPayloads([]byte(body))
	tokens := estimateTokensFromBytes(textBytes) + blobTokens
	raw := int64(len(body)) / 4
	if textBytes != int64(len(body)) || blobTokens != 0 || tokens != raw {
		t.Fatalf("文本被当成内联二进制剥离: text=%d blob=%d tokens=%d, body=%d(raw 口径 %d)",
			textBytes, blobTokens, tokens, len(body), raw)
	}
}

// rc4AssertFolded 断言载荷按平台视觉口径折算(min(载荷/4, 384)/图),
// 且载荷之外的文本全额计费。
func rc4AssertFolded(t *testing.T, body string, payloadLen int, images int64) {
	t.Helper()
	textBytes, blobTokens := stripInlineBinaryPayloads([]byte(body))
	wantPerImage := estimateTokensFromBytes(int64(payloadLen) / images)
	if wantPerImage > r7bVisionImageTokenCap {
		wantPerImage = r7bVisionImageTokenCap
	}
	if blobTokens != wantPerImage*images {
		t.Fatalf("真图片没有按平台视觉口径折算: blob=%d, want %d", blobTokens, wantPerImage*images)
	}
	if want := int64(len(body) - payloadLen); textBytes != want {
		t.Fatalf("折算把载荷之外的文本也吞了: text=%d, want %d", textBytes, want)
	}
}

// ---------------------------------------------------------------------------
// ① 报告点名的形态:载体键 + 字母表内文本 ⇒ 全额文本口径
// ---------------------------------------------------------------------------

// TestRC4CarrierKeyAlphabetTextIsBilledAsText:五种"字母表内文本" × 七种载体键
// 的全矩阵,一个字节都不许剥离。
func TestRC4CarrierKeyAlphabetTextIsBilledAsText(t *testing.T) {
	payloads := []struct{ name, payload string }{
		{"4096 长十六进制串(大写)", strings.Repeat("DEADBEEF", 512)},
		{"4096 长十六进制串(小写)", strings.Repeat("deadbeef", 512)},
		{"4096 长十六进制串(大小写+数字混写)", strings.Repeat("DeAdBeEf01", 410)},
		{"24KiB 均匀字母数字串", rc4AlnumBlob(24 << 10)},
		{"24KiB 单字符重复(A)", strings.Repeat("A", 24<<10)},
		{"24KiB 单字符重复(z)", strings.Repeat("z", 24<<10)},
	}
	carriers := []struct {
		name string
		body func(string) string
	}{
		{"data 键(裸 base64)", func(p string) string { return `{"data":"` + p + `"}` }},
		{"data 键(冒号后空格)", func(p string) string { return `{"data": "` + p + `"}` }},
		{"b64_json 键", func(p string) string { return `{"b64_json":"` + p + `"}` }},
		{"inline_data.data(Gemini)", func(p string) string {
			return `{"inline_data":{"mime_type":"image/png","data":"` + p + `"}}`
		}},
		{"url 键 + data:image/png", func(p string) string {
			return `{"image_url":{"url":"data:image/png;base64,` + p + `"}}`
		}},
		{"url 键 + DATA:IMAGE/JPEG;BASE64,", func(p string) string {
			return `{"url":"DATA:IMAGE/JPEG;BASE64,` + p + `"}`
		}},
		{"Anthropic source.data", func(p string) string {
			return `{"source":{"type":"base64","media_type":"image/png","data":"` + p + `"}}`
		}},
	}
	for _, p := range payloads {
		for _, c := range carriers {
			t.Run(p.name+" @ "+c.name, func(t *testing.T) {
				rc4AssertNoStrip(t, c.body(p.payload))
			})
		}
	}
}

// TestRC4CarrierKeyLargeBlobsStayBilledAsText:报告表格里的三个**尺寸形态**
// (4096 hex / 480 KiB / 12 MiB),以及 64 KiB 边界 —— 全额文本口径,同时钉住
// rc3-1 的线性预算(12 MiB 载荷必须仍在秒级完成)。
func TestRC4CarrierKeyLargeBlobsStayBilledAsText(t *testing.T) {
	cases := []struct {
		name   string
		blob   string
		budget time.Duration
	}{
		{"4096 长十六进制串", strings.Repeat("DeAdBeEf01", 410), time.Second},
		{"64KiB 均匀字母数字串", rc4AlnumBlob(64 << 10), time.Second},
		{"480KiB 均匀字母数字串", rc4AlnumBlob(480 << 10), 2 * time.Second},
		{"12MiB 单段均匀字母数字串", rc4AlnumBlob(12 << 20), 3 * time.Second},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			body := `{"data":"` + c.blob + `"}`
			start := time.Now()
			textBytes, blobTokens := stripInlineBinaryPayloads([]byte(body))
			elapsed := time.Since(start)
			tokens := estimateTokensFromBytes(textBytes) + blobTokens
			raw := int64(len(body)) / 4
			t.Logf("body=%8d 字节 → text=%8d blob=%d tokens=%8d(raw=%d) 耗时=%v",
				len(body), textBytes, blobTokens, tokens, raw, elapsed)
			if textBytes != int64(len(body)) || blobTokens != 0 {
				t.Fatalf("字母表内文本被剥离 %d 字节(应一个字节都不剥): text=%d body=%d",
					int64(len(body))-textBytes, textBytes, len(body))
			}
			if tokens != raw {
				t.Fatalf("文本口径不等于 4 字节/token: tokens=%d, want %d", tokens, raw)
			}
			if elapsed > c.budget {
				t.Fatalf("剥离扫描耗时 %v > %v(rc3-1 的线性预算被破坏)", elapsed, c.budget)
			}
		})
	}
}

// TestRC4ProbeStormStaysFast:2000 个"合格候选段"(每个 4 KiB 字母表内文本,
// 全部带载体键)也不能把剥离器变成 CPU 放大器 —— 每次探测都要解码,总代价必须
// 与请求体长度同阶。
func TestRC4ProbeStormStaysFast(t *testing.T) {
	const segments = 2000
	seg := rc4AlnumBlob(4096)
	var sb strings.Builder
	sb.WriteString(`{"c":[`)
	for i := 0; i < segments; i++ {
		sb.WriteString(`{"data":"`)
		sb.WriteString(seg)
		sb.WriteString(`"},`)
	}
	sb.WriteString(`]}`)
	body := []byte(sb.String())
	start := time.Now()
	textBytes, blobTokens := stripInlineBinaryPayloads(body)
	elapsed := time.Since(start)
	t.Logf("%d 段候选(共 %d 字节)→ text=%d blob=%d 耗时=%v", segments, len(body), textBytes, blobTokens, elapsed)
	if blobTokens != 0 || textBytes != int64(len(body)) {
		t.Fatalf("候选段洪水被折算: text=%d blob=%d body=%d", textBytes, blobTokens, len(body))
	}
	if elapsed > 3*time.Second {
		t.Fatalf("候选段洪水耗时 %v > 3s(线性预算被破坏)", elapsed)
	}
}

// ---------------------------------------------------------------------------
// ② 端到端(真 HTTP + 真 PG):480 KiB 字母数字串挂 "data" 键
// ---------------------------------------------------------------------------

// TestRC4CarrierKeyUnderbillIsClosedE2E:复核报告实测 pt=405 / cost=0.012158
// (字节口径 122901 token,少收 303×)。修复后补估必须回到字节口径量级,
// 费用同量级 —— 而不是 384 token 的"一张图"。
func TestRC4CarrierKeyUnderbillIsClosedE2E(t *testing.T) {
	blob := rc4AlnumBlob(480 << 10)
	base := `{"model":"r3-model","stream":true,"data":"`
	cases := []struct{ name, body string }{
		{"裸 data 键", base + blob + `"}`},
		{"url + data:image/png;base64", `{"model":"r3-model","stream":true,"image_url":{"url":"data:image/png;base64,` + blob + `"}}`},
		{"Anthropic source.data", `{"model":"r3-model","stream":true,"source":{"type":"base64","media_type":"image/png","data":"` + blob + `"}}`},
	}
	var baseline int64
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			u := newR7bUpstream(t)
			u.silent = true // 上游/中转整条流不报 usage ⇒ 触发输入侧补估
			u.chunks, u.chunkText = 1, "答"
			r, db, uid, token := newAuditR3GatewayAt(t, u.srv.URL, 1000, 30, 30, 0)
			w := doPost(t, r, "/v1/chat/completions", c.body, token, nil)
			rows := r5UsageRows(t, db, uid)
			if w.Code != http.StatusOK || len(rows) != 1 {
				t.Fatalf("status=%d rows=%d body=%s", w.Code, len(rows), bodyHead(w))
			}
			got := rows[0]
			want := int64(len(c.body)) / 4
			wantCost := (float64(got.Prompt) + float64(got.Completion)) * 30 / 1e6
			t.Logf("body=%8d → pt=%8d ct=%d cost=%.6f estimated=%v(want pt≈%d)",
				len(c.body), got.Prompt, got.Completion, got.Cost, got.Estimated, want)
			if got.Prompt < want-16 || got.Prompt > want+16 {
				t.Fatalf("输入侧补估被字母表内文本压低: pt=%d, want ≈%d(字节口径)", got.Prompt, want)
			}
			if got.Prompt <= r7bVisionImageTokenCap {
				t.Fatalf("整段文本只按一张图计费(pt=%d ≤ %d):少收面没关", got.Prompt, r7bVisionImageTokenCap)
			}
			if !got.Estimated {
				t.Fatalf("补估行必须打 estimated 标记: %+v", got)
			}
			if diff := got.Cost - wantCost; diff > 1e-6 || diff < -1e-6 {
				t.Fatalf("费用口径异常: cost=%.6f, want %.6f", got.Cost, wantCost)
			}
			if i == 0 {
				baseline = got.Prompt
			} else if d := got.Prompt - baseline; d > 16 || d < -16 {
				t.Fatalf("同一段文本换一种载体落账差 %d token(第 %d 例 %d vs 基线 %d):判据被形态穿透",
					d, i, got.Prompt, baseline)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// ③ r7f1-1 不许退化:真图片(标准库编码器输出的真字节)仍折算成 384
// ---------------------------------------------------------------------------

// TestRC4RealImagesAreStillFoldedNotBilledByBytes:PNG/JPEG/GIF/WebP 各一份
// 真字节,挂在 url 键(带 data: 前缀)与 Anthropic source.data(裸 base64)下,
// 都必须按 384/图折算、载荷之外的文本全额计费。1 MiB 级真 PNG 也必须折算
// (不能被单段预算或"未验证"预算砍掉)。
func TestRC4RealImagesAreStillFoldedNotBilledByBytes(t *testing.T) {
	type fixture struct {
		name    string
		mime    string
		raw     []byte
		carrier string // uri | bare
	}
	fixtures := []fixture{
		{"真 PNG", "image/png", rc4RealPNG(t, 96, 96), "uri"},
		{"真 PNG(Anthropic 裸 base64)", "image/png", rc4RealPNG(t, 96, 96), "bare"},
		{"真 JPEG", "image/jpeg", rc4RealJPEG(t, 96, 96), "uri"},
		{"真 JPEG(Anthropic 裸 base64)", "image/jpeg", rc4RealJPEG(t, 96, 96), "bare"},
		{"真 GIF", "image/gif", rc4RealGIF(t, 96, 96), "uri"},
		{"真 WebP", "image/webp", rc4RealWebP(t), "uri"},
		{"1MiB 级真 PNG", "image/png", rc4RealPNG(t, 600, 600), "uri"},
		// base64 填充边界:载荷长度 %3 == 1 时去掉 '=' 后尾部只剩 1 个 6bit 块,
		// 按 4 的倍数截断会丢字节、把真图片判成"只有魔数"(rc4-1 自查发现的坑)。
		{"真 PNG(载荷长度 %3==0)", "image/png", rc4PNGBytes(3000), "uri"},
		{"真 PNG(载荷长度 %3==1)", "image/png", rc4PNGBytes(3001), "uri"},
		{"真 PNG(载荷长度 %3==2)", "image/png", rc4PNGBytes(3002), "uri"},
		{"真 PNG %3==1(Anthropic 裸 base64)", "image/png", rc4PNGBytes(4201), "bare"},
		// 载荷 > 512 KiB(未验证预算)且原始长度 %3==1:解码时丢掉填充后的最后
		// 若干字节会让容器校验失败、掉进收紧预算而被拒 —— 固定住"解码不许丢字节"。
		{"真 PNG(载荷长度 %3==1 且超过未验证预算)", "image/png", rc4PNGBytes(700_000), "uri"},
	}
	for _, f := range fixtures {
		t.Run(f.name, func(t *testing.T) {
			b64 := base64.StdEncoding.EncodeToString(f.raw)
			if len(b64) < minDataURIPayload {
				t.Fatalf("夹具太小(%d 字节 base64):测不到剥离路径", len(b64))
			}
			var body string
			if f.carrier == "bare" {
				body = `{"source":{"type":"base64","media_type":"` + f.mime + `","data":"` + b64 + `"}}`
			} else {
				body = `{"image_url":{"url":"data:` + f.mime + `;base64,` + b64 + `"}}`
			}
			t.Logf("真图 %d 字节 → base64 %d 字节", len(f.raw), len(b64))
			rc4AssertFolded(t, body, len(b64), 1)
		})
	}
}

// ---------------------------------------------------------------------------
// ④ 半真半假:魔数/容器结构拼接文本
// ---------------------------------------------------------------------------

// TestRC4HalfBinaryPayloadsStayText:
//   - 真 PNG 魔数 + 大量可打印文本尾巴 ⇒ 文本(③ 可打印率判据);
//   - 文本头 + 真 PNG 字节 ⇒ 文本(② 魔数不在前缀);
//   - 真 PNG 容器 + 超过未验证预算的文本尾巴 ⇒ 文本(① 预算);
//   - 真图与文本载荷混在同一请求 ⇒ 只有真图折算。
func TestRC4HalfBinaryPayloadsStayText(t *testing.T) {
	realPNG := rc4RealPNG(t, 96, 96)
	tail := strings.Repeat("tell me a story about billing. ", 20_000) // 640 KB 可打印文本

	magicPlusText := append(append([]byte{}, realPNG[:8]...), []byte(tail[:200_000])...)
	textPlusMagic := append([]byte(tail[:200_000]), realPNG...)
	pngPlusText := append(append([]byte{}, realPNG...), []byte(tail)...)

	t.Run("真 PNG 魔数 + 大量可打印文本尾巴", func(t *testing.T) {
		b64 := base64.StdEncoding.EncodeToString(magicPlusText)
		rc4AssertNoStrip(t, `{"image_url":{"url":"data:image/png;base64,`+b64+`"}}`)
	})
	t.Run("文本头 + 真 PNG 字节", func(t *testing.T) {
		b64 := base64.StdEncoding.EncodeToString(textPlusMagic)
		rc4AssertNoStrip(t, `{"image_url":{"url":"data:image/png;base64,`+b64+`"}}`)
	})
	t.Run("真 PNG 容器 + 超预算文本尾巴", func(t *testing.T) {
		b64 := base64.StdEncoding.EncodeToString(pngPlusText)
		if len(b64) <= maxUnverifiedBinaryBytes {
			t.Fatalf("夹具 payload=%d 字节,没有超过未验证预算 %d", len(b64), maxUnverifiedBinaryBytes)
		}
		rc4AssertNoStrip(t, `{"image_url":{"url":"data:image/png;base64,`+b64+`"}}`)
	})
	t.Run("真图与文本载荷混合", func(t *testing.T) {
		imgB64 := base64.StdEncoding.EncodeToString(realPNG)
		text := rc4AlnumBlob(240 << 10)
		body := `{"c":[{"url":"data:image/png;base64,` + imgB64 + `"},{"url":"data:image/png;base64,` + text + `"}]}`
		textBytes, blobTokens := stripInlineBinaryPayloads([]byte(body))
		if blobTokens != r7bVisionImageTokenCap {
			t.Fatalf("真图未折算: blob=%d, want %d", blobTokens, r7bVisionImageTokenCap)
		}
		if want := int64(len(body) - len(imgB64)); textBytes != want {
			t.Fatalf("文本载荷没有全额计费: textBytes=%d, want %d", textBytes, want)
		}
	})
}

// TestRC4UnverifiedMagicFoldingIsBounded:伪造魔数(真 PNG 签名 + 伪随机字节,
// 容器结构校验必然失败)只能落在"只有魔数"的收紧预算里:
//
//	小载荷(≈87 KiB base64)⇒ 允许折算,但单请求总量不超过 maxUnverifiedBinaryBytes;
//	大载荷(≈1.05 MiB base64,超过该预算)⇒ 必须整体按文本计。
//
// 这是 rc4-1 ① 的"少收上界":伪造者即便付出构造魔数的成本,少收也被硬上限封住。
func TestRC4UnverifiedMagicFoldingIsBounded(t *testing.T) {
	// forged = 真 PNG 签名 + 伪随机字节:命中魔数,但 chunk 长度/CRC 链必然不合法。
	forged := func(n int) string {
		raw := make([]byte, 0, n)
		raw = append(raw, 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n')
		x := uint32(0xC0FFEE01)
		for len(raw) < n {
			x = x*1664525 + 1013904223
			raw = append(raw, byte(x>>24), byte(x>>16), byte(x>>8), byte(x))
		}
		return base64.StdEncoding.EncodeToString(raw[:n])
	}
	t.Run("小载荷按收紧预算折算", func(t *testing.T) {
		// 固定夹具:64 KiB 原始字节 = 87,384 字节 base64。
		b64 := forged(64 << 10)
		if len(b64) > maxUnverifiedBinaryBytes {
			t.Fatalf("夹具 %d 字节已超过未验证预算 %d", len(b64), maxUnverifiedBinaryBytes)
		}
		body := `{"data":"` + b64 + `"}`
		textBytes, blobTokens := stripInlineBinaryPayloads([]byte(body))
		if blobTokens != r7bVisionImageTokenCap {
			t.Fatalf("结构未验证的载荷没有按收紧预算折算: blob=%d, want %d", blobTokens, r7bVisionImageTokenCap)
		}
		if want := int64(len(body) - len(b64)); textBytes != want {
			t.Fatalf("textBytes=%d, want %d", textBytes, want)
		}
	})
	t.Run("大载荷超过收紧预算一律按文本计", func(t *testing.T) {
		// 固定夹具:64 KiB 原始字节 = 768 KiB? 不 —— 768 KiB 原始字节 = 1 MiB base64。
		// "只有魔数"的折算上界不许放宽到 1 MiB base64 之上(rc4-1 ① 的少收上界)。
		b64 := forged(768 << 10)
		if len(b64) != 1<<20 {
			t.Fatalf("夹具应为 1 MiB base64,实际 %d", len(b64))
		}
		rc4AssertNoStrip(t, `{"data":"`+b64+`"}`)
	})
}

// TestRC4OversizedSinglePayloadIsBilledAsText:单段载荷超过
// maxInlineBinaryPayloadBytes(8 MiB base64)即按文本计(rc4-1 ① 的单段上界)
// —— 即使是**结构完全合法**的真 PNG 也一样:12 MiB 的"总量"预算曾经意味着
// 单段也能全免费。夹具用**固定字节数**(不随常量漂移),所以上界一旦被放宽,
// 断言会以行为差异变红:8.7 MiB base64 必须按文本计,7.3 MiB 必须折算。
func TestRC4OversizedSinglePayloadIsBilledAsText(t *testing.T) {
	over := base64.StdEncoding.EncodeToString(rc4PNGBytes(6_815_744)) // 8.7 MiB base64
	if len(over) <= 8<<20 {
		t.Fatalf("夹具 %d 字节没有超过 8 MiB 单段上界", len(over))
	}
	if len(over) > 12<<20 {
		t.Fatalf("夹具 %d 字节超过了 12 MiB 总量预算,测不到单段上界", len(over))
	}
	rc4AssertNoStrip(t, `{"image_url":{"url":"data:image/png;base64,`+over+`"}}`)

	under := base64.StdEncoding.EncodeToString(rc4PNGBytes(5_767_168)) // 7.3 MiB base64
	if len(under) > 8<<20 {
		t.Fatalf("对照夹具 %d 字节超过 8 MiB 单段上界", len(under))
	}
	rc4AssertFolded(t, `{"image_url":{"url":"data:image/png;base64,`+under+`"}}`, len(under), 1)
}

// TestRC4ExternalEncoderImagesStillFold:容器校验必须接受**别的编码器**产出的
// 真图片字节(渐进式 JPEG 的多 SOS 结构、带 EXIF 的段、libwebp 的 chunk 链),
// 否则真实照片会掉进"只有魔数"的收紧预算甚至被按文本计(多收)。
// 夹具来自外部编码器(Pillow/libwebp),不是本仓自造的字节。
func TestRC4ExternalEncoderImagesStillFold(t *testing.T) {
	cases := []struct{ name, mime, b64 string }{
		{"渐进式 JPEG(Pillow/libjpeg)", "image/jpeg", rc4ProgressiveJPEGBase64},
		{"WebP(libwebp)", "image/webp", rc4RealWebPBase64},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			raw, err := base64.StdEncoding.DecodeString(c.b64)
			if err != nil {
				t.Fatalf("fixture: %v", err)
			}
			if got := classifyBinaryMagic(raw); got == binaryFamilyUnknown {
				t.Fatalf("外部编码器的真图片没有命中魔数: %x", raw[:12])
			}
			t.Logf("raw=%d base64=%d", len(raw), len(c.b64))
			rc4AssertFolded(t, `{"image_url":{"url":"data:`+c.mime+`;base64,`+c.b64+`"}}`, len(c.b64), 1)
		})
	}
}

// TestRC4BinaryProbeSurvivesHostilePayloads:容器校验是对**攻击者可控字节**的
// 解析,必须对任意输入都不 panic、不死循环(长度字段全 1、截断、超短、全 0…)。
func TestRC4BinaryProbeSurvivesHostilePayloads(t *testing.T) {
	magics := [][]byte{
		{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'},
		{0xFF, 0xD8, 0xFF},
		[]byte("GIF89a"),
		[]byte("RIFF\x00\x00\x00\x00WEBP"),
		append([]byte{0, 0, 0, 16}, []byte("ftypisom")...),
		[]byte("%PDF-1.7"),
	}
	start := time.Now()
	for mi, magic := range magics {
		for i := 0; i < 96; i++ {
			n := (i * 37) % 512
			raw := make([]byte, 0, len(magic)+n)
			raw = append(raw, magic...)
			x := uint32(0x1234 + i)
			for j := 0; j < n; j++ {
				x = x*1664525 + 1013904223
				raw = append(raw, byte(x>>24))
			}
			// 再加几个"全 1 的长度字段"变体(最容易触发越界/负索引的形态)。
			raw = append(raw, 0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00)
			body := `{"data":"` + base64.StdEncoding.EncodeToString(raw) + `"}`
			func() {
				defer func() {
					if r := recover(); r != nil {
						t.Fatalf("魔数族 %d 的第 %d 个恶意载荷让剥离器 panic: %v", mi, i, r)
					}
				}()
				_, _ = stripInlineBinaryPayloads([]byte(body))
			}()
			if elapsed := time.Since(start); elapsed > 5*time.Second {
				t.Fatalf("恶意载荷扫描耗时 %v > 5s", elapsed)
			}
		}
	}
	t.Logf("576 个恶意载荷全部安全返回,耗时 %v", time.Since(start))
}

// ---------------------------------------------------------------------------
// ⑤ 自查:换等价写法打本轮新加的闸门(≥3 种等价形态)
// ---------------------------------------------------------------------------

// TestRC4CarrierKeyEquivalentDisguisesStayText:同一段"字母表内文本"换载体键、
// 换大小写、换折行、换字母表(URL-safe)、换长度、换字符分布 —— 判据必须与
// 形态无关。
func TestRC4CarrierKeyEquivalentDisguisesStayText(t *testing.T) {
	blob := rc4AlnumBlob(64 << 10)
	hexs := strings.Repeat("DeAdBeEf01", 1024)
	urlSafe := strings.ReplaceAll(strings.ReplaceAll(blob, "+", "-"), "/", "_")
	cases := []struct{ name, body string }{
		{"十六进制 @ b64_json", `{"b64_json":"` + hexs + `"}`},
		{"十六进制 @ inline_data.data", `{"inline_data":{"mime_type":"image/png","data":"` + hexs + `"}}`},
		{"字母数字 @ url/data:image/jpeg", `{"url":"data:image/jpeg;base64,` + blob + `"}`},
		{"字母数字 @ data(冒号后空格)", `{"data": "` + blob + `"}`},
		{"字母数字 @ data(JSON \\n 折行)", `{"data":"` + rc4WrapEscaped(blob, 76) + `"}`},
		{"字母数字 @ data(URL-safe 字母表)", `{"data":"` + urlSafe + `"}`},
		{"字母数字 @ image_url(大写 DATA:)", `{"image_url":{"url":"DATA:IMAGE/PNG;BASE64,` + blob + `"}}`},
		{"字母数字 @ Anthropic source.data", `{"source":{"type":"base64","media_type":"image/jpeg","data":"` + blob + `"}}`},
		{"全 'A'(解码为 0x00 串) @ data", `{"data":"` + strings.Repeat("A", 64<<10) + `"}`},
		{"全 'z' @ data", `{"data":"` + strings.Repeat("z", 64<<10) + `"}`},
		{"可打印文本的合法 base64 @ data", `{"data":"` + r7cTextPayload(64<<10) + `"}`},
		{"字母数字 @ data(带 '=' 填充尾巴)", `{"data":"` + blob[:1000] + `==` + blob[1000:] + `"}`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rc4AssertNoStrip(t, c.body)
		})
	}
}
