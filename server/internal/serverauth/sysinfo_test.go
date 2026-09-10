package serverauth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/updatecheck"
)

// fakeChecker 实现 UpdateChecker 接口,测试可注入固定结果/错误。
type fakeChecker struct {
	res *updatecheck.Result
	err error
}

func (f *fakeChecker) Check(ctx context.Context, current string) (*updatecheck.Result, error) {
	if f.err != nil {
		return nil, f.err
	}
	out := *f.res
	out.Current = current
	return &out, nil
}

func TestHandleServerInfoUpdateCheck(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()

	// 有更新: checker 返回 2.6.0,当前版本 2.5.1 → update_available=true
	SetBuildVersion("2.5.1")
	defer SetBuildVersion("dev")
	a := &AdminAPI{DB: db, UpdateChecker: &fakeChecker{res: &updatecheck.Result{
		Latest:          "2.6.0",
		UpdateAvailable: true,
		ImageTag:        "v2.6.0",
		ManifestURL:     "https://release.picoaide.com/official/latest.json",
		CheckedAt:       "2026-08-31T00:00:00Z",
	}}}
	r := gin.New()
	r.GET("/server-info", a.handleServerInfo)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/server-info", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		Version     string `json:"version"`
		UpdateCheck *struct {
			Latest          string `json:"latest"`
			UpdateAvailable bool   `json:"update_available"`
			ImageTag        string `json:"image_tag"`
			ManifestURL     string `json:"manifest_url"`
		} `json:"update_check"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Version != "2.5.1" {
		t.Errorf("version = %q, want 2.5.1", resp.Version)
	}
	if resp.UpdateCheck == nil {
		t.Fatal("update_check is null, want object")
	}
	if !resp.UpdateCheck.UpdateAvailable {
		t.Error("update_available = false, want true")
	}
	if resp.UpdateCheck.Latest != "2.6.0" {
		t.Errorf("latest = %q", resp.UpdateCheck.Latest)
	}
	// 升级目标与清单来源必须透传到管理端(运维据此执行升级)
	if resp.UpdateCheck.ImageTag != "v2.6.0" {
		t.Errorf("image_tag = %q, want v2.6.0", resp.UpdateCheck.ImageTag)
	}
	if resp.UpdateCheck.ManifestURL != "https://release.picoaide.com/official/latest.json" {
		t.Errorf("manifest_url = %q", resp.UpdateCheck.ManifestURL)
	}
}

func TestHandleServerInfoUpdateCheckUnavailable(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()

	SetBuildVersion("2.5.1")
	defer SetBuildVersion("dev")
	a := &AdminAPI{DB: db, UpdateChecker: &fakeChecker{err: updatecheck.ErrUnavailable}}
	r := gin.New()
	r.GET("/server-info", a.handleServerInfo)
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/server-info", nil)
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}
	var resp struct {
		UpdateCheck *json.RawMessage `json:"update_check"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.UpdateCheck != nil {
		t.Error("update_check should be null on unavailable, got non-nil")
	}
}
