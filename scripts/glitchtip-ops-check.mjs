#!/usr/bin/env node
/**
 * glitchtip-ops-check.mjs — GlitchTip 自托管 DSN 域名（GLITCHTIP_DOMAIN）核查工具
 *
 * 背景：GlitchTip 6.2.x 用 GLITCHTIP_URL（旧名 APP_URL / GLITCHTIP_DOMAIN）计算【后台展示的
 * DSN 主机】与【issue permalink】；MAIN_URL 在本版本里是零效果变量。若容器缺前者，后台就会
 * 展示 http://<key>@localhost:8000/1 这种永远不可能工作的 DSN（客户端会把事件发往自己的电脑）。
 *
 * 安全约定（硬性）：
 *   - 默认（无参数）= 只读：只发 HTTP GET + 只读 ssh 命令，绝不修改任何东西。
 *   - --apply 只【打印】建议执行的生产命令，不代为执行；且必须同时给 --yes。
 *   - 本文件不含任何凭据、也不含任何生产地址的默认值：站点 / 主机 / ssh 目标 / 容器 /
 *     compose 目录**一律必须显式提供**（参数或环境变量）。缺站点或主机时**拒绝运行**
 *     （exit 2），绝不猜一个默认目标 —— 否则无参数运行就会对某个真实环境发起 ssh/HTTP。
 *
 * 用法（`--base-url` 是必填项；无参数运行会打印用法并以 exit 2 退出，**不会**猜目标）：
 *   node scripts/glitchtip-ops-check.mjs --base-url <url> --ssh <user@host>   # 完整只读核查
 *   node scripts/glitchtip-ops-check.mjs --base-url <url> --json            # 仅 API 侧，输出 JSON
 *   node scripts/glitchtip-ops-check.mjs --base-url <url> --apply --yes      # 打印人工修复命令（不执行）
 *   node scripts/glitchtip-ops-check.mjs --help
 *
 * 参数（站点与主机**必须显式提供**；其余有非生产默认值）：
 *   --base-url <url>     GlitchTip 站点        env GLITCHTIP_BASE_URL   （★ 必填，无默认值）
 *   --ssh <user@host>    生产主机              env GLITCHTIP_SSH_HOST   （★ 只读容器核查必填；
 *                                                                       仅用 --base-url 查 API 时可省）
 *   --org <slug>         组织 slug             env GLITCHTIP_ORG        （默认 picoaide）
 *   --project <slug>     项目 slug             env GLITCHTIP_PROJECT    （默认 picoaide-web）
 *   --cookies <path>     管理员 cookie jar     env GLITCHTIP_COOKIES    （默认见 resolveCookieJar）
 *   --ssh-key <path>     ssh 私钥              env GLITCHTIP_SSH_KEY    （默认 ~/.ssh/id_ed25519）
 *   --container <name>   容器名                env GLITCHTIP_CONTAINER  （默认 glitchtip-web-1）
 *   --compose-dir <path> 生产 compose 目录     env GLITCHTIP_COMPOSE_DIR（默认 /data/glitchtip）
 *   --timeout <ms>       单条只读命令超时      env GLITCHTIP_TIMEOUT_MS （默认 12000）
 *   --json               以 JSON 输出
 *   --apply              打印（不执行）生产修复命令；必须配 --yes
 *   --yes                确认 --apply 的意图
 *   --help, -h           帮助
 *
 * 退出码：0 = 核查完成且未发现缺陷；1 = 核查完成但发现缺陷（如 DSN 是 loopback）；
 *         2 = 用法错误 / 缺凭据 / 无法完成核查。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

const HELP = `glitchtip-ops-check.mjs — GlitchTip 自托管 DSN 域名核查（默认只读）

用法:
  node scripts/glitchtip-ops-check.mjs [--json]           只读核查（默认模式）
  node scripts/glitchtip-ops-check.mjs --apply --yes      打印人工修复命令（绝不代为执行）
  node scripts/glitchtip-ops-check.mjs --help             本帮助

参数（站点与主机必须显式给出 —— 本脚本不含任何生产地址默认值）:
  --base-url <url>      GlitchTip 站点（★ 必填；env GLITCHTIP_BASE_URL）
  --org <slug>          组织 slug（env GLITCHTIP_ORG，默认 picoaide）
  --project <slug>      项目 slug（env GLITCHTIP_PROJECT，默认 picoaide-web）
  --cookies <path>      管理员 cookie jar（env GLITCHTIP_COOKIES；默认依次尝试
                        ./.glitchtip-recon/c.txt 与 ~/.cache/picoaide/glitchtip-cookies.txt）
  --ssh <user@host>     生产主机（★ 只读容器核查必填；env GLITCHTIP_SSH_HOST）
  --ssh-key <path>      ssh 私钥（env GLITCHTIP_SSH_KEY，默认 ~/.ssh/id_ed25519）
  --container <name>    容器名（env GLITCHTIP_CONTAINER，默认 glitchtip-web-1）
  --compose-dir <path>  生产 compose 目录（env GLITCHTIP_COMPOSE_DIR，默认 /data/glitchtip）
  --timeout <ms>        单条只读命令超时毫秒（env GLITCHTIP_TIMEOUT_MS，默认 12000）
  --json                以 JSON 输出
  --apply               打印（不执行）生产修复命令，必须与 --yes 同用
  --yes                 确认 --apply
  --help, -h            本帮助

说明:
  只读模式只做三件事：GET GlitchTip keys API、只读 docker inspect、读本机 cookie jar 是否存在。
  --apply 生成的命令供【人类运维】复制执行（见 docs/deploy/2026-09-16-glitchtip-selfhost-operations.md）。
  退出码: 0=无缺陷 1=发现缺陷 2=用法/凭据问题。`;

function parseArgs(argv) {
  const out = { flags: new Set(), values: new Map() };
  const VALUE_FLAGS = new Set([
    '--base-url',
    '--org',
    '--project',
    '--cookies',
    '--ssh',
    '--ssh-key',
    '--container',
    '--compose-dir',
    '--timeout',
  ]);
  const BOOLEAN_FLAGS = new Set(['--json', '--apply', '--yes']);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      out.flags.add('help');
      continue;
    }
    if (token.startsWith('--') && token.includes('=')) {
      const eq = token.indexOf('=');
      const key = token.slice(0, eq);
      if (!VALUE_FLAGS.has(key)) throw new Error(`未知参数: ${key}`);
      out.values.set(key, token.slice(eq + 1));
      continue;
    }
    if (BOOLEAN_FLAGS.has(token)) {
      out.flags.add(token.slice(2));
      continue;
    }
    if (VALUE_FLAGS.has(token)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`参数 ${token} 缺少取值`);
      out.values.set(token, next);
      i += 1;
      continue;
    }
    if (token.startsWith('-')) throw new Error(`未知参数: ${token}`);
    throw new Error(`无法识别的多余参数: ${token}`);
  }
  return out;
}

function resolveCookieJar(explicit) {
  if (explicit) return explicit;
  if (process.env.GLITCHTIP_COOKIES) return process.env.GLITCHTIP_COOKIES;
  // 只做候选路径探测，不读取内容、不复制凭据。
  const workspaceJar = path.resolve(process.cwd(), '.glitchtip-recon', 'c.txt');
  if (existsSync(workspaceJar)) return workspaceJar;
  return path.join(homedir(), '.cache', 'picoaide', 'glitchtip-cookies.txt');
}

let argv;
try {
  argv = parseArgs(process.argv.slice(2));
} catch (error) {
  // 参数错误要用可读信息 + 退出码 2，而不是抛栈。
  process.stderr.write(`✗ ${error.message}\n\n${HELP}\n`);
  process.exit(2);
}

if (argv.flags.has('help')) {
  process.stdout.write(`${HELP}\n`);
  process.exit(0);
}

const wantsApply = argv.flags.has('apply');
const confirmedYes = argv.flags.has('yes');
const asJson = argv.flags.has('json');

// 硬门槛：--apply 必须显式配 --yes，否则直接拒绝（在任何网络/ssh 动作之前）。
if (wantsApply && !confirmedYes) {
  process.stderr.write(
    [
      '✗ 拒绝执行 --apply：缺少 --yes 确认。',
      '',
      '  --apply 会打印【修改生产环境】的命令（改 compose、重启 glitchtip 容器、更新 webadmin DSN），',
      '  属于人类运维动作。仓库自动化 / AI 代理不得执行。',
      '',
      '  如果你确实是要查看这些命令（脚本仍然只打印、不执行）：',
      '      node scripts/glitchtip-ops-check.mjs --apply --yes',
      '',
      '  只读核查（默认推荐）：',
      '      node scripts/glitchtip-ops-check.mjs',
      '',
      `  运维手册：docs/deploy/2026-09-16-glitchtip-selfhost-operations.md`,
    ].join('\n') + '\n',
  );
  process.exit(2);
}

// F-03(修复轮 1):**站点与主机不再有内置默认值**。
//
// 此前默认值直指一个真实生产站点与生产主机 ⇒ 无参数运行就会向**生产**发起只读
// ssh/HTTP("危险默认值"),也与本文件"目标一律来自参数或环境变量"的自述矛盾。
// 现在:缺 --base-url/GLITCHTIP_BASE_URL 直接 exit 2;缺主机时只做 API 核查(不 ssh)。
const cfg = {
  baseUrl: String(argv.values.get('--base-url') ?? process.env.GLITCHTIP_BASE_URL ?? '').replace(/\/+$/, ''),
  org: argv.values.get('--org') ?? process.env.GLITCHTIP_ORG ?? 'picoaide',
  project: argv.values.get('--project') ?? process.env.GLITCHTIP_PROJECT ?? 'picoaide-web',
  cookieJar: resolveCookieJar(argv.values.get('--cookies')),
  sshHost: String(argv.values.get('--ssh') ?? process.env.GLITCHTIP_SSH_HOST ?? '').trim(),
  sshKey: String(argv.values.get('--ssh-key') ?? process.env.GLITCHTIP_SSH_KEY ?? path.join(homedir(), '.ssh', 'id_ed25519')),
  container: argv.values.get('--container') ?? process.env.GLITCHTIP_CONTAINER ?? 'glitchtip-web-1',
  composeDir: argv.values.get('--compose-dir') ?? process.env.GLITCHTIP_COMPOSE_DIR ?? '/data/glitchtip',
  timeoutMs: Number(argv.values.get('--timeout') ?? process.env.GLITCHTIP_TIMEOUT_MS ?? 12000),
};

if (cfg.baseUrl === '') {
  process.stderr.write([
    '✗ 缺少 GlitchTip 站点:请给 --base-url <url> 或设环境变量 GLITCHTIP_BASE_URL。',
    '',
    '  本脚本**不内置**任何生产地址(无参数运行不得对某个真实环境发起网络/ssh 请求):',
    '      node scripts/glitchtip-ops-check.mjs --base-url https://glitchtip.example.com \\',
    '           --ssh user@glitchtip-host',
    '      GLITCHTIP_BASE_URL=https://glitchtip.example.com GLITCHTIP_SSH_HOST=user@host \\',
    '          node scripts/glitchtip-ops-check.mjs',
    '',
    '  仅查 API(不 ssh): 只给 --base-url 即可。',
    '  运维手册: docs/deploy/2026-09-16-glitchtip-selfhost-operations.md',
  ].join('\n') + '\n');
  process.exit(2);
}

if (!Number.isFinite(cfg.timeoutMs) || cfg.timeoutMs <= 0) {
  process.stderr.write('✗ --timeout 必须是正整数毫秒\n');
  process.exit(2);
}

const log = (...parts) => {
  if (!asJson) process.stdout.write(`${parts.join(' ')}\n`);
};

// ---------------------------------------------------------------------------
// DSN 工具
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/** 判断 DSN/URL 主机是否指向「客户端自己」：loopback / unspecified / 含 localhost 后缀。 */
function classifyHost(hostname) {
  if (!hostname) return { loopback: true, reason: '没有主机名' };
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTS.has(host)) return { loopback: true, reason: host };
  if (host.endsWith('.localhost')) return { loopback: true, reason: '*.localhost' };
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) return { loopback: true, reason: '127.0.0.0/8' };
  return { loopback: false, reason: '' };
}

