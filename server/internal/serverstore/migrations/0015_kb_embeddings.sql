-- 0015: chunk vector embeddings (B2). One L2-normalized float32 vector per
-- chunk, produced by the gateway /v1/embeddings route (kb.embedding_model
-- setting). kb_search fuses lexical (trigram) and vector candidates with
-- RRF when embeddings exist; chunks without embeddings degrade to lexical.
-- Deleting a chunk cascades its embedding row away.
CREATE TABLE kb_chunk_embeddings (
  chunk_id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector BLOB NOT NULL,
  updated_at DATETIME DEFAULT (datetime('now','localtime'))
);
CREATE INDEX kb_ce_doc ON kb_chunk_embeddings(doc_id);
CREATE TRIGGER kb_ce_cleanup AFTER DELETE ON kb_chunks BEGIN DELETE FROM kb_chunk_embeddings WHERE chunk_id = old.id; END;
