package serverstore

import (
	"database/sql"
	"errors"
	"strings"
)

// KBChunk is one passage-level chunk of a document (migration 0014).
// TitlePath carries the heading breadcrumb (第一章 > 第一条) so retrieval
// and targeted reads stay in context.
type KBChunk struct {
	ID        int64
	DocID     int64
	Seq       int64
	TitlePath string
	Content   string
	CharStart int64
	CharEnd   int64
}

// ReplaceChunks atomically replaces every chunk of a document. Used on
// create/update; the search path reads chunks only, so content and chunks
// never diverge.
func ReplaceChunks(db *sql.DB, docID int64, chunks []KBChunk) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec("DELETE FROM kb_chunks WHERE doc_id = ?", docID); err != nil {
		return err
	}
	for _, c := range chunks {
		c.DocID = docID
		if _, err := tx.Exec(`INSERT INTO kb_chunks (doc_id, seq, title_path, content, char_start, char_end)
			VALUES (?, ?, ?, ?, ?, ?)`, c.DocID, c.Seq, c.TitlePath, c.Content, c.CharStart, c.CharEnd); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// CountChunksByDoc returns the chunk count of a document.
func CountChunksByDoc(db *sql.DB, docID int64) (int64, error) {
	var n int64
	err := db.QueryRow("SELECT COUNT(*) FROM kb_chunks WHERE doc_id = ?", docID).Scan(&n)
	return n, err
}

// ListChunksByDoc returns the chunks of a document ordered by seq.
func ListChunksByDoc(db *sql.DB, docID int64) ([]KBChunk, error) {
	rows, err := db.Query(`SELECT id, doc_id, seq, title_path, content, char_start, char_end
		FROM kb_chunks WHERE doc_id = ? ORDER BY seq`, docID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []KBChunk
	for rows.Next() {
		var c KBChunk
		if err := rows.Scan(&c.ID, &c.DocID, &c.Seq, &c.TitlePath, &c.Content, &c.CharStart, &c.CharEnd); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// GetChunksByIDs returns chunks by id, ordered by input order. Missing ids
// are skipped (callers resolve permissions on the owning documents).
func GetChunksByIDs(db *sql.DB, ids []int64) ([]KBChunk, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, len(ids))
	for i, id := range ids {
		args[i] = id
	}
	rows, err := db.Query(`SELECT id, doc_id, seq, title_path, content, char_start, char_end
		FROM kb_chunks WHERE id IN (`+placeholders+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]KBChunk, 0, len(ids))
	for rows.Next() {
		var c KBChunk
		if err := rows.Scan(&c.ID, &c.DocID, &c.Seq, &c.TitlePath, &c.Content, &c.CharStart, &c.CharEnd); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// DocsMissingChunkEmbeddings returns ready documents whose chunks have no
// vectors yet (embedding backfill scan).
func DocsMissingChunkEmbeddings(db *sql.DB) ([]int64, error) {
	rows, err := db.Query(`SELECT DISTINCT c.doc_id FROM kb_chunks c
		JOIN kb_documents d ON d.id = c.doc_id
		LEFT JOIN kb_chunk_embeddings ce ON ce.chunk_id = c.id
		WHERE d.status = 'ready' AND ce.chunk_id IS NULL ORDER BY c.doc_id LIMIT 2000`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// NextDocMissingChunkEmbeddings returns one ready document missing chunk
// vectors (embedding loop), or ErrNotFound when nothing is pending.
func NextDocMissingChunkEmbeddings(db *sql.DB) (int64, error) {
	var id int64
	err := db.QueryRow(`SELECT c.doc_id FROM kb_chunks c
		JOIN kb_documents d ON d.id = c.doc_id
		LEFT JOIN kb_chunk_embeddings ce ON ce.chunk_id = c.id
		WHERE d.status = 'ready' AND ce.chunk_id IS NULL
		ORDER BY c.doc_id LIMIT 1`).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	return id, err
}

// CountChunksMissingEmbeddings returns how many chunks still lack vectors
// (embedding pipeline progress; -1 on query error is caller-handled).
func CountChunksMissingEmbeddings(db *sql.DB) (int64, error) {
	var n int64
	err := db.QueryRow(`SELECT COUNT(*) FROM kb_chunks c
		LEFT JOIN kb_chunk_embeddings ce ON ce.chunk_id = c.id
		WHERE ce.chunk_id IS NULL`).Scan(&n)
	return n, err
}

// ClearChunkEmbeddings deletes all chunk vectors (model change / reindex).
func ClearChunkEmbeddings(db *sql.DB) error {
	_, err := db.Exec("DELETE FROM kb_chunk_embeddings")
	return err
}

// CreateKBDocumentWithChunks creates a document and its chunks atomically.
func CreateKBDocumentWithChunks(db *sql.DB, folderID int64, title, content, contentType string, size int64, source, createdBy string, chunks []KBChunk) (int64, error) {
	tx, err := db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	res, err := tx.Exec(`INSERT INTO kb_documents (folder_id, title, content, content_type, size, source, created_by)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, folderID, title, content, contentType, size, source, createdBy)
	if err != nil {
		return 0, err
	}
	docID, err := res.LastInsertId()
	if err != nil {
		return 0, err
	}
	for _, c := range chunks {
		c.DocID = docID
		if _, err := tx.Exec(`INSERT INTO kb_chunks (doc_id, seq, title_path, content, char_start, char_end)
			VALUES (?, ?, ?, ?, ?, ?)`, c.DocID, c.Seq, c.TitlePath, c.Content, c.CharStart, c.CharEnd); err != nil {
			return 0, err
		}
	}
	return docID, tx.Commit()
}

// UpdateKBDocumentWithChunks overwrites title/content (size recomputed) and
// replaces chunks atomically; ErrNotFound when the id is missing.
func UpdateKBDocumentWithChunks(db *sql.DB, id int64, title, content, contentType string, chunks []KBChunk) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.Exec(`UPDATE kb_documents SET title = ?, content = ?, content_type = ?, size = ?
		WHERE id = ?`, title, content, contentType, len(content), id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	if _, err := tx.Exec("DELETE FROM kb_chunks WHERE doc_id = ?", id); err != nil {
		return err
	}
	for _, c := range chunks {
		c.DocID = id
		if _, err := tx.Exec(`INSERT INTO kb_chunks (doc_id, seq, title_path, content, char_start, char_end)
			VALUES (?, ?, ?, ?, ?, ?)`, c.DocID, c.Seq, c.TitlePath, c.Content, c.CharStart, c.CharEnd); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// AdoptKBDocumentEdit overwrites title/content (replacing chunks) and
// transitions a pending/error document to ready in one transaction — "edit
// takes over". After an adopt the row is ready, so the async queue can
// never clobber the edited content with the stale raw-file extraction; the
// caller removes the raw file accordingly (审计 H3).
func AdoptKBDocumentEdit(db *sql.DB, id int64, title, content, contentType string, chunks []KBChunk) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.Exec(`UPDATE kb_documents SET title = ?, content = ?, content_type = ?, size = ?,
		status = 'ready', error = '' WHERE id = ? AND status IN ('pending', 'processing', 'error')`,
		title, content, contentType, len(content), id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		// already ready: same write without the status transition
		if _, err := tx.Exec(`UPDATE kb_documents SET title = ?, content = ?, content_type = ?, size = ?
			WHERE id = ?`, title, content, contentType, len(content), id); err != nil {
			return err
		}
	}
	if _, err := tx.Exec("DELETE FROM kb_chunks WHERE doc_id = ?", id); err != nil {
		return err
	}
	for _, c := range chunks {
		c.DocID = id
		if _, err := tx.Exec(`INSERT INTO kb_chunks (doc_id, seq, title_path, content, char_start, char_end)
			VALUES (?, ?, ?, ?, ?, ?)`, c.DocID, c.Seq, c.TitlePath, c.Content, c.CharStart, c.CharEnd); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// CompleteKBDocumentWithChunks finishes an async upload with its chunks in
// one transaction; semantics match CompleteKBDocument (CAS on the claimed
// processing state).
func CompleteKBDocumentWithChunks(db *sql.DB, id int64, content, errMsg string, chunks []KBChunk) error {
	if errMsg == "" {
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		defer tx.Rollback()
		res, err := tx.Exec("UPDATE kb_documents SET content = ?, size = ?, status = 'ready', error = '' WHERE id = ? AND status = 'processing'", content, len(content), id)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return nil // already completed by another worker
		}
		if _, err := tx.Exec("DELETE FROM kb_chunks WHERE doc_id = ?", id); err != nil {
			return err
		}
		for _, c := range chunks {
			c.DocID = id
			if _, err := tx.Exec(`INSERT INTO kb_chunks (doc_id, seq, title_path, content, char_start, char_end)
				VALUES (?, ?, ?, ?, ?, ?)`, c.DocID, c.Seq, c.TitlePath, c.Content, c.CharStart, c.CharEnd); err != nil {
				return err
			}
		}
		return tx.Commit()
	}
	doc, err := GetKBDocument(db, id)
	if err != nil {
		return err
	}
	if doc.Status != "processing" && doc.Status != "pending" {
		return nil
	}
	_, err = db.Exec("UPDATE kb_documents SET status = 'error', error = ? WHERE id = ? AND status IN ('processing','pending')", errMsg, id)
	return err
}
