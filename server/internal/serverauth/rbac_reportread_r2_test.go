package serverauth

import (
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// 审计 2026-09-12 P1-4 回归:报表订阅列表含 hook_url(凭据本体)⇒ 必须有
// 独立权限点,且**不得**授予只读 auditor。
func TestReportReadPermissionIsSeparatedFromUsageRead(t *testing.T) {
	if PermReportRead == PermUsageRead {
		t.Fatal("PermReportRead 必须是与 usage:read 不同的权限点")
	}
	if !HasPermission(&serverstore.User{Role: serverstore.RoleSuperAdmin}, PermReportRead) {
		t.Fatal("super_admin 必须持有 report:read")
	}
	// 核心断言:auditor 看不到报表订阅列表(改前它靠 usage:read 就能读 hook_url)。
	if HasPermission(&serverstore.User{Role: serverstore.RoleAuditor}, PermReportRead) {
		t.Fatal("auditor 不得持有 report:read(hook_url 是凭据本体)")
	}
	if HasPermission(&serverstore.User{Role: serverstore.RoleAuditor}, PermReportWrite) {
		t.Fatal("auditor 不得持有 report:write")
	}
	// 对照:auditor 仍保留只读三件套(本修复不应缩小其它可见面)。
	for _, p := range []string{PermAuditRead, PermUsageRead, PermUserRead} {
		if !HasPermission(&serverstore.User{Role: serverstore.RoleAuditor}, p) {
			t.Fatalf("auditor 应保留 %s", p)
		}
	}
	// 权限点必须挂进全量表,否则连超管都拿不到(与 FIX-29 的漂移同源)。
	found := false
	for _, p := range AllPermissions {
		if p == PermReportRead {
			found = true
		}
	}
	if !found {
		t.Fatal("report:read 未进 AllPermissions")
	}
}
