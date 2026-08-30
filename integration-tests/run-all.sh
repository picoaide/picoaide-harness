#!/usr/bin/env bash
# 集成测试一键运行(非 CI): 需 Docker + 真实服务端。
# 前置: dex-test/ldap-test 容器已起, 服务端 8091 已配 OIDC+LDAP。
set -e
cd "$(dirname "$0")"
echo "=== 1. Dex SSO 流程测试 ==="
python3 dex/dex-sso-test.py http://127.0.0.1:8091 || echo "Dex SSO: 见上方(深链由桌面客户端接收)"
echo
echo "=== 2. LDAP + RBAC + 品牌集成测试 ==="
python3 openldap/ldap-rbac-brand-test.py http://127.0.0.1:8091
echo
echo "=== 3. Electron 截图验证(需打包 app) ==="
node electron-shots/electron-shots.mjs
