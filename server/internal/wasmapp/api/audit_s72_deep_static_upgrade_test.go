package api_test

// audit_s72_deep_static_upgrade_test.go —— S7-2（v2.8.1→HEAD 回归审计，P1）的
// **端到端判据**：名字落在 WASM 操作面静态段上的应用必须能建、并且能发新版本。
//
// 缺陷形态：写侧 app_id 保留集合从路由表里收了**任意深度**的静态段（`open` /
// `rows` / `releases` / `request` / `schema` / `export` / `availability` / … 共 13 个），
// 而只有"能把 `:app_id` 的下降领走"的静态段才会真的遮蔽。这 13 个名字在真实匹配树上
// **全部可达**（实测 13 名字 × 13 条 `:app_id` 模板 = 169/169 命中自己的模板），却被
// 一律 400 `INVALID_APP_ID`；由于该规则挂在**每一次发布**上（`creationAppID` 是发布
// 与 availability 预查的第一步，不是"仅首版"），X4-1 封口前建出来的**存量应用永远
// 发不出新版本**，availability 预检也 400。
//
// 本用例走**真 PG + 真生产路由树 + 真编译器 + 真 wasip1 制品**：
//   - ① 自校准：`rows` 必须真的出现在真实路由表的静态段里（否则用例失去对象）、
//     不是首段静态、不在派生保留集合里、且写侧接受它；
//   - ② availability 预检必须判它**合法**（S7-2 的另一半影响：预检也 400）；
//   - ③ 首版：用它建出应用（201）；
//   - ④ 第二版：同一个应用发 1.1.0（201）—— 这是"存量应用能升级"的直接判据；
//   - ⑤ 落库对账：两版都在、生效版本是 1.1.0（不只看 HTTP 码）；
//   - ⑥ 存量行：**直接写库**造一个 X4-1 封口前的应用行（`releases`），再发新版本（201）；
//   - ⑦ 正向对照：真正会遮蔽的 `uploads` 必须**仍然**被写侧拒
//     （`route_static_segment`）—— 证明这条修复不是"把闸门整体拆掉"。
//
// 变异（把派生改回"任意深度全收"）⇒ ②/③/⑥ 红（预检非法 + 发布 400）；
// 变异（把写侧的路由静态段校验整个删掉）⇒ ⑦ 红。

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/picoaide/picoaide/internal/router"
	"github.com/picoaide/picoaide/internal/serverstore"
	wasmregistry "github.com/picoaide/picoaide/internal/wasmapp/registry"
)

var (
	s72GuestOnce sync.Once
	s72GuestWasm []byte
	s72GuestErr  error
)

// s72GuestModule 现场编译参考实现（refapp）为 wasip1 模块（本文件独占一份夹具：
// `api` 包内的 testGuestModule 不可跨包使用）。
//
// 为什么必须真制品：发布链路会**真编译 + 真干跑**（guest 要能读请求帧、写出合法
// 响应帧），用一个伪造的字节串会在 app_id 闸门之前/之后以别的错误码失败，判据就
// 咬不到本 finding。
func s72GuestModule(t *testing.T) []byte {
	t.Helper()
	s72GuestOnce.Do(func() {
		out, err := exec.Command("go", "list", "-m", "-f", "{{.Dir}}").Output()
		if err != nil {
			s72GuestErr = fmt.Errorf("定位模块根失败（需要 go 工具链）: %w", err)
			return
		}
		dir, err := os.MkdirTemp("", "picoaide-s72-guest-")
		if err != nil {
			s72GuestErr = err
			return
		}
		bin := filepath.Join(dir, "guest.wasm")
		cmd := exec.Command("go", "build", "-o", bin, "./internal/wasmapp/refapp")
		cmd.Dir = strings.TrimSpace(string(out))
		cmd.Env = append(os.Environ(), "GOOS=wasip1", "GOARCH=wasm", "CGO_ENABLED=0")
		if b, err := cmd.CombinedOutput(); err != nil {
			s72GuestErr = fmt.Errorf("构建 wasip1 夹具失败（需要本机 Go 工具链支持 wasip1）: %v\n%s", err, b)
			return
		}
		s72GuestWasm, s72GuestErr = os.ReadFile(bin)
	})
	if s72GuestErr != nil {
		t.Fatalf("%v", s72GuestErr)
	}
	return s72GuestWasm
}

