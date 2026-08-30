#!/usr/bin/env bash
# usage: verify-sym.sh SYMBOL FILE
# Counts repo-wide references to SYMBOL outside definition file, excluding build/vendor dirs.
SYMBOL="$1"; FILE="$2"
PAT="[^A-Za-z0-9_]$SYMBOL[^A-Za-z0-9_]|^$SYMBOL[^A-Za-z0-9_]|[^A-Za-z0-9_]$SYMBOL\$|^$SYMBOL\$"
DIRS="packages server site scripts integration-tests community docs .github assets"
EXCL=(--exclude-dir=node_modules --exclude-dir=lib --exclude-dir=dist --exclude-dir=.research --exclude-dir=.audit --exclude-dir=temp --exclude-dir=.smoke --exclude-dir=.dsh-home --exclude-dir=.codeql-dbs --exclude-dir=memory-evolve)
TOTAL=$(grep -rE "$PAT" "${EXCL[@]}" $DIRS 2>/dev/null | grep -v "$FILE" | wc -l)
OTHER=$(grep -rEl "$PAT" "${EXCL[@]}" $DIRS 2>/dev/null | grep -v "$FILE" | grep -vE "deepseek-harness" | wc -l)
echo "REF_FILES=$OTHER REF_LINES=$TOTAL"
