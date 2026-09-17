// Command randguest is a wasip1 guest that reports what wazero's random_get
// actually returns. Built with GOOS=wasip1 GOARCH=wasm; crypto/rand on wasip1
// is implemented on top of random_get.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"
)

func main() {
	b := make([]byte, 8)
	n, err := rand.Read(b)
	fmt.Printf("random_get  -> %s (n=%d err=%v)\n", hex.EncodeToString(b), n, err)
	b2 := make([]byte, 8)
	_, _ = rand.Read(b2)
	fmt.Printf("second call -> %s\n", hex.EncodeToString(b2))
	fmt.Printf("walltime    -> %s\n", time.Now().UTC().Format(time.RFC3339Nano))
}