/** 解析 DSN；非法返回 null。 */
function parseDsn(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const publicKey = decodeURIComponent(url.username || '');
  if (!publicKey) return null;
  const segments = url.pathname.split('/').filter((s) => s !== '');
  const projectId = segments.length > 0 ? segments[segments.length - 1] : '';
  const prefix = segments.length > 1 ? `/${segments.slice(0, -1).join('/')}` : '';
  return {
    raw: raw.trim(),
    scheme: url.protocol.replace(':', ''),
    publicKey,
    host: url.hostname,
    port: url.port,
    prefix,
    projectId,
    isLoopback: classifyHost(url.hostname).loopback,
    storeEndpoint: `${url.protocol}//${url.host}${prefix}/api/${projectId}/store/`,
  };
}

/** 由「权威域名 + 已观测到的 key/project」推出期望的正确 DSN。 */
function buildExpectedDsn(baseUrl, observed) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  if (!observed || !observed.publicKey || !observed.projectId) return null;
  const port = base.port ? `:${base.port}` : '';
  const prefix = observed.prefix ?? '';
  return `${base.protocol}//${observed.publicKey}@${base.hostname}${port}${prefix}/${observed.projectId}`;
}

/** 从容器 env 里取 GLITCHTIP_DOMAIN 的主机名，用于交叉核对。 */
function hostFromDomain(value) {
  if (!value) return null;
  try {
    return new URL(value).hostname;
  } catch {
    return value.replace(/^https?:\/\//i, '').replace(/\/.*$/, '') || null;
  }
}

// ---------------------------------------------------------------------------
// 只读探测
// ---------------------------------------------------------------------------

/**
 * Netscape cookie jar 的域列是否匹配目标主机。
 *
 * jar 里可能同时存着多个站点的会话（浏览器导出的尤其如此）。不校验域列就等于
 * 把**任意站点**的会话 cookie 发给 `--base-url` 指定的主机，`--base-url` 可被
 * 命令行/环境变量改成攻击者域名 ⇒ 会话泄漏。规则与浏览器一致：
 * 精确主机匹配，或 jar 域是目标主机的**父域**（前导点写法）。IP 字面量只做精确匹配。
 */
function cookieDomainMatches(jarDomain, targetHost) {
  if (!jarDomain || !targetHost) return false;
  const d = jarDomain.trim().toLowerCase().replace(/^\./, '');
  const h = targetHost.trim().toLowerCase();
  if (d === '') return false;
  if (d === h) return true;
  // IP 字面量不做后缀匹配（避免 "0.0.1" 匹配到 "127.0.0.1" 之类的误判）。
  if (/^[0-9.]+$/.test(h) || h.includes(':')) return false;
  return h.endsWith(`.${d}`);
}

async function fetchKeys(cookieJar) {
  const url = `${cfg.baseUrl}/api/0/projects/${encodeURIComponent(cfg.org)}/${encodeURIComponent(cfg.project)}/keys/`;
  const targetHost = hostFromDomain(cfg.baseUrl);
  const headers = { accept: 'application/json' };
  if (cookieJar && existsSync(cookieJar)) {
    const jar = readFileSync(cookieJar, 'utf8');
    const pairs = [];
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (const line of jar.split('\n')) {
      // curl 写的 Netscape jar 用 "#HttpOnly_" 给 HttpOnly cookie 打前缀 —— 它仍是数据行，不是注释。
      const trimmed = line.replace(/^#HttpOnly_/, '').trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const cols = trimmed.split('\t');
      if (cols.length < 7) continue;
      // 域列（cols[0]）必须与目标主机匹配：jar 里可能同时存着多个站点的会话
      // （浏览器导出的 jar 尤其如此），不校验就会把**别的站点**的会话 cookie
      // 发给我们请求的主机。2026-09-17 审计修复（round-1/FINDINGS-misc-ops-docs.md
      // 的 misc-ops-docs-2：mock 实测 cookie 被发往 --base-url 指定的任意主机）。
      if (!cookieDomainMatches(cols[0], targetHost)) continue;
      const expiresAt = Number(cols[4]);
      if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt < nowSeconds) continue; // 过期 cookie 不发
      pairs.push(`${cols[5]}=${cols[6]}`);
    }
    if (pairs.length > 0) headers.cookie = pairs.join('; ');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal, redirect: 'follow' });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* 非 JSON 响应：保留原文片段 */
    }
    return { ok: res.ok, status: res.status, url, body, raw: text.slice(0, 400) };
  } finally {
    clearTimeout(timer);
  }
}

