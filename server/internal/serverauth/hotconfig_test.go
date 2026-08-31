package serverauth

import (
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// TestLDAPProviderHotConfig:登录时 LDAP provider 从 settings 实时构建——
// webadmin 保存配置后无需重启即可登录(用户 2026-09 报告"配置好登录不可用"
// 的修复)。断言:
//  1. 配置齐全且 auth.enabled 含 ldap → ldapProvider() 非 nil(热生效);
//  2. 未启用(仅配置) → nil(绝不使未启用的 LDAP 意外生效);
//  3. 配置不完整 → nil。
func TestLDAPProviderHotConfig(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := mustDB(t)
	api := New(db) // 不 RegisterProvider(生产启动时 ldap 通常未配置)

	if api.ldapProvider() != nil {
		t.Fatal("ldapProvider should be nil before any ldap settings")
	}
	// 写了配置但 auth.enabled 未启用 → nil
	for k, v := range map[string]string{
		"ldap.server_url": "ldap://x", "ldap.base_dn": "dc=x", "ldap.bind_dn": "cn=a",
	} {
		if err := serverstore.SetSetting(db, k, v); err != nil {
			t.Fatal(err)
		}
	}
	if api.ldapProvider() != nil {
		t.Fatal("ldapProvider should be nil when ldap not enabled")
	}
	// 启用后 → 非 nil(热生效)
	if err := serverstore.SetSetting(db, "auth.enabled", "local,ldap"); err != nil {
		t.Fatal(err)
	}
	if api.ldapProvider() == nil {
		t.Fatal("ldapProvider should be non-nil after enabled (hot config)")
	}
	// 停用 → nil
	if err := serverstore.SetSetting(db, "auth.enabled", "local"); err != nil {
		t.Fatal(err)
	}
	if api.ldapProvider() != nil {
		t.Fatal("ldapProvider should be nil after disabling ldap")
	}
	// 再用兼容 mode=ldap 路径
	if err := serverstore.SetSetting(db, "auth.mode", "ldap"); err != nil {
		t.Fatal(err)
	}
	if api.ldapProvider() == nil {
		t.Fatal("ldapProvider should be non-nil with auth.mode=ldap")
	}
	// 配置不完整 → nil
	if err := serverstore.SetSetting(db, "ldap.base_dn", ""); err != nil {
		t.Fatal(err)
	}
	if api.ldapProvider() != nil {
		t.Fatal("ldapProvider should be nil with incomplete config")
	}
}
