package knowledge

import (
	"database/sql"
	"errors"
	"fmt"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// maxKBContent caps a single document's text content (memory/disk guard;
// real documents are far below 1MB of plain text).
const maxKBContent = 1 << 20

// UpdateDocument overwrites a document's title/content (content type kept),
// enforcing the same size cap as IndexDocument. The FTS index is re-synced by
// the kb_au trigger inside the store update; chunks are re-chunked atomically
// with the content write.
func UpdateDocument(db *sql.DB, id int64, title, content string) error {
	if len(content) > maxKBContent {
		return errors.New(fmt.Sprintf("文档内容超过上限 %d 字节", maxKBContent))
	}
	doc, err := serverstore.GetKBDocument(db, id)
	if err != nil {
		return err
	}
	return serverstore.UpdateKBDocumentWithChunks(db, id, title, content, doc.ContentType, ChunkText(content))
}

// IndexDocument stores a document into the knowledge base, recording the
// extracted text length as its size and chunking the text atomically with
// the insert. txt/md text is accepted as-is; docx/pdf extraction happens in
// extract.go.
func IndexDocument(db *sql.DB, folderID int64, title, content, contentType, source, createdBy string) (int64, error) {
	if len(content) > maxKBContent {
		return 0, errors.New(fmt.Sprintf("文档内容超过上限 %d 字节", maxKBContent))
	}
	return serverstore.CreateKBDocumentWithChunks(db, folderID, title, content, contentType, int64(len(content)), source, createdBy, ChunkText(content))
}
