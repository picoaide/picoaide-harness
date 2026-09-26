package archiveutil

// R21F-04（审计 2026-09-26，P2）的行为判据：**服务端审核期**必须与客户端安装期
// 用同一套"安装端可用性"判据 —— 含 Win32 保留设备名的归档一律不许过审。
//
// ## 缺陷形态（判据要杀的东西）
//
// 客户端有两道硬拒（`packages/host/enterprise/src/skill-name-rules.ts` 的
// `reservedDeviceNameInArchivePath`：上传前预检 `manifest-precheck.ts` + 安装前扫描
// `archive-util.ts`），而服务端 `installerKey` 一侧只有 ToLower + NTFS 危险折叠 +
// 去尾随点/空格，**没有**保留设备名这一条（R17B-05 只补了客户端）。后果：
// 管理员经 `POST /api/server/admin/skills/:name/archive`（base64 直投，不经过客户端
// 预检）上传一个含 `assets/aux.txt` 的包 → 服务端审核**接受并上架** → 任何平台的
// 客户端在安装期硬拒 ⇒「审核通过 = 可安装」在这类包上为假。
//
// ## 判据（四条，缺一条都不算闭合）
//
//	① 两个格式（zip 推荐 / tar.gz 兼容）× 文件条目与**目录条目**都必须被拒；
//	② 错误里带得出命中的段与完整条目名（HTTP 层要能回显给上传者，否则无从改名）；
//	③ **负控**：合法名字（含 `com10`/`com0`/`console.md`/`auxiliary/` 这类"像但不是"）
//	   必须照旧通过 —— 判据不能靠"把所有归档都拒掉"变绿；
//	④ `ErrorText` 给出的用户文案里点出文件名（`archiveErrorMessage` 的 default
//	   分支就是它，见 sharedskills/routes.go 的映射）。
//
// ## 变异（必须变红，实跑对照见 temp/r21/fix-8/REPORT.md）
//
//   - 去掉 `validateZip` 里的 `checkReservedDeviceName` 调用 ⇒ ① 红（zip 面）；
//   - 去掉 `validateTar` 里的同一条调用 ⇒ ① 红（tar.gz 面）；
//   - 从 `windowsReservedDeviceNames` 里删掉 `aux` ⇒ ①③ 与跨端对拍（parity）同时红。

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"errors"
	"strings"
	"testing"
)

