# 决策：客户端禁止使用任何代理（2026-09-22）

**状态**：已实施（`feat/client-no-system-proxy`）
**影响面**：`packages/host/desktop`（启动期开关 + 环境清理 + 渠道字段）
**实证**：`temp/proxy-probe/`（探针与矩阵，可复跑）

## 1. 决策

客户端**默认禁止使用任何代理**：宿主机配置了系统代理、代理环境变量、PAC/WPAD 自动发现，
或给了 `--proxy-server`，客户端一律直连。唯一例外是**显式配置**：

| 层 | 开关 | 语义 |
|----|------|------|
| 环境变量（排障/临时） | `PICOAI_ALLOW_SYSTEM_PROXY=1` | 允许使用宿主机代理；`=0` 显式禁止（压过渠道配置） |
| 渠道包（部署级） | `desktop.allow_system_proxy: true` | 允许使用宿主机代理（只认严格布尔 `true`） |
| 缺省 | —— | 禁止 |

取值来源是**随包**的：经代理才能出网的部署里，客户端连不上服务端时恰恰需要这个开关生效，
所以它不能靠服务端下发。环境变量只认真实进程环境（`app.whenReady()` 之前就要定下来，
Harness home 的 `.env` 分层结构上赶不上）。

## 2. 为什么（实测，非推断）

装置：本机记录型 HTTP 代理 + 记录型 origin；目标用不可解析域名，
"代理应答 = 走了代理 / `ERR_NAME_NOT_RESOLVED` = 直连"（细节见 `temp/proxy-probe/REPORT.md`）。

| 观察 | 结果 |
|------|------|
| 默认（宿主机代理环境变量在场） | 默认 session 与**后建的浏览器分区**都解析成 `PROXY`，请求体真的到代理；连 Chromium 自身组件流量（`redirector.gvt1.com`）都被送进宿主机代理 |
| 只对默认 session `setProxy({mode:'direct'})` | 默认 session 直连，**分区仍走代理** ⇒ 会漏掉内置浏览器、WASM 应用窗口、每个按用户新建的 partition |
| `app.commandLine.appendSwitch('no-proxy-server')` | 全部 session/分区 `DIRECT`，请求不再到代理；本机 loopback UI 不受影响 |
| 宿主机显式 `--proxy-server` | 单独用会跟随；**与 `no-proxy-server` 同用时直连胜出** |
| 宿主机 `--proxy-bypass-list=<-loopback>`（取消 loopback 旁路） | 单独用时连本机 UI 都会被送进代理；加 `no-proxy-server` 后回到直连 |
| 主进程 Node（undici） | 默认直连；宿主机设 `NODE_USE_ENV_PROXY=1` 时走代理，**事后删环境变量无效**（Node 启动时已构造 agent），换 `undici.setGlobalDispatcher(new Agent())` 才撤掉 |

覆盖面：`gatewayFetch`（登录 / bootstrap / 渠道 / 能力中心 / 用量 / 遥测 / 错误上报 / WASM 应用编排）、
更新检查与下载的 `net.fetch`、渲染进程加载的渠道 logo、内置浏览器分区、WASM 应用窗口与平台出站。

## 3. 实现（三刀）

1. **Chromium 一刀**：`main.ts` 模块作用域 `applySystemProxyPolicy(app.commandLine, …)`
   → `appendSwitch('no-proxy-server')`。必须早于 `app.whenReady()`（晚一行 Chromium 已经读过代理配置，
   append 静默无效）。
2. **Node 一刀**：`start()` 里 `loadLayeredEnv()` 之后，若宿主机设了 `NODE_USE_ENV_PROXY`，
   把 undici 全局 dispatcher 换成直连 `Agent`。`undici` 因此从传递依赖升为**显式声明**的依赖
   （声明边 = 实测边）。
