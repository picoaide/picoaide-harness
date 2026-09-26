package marketplace

// 第二十二轮复审 V2-B1（P2）的**跨面同一性**判据：智能体档案（agent preset）的
// 两个兄弟下载端点共用同一条"员工安装通路"契约 —— `X-Preset-Checksum` 头：
//
//	组织面 `/api/client/v2/agent-presets/:name/archive`（agentshare.serveArchive）
//	市场面 `/api/server/admin/agents/:name/archive`（downloadAgentArchiveAdmin）
//
// ## 缺陷形态（判据要杀的东西）
//
// 与 A2-02 的技能面**逐字同形**：`app_releases.checksum` 是 schema 的默认可达态为空
// （`migrations-pg/0032/0035_agent_presets*.sql` 的 `checksum TEXT NOT NULL DEFAULT ''`，
// `0054_apps_backfill.sql` 按 `p.checksum` 原值回填），而两处都直发 `p.Checksum` /
// `r.Checksum` ⇒ 发出**空头**。客户端把空头读成 `''`（`auth-gate.ts` 的
// `?? undefined` 只吃 null/undefined），`agent-preset-install.ts` 的
// `if (checksum !== undefined)` 于是进入比较分支 ⇒ `archive checksum mismatch; refused`
// （负控：头**不存在**时不报该错）⇒ 这类档案对**所有**员工永久装不上。
//
// ## 判据（三件套，缺一条都测不到"同一性"）
//
//	① 同一份归档字节、同一台服务端，两个端点的头都**非空**；
//	② 两头**彼此相等**（这才是"同一性"；只断言非空的话，两边各算各的也能过）；
//	③ 两头都等于**归档字节的 sha256**（钉住"现算的是归档本身"，而不是随便什么值）。
//
// 两个端点都走**生产注册函数**（`agentshare.RegisterRoutes` / `RegisterAdminRoutes`），
// 不是测试自建路由 —— 路径或中间件漂移会在这里直接暴露。
//
// ## 变异（必须变红）
//
//   - 任一面退回 `c.Header("X-Preset-Checksum", p.Checksum)` ⇒ ① 红（空头）；
//   - 任一面把兜底算在别的字节上（例如算 `[]byte(name)`）⇒ ③ 红；
//   - 只修一面（另一面仍直发空值）⇒ ① 红。

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/picoaide/picoaide/internal/agentshare"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

func TestBlankPresetChecksumHeaderParityAcrossAgentSurfaces(t *testing.T) {
	// 复用市场面的标准测试装配（真 PG + 用户 alice）。alice 在夹具里是 admin：
	// 组织面员工下载路由因此走 admin 短路（`X-Preset-Checksum` 的计算与调用者身份
	// 无关，用 admin 只是绕开"组织面需要授权行"的夹具）；市场面管理端点用她的
	// 管理会话访问 —— 两个端点在生产里就是同一棵路由树的两段。
	r, db, token, api := newTestRouter(t)
	agentshare.RegisterRoutes(r, db, api.CacheDir)
	RegisterAdminRoutes(r, db, api.CacheDir)

	archive := skillArchiveBytes(t, "preset-checksum-parity")
	want := sha256.Sum256(archive)
	wantHex := hex.EncodeToString(want[:])

	// —— 两个面各播一行 `checksum = ''` 的智能体档案，**归档字节完全相同**。
	const orgName = "parity-org-agent"
	if _, err := serverstore.CreateAgentPreset(db, &serverstore.AgentPreset{
		Name: orgName, Version: "1.0.0", DisplayName: "parity org agent",
		Description: "checksum parity probe", Author: "alice",
		Status: serverstore.AgentPresetApproved, Checksum: "", Archive: archive,
	}); err != nil {
		t.Fatalf("播种组织智能体: %v", err)
	}
	const marketName = "parity-market-agent"
	if err := serverstore.UpsertApp(db, &serverstore.App{
		Kind: serverstore.AppKindAgent, AppID: marketName, Title: marketName,
		Owner: "", Channel: serverstore.AppChannelMarket, Enabled: 1,
	}); err != nil {
		t.Fatalf("播种市场智能体 App 行: %v", err)
	}
	if _, err := serverstore.CreateRelease(db, &serverstore.Release{
		Kind: serverstore.AppKindAgent, AppID: marketName, Version: "1.0.0",
		Title: marketName, Author: "alice", Publisher: "alice",
		Status: serverstore.ReleaseStatusApproved, Checksum: "", Archive: archive,
	}); err != nil {
		t.Fatalf("播种市场智能体版本行: %v", err)
	}

	orgW := doReq(r, "GET", "/api/client/v2/agent-presets/"+orgName+"/archive", token)
	if orgW.Code != http.StatusOK {
		t.Fatalf("组织面下载 = %d %s", orgW.Code, orgW.Body.String())
	}

	alice, err := serverstore.GetUserByUsername(db, "alice")
	if err != nil {
		t.Fatal(err)
	}
	sess, _, err := serverauth.CreateAdminSession(db, alice.ID)
	if err != nil {
		t.Fatalf("建管理会话: %v", err)
	}
	req := httptest.NewRequest("GET", "/api/server/admin/agents/"+marketName+"/archive", nil)
	req.AddCookie(&http.Cookie{Name: "picoaide_session", Value: sess.ID})
	mktW := httptest.NewRecorder()
	r.ServeHTTP(mktW, req)
	if mktW.Code != http.StatusOK {
		t.Fatalf("市场面下载 = %d %s", mktW.Code, mktW.Body.String())
	}

	orgSum := orgW.Header().Get("X-Preset-Checksum")
	mktSum := mktW.Header().Get("X-Preset-Checksum")
	t.Logf("X-Preset-Checksum：组织面=%q 市场面=%q（期望 %s）", orgSum, mktSum, wantHex)

	if orgSum == "" || mktSum == "" {
		t.Fatalf("空 checksum 行的完整性头为空（组织面=%q 市场面=%q）—— "+
			"客户端对「头存在但为空」是 fail-closed（`agent-preset-install.ts` 进入比较分支 ⇒ "+
			"`archive checksum mismatch; refused`）⇒ 这一类档案对**所有**员工永久装不上", orgSum, mktSum)
	}
	if orgSum != mktSum {
		t.Fatalf("两个兄弟下载端点的完整性头不一致（组织面=%q 市场面=%q）—— "+
			"同一份契约必须只有一份实现（sharedskills.ArchiveChecksum）", orgSum, mktSum)
	}
	if orgSum != wantHex {
		t.Fatalf("完整性头 = %q, want 归档字节的 sha256 = %q（兜底必须现算归档本身）", orgSum, wantHex)
	}
}
