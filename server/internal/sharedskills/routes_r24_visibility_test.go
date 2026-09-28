package sharedskills

// R24-X4 B18（审计 2026-09-26，P2）回归：**员工面的可见性与下载口径相反** ⇒
// 管理员"看得到、装不上"。
//
// 缺陷形态（修前）：列表按**调用者**的 `u.IsAdmin` 全量（`routes.go` 的 listVisible），
// 而下载用的是**路由级** admin 常量（员工面路由恒以 `admin=false` 构造，与调用者是否
// 管理员无关）⇒ 管理员在员工面看得到组织共享技能、用同一个 Bearer 安装必 404
// 「技能不存在」。正确口径在 `marketplace/skill_api.go`（判**调用者**）。
//
// 修法：列表 / 下载（= 客户端的安装通路）共用**同一个** `skillAudience.visibleTo`
// （唯一实现，见 routes.go）。
//
// 判据（本文件，真 PG + 真路由）：四种身份（管理员 / 已授权员工 / 未授权员工 /
// 未登录；另加"归属人本人"作对照）× 四种行形态（已通过 / 待审 / 已下架 / 不存在）
// 的矩阵必须自洽，且**程序化**断言不变量：`列表里出现 ⇔ 同一个 Bearer 下载 200`；
// 未授权与不存在**同形**（状态码与消息逐字相同，不泄露存在性）。
//
// 变异（把下载口径退回路由级常量 `!admin`）⇒ 管理员那一列红（红/绿对照见
// temp/r21/fix-25/REPORT.md）。

