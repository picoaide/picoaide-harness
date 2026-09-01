package skillmanifest

import (
	"errors"
	"strings"
	"testing"
)

// TestStatusFor covers the validation-code → HTTP status mapping. Per the
// package contract every validation failure is 422 (425 vs 409 handling is
// the callers' domain); the switch exists as a single table for that mapping.
func TestStatusFor(t *testing.T) {
	codes := []string{
		CodeMissingField, CodeInvalidAppID, CodeInvalidVersion, CodeFieldTooLong,
		CodeFieldTooShort, CodeInvalidType, CodeIdentityMismatch, CodeBOMDetected,
		CodeFrontmatterInvalid, CodeBodyEmpty, CodeInvocationInvalid,
		CodeProvenanceForbidden, CodeManifestMismatch,
	}
	for _, code := range codes {
		if got := StatusFor(code); got != 422 {
			t.Errorf("StatusFor(%q) = %d, want 422", code, got)
		}
	}
	if got := StatusFor("UNKNOWN_CODE"); got != 422 {
		t.Errorf("StatusFor(unknown) = %d, want 422", got)
	}
}

// TestErrorFormatting covers the Error value's user-facing text: field-scoped
// and global forms, plus the code-first stable prefix.
func TestErrorFormatting(t *testing.T) {
	e := newErr(CodeMissingField, "name", "缺少 %s", "name")
	if e.Error() != "MISSING_FIELD[name]: 缺少 name" {
		t.Errorf("field error = %q", e.Error())
	}
	g := newErr(CodeBOMDetected, "", "BOM")
	if g.Error() != "BOM_DETECTED: BOM" {
		t.Errorf("global error = %q", g.Error())
	}
	// errors.As/Is compatibility.
	var target *Error
	if !errors.As(e, &target) {
		t.Fatal("newErr must produce *Error")
	}
	if !strings.Contains(target.Error(), "MISSING_FIELD") {
		t.Errorf("code prefix missing: %q", target.Error())
	}
}

// TestParseAgentValid: preset.yml is the identity file for agents — title
// wins as the display name, name is the fallback, version/description/
// author/category are required.
func TestParseAgentValid(t *testing.T) {
	m, err := ParseAgent([]string{"preset.yml"}, `
title: "分析助手"
name: "analyzer"
version: "2.1.0"
description: "用于代码分析的助手,足够长的描述文本满足最少字数要求。"
author: "QA"
category: "编程"
`, "my-agent")
	if err != nil {
		t.Fatalf("ParseAgent: %v", err)
	}
	if m.AppID != "my-agent" {
		t.Errorf("AppID = %q", m.AppID)
	}
	if m.Title != "分析助手" {
		t.Errorf("Title = %q", m.Title)
	}
	if m.Version != "2.1.0" {
		t.Errorf("Version = %q", m.Version)
	}
	if m.Author != "QA" || m.Category != "编程" {
		t.Errorf("Author/Category = %q/%q", m.Author, m.Category)
	}
}

// TestParseAgentNameFallback: without a title, upstream's name is the
// display name (never a second ID field).
func TestParseAgentNameFallback(t *testing.T) {
	m, err := ParseAgent([]string{"preset.yml"}, `
name: "fallback-name"
version: "1.0.0"
description: "这是足够长的描述文本,用于回退路径的校验。"
author: "a"
category: "通用"
`, "agent-x")
	if err != nil {
		t.Fatalf("ParseAgent: %v", err)
	}
	if m.Title != "fallback-name" {
		t.Errorf("Title = %q, want fallback-name", m.Title)
	}
}

// TestParseAgentErrors: BOM, missing content, invalid YAML, and a too-short
// description must each produce the expected code.
func TestParseAgentErrors(t *testing.T) {
	bom := "\ufeff" + "name: x\nversion: 1.0.0\ndescription: 足够长的描述文本至少二十个字符。\nauthor: a\ncategory: c\n"
	if _, err := ParseAgent(nil, bom, "a"); err == nil || err.(*Error).Code != CodeBOMDetected {
		t.Errorf("BOM err = %v", err)
	}
	if _, err := ParseAgent(nil, "", "a"); err == nil || err.(*Error).Code != CodeMissingField {
		t.Errorf("empty err = %v", err)
	}
	if _, err := ParseAgent(nil, "{}", "a"); err == nil || err.(*Error).Code != CodeMissingField {
		t.Errorf("{} err = %v", err)
	}
	if _, err := ParseAgent(nil, "- not\n- a\n- mapping\n", "a"); err == nil || err.(*Error).Code != CodeFrontmatterInvalid {
		t.Errorf("list err = %v", err)
	}
	if _, err := ParseAgent(nil, `
name: x
version: 1.0.0
description: "短"
author: a
category: c
`, "a"); err == nil || err.(*Error).Code != CodeFieldTooShort {
		t.Errorf("short desc err = %v", err)
	}
	if _, err := ParseAgent(nil, `
name: x
version: 1.0.0
description: 足够长的描述文本至少二十个字符才能通过校验。
author: a
`, "a"); err == nil || err.(*Error).Code != CodeMissingField {
		t.Errorf("missing category err = %v", err)
	}
}
