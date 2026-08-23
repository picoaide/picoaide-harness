package util

import "testing"

func TestSafePathSegment(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"ppt-gen", true},
		{"ppt-gen-v1.2", true},
		{"demo_skill", true},
		{"", false},
		{".", false},
		{"..", false},
		{"a/b", false},
		{"a\\b", false},
		{"/etc/passwd", false},
		{"../x", false},
		{"a b", true},
	}
	for _, c := range cases {
		if got := SafePathSegment(c.in); got != c.want {
			t.Errorf("SafePathSegment(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}
