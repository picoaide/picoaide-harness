# 集成测试（非 CI）

本目录存放企业登录/权限/品牌改造（v3b）的集成测试。**端到端跑需要 Docker + 真实服务端 + 截图环境**，
因此它们不在 CI 里整跑；但**可静态执行的那部分已进门禁**（见下方「门禁覆盖」）。

## 组成

| 目录/文件 | 用途 |
|---|---|
| `dex/` | Dex SSO 集成测试（docker 起 Dex → 服务端配 OIDC → 验证登录流） |
| `openldap/` | OpenLDAP 集成测试（docker 起 LDAP → 服务端配 LDAP → 验证登录/RBAC/渠道内容） |
| `electron-shots/` | 真实 Electron + Xvfb + CDP 截图验证（客户端登录页/品牌/权限） |
| `run-all.sh` | 一键跑全部（服务端地址取 `SERVER_BASE`，默认 `http://127.0.0.1:8091`；逐项收集结果） |

## 退出码契约（2026-09-23 起）

| 码 | 含义 |
|---|---|
| `0` | 通过（该项**真的跑过**且契约全部满足） |
| `1` | 失败（契约不满足 / 断言不成立） |
| `2` | 用法错误（未知参数等） |
| `77` | **SKIP：环境缺失，未验证任何东西**（服务端不可达 / 该登录方式未配置 / 打包产物缺失 / 没有可用 X 显示） |

- SKIP 只对"环境没起来"生效，**不会**把失败降级成跳过；`run-all.sh` 的聚合规则是
  「有失败 ⇒ 1；否则一项都没跑起来 ⇒ **77**；否则 0」——**"什么都没验证"绝不报 PASS**。
- `--self-test` 是判据自检（每条判据都配负例，证明它有判别力），**不需要**任何服务端/Docker，
  也是门禁实际执行的那条路径。
- 三个用例脚本都遵守同一张表。`electron-shots.mjs` 在启动应用**之前**依次探测
  「打包产物 → X 显示 → 服务端 `/healthz`」，任一缺失即 `SKIP(77)` 并打印原因与处置；
  只有三项都在才会真跑（此时断言失败才是 `1`）。

## 门禁覆盖

`corepack yarn check` 里的 `check:integration-tests`（`scripts/check-integration-tests.mjs`）会：
① 对 `integration-tests/**/*.py` 逐个做语法解析、对 `**/*.mjs` 逐个 `node --check`；
② 跑两个契约脚本的 `--self-test`；
③ 用**进程内假网关**（按真契约应答）驱动两个脚本：正例必须绿、破坏契约必须红、
provider 未配置必须 SKIP 且不得报 PASS；
④ 断言 `electron-shots` 的**接线**（`run-all.sh` 真的调用它、脚本里保留截图/判定/退出码判据）
与其 **SKIP 契约**（`--app <不存在>` ⇒ 77 且不打印 PASS）；
⑤ 跑一次聚合层 `run-all.sh`（三项全 SKIP 的输入）断言 `77` + `RESULT: SKIP`。
它不需要 Docker/PG/显示器，秒级完成。

## 前置

- Docker（Dex `ghcr.io/dexidp/dex` 监听 127.0.0.1:5556、OpenLDAP `osixia/openldap:1.5.0` 监听 127.0.0.1:1389）
- 已在 `http://127.0.0.1:8091` 运行的服务端，且已配好 OIDC（Dex）与 LDAP（服务端自身需要 PostgreSQL，脚本不直接连库）
- Electron 桌面包已构建（`packages/host/desktop/dist/`，`electron-shots` 需要 `dist/linux-unpacked/`）与 Xvfb `:99`
- `python3`（两个 Python 脚本；`check:integration-tests` 也需要它，缺 python3 时门禁**判失败**而不是静默跳过）

> 环境变量：`SERVER_BASE`（`run-all.sh`）与命令行参数（`--server` / `--shots` / `--app` / `--display`）；
> `ELECTRON_SHOTS_APP` 覆盖 `electron-shots` 的打包产物路径（CI 用），`DISPLAY` 指定 X 显示。
> Python 脚本只接受服务端地址位置参数，另可选读 `DEX_BASE`（断言 IdP origin）、
> `DEX_DEEP_LINK_SCHEME`（断言深链 scheme）、`DEX_EXPECTED_USER`（期望账号）。
> **不读** `PG_DSN` / `PG_DSN_TEST`。

## 运行

```bash
cd integration-tests
./run-all.sh                      # 全部（退出码见上表；缺前置的项以 77 计入 SKIP）
python3 dex/dex-sso-test.py       # 单项；`--help` 看参数
python3 openldap/ldap-rbac-brand-test.py --self-test   # 只跑判据自检
node electron-shots/electron-shots.mjs --app packages/host/desktop/dist/linux-unpacked/dsh-plugin-desktop
```

### 真机端到端怎么接（当前**未**接进 CI，留可执行入口）

真机跑需要 Docker + 真实服务端 + Xvfb，本仓 CI runner 目前不提供，所以它仍是**手动入口**；
接线方式已定，任何具备前置的机器上按下面三步即可跑通（并可用同一个命令接进 CI job）：

```bash
# 1) 起显示（本机无物理显示器时）
Xvfb :99 -screen 0 1440x900x24 &                # 后台常驻；DISPLAY=:99
# 2) 起前置：Dex / OpenLDAP 容器 + 已配 OIDC/LDAP 的服务端（见「前置」）
# 3) 一键跑（聚合退出码：0 全通过 / 1 有失败 / 77 全 SKIP）
SERVER_BASE=http://127.0.0.1:8091 bash integration-tests/run-all.sh
```

- **缺前置时不会假装跑过**：每项自己探测前置并以 `77` 显式 SKIP（`run-all.sh` 汇总成
  `RESULT: SKIP`），与"断言失败（1）"和"通过（0）"在退出码上可区分 —— CI 里可以据此
  把"环境没起来"和"契约坏了"分开处置（例如前者只告警、后者阻塞）。
- CI 接法（示例，未入库）：加一个仅 `workflow_dispatch` / 定时触发的 job，起 Docker 服务与
  Xvfb 后执行上面第 3 步，并把 `run-all.sh` 的退出码分三档处置。

