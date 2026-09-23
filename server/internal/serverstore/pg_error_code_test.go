package serverstore

// 2026-09-23：`pgErrorCode` 抽出的回归网。
//
// 为什么值得单独钉：抽取前这 5 个 SQLSTATE 判定散在 pg.go / partitions.go×2 /
// users.go / wasmapps.go，各带一份 `errors.As` + 串匹配副本；抽取后它们全部走
// `pgErrorCode` / `pgErrorCodeIs` 这一条路径。判定**收紧**（少认形态）会让
// 「另一会话刚提交同名对象」的并发建分区重新变成裸 SQLSTATE 直出，
// 判定**放宽**（多认形态）会把无关错误误翻译成「分区重叠」。两个方向都不会
// 让别的用例变红 —— 只有这张表能拦住。
//
// 覆盖面（与合并前 5 份副本逐条对齐）：
//   - `errors.As` 命中 `*pgconn.PgError` ⇒ 取结构化 Code；
//   - 被 `%w` 包装（非直接 PgError）时仍要认出；
//   - 非 PgError 但错误串里带 SQLSTATE 文本（中间层再包装）；
//   - `users.go` / `wasmapps.go` 里 SQLite 时代的**宽文本回落**（保留 = 不收窄）。

import (
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestPGErrorCodeClassification(t *testing.T) {
	cases := []struct {
		name string
		err  error
		// 期望的 5 个业务谓词结果。
		dupRel  bool
		overlap bool
		dflt    bool
		unique  bool
		fk      bool
	}{
		{name: "nil", err: nil},

		// —— 结构化 PgError（驱动已解析出码）——
		{name: "42P07 结构化", err: &pgconn.PgError{Code: "42P07", Message: `relation "usage_209901" already exists`}, dupRel: true},
		{name: "42P17 结构化", err: &pgconn.PgError{Code: "42P17", Message: `partition "usage_209901" would overlap`}, overlap: true},
		{name: "23514 结构化", err: &pgconn.PgError{Code: "23514", Message: "default partition constraint violated"}, dflt: true},
		{name: "23505 结构化", err: &pgconn.PgError{Code: "23505", Message: `duplicate key value violates unique constraint "users_username_key"`}, unique: true},
		{name: "23503 结构化", err: &pgconn.PgError{Code: "23503", Message: `insert or update violates foreign key constraint "wasm_releases_app_id_fkey"`}, fk: true},

		// —— 被上层包装（`%w` 链条）⇒ errors.As 仍要命中 ——
		{name: "42P07 包装", err: fmt.Errorf("ensureUsagePartition: create: %w", &pgconn.PgError{Code: "42P07"}), dupRel: true},
		{name: "23503 包装", err: fmt.Errorf("CreateWasmRelease: %w", &pgconn.PgError{Code: "23503"}), fk: true},

		// —— 非 PgError，但错误串里带 SQLSTATE 文本（合并前 3 份副本的兜底路径）——
		{name: "42P07 串回落", err: errors.New(`ERROR: relation "usage_209901" already exists (SQLSTATE 42P07)`), dupRel: true},
		{name: "42P17 串回落", err: errors.New(`ERROR: partition "x" would overlap (SQLSTATE 42P17)`), overlap: true},
		{name: "23514 串回落", err: errors.New(`ERROR: updated partition constraint for default partition would be violated (SQLSTATE 23514)`), dflt: true},
		{name: "23505 裸码串", err: errors.New("error 23505 from wrapper"), unique: true},
		{name: "23503 裸码串", err: errors.New("error 23503 from wrapper"), fk: true},

		// —— SQLite 时代的**宽文本回落**（users.go / wasmapps.go 有意保留）——
		{name: "SQLite UNIQUE", err: errors.New("UNIQUE constraint failed: users.username"), unique: true},
		{name: "unique constraint 文本", err: errors.New(`duplicate key value violates unique constraint "x"`), unique: true},
		{name: "duplicate key 文本", err: errors.New("duplicate key on insert"), unique: true},
		{name: "foreign key constraint 文本", err: errors.New(`violates foreign key constraint "wasm_releases_app_id_fkey"`), fk: true},
		// SQLite 的真实文案是全大写的 `FOREIGN KEY constraint failed`，而回落判据是
		// **大小写敏感**的小写串 ⇒ 它本来就不命中。这不是本次合并引入的差异，是原实现的
		// 既有窄面（SQLite 已下线，该路径无生产者）；这里钉住它，避免日后有人"顺手"
		// 放宽成大小写不敏感却没意识到那是一次判定放宽。
		{name: "SQLite 全大写文案不命中（与原实现一致）", err: errors.New("FOREIGN KEY constraint failed")},

		// —— 负例：不能把无关错误认成上面任何一种 ——
		{name: "无关错误", err: errors.New("connection reset by peer")},
		{name: "别的 SQLSTATE", err: &pgconn.PgError{Code: "40001", Message: "serialization failure"}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isDuplicateRelationErr(tc.err); got != tc.dupRel {
				t.Errorf("isDuplicateRelationErr = %v, want %v", got, tc.dupRel)
			}
			if got := isOverlapPartitionErr(tc.err); got != tc.overlap {
				t.Errorf("isOverlapPartitionErr = %v, want %v", got, tc.overlap)
			}
			if got := isDefaultPartitionViolationErr(tc.err); got != tc.dflt {
				t.Errorf("isDefaultPartitionViolationErr = %v, want %v", got, tc.dflt)
			}
			if got := isUniqueViolation(tc.err); got != tc.unique {
				t.Errorf("isUniqueViolation = %v, want %v", got, tc.unique)
			}
			if got := isForeignKeyViolation(tc.err); got != tc.fk {
				t.Errorf("isForeignKeyViolation = %v, want %v", got, tc.fk)
			}
		})
	}
}

// TestPGErrorCodeReturnsStructuredCode 钉住两级判定的**优先级**：
// 结构化 Code 优先于错误串文本（否则一个 message 里恰好带别的码会让判定变宽）。
func TestPGErrorCodeReturnsStructuredCode(t *testing.T) {
	wrapped := fmt.Errorf("outer: %w", &pgconn.PgError{Code: pgSQLStateOverlapPartition})
	code, ok := pgErrorCode(wrapped)
	if !ok || code != pgSQLStateOverlapPartition {
		t.Fatalf("pgErrorCode(包装的 42P17) = (%q, %v), want (%q, true)", code, ok, pgSQLStateOverlapPartition)
	}
	if code, ok := pgErrorCode(nil); ok || code != "" {
		t.Fatalf("pgErrorCode(nil) = (%q, %v), want (\"\", false)", code, ok)
	}
	if code, ok := pgErrorCode(errors.New("no state here")); ok || code != "" {
		t.Fatalf("pgErrorCode(无码错误) = (%q, %v), want (\"\", false)", code, ok)
	}
	// 5 个码都在回落清单里（新增判定时忘记登记会在这里红）。
	for _, code := range []string{
		pgSQLStateDuplicateRelation,
		pgSQLStateOverlapPartition,
		pgSQLStateDefaultPartitionViolated,
		pgSQLStateUniqueViolation,
		pgSQLStateForeignKeyViolation,
	} {
		if !pgErrorCodeIs(errors.New("wrapper: SQLSTATE "+code), code) {
			t.Errorf("回落清单缺 %s", code)
		}
	}
}
