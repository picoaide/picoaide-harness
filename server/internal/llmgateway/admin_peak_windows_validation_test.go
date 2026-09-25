package llmgateway

// R18C-04（审计 2026-09-25，P2）写入面判据：管理端 `PUT /api/server/admin/gateway` 的
// `peak_windows` 校验。
//
// 修前：`ParsePeakWindows(...) == nil` 才 400，而"显式空数组 / 全非法 weekdays"的解析结果
// **非 nil** ⇒ 放行 ⇒ 存进库的就是一次静默的计费口径反转（空闲折扣整体丢失：
// 旧读取实现把"一天都不选"当成"每天都是高峰"）。
//
// 修后：`ValidatePeakWindows` 对这两种形态 400 VALIDATION（文案给出修法），并且
// **失败不落库**（既不能写坏新值，也不能顺手覆盖掉原有配置）。

import (
	"net/http"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

func TestGatewayConfigRejectsEmptyAndInvalidPeakWeekdays(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	// 先存一份合法配置（后面用来断言"被拒的写入没有覆盖它"）。
	const legal = `[{"start":"09:00","end":"12:00","weekdays":[1,2,3,4,5]}]`
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", gatewayPutBody(t, legal), hdr); w.Code != http.StatusOK {
		t.Fatalf("写入合法配置 = %d %s", w.Code, w.Body.String())
	}
	if got, _ := gwcSetting(t, db, serverstore.PeakWindowsSetting); got != legal {
		t.Fatalf("合法配置未落库: %q", got)
	}

	cases := []struct {
		name string
		val  string
	}{
		{"显式空数组", `[{"start":"09:00","end":"12:00","weekdays":[]}]`},
		{"全非法星期", `[{"start":"09:00","end":"12:00","weekdays":[0,8]}]`},
		{"部分非法星期", `[{"start":"09:00","end":"12:00","weekdays":[1,8]}]`},
		{"跨午夜", `[{"start":"22:00","end":"06:00"}]`},
		{"坏 JSON", `not-json`},
	}
	for _, c := range cases {
		w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", gatewayPutBody(t, c.val), hdr)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d %s, want 400（这类取值必须响亮失败）", c.name, w.Code, w.Body.String())
		}
		if code := errCodeOf(t, w); code != "VALIDATION" {
			t.Fatalf("%s: error.code = %q, want VALIDATION", c.name, code)
		}
		if got, _ := gwcSetting(t, db, serverstore.PeakWindowsSetting); got != legal {
			t.Fatalf("%s: 被拒的写入改动了已存配置: %q", c.name, got)
		}
	}

	// 合法形态照旧放行：显式每天（键缺省）、显式空数组（= 无高峰窗口）、空串（清空配置）。
	for _, ok := range []struct{ val, stored string }{
		{`[{"start":"09:00","end":"12:00"}]`, `[{"start":"09:00","end":"12:00"}]`},
		{`[]`, `[]`},
		{``, ``},
	} {
		if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", gatewayPutBody(t, ok.val), hdr); w.Code != http.StatusOK {
			t.Fatalf("合法值 %q = %d %s, want 200", ok.val, w.Code, w.Body.String())
		}
		if got, _ := gwcSetting(t, db, serverstore.PeakWindowsSetting); got != ok.stored {
			t.Fatalf("写入 %q 后库里 = %q, want %q", ok.val, got, ok.stored)
		}
	}
}
