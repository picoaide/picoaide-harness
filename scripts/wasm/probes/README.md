# scripts/wasm/probes —— 协议/平台事实探针（WASM 客户端专属改造）

> 归属：L4（验证脚本与渠道泳道）。权威设计：`docs/planning/2026-09-19-wasm-client-only-design.md`
> §2.3（实测事实）/ §13（判据）/ §16 W0-C·W0-D·W6（探针波次与三平台）。
> 台账：`docs/planning/2026-09-19-wasm-client-only-findings-ledger.md`（TST-1/3/15、R2T-13/14/15）

## 为什么必须入库

早期探针散在 gitignore 的 `temp/` 里（R1-TST-12/R2T-3），审计者与 CI 复现不了；而且
调用方曾用 `grep VERDICT` 判绿 —— 既可能假红，也可能退化成"存在性断言"（TST-1）。
本目录的每条探针都**自己按期望值判定并设退出码**，门禁只读退出码。

## 约定（新探针必须照此写）

1. **自判定 + 退出码**：`0` = 期望值全部满足；`1` = 有断言不满足（打印 `ASSERT {failed:[…]}`）；`77` = **显式 SKIP**（平台未覆盖等，见下）。
2. **禁止静默跳过**：跑不起来（无显示器/无 Electron）必须是失败，不是通过；确实不该跑的（例如 Windows/macOS 未覆盖）要打印 `[skip]`/`[skip-note]` 并以 77 收尾。
3. **平台覆盖声明**：所有探针打印 `[skip-note]`（非 Linux）并在 `VERDICT` 里给 `platform`/`platformCovered`。理由：§17 认账第 1 条 —— Windows/macOS 的自定义协议行为尚未实测，Linux 单次运行的结论**不是**三平台判据（R2T-8/R2T-13）。需要"未覆盖平台一律不产出结论"时设 `PROBE_REQUIRE_COVERED_PLATFORM=1`。
4. **CSP 违规监听用 Electron 43 的 details 对象**（位置参数已废弃；R2T-14），并放一条金丝雀违规确认监听真的在工作。
5. 运行方式（门禁第 6 组逐条照做，`xvfb-run -a` **与探针同一条命令**）：

```bash
xvfb-run -a --server-args="-screen 0 1280x800x24" \
  env HOME=/tmp/wasm-gate-home XDG_CONFIG_HOME=/tmp/wasm-gate-home/.config \
      ELECTRON_DISABLE_SECURITY_WARNINGS=1 \
      timeout 180 packages/host/desktop/node_modules/.bin/electron \
      --no-sandbox --disable-gpu scripts/wasm/probes/<probe>.cjs
```

## 现有探针

| 探针 | 覆盖 | 判据要点 |
| --- | --- | --- |
| `probe-custom-scheme.cjs` | W0-C：`<app-scheme>://<app_id>/` 能否作为应用 origin | handler 服务内容 / `origin = scheme://host` / secure context / 同源 fetch 与**原生表单 POST** 到达 handler / 跨应用被拦 / **Cookie 不可用** / 302 透传 / 子资源走 handler / 负向：无 `Origin`、无 `Sec-Fetch-*` |
| `probe-custom-scheme-2.cjs` | W0-C2：平台真实约束 | 生产 CSP 逐字放行（`'self'` 解析成应用 origin）/ `persist:` 分区内注册 handler 后可用 / **客户端 UI（http 源）不能 fetch 应用 origin** |
| `probe-web-storage.cjs` | W0-D：浏览器存储（F13） | `localStorage`/`sessionStorage`/`IndexedDB` 可用性 + **按 app origin 隔离** + 与客户端 UI 隔离 + 同 origin 同分区往返 + **跨 persist: 分区隔离**；`W0D-14` = **反向期望**（`cache.put()` 被拒且错误含 scheme 不支持 ⇒ PASS；竟然成功 ⇒ FAIL，口径需重新裁定） |
| `probe-app-scheme-gate.cjs` | R1-L2-1：session 级 `webRequest.onBeforeRequest` 闸门真的生效 | pattern `<scheme>://*/*` 触发 6 次；**装闸门后** http 页 / 应用 B 页发起的应用 scheme 请求 ⇒ handler 增量 **0**（对照阶段各 1）；应用窗口自身 **+2**（正例对照）；白名单谓词按窗口判真假 |

> `probe-web-storage.cjs` 与 `probe-app-scheme-gate.cjs` 由 **L2** 产出、由 L4 **收编**到本目录
> （同一实现不另写一份，避免分叉；收编记录与源 sha256 见 `temp/wasm-client-only/L4-ADOPTED.md`，
> temp 版标注为已作废）。门禁第 6 组按"发现的探针集合"运行 —— 新探针落进本目录即自动纳入。
> 现状：**4/4 PASS**（`temp/wasm-client-only/L4-probes-final.log`）。

## 覆盖矩阵（必须认账的空白）

| 平台 | W0-C / W0-C2 / W0-D | 结论效力 |
| --- | --- | --- |
| Linux（本仓 CI / 开发机） | 已跑（Electron 43.4.0 + xvfb；4 条探针全部 0 退出） | 有效，但**单平台单次**运行；证据随 `temp/wasm-client-only/gate-logs/probe-*.log` 归档 |
| Windows | **未实测** | 不得作为验收证据；`registerSchemesAsPrivileged` 时序、分区注册、无 Origin/无 Cookie 四条待 W6 复核 |
| macOS | **未实测** | 同上 |

三平台复核（§16 W6）与本目录的 `platformCovered` 标记是同一件事的两端：门禁在非 Linux 上
要么显式 SKIP（77），要么照常跑但结论标注"未覆盖"。
