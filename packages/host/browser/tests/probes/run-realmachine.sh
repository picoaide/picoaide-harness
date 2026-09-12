#!/usr/bin/env bash
# Real-machine regression probes for the embedded browser (R-1…R-4).
#
# Runs the ACTUAL runtime + real Electron adapter + the real `browser_*` tool
# registrations inside a real Electron main process (Xvfb), against real
# loopback pages over real CDP. Evidence JSON goes to $PROBE_DIR (default:
# <package>/node_modules/.probe-out, which is gitignored; never into temp/).
#
#   bash tests/probes/run-realmachine.sh              # working tree
#   bash tests/probes/run-realmachine.sh --pristine   # pre-fix sources from HEAD
#
# `--pristine` snapshots the committed sources (`git show HEAD:…` — read-only:
# no git index/worktree write) into a scratch directory OUTSIDE node_modules
# (Node refuses to type-strip .ts files under node_modules) and runs the same
# probes against them. That is how the red→green pair was produced: the
# `*.red.*` assertions describe the defect and pass there, the `*.green.*`
# assertions describe the fix and pass on the working tree.
#
# Requirements: Linux + xvfb-run (the Electron-less regression lock lives in
# tests/audit-0913.spec.ts and runs in `vitest run`).
set -euo pipefail
cd "$(dirname "$0")/../.."   # packages/host/browser
PKG_ROOT="$PWD"
REPO_ROOT="$(cd "$PKG_ROOT/../../.." && pwd)"
ELECTRON="${ELECTRON:-$PKG_ROOT/node_modules/electron/dist/electron}"
PROBE_DIR="${PROBE_DIR:-$PKG_ROOT/node_modules/.probe-out}"
PRISTINE=0
[ "${1:-}" = "--pristine" ] && PRISTINE=1
mkdir -p "$PROBE_DIR"

if [ ! -x "$ELECTRON" ]; then
  echo "electron binary not found at $ELECTRON" >&2
  exit 2
fi

PROBES="frame-index-probe outlet-egress-probe credential-window-probe"
PROBE_EXPECT="green"
RUN_ROOT="$PKG_ROOT"
SCRATCH=""
cleanup() {
  # NOTE: an EXIT trap's status becomes the script's status — a bare
  # `[ -n "$SCRATCH" ] && rm -rf "$SCRATCH"` returned 1 when there was no
  # scratch dir and made the whole run look failed.
  if [ -n "$SCRATCH" ]; then rm -rf "$SCRATCH"; fi
}
trap cleanup EXIT

if [ "$PRISTINE" = "1" ]; then
  SCRATCH="$(mktemp -d "$PKG_ROOT/tests/.pristine-XXXXXX")"
  mkdir -p "$SCRATCH/src" "$SCRATCH/tests"
  cp -r tests/probes "$SCRATCH/tests/probes"
  for f in $(git -C "$REPO_ROOT" ls-tree -r --name-only HEAD packages/host/browser/src/ | sed 's|packages/host/browser/src/||'); do
    mkdir -p "$SCRATCH/src/$(dirname "$f")"
    git -C "$REPO_ROOT" show "HEAD:packages/host/browser/src/$f" > "$SCRATCH/src/$f"
  done
  RUN_ROOT="$SCRATCH"
  # The other probes' assertions encode the CURRENT model behaviour, so only the
  # credential-window probe (which carries both polarities) runs on HEAD.
  PROBES="credential-window-probe"
  PROBE_EXPECT="red"
  echo "== pristine (HEAD) sources: $SCRATCH =="
fi

# A fresh profile per run: a killed Electron leaves caches behind and the
# next start can block on them.
RUN_HOME="$PROBE_DIR/home-$RANDOM-$$"
mkdir -p "$RUN_HOME"
status=0
for probe in $PROBES; do
  echo "== $probe =="
  # --experimental-transform-types: the sources use TypeScript parameter
  # properties, which Node's strip-only type stripping rejects.
  # HOME/XDG are redirected: /root/.config is read-only here and Electron
  # otherwise spends the run failing to create its cache directories.
  if HOME="$RUN_HOME" XDG_CONFIG_HOME="$RUN_HOME/.config" PROBE_EXPECT="$PROBE_EXPECT" \
    PROBE_OUT="$PROBE_DIR/$probe.json" NODE_OPTIONS=--experimental-transform-types \
    xvfb-run -a "$ELECTRON" --no-sandbox "$RUN_ROOT/tests/probes/$probe.mjs" >"$PROBE_DIR/$probe.log" 2>&1; then
    echo "   PASS  ($PROBE_DIR/$probe.json)"
  else
    echo "   FAIL  ($PROBE_DIR/$probe.log)" >&2
    status=1
  fi
done
exit $status
