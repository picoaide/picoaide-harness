package serverauth

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// TestGetPublicAuthMethods:未认证可访问,返回 enabled 列表与配置状态。
func TestGetPublicAuthMethods(t *testing.T) {
	db := mustDB(t)
	if err := serverstore.SetSetting(db, "auth.enabled", "local,ldap"); err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterAdminRoutes(r, db)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/server/admin/auth/methods", nil))
	if w.Code != 200 {
		t.Fatalf("methods status = %d", w.Code)
	}
	var out struct {
		Methods []struct {
			Name       string `json:"name"`
			Configured bool   `json:"configured"`
		} `json:"methods"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Methods) != 2 {
		t.Fatalf("methods = %v, want [local ldap]", out.Methods)
	}
	if out.Methods[0].Name != "local" || !out.Methods[0].Configured {
		t.Fatalf("local = %+v, want configured", out.Methods[0])
	}
	if out.Methods[1].Name != "ldap" || out.Methods[1].Configured {
		t.Fatalf("ldap = %+v, want not configured (no ldap.* settings)", out.Methods[1])
	}
}

// TestGetPublicAuthMethodsForcesLocal:enabled 不含 local 时仍返回 local(admin 回退)。
func TestGetPublicAuthMethodsForcesLocal(t *testing.T) {
	db := mustDB(t)
	if err := serverstore.SetSetting(db, "auth.enabled", "ldap"); err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterAdminRoutes(r, db)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/server/admin/auth/methods", nil))
	var out struct {
		Methods []struct {
			Name       string `json:"name"`
			Configured bool   `json:"configured"`
		} `json:"methods"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	foundLocal := false
	for _, m := range out.Methods {
		if m.Name == "local" {
			foundLocal = true
		}
	}
	if !foundLocal {
		t.Fatalf("methods = %v, want local always present", out.Methods)
	}
}
