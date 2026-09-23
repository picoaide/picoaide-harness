#!/usr/bin/env bash
# 集成测试一键运行(非 CI): 需 Docker + 真实服务端。
# 前置: dex-test/ldap-test 容器已起, 服务端 8091 已配 OIDC+LDAP。
#
# 退出码契约(2026-09-23 审计 W3 修订):
#   0  = 至少一项真正跑过且全部通过;
#   1  = 有失败项(逐项收集,单项退出码不再丢失 —— P2-54);
#   77 = **一项都没跑起来**(全部 SKIP:环境缺失)。"什么都没验证"绝不能报 PASS ——
#        单项脚本在服务端/Dex/LDAP 缺失时以 77 显式 SKIP,本脚本据此给出 SKIP 汇总。
cd "$(dirname "$0")"

SERVER_BASE="${SERVER_BASE:-http://127.0.0.1:8091}"
failures=0
skipped=0
passed=0
results=()

run() {
  local name="$1"; shift
  echo "=== ${name} ==="
  "$@"
  local code=$?
  case "$code" in
    0) results+=("PASS  ${name}"); passed=$((passed + 1)) ;;
    77) results+=("SKIP  ${name} (环境缺失,未验证任何东西)"); skipped=$((skipped + 1)) ;;
    *) results+=("FAIL  ${name} (exit ${code})"); failures=$((failures + 1)) ;;
  esac
  echo
}

run "1. Dex SSO 流程测试" python3 dex/dex-sso-test.py "$SERVER_BASE"
run "2. LDAP + RBAC + 渠道集成测试" python3 openldap/ldap-rbac-brand-test.py "$SERVER_BASE"
run "3. Electron 截图验证(需打包 app)" node electron-shots/electron-shots.mjs --server "$SERVER_BASE"

echo "========== 汇总 =========="
printf '%s\n' "${results[@]}"
echo "通过 ${passed} ｜ 失败 ${failures} ｜ 跳过 ${skipped}"
if [ "$failures" -ne 0 ]; then
  echo "RESULT: FAIL(${failures} 项失败)"
  exit 1
fi
if [ "$passed" -eq 0 ]; then
  echo "RESULT: SKIP(一项都没跑起来:${skipped} 项因环境缺失跳过)"
  exit 77
fi
echo "RESULT: PASS(${passed} 项通过${skipped:+,${skipped} 项跳过})"
exit 0
