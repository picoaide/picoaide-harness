package agentshare

import (
	"path/filepath"
	"testing"
)

// safeName 是归档磁盘回退路径的唯一拼接点(审计 2026-09-12)。它必须把
// name/version 当作**不可信的单段路径**处理:任一含分隔符 / .. / 绝对路径时
// 返回空串,而不是拼出可越出 cacheDir 的路径(纵深防御,与 sharedskills
// 的姊妹实现对齐)。
func TestSafeNameRejectsNonSegmentInput(t *testing.T) {
	cacheDir := "/var/lib/picoaide/agents"
	bad := []struct{ name, version string }{
		{"../../etc/passwd", "1.0.0"},
		{"ok", "../../../etc/passwd"},
		{"a/b", "1.0.0"},
		{"ok", "1/2"},
		{`a\b`, "1.0.0"},
		{"..", "1.0.0"},
		{"ok", ".."},
		{"", "1.0.0"},
		{"ok", ""},
		{".", "1.0.0"},
	}
	for _, c := range bad {
		if got := safeName(c.name, c.version); got != "" {
			t.Errorf("safeName(%q, %q) = %q, want empty", c.name, c.version, got)
		}
		// 空串经 filepath.Join 后必须仍落在 cacheDir 内(不会被当作 ".." 处理)。
		if p := filepath.Join(cacheDir, safeName(c.name, c.version)); p != cacheDir {
			t.Errorf("safeName(%q, %q) escaped cacheDir: %q", c.name, c.version, p)
		}
	}

	// 合法值保持原行为(旧磁盘回退文件名格式不变)。
	if got := safeName("my-agent", "1.2.3"); got != "my-agent-1.2.3.tar.gz" {
		t.Errorf("safeName(valid) = %q, want %q", got, "my-agent-1.2.3.tar.gz")
	}
}