function runReadOnly(cmd, args) {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: cfg.timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: stdout.trim(), stderr: '' };
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error.stdout === 'string' ? error.stdout.trim() : '',
      stderr: typeof error.stderr === 'string' ? error.stderr.trim() : String(error.message ?? error),
    };
  }
}

function inspectContainerEnv() {
  // F-03(修复轮 1):未给主机时**不猜目标**,直接跳过容器核查(只做 API 部分)。
  if (cfg.sshHost === '') {
    return {
      reachable: false,
      skipped: true,
      error: '未提供 --ssh/GLITCHTIP_SSH_HOST（本脚本不内置任何生产主机）',
      domain: null,
      siteUrlSource: null,
      glitchtipUrl: null,
      appUrl: null,
      legacyDomain: null,
      mainUrl: null,
      embedWorker: null,
      allowedHosts: null,
    };
  }
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${Math.max(1, Math.ceil(cfg.timeoutMs / 1000))}`,
  ];
  if (existsSync(cfg.sshKey)) args.push('-i', cfg.sshKey);
  args.push(
    cfg.sshHost,
    `docker inspect ${cfg.container} --format '{{range .Config.Env}}{{println .}}{{end}}'`,
  );
  const result = runReadOnly('ssh', args);
  if (!result.ok) {
    return {
      reachable: false,
      error: result.stderr.split('\n')[0] || 'ssh 失败',
      domain: null,
      siteUrlSource: null,
      glitchtipUrl: null,
      appUrl: null,
      legacyDomain: null,
      mainUrl: null,
      embedWorker: null,
      allowedHosts: null,
    };
  }
  const readEnv = (name) => {
    const line = result.stdout.split('\n').find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim() : null;
  };
  // 注意：只提取本核查需要的几个变量。**不**保留整份 env 原文 ——
  // 容器 env 里含 DATABASE_URL（带口令）、SECRET_KEY 等机密，落到 stdout/JSON/日志里就是泄漏。
  //
  // F-08(修复轮 1):站点 URL 的**读取优先级**是 GLITCHTIP_URL > APP_URL >
  // GLITCHTIP_DOMAIN(见 GlitchTip settings.py 的 `env.url("GLITCHTIP_URL", default_url)`,
  // default_url = env.str("APP_URL", env.str("GLITCHTIP_DOMAIN", …)))。现场只配了
  // MAIN_URL(6.2.6 里零代码读取)所以什么都没生效;只查 GLITCHTIP_DOMAIN 会把
  // "设了 APP_URL/GLITCHTIP_URL 的部署"误报成缺陷。
  const glitchtipUrl = readEnv('GLITCHTIP_URL');
  const appUrl = readEnv('APP_URL');
  const legacyDomain = readEnv('GLITCHTIP_DOMAIN');
  const domain = glitchtipUrl ?? appUrl ?? legacyDomain;
  const siteUrlSource = glitchtipUrl !== null
    ? 'GLITCHTIP_URL'
    : appUrl !== null
      ? 'APP_URL'
      : legacyDomain !== null
        ? 'GLITCHTIP_DOMAIN'
        : null;
  return {
    reachable: true,
    error: null,
    domain,
    siteUrlSource,
    glitchtipUrl,
    appUrl,
    legacyDomain,
    mainUrl: readEnv('MAIN_URL'),
    embedWorker: readEnv('GLITCHTIP_EMBED_WORKER'),
    allowedHosts: readEnv('ALLOWED_HOSTS'),
  };
}

// ---------------------------------------------------------------------------
// 修复命令（仅打印，绝不执行）
// ---------------------------------------------------------------------------

function buildApplyCommands({ expectedDsn, domain }) {
  const domainValue = domain ?? cfg.baseUrl;
  return [
    `# ── 0) 先备份（人工执行；本脚本不会执行任何一条） ──`,
    `cd ${cfg.composeDir} && cp -a compose.yml "compose.yml.bak-$(date +%Y%m%d-%H%M%S)"`,
    ``,
    `# ── 1) 在 ${cfg.composeDir}/compose.yml 的 services.web.environment 下新增一行 ──`,
    `#    取值必须带协议。若已存在 APP_URL / GLITCHTIP_URL，请改【它们】（优先级更高）。`,
    `#    MAIN_URL 在 GlitchTip 6.2.x 里无代码读取，保持原样即可（不需要与它同值）。`,
    `#      GLITCHTIP_DOMAIN: ${domainValue}      # ← 新增（仅当 APP_URL/GLITCHTIP_URL 都不存在）`,
    ``,
    `# ── 2) 只重启 web 服务（不要 down -v，会删数据卷） ──`,
    `cd ${cfg.composeDir} && docker compose up -d web`,
    ``,
    `# ── 3) 核对变量已进入容器 ──`,
    `docker inspect ${cfg.container} --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E 'GLITCHTIP_URL|APP_URL|GLITCHTIP_DOMAIN'`,
    `docker compose -f ${cfg.composeDir}/compose.yml ps`,
    ``,
    `# ── 4) 核对后台 DSN 与 permalink 已变成公网域名 ──`,
    `curl -s -b <管理员cookie jar> '${cfg.baseUrl}/api/0/projects/${cfg.org}/${cfg.project}/keys/'`,
    `#    期望: "public": "${expectedDsn ?? 'https://<key>@<domain>/<projectId>'}"`,
    ``,
    `# ── 5) 在 webadmin →「错误监控」把 DSN 更新为下面这一串并保存 ──`,
    expectedDsn ?? '(无法推导：请先从后台 keys API 抄一次 DSN 主机与 project id)',
  ];
}

