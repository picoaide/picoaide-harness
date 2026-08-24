// Package util provides shared helpers for the picoaide server.
package util

import "strings"

// SafePathSegment reports whether s can be used as a single path segment:
// non-empty, contains no separators, and is not "." or "..".
func SafePathSegment(s string) bool {
	if s == "" || s == "." || s == ".." {
		return false
	}
	if strings.ContainsAny(s, "/\\") {
		return false
	}
	return true
}

// PresetIDPattern matches an agent preset id: the lower-case id used as the
// preset directory name, mirroring the upstream dsh-agent-presets PRESET_ID.
const PresetIDPattern = `^[a-z0-9][a-z0-9-]*$`
