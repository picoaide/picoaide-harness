#!/bin/bash
# For each "file:line:col SYMBOL" candidate, grep repo-wide for SYMBOL
# Skip node_modules, lib/, dist/, .research, .audit, temp, deepseek-harness
SEARCH_DIRS="packages server site scripts integration-tests community docs .github assets"
grep -vE "^(Unused|Duplicate|$)" "$1" | sed -E 's/^[A-Za-z ]+ *//' > /dev/null