// ---------------------------------------------------------------------------
// 主流程（只读）
// ---------------------------------------------------------------------------

const report = {
  mode: wantsApply ? 'apply(print-only)' : 'check',
  baseUrl: cfg.baseUrl,
  org: cfg.org,
  project: cfg.project,
  cookieJar: cfg.cookieJar,
  cookieJarPresent: existsSync(cfg.cookieJar),
  sshHost: cfg.sshHost,
  container: cfg.container,
  composeDir: cfg.composeDir,
  observedDsn: null,
  observed: null,
  loopback: null,
  loopbackReason: null,
  containerEnv: null,
  expectedDsn: null,
  verdict: [],
  notes: [],
  exitCode: 0,
};

log('GlitchTip 自托管 DSN 核查（只读模式，不会修改任何东西）');
log(`  站点: ${cfg.baseUrl}   组织/项目: ${cfg.org}/${cfg.project}`);
log(`  cookie jar: ${cfg.cookieJar}${report.cookieJarPresent ? '' : '（未找到 → 跳过 API 检查）'}`);
log('');

if (!report.cookieJarPresent) {
  report.notes.push(
    'cookie jar 缺失：无法读取 GlitchTip keys API。用 --cookies <path> 或 GLITCHTIP_COOKIES=<path> 指定；' +
      '如何取得管理员 cookie 见 docs/deploy/2026-09-16-glitchtip-selfhost-operations.md。',
  );
  report.verdict.push('UNKNOWN: 未提供管理员 cookie jar，无法核查后台展示的 DSN');
  report.exitCode = 2;
} else {
  let keys;
  try {
    keys = await fetchKeys(cfg.cookieJar);
  } catch (error) {
    keys = { ok: false, status: 0, url: '', body: null, raw: String(error?.message ?? error) };
  }
  if (!keys.ok || !Array.isArray(keys.body) || keys.body.length === 0) {
    report.notes.push(
      `keys API 未返回可用数据（HTTP ${keys.status}）：${keys.raw || '空响应'}。` +
        'cookie 可能已过期，或该组织/项目 slug 不正确。',
    );
    report.verdict.push('UNKNOWN: 无法从 GlitchTip API 读到 DSN');
    report.exitCode = 2;
  } else {
    const first = keys.body[0];
    const raw = first?.dsn?.public ?? first?.dsn?.secret ?? null;
    const parsed = parseDsn(raw);
    report.observedDsn = raw;
    report.observed = parsed;
    report.loopback = parsed ? parsed.isLoopback : null;
    report.loopbackReason = parsed ? classifyHost(parsed.host).reason : null;
    log(`① GlitchTip 当前对外展示的 DSN: ${raw ?? '(未返回 dsn 字段)'}`);
    if (parsed) {
      log(`   主机: ${parsed.host}${parsed.port ? `:${parsed.port}` : ''}   项目 id: ${parsed.projectId}   store 端点: ${parsed.storeEndpoint}`);
      log(`② 是否 loopback（客户端会发往自己）: ${parsed.isLoopback ? `是 ← 缺陷（${report.loopbackReason}）` : '否'}`);
    } else {
      log('② 是否 loopback: 无法判定（DSN 解析失败）');
    }
    log('');
    if (parsed && parsed.isLoopback) {
      report.verdict.push('FAIL: 后台展示的 DSN 指向本机（loopback/unspecified），任何客户端都不可能上报成功');
      report.exitCode = 1;
    } else if (parsed) {
      report.verdict.push('OK: 后台展示的 DSN 不指向本机');
    }
  }
}