3. **子进程一刀**：同一处 `stripProxyEnvironment(process.env)` 删掉大小写两套
   `HTTP(S)_PROXY`/`ALL_PROXY`/`NO_PROXY` 与 `NODE_USE_ENV_PROXY` —— agent 的 shell
   子进程（curl/git/npm/MCP stdio）由 `scrubbedParentEnv()` 从 `process.env` 派生，只滤敏感名与
   `DSH_` 前缀，代理名会原样继承。放在 `loadLayeredEnv()` **之后**，连 home `.env` 注入的代理名一起清。

启动日志头新增 `proxy direct|system/<source>` 字段，支持排障时一眼看出本次启动的出口策略；
清理掉代理环境变量、或显式开启了代理时各记一行日志。

## 4. 代价（有意接受）

- **内置浏览器（AI 浏览器）失去系统代理**：在"只有经代理才能出公网"的办公网里，AI 浏览器访问外网会失败。
  需要它的渠道用 `desktop.allow_system_proxy: true` 换回旧行为（那时全客户端都跟随代理）。
- WASM 应用窗口、更新检查同样直连 —— 它们访问的都是自家服务器，正常部署下无障碍。
- 安全侧收益：Charles/Fiddler 这类"改系统代理 + 装根证书"的抓包路径被掐断（它们默认就是改系统代理）。

## 5. 管不到的（认账）

- **L3/TUN / 透明代理 / VPN / 出口设备**：应用层开关管不到，流量照样被接走。本开关关的是"应用级代理配置"
  （系统代理设置、代理环境变量、PAC/WPAD、`--proxy-server`）。反过来，Clash TUN + fake-IP 环境行为不变
  （流量本来在 L3 被接走），`patches/dsh-web-fetch-http` 的 fake-IP 兼容结论不受影响。
- 宿主机用别的手段注入代理（例如 TLS 中间盒）属另一层问题，对策是证书 pin
  （`packages/host/enterprise/src/server-connector/tls.ts`），不是本开关。
- `LaunchEnvironmentSnapshot` 里由 home `.env` 声明的代理名仍留在快照中（live `process.env` 已清）。
  没有任何路由消费它；若日后有插件显式读快照里的 `HTTP_PROXY`，需要重新评估。

## 6. 验证链

- **单测 + 源码级接线守卫**：`packages/host/desktop/tests/network-policy.spec.ts`
  （判定顺序与真值表、环境清理、dispatcher 替换、渠道字段严格布尔；并断言 `main.ts` 的 append
  早于 `await app.whenReady()`、清理早于 `await boot(`）。变异验证：删开关接线 / 删环境清理 /
  把开关挪到 ready 之后，三种改法分别让 2 / 1 / 1 条用例变红。
- **构建产物级真机探针**（需显示器）：
  `cd packages/host/desktop && yarn build && xvfb-run -a yarn probe:proxy`
  —— 用真实 Electron 装载构建出的 `lib/network-policy.js`，在"宿主机到处配了代理"
  （`--proxy-server` + 三个代理环境变量 + `NODE_USE_ENV_PROXY=1`）下断言：默认 session 与分区都
  `DIRECT`、请求从未到达记录型代理、Node fetch 直连；并带一个**反向对照**（跳过开关必须看到代理命中，
  否则判探针假绿）。当前 9/9 通过。
- **真机矩阵（调查阶段的证据）**：`cd temp/proxy-probe && bash run.sh`（5 个 Chromium mode）+
  `node-probe2.cjs` / `node-probe3.cjs`（Node 三个 mode）。

## 7. 后续可做

- 把渠道字段的**形状校验**加进 `scripts/ci-channels.sh`（写错成字符串时目前静默按"禁止"处理，
  方向安全但不提示）。
- `e2e-client` 还没有"代理"这一维（探针独立于它，不进 `yarn check`）；若要把这一维并进 CI 的
  Linux desktop job，可直接复用 `scripts/proxy-policy-probe.mjs` 的装置。
- 若客户部署确需代理：在渠道包配 `desktop.allow_system_proxy: true`，并考虑只对内置浏览器放行
  （按 partition 逐会话设置，实现更复杂）。
