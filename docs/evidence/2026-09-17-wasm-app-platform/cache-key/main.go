// Command cache-key probes wazero's on-disk compilation cache key.
//
// Why this exists: `wazero.NewCompilationCacheWithDir` keys entries by
// sha256(moduleID ‖ magic ‖ CPU features), and moduleID itself is
// AssignModuleID(binary, listeners, ensureTermination) — i.e. the
// RuntimeConfig flag `WithCloseOnContextDone` is part of the key while
// `WithMemoryLimitPages` is not. A compile process and an execute process that
// disagree on the flag silently never share a cache entry. See the design's
// §4.3.1.
//
// Usage:
//
//	GOMODCACHE=<any populated module cache> go run . <module.wasm> <cache-dir>
//	GOMODCACHE=<...> go run . <module.wasm> <cache-dir> <variant>
//
// Without <variant> it runs the full writer/reader matrix; with <variant>
// (plain | close | mem | both) it compiles once into a fresh directory and
// prints the resulting cache entry name — that is how a config is mapped to a
// key.
package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/tetratelabs/wazero"
)

type variant struct {
	name string
	cfg  func(wazero.RuntimeConfig) wazero.RuntimeConfig
}

var variants = []variant{
	{"plain", nil},
	{"close", func(c wazero.RuntimeConfig) wazero.RuntimeConfig { return c.WithCloseOnContextDone(true) }},
	{"mem", func(c wazero.RuntimeConfig) wazero.RuntimeConfig { return c.WithMemoryLimitPages(1024) }},
	{"both", func(c wazero.RuntimeConfig) wazero.RuntimeConfig {
		return c.WithCloseOnContextDone(true).WithMemoryLimitPages(1024)
	}},
}

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: cache-key <module.wasm> <cache-dir> [plain|close|mem|both]")
		os.Exit(2)
	}
	bin, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	base := os.Args[2]
	sum := sha256.Sum256(bin)
	fmt.Printf("module: %s (%d bytes, sha256 %s)\n", os.Args[1], len(bin), hex.EncodeToString(sum[:]))

	if len(os.Args) > 3 {
		single(bin, base, os.Args[3])
		return
	}
	matrix(bin, base)
}

// single compiles once with one config into an empty directory and prints the
// cache entry that config produced.
func single(bin []byte, base, name string) {
	v, ok := lookup(name)
	if !ok {
		fmt.Fprintf(os.Stderr, "unknown variant %q\n", name)
		os.Exit(2)
	}
	dir := filepath.Join(base, "single-"+v.name)
	_ = os.RemoveAll(dir)
	must(os.MkdirAll(dir, 0o755))
	d := compileOnce(bin, dir, v.cfg)
	fmt.Printf("variant=%-5s first-compile=%s\n", v.name, d.Round(time.Millisecond))
	for _, e := range entries(dir) {
		fmt.Printf("  entry %s (%d bytes)\n", filepath.Base(e), size(e))
	}
}

// matrix starts from an empty cache directory per block, does one cold compile
// (the first "plain" line) and then reads with every variant. A reader is
// classified HIT when it is at least 5x faster than the cold compile.
func matrix(bin []byte, base string) {
	for _, writer := range variants {
		dir := filepath.Join(base, "matrix-"+writer.name)
		_ = os.RemoveAll(dir)
		must(os.MkdirAll(dir, 0o755))
		fmt.Printf("== empty cache dir %s ==\n", filepath.Base(dir))
		var cold time.Duration
		for i, reader := range variants {
			d := compileOnce(bin, dir, reader.cfg)
			verdict := "cold"
			if i > 0 {
				if d*5 < cold {
					verdict = "HIT"
				} else {
					verdict = "MISS"
				}
			} else {
				cold = d
			}
			fmt.Printf("   reader=%-5s %8s %-4s (entries=%d)\n",
				reader.name, d.Round(time.Millisecond), verdict, len(entries(dir)))
		}
	}
	fmt.Println("\nnote: the first line of every block is the cold compile (config 'plain');")
	fmt.Println("      the config -> entry-name mapping is printed by the <variant> mode.")
}

func compileOnce(bin []byte, dir string, cfg func(wazero.RuntimeConfig) wazero.RuntimeConfig) time.Duration {
	ctx := context.Background()
	cache, err := wazero.NewCompilationCacheWithDir(dir)
	if err != nil {
		panic(err)
	}
	rc := wazero.NewRuntimeConfig().WithCompilationCache(cache)
	if cfg != nil {
		rc = cfg(rc)
	}
	start := time.Now()
	rt := wazero.NewRuntimeWithConfig(ctx, rc)
	cm, err := rt.CompileModule(ctx, bin)
	if err != nil {
		panic(err)
	}
	d := time.Since(start)
	cm.Close(ctx)
	_ = rt.Close(ctx)
	_ = cache.Close(ctx)
	return d
}

func lookup(name string) (variant, bool) {
	for _, v := range variants {
		if v.name == name {
			return v, true
		}
	}
	return variant{}, false
}

func entries(dir string) []string {
	m, _ := filepath.Glob(filepath.Join(dir, "wazero-*", "*"))
	return m
}

func size(path string) int64 {
	fi, err := os.Stat(path)
	if err != nil {
		return -1
	}
	return fi.Size()
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}
