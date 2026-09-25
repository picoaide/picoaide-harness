# 集成测试（非 CI）

本目录存放企业登录/权限/品牌改造（v3b）的集成测试。**端到端跑需要 Docker + 真实服务端 + 截图环境**，
因此它们不在 CI 里整跑；但**可静态执行的那部分已进门禁**（见下方「门禁覆盖」）。

## 组成

| 目录/文件 | 用途 |
|---|---|
| `dex/` | Dex SSO 集成测试（docker 起 Dex → 服务端配 OIDC → 验证登录流） |
| `openldap/` | OpenLDAP 集成测试（docker 起 LDAP → 服务端配 LDAP → 验证登录/RBAC/渠道内容） |
| `electron-shots/` | 真实 Electron + Xvfb + CDP 截图验证（客户端登录页/品牌/权限）。判据本体在 `electron-shots/assertions.mjs`（运行期与门禁消费同一张表），`--self-test` 逐条判据跑正例 + 负例 |
| `contractkit.py` | **契约判据通道**：判据求值（`judge`）+ 失败计数（`Reporter`）+ 两个自证入口。两个 `.py` 与门禁消费同一份实现 —— 判定与计数不允许在各脚本里各写一份（那样"运行期还按不按判据判"就没有单一入口可查） |
| `run-all.sh` | 一键跑全部（服务端地址取 `SERVER_BASE`，默认 `http://127.0.0.1:8091`；逐项收集结果） |

## 判据纪律（2026-09-23 第十三轮审计 F-01，P0）

两个 `.py` 与 `electron-shots` **遵守同一套纪律**（此前只有 `electron-shots` 一条腿有）：

1. **判据表是唯一真源**：每条契约判据落成 `CRITERIA` 里的一条 `{id, name, evaluate}`；
   运行期**只按 id** 经 `contractkit.Reporter.report()` 求值，不在运行期代码里散写判据。
2. **每条判据都配正例 + 负例夹具**（`SELF_TEST_FIXTURES`）：
   `--self-test` 逐条跑，缺正例/缺负例/夹具结论不符都判失败
   ⇒ **把任何一条判据的 `evaluate` 掏成恒真都会当场红**。
3. **判定通道自证**：`--self-check` 把**全部夹具**经**运行期那条 `report()`** 求值
   ⇒ 掏空 `judge()`、只改计票侧、或把通道换成恒真包装都会红。
   （夹具层对"运行期不再按表判"是**盲的** —— 两层互补，缺一不可。）
4. **登记值对账**：`--dump-criteria` 输出判据 id 与逐 id 正/负例条数，由
   `scripts/check-integration-tests.mjs` 的 `CONTRACT_CRITERIA` 做**精确**对拍；
   增删判据或夹具都必须改登记值（登记值进 diff 才会被评审看见）。
5. **新增用例必须登记**：`integration-tests/**` 下每个 `.py` / `.mjs` / `.sh` 都要在
   `scripts/check-integration-tests.mjs` 的 `INTEGRATION_ENTRIES` 里登记角色；
   **登记了却不在 / 在却没登记 / 聚合层少调多调或换序 都红**。

