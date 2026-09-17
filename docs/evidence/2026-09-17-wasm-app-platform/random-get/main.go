// Command random-get-host instantiates the wasip1 guest (guest/main.go, built to
// randguest.wasm) three times with wazero's DEFAULT ModuleConfig and twice with
// an explicit real random source, then prints what the guest saw.
//
// Expected (wazero v1.12.0): the three default runtimes return the SAME bytes
// (platform.NewFakeRandSource is math/rand seeded with 42) and a fake
// 2022-01-01 clock; the explicit runs differ from each other.
//
// Run via ./run.sh (it builds the guest first).
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"fmt"
	"os"
	"time"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

func main() {
	bin, err := os.ReadFile("randguest.wasm")
	if err != nil {
		fmt.Fprintln(os.Stderr, "build the guest first: see run.sh")
		panic(err)
	}
	ctx := context.Background()

	fmt.Println("--- A) default ModuleConfig (no WithRandSource) ---")
	for i := 1; i <= 3; i++ {
		fmt.Printf("[runtime %d]\n%s", i, run(ctx, bin, wazero.NewModuleConfig()))
	}

	fmt.Println("--- B) WithRandSource(rand.Reader) + real clocks ---")
	cfg := wazero.NewModuleConfig().
		WithRandSource(rand.Reader).
		WithSysWalltime().
		WithSysNanotime()
	for i := 1; i <= 2; i++ {
		fmt.Printf("[runtime %d]\n%s", i, run(ctx, bin, cfg))
	}
}

func run(ctx context.Context, bin []byte, mc wazero.ModuleConfig) string {
	rt := wazero.NewRuntime(ctx)
	defer rt.Close(ctx)
	if _, err := wasi_snapshot_preview1.Instantiate(ctx, rt); err != nil {
		panic(err)
	}
	var out, errb bytes.Buffer
	if _, err := rt.InstantiateWithConfig(ctx, bin, mc.WithStdout(&out).WithStderr(&errb)); err != nil {
		return fmt.Sprintf("instantiate err: %v\nstderr=%s", err, errb.String())
	}
	time.Sleep(5 * time.Millisecond) // let the guest's writes land in the buffer
	return out.String()
}
