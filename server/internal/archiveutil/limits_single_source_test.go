// Package archiveutil_test 是 archiveutil 的外部测试包:只有它能同时 import
// archiveutil / sharedskills / agentshare(三者互为上下游,内部测试包 import
// 会成环)。
package archiveutil_test

import (
	"testing"

	"github.com/picoaide/picoaide/internal/agentshare"
	"github.com/picoaide/picoaide/internal/archiveutil"
	"github.com/picoaide/picoaide/internal/sharedskills"
)

// TestArchiveLimitsSingleSource 锁"四入口同一套边界"的数字只有一个真源。
//
// 2026-09-13:archiveutil / sharedskills / agentshare 曾各自硬编码
// 16MB / 64MB / 10000;tarExtract 为查重改成全量扫描后,函数内借用这套默认
// 边界给自己封顶,所以三处漂移会直接改变 ExtractFileContent 的行为。现在
// archiveutil 是规范源,sharedskills 引用它,本用例把第三份(agentshare,不在
// 本次改动范围)也钉住。
func TestArchiveLimitsSingleSource(t *testing.T) {
	canon := archiveutil.DefaultLimits("SKILL.md")
	if canon.MaxArchiveBytes != archiveutil.MaxArchiveBytes ||
		canon.MaxUnpackedBytes != archiveutil.MaxUnpackedBytes ||
		canon.MaxEntries != archiveutil.MaxArchiveEntries {
		t.Fatalf("archiveutil.DefaultLimits 未使用包内规范常量: %+v", canon)
	}
	if sharedskills.MaxArchiveBytes != canon.MaxArchiveBytes ||
		sharedskills.MaxUnpackedBytes != canon.MaxUnpackedBytes ||
		sharedskills.MaxArchiveEntries != canon.MaxEntries {
		t.Fatalf("sharedskills 边界漂移: %d/%d/%d, want %d/%d/%d",
			sharedskills.MaxArchiveBytes, sharedskills.MaxUnpackedBytes, sharedskills.MaxArchiveEntries,
			canon.MaxArchiveBytes, canon.MaxUnpackedBytes, canon.MaxEntries)
	}
	if agentshare.MaxArchiveBytes != canon.MaxArchiveBytes ||
		agentshare.MaxUnpackedBytes != canon.MaxUnpackedBytes ||
		agentshare.MaxArchiveEntries != canon.MaxEntries {
		t.Fatalf("agentshare 边界漂移: %d/%d/%d, want %d/%d/%d",
			agentshare.MaxArchiveBytes, agentshare.MaxUnpackedBytes, agentshare.MaxArchiveEntries,
			canon.MaxArchiveBytes, canon.MaxUnpackedBytes, canon.MaxEntries)
	}
	if archiveutil.MaxArchiveEntries <= 0 || archiveutil.MaxUnpackedBytes <= 0 || archiveutil.MaxArchiveBytes <= 0 {
		t.Fatalf("规范边界必须是正数: %+v", canon)
	}
}
