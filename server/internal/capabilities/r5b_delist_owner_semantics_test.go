package capabilities

// 第五轮审计 R5-B-1 / R5-B-2 / R5-B-5（2026-09-23）的服务端语义回归。
//
// 三条 finding 共用同一条缝：`apps.enabled`（下架）与 `apps.owner`（归属）这两个
// 事实被多处各写了一遍判据，且互相矛盾：
//
//	R5-B-1 下架在员工面不可表达：作者自己的三个面全空，而下架期间上传照旧 201、
//	       审批照旧 200；
//	R5-B-2 归属转移后员工面与真实归属相反：旧作者永久看到却续传 409，新归属人
//	       （唯一有权续传的人）什么都看不到；
//	R5-B-5 管理员自传的共享技能在「我的」恒为空（上传 201 但零反馈）。
//
// 定案语义（唯一权威见 serverstore/distribution.go）：
//   下架 = 不可分发（分发面与不存在同语义）+ 作者自己的「我的」照旧可见并带
//   delisted=true + 下架期间内容冻结（发布与审批一律 409 APP_DELISTED）；
//   「我的」的成员判据 = apps.owner（与发布权同源），空 owner 不属于任何人。
//
// 变异验证（任一改动都应让本文件变红，对照见报告）：
//   · 把 ListOwned* 换回 publisher 判据 ⇒ R5-B-2 用例红；
//   · 让作者面也走 Delivered() ⇒ R5-B-1 用例红；
//   · 去掉 appstore.Publish / sharedskills.decide 的 Writable() 闸门 ⇒ 冻结用例红；
//   · 还原 capabilities 的 `!u.IsAdmin` ⇒ R5-B-5 用例红。

import (
	"bytes"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/appstore"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/sharedskills"
	"github.com/picoaide/picoaide/internal/skillmanifest"
)

// r5bItem 是能力中心条目的完整投影（比共享夹具多带 is_owner/delisted/author）。
type r5bItem struct {
	Kind     string   `json:"kind"`
	Name     string   `json:"name"`
	Version  string   `json:"version"`
	Status   string   `json:"status"`
	Source   string   `json:"source"`
	Author   string   `json:"author"`
	IsOwner  bool     `json:"is_owner"`
	Delisted bool     `json:"delisted"`
	Versions []string `json:"versions"`
}

