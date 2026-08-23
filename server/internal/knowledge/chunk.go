package knowledge

import (
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// Chunking parameters (calibrated from RAGFlow defaults for CJK, where
// 500-800 runes ≈ 128-256 tokens):
const (
	maxChunkRunes  = 800  // target chunk size; chunks flush before exceeding
	overlapRunes   = 100  // ~12.5% tail overlap between same-section chunks
	hardSplitRunes = 2000 // paragraphs above this split at sentence ends
	titleMaxRunes  = 60   // heading line length cap
	maxPathDepth   = 3    // title path levels (markdown # / 第X章 / 1.1)
)

// heading rules, coarsest to finest. Levels are 1-based path depth.
// Fine-grained rules carry per-rule length caps (below): numbered list
// items like "1. 检查电源线" must not become headings, so level-3 lines
// are only headings when very short.
var headingRules = []struct {
	re    *regexp.Regexp
	level int
	max   int
}{
	{regexp.MustCompile(`^第[0-9一二三四五六七八九十百千两]+[章节篇部]`), 1, 0},
	{regexp.MustCompile(`^[一二三四五六七八九十]+、`), 1, 0},
	// 第X条 headings require a separator and stay short: "第一条 适用范围"
	// is a heading, "第一条需求是支持多文件上传" is a full sentence
	{regexp.MustCompile(`^第[0-9一二三四五六七八九十百千两]+[条款项][ 、]`), 2, 16},
	{regexp.MustCompile(`^\d+\.\d+\s`), 2, 16},
	{regexp.MustCompile(`^[（(][一二三四五六七八九十0-9]+[）)]`), 2, 16},
	// numbered rule carries a length cap: short numbered lines are
	// headings, longer ones are list items
	{regexp.MustCompile(`^\d+[、.]\s`), 3, 12},
}

// headingLevel returns the path level of a heading line (0 = not a heading).
// Markdown # is handled separately (# count = level, capped at maxPathDepth).
func headingLevel(line string) int {
	if strings.HasPrefix(line, "#") {
		level := 0
		for _, r := range line {
			if r != '#' {
				break
			}
			level++
		}
		if level >= 1 && level <= 6 && len(line) > level && line[level] == ' ' {
			if level > maxPathDepth {
				level = maxPathDepth
			}
			return level
		}
		return 0
	}
	n := utf8.RuneCountInString(line)
	if n > titleMaxRunes {
		return 0
	}
	if r, _ := utf8.DecodeLastRuneInString(line); strings.ContainsRune("。；！？.!?", r) {
		return 0 // a full sentence is content, not a heading
	}
	for _, h := range headingRules {
		if h.max > 0 && n > h.max {
			continue
		}
		if h.re.MatchString(line) {
			return h.level
		}
	}
	return 0
}

// sentenceSplit splits an oversized paragraph at sentence ends (CJK and
// ASCII), keeping the delimiter; segments stay contiguous.
func sentenceSplit(line string) []string {
	var out []string
	var cur []rune
	flush := func() {
		if s := strings.TrimSpace(string(cur)); s != "" {
			out = append(out, s)
		}
		cur = cur[:0]
	}
	for _, r := range line {
		cur = append(cur, r)
		if strings.ContainsRune("。；！？.!?", r) {
			flush()
		}
	}
	flush()
	return out
}

func tailRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[len(r)-n:])
}

// ChunkText splits document text into passage chunks: paragraph-boundary
// first, ~800 runes per chunk with 100-rune overlap, heading breadcrumbs in
// TitlePath, oversized paragraphs hard-split at sentence ends (RAGFlow
// OVER_CAP: never slice mid-paragraph unless it exceeds hardSplitRunes).
// CharStart/CharEnd are rune offsets into the source text, overlap included.
func ChunkText(content string) []serverstore.KBChunk {
	content = strings.ReplaceAll(content, "\r\n", "\n")
	content = strings.ReplaceAll(content, "\r", "\n")

	var chunks []serverstore.KBChunk
	var path []string
	offset := 0 // rune offset: end of the last consumed line
	var parts []string
	curRunes := 0
	bufStart := 0

	flush := func() {
		if len(parts) == 0 {
			return
		}
		text := strings.Join(parts, "\n")
		// offset counts a phantom newline after the last consumed line;
		// the chunk text spans up to the last line's last rune
		end := offset - 1
		chunks = append(chunks, serverstore.KBChunk{
			Seq:       int64(len(chunks) + 1),
			TitlePath: strings.Join(path, " > "),
			Content:   text,
			CharStart: int64(bufStart),
			CharEnd:   int64(end),
		})
		// overlap: tail of the emitted chunk prefixes the next one, but only
		// within the same section (a heading clears the carry below)
		carry := tailRunes(text, overlapRunes)
		if carry == "" {
			parts = nil
			curRunes = 0
		} else {
			parts = []string{carry}
			curRunes = utf8.RuneCountInString(carry)
			// the carry starts (carryRunes) before the chunk end
			bufStart = end - utf8.RuneCountInString(carry)
		}
	}

	addUnit := func(unit string) {
		unit = strings.TrimSpace(unit)
		if unit == "" {
			return
		}
		sep := 0
		if len(parts) > 0 {
			sep = 1 // joining newline
		}
		u := utf8.RuneCountInString(unit)
		if len(parts) > 0 && curRunes+sep+u > maxChunkRunes {
			flush()
			sep = 0
			if len(parts) > 0 {
				sep = 1
			}
		}
		parts = append(parts, unit)
		curRunes += sep + u
	}

	inFence := false // markdown ``` code fence: no heading detection inside
	lines := strings.Split(content, "\n")
	for i, raw := range lines {
		line := strings.TrimSpace(raw)
		offset += utf8.RuneCountInString(line) + 1
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "```") {
			inFence = !inFence // toggle; fences always start a content line
			addUnit(line)
			continue
		}
		isHeading := false
		if !inFence {
			if lvl := headingLevel(line); lvl > 0 {
				isHeading = true
				// consecutive short numbered lines are a list, not a
				// heading cascade ("1. x\n2. y"): the first one only
				// becomes a heading when the next line is not numbered
				if lvl == 3 && i+1 < len(lines) {
					next := strings.TrimSpace(lines[i+1])
					if next != "" && headingLevel(next) == 3 {
						isHeading = false
					}
				}
			}
		}
		if isHeading {
			flush()
			// heading starts a new section: no overlap carry, path updated
			parts = nil
			curRunes = 0
			lvl := headingLevel(line)
			if lvl <= len(path) {
				path = path[:lvl-1]
			}
			path = append(path, strings.TrimSpace(strings.TrimLeft(line, "#")))
			bufStart = offset
			continue
		}
		if utf8.RuneCountInString(line) > hardSplitRunes {
			for _, seg := range sentenceSplit(line) {
				addUnit(seg)
			}
		} else {
			addUnit(line)
		}
	}
	flush()
	return chunks
}
