# Cloudflare Pages 部署指南

本站（`site/`）构建产物为纯静态文件（`site/dist/`），使用 **Cloudflare Pages** 托管，采用 **Git 直连集成**，不依赖 GitHub Actions。

## 一、前置条件

- 已安装 Cloudflare 账号，且 `picoaide.com` 域名的 DNS 已托管在 Cloudflare（当前已是，NS 指向 amy.ns.cloudflare.com / stanley.ns.cloudflare.com）
- 已登录 Cloudflare Dashboard

## 二、创建 Pages 项目

1. 打开 https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. 授权 Cloudflare 访问 GitHub，选择仓库 `picoaide/picoaide-harness`
3. 配置构建参数：

| 配置项 | 值 |
| --- | --- |
| Project name | `picoaide`（或你喜欢的名字，如 `picoaide-harness-site`） |
| Production branch | `master` |
| **Build command** | `npm --prefix site run build` |
| **Build output directory** | `site/dist` |
| Root directory | 留空（仓库根） |

> 注意：因为站点源码在 `site/` 子目录，必须用 `npm --prefix site run build` 构建，输出目录写 `site/dist`。如果 CF 界面要求填写 **Root directory**，请填 `/`（仓库根）。

4. 点击 **Save and Deploy**，首次构建会在 Cloudflare 的构建容器里运行：
   - 自动运行 `npm install`（在 `site/` 下）
   - 运行 `npm run build`（Astro 静态构建）
   - 部署 `site/dist/` 到 `*.pages.dev` 预览地址

## 三、绑定自定义域名

1. 进入 Pages 项目 → **Custom domains** → **Set up a custom domain**
2. 输入 `www.picoaide.com`
3. 按提示添加 CNAME 记录（Cloudflare 会自动生成 DNS 记录，指向 `picoaide.pages.dev`）
4. 等待证书签发（通常几分钟），HTTPS 会自动启用

如果你想把裸域 `picoaide.com` 也指向站，请在 CF DNS 添加 A 记录或设置 `www` 重定向。

## 四、构建环境注意

- **Node 版本**：Cloudflare Pages 默认用 Node 18/20；Astro 5 要求 Node 18.17+，推荐在 Pages 项目 **Settings → Environment variables** 添加：
  ```
  NODE_VERSION = 22
  ```
- **构建命令**：`npm --prefix site run build`（已含 `astro build`）
- **无需 secrets**：本站纯静态、无后端环境变量

## 五、发布/预览流程

- 每次推送到 `master` → CF Pages 自动构建并发布到生产域名
- 每次推送其他分支（如 `dev`）→ 自动构建到 `<branch>.picoaide.pages.dev` 预览地址
- 无需 GitHub Actions、无需手动上传

## 六、验证

部署后在 https://www.picoaide.com 检查：

- 首页 Hero 与截图墙正常加载
- `/blog/` 博客列表与文章页可访问
- `/docs/` Wiki 文档可访问（含搜索）
- `/rss.xml` 返回 feed

## 七、常见问题

### 构建失败：找不到 `site/package.json`

说明 CF 的构建命令没进到 `site/`。检查 Build command 是否为 `npm --prefix site run build`，Root directory 是否为 `/`。

### 本地可以构建，Pages 失败

用以下命令本地复现（与 CF 构建容器一致的步骤）：

```bash
cd site
npm install
npm run build
```
