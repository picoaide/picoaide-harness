// Command vacuum-into checks whether SQLITE_LIMIT_ATTACHED=0 also blocks
// VACUUM INTO, i.e. whether "ban VACUUM INTO" or "reset the per-connection
// ATTACH limit" is the load-bearing control (design §4.5, §15.1 #5).
//
// Measured with modernc.org/sqlite v1.55.0 (SQLite 3.53.3) and v1.59.0
// (SQLite 3.53.4): without the limit VACUUM INTO writes the target file;
// with the limit set to 0 both ATTACH and VACUUM INTO fail with
// "too many attached databases - max 0" and no file is produced.
//
// Switch driver versions with:
//
//	go mod edit -require=modernc.org/sqlite@v1.59.0 && go mod tidy
package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

func main() {
	ctx := context.Background()
	dir, err := os.MkdirTemp("", "vacuum-probe")
	must(err)
	defer os.RemoveAll(dir)

	{
		db, err := sql.Open("sqlite", filepath.Join(dir, "version.sqlite"))
		must(err)
		var ver string
		_ = db.QueryRowContext(ctx, "select sqlite_version()").Scan(&ver)
		_ = db.Close()
		fmt.Printf("modernc.org/sqlite embedded SQLite version: %s\n\n", ver)
	}

	for _, limit := range []int{-1, 0} {
		label := fmt.Sprintf("LIMIT_ATTACHED=%d", limit)
		src := filepath.Join(dir, fmt.Sprintf("src-%d.sqlite", limit))
		db, err := sql.Open("sqlite", "file:"+src)
		must(err)
		conn, err := db.Conn(ctx)
		must(err)

		if limit >= 0 {
			old, err := sqlite.Limit(conn, sqlite3.SQLITE_LIMIT_ATTACHED, limit)
			fmt.Printf("[%s] set (previous value %d, err=%v)\n", label, old, err)
		}
		_, err = conn.ExecContext(ctx, "CREATE TABLE t(x INTEGER)")
		must(err)
		_, err = conn.ExecContext(ctx, "INSERT INTO t VALUES (1),(2)")
		must(err)

		out := filepath.Join(dir, fmt.Sprintf("vacuum-out-%d.sqlite", limit))
		_, verr := conn.ExecContext(ctx, "VACUUM INTO '"+out+"'")
		fi, serr := os.Stat(out)
		fmt.Printf("[%s] VACUUM INTO -> err=%v ; target exists=%v", label, verr, serr == nil)
		if serr == nil {
			fmt.Printf(" (%d bytes)", fi.Size())
		}
		fmt.Println()

		other := filepath.Join(dir, fmt.Sprintf("attach-%d.sqlite", limit))
		_, aerr := conn.ExecContext(ctx, "ATTACH DATABASE '"+other+"' AS b")
		fmt.Printf("[%s] ATTACH      -> err=%v\n\n", label, aerr)

		_ = conn.Close()
		_ = db.Close()
	}
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
