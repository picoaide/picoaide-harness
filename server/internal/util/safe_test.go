package util

import (
	"regexp"
	"testing"
)

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

func TestPresetIDPattern(t *testing.T) {
	re := regexp.MustCompile(PresetIDPattern)
	cases := []struct {
		in   string
		want bool
	}{
		{"coding-agent", true},
		{"v1", true},
		{"a-b-c-9", true},
		{"", false},
		{"Coding-Agent", false},
		{"_underscore", false},
		{"with space", false},
		{"a/b", false},
		{"a\\b", false},
		{"-leading", false},
		{"trailing-", true},
	}
	for _, c := range cases {
		if got := re.MatchString(c.in); got != c.want {
			t.Errorf("PresetIDPattern(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}
