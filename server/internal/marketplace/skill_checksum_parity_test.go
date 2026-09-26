package marketplace

// A2-02（审计 2026-09-26，P2）的**跨面同一性**判据：组织面与市场面是两个兄弟下载
// 端点，却共用同一条"员工安装通路"契约 —— `X-Skill-Checksum` 头。
//
// ## 缺陷形态（判据要杀的东西）
//
// 库里的 `checksum` 是 schema 的默认可达态为空（0034 的
// `checksum TEXT NOT NULL DEFAULT ''`，0054 按原值回填）。修前：
//
//	市场面 `serveSkillArchive`  → `if sum == "" { sum = sha256Hex(archive) }` ⇒ 有兜底
//	组织面 `sharedskills.download` → `c.Header("X-Skill-Checksum", s.Checksum)` ⇒ 发**空头**
//
// 客户端自 R18B-05 起对"头存在但为空"是 fail-closed（`CHECKSUM_UNAVAILABLE`、422、
// 拒绝安装）⇒ 组织面那些行对**所有**员工永久装不上，而市场面同形状行正常 ——
// 同一台服务端、同一种数据状态、两个渠道两种结局。
//
// ## 判据（三件套，缺一条都测不到"同一性"）
//
//	① 同一份归档字节、同一台服务端，两个端点的头都**非空**；
//	② 两头**彼此相等**（这才是"同一性"；只断言非空的话，两边各算各的也能过）；
//	③ 两头都等于**归档字节的 sha256**（钉住"现算的是归档本身"，而不是随便什么值）。
//
// ## 变异（必须变红）
//
//   - 组织面退回 `c.Header("X-Skill-Checksum", s.Checksum)` ⇒ ① 红（空头）；
//   - 市场面退回"没有兜底"⇒ ① 红；
//   - 任一面把兜底算在别的字节上（例如算 `[]byte(s.Name)`）⇒ ③ 红。

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/sharedskills"
)

func TestBlankChecksumHeaderParityAcrossSkillSurfaces(t *testing.T) {
	// 复用市场面的标准测试装配（真 PG + admin Bearer）—— 两个端点都用同一个
	// admin 令牌访问员工路由：`X-Skill-Checksum` 的计算与调用者身份无关，用 admin
	// 只是绕开"组织面需要授权行 / 市场面需要 apps 行"的授权夹具。
	r, db, token, api := newTestRouter(t)

	// 组织面：直接把路由挂到同一个引擎上（两个面在生产里就是同一棵路由树的两段）。
	sharedskills.RegisterRoutes(r, db, api.CacheDir)

	archive := skillArchiveBytes(t, "parity-skill")
	want := sha256.Sum256(archive)
	wantHex := hex.EncodeToString(want[:])

	// —— 两个面各播一行 `checksum = ''` 的技能，**归档字节完全相同**。
	//
	// 组织面把 Owner 播成 alice（newTestRouter 的那个账号）：员工下载路由对
	// **非 admin 路由**要求"授权或归属人本人"（`dist.OwnedBy`），归属人是最省事
	// 且最贴近真实的夹具；市场面 alice 是 admin ⇒ 授权闸门直接放行。
	const orgName, orgVersion = "parity-org-skill", "1.0.0"
	if _, err := serverstore.CreateSharedSkill(db, &serverstore.SharedSkill{
		Name: orgName, Version: orgVersion, Description: "parity probe",
		Author: "alice", Checksum: "", Status: serverstore.SharedSkillApproved,
		Archive: archive,
	}); err != nil {
		t.Fatalf("播种组织技能: %v", err)
	}
	const marketName = "parity-market-skill"
	if _, err := serverstore.AddSkill(db, &serverstore.Skill{
		Name: marketName, Version: "1.0.0", Description: "parity probe",
		Author: "alice", Enabled: 1, Checksum: "", Archive: archive,
	}); err != nil {
		t.Fatalf("播种市场技能: %v", err)
	}

	orgW := doReq(r, "GET", "/api/client/v2/shared-skills/"+orgName+"/"+orgVersion+"/archive", token)
	if orgW.Code != http.StatusOK {
		t.Fatalf("组织面下载 = %d %s", orgW.Code, orgW.Body.String())
	}
	mktW := doReq(r, "GET", "/api/client/v2/marketplace/skills/"+marketName+"/archive", token)
	if mktW.Code != http.StatusOK {
		t.Fatalf("市场面下载 = %d %s", mktW.Code, mktW.Body.String())
	}

	orgSum := orgW.Header().Get("X-Skill-Checksum")
	mktSum := mktW.Header().Get("X-Skill-Checksum")
	t.Logf("X-Skill-Checksum：组织面=%q 市场面=%q（期望 %s）", orgSum, mktSum, wantHex)

	if orgSum == "" || mktSum == "" {
		t.Fatalf("空 checksum 行的完整性头为空（组织面=%q 市场面=%q）—— "+
			"客户端 R18B-05 起对「头存在但为空」fail-closed（CHECKSUM_UNAVAILABLE、拒绝安装）"+
			"⇒ 这一行对**所有**员工永久装不上", orgSum, mktSum)
	}
	if orgSum != mktSum {
		t.Fatalf("两个兄弟下载端点的完整性头不一致（组织面=%q 市场面=%q）—— "+
			"同一份契约必须只有一份实现（sharedskills.ArchiveChecksum）", orgSum, mktSum)
	}
	if orgSum != wantHex {
		t.Fatalf("完整性头 = %q, want 归档字节的 sha256 = %q（兜底必须现算归档本身）", orgSum, wantHex)
	}
}
