package telemetry

import (
	"net/http"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// SG-1(审计 2026-09-17,r2 server-gateway P3)回归:上报文本里的控制字符
// (最典型是 JSON `\u0000`)不得让**整条**上报 500。
//
// 缺陷现场:reason/release 里的一个 NUL 会被 PostgreSQL 拒绝(0x00 不是合法
// UTF8 字节),UpsertErrorReportingStatus 报错 ⇒ handler 回 500 且**不落库**;
// 而该用户上一行(上一次的 ready)原样留在表里 —— 管理端「客户端上报状态」
// 页继续显示「正常」,正是这个功能要消灭的「后台绿着、客户端已经坏了」。
// 契约见 errorreporting.go 文件头:单字段不合法只清洗该字段,整条状态仍记录。
func TestReportErrorReportingStatusStripsControlChars(t *testing.T) {
	resetErrorReportingLimiter()
	r, db, token := newTestEnv(t)

	// 先写入旧状态行:下面每次上报都必须把它覆盖成 failed(而不是因为 NUL
	// 报 500、把这一行留在后台继续显示 ready)。
	if w := post(r, token, errorReportingPath, `{"state":"ready","release":"v0"}`); w.Code != http.StatusOK {
		t.Fatalf("seed ready = %d %s", w.Code, w.Body.String())
	}

	cases := []struct {
		name        string
		body        string
		wantReason  string
		wantRelease string
	}{
		{"nul in reason", `{"state":"failed","reason":"a\u0000b"}`, "ab", ""},
		{"nul in release", `{"state":"failed","release":"v1\u0000"}`, "", "v1"},
		{"nul at both ends", `{"state":"failed","reason":"\u0000boom\u0000"}`, "boom", ""},
		{"c0 and del stripped, newline and tab kept", `{"state":"failed","reason":"l1\nl2\tend\u0001\u001f\u007f"}`, "l1\nl2\tend", ""},
		{"c1 stripped", `{"state":"failed","reason":"a\u0085b"}`, "ab", ""},
		{"control-only reason becomes empty", `{"state":"failed","reason":"\u0000\u0001"}`, "", ""},
		{"nul in reason and release together", `{"state":"failed","reason":"boom\u0000","release":"v2\u0000"}`, "boom", "v2"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := post(r, token, errorReportingPath, tc.body)
			if w.Code != http.StatusOK {
				t.Fatalf("report = %d %s, want 200(该字段被清洗、整条状态仍记录)", w.Code, w.Body.String())
			}
			rows := errorReportingRows(t, db)
			if len(rows) != 1 {
				t.Fatalf("rows = %d, want 1(upsert 单行)", len(rows))
			}
			got := rows[0]
			// 关键:旧 ready 行必须已被本次上报覆盖 —— 后台上报状态页不能再
			// 显示与事实相反的「正常」。
			if got.State != serverstore.ErrorReportingStateFailed {
				t.Fatalf("state = %q, want failed(旧 ready 行未被覆盖:后台上报状态页会继续显示正常)", got.State)
			}
			if got.Reason != tc.wantReason {
				t.Fatalf("reason = %q, want %q", got.Reason, tc.wantReason)
			}
			if got.Release != tc.wantRelease {
				t.Fatalf("release = %q, want %q", got.Release, tc.wantRelease)
			}
			for _, bad := range []string{"\x00", "\x01", "\x1f", "\x7f", "\u0085"} {
				if strings.Contains(got.Reason, bad) || strings.Contains(got.Release, bad) {
					t.Fatalf("control char %q survived into the row: %+v", bad, got)
				}
			}
		})
	}
}

