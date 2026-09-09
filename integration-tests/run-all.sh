#!/usr/bin/env bash
# 集成测试一键运行(非 CI): 需 Docker + 真实服务端。
# 前置: dex-test/ldap-test 容器已起, 服务端 8091 已配 OIDC+LDAP。
# P2-54: 原来 Dex 一行用 `|| echo` 吞掉失败 → 全挂也退出 0。改为逐项收集结果,
# 任一失败以非零退出并给出汇总(单项退出码不再丢失)。
cd "$(dirname "$0")"

SERVER_BASE="${SERVER_BASE:-http://127.0.0.1:8091}"
failures=0
results=()

run() {
  local name="$1"; shift
  echo "=== ${name} ==="
  if "$@"; then
    results+=("PASS  ${name}")
  else
    local code=$?
    results+=("FAIL  ${name} (exit ${code})")
    failures=$((failures + 1))
  fi
  echo
}

run "1. Dex SSO 流程测试" python3 dex/dex-sso-test.py "$SERVER_BASE"
run "2. LDAP + RBAC + 品牌集成测试" python3 openldap/ldap-rbac-brand-test.py "$SERVER_BASE"
run "3. Electron 截图验证(需打包 app)" node electron-shots/electron-shots.mjs --server "$SERVER_BASE"

echo "========== 汇总 =========="
printf '%s\n' "${results[@]}"
if [ "$failures" -ne 0 ]; then
  echo "RESULT: FAIL(${failures} 项失败)"
  exit 1
fi
echo "RESULT: PASS"
