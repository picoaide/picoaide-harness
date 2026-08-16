package marketplace

import (
	"archive/tar"
	"compress/gzip"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
)

const fixtureMetadata = `name: demo
version: 1.0.0
author: pico
description: demo skill
dependencies: []
entrypoint: SKILL.md
`

func writeFixtureRepo(t *testing.T, dir string) {
	t.Helper()
	files := map[string]string{
		"metadata.yaml": fixtureMetadata,
		"SKILL.md":      "# demo skill\n",
		"tools/run.sh":  "#!/bin/sh\necho hi\n",
	}
	for p, content := range files {
		full := filepath.Join(dir, p)
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
}

// makeGitRepo creates a real repo (branch "main") in dir and returns its path.
func makeGitRepo(t *testing.T, dir string) string {
	t.Helper()
	repo, err := git.PlainInit(dir, false)
	if err != nil {
		t.Fatal(err)
	}
	w, err := repo.Worktree()
	if err != nil {
		t.Fatal(err)
	}
	writeFixtureRepo(t, dir)
	for p := range map[string]string{"metadata.yaml": "", "SKILL.md": "", "tools/run.sh": ""} {
		if _, err := w.Add(p); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := w.Commit("init", &git.CommitOptions{
		Author: &object.Signature{Name: "t", Email: "t@t", When: time.Now()},
	}); err != nil {
		t.Fatal(err)
	}
	h, err := repo.Head()
	if err != nil {
		t.Fatal(err)
	}
	main := plumbing.NewHashReference(plumbing.NewBranchReferenceName("main"), h.Hash())
	if err := repo.Storer.SetReference(main); err != nil {
		t.Fatal(err)
	}
	return dir
}

func readArchive(t *testing.T, path string) map[string][]byte {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gr, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gr)
	out := map[string][]byte{}
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(tr)
		out[hdr.Name] = b
	}
	return out
}

func TestBuildPackage(t *testing.T) {
	cache := t.TempDir()
	repo := filepath.Join(cache, "demo")
	writeFixtureRepo(t, repo)

	pkg, err := BuildPackage(repo, "demo", "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(cache, "demo-1.0.0.tar.gz")
	if pkg != want {
		t.Fatalf("package path = %q, want %q", pkg, want)
	}
	entries := readArchive(t, pkg)
	meta, ok := entries["metadata.yaml"]
	if !ok {
		t.Fatal("metadata.yaml missing")
	}
	if !strings.Contains(string(meta), "name: demo") || !strings.Contains(string(meta), "version: 1.0.0") ||
		!strings.Contains(string(meta), "author: pico") || !strings.Contains(string(meta), "entrypoint: SKILL.md") {
		t.Fatalf("metadata.yaml content = %s", meta)
	}
	if _, ok := entries["SKILL.md"]; !ok {
		t.Fatal("SKILL.md missing")
	}
	if _, ok := entries["tools/run.sh"]; !ok {
		t.Fatal("tools/run.sh missing")
	}
	for name := range entries {
		if name == "" || filepath.IsAbs(name) || strings.HasPrefix(name, "..") || strings.Contains(name, "../") {
			t.Fatalf("unsafe entry name %q", name)
		}
	}

	// cache hit: second call returns the same path without rebuilding
	pkg2, err := BuildPackage(repo, "demo", "1.0.0")
	if err != nil || pkg2 != pkg {
		t.Fatalf("cache hit = %q, %v", pkg2, err)
	}

	// building a new version removes the old archive
	if err := os.WriteFile(filepath.Join(repo, "metadata.yaml"), []byte(strings.ReplaceAll(fixtureMetadata, "1.0.0", "2.0.0")), 0644); err != nil {
		t.Fatal(err)
	}
	pkg3, err := BuildPackage(repo, "demo", "2.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if pkg3 != filepath.Join(cache, "demo-2.0.0.tar.gz") {
		t.Fatalf("v2 path = %q", pkg3)
	}
	if _, err := os.Stat(pkg); !os.IsNotExist(err) {
		t.Fatal("old version archive not cleaned up")
	}
}

func TestBuildPackageRejects(t *testing.T) {
	cache := t.TempDir()
	repo := filepath.Join(cache, "demo")
	writeFixtureRepo(t, repo)

	if _, err := BuildPackage(repo, "../evil", "1.0.0"); err == nil {
		t.Fatal("unsafe name accepted")
	}
	if err := os.WriteFile(filepath.Join(repo, "metadata.yaml"), []byte(strings.ReplaceAll(fixtureMetadata, "version: 1.0.0", "version: 9.9.9")), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := BuildPackage(repo, "demo", "1.0.0"); err == nil {
		t.Fatal("version mismatch accepted")
	}
}

// 审计 6-M4: maxPackageSize is enforced while archiving — a skill whose
// source exceeds the ceiling is refused.
func TestBuildPackageSizeLimit(t *testing.T) {
	prev := maxPackageSize
	maxPackageSize = 4096
	defer func() { maxPackageSize = prev }()

	cache := t.TempDir()
	repo := filepath.Join(cache, "demo")
	writeFixtureRepo(t, repo)
	if err := os.WriteFile(filepath.Join(repo, "big.bin"), make([]byte, 8192), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := BuildPackage(repo, "demo", "1.0.0"); err == nil {
		t.Fatal("oversized package accepted")
	}
	if _, err := os.Stat(filepath.Join(cache, "demo-1.0.0.tar.gz")); !os.IsNotExist(err) {
		t.Fatal("oversized archive left on disk")
	}
}

func TestCloneRepo(t *testing.T) {
	src := makeGitRepo(t, filepath.Join(t.TempDir(), "src"))
	dst := filepath.Join(t.TempDir(), "clone")
	if err := CloneRepo(src, "main", dst); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dst, "metadata.yaml")); err != nil {
		t.Fatalf("cloned file missing: %v", err)
	}
	// a wrong branch falls back to the default HEAD
	dst2 := filepath.Join(t.TempDir(), "clone2")
	if err := CloneRepo(src, "does-not-exist", dst2); err != nil {
		t.Fatalf("fallback clone: %v", err)
	}
	// nonexistent repo fails
	if err := CloneRepo(filepath.Join(t.TempDir(), "nope"), "main", filepath.Join(t.TempDir(), "x")); err == nil {
		t.Fatal("clone of nonexistent repo accepted")
	}
}
