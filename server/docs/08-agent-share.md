# 共享 Agent(agent_presets)

> 员工在 DSH 客户端「创造模式」创建的本地 Agent 预设可上传共享;管理员审核通过后**全员**可见可安装(无需逐人授权)。未通过或待审核内容对他人不可见。

## 1. 数据流

```
员工(创造模式创建本地 preset) → /api/pico/agent-presets/upload(host 打包)
  → POST /api/agent-presets(员工 Bearer,归档 base64) → agent_presets 表(status=pending)
管理员(webadmin 能力中心 /capabilities) → approve / reject / delete(全审计)
审核通过 → GET /api/agent-presets 全员可见 → /api/pico/agent-presets/:name/install
  → 下载归档(校验 x-preset-checksum)→ 安全解包到 <DSH_HOME>/.agent-presets/<id>
  → 上游 dsh-agent-presets discover 为 user preset,出现在「创造模式」roster
```

## 2. 模型

- **preset = 目录**:`agent.cordis.yml`(Cordis 组合,必填)+ `preset.yml`(可选 name/description)+ 可选自带资源(如 `skills/`);目录名 = preset id,规则 `^[a-z0-9][a-z0-9-]*$`(上游 PRESET_ID)。
- **打包 = 整目录**:上游「创造模式」(cordis preset)自身就带 `skills/`,且其 composition 用 `new URL('skills/', baseUrl)` 引用该目录;复制它派生的 preset 同样带 `skills/`。因此上传打包整个 preset 目录(不是只打两个文件),否则安装后 skill root 缺失、能力静默丢失。
- **状态机**:`pending → approved | rejected`;rejected 必须带 reason(作者可见,`presets[].reason`);rejected 同名重提 = 重置 pending(更新标题/描述/checksum,清空 reason);approve 亦清空 reason。
- **可见性**:员工(GET /api/agent-presets)= approved 全部 + 自己上传的全部状态;他人 pending/rejected 与不存在同 404(不泄露)。
- **可见性**:员工(GET /api/agent-presets)= 已授权用户的 approved + 自己上传的全部状态;他人 pending/rejected 与不存在同 404(不泄露)。**审核通过后仍需管理员授权给用户/部门组才可见可安装**(与商城授权制一致;admin 恒全量不落授权表);同名多版本共享一个授权。

## 3. 端点

- 员工(Bearer):`GET /api/agent-presets`、`POST /api/agent-presets`(归档 base64 + display_name/description ≤500 字)、`GET /api/agent-presets/:name/archive`(仅 approved)。
- 管理端(Admin):`/api/server/admin/agent-presets`(列表/approve/reject(body reason)/delete/archive 核查/`preview`(composition + 文件清单));0037 起 `PUT /:name/:version/quality`(官方/精选质量标记,仅 approved 行,互斥,审计 `agent_preset_qualify`)。webadmin 经能力中心(`/api/server/admin/capabilities/approvals`)统一审核。
- 客户端本地代理:`/api/pico/agent-presets`(+upload/install/uninstall/archive),loopback guard + session 校验。
- 统一聚合(Bearer):`GET /api/capabilities?source=org`(与共享技能合并返回,见 06-database.md §capabilities)。

## 4. 归档安全(服务端 + 客户端双侧校验)

- 大小上限:原始归档 ≤16MB、解包后 ≤64MB、条目 ≤10000。
- 拒绝:绝对路径、`..` 越界、空路径、symlink/hardlink;必须含顶层 `agent.cordis.yml`。**上传端与安装端跑同一套校验**(`assertArchiveSafe`):源目录里有 symlink 时在上传机就报错,不会传播给每台安装机。
- **归档存储(0041)**:上传的归档字节**直存 agent_presets.archive(DB 行)**,不落磁盘;下载/预览读 DB;pre-0041 老行磁盘回退只读。下载成功 `downloads+1`(webadmin 可见)。
- 服务端存 sha256(checksum);下载响应带 `X-Preset-Checksum`,客户端安装前校验。
- 安装不覆盖本地同名 preset(冲突明确报错,由用户先卸载/改名)。

## 5. 审计

`agent_preset_upload`(作者)/ `agent_preset_approve` / `agent_preset_reject` / `agent_preset_delete`(管理员),落 audit_logs(90 天保留)。

## 6. 边界

- 每用户待审上限 10(pendingCap),**INSERT 内原子计数**防并发绕过,防刷审核队列。
- 上传人 = 当前登录员工;管理员同员工身份上传亦可(admin 上传同样走审核)。
- rejected 无回收站:管理员可删除,作者可重提覆盖。
- v1 无多版本并存(同名唯一):版本字段保留,后续版本管理列为 Known Limitation。
