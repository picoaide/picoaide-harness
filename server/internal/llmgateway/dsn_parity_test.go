package llmgateway

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// dsnCorpusEntry 是 testdata/dsn_corpus.json 的一行。
type dsnCorpusEntry struct {
	DSN     string                   `json:"dsn"`
	Verdict ErrorReportingDSNVerdict `json:"verdict"`
	Message string                   `json:"message"`
	Note    string                   `json:"note"`
}

type dsnCorpusFile struct {
	Comment string           `json:"_comment"`
	Cases   []dsnCorpusEntry `json:"cases"`
}

// dsnCorpusPath 是语料真源(与 webadmin 的 src/lib/dsn.corpus.test.ts 共用)。
func dsnCorpusPath() string {
	return filepath.Join("testdata", "dsn_corpus.json")
}

// loadErrorReportingDSNCorpus 读取跨语言对拍语料。
func loadErrorReportingDSNCorpus(t *testing.T) []dsnCorpusEntry {
	t.Helper()
	raw, err := os.ReadFile(dsnCorpusPath())
	if err != nil {
		t.Fatalf("read dsn corpus: %v", err)
	}
	var parsed dsnCorpusFile
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("parse dsn corpus: %v", err)
	}
	if len(parsed.Cases) == 0 {
		t.Fatal("dsn corpus is empty")
	}
	return parsed.Cases
}

// TestDSNCorpus 是跨语言对拍的 Go 侧一半:遍历 testdata/dsn_corpus.json,
// 断言 Go 权威实现(ValidateErrorReportingDSN / InspectErrorReportingDSN)的
// 结论与**文案**都逐字命中语料。
//
// 对拍的意义:webadmin 侧 src/lib/dsn.corpus.test.ts 读**同一份** JSON。任一侧
// 规则漂移(例如有人为 loopback 放行、或改了中文文案)都会让对侧变红 —— 这正是
// P0-2 与 P0-1 必须"逐字一致"的机械化保证(范式同
// serverstore/audit_r4_url_parity_test.go 的 TestConnectorBlockedNetworksMatchClientOutbound)。
func TestDSNCorpus(t *testing.T) {
	cases := loadErrorReportingDSNCorpus(t)
	counts := map[ErrorReportingDSNVerdict]int{}
	for _, tc := range cases {
		name := tc.DSN
		if name == "" {
			name = "<empty>"
		}
		t.Run(name, func(t *testing.T) {
			got := InspectErrorReportingDSN(tc.DSN)
			if got.Verdict != tc.Verdict {
				t.Fatalf("verdict = %s, want %s (note: %s)", got.Verdict, tc.Verdict, tc.Note)
			}
			if got.Message != tc.Message {
				t.Fatalf("message = %q, want %q (note: %s)", got.Message, tc.Message, tc.Note)
			}
			// ValidateErrorReportingDSN 是 handler 用的薄封装,结论必须一致。
			err := ValidateErrorReportingDSN(tc.DSN)
			switch tc.Verdict {
			case ErrorReportingDSNReject:
				if err == nil || err.Error() != tc.Message {
					t.Fatalf("ValidateErrorReportingDSN = %v, want error %q", err, tc.Message)
				}
			default:
				if err != nil {
					t.Fatalf("ValidateErrorReportingDSN = %v, want nil for verdict %s", err, tc.Verdict)
				}
			}
		})
		counts[tc.Verdict]++
	}
	// 语料必须三类齐全,否则"对拍"会退化成只测一类。
	for _, want := range []ErrorReportingDSNVerdict{ErrorReportingDSNAccept, ErrorReportingDSNWarn, ErrorReportingDSNReject} {
		if counts[want] == 0 {
			t.Fatalf("dsn corpus has no %s case: %v", want, counts)
		}
	}
	t.Logf("dsn corpus verdict counts: %v (total %d)", counts, len(cases))
}
