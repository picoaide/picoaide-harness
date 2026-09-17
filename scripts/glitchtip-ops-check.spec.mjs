#!/usr/bin/env node
/**
 * glitchtip-ops-check 的行为门禁（2026-09-17，审计 R1 补齐断言缺口）。
 *
 * 为什么需要它：第一轮多代理审计修掉了这个脚本的两处真实缺陷 ——
 *   ① P1：ssh 不可达时只记一行 UNKNOWN 文字却不改 exitCode，脚本仍退 0
 *      （"一切正常"），与脚本自述的"2 = 无法完成核查"直接冲突；
 *   ② P2：解析 Netscape cookie jar 时丢弃域列，把任意站点的会话 cookie
 *      发往 --base-url 指定的主机。
 * 但审计同时发现：**全仓没有任何自动化断言覆盖这个脚本**（不在 CI、不在
 * verify-ci-scripts.mjs、不在 package.json scripts）⇒ 两处修复**回退后不会
 * 有任何测试变红**。按本轮验收口径「红不了的断言算缺口」，本文件补上断言。
 *
 * 手法：起一个本地 mock（仅 127.0.0.1）当 GlitchTip keys API，用保留地址
 * 192.0.2.1（RFC 5737，不可达）当 ssh 主机，**子进程真跑脚本**并断言退出码 /
 * stdout / mock 实际收到的 Cookie 头。全是行为断言，不 mock 被测对象本身。
 *
 * 用法：node scripts/glitchtip-ops-check.spec.mjs
 * 退出码：0 = 全通过；非 0 = 有断言失败。
 */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const SCRIPT = join(ROOT, 'scripts', 'glitchtip-ops-check.mjs')

/** RFC 5737 TEST-NET-1：保证不可达，绝不指向任何真实主机。 */
const UNREACHABLE_SSH = 'nobody@192.0.2.1'

let failures = 0
let checks = 0
let skips = 0

