-- 0013: trigram FTS index for CJK substring search (A1).
-- unicode61 treats a CJK run as one token, so prefix queries only match
-- token-initial characters; trigram indexes every 3-char substring and
-- matches queries of >= 3 characters anywhere in the text. Short (1-2
-- rune) words keep the unicode61 prefix index + LIKE fallback (search.go
-- dispatches by word length). Keep both tables in sync via triggers.
CREATE VIRTUAL TABLE kb_fts_trigram USING fts5(title, content, content='kb_documents', content_rowid='id', tokenize='trigram');
INSERT INTO kb_fts_trigram(rowid, title, content) SELECT id, title, content FROM kb_documents;
CREATE TRIGGER kb_tri_ai AFTER INSERT ON kb_documents BEGIN INSERT INTO kb_fts_trigram(rowid, title, content) VALUES (new.id, new.title, new.content); END;
CREATE TRIGGER kb_tri_ad AFTER DELETE ON kb_documents BEGIN INSERT INTO kb_fts_trigram(kb_fts_trigram, rowid, title, content) VALUES('delete', old.id, old.title, old.content); END;
CREATE TRIGGER kb_tri_au AFTER UPDATE ON kb_documents BEGIN INSERT INTO kb_fts_trigram(kb_fts_trigram, rowid, title, content) VALUES('delete', old.id, old.title, old.content); INSERT INTO kb_fts_trigram(rowid, title, content) VALUES (new.id, new.title, new.content); END;