func r5bItems(t *testing.T, r *gin.Engine, hdr map[string]string, source string) []r5bItem {
	t.Helper()
	w := doGet(t, r, "/api/client/v2/capabilities?source="+source, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("capabilities(%s) = %d %s", source, w.Code, w.Body.String())
	}
	var body struct {
		Items []r5bItem `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	out := []r5bItem{}
	for _, it := range body.Items {
		if it.Kind == "skill" && it.Name == skillLifecycleName {
			out = append(out, it)
		}
	}
	return out
}

func r5bFind(items []r5bItem, version string) (r5bItem, bool) {
	for _, it := range items {
		if it.Version == version {
			return it, true
		}
	}
	return r5bItem{}, false
}

// r5bUpload 上传一版技能并返回状态码与响应体（不 fatal —— 冻结场景要断言 409）。
func r5bUpload(t *testing.T, r *gin.Engine, hdr map[string]string, version string) (int, string) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{
		"name": skillLifecycleName, "version": version,
		"archive": base64.StdEncoding.EncodeToString(lifecycleZip(t, skillLifecycleName, version)),
	})
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/client/v2/shared-skills", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	return w.Code, w.Body.String()
}

func r5bApprove(t *testing.T, r *gin.Engine, adminHdr map[string]string, version string) (int, string) {
	t.Helper()
	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/api/server/admin/shared-skills/"+skillLifecycleName+"/"+version+"/approve", nil)
	for k, v := range adminHdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	return w.Code, w.Body.String()
}

// r5bErrorCode 取错误信封里的稳定错误码。
func r5bErrorCode(t *testing.T, body string) string {
	t.Helper()
	var env struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(body), &env); err != nil {
		t.Fatalf("错误信封解析失败: %v (%s)", err, body)
	}
	return env.Error.Code
}

// withOwnerTransferRoute 在测试路由树上补生产的那条归属转移路由（前缀、中间件
// 与权限申报与 internal/router 逐字一致）——测试自建树必须与生产同形，否则
// 「转移归属」这条链路在本包内无法端到端验证。
func withOwnerTransferRoute(r *gin.Engine, db *sql.DB) {
	g := r.Group("/api/server/admin", serverauth.AdminAuth(db))
	serverauth.AdminRoute(g, "PUT", "/apps/:kind/:app_id/owner",
		serverauth.PermCapabilityWrite, appstore.NewHandlers(db).TransferOwner)
}

func transferOwner(t *testing.T, r *gin.Engine, adminHdr map[string]string, kind, appID, owner string) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"owner": owner})
	w := httptest.NewRecorder()
	req := httptest.NewRequest("PUT", "/api/server/admin/apps/"+kind+"/"+appID+"/owner", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range adminHdr {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("转移归属 = %d %s", w.Code, w.Body.String())
	}
}

// ---------------------------------------------------------------------------
// R5-B-1：下架 = 作者仍可见（带「已下架」）+ 分发面全员不可见 + 内容冻结
// ---------------------------------------------------------------------------

func TestR5B1DelistKeepsAuthorRowAndHidesDelivery(t *testing.T) {
	r, _, adminHdr, aliceHdr, bobHdr := setupSkillLifecycle(t)
	if code, body := r5bUpload(t, r, aliceHdr, "1.0.0"); code != http.StatusCreated {
		t.Fatalf("upload = %d %s", code, body)
	}
	approveSkill(t, r, adminHdr, "1.0.0")
	grantSkill(t, r, adminHdr, "bob")

	// 正对照：上架时作者与已授权同事在分发面都看得到，作者自己的行在「我的」。
	if len(r5bItems(t, r, aliceHdr, "market")) != 1 || len(r5bItems(t, r, bobHdr, "market")) != 1 {
		t.Fatal("正对照失败：上架时应可见")
	}
	if items := r5bItems(t, r, aliceHdr, "own"); len(items) != 1 || items[0].Delisted {
		t.Fatalf("正对照失败：作者「我的」= %+v", items)
	}

	toggleSkillEnabled(t, r, adminHdr, skillLifecycleName, false)

	// ① 作者面（「我的」）**仍然返回该行**，并带 delisted=true —— 这是 R5-B-1
	//    的修复点：下架不能连作者自己也看不见，否则员工面无法表达「已下架」。
	own := r5bItems(t, r, aliceHdr, "own")
	it, ok := r5bFind(own, "1.0.0")
	if !ok {
		t.Fatalf("下架后作者「我的」看不到自己的行（R5-B-1 回归）: %+v", own)
	}
	if !it.Delisted {
		t.Fatalf("下架行未带 delisted=true（客户端无法渲染「已下架」）: %+v", it)
	}
	if !it.IsOwner {
		t.Fatalf("作者自己的行 is_owner 必须为 true: %+v", it)
	}
	if it.Status != "approved" {
		t.Fatalf("审核状态不应被下架改写: %+v", it)
	}

	// ② 分发面（组织/市场分区）与另一条客户端清单：三种角色都不可见。
	for _, c := range []struct {
		who string
		hdr map[string]string
	}{{"作者", aliceHdr}, {"已授权同事", bobHdr}} {
		if items := r5bItems(t, r, c.hdr, "market"); len(items) != 0 {
			t.Fatalf("下架后%s仍在分发面看到 %+v", c.who, items)
		}
		if containsStr(clientSkillList(t, r, c.hdr), skillLifecycleName+"@1.0.0") {
			t.Fatalf("下架后%s仍在客户端技能清单看到（分发面必须与不存在同语义）", c.who)
		}
		if code := downloadSkill(t, r, c.hdr, "1.0.0"); code != http.StatusNotFound {
			t.Fatalf("下架后%s下载 = %d, want 404", c.who, code)
		}
	}
	// 已授权同事的「我的」里也不该凭空出现别人的行。
	if items := r5bItems(t, r, bobHdr, "own"); len(items) != 0 {
		t.Fatalf("他人的行不得出现在 bob 的「我的」: %+v", items)
	}

	// ③ 重新上架即恢复（下架是可逆开关，不是删除）。
	toggleSkillEnabled(t, r, adminHdr, skillLifecycleName, true)
	items := r5bItems(t, r, aliceHdr, "own")
	it, ok = r5bFind(items, "1.0.0")
	if !ok || it.Delisted {
		t.Fatalf("重新上架后「我的」应恢复 delisted=false: %+v", items)
	}
	if len(r5bItems(t, r, bobHdr, "market")) != 1 {
		t.Fatal("重新上架后已授权同事应恢复可见")
	}
}

func TestR5B1DelistFreezesUploadAndApproval(t *testing.T) {
	r, _, adminHdr, aliceHdr, _ := setupSkillLifecycle(t)
	if code, body := r5bUpload(t, r, aliceHdr, "1.0.0"); code != http.StatusCreated {
		t.Fatalf("upload v1 = %d %s", code, body)
	}
	approveSkill(t, r, adminHdr, "1.0.0")
	// 先造一个待审版本，再下架 —— 于是"下架期间审批"有真实对象可审。
	if code, body := r5bUpload(t, r, aliceHdr, "1.1.0"); code != http.StatusCreated {
		t.Fatalf("upload v1.1.0 = %d %s", code, body)
	}
	toggleSkillEnabled(t, r, adminHdr, skillLifecycleName, false)

	// ① 下架期间不得再上传新版本：放行只会产出「已批准但没人看得见」的行，
	//    作者会反复重传、管理员会反复批准（旧缺陷形态）。
	code, body := r5bUpload(t, r, aliceHdr, "2.0.0")
	if code != http.StatusConflict {
		t.Fatalf("下架期间上传 = %d %s, want 409 APP_DELISTED", code, body)
	}
	if got := r5bErrorCode(t, body); got != appstore.CodeAppDelisted {
		t.Fatalf("下架期间上传错误码 = %q, want %q", got, appstore.CodeAppDelisted)
	}

	// ② 下架期间不得把待审版本置为 approved（同一判据 Writable()）。
	code, body = r5bApprove(t, r, adminHdr, "1.1.0")
	if code != http.StatusConflict {
		t.Fatalf("下架期间审批 = %d %s, want 409 APP_DELISTED", code, body)
	}
	if got := r5bErrorCode(t, body); got != appstore.CodeAppDelisted {
		t.Fatalf("下架期间审批错误码 = %q, want %q", got, appstore.CodeAppDelisted)
	}
	// 拒绝（reject）不是分发动作，下架期间仍应允许清理队列 —— 未生效的版本
	// 被拒不会让任何内容生效。
	if code, body := do(t, r, adminHdr, "POST",
		"/api/server/admin/shared-skills/"+skillLifecycleName+"/1.1.0/reject", `{"reason":"下架期间清理队列"}`); code != http.StatusOK {
		t.Fatalf("下架期间拒绝待审版本 = %d %s, want 200（拒绝不改变分发事实）", code, body)
	}

	// ③ 重新上架后两条路径立即恢复（显式上架是唯一出口，且它本身有审计）。
	toggleSkillEnabled(t, r, adminHdr, skillLifecycleName, true)
	if code, body := r5bUpload(t, r, aliceHdr, "2.0.0"); code != http.StatusCreated {
		t.Fatalf("重新上架后上传 = %d %s, want 201", code, body)
	}
	if code, body := r5bApprove(t, r, adminHdr, "2.0.0"); code != http.StatusOK {
		t.Fatalf("重新上架后审批 = %d %s, want 200", code, body)
	}
	if items := r5bItems(t, r, aliceHdr, "own"); len(items) == 0 || items[0].Version != "2.0.0" {
		t.Fatalf("重新上架 + 审批后「我的」应展示 2.0.0: %+v", items)
	}
}

// 下架冻结对**管理员直发**同样生效（规则没有角色例外，否则管理端仍能造出
// 不可见版本）。这里直接驱动唯一发布内核 appstore.Publish（AdminPublish=true
// 即"管理后台上架"等价于已审核），与三条上传路径共用同一份判据。
func TestR5B1DelistFreezesAdminPublish(t *testing.T) {
	r, db, adminHdr, aliceHdr, _ := setupSkillLifecycle(t)
	if code, body := r5bUpload(t, r, aliceHdr, "1.0.0"); code != http.StatusCreated {
		t.Fatalf("upload = %d %s", code, body)
	}
	approveSkill(t, r, adminHdr, "1.0.0")
	toggleSkillEnabled(t, r, adminHdr, skillLifecycleName, false)

	raw := lifecycleZip(t, skillLifecycleName, "9.9.9")
	checksum, cerr := sharedskills.ValidateSkillArchive(raw)
	if cerr != nil {
		t.Fatalf("夹具归档校验失败: %v", cerr)
	}
	entries, skillMD, lerr := sharedskills.ListArchiveContents(raw)
	if lerr != nil {
		t.Fatalf("夹具归档清单失败: %v", lerr)
	}
	man, merr := skillmanifest.Parse(entries, skillMD, skillLifecycleName)
	if merr != nil {
		t.Fatalf("夹具 SKILL.md 解析失败: %v", merr)
	}
	_, perr := appstore.Publish(db, appstore.PublishRequest{
		Kind: serverstore.AppKindSkill, AppID: skillLifecycleName,
		Channel: serverstore.AppChannelOrg, Archive: raw,
		Publisher: "boss", AdminPublish: true, Checksum: checksum,
		Manifest: appstore.FromSkillManifest(man),
	})
	if perr == nil {
		t.Fatal("下架期间管理员直发仍成功（冻结规则有角色漏洞）")
	}
	var ae *appstore.Error
	if !errors.As(perr, &ae) || ae.Code != appstore.CodeAppDelisted {
		t.Fatalf("管理员直发失败 = %v, want APP_DELISTED", perr)
	}
}

// ---------------------------------------------------------------------------
// R5-B-2：归属转移后「我的」与续传权限方向一致
// ---------------------------------------------------------------------------

func TestR5B2OwnerTransferAlignsOwnWithPublishRight(t *testing.T) {
	r, db, adminHdr, aliceHdr, bobHdr := setupSkillLifecycle(t)
	withOwnerTransferRoute(r, db)
	if code, body := r5bUpload(t, r, aliceHdr, "1.0.0"); code != http.StatusCreated {
		t.Fatalf("upload = %d %s", code, body)
	}
	approveSkill(t, r, adminHdr, "1.0.0")
	if items := r5bItems(t, r, aliceHdr, "own"); len(items) != 1 {
		t.Fatalf("转移前作者「我的」= %+v, want 1 行", items)
	}

	transferOwner(t, r, adminHdr, serverstore.AppKindSkill, skillLifecycleName, "bob")

	// ① 旧作者：既看不到（「我的」按 owner 判），也传不了（发布权同判据）。
	if items := r5bItems(t, r, aliceHdr, "own"); len(items) != 0 {
		t.Fatalf("转移后旧作者的「我的」仍含该行（R5-B-2 回归）: %+v", items)
	}
	code, body := r5bUpload(t, r, aliceHdr, "2.0.0")
	if code != http.StatusConflict {
		t.Fatalf("转移后旧作者续传 = %d %s, want 409 NAME_TAKEN", code, body)
	}
	if got := r5bErrorCode(t, body); got != appstore.CodeNameTaken {
		t.Fatalf("旧作者续传错误码 = %q, want %q", got, appstore.CodeNameTaken)
	}

	// ② 新归属人：看得到（is_owner=true）且传得了 —— 两个方向必须一致。
	items := r5bItems(t, r, bobHdr, "own")
	it, ok := r5bFind(items, "1.0.0")
	if !ok {
		t.Fatalf("转移后新归属人的「我的」看不到该行（唯一的续传人看不到自己的内容）: %+v", items)
	}
	if !it.IsOwner || it.Delisted || it.Status != "approved" {
		t.Fatalf("新归属人的行投影错误: %+v", it)
	}
	if code, body := r5bUpload(t, r, bobHdr, "2.0.0"); code != http.StatusCreated {
		t.Fatalf("新归属人续传 = %d %s, want 201", code, body)
	}

	// ③ 归档豁免同源：新归属人无需授权即可取到自己的内容；旧作者已无任何权利。
	if code := downloadSkill(t, r, bobHdr, "1.0.0"); code != http.StatusOK {
		t.Fatalf("新归属人下载自己（已批准）的版本 = %d, want 200（转移出来的发布权不能是空的）", code)
	}
	if code := downloadSkill(t, r, aliceHdr, "1.0.0"); code != http.StatusNotFound {
		t.Fatalf("转移后旧作者下载 = %d, want 404（他已是普通同事，需授权）", code)
	}
}

// 空 owner 的行（官方内容 / 2026-09-02 之前的历史行）不属于任何人：既不在任何
// 人的「我的」里（含管理员），也不因此失去分发面的授权门。与 appstore.Publish
// 的既有规则同义：空 owner 一律视同占名，非管理员不得接管发布。
func TestR5B2EmptyOwnerIsNobody(t *testing.T) {
	r, db, adminHdr, _, bobHdr := setupSkillLifecycle(t)
	bossBearer := adminBearer(t, db)
	if err := serverstore.UpsertApp(db, &serverstore.App{
		Kind: serverstore.AppKindSkill, AppID: skillLifecycleName, Title: skillLifecycleName,
		Channel: serverstore.AppChannelOrg, Enabled: 1, Owner: "", Official: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateRelease(db, &serverstore.Release{
		Kind: serverstore.AppKindSkill, AppID: skillLifecycleName, Version: "1.0.0",
		Publisher: "boss", Status: serverstore.ReleaseStatusApproved, Archive: []byte("zip"),
	}); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		who string
		hdr map[string]string
	}{{"管理员", bossBearer}, {"同事", bobHdr}} {
		if items := r5bItems(t, r, c.hdr, "own"); len(items) != 0 {
			t.Fatalf("空 owner 的行出现在%s的「我的」里: %+v", c.who, items)
		}
	}
	// 分发面照旧按「已授权」判：未授权同事不可见（严格默认拒绝不因 owner 为空放宽）。
	if items := r5bItems(t, r, bobHdr, "market"); len(items) != 0 {
		t.Fatalf("未授权同事看到空 owner 的行: %+v", items)
	}
	grantSkill(t, r, adminHdr, "bob")
	if items := r5bItems(t, r, bobHdr, "market"); len(items) != 1 {
		t.Fatalf("授权后应可见: %+v", items)
	}
}

// ---------------------------------------------------------------------------
// R5-B-5：管理员自传的共享技能必须能在「我的」看到（201 与可见性一致）
// ---------------------------------------------------------------------------

func TestR5B5AdminSelfUploadVisibleInOwn(t *testing.T) {
	r, db, adminHdr, aliceHdr, _ := setupSkillLifecycle(t)
	bossBearer := adminBearer(t, db)

	// 管理员走客户端上传路径（该路径不禁止管理员）⇒ 201。
	if code, body := r5bUpload(t, r, bossBearer, "1.0.0"); code != http.StatusCreated {
		t.Fatalf("管理员上传 = %d %s, want 201", code, body)
	}
	// ① 「我的」必须能看到它（否则 201 就是零反馈：管理端只能在审批队列里找）。
	items := r5bItems(t, r, bossBearer, "own")
	it, ok := r5bFind(items, "1.0.0")
	if !ok {
		t.Fatalf("管理员自传的技能在「我的」恒为空（R5-B-5 回归）: %+v", items)
	}
	if !it.IsOwner || it.Status != "pending" || it.Delisted {
		t.Fatalf("管理员自己的行投影错误: %+v", it)
	}
	// ② 员工面照旧看不到未审核的内容（严格默认拒绝不受影响）。
	if items := r5bItems(t, r, aliceHdr, "own"); len(items) != 0 {
		t.Fatalf("管理员的 pending 行泄漏进员工的「我的」: %+v", items)
	}
	// ③ 审批通过后管理员仍在自己的「我的」看到它（与普通作者一致）。
	approveSkill(t, r, adminHdr, "1.0.0")
	items = r5bItems(t, r, bossBearer, "own")
	if it, ok = r5bFind(items, "1.0.0"); !ok || it.Status != "approved" {
		t.Fatalf("审批后管理员「我的」= %+v", items)
	}
	// ④ 管理员不是下架规则的例外：下架后他的行同样从分发面消失（下架 =
	//    分发面不存在，对管理员也一样 —— 客户端归档端点恒以 admin=false 构造，
	//    S11-2），但「我的」照旧可见（与普通作者同一条判据）。
	toggleSkillEnabled(t, r, adminHdr, skillLifecycleName, false)
	items = r5bItems(t, r, bossBearer, "own")
	if it, ok = r5bFind(items, "1.0.0"); !ok || !it.Delisted {
		t.Fatalf("下架后管理员「我的」= %+v, want 仍可见且 delisted=true", items)
	}
	if items := r5bItems(t, r, bossBearer, "market"); len(items) != 0 {
		t.Fatalf("下架后管理员仍在分发面看到该行: %+v", items)
	}
	if code := downloadSkill(t, r, bossBearer, "1.0.0"); code != http.StatusNotFound {
		t.Fatalf("下架后管理员（客户端面）下载 = %d, want 404", code)
	}
}
