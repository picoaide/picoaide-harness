# dsh-memory-evolve vendored 说明

## 来源与当前基线

- 上游仓库：https://github.com/csyangwen/dsh-memory-evolve
- 当前基线：`b4994fa`（tag `v26090901`，2026-09-09），2026-09-11 从 `1e6e7eb`（v26082401 后）升级。
- 同步方式：`git -C <upstream-clone> archive b4994fa | tar -x -C packages/vendor/memory-evolve`，
  然后重放下方本地补丁（上游把 `lib/` 作为发布产物提交，lib 与 src 同步更新）。
- 上游 remote 仍配置在本仓库：`git fetch dsh-memory-evolve && git merge`（历史说明见提交 8bdd028607）。

## 本地补丁（升级时必须重放）

1. **`package.json`**：`dsh.client.inject` 改为 `@deepseek-ai/dsh-client-store`
   （桌面宿主 DSH 导出名与上游 `dsh-client-runtime` 不同，提交 346fdfb017）。
2. **`lib/skills-manager.js`**：`/skills-manager` 路由加本地信任栅栏
   （F6 审计：此前没有任何本地信任边界）。复核增强：除 loopback socket+Host+
   Origin 外，支持 `webRuntime.trustedHosts` 中已声明的局域网权威（`dsh web
   --host 0.0.0.0` 模式），伪造 loopback Host 仍拒绝；配套测试见
   `tests/skills-manager.test.js` 的 trustedHosts 用例。
3. **`lib/skills.js`**：技能采纳的 Windows `EBUSY/EPERM/EACCES/ENOTEMPTY` 降级为
   复制+删除，且**合并语义**（不覆盖目标目录既有用户数据），提交 b81b62d174/a26191b9b7。
4. **`lib/api.js`**：pending-skills approve 路由把文件系统错误包装为友好提示
   （不向前端抛原始堆栈）。
5. **`src/client/mermaid-render.ts`**：subgraph 标题正则去重（提交 f8fd905d49）。
6. **`tests/skills.test.js` / `tests/skills-fault.test.js` / `tests/fixtures/`**：上述
   Windows 修复的回归测试（本地独有）。
7. **git locale 稳定性（2026-09-11 复核新增，建议上游吸收）**：
   `lib/sync/repo.js`/`identity.js`/`index.js`/`worker.js` 的 git 子进程统一
   `LC_ALL=C LANG=C`。中文 locale 下 git 输出「无法找到远程引用」会让 worker 的
   英文正则 `couldn't find remote ref` 失配，把"远端分支不存在/首次推送"误报为
   致命拉取错误（本环境实测复现并修复）。
8. **`tests/search-docs.test.js`**：平台断言自适应（`/Volumes`、`mdfind` 优先序、
   provider 链）在非 darwin 环境跳过/放宽，不再让测试套件依赖 mac 物理机。

## 验证

- 全量：`node --test 'tests/*.test.js'` → **810 tests / 810 pass / 0 fail**
  （升级前同一环境为 27 项失败：git locale 与平台断言）。
- 桌面宿主：`dsh-plugin-desktop` 的 prebuild/profile 组装会读取本包
  `cordis.patch.yml` 与 `lib/`，升级后随桌面包构建验证。