> **为什么**：2026-09-23 之前把两个 `.py` 的运行期判据 14/17 条换成恒真 `check(name, [], '')`
> （其余一字不改）之后，`--self-test` 仍报 24/24、29/29，门禁照打「2 个契约脚本判据自检通过」、
> `REAL_GATE_EXIT=0` —— **判据的自我陈述比它实际判的东西宽**。
> 矩阵与原始输出：`temp/r13/GF/probe-f01.sh`（A 修前反例 / B 修后正例 / C 分层互补）。

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
② **登记制 + 聚合层双向对账**：`integration-tests/**` 下每个 `.py`/`.mjs`/`.sh` 都必须在
`INTEGRATION_ENTRIES` 里登记角色（登记了却不在 / 在却没登记都红），`run-all.sh` 的
`run "…" <runner> <路径>` 行与登记表里带 `aggregateName` 的条目**逐条逐字对拍（含顺序）**
—— 两个 `.py` 从聚合层摘线此前**零判据**（第十三轮 F-02/F-03）；
③ 跑两个契约脚本的 `--self-test`（判据本体自证）与 `--self-check`（判定通道自证），
并用 `--dump-criteria` 做**判据 id 精确集合 + 逐 id 正/负例条数**对账；
④ 静态判据：每条判据 id 都必须有"以该 id 字面量为首参"的调用点、被调方逐字是
`reporter.report`、观测非空（`{}` = 没把观测传进来）；每条判据的 `evaluate` 必须保留
变异注入锚点；
⑤ **契约端到端变异**（在临时副本里真跑，全部必须变红）：
· 逐条判据 `evaluate` 掏成 `return []` ⇒ `--self-test` 非零且**具名**咬住该判据（dex 7 条 + ldap 10 条）；
· `contractkit.judge()` 恒真 ⇒ `--self-check` 非零（而 `--self-test` 照旧绿 —— 证明两层互补）；
· 只改计票侧（`failures += 0`）⇒ `--self-check` 非零；
· 运行期通道换成恒真包装（id 引用一字未改）⇒ `--self-check` 非零；
⑥ 用**进程内假网关**（按真契约应答）驱动两个脚本：正例必须绿、破坏契约必须红、
provider 未配置必须 SKIP 且不得报 PASS；
⑦ 断言 `electron-shots` 的**接线**（`run-all.sh` 真的调用它、脚本里保留截图/判定/退出码判据）
与其 **SKIP 契约**（`--app <不存在>` ⇒ 77 且不打印 PASS）；
⑧ 跑 `electron-shots/assertions.mjs --self-test` 并把**判据表**三层钉住：判据 id 集合与登记
值精确相等、每条判据都有正例 + 负例夹具且夹具总数不低于下限、运行期脚本逐条引用每个 id；
⑨ 跑一次聚合层 `run-all.sh`（三项全 SKIP 的输入）断言 `77` + `RESULT: SKIP`；
⑩ **引用面扩展名对账**（第十四轮 B-04）：本守卫引用的每个**落盘**的 `integration-tests/**`
路径，扩展名必须落在扫描面（`.py`/`.mjs`/`.sh`/`.yaml`/`.yml`）内、或在
`INTEGRATION_REFERENCE_SCOPE_REGISTRY` 里逐条登记为非判据面 —— 否则红。
（`check-install-integrity` 的"执行体全集"就是按同一份扩展名集合从本守卫的文本里派生目标的，
引用面静默宽于扫描面时，那个文件会**两边都看不见**。）
⑪ **CI 执行面闭包**（第十四轮 E-02）：从 `.github/workflows/**` 的 `run:` 命令位出发，
沿**本地复合 action → manifest scripts 别名 → 仓内包装脚本 / `spawn`·`exec` 目标**闭包到
不动点，任何"真实前置"触达端到端入口的来源文件都必须登记（未登记即红；本守卫自己的
合成 SKIP 探针单列登记，不计入）；`.github/workflows/**` 的**文本面**命中数作为独立的
第二张网保留。⇒ 把 `run-all.sh` 经 `package.json` 别名 / 复合 action / 包装脚本接进 CI
（workflow 文本里一个 token 都没有）同样当场红。
它不需要 Docker/PG/显示器，秒级完成。

> **本守卫不覆盖什么（写清楚，别把"没测"读成"通过"）**：真机端到端（Docker + 真实服务端 +
> Xvfb）在 CI 语境下 **0 执行**；本守卫只判"可静态执行的那部分"——**通过行**逐项枚举它真的判了的 14 层，
> 并显式声明端到端不在覆盖面内。

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
python3 dex/dex-sso-test.py --self-test        # 只跑判据本体自检（每条的 正例 + 负例）
python3 dex/dex-sso-test.py --self-check       # 只跑判定通道自检（夹具经运行期 report() 求值）
python3 dex/dex-sso-test.py --dump-criteria    # 判据表登记值（JSON；门禁据此对账）
python3 openldap/ldap-rbac-brand-test.py --self-test   # 同上（另一个契约脚本）
node electron-shots/assertions.mjs --self-test         # 只跑判据表的夹具自检（门禁跑的路径）
node electron-shots/assertions.mjs --list              # 判据清单 + 条数
node electron-shots/electron-shots.mjs --app packages/host/desktop/dist/linux-unpacked/dsh-plugin-desktop
```

### 真机端到端怎么接（当前**未**接进 CI，留可执行入口）

> **CI 覆盖面声明（2026-09-23 第十三轮审计 F-03，2026-09-25 第十四轮 E-02 收紧口径）**：
> `check-integration-tests` 判的是**CI 执行面闭包**（workflow `run:` 命令位 → 本地复合
> action → manifest scripts 别名 → 仓内包装脚本 / `spawn`·`exec` 目标），闭包对端到端入口的
> **真实前置接线**命中 **0** 处 ⇒ 这个端到端面在 CI 语境下 **0 执行**；`.github/workflows/**`
> 的文本面命中同样是 0（两张面都由该守卫对拍，任一面变成非 0 都当场红 —— 包括"经
> `package.json` 别名接进来、workflow 文本里没有任何 token"这种形态）。处置**不是**往 CI 里塞一个跑不起来的 job（缺 Docker 服务与 Xvfb 时它只会
> 长期红或长期 SKIP，两者都比没有更糟）；建议是**显式声明为非 CI 覆盖面**：
> · 本 README 与守卫的通过行都明写"端到端不在门禁覆盖面内"（已落）；
> · 守卫**不得**以任何措辞声称端到端被门禁覆盖（**通过行**逐项枚举它真的判了的 14 层）；
> · 若要真接，按下面三步加一个 `workflow_dispatch` / 定时触发的 job，并把 `run-all.sh`
>   的三档退出码分开处置（0 通过 / 1 契约坏了要阻塞 / 77 环境没起来只告警）。
> 该拍板项已登记在修复报告里，等待定夺。

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

