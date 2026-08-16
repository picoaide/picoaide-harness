package llmgateway

import (
	"database/sql"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

func modelsRouter(t *testing.T) (*gin.Engine, *sql.DB, string) {
	t.Helper()
	db, err := serverstore.EnsureMigrated(fmt.Sprintf("%s/models.db", t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })

	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: "bob", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	token, err := serverauth.IssueToken(db, uid)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models, enabled) VALUES
		('openai', 'http://a', 'k', '["gpt-4o"]', 1),
		('disabled', 'http://b', 'k', '["secret-model"]', 0)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO models (name, provider_id, display_name) VALUES
		('gpt-4o', 1, 'GPT-4o'),
		('disabled-model', 2, 'Hidden')`); err != nil {
		t.Fatal(err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterRoutes(r, db)
	return r, db, token
}

func getModels(t *testing.T, r http.Handler, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestModelsList(t *testing.T) {
	r, _, token := modelsRouter(t)
	w := getModels(t, r, token)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	// {"models":[{"id":"gpt-4o","display_name":"GPT-4o","default_params":"{}"}]} — disabled provider excluded
	want := `{"models":[{"id":"gpt-4o","display_name":"GPT-4o","default_params":"{}"}]}`
	if w.Body.String() != want {
		t.Fatalf("body = %s", w.Body.String())
	}
}

func TestModelsUnauthorized(t *testing.T) {
	r, _, _ := modelsRouter(t)
	w := getModels(t, r, "")
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", w.Code)
	}
}

func TestMaxOutputFromModelDefaultParams(t *testing.T) {
	// from JSON default_params
	v, ok, err := maxOutputFromDefaultParams(`{"context_length":1048576,"max_output":393216}`)
	if err != nil || !ok || v != 393216 {
		t.Fatalf("got %d %v %v", v, ok, err)
	}
	// missing -> ok=false, no error
	v, ok, err = maxOutputFromDefaultParams(`{"context_length":1048576}`)
	if err != nil || ok {
		t.Fatalf("missing max_output: got %d %v %v", v, ok, err)
	}
	// bad JSON -> error
	_, _, err = maxOutputFromDefaultParams(`not-json`)
	if err == nil {
		t.Fatal("bad json should error")
	}
}

func TestModelsEmptyReturnsArray(t *testing.T) {
	db, err := serverstore.EnsureMigrated(fmt.Sprintf("%s/empty.db", t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: "bob", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	token, err := serverauth.IssueToken(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterRoutes(r, db)
	// 空 models 表:JSON 必须序列化为 [] 而非 null(webadmin 依赖 .map)
	w := getModels(t, r, token)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	if w.Body.String() != `{"models":[]}` {
		t.Fatalf("empty models body = %s, want {\"models\":[]}", w.Body.String())
	}
}