import (
	"net/http"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// r24Identity 是一次"以某个身份访问员工面"的凭据（未登录 = 空 header）。
type r24Identity struct {
	name string
	hdr  map[string]string
	// anonymous 标记未登录：BearerAuth 必须拦成 401。
	anonymous bool
}

// r24Rows 是本用例的四种行形态（名字互不为子串，便于清单成员判定）。
var r24Rows = []string{"r24-open", "r24-pending", "r24-down", "r24-ghost"}

func TestR24SharedSkillVisibilityMatrixIsSelfConsistent(t *testing.T) {
	r, db, adminHdr, aliceHdr, bobHdr := setup(t)
	defer db.Close()

	// 第四种身份：已授权员工（个人授权），与归属人 alice、未授权 bob 区分开。
	if _, err := serverstore.CreateUserWithPassword(db, "carol", "pw123456"); err != nil {
		t.Fatal(err)
	}
	carol, err := serverstore.GetUserByUsername(db, "carol")
	if err != nil {
		t.Fatal(err)
	}
	carolToken, err := serverauth.IssueToken(db, carol.ID)
	if err != nil {
		t.Fatal(err)
	}
	// 员工面只认 Bearer：管理员的"员工面身份"也必须用**调用者自己的 Bearer**
	// （这正是 R24-X4 B18 的现场：管理员用同一个 Bearer 看得到、装不上）。
	boss, err := serverstore.GetUserByUsername(db, "boss")
	if err != nil {
		t.Fatal(err)
	}
	adminToken, err := serverauth.IssueToken(db, boss.ID)
	if err != nil {
		t.Fatal(err)
	}

	// 三种真实行：已通过（上架）/ 待审 / 已通过但下架。第四种（不存在）不建行。
	for _, name := range []string{"r24-open", "r24-pending", "r24-down"} {
		if code, body := skUserDo(t, r, aliceHdr, "POST", "/api/client/v2/shared-skills", skillUpload(t, name, "1.0.0", "R24 可见性矩阵夹具")); code != http.StatusCreated {
			t.Fatalf("上传 %s = %d %s", name, code, body)
		}
	}
	for _, name := range []string{"r24-open", "r24-down"} {
		if code, body := skAdminDo(t, r, adminHdr, "POST", "/api/server/admin/shared-skills/"+name+"/1.0.0/approve", ""); code != http.StatusOK {
			t.Fatalf("审批通过 %s = %d %s", name, code, body)
		}
	}
	if code, body := skAdminDo(t, r, adminHdr, "PUT", "/api/server/admin/shared-skills/r24-down/enabled", `{"enabled":false}`); code != http.StatusOK {
		t.Fatalf("下架 r24-down = %d %s", code, body)
	}
	if code, body := skAdminDo(t, r, adminHdr, "PUT", "/api/server/admin/shared-skills/r24-open/grant", `{"username":"carol"}`); code != http.StatusOK {
		t.Fatalf("授权 carol = %d %s", code, body)
	}

	identities := []r24Identity{
		{name: "管理员", hdr: map[string]string{"Authorization": "Bearer " + adminToken}},
		{name: "归属人本人", hdr: aliceHdr},
		{name: "已授权员工", hdr: map[string]string{"Authorization": "Bearer " + carolToken}},
		{name: "未授权员工", hdr: bobHdr},
		{name: "未登录", anonymous: true},
	}
	// 期望矩阵：行 → 身份 → 是否允许（列表出现 ∧ 下载 200）。
	want := map[string]map[string]bool{
		"r24-open":    {"管理员": true, "归属人本人": true, "已授权员工": true, "未授权员工": false, "未登录": false},
		"r24-pending": {"管理员": false, "归属人本人": false, "已授权员工": false, "未授权员工": false, "未登录": false},
		"r24-down":    {"管理员": false, "归属人本人": false, "已授权员工": false, "未授权员工": false, "未登录": false},
		"r24-ghost":   {"管理员": false, "归属人本人": false, "已授权员工": false, "未授权员工": false, "未登录": false},
	}

	for _, id := range identities {
		t.Run(id.name, func(t *testing.T) {
			listCode, listBody := skUserDo(t, r, id.hdr, "GET", "/api/client/v2/shared-skills", "")
			if id.anonymous {
				if listCode != http.StatusUnauthorized {
					t.Fatalf("未登录清单 = %d %s, want 401", listCode, listBody)
				}
			} else if listCode != http.StatusOK {
				t.Fatalf("清单 = %d %s, want 200", listCode, listBody)
			}
			for _, row := range r24Rows {
				code, body := skUserDo(t, r, id.hdr, "GET", "/api/client/v2/shared-skills/"+row+"/1.0.0/archive", "")
				listed := !id.anonymous && strings.Contains(listBody, `"`+row+`"`)
				// 不变量（唯一承重的那条）：列表里出现 ⇔ 同一个 Bearer 能下载安装。
				if listed != (code == http.StatusOK) {
					t.Fatalf("%s × %s：列表出现=%v 但下载 = %d %s —— 列表放行、下载拒绝是 R24-X4 B18 的缺陷形态",
						id.name, row, listed, code, body)
				}
				allowed := want[row][id.name]
				if listed != allowed || (code == http.StatusOK) != allowed {
					t.Fatalf("%s × %s：允许=%v（列表=%v 下载=%d %s），want %v",
						id.name, row, listed, listed, code, body, allowed)
				}
				if id.anonymous && code != http.StatusUnauthorized {
					t.Fatalf("未登录下载 %s = %d %s, want 401", row, code, body)
				}
				if !allowed && !id.anonymous && code != http.StatusNotFound {
					t.Fatalf("%s × %s 下载 = %d %s, want 404（未授权/未审核/已下架/不存在一律同形）",
						id.name, row, code, body)
				}
			}
		})
	}

	// 未授权与不存在**同形**：状态码 + 信封逐字相同（不泄露存在性）。
	unauthCode, unauthBody := skUserDo(t, r, bobHdr, "GET", "/api/client/v2/shared-skills/r24-open/1.0.0/archive", "")
	ghostCode, ghostBody := skUserDo(t, r, bobHdr, "GET", "/api/client/v2/shared-skills/r24-ghost/1.0.0/archive", "")
	if unauthCode != ghostCode || unauthBody != ghostBody {
		t.Fatalf("未授权与不存在不同形：unauthorized=%d %s / missing=%d %s", unauthCode, unauthBody, ghostCode, ghostBody)
	}
}
