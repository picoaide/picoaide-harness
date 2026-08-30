# 集成测试（非 CI）

本目录存放企业登录/权限/品牌改造（v3b）的集成测试。**不进入 CI**（需 Docker + 真实服务端 + 截图环境），手动/本地运行。

## 组成

| 目录/文件 | 用途 |
|---|---|
| `dex/` | Dex SSO 集成测试（docker 起 Dex → 服务端配 OIDC → 验证登录流） |
| `openldap/` | OpenLDAP 集成测试（docker 起 LDAP → 服务端配 LDAP → 验证登录） |
| `electron-shots/` | 真实 Electron + Xvfb + CDP 截图验证（客户端登录页/品牌/权限） |
| `run-all.sh` | 一键跑全部（需 `PG_DSN`、`DEX`、`LDAP` 环境） |

## 前置

- Docker（Dex `ghcr.io/dexidp/dex`、OpenLDAP `osixia/openldap:1.5.0`）
- PostgreSQL（测试用 `PG_DSN_TEST` 指向本机 127.0.0.1:15435 postgres:test）
- Electron 桌面包已构建（`packages/host/desktop/dist/`）

## 运行

```bash
cd integration-tests
./run-all.sh
```
