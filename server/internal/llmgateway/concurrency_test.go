package llmgateway

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

func TestConcurrencyTargetFromParams(t *testing.T) {
	cases := []struct {
		params string
		want   int64
	}{
		{`{"concurrency_target":2500}`, 2500},
		{`{"concurrency_target":500}`, 500},
		{`{"max_output":2048}`, 0},
		{`{}`, 0},
		{``, 0},
		{`not json`, 0},
		{`{"concurrency_target":-5}`, 0},
	}
	for _, tc := range cases {
		if got := concurrencyTargetFromParams(tc.params); got != tc.want {
			t.Errorf("concurrencyTargetFromParams(%q) = %d, want %d", tc.params, got, tc.want)
		}
	}
}

func TestConcurrencyStatusHandler(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()

	// 建模型: flash target 2500, pro target 500
	providerID, err := serverstore.AddGatewayProvider(db, &serverstore.GatewayProvider{
		Name: "picoaide", BaseURL: "https://api.example.com", APIKeyEnc: "x", Models: []string{}, Enabled: 1,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.AddModel(db, &serverstore.Model{
		Name: "deepseek-v4-flash", ProviderID: providerID,
		DefaultParams: `{"concurrency_target":2500}`,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.AddModel(db, &serverstore.Model{
		Name: "deepseek-v4-pro", ProviderID: providerID,
		DefaultParams: `{"concurrency_target":500}`,
	}); err != nil {
		t.Fatal(err)
	}

	meter := newConcurrencyMeter()
	// flash 当前 3 个 in-flight, pro 1 个
	d1 := meter.begin("deepseek-v4-flash")
	d2 := meter.begin("deepseek-v4-flash")
	d3 := meter.begin("deepseek-v4-flash")
	d4 := meter.begin("deepseek-v4-pro")
	defer d1()
	defer d2()
	defer d3()
	defer d4()

	// 写入历史峰值(90 天前的一天)
	past := time.Now().AddDate(0, 0, -5).UTC()
	if err := serverstore.RecordConcurrencySample(db, "deepseek-v4-flash", 2100, past); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.RecordConcurrencySample(db, "deepseek-v4-flash", 2500, past.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.RecordConcurrencySample(db, "deepseek-v4-pro", 480, past); err != nil {
		t.Fatal(err)
	}

	r := gin.New()
	r.GET("/concurrency", func(c *gin.Context) { concurrencyStatus(c, db, meter) })
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/concurrency", nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", w.Code, w.Body.String())
	}

	var resp struct {
		Models []struct {
			Model   string `json:"model"`
			Current int64  `json:"current"`
			Peak90  int64  `json:"peak_90d"`
			Target  int64  `json:"target"`
		} `json:"models"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if len(resp.Models) < 2 {
		t.Fatalf("models = %d, want >= 2", len(resp.Models))
	}
	// flash: 当前 3、峰值 2500、目标 2500
	var flash, pro *struct {
		Model   string `json:"model"`
		Current int64  `json:"current"`
		Peak90  int64  `json:"peak_90d"`
		Target  int64  `json:"target"`
	}
	for i := range resp.Models {
		switch resp.Models[i].Model {
		case "deepseek-v4-flash":
			flash = &resp.Models[i]
		case "deepseek-v4-pro":
			pro = &resp.Models[i]
		}
	}
	if flash == nil || flash.Current != 3 || flash.Peak90 != 2500 || flash.Target != 2500 {
		t.Errorf("flash = %+v, want current=3 peak=2500 target=2500", flash)
	}
	if pro == nil || pro.Current != 1 || pro.Peak90 != 480 || pro.Target != 500 {
		t.Errorf("pro = %+v, want current=1 peak=480 target=500", pro)
	}
}
