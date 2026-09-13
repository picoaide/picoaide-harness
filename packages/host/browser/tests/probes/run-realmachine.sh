#!/usr/bin/env bash
# Real-machine regression probes for the embedded browser (R-1…R-4, R-6).
#
# Runs the ACTUAL runtime + real Electron adapter + the real `browser_*` tool
# registrations inside a real Electron main process (Xvfb), against real
# loopback pages over real CDP. Evidence JSON goes to $PROBE_DIR (default:
# <package>/node_modules/.probe-out, which is gitignored; never into temp/).
#
#   bash tests/probes/run-realmachine.sh                     # working tree (GREEN)
#   bash tests/probes/run-realmachine.sh --pristine          # HEAD sources (RED, R-6)
#   bash tests/probes/run-realmachine.sh --pristine --ref HEAD~1   # pre-R-4 baseline
#
# `--pristine` snapshots the committed sources (`git show <ref>:…` — read-only:
# no git index/worktree write) into a scratch directory OUTSIDE node_modules
# (Node refuses to type-strip .ts files under node_modules) and runs the probes
# against them. That is how the red→green pair is produced: the `*.red.*`
# assertions describe the defect and pass there, the `*.green.*` assertions
# describe the fix and pass on the working tree.
#
# Red baselines differ per probe, because each one describes the tree it was
# written against: `r6-outlet-probe` describes the R-4 tree (= HEAD), while
# `credential-window-probe` describes the tree BEFORE R-4 (eval leaking inside
# the window) and therefore needs an explicit `--ref`.
#
# Requirements: Linux + xvfb-run (the Electron-less regression lock lives in
# tests/audit-0913.spec.ts / tests/audit-r6-outlets.spec.ts and runs in `vitest run`).
set -euo pipefail
cd "$(dirname "$0")/../.."   # packages/host/browser
PKG_ROOT="$PWD"
REPO_ROOT="$(cd "$PKG_ROOT/../../.." && pwd)"
ELECTRON="${ELECTRON:-$PKG_ROOT/node_modules/electron/dist/electron}"
PROBE_DIR="${PROBE_DIR:-$PKG_ROOT/node_modules/.probe-out}"
PRISTINE=0
PRISTINE_REF=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pristine) PRISTINE=1 ;;
    # Red baseline for a probe whose `*.red.*` assertions encode an OLDER defect:
    # `credential-window-probe` describes the pre-R-4 tree (eval leaking inside
    # the window), which stopped being HEAD when R-4 was committed — run it with
    # `--pristine --ref HEAD~1`. `r6-outlet-probe` describes the R-4 tree, i.e.
    # plain HEAD.
    --ref) shift; PRISTINE_REF="${1:-}" ;;
  esac
  shift
done
mkdir -p "$PROBE_DIR"

if [ ! -x "$ELECTRON" ]; then
  echo "electron binary not found at $ELECTRON" >&2
  exit 2
fi

PROBES="frame-index-probe outlet-egress-probe credential-window-probe r6-outlet-probe"
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
  PRISTINE_REF="${PRISTINE_REF:-HEAD}"
  SCRATCH="$(mktemp -d "$PKG_ROOT/tests/.pristine-XXXXXX")"
  mkdir -p "$SCRATCH/src" "$SCRATCH/tests"
  cp -r tests/probes "$SCRATCH/tests/probes"
  for f in $(git -C "$REPO_ROOT" ls-tree -r --name-only "$PRISTINE_REF" packages/host/browser/src/ | sed 's|packages/host/browser/src/||'); do
    mkdir -p "$SCRATCH/src/$(dirname "$f")"
    git -C "$REPO_ROOT" show "$PRISTINE_REF:packages/host/browser/src/$f" > "$SCRATCH/src/$f"
  done
  RUN_ROOT="$SCRATCH"
  # Which probes carry a red polarity against THIS revision: `r6-outlet-probe`
  # against HEAD (the R-4 tree it was written against), and additionally
  # `credential-window-probe` when an explicit older ref is given.
  PROBES="r6-outlet-probe"
  if [ -n "$PRISTINE_REF" ] && [ "$PRISTINE_REF" != "HEAD" ]; then
    PROBES="credential-window-probe r6-outlet-probe"
  fi
  PROBE_EXPECT="red"
  echo "== pristine ($PRISTINE_REF) sources: $SCRATCH =="
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
