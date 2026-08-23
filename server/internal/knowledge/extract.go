package knowledge

import (
	"archive/zip"
	"errors"
	"fmt"
	"html"
	"io"
	"os"
	"regexp"
	"strings"

	"github.com/ledongthuc/pdf"
)

var xmlTagRE = regexp.MustCompile(`<[^>]+>`)

// maxUploadBytes caps a raw upload file; maxExtractBytes caps extracted text.
const (
	maxUploadBytes  = 16 << 20
	maxExtractBytes = 32 << 20
)

// classifyFile maps an upload filename to a supported content type.
func classifyFile(name string) (string, error) {
	switch {
	case strings.HasSuffix(strings.ToLower(name), ".txt"):
		return "text", nil
	case strings.HasSuffix(strings.ToLower(name), ".md"):
		return "markdown", nil
	case strings.HasSuffix(strings.ToLower(name), ".docx"):
		return "docx", nil
	case strings.HasSuffix(strings.ToLower(name), ".pdf"):
		return "pdf", nil
	default:
		return "", errors.New("仅支持 txt/md/docx/pdf 文件")
	}
}

// extractSaved reads a saved upload file and returns its text. Content is
// capped at maxKBContent, matching IndexDocument's limit.
func extractSaved(path, contentType string) (string, error) {
	var content string
	var err error
	switch contentType {
	case "text", "markdown":
		b, err := os.ReadFile(path)
		if err != nil {
			return "", errors.New("读取文件失败")
		}
		content = string(b)
	case "docx":
		content, err = extractDocx(path)
	case "pdf":
		content, err = extractPDF(path)
	}
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(content) == "" {
		return "", errors.New("无法从文件中提取文本")
	}
	if len(content) > maxKBContent {
		return "", errors.New(fmt.Sprintf("文档内容超过上限 %d 字节", maxKBContent))
	}
	return content, nil
}

// extractDocx reads word/document.xml from a docx (zip) archive, turning
// paragraphs into newlines and stripping XML markup.
func extractDocx(path string) (string, error) {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return "", fmt.Errorf("不是有效的 docx 文件: %v", err)
	}
	defer zr.Close()
	for _, f := range zr.File {
		if f.Name != "word/document.xml" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return "", fmt.Errorf("docx 解析失败: %v", err)
		}
		b, err := io.ReadAll(io.LimitReader(rc, maxExtractBytes+1)) // zip bomb guard
		rc.Close()
		if err != nil {
			return "", fmt.Errorf("docx 解析失败: %v", err)
		}
		if len(b) > maxExtractBytes {
			return "", errors.New("docx 解压内容超过 32MB 上限")
		}
		text := xmlTagRE.ReplaceAllString(strings.ReplaceAll(string(b), "</w:p>", "\n"), "")
		return html.UnescapeString(text), nil
	}
	return "", errors.New("不是有效的 docx 文件: 缺少 word/document.xml")
}

// extractPDF returns the plain text of a PDF.
func extractPDF(path string) (out string, err error) {
	// ponytail: ledongthuc/pdf panics on some malformed files; untrusted
	// uploads must not crash the server, so contain any panic.
	defer func() {
		if r := recover(); r != nil {
			out, err = "", fmt.Errorf("pdf 解析失败: %v", r)
		}
	}()
	f, r, err := pdf.Open(path)
	if err != nil {
		return "", fmt.Errorf("pdf 解析失败: %v", err)
	}
	defer f.Close()
	rd, err := r.GetPlainText()
	if err != nil {
		return "", fmt.Errorf("pdf 解析失败: %v", err)
	}
	b, err := io.ReadAll(io.LimitReader(rd, maxExtractBytes+1))
	if err != nil {
		return "", fmt.Errorf("pdf 解析失败: %v", err)
	}
	if len(b) > maxExtractBytes {
		return "", errors.New("pdf 内容超过 32MB 上限")
	}
	return string(b), nil
}
