package archiveutil

// P0(评审 2026-09-19,report §5 P0-2 / §7.2):tar 的**旧式目录标记**解析分歧。
//
// 真实客户端是 node-tar 7.5.x(packages/host/enterprise 的技能安装链路),
// header.js:119-132 的归一条件是
//
//	if (types.isCode(t)) { this.#type = t || '0' }     // '\x00' 归一成 '0'
//	if (this.#type === '0' && path.endsWith('/')) ...   // '0' + 尾斜杠 ⇒ '5'
//	if (this.#type === '5') this.size = 0               // 目录没有数据段
//
// 即 ASCII '0' 与 '\x00' **同等对待**:尾斜杠 ⇒ 目录、Size 强制 0,**不跳过**头里
// 声明的数据区,而是把数据区当条目链继续解析。
//
// 修复前(Go 只对 '\x00' 做这条归一,见 stdlib reader.go:145-151)的现场:
//
//	变体 I: [SKILL.md 6B "benign"]['0'+"assets/" size=1024][evil.md 头+"EVIL"][2×零块]
//	  Go   Validate=nil  ListContents=[SKILL.md assets]  ReadAll={SKILL.md, assets}
//	  客户端 assertArchiveSafe=通过 → tar.x 实际装出 [SKILL.md="benign", evil.md="EVIL"]
//	  ⇒ 员工装上了审核页从未出现的文件(可夹带 scripts/ 之类)。
//
// 修复后 Go 与客户端逐条一致(下面每个用例都钉住这一点)。
//
// 夹具手写 512 字节 USTAR 头,typeflag 与声明 Size 完全可控 —— Go 的 tar.Writer
// 写不出这种畸形条目(它对目录写 '5'/Size=0)。

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"fmt"
	"testing"
)

// tcBlock 把一段内容放进 512 字节块。
func tcBlock(b []byte) []byte {
	out := make([]byte, 512)
	copy(out, b)
	return out
}

// tcHeader 手写一个 512 字节 USTAR 头(校验和按 byte sum 计算)。
func tcHeader(name string, typeflag byte, size int64) []byte {
	h := make([]byte, 512)
	copy(h[0:100], name)
	copy(h[100:108], "0000644\x00")
	copy(h[108:116], "0000000\x00")
	copy(h[116:124], "0000000\x00")
	copy(h[124:136], fmt.Sprintf("%011o\x00", size))
	copy(h[136:148], "00000000000\x00")
	for i := 148; i < 156; i++ {
		h[i] = ' '
	}
	h[156] = typeflag
	copy(h[257:263], "ustar\x00")
	copy(h[263:265], "00")
	var sum int
	for _, c := range h {
		sum += int(c)
	}
	copy(h[148:156], fmt.Sprintf("%06o\x00 ", sum))
	return h
}