// s72Payload 构造发布请求体（首版必填字段齐全；changelog 非首版必填）。
func s72Payload(t *testing.T, appID, version, changelog string, wasm []byte) string {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"app_id":      appID,
		"version":     version,
		"title":       "存量应用 " + appID,
		"changelog":   changelog,
		"wasm_base64": base64.StdEncoding.EncodeToString(wasm),
		"config": map[string]any{
			"access":           "login",
			"whitelist":        []string{},
			"purpose":          "演示：给团队共享一个小工具",
			"data_sensitivity": "internal",
			"owner":            "张伟",
		},
	})
	if err != nil {
		t.Fatalf("构造发布载荷失败: %v", err)
	}
	return string(body)
}

func s72Contains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

func TestAuditS72DeepStaticAppIDCanCreateAppAndPublishSecondRelease(t *testing.T) {
	env := newR25RouteEnv(t)
	// `rows` 是审计 S7-2 点名的名字之一（`/:app_id/rows` 的第二段，深层静态段）。
	const appID = "rows"

	// ① 自校准：用例必须有对象，且当前状态确实是"可达却被写侧拒"的形态。
	statics, firstSegment := r25IndependentSegments(env.r.Routes())
	if !statics[appID] {
		t.Fatalf("自校准失败：%q 不在真实路由表的 WASM 静态段里 —— 用例失去对象", appID)
	}
	if firstSegment[appID] {
		t.Fatalf("自校准失败：%q 被判成首段静态路由 —— 情形与 S7-2 描述的深层静态段不符", appID)
	}
	if reserved := wasmregistry.RouteReservedAppIDs(); s72Contains(reserved, appID) {
		t.Fatalf("自校准失败：派生保留集合仍含 %q（%v）—— 写侧必拒，②③ 会以 400 收场（S7-2 未修）",
			appID, reserved)
	}
	if aerr := wasmregistry.ValidateAppID(appID, nil); aerr != nil {
		t.Fatalf("自校准失败：写侧仍拒 %q：%s（S7-2 未修）", appID, aerr.Message)
	}

	guest := s72GuestModule(t)

	// ② availability 预检（S7-2 的另一半影响：预检也把这类名字判成非法）。
	// 该端点对非法名字走 200 + `valid:false`（判词而非错误信封），所以这里断言取值。
	wAvail := env.do(http.MethodGet, router.WasmClientRouteBase+"/"+appID+"/availability", "", false)
	if wAvail.Code != http.StatusOK {
		t.Fatalf("availability 预检 status=%d body=%s", wAvail.Code, wAvail.Body.String())
	}
	var avail struct {
		Valid bool   `json:"valid"`
		Code  string `json:"code"`
	}
	if err := json.Unmarshal(wAvail.Body.Bytes(), &avail); err != nil {
		t.Fatalf("availability 响应不是 JSON: %v（body=%s）", err, wAvail.Body.String())
	}
	if !avail.Valid {
		t.Fatalf("availability 预检把 %q 判成非法（code=%q body=%s）—— S7-2 的另一半影响",
			appID, avail.Code, wAvail.Body.String())
	}

	// ③ 首版：把这个名字**建出来**（名字实测可达，X4-1 封口之后也不该被拒）。
	w1 := env.do(http.MethodPost, router.WasmClientRouteBase+"/"+appID+"/releases",
		s72Payload(t, appID, "1.0.0", "首版", guest), false)
	if w1.Code != http.StatusCreated {
		t.Fatalf("首版发布失败：status=%d body=%s\n（可达名 %q 被写侧拒 = S7-2 的形态）",
			w1.Code, w1.Body.String(), appID)
	}

	// ④ 第二版：**存量应用能升级**的直接判据（这也是缺陷的实际后果所在：
	// 应用本来在服务，但发不出新版本）。
	w2 := env.do(http.MethodPost, router.WasmClientRouteBase+"/"+appID+"/releases",
		s72Payload(t, appID, "1.1.0", "第二版：修一个 bug", guest), false)
	if w2.Code != http.StatusCreated {
		t.Fatalf("第二版发布失败：status=%d body=%s\n（存量应用发不出新版本 = S7-2 的现场）",
			w2.Code, w2.Body.String())
	}

	// ⑤ 落库对账（HTTP 201 不足以证明版本真的落行且生效指针前移）。
	releases, err := serverstore.ListWasmReleases(context.Background(), env.db, appID, false)
	if err != nil {
		t.Fatalf("读版本历史失败: %v", err)
	}
	if len(releases) != 2 {
		t.Fatalf("版本行数 = %d，want 2（1.0.0 + 1.1.0）：%+v", len(releases), releases)
	}
	if releases[0].Version != "1.0.0" || releases[1].Version != "1.1.0" {
		t.Fatalf("版本序列 = [%s %s]，want [1.0.0 1.1.0]", releases[0].Version, releases[1].Version)
	}
	app, err := serverstore.GetWasmApp(context.Background(), env.db, appID)
	if err != nil {
		t.Fatalf("读应用失败: %v", err)
	}
	if !app.Enabled {
		t.Fatalf("应用 enabled=false（两次发布之后应处于上架态）：%+v", app)
	}
	// 生效版本指针必须前移到第二版（`apps` 行只存 current_release_id，版本号在版本行上）。
	current := ""
	for _, r := range releases {
		if r.ID == app.CurrentReleaseID {
			current = r.Version
		}
	}
	if current != "1.1.0" {
		t.Fatalf("生效版本 = %q（current_release_id=%d），want 1.1.0：%+v",
			current, app.CurrentReleaseID, releases)
	}

	// ⑥ 存量行形态（审计原话的现场）：**直接落一行** X4-1 封口前就存在的应用
	//（不经过发布链路 —— 它本来就建得出来），再发一个**新版本**。这是"存量应用
	// 发不出新版本"的字面复现，也是本轮修复最直接的验收点。
	const legacyID = "releases"
	env.seedLegacyApp(legacyID)
	wl := env.do(http.MethodPost, router.WasmClientRouteBase+"/"+legacyID+"/releases",
		s72Payload(t, legacyID, "1.0.0", "存量应用的新版本", guest), false)
	if wl.Code != http.StatusCreated {
		t.Fatalf("存量应用 %q 发新版本失败：status=%d body=%s\n（S7-2 的现场：应用在服务，但永远发不出新版本）",
			legacyID, wl.Code, wl.Body.String())
	}

	// ⑦ 正向对照：这条修复**不是**把写侧闸门整体拆掉 —— 真正会遮蔽 `:app_id` 的
	// `uploads`（它之下有 `/uploads/:upload_id`，12/13 条模板因此打不开）必须仍然被拒。
	wBad := env.do(http.MethodPost, router.WasmClientRouteBase+"/uploads",
		fmt.Sprintf(`{"app_id":"uploads","version":"1.0.0","total_bytes":1048576,"chunk_bytes":1048576}`), false)
	if bad, detail := isRouteStaticRejection(wBad); !bad {
		t.Fatalf("正向对照失败：uploads 未被写侧以 route_static_segment 拒绝（status=%d body=%s；%s）"+
			"—— 与 X4-1 的封口相反（应用建得成、永远打不开）", wBad.Code, wBad.Body.String(), detail)
	}
}
