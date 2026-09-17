# 决策：只改文档时跳过全量 CI（2026-09-17）

## 背景

`ci.yml` 在每次 `pull_request` / `push` 上跑全量门禁（Gate 全 workspace 构建+测试、Go server、三平台打包）。
纯文档改动（`docs/`、`site/`、`*.md`）也要跑 7 分钟以上，且实测会撞上 connectors 套件的负载敏感
竞态——本次一份纯文档 PR 因此在 Gate 上连红两次，只能靠 `gh run rerun --failed` 过关。

## 决策

**只改文档时不跑重活；用「job 级条件跳过」，不用「workflow 级路径过滤」。**

| 手段 | 结果 |
|---|---|
| `on.pull_request.paths-ignore` | ❌ 关联检查停在 **Pending**，受保护分支的 PR **永远合不了**（GitHub 官方文档 "Troubleshooting required status checks" 明确写：不要对必需检查用路径过滤） |
| job 级 `if:` 跳过 | ✅ 该 job 报告 **Success**（官方文档：`success` / `skipped` / `neutral` 都算通过） |

## 实现（`.github/workflows/ci.yml`）

1. 新增永远运行的 `changes` job（约 5 秒）：取本次 diff 的文件名，**全部**落在 `docs/**`、`site/**`、`*.md` 之内 ⇒ `code=false`。
   - `refs/tags/*` 一律 `code=true`（发布链必须完整跑，且 tag 的 `before` 常是全零）。
   - base 未知 / 空 diff / 检测异常 ⇒ `code=true`（fail-safe，宁可多跑）。
2. `gate`、`server`、`desktop-linux/windows/macos` 加
   `if: needs.changes.result != 'success' || needs.changes.outputs.code == 'true'`
   —— `changes` 自身失败时也照跑全量，避免"检测挂了 ⇒ 全跳过 ⇒ 无门禁合并"。
3. `pr-summary` 改 `if: always()`，docs-only 时改为发一条"本次只改文档"的说明评论。

## 影响

- 文档 PR 的必需检查全部显示为 skipped（分支保护按通过计），合并不受影响；PR 上会有一条说明评论。
- 任何非文档文件（含 `packages/**`、`server/**`、`scripts/**`、`*.json`、`*.yml`…）出现即回到全量 CI。
- tag 事件不受影响；`release` job 仍依赖全量 job。

## 复现/验证

- 静态守卫：`node scripts/check-workflows.mjs`（解析 YAML + 42 个 shell run 块 `bash -n`）。
- 判据自测：对真实提交区间跑一遍文件名判定（文档提交 ⇒ `code=false`；含 `packages/host/...` 的提交 ⇒ `code=true`）。