log(`③ 容器 ${cfg.container} 的上报域名相关 env（只读 ssh docker inspect）`);
const envInfo = inspectContainerEnv();
report.containerEnv = envInfo;
if (!envInfo.reachable) {
  log(`   不可达：${envInfo.error}`);
  report.notes.push(envInfo.skipped === true
    ? '跳过容器 env 核查（未提供主机）：只给了 --base-url，本次仅核查 API 侧'
    : `无法通过 ssh 读取容器 env（${cfg.sshHost}）：${envInfo.error}`);
  if (envInfo.skipped === true) {
    // 用户**显式**只给 --base-url：这是被支持的子集用法，不构成"核查失败"。
    report.verdict.push('UNKNOWN: 未指定 --ssh，本次只核查了 API 侧（容器站点 URL 未核查）');
  } else {
    // 给了主机却读不到 ⇒ 核查无法完成，按契约退 2。
    // 2026-09-17 审计修复：此前这里只 push 一行 UNKNOWN 文字而不改 exitCode，
    // 脚本仍退 0（"一切正常"）—— 运维会误以为链路健康，正是本工具要消灭的
    // "静默无信号"。见 round-1/FINDINGS-misc-ops-docs.md。
    report.verdict.push('UNKNOWN: 未能读取容器 env，站点 URL（GLITCHTIP_URL/APP_URL/GLITCHTIP_DOMAIN）设置情况未知');
    report.exitCode = 2;
  }
} else {
  log(`   MAIN_URL=${envInfo.mainUrl ?? '(未设置)'}（GlitchTip 6.2.x 里无代码读取 = 零效果）`);
  log(`   GLITCHTIP_URL=${envInfo.glitchtipUrl ?? '(未设置)'}`);
  log(`   APP_URL=${envInfo.appUrl ?? '(未设置)'}`);
  log(`   GLITCHTIP_DOMAIN=${envInfo.legacyDomain ?? '(未设置)'}`);
  if (envInfo.embedWorker) log(`   GLITCHTIP_EMBED_WORKER=${envInfo.embedWorker}`);
  if (!envInfo.domain) {
    report.verdict.push(
      'FAIL: 容器未设置站点 URL（GLITCHTIP_URL / APP_URL / GLITCHTIP_DOMAIN 三者皆空）'
      + '—— DSN 展示与 issue permalink 会退化成 localhost（只配 MAIN_URL 不生效）',
    );
    if (report.exitCode === 0) report.exitCode = 1;
  } else {
    report.verdict.push(`OK: 容器已设置站点 URL（生效来源 ${envInfo.siteUrlSource}）`);
  }
}
log('');