func tcGz(t *testing.T, blocks ...[]byte) []byte {
	t.Helper()
	var raw bytes.Buffer
	for _, b := range blocks {
		raw.Write(b)
	}
	var out bytes.Buffer
	zw := gzip.NewWriter(&out)
	if _, err := zw.Write(raw.Bytes()); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

// 变体 I:'0'(ASCII) + "assets/" + 声明 Size=1024,数据区是一个合法的 evil.md 头链。
// 客户端把该条目当目录(Size=0)⇒ 数据区被当条目链 ⇒ 装上 evil.md。
func variantIClientDirAsciiZero(t *testing.T) []byte {
	t.Helper()
	return tcGz(t,
		tcHeader("SKILL.md", '0', 6), tcBlock([]byte("benign")),
		tcHeader("assets/", '0', 1024),
		tcHeader("evil.md", '0', 4), tcBlock([]byte("EVIL")),
		tcBlock(nil), tcBlock(nil),
	)
}

// 变体 G:'\x00' + "assets/" + 声明 Size=1024,数据区是 evil.md 头链。
// Go stdlib 已把 '\x00'+尾斜杠归一成目录 —— 修复前后都必须与客户端一致。
func variantGClientDirNulByte(t *testing.T) []byte {
	t.Helper()
	return tcGz(t,
		tcHeader("SKILL.md", '0', 6), tcBlock([]byte("benign")),
		tcHeader("assets/", 0, 1024),
		tcHeader("evil.md", '0', 4), tcBlock([]byte("EVIL")),
		tcBlock(nil), tcBlock(nil),
	)
}

// 变体 J:V7 式目录标记('\x00' + 尾斜杠,Size=0)+ 目录内文件。Go 与客户端都接受。
func variantJClientDirZeroSize(t *testing.T) []byte {
	t.Helper()
	return tcGz(t,
		tcHeader("SKILL.md", '0', 6), tcBlock([]byte("benign")),
		tcHeader("assets/", 0, 0),
		tcHeader("assets/note.md", '0', 4), tcBlock([]byte("NOTE")),
		tcBlock(nil), tcBlock(nil),
	)
}

// P0-A 主用例:ASCII '0' + 尾斜杠 + 非零 Size —— 修复前 Go 把声明数据区整段跳过后
// **静默放行**(Validate=nil)且审核面看不到 evil.md,而客户端照装不误。
// 修复后四个入口与真实客户端(node-tar + assertArchiveSafe + tar.x)逐条一致。
func TestTarLegacyDirMarkerAsciiZeroWithSizeMatchesClientView(t *testing.T) {
	data := variantIClientDirAsciiZero(t)

	if _, err := Validate(data, testLim); err != nil {
		t.Fatalf("Validate 必须放行(客户端也放行): err=%v", err)
	}
	names, preview, err := ListContents(data, testLim, 1<<20)
	if err != nil {
		t.Fatalf("ListContents err=%v", err)
	}
	// 目录标记本身不列出;数据区里的 evil.md 必须出现(客户端实际会装出它)。
	if want := []string{"SKILL.md", "evil.md"}; !equalStrings(names, want) {
		t.Fatalf("ListContents=%v, want %v(客户端装出 %v)", names, want, want)
	}
	if preview != "benign" {
		t.Fatalf("required 预览=%q, want %q", preview, "benign")
	}
	all, err := ReadAll(data, testLim)
	if err != nil {
		t.Fatalf("ReadAll err=%v", err)
	}
	if got := string(all["evil.md"]); got != "EVIL" {
		t.Fatalf("ReadAll[evil.md]=%q, want %q(修复前该键不存在 —— 审核所见 ≠ 员工所装)", got, "EVIL")
	}
	if got := string(all["SKILL.md"]); got != "benign" {
		t.Fatalf("ReadAll[SKILL.md]=%q, want %q", got, "benign")
	}
	if len(all) != 2 {
		t.Fatalf("ReadAll 条目=%d, want 2(不能多出数据区被当成文件的 assets)", len(all))
	}
	content, size, found, binary, tooLarge, err := ExtractFileContent(data, "evil.md", 1<<20)
	if err != nil || !found || binary || tooLarge {
		t.Fatalf("Extract(evil.md): content=%q size=%d found=%v binary=%v tooLarge=%v err=%v",
			content, size, found, binary, tooLarge, err)
	}
	if content != "EVIL" || size != 4 {
		t.Fatalf("Extract(evil.md)=%q/%d, want \"EVIL\"/4", content, size)
	}
}

// 同形态但 Size=0('0' + 尾斜杠):没有数据体,两侧的**推进**本来就一致,分歧只在
// 归类 —— 修复前 Go 把它当成名为 "assets" 的普通文件并列出它,客户端建的是目录。
func TestTarLegacyDirMarkerAsciiZeroZeroSizeMatchesClientView(t *testing.T) {
	data := tcGz(t,
		tcHeader("SKILL.md", '0', 6), tcBlock([]byte("benign")),
		tcHeader("assets/", '0', 0),
		tcHeader("assets/note.md", '0', 4), tcBlock([]byte("NOTE")),
		tcBlock(nil), tcBlock(nil),
	)
	if _, err := Validate(data, testLim); err != nil {
		t.Fatalf("Validate 必须放行: err=%v", err)
	}
	names, _, err := ListContents(data, testLim, 1<<20)
	if err != nil {
		t.Fatalf("ListContents err=%v", err)
	}
	if want := []string{"SKILL.md", "assets/note.md"}; !equalStrings(names, want) {
		t.Fatalf("ListContents=%v, want %v(目录标记不得被列成文件)", names, want)
	}
	all, err := ReadAll(data, testLim)
	if err != nil {
		t.Fatalf("ReadAll err=%v", err)
	}
	if _, bad := all["assets"]; bad {
		t.Fatalf("ReadAll 不得含 %q:目录标记被当成了文件", "assets")
	}
	if got := string(all["assets/note.md"]); got != "NOTE" {
		t.Fatalf("ReadAll[assets/note.md]=%q, want %q", got, "NOTE")
	}
}

// 变体 G / J 的回归护栏:'\x00' + 尾斜杠 的两条路径(stdlib 已归一/Size=0)不得因为
// P0-A 的改动而漂移 —— 修复前后都必须与客户端一致。
func TestTarLegacyDirMarkerNulByteStaysClientAligned(t *testing.T) {
	// G:数据区藏 evil.md 头链 ⇒ 审核面必须看到它(客户端也会装它)。
	g := variantGClientDirNulByte(t)
	if _, err := Validate(g, testLim); err != nil {
		t.Fatalf("G Validate 必须放行: err=%v", err)
	}
	names, _, err := ListContents(g, testLim, 1<<20)
	if err != nil {
		t.Fatalf("G ListContents err=%v", err)
	}
	if want := []string{"SKILL.md", "evil.md"}; !equalStrings(names, want) {
		t.Fatalf("G ListContents=%v, want %v", names, want)
	}
	all, err := ReadAll(g, testLim)
	if err != nil {
		t.Fatalf("G ReadAll err=%v", err)
	}
	if string(all["evil.md"]) != "EVIL" {
		t.Fatalf("G ReadAll[evil.md]=%q, want \"EVIL\"", string(all["evil.md"]))
	}

	// J:V7 式目录标记(Size=0)+ 目录内文件 ⇒ 接受,且不把目录标记列成文件。
	j := variantJClientDirZeroSize(t)
	if _, err := Validate(j, testLim); err != nil {
		t.Fatalf("J Validate 必须放行: err=%v", err)
	}
	names, _, err = ListContents(j, testLim, 1<<20)
	if err != nil {
		t.Fatalf("J ListContents err=%v", err)
	}
	if want := []string{"SKILL.md", "assets/note.md"}; !equalStrings(names, want) {
		t.Fatalf("J ListContents=%v, want %v", names, want)
	}
}

// 客户端把旧式目录标记的**声明 Size 整个丢弃**(`this.size = 0`),所以那个数字既不
// 参与解析也不该被用来分配内存:
//   - 谎报大尺寸但没有数据体("sloppy dir",旧 tar 把 stat(dir).size 写进头里)必须
//     照常解析后续条目 —— 修复前 Go 会跳过这些字节,直接落到后续条目中间报 ErrUnsafe
//     (合法归档被误拒);客户端则正常装出 [SKILL.md, notes.md]。
//   - 声明一个远超预算的巨大尺寸也不得触发分配(修复后的实现只换一层 reader,不读它)。
func TestTarLegacyDirMarkerDeclaredSizeIsIgnoredLikeClient(t *testing.T) {
	// notes.md 头(512)+ 载荷/补齐(512)= 1024 字节,声明 4096 与实际不符。
	data := tcGz(t,
		tcHeader("SKILL.md", '0', 6), tcBlock([]byte("benign")),
		tcHeader("assets/", '0', 4096),
		tcHeader("notes.md", '0', 4), tcBlock([]byte("NOTE")),
		tcBlock(nil), tcBlock(nil),
	)
	if _, err := Validate(data, testLim); err != nil {
		t.Fatalf("Validate(sloppy 旧式目录标记)必须放行(客户端也放行): err=%v", err)
	}
	names, _, err := ListContents(data, testLim, 1<<20)
	if err != nil {
		t.Fatalf("ListContents err=%v", err)
	}
	if want := []string{"SKILL.md", "notes.md"}; !equalStrings(names, want) {
		t.Fatalf("ListContents=%v, want %v(声明尺寸不得让后续条目被跳过)", names, want)
	}
	all, err := ReadAll(data, testLim)
	if err != nil {
		t.Fatalf("ReadAll err=%v", err)
	}
	if string(all["notes.md"]) != "NOTE" {
		t.Fatalf("ReadAll[notes.md]=%q, want \"NOTE\"", string(all["notes.md"]))
	}

	// 声明 5MiB(> testLim.MaxUnpackedBytes)但归档里没有这些字节:与客户端一致地忽略它。
	huge := tcGz(t,
		tcHeader("SKILL.md", '0', 6), tcBlock([]byte("benign")),
		tcHeader("assets/", '0', 5<<20),
		tcHeader("notes.md", '0', 4), tcBlock([]byte("NOTE")),
		tcBlock(nil), tcBlock(nil),
	)
	if _, err := Validate(huge, testLim); err != nil {
		t.Fatalf("Validate(谎报 5MiB 的目录标记)必须放行: err=%v", err)
	}
	names, _, err = ListContents(huge, testLim, 1<<20)
	if err != nil {
		t.Fatalf("ListContents(谎报 5MiB) err=%v", err)
	}
	if want := []string{"SKILL.md", "notes.md"}; !equalStrings(names, want) {
		t.Fatalf("ListContents(谎报 5MiB)=%v, want %v", names, want)
	}
}

// 声明长度只是个"谎报的上界":条目链可以**越过它**继续(客户端丢弃 size 后完全不看它)。
// 修复时若把数据区当"到此为止"的边界(例如只把声明的 N 字节读进内存再解析),后面的
// 真实条目就会被静默丢掉 —— 那正是本包要消灭的 fail-open。
func TestTarLegacyDirMarkerEntriesSpanDeclaredBoundary(t *testing.T) {
	// 声明 512:只够装 evil.md 的头;它的载荷与 scripts/run.sh 都在边界之外。
	data := tcGz(t,
		tcHeader("SKILL.md", '0', 6), tcBlock([]byte("benign")),
		tcHeader("assets/", '0', 512),
		tcHeader("evil.md", '0', 4),
		tcBlock([]byte("EVIL")),
		tcHeader("scripts/run.sh", '0', 8), tcBlock([]byte("echo hi\n")),
		tcBlock(nil), tcBlock(nil),
	)
	if _, err := Validate(data, testLim); err != nil {
		t.Fatalf("Validate 必须放行: err=%v", err)
	}
	names, _, err := ListContents(data, testLim, 1<<20)
	if err != nil {
		t.Fatalf("ListContents err=%v", err)
	}
	// 客户端实测(node-tar + tar.x)装出 [SKILL.md, evil.md, scripts/run.sh]。
	if want := []string{"SKILL.md", "evil.md", "scripts/run.sh"}; !equalStrings(names, want) {
		t.Fatalf("ListContents=%v, want %v(声明边界之外的条目不得被丢掉)", names, want)
	}
	all, err := ReadAll(data, testLim)
	if err != nil {
		t.Fatalf("ReadAll err=%v", err)
	}
	if string(all["scripts/run.sh"]) != "echo hi\n" {
		t.Fatalf("ReadAll[scripts/run.sh]=%q, want %q", string(all["scripts/run.sh"]), "echo hi\n")
	}
	if string(all["evil.md"]) != "EVIL" {
		t.Fatalf("ReadAll[evil.md]=%q, want %q", string(all["evil.md"]), "EVIL")
	}
}

// 双层旧式目录标记(数据区里还是目录标记):换层重解析必须逐层推进、不得死循环,
// 且各层之后与跨越声明边界的条目都要被解析出来(客户端实测装出 [SKILL.md, evil.md])。
func TestTarLegacyDirMarkerNestedMarkersTerminate(t *testing.T) {
	data := tcGz(t,
		tcHeader("SKILL.md", '0', 6), tcBlock([]byte("benign")),
		tcHeader("a/", '0', 1024), // 旧式标记 #1,声明 1024
		tcHeader("b/", '0', 512),  // 数据区第一块:旧式标记 #2
		tcHeader("evil.md", '0', 4),
		tcBlock([]byte("EVIL")), // 载荷在 a/ 的声明边界之外
		tcBlock(nil), tcBlock(nil),
	)
	if _, err := Validate(data, testLim); err != nil {
		t.Fatalf("Validate 必须放行: err=%v", err)
	}
	names, _, err := ListContents(data, testLim, 1<<20)
	if err != nil {
		t.Fatalf("ListContents err=%v", err)
	}
	if want := []string{"SKILL.md", "evil.md"}; !equalStrings(names, want) {
		t.Fatalf("ListContents=%v, want %v", names, want)
	}
	all, err := ReadAll(data, testLim)
	if err != nil {
		t.Fatalf("ReadAll err=%v", err)
	}
	if string(all["evil.md"]) != "EVIL" {
		t.Fatalf("ReadAll[evil.md]=%q, want %q", string(all["evil.md"]), "EVIL")
	}
}

// 合法归档零影响:真实目录('5')、普通文件、以及它们的大小写/顺序都不受本次改动
// 影响(旧式标记归一只在 '0'/'\x00' + 尾斜杠时触发)。
func TestTarCleanArchiveUnaffectedByClientDirNormalization(t *testing.T) {
	data := tcGz(t,
		tcHeader("SKILL.md", '0', 6), tcBlock([]byte("benign")),
		tcHeader("assets/", '5', 0),
		tcHeader("assets/note.md", '0', 4), tcBlock([]byte("NOTE")),
		tcBlock(nil), tcBlock(nil),
	)
	sum, err := Validate(data, testLim)
	if err != nil {
		t.Fatalf("Validate err=%v", err)
	}
	if len(sum) != 64 {
		t.Fatalf("sha256 长度=%d, want 64", len(sum))
	}
	names, preview, err := ListContents(data, testLim, 1<<20)
	if err != nil {
		t.Fatalf("ListContents err=%v", err)
	}
	if want := []string{"SKILL.md", "assets/note.md"}; !equalStrings(names, want) {
		t.Fatalf("ListContents=%v, want %v", names, want)
	}
	if preview != "benign" {
		t.Fatalf("预览=%q, want %q", preview, "benign")
	}
	all, err := ReadAll(data, testLim)
	if err != nil {
		t.Fatalf("ReadAll err=%v", err)
	}
	if len(all) != 2 || string(all["assets/note.md"]) != "NOTE" {
		t.Fatalf("ReadAll=%v, want 2 条且 assets/note.md=NOTE", all)
	}
	// tar 写入器对真实目录写 Size=0,所以数据区没有可重解析的东西:内容读取照旧。
	content, size, found, _, _, err := ExtractFileContent(data, "assets/note.md", 1<<20)
	if err != nil || !found || content != "NOTE" || size != 4 {
		t.Fatalf("Extract(assets/note.md)=%q/%d found=%v err=%v", content, size, found, err)
	}
	_ = tar.TypeDir // 说明:夹具用的是与 tar.Writer 相同的 '5'/Size=0 形态
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
