//go:build skills

// 本文件是**技能面归档非 JSON 例外**的正向举证（P1 第二片，2026-10-14 起按模块分文件）。
//
// 它举证的端点是 `/api/client/v2/skills/builtin/:name/archive` —— 技能面关闭时
// 该路由整片不注册，举证无从谈起。断言一条都没有删（开启 skills 时逐字照跑）。

package main

import (
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/skillseed"
)

func TestAPISweepExceptionEvidenceBinaryArchive(t *testing.T) {
	db := requireRealDB(t)

	// 内置技能目录：优先用仓库真实资产（server/skills = 镜像 /opt/picoaide/skills
	// 的源头），没有就自建夹具（见 sweepBuiltinSkillsDir 的注释：本用例举证的是
	// **内容类型契约**，不该因为无关分支的资产没提交而红）。
	skillsDir, skillName := sweepBuiltinSkillsDir(t)
	prevDir := skillseed.Dir
	skillseed.Dir = skillsDir
	t.Cleanup(func() { skillseed.Dir = prevDir })

	// 例外表是**载荷**：这里正向举证的路由必须登记在案（删掉登记 ⇒ 本用例红），
	// 否则"归档是 gzip 例外"这件事可以被人从表里悄悄删掉而没人发现。
	assertDeclaredNonJSON(t, "GET /api/client/v2/skills/builtin/:name/archive", "application/gzip")

	sweepSilenceAccessLog(t)
	r := sweepEngine(t, db)
	token := sweepIssueToken(t, db, "sweep-archive")

	h := sweepDoAuthed(r, "GET", "/api/client/v2/skills/builtin/:name/archive",
		"/api/client/v2/skills/builtin/"+skillName+"/archive", token)
	if h.status != 200 {
		t.Fatalf("%s：status=%d want 200；content-type=%q body=%s",
			h.label(), h.status, h.ct, h.bodySummary())
	}
	if !strings.HasPrefix(h.ct, "application/gzip") {
		t.Fatalf("%s：content-type=%q want application/gzip（例外登记里的二进制面）",
			h.label(), h.ct)
	}
	if len(h.body) < 3 || h.body[0] != 0x1f || h.body[1] != 0x8b {
		t.Fatalf("%s：body 不是 gzip 字节流（前 3 字节 % x）", h.label(), h.body[:min(3, len(h.body))])
	}
	if chk := h.header.Get("X-Skill-Checksum"); chk == "" {
		t.Errorf("%s：缺少 X-Skill-Checksum（客户端靠它做 sha256 对照）", h.label())
	}
	t.Logf("例外正向举证：%s ⇒ %d %s（%d 字节 gzip，X-Skill-Checksum=%s…）",
		h.label(), h.status, h.ct, len(h.body), h.header.Get("X-Skill-Checksum")[:8])
}
