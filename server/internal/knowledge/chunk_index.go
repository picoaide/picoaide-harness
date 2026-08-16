package knowledge

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ChunkResult is one passage-level knowledge base hit.
type ChunkResult struct {
	ChunkID   int64   `json:"chunk_id"`
	DocID     int64   `json:"doc_id"`
	FolderID  int64   `json:"folder_id"`
	Title     string  `json:"title"`
	TitlePath string  `json:"title_path"`
	Seq       int64   `json:"seq"`
	CharStart int64   `json:"char_start"`
	Content   string  `json:"content"`
	Score     float64 `json:"score"` // lexical relevance in [0,1]
}

// ChunkDocument chunks a document's content and replaces its chunks. All
// content finalization paths (create/update/queue-complete/retry) go
// through this so chunks never drift from kb_documents.
func ChunkDocument(db *sql.DB, docID int64, content string) error {
	return serverstore.ReplaceChunks(db, docID, ChunkText(content))
}

// BackfillChunks chunks every ready document that has no chunks yet
// (pre-0014 documents). Idempotent; run once at startup.
func BackfillChunks(db *sql.DB) error {
	rows, err := db.Query(`SELECT d.id, d.content FROM kb_documents d
		WHERE d.status = 'ready' AND NOT EXISTS (SELECT 1 FROM kb_chunks c WHERE c.doc_id = d.id)`)
	if err != nil {
		return err
	}
	var ids []int64
	var contents []string
	for rows.Next() {
		var id int64
		var content string
		if err := rows.Scan(&id, &content); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
		contents = append(contents, content)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for i, id := range ids {
		if err := serverstore.ReplaceChunks(db, id, ChunkText(contents[i])); err != nil {
			return err
		}
	}
	return nil
}

// SearchChunks queries the knowledge base at passage level and returns the
// chunks the user can access, ranked by hybrid relevance.
//
// Retrieval is two-stage: candidate generation (lexical trigram/unicode61
// as in search.go, plus a vector brute-force scan over chunk embeddings
// when one is configured) and Go-side fusion with Reciprocal Rank Fusion
// (k=60) — chunks both routes agree on rank first. When embeddings are
// unset or the upstream fails, the search degrades to pure lexical.
func SearchChunks(db *sql.DB, username string, groups []string, query string, page, pageSize int) ([]ChunkResult, int64, error) {
	folders, err := serverstore.GetAccessibleFolderIDs(db, username, groups)
	if err != nil {
		return nil, 0, err
	}
	return searchChunksInFolders(db, folders, query, page, pageSize)
}

// SearchChunksAll searches every folder (admin hit-test).
func SearchChunksAll(db *sql.DB, query string, page, pageSize int) ([]ChunkResult, int64, error) {
	folders, err := serverstore.ListKBFolders(db)
	if err != nil {
		return nil, 0, err
	}
	ids := make([]int64, 0, len(folders)+1)
	ids = append(ids, 0) // global root
	for _, f := range folders {
		ids = append(ids, f.ID)
	}
	return searchChunksInFolders(db, ids, query, page, pageSize)
}

// SearchMode reports whether the vector path is currently active ("hybrid")
// or the search is pure lexical ("lexical") — admin visibility for tuning.
func SearchMode(db *sql.DB) string {
	if currentEmbedder() == nil {
		return "lexical"
	}
	model, ok, err := GetEmbeddingModel(db)
	if err != nil || !ok || model == "" {
		return "lexical"
	}
	return "hybrid"
}

func searchChunksInFolders(db *sql.DB, folders []int64, query string, page, pageSize int) ([]ChunkResult, int64, error) {
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
		return []ChunkResult{}, 0, nil
	}

	lexical, err := lexicalCandidates(db, folders, words)
	if err != nil {
		return nil, 0, err
	}

	// vector path: optional; failures degrade to lexical
	var vecHits []vecHit
	if e := currentEmbedder(); e != nil {
		model, ok, serr := GetEmbeddingModel(db)
		if serr == nil && ok {
			if hits, verr := vectorHits(context.Background(), db, e, model, query, folders); verr == nil {
				vecHits = hits
			}
		}
	}
	if len(vecHits) == 0 {
		return pageChunkResults(lexical, page, pageSize)
	}

	// RRF fusion over the top candidates of each route
	type scored struct {
		chunkID int64
		score   float64
	}
	fused := map[int64]*scored{}
	addList := func(list []int64) {
		for rank, id := range list {
			s := fused[id]
			if s == nil {
				s = &scored{chunkID: id}
				fused[id] = s
			}
			s.score += 1.0 / (float64(rrfK) + float64(rank+1))
		}
	}
	lexRanked := make([]int64, 0, len(lexical))
	for i, r := range lexical {
		if i < embedVecTopK {
			lexRanked = append(lexRanked, r.ChunkID)
		}
	}
	vecRanked := make([]int64, 0, len(vecHits))
	for i, h := range vecHits {
		if i < embedVecTopK {
			vecRanked = append(vecRanked, h.chunkID)
		}
	}
	addList(lexRanked)
	addList(vecRanked)
	order := make([]*scored, 0, len(fused))
	for _, s := range fused {
		order = append(order, s)
	}
	sort.Slice(order, func(i, j int) bool {
		if order[i].score != order[j].score {
			return order[i].score > order[j].score
		}
		return order[i].chunkID < order[j].chunkID
	})
	// normalize RRF to [0,1] for display (top score = 1.0)
	maxScore := 0.0
	if len(order) > 0 {
		maxScore = order[0].score
	}

	byID := make(map[int64]ChunkResult, len(lexical))
	for _, r := range lexical {
		byID[r.ChunkID] = r
	}
	var missing []int64
	for _, s := range order {
		if _, ok := byID[s.chunkID]; !ok {
			missing = append(missing, s.chunkID)
		}
	}
	if len(missing) > 0 {
		rows, err := chunkResultRowsByIDs(db, missing)
		if err != nil {
			return nil, 0, err
		}
		for _, r := range rows {
			byID[r.ChunkID] = r
		}
	}
	all := make([]ChunkResult, 0, len(order))
	for _, s := range order {
		r, ok := byID[s.chunkID]
		if !ok {
			continue // chunk deleted between retrieval and fusion
		}
		if maxScore > 0 {
			r.Score = s.score / maxScore
		} else {
			r.Score = 0
		}
		all = append(all, r)
	}
	return pageChunkResults(all, page, pageSize)
}

