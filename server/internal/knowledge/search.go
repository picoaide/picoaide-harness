package knowledge

import (
	"database/sql"
	"fmt"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// SearchResult is one knowledge base hit.
type SearchResult struct {
	ID          int64   `json:"id"`
	FolderID    int64   `json:"folder_id"`
	Title       string  `json:"title"`
	Content     string  `json:"content"`
	ContentType string  `json:"content_type"`
	Size        int64   `json:"size"`
	Source      string  `json:"source"`
	CreatedBy   string  `json:"created_by"`
	Score       float64 `json:"score"` // lexical relevance in [0,1]
}

// sanitizeWord strips FTS5 syntax characters and control chars so a raw
// query word can never break out of a quoted phrase or alter the query.
func sanitizeWord(w string) string {
	return strings.Map(func(r rune) rune {
		if strings.ContainsRune("\"*():%_\\", r) || unicode.IsControl(r) {
			return -1
		}
		return r
	}, w)
}

// Search queries the knowledge base for docs the user can access.
//
// Two tokenizers back the index (migration 0013): trigram matches any
// substring >= 3 runes (CJK-safe); unicode61 prefix matches token-initial
// words of any length. Query words are dispatched by length — >= 3 runes
// go to the trigram index, 1-2 rune words to the unicode61 prefix index
// plus a LIKE fallback (trigram needs 3 runes). Candidates are then
// re-scored in Go with weighted Jaccard similarity (lexical.go) and
// ordered by relevance; pagination and totals are computed in memory.
func Search(db *sql.DB, username string, groups []string, query string, page, pageSize int) ([]SearchResult, int64, error) {
	folders, err := serverstore.GetAccessibleFolderIDs(db, username, groups)
	if err != nil {
		return nil, 0, err
	}
	if len(folders) == 0 {
		// 零可访问文件夹:空集早退(审计2026-L1,不依赖驱动的空 IN () 宽容)
		return []SearchResult{}, 0, nil
	}
	return searchInFolders(db, folders, query, page, pageSize)
}

// SearchAll searches every folder (admin preview).
func SearchAll(db *sql.DB, query string, page, pageSize int) ([]SearchResult, int64, error) {
	folders, err := serverstore.ListKBFolders(db)
	if err != nil {
		return nil, 0, err
	}
	ids := make([]int64, 0, len(folders)+1)
	ids = append(ids, 0) // global root
	for _, f := range folders {
		ids = append(ids, f.ID)
	}
	return searchInFolders(db, ids, query, page, pageSize)
}

func searchInFolders(db *sql.DB, folders []int64, query string, page, pageSize int) ([]SearchResult, int64, error) {
	if page < 1 {
		page = 1
	}
	if pageSize <= 0 {
		pageSize = 20
	}
	if pageSize > 100 {
		pageSize = 100
	}

	var words []string
	for _, w := range strings.Fields(query) {
		if w = sanitizeWord(w); w != "" {
			words = append(words, w)
		}
	}
	if len(words) == 0 {
		return []SearchResult{}, 0, nil
	}

	// Dispatch by rune length: >= 3 runes can ride the trigram index;
	// shorter words fall back to unicode61 prefix + LIKE.
	var longWords, shortWords []string
	for _, w := range words {
		if utf8.RuneCountInString(w) >= 3 {
			longWords = append(longWords, w)
		} else {
			shortWords = append(shortWords, w)
		}
	}

	// ponytail: folder list is small; IN (...) built from placeholders
	in := strings.TrimSuffix(strings.Repeat("?,", len(folders)), ",")
	conds := make([]string, 0, 2)
	args := make([]any, 0, len(folders)+2)
	for _, f := range folders {
		args = append(args, f)
	}
	if len(longWords) > 0 {
		// trigram substrings AND-combined: `"a" "b"` requires both.
		fts := make([]string, len(longWords))
		for i, w := range longWords {
			fts[i] = `"` + w + `"`
		}
		conds = append(conds, "d.id IN (SELECT rowid FROM kb_fts_trigram WHERE kb_fts_trigram MATCH ?)")
		args = append(args, strings.Join(fts, " "))
	}
	if len(shortWords) > 0 {
		// unicode61 prefix (indexed, token-initial) OR LIKE (mid-token).
		// LIKE has no index on %w%, but trigram needs >= 3 runes so this
		// bounded fallback is the only mid-token path for short words.
		prefix := make([]string, len(shortWords))
		for i, w := range shortWords {
			prefix[i] = `"` + w + `"*`
		}
		like := make([]string, 0, len(shortWords))
		likeArgs := make([]any, 0, len(shortWords)*2)
		for _, w := range shortWords {
			like = append(like, "(d.title LIKE ? OR d.content LIKE ?)")
			likeArgs = append(likeArgs, "%"+w+"%", "%"+w+"%")
		}
		conds = append(conds, "(d.id IN (SELECT rowid FROM kb_fts WHERE kb_fts MATCH ?) OR "+strings.Join(like, " AND ")+")")
		// placeholder order: MATCH first, LIKE args after
		args = append(args, strings.Join(prefix, " "))
		args = append(args, likeArgs...)
	}
	where := fmt.Sprintf("d.folder_id IN (%s) AND d.status = 'ready' AND %s", in, strings.Join(conds, " AND "))

	// Candidate generation is SQL; ranking is Go. Fetch every matching doc
	// (a few thousand at most), score, sort, page in memory — one pass, no
	// separate COUNT, ordering and totals always agree.
	rows, err := db.Query(`SELECT d.id, d.folder_id, d.title, d.content, d.content_type, d.size, d.source, d.created_by
		FROM kb_documents d WHERE `+where+` ORDER BY d.id`, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	all := make([]SearchResult, 0, 64)
	for rows.Next() {
		var r SearchResult
		if err := rows.Scan(&r.ID, &r.FolderID, &r.Title, &r.Content, &r.ContentType, &r.Size, &r.Source, &r.CreatedBy); err != nil {
			return nil, 0, err
		}
		all = append(all, r)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	if len(all) == 0 {
		return []SearchResult{}, 0, nil
	}

	qsim := newLexicalSim(strings.Join(words, " "))
	for i := range all {
		all[i].Score = qsim.similarity(all[i].Title, all[i].Content)
	}
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].Score != all[j].Score {
			return all[i].Score > all[j].Score
		}
		return all[i].ID < all[j].ID
	})

	total := int64(len(all))
	start := (page - 1) * pageSize
	if start >= len(all) {
		return []SearchResult{}, total, nil
	}
	end := start + pageSize
	if end > len(all) {
		end = len(all)
	}
	return all[start:end], total, nil
}
