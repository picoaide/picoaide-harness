package knowledge

import (
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

func TestFineTokenize(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"差旅费报销", []string{"差", "旅", "费", "报", "销"}},
		{"policy", []string{"policy"}},
		{"报销 policy", []string{"报", "销", "policy"}},
		{"Abc Def", []string{"abc", "def"}},
		{"", nil},
	}
	for _, c := range cases {
		got := fineTokens(c.in)
		if len(got) != len(c.want) {
			t.Fatalf("fineTokens(%q) = %v, want %v", c.in, got, c.want)
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Fatalf("fineTokens(%q)[%d] = %q, want %q", c.in, i, got[i], c.want[i])
			}
		}
	}
}

func TestLexicalSimilarity(t *testing.T) {
	q := newLexicalSim("知识")
	if s := q.similarity("知识问答", "知识问答的内容"); s <= 0 {
		t.Fatalf("relevant doc scored %f, want > 0", s)
	}
	if s := q.similarity("手册知识", "手册知识"); s <= 0 {
		t.Fatalf("mid-token doc scored %f, want > 0", s)
	}
	if s := q.similarity("完全无关", "完全无关的内容"); s != 0 {
		t.Fatalf("irrelevant doc scored %f, want 0", s)
	}
	// shorter doc containing the exact phrase outranks a long doc with one mention
	longDoc := q.similarity("手册知识", "这是一段很长的内容包含知识这个词语其余都是无关内容")
	shortDoc := q.similarity("手册知识", "知识手册")
	if shortDoc <= longDoc {
		t.Fatalf("short exact doc %f should outrank long doc %f", shortDoc, longDoc)
	}
	// title matching weighs in: identical content, matching title ranks higher
	a := q.similarity("知识手册", "一篇关于操作流程的文档")
	b := q.similarity("操作手册", "一篇关于操作流程的文档")
	if a <= b {
		t.Fatalf("title match %f should outrank title miss %f", a, b)
	}
}

func TestLexicalDeepHitWindow(t *testing.T) {
	// a query term 10k+ runes into a long doc must still score (window is
	// anchored at the first occurrence, not the prefix)
	lead := strings.Repeat("无关填充内容。", 2000)
	doc := lead + "客户满意度调研报告的核心结论"
	q := newLexicalSim("客户满意度")
	if s := q.similarity("标题", doc); s <= 0 {
		t.Fatalf("deep hit scored 0 (window miss): %f", s)
	}
	if s := q.similarity("标题", lead+"完全没有相关内容"); s != 0 {
		t.Fatalf("no-hit doc scored %f, want 0", s)
	}
}

// A2-era recall guarantee: a query whose characters sit mid-token of a CJK
// run (unicode61 sees one big token, prefix match fails) must still recall
// via the trigram index.
func TestTrigramMidTokenRecall(t *testing.T) {
	db := kbDB(t)
	folder, err := serverstore.CreateKBFolder(db, "alice-docs", 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantFolderUser(db, folder, "alice"); err != nil {
		t.Fatal(err)
	}
	id, err := serverstore.CreateKBDocument(db, folder, "差旅费报销政策及流程说明",
		"2024年企业差旅费报销政策及流程说明,适用于全体员工", "text", 0, "upload", "alice")
	if err != nil {
		t.Fatal(err)
	}
	// "报销政策" is 4 runes: trigram MATCH path (unicode61 prefix cannot
	// match mid-token, so this test fails before migration 0013).
	res, total, err := Search(db, "alice", nil, "报销政策", 1, 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if total != 1 || len(res) != 1 || res[0].ID != id {
		t.Fatalf("mid-token trigram recall: total=%d res=%v, want doc %d", total, res, id)
	}
	if res[0].Score <= 0 {
		t.Fatalf("hit scored %f, want > 0", res[0].Score)
	}
}

// Short (1-2 rune) words fall back to the unicode61 prefix index + LIKE;
// they must AND with long (trigram) words in the same query.
func TestSearchMixedWordLengths(t *testing.T) {
	db := kbDB(t)
	folder, err := serverstore.CreateKBFolder(db, "alice-docs", 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantFolderUser(db, folder, "alice"); err != nil {
		t.Fatal(err)
	}
	both, err := serverstore.CreateKBDocument(db, folder, "报销制度", "差旅费报销政策及流程说明", "text", 0, "upload", "alice")
	if err != nil {
		t.Fatal(err)
	}
	onlyShort, err := serverstore.CreateKBDocument(db, folder, "报销单据规范", "报销单据粘贴与审核规范", "text", 0, "upload", "alice")
	if err != nil {
		t.Fatal(err)
	}
	res, total, err := Search(db, "alice", nil, "报销 流程说明", 1, 10)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if total != 1 || len(res) != 1 || res[0].ID != both {
		t.Fatalf("mixed-length AND: total=%d res=%v, want only doc %d (not %d)", total, res, both, onlyShort)
	}
}

// Hits are ranked by lexical relevance (score desc), ties broken by id.
// A short doc whose only mention is mid-token (LIKE-only path) can outrank
// docs the prefix index matched — relevance beats index provenance.
func TestSearchOrderingByRelevance(t *testing.T) {
	db := kbDB(t)
	aliceFolder, _ := seedDocs(t, db)
	for i := 0; i < 5; i++ {
		if _, err := serverstore.CreateKBDocument(db, aliceFolder,
			"公共文档", "知识内容", "text", 0, "upload", "alice"); err != nil {
			t.Fatal(err)
		}
	}
	likeID, err := serverstore.CreateKBDocument(db, aliceFolder, "手册知识", "手册知识", "text", 0, "upload", "alice")
	if err != nil {
		t.Fatal(err)
	}
	res, total, err := Search(db, "alice", nil, "知识", 1, 20)
	if err != nil {
		t.Fatal(err)
	}
	if total != 7 || len(res) != 7 {
		t.Fatalf("total=%d len=%d, want 7/7", total, len(res))
	}
	if res[0].ID != likeID {
		t.Fatalf("first hit = %d, want like-only doc %d", res[0].ID, likeID)
	}
	prev := 1.0
	for _, r := range res {
		if r.Score > prev {
			t.Fatalf("score not descending: %f > %f (doc %d)", r.Score, prev, r.ID)
		}
		prev = r.Score
	}
	seen := map[int64]bool{}
	for _, r := range res {
		if seen[r.ID] {
			t.Fatalf("doc %d duplicated", r.ID)
		}
		seen[r.ID] = true
	}
}