// pageChunkResults slices scored results for the requested page.
func pageChunkResults(all []ChunkResult, page, pageSize int) ([]ChunkResult, int64, error) {
	total := int64(len(all))
	start := (page - 1) * pageSize
	if start >= len(all) {
		return []ChunkResult{}, total, nil
	}
	end := start + pageSize
	if end > len(all) {
		end = len(all)
	}
	return all[start:end], total, nil
}

// chunkResultRowsByIDs loads full chunk rows for a set of ids.
func chunkResultRowsByIDs(db *sql.DB, ids []int64) ([]ChunkResult, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	ph := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	rows, err := db.Query(`SELECT c.id, c.doc_id, c.seq, c.title_path, c.content, c.char_start, d.folder_id, d.title
		FROM kb_chunks c JOIN kb_documents d ON d.id = c.doc_id
		WHERE c.id IN (`+ph+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ChunkResult
	for rows.Next() {
		var r ChunkResult
		if err := rows.Scan(&r.ChunkID, &r.DocID, &r.Seq, &r.TitlePath, &r.Content, &r.CharStart, &r.FolderID, &r.Title); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// vecHit is one vector-route candidate.
type vecHit struct {
	chunkID int64
	score   float64 // cosine similarity in [-1,1]
}

// vectorHits brute-force scans chunk embeddings of accessible docs (capped
// by embedScanLimit, newest first) and returns the top embedVecTopK by
// cosine similarity. Stored vectors are L2-normalized, so cosine = dot.
// Rows with stale dims (model changed before reindex) are filtered in SQL.
func vectorHits(ctx context.Context, db *sql.DB, e Embedder, model, query string, folders []int64) ([]vecHit, error) {
	ctx, cancel := context.WithTimeout(ctx, vectorQueryTimeout)
	defer cancel()
	vecs, _, err := e.Embed(ctx, model, []string{query})
	if err != nil {
		return nil, errEmbedUpstream
	}
	q := normalize(vecs[0])

	in := strings.TrimSuffix(strings.Repeat("?,", len(folders)), ",")
	args := make([]any, 0, len(folders)+2)
	for _, f := range folders {
		args = append(args, f)
	}
	args = append(args, len(q))
	args = append(args, embedScanLimit)
	rows, err := db.Query(`SELECT e.chunk_id, e.vector, e.dims
		FROM kb_chunk_embeddings e JOIN kb_documents d ON d.id = e.doc_id
		WHERE d.folder_id IN (`+in+`) AND d.status = 'ready' AND e.dims = ?
		ORDER BY e.chunk_id DESC LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var hits []vecHit
	for rows.Next() {
		var id int64
		var raw []byte
		var dims int
		if err := rows.Scan(&id, &raw, &dims); err != nil {
			return nil, err
		}
		if dims != len(q) || len(raw) != dims*4 {
			continue // defensive: SQL filtered, but never trust the blob
		}
		v := decodeF32(raw)
		var dot float64
		for i := range q {
			dot += float64(q[i]) * float64(v[i])
		}
		hits = append(hits, vecHit{chunkID: id, score: dot})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(hits, func(i, j int) bool {
		if hits[i].score != hits[j].score {
			return hits[i].score > hits[j].score
		}
		return hits[i].chunkID < hits[j].chunkID
	})
	if len(hits) > embedVecTopK {
		hits = hits[:embedVecTopK]
	}
	return hits, nil
}

// lexicalCandidates runs the trigram/unicode61 candidate pipeline and
// ranks hits with Go-side lexical similarity (shared with Search).
func lexicalCandidates(db *sql.DB, folders []int64, words []string) ([]ChunkResult, error) {
	var longWords, shortWords []string
	for _, w := range words {
		if utf8.RuneCountInString(w) >= 3 {
			longWords = append(longWords, w)
		} else {
			shortWords = append(shortWords, w)
		}
	}

	in := strings.TrimSuffix(strings.Repeat("?,", len(folders)), ",")
	conds := make([]string, 0, 2)
	args := make([]any, 0, len(folders)+3)
	for _, f := range folders {
		args = append(args, f)
	}
	if len(longWords) > 0 {
		// chunk trigram MATCH, OR'd with the doc-level trigram index so a
		// query that only hits the doc title (or a part of the doc the
		// chunk boundaries missed) still recalls — kb_fts_trigram covers
		// title+content of every doc
		fts := make([]string, len(longWords))
		for i, w := range longWords {
			fts[i] = `"` + w + `"`
		}
		ftsMatch := strings.Join(fts, " ")
		conds = append(conds, `(c.id IN (SELECT rowid FROM kb_chunks_fts WHERE kb_chunks_fts MATCH ?)
			OR c.doc_id IN (SELECT rowid FROM kb_fts_trigram WHERE kb_fts_trigram MATCH ?))`)
		args = append(args, ftsMatch, ftsMatch)
	}
	if len(shortWords) > 0 {
		// doc-level unicode61 prefix narrows the candidate set cheaply;
		// LIKE covers mid-token short words inside a chunk or the doc title
		prefix := make([]string, len(shortWords))
		for i, w := range shortWords {
			prefix[i] = `"` + w + `"*`
		}
		like := make([]string, 0, len(shortWords))
		likeArgs := make([]any, 0, len(shortWords)*3)
		for _, w := range shortWords {
			like = append(like, "(c.title_path LIKE ? OR c.content LIKE ? OR d.title LIKE ?)")
			likeArgs = append(likeArgs, "%"+w+"%", "%"+w+"%", "%"+w+"%")
		}
		conds = append(conds, `(c.doc_id IN (SELECT rowid FROM kb_fts WHERE kb_fts MATCH ?) OR `+strings.Join(like, " AND ")+`)`)
		args = append(args, strings.Join(prefix, " "))
		args = append(args, likeArgs...)
	}
	where := fmt.Sprintf(`d.folder_id IN (%s) AND d.status = 'ready' AND %s`, in, strings.Join(conds, " AND "))

	rows, err := db.Query(`SELECT c.id, c.doc_id, c.seq, c.title_path, c.content, c.char_start, d.folder_id, d.title
		FROM kb_chunks c JOIN kb_documents d ON d.id = c.doc_id
		WHERE `+where+` ORDER BY c.id`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	all := make([]ChunkResult, 0, 64)
	for rows.Next() {
		var r ChunkResult
		if err := rows.Scan(&r.ChunkID, &r.DocID, &r.Seq, &r.TitlePath, &r.Content, &r.CharStart, &r.FolderID, &r.Title); err != nil {
			return nil, err
		}
		all = append(all, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(all) == 0 {
		return []ChunkResult{}, nil
	}

	qsim := newLexicalSim(strings.Join(words, " "))
	for i := range all {
		title := all[i].Title
		if all[i].TitlePath != "" {
			title += " " + all[i].TitlePath
		}
		all[i].Score = qsim.similarity(title, all[i].Content)
	}
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].Score != all[j].Score {
			return all[i].Score > all[j].Score
		}
		return all[i].ChunkID < all[j].ChunkID
	})
	return all, nil
}
