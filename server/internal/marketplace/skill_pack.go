package marketplace

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/goccy/go-yaml"

	"github.com/picoaide/picoaide/internal/util"
)

// maxRepoSize caps the cloned skill source; maxPackageSize caps the built
// archive. Both are ceilings, not quotas.
const maxRepoSize = 200 << 20

// maxPackageSize is enforced while archiving (审计 6-M4); test-injectable.
var maxPackageSize = 100 << 20

type skillMetadata struct {
	Name         string   `yaml:"name"`
	Version      string   `yaml:"version"`
	Author       string   `yaml:"author"`
	Description  string   `yaml:"description"`
	Dependencies []string `yaml:"dependencies"`
	Entrypoint   string   `yaml:"entrypoint"`
}

// CloneRepo shallow-clones gitURL@ref into repoPath. The repo lives at
// cacheDir/<name>/ so the archive ends up in cacheDir/<name>-<version>.tar.gz.
// A wrong ref falls back to the default branch; clones over maxRepoSize are
// rejected.
func CloneRepo(gitURL, ref, repoPath string) error {
	if err := os.RemoveAll(repoPath); err != nil {
		return err
	}
	clone := func(refName plumbing.ReferenceName) error {
		_, err := git.PlainClone(repoPath, false, &git.CloneOptions{
			URL:           gitURL,
			ReferenceName: refName,
			Depth:         1,
			SingleBranch:  true,
		})
		return err
	}
	err := clone(plumbing.NewBranchReferenceName(ref))
	if err != nil {
		os.RemoveAll(repoPath)
		err = clone(plumbing.NewTagReferenceName(ref))
	}
	if err != nil {
		os.RemoveAll(repoPath)
		err = clone("")
	}
	if err != nil {
		os.RemoveAll(repoPath)
		return fmt.Errorf("clone %s: %w", gitURL, err)
	}
	// ponytail: size is checked after the clone completes; an in-flight
	// limit would need transport plumbing. A 200MB clone is the cost of
	// the check itself, and the clone is discarded on failure.
	size, err := dirSize(repoPath)
	if err != nil {
		os.RemoveAll(repoPath)
		return err
	}
	if size > maxRepoSize {
		os.RemoveAll(repoPath)
		return fmt.Errorf("repository %s exceeds %d bytes", gitURL, maxRepoSize)
	}
	return nil
}

// BuildPackage validates the repo at repoPath and returns the path of the
// built archive at cacheDir/<name>-<version>.tar.gz (cacheDir = parent of
// repoPath). Cache hits return immediately; building a new version removes
// older archives for the same name.
func BuildPackage(repoPath, name, version string) (string, error) {
	if !util.SafePathSegment(name) {
		return "", fmt.Errorf("invalid skill name %q", name)
	}
	if version == "" || strings.ContainsAny(version, "/\\") {
		return "", fmt.Errorf("invalid skill version %q", version)
	}
	cacheDir := filepath.Dir(repoPath)
	dst := filepath.Join(cacheDir, name+"-"+version+".tar.gz")
	if _, err := os.Stat(dst); err == nil {
		return dst, nil // cache hit
	}
	if err := buildArchive(repoPath, name, version, dst); err != nil {
		return "", err
	}
	matches, _ := filepath.Glob(filepath.Join(cacheDir, name+"-*.tar.gz"))
	for _, m := range matches {
		if m != dst {
			os.Remove(m)
		}
	}
	return dst, nil
}

func buildArchive(repoPath, name, version, dst string) error {
	meta, err := readMetadata(filepath.Join(repoPath, "metadata.yaml"))
	if err != nil {
		return fmt.Errorf("metadata.yaml: %w", err)
	}
	if meta.Name != name {
		return fmt.Errorf("metadata name %q != %q", meta.Name, name)
	}
	if meta.Version != version {
		return fmt.Errorf("metadata version %q != %q", meta.Version, version)
	}
	if _, err := os.Stat(filepath.Join(repoPath, "SKILL.md")); err != nil {
		return fmt.Errorf("SKILL.md: %w", err)
	}

	tmp, err := os.CreateTemp(filepath.Dir(dst), ".build-*.tar.gz")
	if err != nil {
		return err
	}
	defer func() {
		tmp.Close()
		os.Remove(tmp.Name())
	}()
	gw := gzip.NewWriter(tmp)
	tw := tar.NewWriter(gw)
	total := int64(0) // 审计 6-M4: archive byte counter
	err = filepath.WalkDir(repoPath, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(repoPath, p)
		if err != nil {
			return err
		}
		if rel == "." || rel == ".git" {
			return nil
		}
		if strings.HasPrefix(rel, ".git/") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if d.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("symlink not allowed in package: %s", rel)
		}
		// ponytail: git clones cannot contain hardlinks (git stores blobs
		// separately), so no link check is needed here.
		info, err := d.Info()
		if err != nil {
			return err
		}
		total += info.Size()
		if total > int64(maxPackageSize) {
			return fmt.Errorf("package exceeds %d bytes", maxPackageSize)
		}
		hdr := &tar.Header{
			Name: filepath.ToSlash(rel),
			Mode: int64(info.Mode().Perm()),
			Size: info.Size(),
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		_, err = io.Copy(tw, f)
		f.Close()
		return err
	})
	if err != nil {
		return err
	}
	if err := tw.Close(); err != nil {
		return err
	}
	if err := gw.Close(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), dst)
}

func readMetadata(path string) (*skillMetadata, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var m skillMetadata
	if err := yaml.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	if !util.SafePathSegment(m.Name) {
		return nil, fmt.Errorf("invalid skill name %q", m.Name)
	}
	return &m, nil
}

func dirSize(dir string) (int64, error) {
	var total int64
	err := filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.Type().IsRegular() {
			if info, err := d.Info(); err == nil {
				total += info.Size()
			}
		}
		return nil
	})
	return total, err
}
