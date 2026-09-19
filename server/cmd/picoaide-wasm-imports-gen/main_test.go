package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 本文件守 R2-SK-3：`-check` 打印的是"逐字节一致"，判定就必须**逐字节**。
//
// 现场：compareWithDisk 曾经比 `normalize(onDisk) == normalize(want)`
// （CRLF→LF + 去掉尾部空行）。于是把 references/imports.md 整份转成 CRLF、或往
// 末尾追加几个空行，下发字节已经变了、门禁仍然绿着，并照旧打印"逐字节一致" ——
// 而这份文档是**随技能原样下发到员工磁盘**的产物。
//
// 判据（变异验证：把 compareWithDisk 改回 normalize(...) 比较，本用例必红）：
//   - 完全相同的字节 ⇒ 通过；
//   - 行尾 CRLF / 末尾多空行 / 行尾多空格 ⇒ 一律非零退出。
func TestCompareWithDiskIsByteExact(t *testing.T) {
	want := []byte("# 探针\n\n| 模块 | 符号 |\n| --- | --- |\n| wasi_snapshot_preview1 | fd_read |\n")
	dir := t.TempDir()

	write := func(name string, raw []byte) string {
		t.Helper()
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, raw, 0o644); err != nil {
			t.Fatalf("写 %s: %v", name, err)
		}
		return p
	}

	// 正向对照：磁盘字节 == 生成字节 ⇒ 通过（否则下面的"红"没有对照）。
	if err := compareWithDisk(write("exact.md", want), want, "探针产物"); err != nil {
		t.Fatalf("逐字节相同的产物必须通过 -check: %v", err)
	}

	crlf := bytes.ReplaceAll(want, []byte("\n"), []byte("\r\n"))
	trailingBlank := append(append([]byte{}, want...), '\n', '\n', '\n')
	trailingSpace := append(append([]byte{}, bytes.TrimRight(want, "\n")...), []byte("   \n")...)

	cases := []struct {
		name string
		disk []byte
		why  string
	}{
		{"crlf.md", crlf, "整份 CRLF：行尾风格变了，下发字节也变了"},
		{"trailing-blank.md", trailingBlank, "EOF 多 3 个空行"},
		{"trailing-space.md", trailingSpace, "末行尾随空格"},
	}
	for _, tc := range cases {
		err := compareWithDisk(write(tc.name, tc.disk), want, "探针产物")
		if err == nil {
			t.Fatalf("%s：字节不同却通过了 -check（%s）—— 门禁又回到容忍空白差异的旧形态", tc.name, tc.why)
		}
		// 报错必须说清"差异在哪"，而不是一句笼统的不一致。
		if !strings.Contains(err.Error(), "不一致") {
			t.Fatalf("%s：错误信息应说明与真源不一致: %v", tc.name, err)
		}
	}
}

// normalizeForDiff 只服务差异展示：它必须仍能把 CRLF 差异讲成"逐行内容相同"，
// 但**不得**再出现在判定路径上（判定在 compareWithDisk，见上一条用例）。
func TestNormalizeForDiffIsDisplayOnly(t *testing.T) {
	want := []byte("a\nb\n")
	crlf := []byte("a\r\nb\r\n")
	if !bytes.Equal(normalizeForDiff(crlf), normalizeForDiff(want)) {
		t.Fatalf("归一化后应相同（它只用于展示）")
	}
	msg := firstDiffLine(append(append([]byte{}, want...), '\n'), want)
	if !strings.Contains(msg, "逐行内容相同") {
		t.Fatalf("CRLF/尾随空行这类「字节不同但行内容相同」的差异必须被讲清楚，实际: %q", msg)
	}
	msg = firstDiffLine([]byte("a\nc\n"), want)
	if !strings.Contains(msg, "第 2 行") {
		t.Fatalf("内容差异必须报到具体行号，实际: %q", msg)
	}
}