// reservedZip 构造一个 zip：给定条目名（以 `/` 结尾 = 目录条目），外加根 SKILL.md。
func reservedZip(t *testing.T, names ...string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	add := func(name string, content []byte) {
		hdr := &zip.FileHeader{Name: name, Method: zip.Deflate}
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			t.Fatal(err)
		}
		if strings.HasSuffix(name, "/") {
			return // 目录条目不携带内容（zip 写入器对"目录写字节"直接报错）
		}
		if _, err := w.Write(content); err != nil {
			t.Fatal(err)
		}
	}
	add("SKILL.md", []byte("name: probe\n"))
	for _, n := range names {
		add(n, []byte("x"))
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// reservedTarGz 构造一个 tar.gz：`/` 结尾的条目写成 TypeDir（覆盖"目录条目"面）。
func reservedTarGz(t *testing.T, names ...string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	write := func(name string, content string, typ byte) {
		if err := tw.WriteHeader(&tar.Header{Name: name, Typeflag: typ, Size: int64(len(content))}); err != nil {
			t.Fatal(err)
		}
		if content != "" {
			if _, err := tw.Write([]byte(content)); err != nil {
				t.Fatal(err)
			}
		}
	}
	write("SKILL.md", "name: probe\n", tar.TypeReg)
	for _, n := range names {
		if strings.HasSuffix(n, "/") {
			write(n, "", tar.TypeDir)
			continue
		}
		write(n, "x", tar.TypeReg)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// TestValidateRejectsReservedDeviceNames 是①：两个格式、文件与目录条目都要拒。
func TestValidateRejectsReservedDeviceNames(t *testing.T) {
	reject := []struct {
		entry     string
		wantSeg   string
		wantWhole string
	}{
		{"assets/aux.txt", "aux.txt", "assets/aux.txt"}, // 审计现场
		{"AUX.TXT", "AUX.TXT", "AUX.TXT"},               // 大小写不敏感
		{"assets/aux.", "aux.", "assets/aux."},          // 尾随点（Windows 忽略）
		{"assets/aux ", "aux ", "assets/aux "},          // 尾随空格（Windows 忽略）
		{"nul", "nul", "nul"},                           // 无扩展名
		{"nul/SKILL.md", "nul", "nul/SKILL.md"},         // 目录段命中
		{"references/COM1.md", "COM1.md", "references/COM1.md"},
		{"lpt9.md", "lpt9.md", "lpt9.md"},
		{"con/", "con", "con"}, // **目录条目**（必须在 isDir 分支之前判；报告里的名字是归一化后的）
		{"PRN/child.md", "PRN", "PRN/child.md"},
	}
	for _, tc := range reject {
		t.Run("zip/"+tc.entry, func(t *testing.T) {
			_, err := Validate(reservedZip(t, tc.entry), testLim)
			if !errors.Is(err, ErrReservedName) {
				t.Fatalf("zip 条目 %q 必须被判 ErrReservedName，实得 %v", tc.entry, err)
			}
			seg, path, ok := ReservedDeviceName(err)
			if !ok || seg != tc.wantSeg || path != tc.wantWhole {
				t.Fatalf("错误里没带对名字：segment=%q path=%q ok=%v，want %q/%q", seg, path, ok, tc.wantSeg, tc.wantWhole)
			}
		})
		t.Run("tar.gz/"+tc.entry, func(t *testing.T) {
			_, err := Validate(reservedTarGz(t, tc.entry), testLim)
			if !errors.Is(err, ErrReservedName) {
				t.Fatalf("tar.gz 条目 %q 必须被判 ErrReservedName，实得 %v", tc.entry, err)
			}
		})
	}
}

// TestValidateAcceptsLookalikeNames 是③（负控）：像保留名但不是的必须照旧通过。
//
// 没有这条，"把所有归档都拒掉"也能让①变绿 —— 而它会误杀合法技能包。
func TestValidateAcceptsLookalikeNames(t *testing.T) {
	accept := []string{
		"assets/notes.txt",
		"console.md",
		"auxiliary/references.md",
		"com10.md", // COM10 不是保留名（文档只到 COM1-9）
		"com0.md",  // 同上
		"lpt0.md",
		"conx.md",
		"aux-.md",
		"nu.md",
		"references/aux_notes.md",
	}
	for _, entry := range accept {
		t.Run("zip/"+entry, func(t *testing.T) {
			if _, err := Validate(reservedZip(t, entry), testLim); err != nil {
				t.Fatalf("合法条目 %q 被误拒: %v", entry, err)
			}
		})
		t.Run("tar.gz/"+entry, func(t *testing.T) {
			if _, err := Validate(reservedTarGz(t, entry), testLim); err != nil {
				t.Fatalf("合法条目 %q 被误拒: %v", entry, err)
			}
		})
	}
	// 反向自证（防止负控写成"什么都不判"）：`con.notes.md` 的**段首**就是 `con`
	// （扩展名不豁免，客户端同款）⇒ 必须拒。
	if _, err := Validate(reservedZip(t, "con.notes.md"), testLim); !errors.Is(err, ErrReservedName) {
		t.Fatalf("`con.notes.md` 的段首是 `con`（扩展名不豁免），必须拒；实得 %v", err)
	}
}

// TestReservedDeviceNameSegmentTable 是判定原语的段级表（对拍用例的语料与它同源）。
func TestReservedDeviceNameSegmentTable(t *testing.T) {
	hit := map[string]string{
		"aux.txt":              "aux.txt",
		"AUX.TXT":              "AUX.TXT",
		"aux.":                 "aux.",
		"aux ":                 "aux ",
		"aux  ":                "aux  ",
		"con":                  "con",
		"nul":                  "nul",
		"com1":                 "com1",
		"lpt9.md":              "lpt9.md",
		"assets/aux.txt":       "aux.txt",
		"nul/SKILL.md":         "nul",
		`references\aux.md`:    "aux.md", // 反斜杠也当分隔符（zip 里两种都出现过）
		"./aux.md":             "aux.md",
		"a/./nul":              "nul",
		"CON.md":               "CON.md",
		"prn.log":              "prn.log",
		"deep/nested/Com3.dat": "Com3.dat",
		"x/../aux":             "aux",
		"aux.txt/child.md":     "aux.txt", // 目录段是保留名同样致命
		"end/lpt1":             "lpt1",
		"nul.md.bak/SKILL.md":  "nul.md.bak", // 段首 = `nul`（第一个点之前）
		"con.notes.md":         "con.notes.md",
	}
	for path, want := range hit {
		if got := ReservedDeviceNameSegment(path); got != want {
			t.Fatalf("ReservedDeviceNameSegment(%q) = %q, want %q", path, got, want)
		}
	}
	miss := []string{
		"", ".", "..", "SKILL.md", "assets/notes.txt", "console.md", "com10.md", "com0.md",
		"com", "lpt", "nu.md", "aux-.md", "auxiliary/x.md", "references/aux_notes.md",
		"aux\t", // 只剥**空格**，制表符不豁免（与客户端 `[ ]+$` 同口径）
	}
	for _, path := range miss {
		if got := ReservedDeviceNameSegment(path); got != "" {
			t.Fatalf("ReservedDeviceNameSegment(%q) = %q, want 未命中", path, got)
		}
	}
	// 段级原语（导出给同类闸门复用）：`con.txt` 的段首是 `con`。
	if !IsWindowsReservedDeviceNameSegment("con.txt") || IsWindowsReservedDeviceNameSegment("con10") {
		t.Fatal("IsWindowsReservedDeviceNameSegment 的段级判定不对")
	}
}

// TestReservedDeviceNameErrorTextNamesTheFile 是②④：文案里必须点出文件名。
func TestReservedDeviceNameErrorTextNamesTheFile(t *testing.T) {
	_, err := Validate(reservedZip(t, "assets/aux.txt"), testLim)
	if err == nil {
		t.Fatal("含 assets/aux.txt 的归档必须被拒")
	}
	msg := ErrorText(err, "SKILL.md", 16)
	if !strings.Contains(msg, "aux.txt") {
		t.Fatalf("用户文案里没有文件名（上传者无从改名）: %q", msg)
	}
	if !strings.Contains(msg, "Windows") {
		t.Fatalf("文案里没有说明为什么被拒: %q", msg)
	}
}
