package serverstore

import "testing"

func TestRewritePlaceholders(t *testing.T) {
	cases := []struct{ in, want string }{
		{"SELECT * FROM users WHERE id = ?", "SELECT * FROM users WHERE id = $1"},
		{"INSERT INTO t (a,b) VALUES (?, ?)", "INSERT INTO t (a,b) VALUES ($1, $2)"},
		{"WHERE name = 'it''s ?' AND x = ?", "WHERE name = 'it''s ?' AND x = $1"},
		{`WHERE name = "a?" AND y = ?`, `WHERE name = "a?" AND y = $1`},
		{"SELECT '?', ?", "SELECT '?', $1"},
		{"UPDATE t SET x=? WHERE id=?", "UPDATE t SET x=$1 WHERE id=$2"},
	}
	for _, c := range cases {
		got := rewritePlaceholders(c.in)
		if got != c.want {
			t.Errorf("rewritePlaceholders(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
