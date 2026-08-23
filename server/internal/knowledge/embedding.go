package knowledge

import (
	"context"
	"database/sql"
	"encoding/binary"
	"errors"
	"log"
	"math"
	"sync"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// Embedder produces vectors for texts (llmgateway.Embedder satisfies it;
// tests inject fakes). A nil-returning error means the caller must degrade
// to lexical search.
type Embedder interface {
	Embed(ctx context.Context, model string, texts []string) ([][]float32, int64, error)
}

// EmbeddingModelSetting is the settings key holding the embedding model
// name (admin-configured; must be routed by a gateway channel).
const EmbeddingModelSetting = "kb.embedding_model"

const (
	embedBatchSize     = 32    // texts per upstream call
	embedScanLimit     = 50000 // brute-force scan cap (chunks)
	embedVecTopK       = 100   // vector candidates fed into fusion
	rrfK               = 60    // RRF smoothing (Cormack et al., k=60)
	vectorQueryTimeout = 10 * time.Second
	embedDocTimeout    = 60 * time.Second
)

var (
	embedderMu     sync.RWMutex
	activeEmbedder Embedder
)

// SetEmbedder installs the process-wide embedding client (main.go wires the
// gateway embedder; nil disables the vector path entirely).
func SetEmbedder(e Embedder) {
	embedderMu.Lock()
	defer embedderMu.Unlock()
	activeEmbedder = e
}

func currentEmbedder() Embedder {
	embedderMu.RLock()
	defer embedderMu.RUnlock()
	return activeEmbedder
}

// GetEmbeddingModel returns the configured embedding model name.
func GetEmbeddingModel(db *sql.DB) (string, bool, error) {
	return serverstore.GetSetting(db, EmbeddingModelSetting)
}

var errEmbedUpstream = errors.New("embedding upstream unavailable")

// normalize returns the L2-normalized copy of v.
func normalize(v []float32) []float32 {
	var sum float64
	for _, x := range v {
		sum += float64(x) * float64(x)
	}
	n := math.Sqrt(sum)
	if n == 0 {
		return v
	}
	out := make([]float32, len(v))
	for i, x := range v {
		out[i] = float32(float64(x) / n)
	}
	return out
}

// decodeF32 decodes a little-endian float32 BLOB.
func decodeF32(b []byte) []float32 {
	out := make([]float32, len(b)/4)
	for i := range out {
		out[i] = math.Float32frombits(binary.LittleEndian.Uint32(b[i*4:]))
	}
	return out
}

// embedMissingChunks embeds every chunk of a document that has no vector
// yet, in batches of embedBatchSize. Idempotent; returns the count embedded.
func embedMissingChunks(ctx context.Context, db *sql.DB, e Embedder, model string, docID int64) (int, error) {
	rows, err := db.Query(`SELECT c.id, c.title_path, c.content FROM kb_chunks c
		LEFT JOIN kb_chunk_embeddings ce ON ce.chunk_id = c.id
		WHERE c.doc_id = ? AND ce.chunk_id IS NULL ORDER BY c.seq`, docID)
	if err != nil {
		return 0, err
	}
	type row struct {
		id      int64
		title   string
		content string
	}
	var missing []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.title, &r.content); err != nil {
			rows.Close()
			return 0, err
		}
		missing = append(missing, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	embedded := 0
	for start := 0; start < len(missing); start += embedBatchSize {
		end := start + embedBatchSize
		if end > len(missing) {
			end = len(missing)
		}
		batch := missing[start:end]
		texts := make([]string, len(batch))
		for i, r := range batch {
			if r.title != "" {
				texts[i] = r.title + "\n" + r.content
			} else {
				texts[i] = r.content
			}
		}
		vecs, _, err := e.Embed(ctx, model, texts)
		if err != nil {
			return embedded, err
		}
		tx, err := db.Begin()
		if err != nil {
			return embedded, err
		}
		for i, r := range batch {
			v := normalize(vecs[i])
			if _, err := tx.Exec(`INSERT OR REPLACE INTO kb_chunk_embeddings (chunk_id, doc_id, model, dims, vector)
				VALUES (?, ?, ?, ?, ?)`, r.id, docID, model, len(v), encodeF32(v)); err != nil {
				tx.Rollback()
				return embedded, err
			}
		}
		if err := tx.Commit(); err != nil {
			return embedded, err
		}
		embedded += len(batch)
	}
	return embedded, nil
}

// encodeF32 packs float32s into a little-endian BLOB.
func encodeF32(v []float32) []byte {
	b := make([]byte, len(v)*4)
	for i, x := range v {
		binary.LittleEndian.PutUint32(b[i*4:], math.Float32bits(x))
	}
	return b
}

// BackfillEmbeddings embeds every ready document missing chunk vectors in
// one pass (startup housekeeping; best-effort, logs errors).
func BackfillEmbeddings(db *sql.DB, e Embedder) {
	model, ok, err := GetEmbeddingModel(db)
	if err != nil || !ok || e == nil {
		return
	}
	ids, err := serverstore.DocsMissingChunkEmbeddings(db)
	if err != nil {
		log.Printf("kb embeddings: backfill scan: %v", err)
		return
	}
	for _, id := range ids {
		if _, err := embedMissingChunks(context.Background(), db, e, model, id); err != nil {
			log.Printf("kb embeddings: doc %d: %v", id, err)
		}
	}
}

// StartEmbeddingLoop runs a background worker embedding chunks as they
// land (new uploads, imports). Idle when the model is unset or no chunk
// lacks a vector; one doc at a time, batched internally.
func StartEmbeddingLoop(db *sql.DB, e Embedder, idle time.Duration) {
	if idle <= 0 {
		idle = time.Second
	}
	go func() {
		for {
			model, ok, err := GetEmbeddingModel(db)
			if err != nil || !ok || e == nil {
				time.Sleep(3 * idle)
				continue
			}
			docID, err := serverstore.NextDocMissingChunkEmbeddings(db)
			if errors.Is(err, serverstore.ErrNotFound) {
				time.Sleep(idle)
				continue
			}
			if err != nil {
				log.Printf("kb embeddings: scan: %v", err)
				time.Sleep(idle)
				continue
			}
			ctx, cancel := context.WithTimeout(context.Background(), embedDocTimeout)
			_, err = embedMissingChunks(ctx, db, e, model, docID)
			cancel()
			if err != nil {
				// transient upstream failure: back off and retry the doc
				log.Printf("kb embeddings: doc %d: %v", docID, err)
				time.Sleep(idle)
			}
		}
	}()
}
