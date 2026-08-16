package knowledge

import (
	"strings"
	"unicode"
)

// contentScoreWindow caps the content window used for lexical scoring: a
// document can hold up to 1MB, but relevance only needs a bounded prefix
// (the FTS MATCH already proved the query terms appear).
const contentScoreWindow = 2000

// fineTokens splits text into fine-grained tokens: CJK runs become single
// runes, latin/digit runs become lowercased words, everything else is a
// separator (RAGFlow fine_grained_tokenize). No word segmentation needed.
func fineTokens(s string) []string {
	var out []string
	var latin []rune
	flush := func() {
		if len(latin) > 0 {
			out = append(out, strings.ToLower(string(latin)))
			latin = latin[:0]
		}
	}
	for _, r := range s {
		switch {
		case unicode.Is(unicode.Han, r):
			flush()
			out = append(out, string(r))
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			latin = append(latin, r)
		default:
			flush()
		}
	}
	flush()
	return out
}

// grams builds unigram/bigram sets from fine-grained tokens.
func grams(tokens []string) (uni, bi map[string]bool) {
	uni = make(map[string]bool, len(tokens))
	for _, t := range tokens {
		uni[t] = true
	}
	bi = make(map[string]bool)
	for i := 1; i < len(tokens); i++ {
		bi[tokens[i-1]+tokens[i]] = true
	}
	return uni, bi
}

// jaccard returns |a∩b|/|a∪b| in [0,1]; 0 when either set is empty.
func jaccard(a, b map[string]bool) float64 {
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	inter, union := 0, len(b)
	for k := range a {
		if b[k] {
			inter++
		} else {
			union++
		}
	}
	if union == 0 {
		return 0
	}
	return float64(inter) / float64(union)
}

// lexicalSim scores text against a query with RAGFlow-style weighted
// Jaccard on fine-grained unigrams (0.4) and bigrams (0.6), in [0,1].
// Bigrams capture adjacency (报销政策 vs 政策报销), unigrams tolerate
// word-order drift; both are tokenizer-agnostic for CJK.
type lexicalSim struct {
	uni, bi map[string]bool
}

func newLexicalSim(query string) *lexicalSim {
	u, b := grams(fineTokens(query))
	return &lexicalSim{uni: u, bi: b}
}

// similarity returns query-vs-document relevance in [0,1]: content window
// 60% + title 40% (title weighting), 0 when nothing matches. The content
// window is anchored at the first query-term occurrence so hits deep in a
// long document still score (a fixed prefix window would give them 0).
func (l *lexicalSim) similarity(title, content string) float64 {
	if len(l.uni) == 0 {
		return 0
	}
	score := func(text string) float64 {
		u, b := grams(fineTokens(text))
		return 0.4*jaccard(l.uni, u) + 0.6*jaccard(l.bi, b)
	}
	return 0.6*score(contentWindow(content, l)) + 0.4*score(title)
}

// contentWindow returns the scoring window of a document body: a segment
// around the first occurrence of any query unigram, or the leading
// contentScoreWindow runes when nothing matches.
func contentWindow(content string, l *lexicalSim) string {
	runes := []rune(content)
	if len(runes) <= contentScoreWindow {
		return content
	}
	first := -1
	for i, r := range runes {
		if l.uni[string(r)] {
			first = i
			break
		}
	}
	if first < 0 {
		return string(runes[:contentScoreWindow])
	}
	start := first - contentScoreWindow/4
	if start < 0 {
		start = 0
	}
	end := start + contentScoreWindow
	if end > len(runes) {
		end = len(runes)
	}
	return string(runes[start:end])
}
