# 内置 AI 浏览器 v4 —— 实施计划（P0→P2 → beta7 发布）

- 日期：2026-09-07
- 权威设计：docs/planning/2026-09-07-ai-browser-redesign.md（v4 定稿）
- 目标：将设计文档全部功能落地（32 工具 + 会话分组隔离 + v4 UI + 三 store + 生命周期 + P2 智能），全测试绿 + 真机验证截图 + 提交 v2.6.7-beta.7

## 任务分解

### P0 —— 分组骨架 + 外壳重构 + 健壮性基线
1. **src/common/errors.ts**（新）：TaggedError{code,message} + 全部错误码（no-session/foreign-tab/group-not-found/group-archived/group-quota/window-controlled/eval-policy/policy + 基础 taxonomy）
2. **src/resolve.ts**（新）：GroupKey 解析 + subagentIndex 血统表（registerLineage 对外；事件接入 P1）
3. **src/registry.ts**（新）：GroupRegistry（Group 元数据/状态机/配额 FIFO 队列/生命周期定时器/persist 钩子/订阅）
4. **src/runtime.ts**（改）：tabs→groups；GroupMutex + 全局用户闸；per-group busy；事件总线 on/off；opLog 加 session/actor；open/close/switch/… 全套组上下文；on("group-state") 推送
5. **src/eval-policy.ts**（新）：acorn AST 只读校验（expr 单表达式 + 白名单辅助函数注入 + 结果脱敏/截断）
6. **src/store.ts**（新）：BrowserStore（书签/历史/下载/组清单四 collection，JSONL+索引+保留策略+敏感剥离+session 标注）
7. **src/tools.ts**（改）：全部工具接组权限矩阵；list_tabs 组上下文；clear_data scope；takeover/release/clear_data 升级为工具；新增 wait_for/fill_form/upload_file/bookmarks×3/history_search/downloads×2/credentials_list；语义模板 render；删 browser_close/browser_new_tab；eval 走只读校验
8. **src/shell-pages.ts**（重写）：单页 shell（分组 TabStrip + Omnibox + AI 指示胶囊 + 活动面板浮层 + 空态 + 查看器入口）；删除 mask 页；SSE 推送替代轮询
9. **src/guard.ts + electron-adapter.ts**（改）：download 程序化（downloadsDir/冲突策略/上限，无对话框）；backgroundThrottling=false；render-process-gone 上报；删 createMaskView/透传链路
10. **src/index.ts**（改）：/state 返回 groups[]+window+控制权；/switch-group；/open 等 shell 路由绑定前台组；/stream SSE；注册三个 store 路由（书签/历史/下载/会话查看器 API）
11. **desktop 集成**：runtime 拿 userData 目录（store 根）；client 侧栏触发保持
12. 测试：resolve.spec / registry.spec / eval-policy.spec / store.spec / runtime.spec 扩展（组/并行/用户闸）/ permission（跨组）/ parallel（双会话）

### P1 —— 记忆/产物工具 + 生命周期
- 三 store 完成 + 组清单持久化；会话结束事件侦测（血统表升级）；归档 24h + 重开恢复；查看器 UI（书签/历史/下载）+ 组重命名 + 快捷键全量

### P2 —— 智能增强
- AI 计划预览（工具执行前摘要注入）；跨标签上下文（页面信息缓存）；企业策略矩阵（工具级禁用）；工具组动态激活

### 发布
- 版本 set 2.6.7-beta.7 → yarn check 全绿 → e2e-client 13/13 → 真机验证（user001）截图 → PR → 打 tag

## 验证环境
- 测试服务器：https://picoaide-next.kq0575.cn/（user001 / user001123456）
- E2E 工具：packages/host/desktop/scripts/e2e-client.mjs（mock gateway，可扩展 CDP 驱动）
- 截图：packages/host/desktop/.e2e-shots/ + temp/browser-v4-shots/
