#!/usr/bin/env bash
# Real-machine regression probes for the embedded browser (R-1…R-4).
#
# Runs the ACTUAL runtime + real Electron adapter + the real `browser_*` tool
# registrations inside a real Electron main process (Xvfb), against real
# loopback pages over real CDP. Writes evidence JSON to $PROBE_DIR
# (default: <repo>/temp/fix-r3-browser).
#
#   bash tests/probes/run-realmachine.sh
#
# Requirements: Linux + xvfb-run (CI gate does not run this; the Electron-less
# regression lives in tests/audit-0913.spec.ts).
set -euo pipefail
cd "$(dirname "$0")/../.."   # packages/host/browser
PKG_ROOT="$PWD"
ELECTRON="${ELECTRON:-$PKG_ROOT/node_modules/electron/dist/electron}"
PROBE_DIR="${PROBE_DIR:-$PKG_ROOT/../../../temp/fix-r3-browser}"
mkdir -p "$PROBE_DIR"

if [ ! -x "$ELECTRON" ]; then
  echo "electron binary not found at $ELECTRON" >&2
  exit 2
fi

status=0
for probe in frame-index-probe outlet-egress-probe; do
  echo "== $probe =="
  # --experimental-transform-types: the sources use TypeScript parameter
  # properties, which Node's strip-only type stripping rejects.
  if PROBE_OUT="$PROBE_DIR/$probe.json" NODE_OPTIONS=--experimental-transform-types \
    xvfb-run -a "$ELECTRON" --no-sandbox "$PKG_ROOT/tests/probes/$probe.mjs" >"$PROBE_DIR/$probe.log" 2>&1; then
    echo "   PASS  ($PROBE_DIR/$probe.json)"
  else
    echo "   FAIL  ($PROBE_DIR/$probe.log)" >&2
    status=1
  fi
done
exit $status
