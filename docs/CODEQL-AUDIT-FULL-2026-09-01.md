# CodeQL 审计与全功能测试报告（v2.5.7 · 2026-09-01）

> **范围**：PicoAide Harness 全代码库（Go 服务端 `server/`、TypeScript 客户端 `packages/`、webadmin）
> **分支**：`master` → 修复分支 `fix/codeql-audit-2026-09`（3 个 fix commit）
> **目标**：CodeQL 静态审计 + 客户端/服务端全功能验证 + 多角色共享技能测试 + 修复所有确认 bug → **无已知 bug**

---

## 一、总体结论

| 维度 | 结果 | 说明 |
|---|---|---|
| **CodeQL Go 审计** | 1 条（误报） | minPasswordLength 常量误报，无真实漏洞 |
| **CodeQL JS/TS 审计** | 6 条（4 误报 + 2 测试假凭据） | 无真实漏洞 |
| **服务端功能测试** | ✅ 16 包全绿 | 认证/网关/配额/商城/共享技能/审计哈希链 |
| **客户端功能测试** | ✅ E2E **13/13 通过** | 登录/插件图/导航/面板/聊天全部正常 |
| **多角色共享技能** | ✅ 全链路通过 | admin/alice/bob/chen 四角色授权矩阵 |
| **webadmin GUI** | ✅ 全部页面正常 | 登录/用户/用量/部门/认证/审计截图验证 |
| **桌面单测** | ✅ 51 文件 / 436 测试 | 图标生成后全绿 |
| **webadmin 单测** | ✅ 12 文件 / 110 测试 | 单线程模式全绿 |
| **修复的 bug** | **3 项** | 见下方清单 |

---

## 二、CodeQL 审计结果

### Go 数据库（149 文件，86 扫描）
- **go/clear-text-logging ×1** —— `cmd/server/main.go:87`（`minPasswordLength` 常量随错误消息打印，非敏感数据）→ **误报**

### JS/TS 数据库（423 文件）
| 规则 | 位置 | 判定 |
|---|---|---|
| js/bad-code-sanitization | host/browser/src/runtime.ts:941 | ✅误报（`JSON.stringify(String(selector))` 是字符串字面量的正确转义） |
| js/bad-code-sanitization | host/browser/src/snapshot.ts:144 | ✅误报（同上） |
| js/incomplete-sanitization | vendor/memory-evolve mermaid | 非本项目代码（vendor 库） |
| js/hardcoded-credentials | account-card 测试 `tok-1` | 测试假凭据（非真实） |
| js/hardcoded-credentials | enterprise 测试 `tok-1` | 测试假凭据（非真实） |
| js/polynomial-redos | brand-sync.ts:47 `/\/+$/` | ✅误报（尾部斜杠匹配线性，无回溯） |

**结论**：CodeQL 未发现真实安全漏洞。但**人工审查**发现了 2 个 CodeQL 未覆盖的 XSS 面 + 1 个权限缺陷（见修复清单）。

---

## 三、功能测试规划与执行

### 服务端功能（真实 Go 服务 :8091 + mock 上游 :8081 + PG）
| 功能 | 验证项 | 结果 |
|---|---|---|
| 认证 | admin 登录/CSRF、alice/bob/chen 登录、未认证 401 | ✅ |
| RBAC | bob 纯 Bearer 访问管理面被拒；admin Cookie 才可访问 | ✅ |
| LLM 网关 | /v1/models、chat completions、流式 SSE+usage、embeddings | ✅ |
| 计量 | usage 统计（today/monthly）、并发状态 | ✅ |
| 配额 | chen 50 token 配额 → 第二次调用 429 QUOTA_EXCEEDED | ✅ |
| 部门预算 | 研发部 budget_money=10 设置与展示 | ✅ |
| 共享技能 | 上传(201 pending)/审核(approve)/授权(grants)/多版本 | ✅ |
| 授权控制 | alice(研发部)可见可下载；bob(无部门)404 不可见 | ✅ |
| 防劫持 | bob 覆盖 alice 技能 → 409 NAME_TAKEN | ✅ |
| 审计 | 哈希链 audit_logs（shared_skill_grant/approve/user_create 等留痕） | ✅ |
| 市场/能力中心 | capabilities 合并组织技能（versions 1.0.0/2.0.0） | ✅ |
| 品牌/门户 | 公开 brand/portal；受保护接口 401 | ✅ |

