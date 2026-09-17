#!/usr/bin/env bash
# Rebuild the wasip1 guest and run the host-side comparison.
#
# Requires Go (built with 1.26.5) and a populated module cache for the host
# module (wazero v1.12.0 + golang.org/x/sys).
set -euo pipefail
cd "$(dirname "$0")"

( cd guest && GOOS=wasip1 GOARCH=wasm go build -o ../randguest.wasm . )
go run .
