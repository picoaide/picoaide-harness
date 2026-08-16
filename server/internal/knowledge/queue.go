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
// kb_documents table is the queue (status='pending'); workers claim the
// oldest row, extract its raw file from uploadsDir, and mark it ready or
// error. Pending rows survive restarts, so a crash mid-extraction self-heals.
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

// processNextPending extracts one pending upload; returns false when the
// queue is empty. Tests drive the queue synchronously by looping on it.
func processNextPending(db *sql.DB, uploadsDir string) bool {
	doc, err := serverstore.ClaimPendingKBDocument(db)
	if errors.Is(err, serverstore.ErrNotFound) {
		return false
	}
	if err != nil {
		log.Printf("kb queue: claim: %v", err)
		return false
	}
	path := filepath.Join(uploadsDir, strconv.FormatInt(doc.ID, 10))
	if _, err := os.Stat(path); err != nil {
		// C-4: the raw file has not landed yet (INSERT happens before the
		// Rename in the upload handler) or was manually removed. Release
		// the exclusive claim and skip without marking error — the upload
		// handler renames the file into place moments later and the next
		// poll picks it up.
		if rerr := serverstore.ReleaseClaim(db, doc.ID); rerr != nil {
			log.Printf("kb queue: doc %d release claim: %v", doc.ID, rerr)
		}
		return false
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