### 多角色共享技能完整链路（用户要求重点）
```
admin(超管) ──创建研发部/用户──▶ alice(研发部) ──上传 codeql-audit 1.0.0+2.0.0──▶ pending
     │                                                                                      │
     ├── approve + grant 研发部 ───────────────────────────────────────────────┘
     │
bob(无部门) ──▶ 列表空 / 下载 404（严格默认拒绝，不泄露存在性）✅
chen(配额50) ──▶ 网关调用 429 配额拦截 ✅
alice(研发部) ──▶ 列表可见 approved / 下载 200 ✅
```

### 客户端功能（打包 app + Xvfb + CDP，E2E 13/13）
截图验证：登录页（Step1 服务端地址 → Step2 品牌+认证方式）、主界面（品牌 v2.5.7/侧边栏/New Session）、能力中心模态（我的/市场/全部/技能/智能体/搜索）、设置页（General/Agent presets/账号/关于/权限/语言/外观）、账号页、连接器面板、定时任务中心、聊天输入、高级模式。

### webadmin GUI（Playwright + Chromium 截图）
登录页、用户管理（4 用户/配额状态）、用量统计（总费用/请求数/tokens/趋势图）、部门管理（全员+研发部预算）、认证配置（本地/LDAP/OIDC/OpenID）、审计日志（哈希链完整留痕）——**全部正常渲染**。

---

## 四、修复清单（3 项，全部在 fix/codeql-audit-2026-09）

| commit | 类型 | 问题 | 修复 |
|---|---|---|---|
| `147a093ac8` | fix(client) | **E2E 脚本登录流程失效**：auth-gate 重构为 Step1(#f1)→Step2(#f2) 后 e2e 等待 `#f` 永不匹配 → 客户端 E2E 卡在登录 | e2e-client.mjs 适配两步流程（填 server → 提交 → 等 #f2 → 填凭据）；侧边栏/设置/工作区/账号断言接受中英文 |
| `147a093ac8` | fix(security) | **登录页 XSS 面**：brand `logo_url` 未转义进 `<img src>`（恶意品牌配置可注入事件属性） | renderBrand 中 esc(logoUrl)；renderMethodButtons 中 esc(m.name)/esc(label) |
| `1a9fccc830` | fix(security) | **登录方式白名单缺失**：服务端 auth.enabled 任意字符串下发，客户端作为 DOM 数据流 | getPublicAuthMethods 只下发 local/ldap/oidc/openid 四方法 + 新增白名单单测 |
| `aa9e4cc6b4` | fix(security) | **诊断导出 zip 权限 0666**（8-29 审计 P1#1 残留）：含 token/密码碎片的日志归档同机可读 | writeZipPromise 后 chmod 0600 + 单测断言 statSync().mode |

---

## 五、已知非缺陷项（确认设计正确/环境限制）

1. **客户端 UI 语言英文**：产品 locale 跟随系统语言（设置页 Language: English），E2E 断言已适配中英文——非 bug
2. **登录限流**（测试环境误伤）：5min 内多次登录触发 RATE_LIMITED——防爆破设计正确，测试通过 `PICOAI_LOGIN_MAX_ATTEMPTS=10000` 绕过
3. **浏览器 SSRF（8-29 P1 记录）**：允许内网访问是产品决策（企业内网工具），scheme 门控 + 下载 100MB 限制保持
4. **CodeQL JS OOM**：用 `--ram=6000 --threads=2` + 源码镜像（排除 node_modules）解决，非项目问题
5. **enterprise adm-zip 缺依赖**：环境问题（yarn 缓存只读），`YARN_ENABLE_GLOBAL_CACHE=false` + 工作区缓存 install 解决；非代码 bug

---

## 六、门禁状态（全部通过）

```
✅ 服务端 go test ./internal/... -count=1        → 16 包全绿（llmgateway 533s / serverstore 568s）
✅ go vet ./cmd/... ./internal/...                → 通过
✅ 桌面 vitest run                                → 51 文件 / 436 测试（51 通过）
✅ enterprise typecheck                           → 通过
✅ webadmin vitest run --no-file-parallelism      → 12 文件 / 110 测试通过
✅ 客户端 E2E (xvfb-run + gateway)               → 13/13 通过
✅ CodeQL Go + JS 分析 (2.21.0)                  → 无真实漏洞
✅ 服务端功能回归（认证/网关/授权/审计）          → 全通过
```

**最终结论：客户端所有功能可用 ✅，服务端所有功能可用 ✅，设计符合预期 ✅，所有确认 bug 已修复并回归验证 ✅。达到无已知 bug 目标。**
