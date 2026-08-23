package knowledge

import (
	"database/sql"
	"errors"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// StartUploadQueue runs n workers draining pending kb uploads. The
// kb_documents table is the queue (status='pending'); workers claim a row
// whose raw file is on disk, extract it from uploadsDir, and mark it ready
// or error. Pending rows survive restarts, so a crash mid-extraction
// self-heals.
func StartUploadQueue(db *sql.DB, uploadsDir string, n int) {
	for i := 0; i < n; i++ {
		go uploadWorker(db, uploadsDir)
	}
}

func uploadWorker(db *sql.DB, uploadsDir string) {
	for {
		if !processNextPending(db, uploadsDir) {
			time.Sleep(time.Second)
		}
	}
}

// orphanGrace bounds how long a pending row may wait for its raw file to
// land. The upload handler INSERTs the row and only then renames the file
// into place (C-4), so a freshly inserted row legitimately has no file for
// a moment; anything older than this with no file is an orphan (crash
// mid-save + startup temp sweep, manual deletion) and must not block the
// queue head forever (审计 H2).
const orphanGrace = 30 * time.Second

// processNextPending extracts one pending upload; returns false when the
// queue is empty. Tests drive the queue synchronously by looping on it.
func processNextPending(db *sql.DB, uploadsDir string) bool {
	docs, err := serverstore.ListPendingKBDocuments(db)
	if err != nil {
		log.Printf("kb queue: list pending: %v", err)
		return false
	}
	if len(docs) == 0 {
		return false
	}
	worked := false
	for _, d := range docs {
		path := filepath.Join(uploadsDir, strconv.FormatInt(d.ID, 10))
		if _, err := os.Stat(path); err != nil {
			// C-4: the raw file has not landed yet (INSERT happens before the
			// Rename in the upload handler) — skip and let the next poll pick
			// it up. Older than the grace period: the file will never land, so
			// mark the row error instead of re-queuing it forever (H2).
			if time.Since(d.CreatedAt) > orphanGrace {
				if uerr := serverstore.CompleteKBDocument(db, d.ID, "", "原始文件丢失,请删除后重新上传"); uerr != nil {
					log.Printf("kb queue: doc %d mark orphan error: %v", d.ID, uerr)
				} else {
					log.Printf("kb queue: doc %d orphaned (missing raw file), marked error", d.ID)
					worked = true
				}
			}
			continue
		}
		// file is present: claim exclusively (CAS by id) and extract. A stale
		// list entry already claimed by another worker fails with ErrNotFound
		// and is simply skipped.
		doc, cerr := serverstore.ClaimPendingKBDocumentByID(db, d.ID)
		if errors.Is(cerr, serverstore.ErrNotFound) {
			continue
		}
		if cerr != nil {
			log.Printf("kb queue: claim doc %d: %v", d.ID, cerr)
			continue
		}
		content, err := extractSaved(path, doc.ContentType)
		if err != nil {
			// raw file kept on disk for a later OCR round
			log.Printf("kb queue: doc %d extract failed: %v (file kept)", doc.ID, err)
			if uerr := serverstore.CompleteKBDocument(db, doc.ID, "", err.Error()); uerr != nil {
				log.Printf("kb queue: doc %d mark error: %v", doc.ID, uerr)
			}
			return true
		}
		// complete 失败:行保持 processing 且文件绝不能删(否则永久 pending)。
		// 释放 claim 回队列 + 退避重试;事务(trigram 索引写放大)偶发 busy。
		if uerr := serverstore.CompleteKBDocumentWithChunks(db, doc.ID, content, "", ChunkText(content)); uerr != nil {
			log.Printf("kb queue: doc %d complete: %v (file kept, retry)", doc.ID, uerr)
			if rerr := serverstore.ReleaseClaim(db, doc.ID); rerr != nil {
				log.Printf("kb queue: doc %d release claim: %v", doc.ID, rerr)
			}
			time.Sleep(500 * time.Millisecond)
			return true
		}
		os.Remove(path) // success only: extracted text is in the DB, raw file gone
		return true
	}
	return worked
}