function check(label, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ✓ ${label}${detail ? `  (${detail})` : ''}`)
  } else {
    failures += 1
    console.log(`  ✗ ${label}${detail ? `  (${detail})` : ''}`)
  }
}

/** 起 mock keys API；记录收到的 Cookie 头。 */
async function startMock() {
  const seenCookies = []
  const server = createServer((req, res) => {
    seenCookies.push(req.headers.cookie ?? null)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify([{
      id: '1',
      dsn: { public: 'https://deadbeefdeadbeefdeadbeefdeadbeef@glitchtip.example.com/1' },
      projectId: 1,
    }]))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  return { server, port, seenCookies }
}

/** 子进程真跑脚本；返回 {code, stdout, stderr}。 */
function runScript(args, env = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('close', (code) => resolveRun({ code, stdout, stderr }))
  })
}

const work = mkdtempSync(join(tmpdir(), 'gt-ops-spec-'))

try {
  const { server, port, seenCookies } = await startMock()
  const baseUrl = `http://127.0.0.1:${port}`

  // ---------------------------------------------------------------- 用法/契约
  console.log('\n【用法契约】无参数运行必须打印用法并 exit 2（绝不猜目标）')
  {
    const noArgs = await runScript([])
    check('无参数 ⇒ exit 2', noArgs.code === 2, `exit=${noArgs.code}`)
    check(
      '无参数 ⇒ 输出含 --base-url 为必填的提示',
      /--base-url/.test(noArgs.stdout + noArgs.stderr),
      'help 文本已提及 --base-url',
    )
    const help = await runScript(['--help'])
    check('--help ⇒ exit 0', help.code === 0, `exit=${help.code}`)
    check(
      '--help 不再宣称"无参数即只读核查"',
      !/\[--json\]\s+只读核查（默认模式）/.test(help.stdout),
      '旧的默认模式文案已移除',
    )
  }

  // -------------------------------------------- P1 回归：ssh 不可达必须 exit 2
  console.log('\n【P1 回归】API 可达 + ssh 不可达 ⇒ 核查未完成，必须 exit 2（曾为 0）')
  {
    const r = await runScript([
      '--base-url', baseUrl,
      '--cookies', '/dev/null',
      '--ssh', UNREACHABLE_SSH,
      '--ssh-key', '/nonexistent/key',
    ])
    check('exit 2（而不是 0="一切正常"）', r.code === 2, `exit=${r.code}`)
    check(
      'stdout 明确写出 UNKNOWN 未能读取容器 env',
      /UNKNOWN: 未能读取容器 env/.test(r.stdout),
      '结论行可读',
    )
    check(
      'stdout 的退出码说明与真实退出码一致',
      /退出码 2/.test(r.stdout),
      '人读输出与 exit code 不矛盾',
    )
  }

  console.log('\n【P1 边界】只给 --base-url（显式子集用法）⇒ 不构成"核查失败"')
  {
    const r = await runScript(['--base-url', baseUrl, '--cookies', '/dev/null'])
    check('exit 0（用户显式选择只查 API 侧）', r.code === 0, `exit=${r.code}`)
    check(
      '仍标注容器 env 未核查（不冒充完整核查）',
      /未指定 --ssh/.test(r.stdout),
      '诚实标注范围',
    )
  }

  // -------------------------------------------- P2 回归：cookie 域列必须生效
  console.log('\n【P2 回归】cookie jar 域列不匹配目标主机 ⇒ 不得发送该 cookie')
  {
    seenCookies.length = 0
    const jar = join(work, 'mismatch.jar')
    writeFileSync(jar, [
      '# Netscape HTTP Cookie File',
      '.glitchtip.example.com\tTRUE\t/\tFALSE\t1999999999\tsessionid\tLEAKED_SESSION',
      '',
    ].join('\n'))
    const r = await runScript(['--base-url', baseUrl, '--cookies', jar])
    check('exit 0（API 可达）', r.code === 0, `exit=${r.code}`)
    const last = seenCookies.at(-1)
    check(
      'mock 未收到任何 Cookie（域列 .glitchtip.example.com ≠ 127.0.0.1）',
      last === null || last === undefined,
      `实际收到 cookie=${String(last)}`,
    )
  }

  console.log('\n【P2 边界】域列匹配时仍必须发送（别把功能一起修没）')
  {
    seenCookies.length = 0
    const jar = join(work, 'match.jar')
    writeFileSync(jar, [
      '# Netscape HTTP Cookie File',
      `127.0.0.1\tFALSE\t/\tFALSE\t1999999999\tsessionid\tMATCHED_SESSION`,
      '',
    ].join('\n'))
    const r = await runScript(['--base-url', baseUrl, '--cookies', jar])
    check('exit 0', r.code === 0, `exit=${r.code}`)
    check(
      'mock 收到匹配的 cookie',
      /sessionid=MATCHED_SESSION/.test(String(seenCookies.at(-1))),
      `实际收到 cookie=${String(seenCookies.at(-1))}`,
    )
  }

  console.log('\n【P2 边界】IP 字面量后缀陷阱：jar 域 "0.0.1" 不得匹配目标 127.0.0.1')
  {
    seenCookies.length = 0
    const jar = join(work, 'suffix.jar')
    writeFileSync(jar, [
      '# Netscape HTTP Cookie File',
      '0.0.1\tFALSE\t/\tFALSE\t1999999999\tsessionid\tSUFFIX_TRAP',
      '',
    ].join('\n'))
    await runScript(['--base-url', baseUrl, '--cookies', jar])
    const last = seenCookies.at(-1)
    check(
      '未发送（IP 不做后缀匹配）',
      last === null || last === undefined,
      `实际收到 cookie=${String(last)}`,
    )
  }

  console.log('\n【P2 边界】IP 保护必须独立生效（jar 域带前导点的 IP 也必须拒）')
  {
    // 2026-09-17 第 3 轮审计 R3-ops-2:此前 IP 用例的 jar 域写成无点的 `0.0.1`，
    // 会被"前导点规则"先挡住 ⇒ 该断言实际测的是点规则，IP 保护**无独立断言**。
    // 带点的 `.0.0.1` 才能把 IP 保护单独逼出来。
    seenCookies.length = 0
    const jar = join(work, 'ip-dotted.jar')
    writeFileSync(jar, [
      '# Netscape HTTP Cookie File',
      '.0.0.1\tTRUE\t/\tFALSE\t1999999999\tsessionid\tIP_DOTTED_TRAP',
      '',
    ].join('\n'))
    await runScript(['--base-url', baseUrl, '--cookies', jar])
    const last = seenCookies.at(-1)
    check(
      'jar 域 .0.0.1（有前导点的 IP）对目标 127.0.0.1 ⇒ 不发送',
      last === null || last === undefined,
      `实际收到 cookie=${String(last)}`,
    )
  }

  console.log('\n【P2 边界】父域 cookie 必须匹配子域（须真正走到后缀分支，别被 IP 短路掩盖）')
  {
    // 2026-09-17 证伪轮发现：原用例目标写成 IP 127.0.0.1，会在"IP 不做后缀匹配"
    // 那行就返回，**永远走不到父域后缀分支** —— 把后缀分支删掉它照样绿（假绿）。
    // 改为用 `foo.localhost` 这种非 IP 目标，并真起一个绑定它的 mock 来断言"真发出去了"。
    seenCookies.length = 0
    const parentServer = createServer((req, res) => {
      seenCookies.push(req.headers.cookie ?? null)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{
        id: '1',
        dsn: { public: 'https://deadbeefdeadbeefdeadbeefdeadbeef@glitchtip.example.com/1' },
        projectId: 1,
      }]))
    })
    let parentOk = true
    try {
      parentServer.listen(0, '127.0.0.1')
      await once(parentServer, 'listening')
      const { port: pPort } = parentServer.address()
      const jar = join(work, 'parent2.jar')
      // 目标主机写 `${pPort}` 所在的 loopback 不行（是 IP）——用 host 别名：
      // `foo.localhost` 在多数解析器里指向 127.0.0.1，正是父域 `.localhost` 的子域。
      writeFileSync(jar, [
        '# Netscape HTTP Cookie File',
        '.localhost\tTRUE\t/\tFALSE\t1999999999\tsessionid\tPARENT_DOMAIN',
        '',
      ].join('\n'))
      // 预检解析栈：`foo.localhost` 依赖 systemd-resolved 一类的 `.localhost` 合成。
      // 解析不到时**显式跳过**并说明原因 —— 既不静默通过（那会假装有覆盖），
      // 也不假红（2026-09-17 第 3 轮审计 R3-ops-1：干净容器里曾整条 yarn check 变红）。
      const resolvable = await new Promise((r) => {
        import('node:dns').then(({ lookup }) => lookup('foo.localhost', (err, addr) => r(!err && addr === '127.0.0.1')))
      })
      if (!resolvable) {
        skips += 1
        console.log('  ⊘ SKIP 父域正例：本机解析栈不合成 .localhost（无法构造子域场景）')
      } else {
        await runScript(['--base-url', `http://foo.localhost:${pPort}`, '--cookies', jar])
        const last = seenCookies.at(-1)
        check(
          '父域 .localhost 匹配子域 foo.localhost ⇒ 真发出 cookie',
          /sessionid=PARENT_DOMAIN/.test(String(last)),
          `实际收到 cookie=${String(last)}`,
        )
      }
    } catch {
      parentOk = false
      check('父域用例可运行（foo.localhost 可解析）', false, '无法建立父域场景')
    } finally {
      if (parentOk) parentServer.close()
    }
  }

  // ---------------------------------------------------------------- JSON 契约
  console.log('\n【输出契约】--json 必须是合法 JSON 且含 exitCode 字段')
  {
    const r = await runScript(['--base-url', baseUrl, '--cookies', '/dev/null', '--json'])
    let parsed = null
    try {
      parsed = JSON.parse(r.stdout)
    } catch {
      /* 断言下面会报 */
    }
    check('stdout 可被 JSON.parse', parsed !== null, '合法 JSON')
    check('含 exitCode 字段', parsed !== null && 'exitCode' in parsed, `exitCode=${parsed?.exitCode}`)
    check('exitCode 与进程退出码一致', parsed !== null && parsed.exitCode === r.code,
      `report=${parsed?.exitCode} process=${r.code}`)
  }

  server.close()
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(
  `\n${failures === 0 ? '→ PASS' : '→ FAIL'}（${checks - failures}/${checks} 通过` +
  `${skips > 0 ? `，${skips} 项因环境跳过` : ''}）`,
)
process.exit(failures === 0 ? 0 : 1)