const domainForExpected = envInfo.reachable && envInfo.domain ? envInfo.domain : cfg.baseUrl;
const expected = buildExpectedDsn(domainForExpected, report.observed);
report.expectedDsn = expected;
log('④ 期望的正确 DSN（由权威域名 + 已观测到的 key/project 推导）');
log(`   ${expected ?? '(无法推导：缺 DSN 观测值或域名非法)'}`);
if (expected && report.observedDsn && expected !== report.observedDsn) {
  log('   ↑ 与当前后台展示值不同 → 修好 GLITCHTIP_DOMAIN 后应从后台重新抄一次并更新 webadmin');
}
log('');

log('⑤ 结论');
for (const line of report.verdict) log(`   - ${line}`);
for (const line of report.notes) log(`   ! ${line}`);

if (wantsApply) {
  log('');
  log('════════════════════════════════════════════════════════════════════');
  log('  --apply 模式：仅打印命令，本脚本绝不执行任何一条');
  log('  ⚠️  下列命令会修改生产环境（改 compose + 重启容器 + 改 webadmin DSN）。');
  log('  ⚠️  必须由人类运维确认后手工执行；AI 代理与 CI 禁止执行。');
  log('  ⚠️  执行前先读 docs/deploy/2026-09-16-glitchtip-selfhost-operations.md');
  log('════════════════════════════════════════════════════════════════════');
  for (const line of buildApplyCommands({ expectedDsn: expected, domain: domainForExpected })) log(line);
  log('');
  log('（已给 --yes：以上命令已打印。本脚本不会代替你执行。）');
}

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
if (!asJson) {
  log('');
  log(`退出码 ${report.exitCode}（0=无缺陷 1=发现缺陷 2=用法/凭据问题）`);
}
process.exit(report.exitCode);
