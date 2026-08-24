# 共享 Agent(agent_presets)

> 员工在 DSH 客户端「创造模式」创建的本地 Agent 预设可上传共享;管理员审核通过后**全员**可见可安装(无需逐人授权)。未通过或待审核内容对他人不可见。

## 1. 数据流

```
员工(创造模式创建本地 preset) → /api/pico/agent-presets/upload(host 打包)
  → POST /api/agent-presets(员工 Bearer,归档 base64) → agent_presets 表(status=pending)
管理员(webadmin /admin/agent-presets) → approve / reject / delete(全审计)
审核通过 → GET /api/agent-presets 全员可见 → /api/pico/agent-presets/:name/install
  → 下载归档(校验 x-preset-checksum)→ 安全解包到 <DSH_HOME>/.agent-presets/<id>
  → 上游 dsh-agent-presets discover 为 user preset,出现在「创造模式」roster
```

## 2. 模型

- **preset = 目录**:`agent.cordis.yml`(Cordis 组合,必填)+ `preset.yml`(可选 name/description)+ 可选自带资源(如 `skills/`);目录名 = preset id,规则 `^[a-z0-9][a-z0-9-]*$`(上游 PRESET_ID)。
- **打包 = 整目录**:上游「创造模式」(cordis preset)自身就带 `skills/`,且其 composition 用 `new URL('skills/', baseUrl)` 引用该目录;复制它派生的 preset 同样带 `skills/`。因此上传打包整个 preset 目录(不是只打两个文件),否则安装后 skill root 缺失、能力静默丢失。
- **状态机**:`pending → approved | rejected`;rejected 同名重提 = 重置 pending(更新描述/checksum)。
- **可见性**:员工(GET /api/agent-presets)= approved 全部 + 自己上传的全部状态;他人 pending/rejected 与不存在同 404(不泄露)。
- **无 grants 表**(与技能商城授权制不同,用户明确要求审核通过后全员共享)。

## 3. 端点

- 员工(Bearer):`GET /api/agent-presets`、`POST /api/agent-presets`(归档 base64)、`GET /api/agent-presets/:name/archive`(仅 approved)。
- 管理端(Admin):`/api/admin/agent-presets`(列表/approve/reject/delete/archive 核查)。
- 客户端本地代理:`/api/pico/agent-presets`(+upload/install/uninstall/archive),loopback guard + session 校验。

## 4. 归档安全(服务端 + 客户端双侧校验)

- 大小上限:原始归档 ≤16MB、解包后 ≤64MB、条目 ≤10000。
- 拒绝:绝对路径、`..` 越界、空路径、symlink/hardlink;必须含顶层 `agent.cordis.yml`。**上传端与安装端跑同一套校验**(`assertArchiveSafe`):源目录里有 symlink 时在上传机就报错,不会传播给每台安装机。
- 服务端存 sha256(checksum);下载响应带 `X-Preset-Checksum`,客户端安装前校验。
- 安装不覆盖本地同名 preset(冲突明确报错,由用户先卸载/改名)。

## 5. 审计

`agent_preset_upload`(作者)/ `agent_preset_approve` / `agent_preset_reject` / `agent_preset_delete`(管理员),落 audit_logs(90 天保留)。

## 6. 边界

- 每用户待审上限 10(pendingCap),防刷审核队列。
- 上传人 = 当前登录员工;管理员同员工身份上传亦可(admin 上传同样走审核)。
- rejected 无回收站:管理员可删除,作者可重提覆盖。
- v1 无多版本并存(同名唯一):版本字段保留,后续版本管理列为 Known Limitation。
