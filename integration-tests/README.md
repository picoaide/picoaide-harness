# 集成测试（非 CI）

本目录存放企业登录/权限/品牌改造（v3b）的集成测试。**不进入 CI**（需 Docker + 真实服务端 + 截图环境），手动/本地运行。

## 组成

| 目录/文件 | 用途 |
|---|---|
| `dex/` | Dex SSO 集成测试（docker 起 Dex → 服务端配 OIDC → 验证登录流） |
| `openldap/` | OpenLDAP 集成测试（docker 起 LDAP → 服务端配 LDAP → 验证登录） |
| `electron-shots/` | 真实 Electron + Xvfb + CDP 截图验证（客户端登录页/品牌/权限） |
| `run-all.sh` | 一键跑全部（服务端地址取 `SERVER_BASE`，默认 `http://127.0.0.1:8091`；逐项收集结果，任一失败以非零退出） |

## 前置

- Docker（Dex `ghcr.io/dexidp/dex` 监听 127.0.0.1:5556、OpenLDAP `osixia/openldap:1.5.0` 监听 127.0.0.1:1389）
- 已在 `http://127.0.0.1:8091` 运行的服务端，且已配好 OIDC（Dex）与 LDAP（服务端自身需要 PostgreSQL，脚本不直接连库）
- Electron 桌面包已构建（`packages/host/desktop/dist/`，`electron-shots` 需要 `dist/linux-unpacked/`）与 Xvfb `:99`

> 脚本读取的环境变量只有 `SERVER_BASE`（`run-all.sh`）与命令行参数（`--server` / `--shots`）；
> 各 Python 脚本只接受服务端地址位置参数，**不读** `PG_DSN` / `PG_DSN_TEST` / `DEX` / `LDAP`。

## 运行

```bash
cd integration-tests
./run-all.sh
```