// SG-1 残留(r3v 复核,2026-09-17):state 是唯一没过 stripControlChars 的字段。
//
// 复现:`{"state":"failed\u0000"}` —— 只 TrimSpace + 查白名单时它不在白名单里,
// 于是走「未知状态静默忽略」分支,回 200 {ok:true} 却**一个字都不落库**,该用户
// 上一行(seed 的 ready)继续在后台显示 —— 与 SG-1 修掉的 500 是同一个症状
// (后台绿着、客户端已经坏了),而且触发它的正是 SG-1 清洗的那类字符。
// 修复后控制字符先剥:该串记录成 failed(旧行被覆盖)。
func TestReportErrorReportingStateStripsControlChars(t *testing.T) {
	resetErrorReportingLimiter()
	r, db, token := newTestEnv(t)

	if w := post(r, token, errorReportingPath, `{"state":"ready","release":"v0"}`); w.Code != http.StatusOK {
		t.Fatalf("seed ready = %d %s", w.Code, w.Body.String())
	}

	// 控制字符出现在 state 的任意位置/任意类别(C0/DEL/C1)都必须落到 failed。
	for _, body := range []string{
		`{"state":"failed\u0000","reason":"boom"}`,
		`{"state":"\u0001failed\u007f","reason":"boom"}`,
		`{"state":"failed\u0085","reason":"boom"}`,
	} {
		if w := post(r, token, errorReportingPath, body); w.Code != http.StatusOK {
			t.Fatalf("%s = %d %s, want 200", body, w.Code, w.Body.String())
		}
		rows := errorReportingRows(t, db)
		if len(rows) != 1 {
			t.Fatalf("%s rows = %d, want 1(upsert 单行)", body, len(rows))
		}
		if rows[0].State != serverstore.ErrorReportingStateFailed {
			t.Fatalf("%s state = %q, want failed(控制字符没被剥 ⇒ 上报被静默丢弃,后台继续显示上一行的 ready)", body, rows[0].State)
		}
	}

	// 边界:真正不认识的状态值仍然静默忽略(200 且不落库)—— 修复不得把
	// 文件头写明的「未知 state 非致命」契约一起改掉(旧行保持上一次的值)。
	if w := post(r, token, errorReportingPath, `{"state":"weird\u0000","reason":"x"}`); w.Code != http.StatusOK {
		t.Fatalf("unknown state = %d %s, want 200", w.Code, w.Body.String())
	}
	rows := errorReportingRows(t, db)
	if len(rows) != 1 || rows[0].State != serverstore.ErrorReportingStateFailed || rows[0].Reason != "boom" {
		t.Fatalf("unknown state must stay silently ignored, got %+v", rows)
	}
}

// SG-1 同源检查(审计给出先例):skill-call 的 name/version 是同一个洞 ——
// NUL 能穿过长度与分隔符校验,却让 SELECT/UPDATE 的参数被 PG 拒绝(500 +
// 计数丢失)。清洗后仍按原有校验判定(全控制字符 ⇒ 空名 ⇒ 400)。
func TestReportSkillCallStripsControlChars(t *testing.T) {
	r, db, token := newTestEnv(t)
	if _, err := serverstore.AddSkill(db, &serverstore.Skill{Name: "codeql", Version: "1.0.0", Enabled: 1, Archive: []byte("pkg")}); err != nil {
		t.Fatal(err)
	}
	grantSkill(t, db, "codeql", "alice")
	const path = "/api/client/v2/telemetry/skill-call"

	// NUL 结尾的名字清洗成 codeql ⇒ 真的计到 codeql 上(不是 500、也不是丢计数)。
	if w := post(r, token, path, `{"name":"codeql\u0000"}`); w.Code != http.StatusOK {
		t.Fatalf("nul-suffixed name = %d %s, want 200", w.Code, w.Body.String())
	}
	if calls := marketSkillCalls(t, db, "codeql"); calls != 1 {
		t.Fatalf("codeql calls = %d, want 1(清洗后的名字必须真的命中计数目标)", calls)
	}

	// version 里的 NUL 同样不能 500:清洗成 1.0 后落不到任何版本行,静默成功。
	if w := post(r, token, path, `{"name":"codeql","version":"1.0\u0000"}`); w.Code != http.StatusOK {
		t.Fatalf("nul in version = %d %s, want 200", w.Code, w.Body.String())
	}
	if calls := marketSkillCalls(t, db, "codeql"); calls != 1 {
		t.Fatalf("codeql calls = %d, want 1(不存在的 version 不计数)", calls)
	}

	// 全控制字符的名字清洗后为空 ⇒ 沿用「name 不合法」400(不是 500)。
	if w := post(r, token, path, `{"name":"\u0000\u0001"}`); w.Code != http.StatusBadRequest {
		t.Fatalf("control-only name = %d %s, want 400", w.Code, w.Body.String())
	}
}
