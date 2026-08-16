-- 0014: passage-level chunks (A2). A document is split into ~800-rune
-- chunks with title-path tracking; kb_chunks_fts (trigram) indexes each
-- chunk so search returns the relevant passage instead of a whole doc.
-- Chunks are replaced wholesale on create/update (atomic tx in store).
CREATE TABLE kb_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  title_path TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  char_start INTEGER NOT NULL DEFAULT 0,
  char_end INTEGER NOT NULL DEFAULT 0,
  UNIQUE(doc_id, seq)
);
CREATE INDEX kb_chunks_doc ON kb_chunks(doc_id);
CREATE VIRTUAL TABLE kb_chunks_fts USING fts5(title_path, content, content='kb_chunks', content_rowid='id', tokenize='trigram');
CREATE TRIGGER kb_chunk_ai AFTER INSERT ON kb_chunks BEGIN INSERT INTO kb_chunks_fts(rowid, title_path, content) VALUES (new.id, new.title_path, new.content); END;
CREATE TRIGGER kb_chunk_ad AFTER DELETE ON kb_chunks BEGIN INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, title_path, content) VALUES('delete', old.id, old.title_path, old.content); END;
CREATE TRIGGER kb_chunk_au AFTER UPDATE ON kb_chunks BEGIN INSERT INTO kb_chunks_fts(kb_chunks_fts, rowid, title_path, content) VALUES('delete', old.id, old.title_path, old.content); INSERT INTO kb_chunks_fts(rowid, title_path, content) VALUES (new.id, new.title_path, new.content); END;
-- any document delete (admin API, cleanup) cascades to chunks + chunk FTS
CREATE TRIGGER kb_chunk_cleanup AFTER DELETE ON kb_documents BEGIN DELETE FROM kb_chunks WHERE doc_id = old.id; END;
