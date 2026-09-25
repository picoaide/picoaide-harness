package serverstore

// R16C-04（审计 2026-09-25，P2）：`audit_logs.username` 必须与 `detail` 同口径转义。
//
// 缺陷形态（修复前，探针实测）：同一个 AuditLog 入口里 detail 过 `util.EscapeControl`，
// 而 **username 不过任何转义**，可它承载**未认证**输入（登录失败把请求体里的用户名
// 原样写进这一列，见 serverauth/handler.go 的 login_fail 两处）：
//
//   - 带 `\n` 的用户名在库里造出"第二行"（实测 username 列的 hex 里是裸 `0a`）——
//     psql / \copy / SIEM 采集 / 导出脚本都按"一条审计 = 一行"读，凭空多出一条形如
//     管理员操作的记录；
//   - 带 NUL 的用户名让这条审计**永远写不进库**（PG 的 text 不接受 0x00），
//     worker 重试 3 次后丢弃 ⇒ 攻击者可以自己抹掉"登录失败"这条合规留痕。
//
// 判据（本文件）：① 落库 username 的换行数 = 0；② 含 NUL 的用户名**必须留下一条
// 可查的记录**（转义后入库）；③ **正常用户名的存储形态逐字节不变**（转义走快速路径）；
// ④ 两条写路径（异步 worker 与 AuditLogTx）同口径 —— 否则哈希链校验会报断链。

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestAuditLogEscapesUsernameControlCharacters(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()

	// ① 换行注入：库里的 username 必须是**单行**，且换行以可见转义形态保留。
	forged := "evil\n2026-01-01T00:00:00Z|admin|user_delete|FORGED-ROW"
	if err := AuditLog(db, forged, "login_fail", "ip=127.0.0.1"); err != nil {
		t.Fatalf("换行用户名必须仍能落库（留痕不可被自己抹掉）: %v", err)
	}
	var got string
	if err := db.QueryRow(`SELECT username FROM audit_logs WHERE action='login_fail' ORDER BY id DESC LIMIT 1`).Scan(&got); err != nil {
		t.Fatalf("读回 username: %v", err)
	}
	if strings.ContainsAny(got, "\n\r") {
		t.Fatalf("落库 username 里仍有裸换行: %q —— 一条审计被拆成两行", got)
	}
	if !strings.Contains(got, `\n`) {
		t.Fatalf("换行没有被转义成可见序列（内容不该悄悄变样）: %q", got)
	}
	if !strings.HasPrefix(got, "evil") || !strings.Contains(got, "FORGED-ROW") {
		t.Fatalf("转义后内容不完整: %q", got)
	}
	// 整表口径：username 列里的换行总数必须为 0（判据与 detail 的既有判据同形）。
	var newlines int
	if err := db.QueryRow(`SELECT COALESCE(SUM(length(username) - length(replace(username, chr(10), ''))), 0) FROM audit_logs`).Scan(&newlines); err != nil {
		t.Fatal(err)
	}
	if newlines != 0 {
		t.Fatalf("audit_logs.username 里还有 %d 个换行", newlines)
	}

	// ② NUL：必须落库（修前这条**永远写不进库**：PG 拒绝 0x00，重试后丢弃）。
	if err := AuditLog(db, "nul\x00probe", "login_fail", "ip=127.0.0.1"); err != nil {
		t.Fatalf("含 NUL 的用户名必须仍能落库（否则攻击者可以自己抹掉登录失败留痕）: %v", err)
	}
	// 注意：查询**参数**里不能带 0x00（PG 直接报 SQLSTATE 54000 "null character not
	// permitted"）—— 这恰好证明"NUL 原样入库"根本不可能。这里用 LIKE 找到那一行，
	// 再逐字比较转义后的形态。
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM audit_logs WHERE username LIKE 'nul%probe'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("含 NUL 用户名的审计行数 = %d, want 1（转义后入库）", n)
	}
	var nulName string
	if err := db.QueryRow(`SELECT username FROM audit_logs WHERE username LIKE 'nul%probe' ORDER BY id DESC LIMIT 1`).Scan(&nulName); err != nil {
		t.Fatal(err)
	}
	if nulName != `nul\x00probe` {
		t.Fatalf("含 NUL 用户名的落库形态 = %q, want %q", nulName, `nul\x00probe`)
	}
	// 这里不写"库里没有裸 NUL"的断言：PG 的 text 类型**根本存不下 0x00**
	// （写入整条报 SQLSTATE 54000/22021），这正是修前"含 NUL 的登录失败审计永远
	// 落不了库"的机制本身。可判定的形态是上一条：转义后单行入库、内容完整。
	// ③ 正常用户名的存储形态**逐字节不变**（转义必须走快速路径）。
	if err := AuditLog(db, "alice", "login_ok", "ip=127.0.0.1"); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT username FROM audit_logs WHERE action='login_ok' ORDER BY id DESC LIMIT 1`).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != "alice" {
		t.Fatalf("正常用户名被改写: %q, want %q", got, "alice")
	}
	// 中文/emoji 等合法多字节用户名同样必须原样保留（转义不得破坏 UTF-8）。
	if err := AuditLog(db, "张三", "login_ok", "ip=127.0.0.1"); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT username FROM audit_logs WHERE action='login_ok' ORDER BY id DESC LIMIT 1`).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != "张三" || !utf8.ValidString(got) {
		t.Fatalf("多字节用户名被改写: %q", got)
	}

	// ④ 哈希链仍自洽：两条写路径（worker 与 AuditLogTx）必须算同一份输入。
	if broken, err := VerifyAuditChain(db); err != nil || broken != 0 {
		t.Fatalf("转义改造后链校验失败: broken=%d err=%v", broken, err)
	}
}

// TestAuditLogTxEscapesUsernameLikeWorker 钉两条写路径的口径一致：
// 事务路径（AuditLogTx）也必须转义 username，否则同一份"落库内容 == 计算哈希的输入"
// 的前提在两条路径上不同，链会断。
func TestAuditLogTxEscapesUsernameLikeWorker(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()

	tx, err := UsageWriteTx(db)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err := AuditLogTx(tx, "evil\nname", "act_tx", "d"); err != nil {
		t.Fatalf("AuditLogTx 必须能写含换行的用户名: %v", err)
	}
	if err := AuditLogTx(tx, "nul\x00tx", "act_tx", "d"); err != nil {
		t.Fatalf("AuditLogTx 必须能写含 NUL 的用户名: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	var got string
	if err := db.QueryRow(`SELECT username FROM audit_logs WHERE action='act_tx' ORDER BY id ASC LIMIT 1`).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != `evil\nname` {
		t.Fatalf("AuditLogTx 的 username 转义形态 = %q, want %q（与 worker 路径必须同一口径）", got, `evil\nname`)
	}
	if broken, err := VerifyAuditChain(db); err != nil || broken != 0 {
		t.Fatalf("链校验失败: broken=%d err=%v", broken, err)
	}
}
