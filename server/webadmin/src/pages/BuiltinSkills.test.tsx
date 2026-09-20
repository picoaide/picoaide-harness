import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BuiltinSkills from './BuiltinSkills'
import { ApiError, request } from '../api'
import { setCurrentAdmin } from '../lib/rbac'

/**
 * 平台内置技能（管理端只读面，2026-09-19）。
 *
 * 夹具与 Go 侧 `skillseed.Handlers.AdminListBuiltin` 的 JSON 形状逐字对齐（跨语言契约）：
 *   { dir, dir_exists, skills:[{name,version,title,description,author,category,sha256,size,files,source}],
 *     problems:[{name,reason}], counts:{skills,problems}, load_error? }
 *
 * 三条用例对应这页存在的三个理由：
 *  ① 管理员能看到镜像里带了什么（名称/版本/大小/文件数/sha256）；
 *  ② 技能**坏掉**时必须看到名字与原因（此前只有启动日志里有）；
 *  ③ 空清单要区分"目录不存在（正常）"与"目录在但全坏了（故障）"。
 */
const mockRequest = vi.mocked(request)

const SKILL = {
  name: 'app-builder',
  version: '1.0.0',
  title: '应用构建（WASM 应用）',
  description: '用 Go 写一个 PicoAide 应用平台上的 WASM 应用并发布',
  author: 'PicoAide',
  category: '应用开发',
  sha256: '4face91471df1b872a1d64150e3ee684e1645ae80939218e92b3698fb20cf271',
  size: 43282,
  files: 11,
  source: 'builtin',
}

const VIEW = {
  dir: '/opt/picoaide/skills',
  dir_exists: true,
  skills: [SKILL],
  problems: [] as Array<{ name: string; name_bytes_hex?: string; reason: string }>,
  counts: { skills: 1, problems: 0 },
}

beforeEach(() => {
  mockRequest.mockReset()
  // 页面按 capability:read 收敛（体验层；服务端 RequirePermission 才是护栏）。
  setCurrentAdmin({ role: 'super_admin', permissions: ['capability:read'] })
})

describe('BuiltinSkills 平台内置技能（只读诊断面）', () => {
  it('展示资产目录与镜像里那条技能的元数据', async () => {
    mockRequest.mockResolvedValueOnce(VIEW as never)
    render(<BuiltinSkills />)

    expect(await screen.findByTestId('builtin-dir')).toHaveTextContent('/opt/picoaide/skills')
    const row = await screen.findByTestId('builtin-row-app-builder')
    expect(row).toHaveTextContent('app-builder')
    expect(row).toHaveTextContent('1.0.0')
    expect(row).toHaveTextContent('11')            // 文件数
    expect(row).toHaveTextContent('42.3 KiB')      // 大小
    expect(row).toHaveTextContent('4face91471df…') // sha256 短形态（完整值在 title）
    expect(mockRequest).toHaveBeenCalledWith('/api/server/admin/skills/builtin')
    // 正常资产不得渲染告警块。
    expect(screen.queryByTestId('builtin-problems')).not.toBeInTheDocument()
    expect(screen.queryByTestId('builtin-load-error')).not.toBeInTheDocument()
  })

  it('未收录条目点名技能与原因（这正是"接口 200 + 空数组"看不见的部分）', async () => {
    mockRequest.mockResolvedValueOnce({
      ...VIEW,
      skills: [],
      problems: [{
        name: 'app-builder',
        reason: 'manifest 校验未通过: IDENTITY_MISMATCH[name]: SKILL.md 的 name("picoaide-app-builder")必须等于应用 ID("app-builder")',
      }],
      counts: { skills: 0, problems: 1 },
    } as never)
    render(<BuiltinSkills />)

    const box = await screen.findByTestId('builtin-problems')
    expect(box).toHaveTextContent('1 条未收录')
    expect(box).toHaveTextContent('app-builder')
    expect(box).toHaveTextContent('必须等于应用 ID')
    // 空清单 + 有原因 ⇒ 不能说成"目录不存在"。
    expect(await screen.findByTestId('builtin-empty')).toHaveTextContent('没有一条技能通过校验')
  })

  // F3-7（2026-09-19 第三轮审计）：标题的计数与列表口径必须一致。
  // 历史问题：标题写「N 条技能被跳过」，而列表里已经包含"资产根散文件"这类**不是技能**
  // 的条目（服务端 Problem 的语义早就扩了），两个口径打架 ⇒ 管理员按标题理解会漏判。
  // 判据是**数量语义一致**（标题里的数字 == 列表条目数 == 服务端 problems 长度），
  // 不是"文案里出现某个词"。
  it('标题计数与列表条目数是同一个口径（散文件也算未收录条目）', async () => {
    mockRequest.mockResolvedValueOnce({
      ...VIEW,
      skills: [SKILL],
      problems: [
        { name: 'SKILL.md', reason: '资产根目录只放技能子目录（<name>/SKILL.md）；散文件不会被打包下发' },
        { name: '.DS_Store', reason: '资产根目录只放技能子目录（<name>/SKILL.md）；散文件不会被打包下发' },
        { name: 'broken-skill', reason: 'manifest 校验未通过: 缺少 name' },
      ],
      counts: { skills: 1, problems: 3 },
    } as never)
    render(<BuiltinSkills />)

    const count = await screen.findByTestId('builtin-count')
    const list = await screen.findByTestId('builtin-problem-list')
    const items = screen.getAllByTestId('builtin-problem-item')
    // 标题里的数字必须等于列表条目数（3），且与可用技能数 1 并列显示。
    expect(count).toHaveTextContent('1 条可用')
    expect(count).toHaveTextContent('3 条未收录')
    expect(items).toHaveLength(3)
    expect(list).toHaveTextContent('.DS_Store')
    expect(list).toHaveTextContent('broken-skill')
    // 口径一致性断言（不是"存在某个词"）：标题里的数字 == 真实条目数。
    const badgeText = count.textContent ?? ''
    const shown = Number(/·\s*(\d+)\s*条未收录/u.exec(badgeText)?.[1] ?? '-1')
    expect(shown).toBe(items.length)
  })

  // F3-6（2026-09-19 第三轮审计）：非法 UTF-8 文件名在 JSON 里退化成 `\ufffd`
  // （两个不同的坏名字会显示成同一个 `��A`）⇒ 服务端补 name_bytes_hex，管理端必须
  // 把它渲染出来，管理员才能定位到具体文件。
  it('非法 UTF-8 名字渲染精确字节形态（两个坏名字可区分）', async () => {
    mockRequest.mockResolvedValueOnce({
      ...VIEW,
      skills: [],
      problems: [
        { name: '\ufffd\ufffdA', name_bytes_hex: 'ff fe 41', reason: '资产根目录只放技能子目录（<name>/SKILL.md）；散文件不会被打包下发' },
        { name: '\ufffd\ufffdB', name_bytes_hex: 'ff fd 42', reason: '资产根目录只放技能子目录（<name>/SKILL.md）；散文件不会被打包下发' },
      ],
      counts: { skills: 0, problems: 2 },
    } as never)
    render(<BuiltinSkills />)

    const hexes = await screen.findAllByTestId('builtin-problem-name-hex')
    expect(hexes).toHaveLength(2)
    // 精确且**互不相同**：这正是 Name 里 `��` 做不到的事。
    expect(hexes[0]).toHaveTextContent('ff fe 41')
    expect(hexes[1]).toHaveTextContent('ff fd 42')
    expect(hexes[0].textContent).not.toBe(hexes[1].textContent)
  })

  it('目录存在但里面什么都没有时，不得指向不存在的「被跳过」块（R2-SK-2）', async () => {
    // 服务端在"资产根目录放错层/放空目录"时给出的真实形状：skills 空、problems 空 ——
    // 空态文案此前无条件写"请看上面的「被跳过」原因"，而那个块根本不会渲染。
    mockRequest.mockResolvedValueOnce({
      dir: '/opt/picoaide/skills',
      dir_exists: true,
      skills: [],
      problems: [],
      counts: { skills: 0, problems: 0 },
    } as never)
    render(<BuiltinSkills />)

    const empty = await screen.findByTestId('builtin-empty')
    // 判据：引用与真实存在的块一致 —— 没有块就不能引用它；文案要指向真实的排查动作。
    expect(screen.queryByTestId('builtin-problems')).not.toBeInTheDocument()
    expect(empty).not.toHaveTextContent('未收录')
    expect(empty).toHaveTextContent('没有任何条目')
  })

  it('目录不存在是"没有内置技能"而不是故障（本地直跑二进制就是这个形态）', async () => {
    mockRequest.mockResolvedValueOnce({
      dir: '/opt/picoaide/skills',
      dir_exists: false,
      skills: [],
      problems: [],
      counts: { skills: 0, problems: 0 },
    } as never)
    render(<BuiltinSkills />)

    expect(await screen.findByTestId('builtin-empty')).toHaveTextContent('没有内置技能资产目录')
    expect(screen.queryByTestId('builtin-load-error')).not.toBeInTheDocument()
  })

  it('扫描失败时把原因显示出来（而不是只给一句"加载失败"）', async () => {
    mockRequest.mockResolvedValueOnce({
      dir: '/opt/picoaide/skills',
      dir_exists: false,
      skills: [],
      problems: [],
      load_error: 'skillseed: 读取内置技能目录 /opt/picoaide/skills: permission denied',
    } as never)
    render(<BuiltinSkills />)

    const box = await screen.findByTestId('builtin-load-error')
    expect(box).toHaveTextContent('资产扫描失败')
    expect(box).toHaveTextContent('permission denied')
  })

  it('刷新按钮重新拉取（改完镜像/资产后可当场核对）', async () => {
    mockRequest.mockResolvedValue(VIEW as never)
    const u = userEvent.setup()
    render(<BuiltinSkills />)
    await screen.findByTestId('builtin-row-app-builder')
    expect(mockRequest).toHaveBeenCalledTimes(1)

    await u.click(screen.getByTestId('builtin-refresh'))
    expect(mockRequest).toHaveBeenCalledTimes(2)
  })

  it('没有 capability:read 时不请求接口，只给一句说明', async () => {
    setCurrentAdmin({ role: 'auditor', permissions: ['audit:read'] })
    render(<BuiltinSkills />)
    expect(screen.getByText(/没有查看权限/)).toBeInTheDocument()
    expect(mockRequest).not.toHaveBeenCalled()
  })
  it('错误信封的 hints 与 details.field 都要显示(P1-6 残留:R1-uxw-12)', async () => {
    // 服务端同波次的口径:403/500 时会带 hints("还差什么条件")与 details.field
    // ("哪个字段被拒")。本页此前只读 message,把这两段整段丢掉 —— 与成本页/
    // 能力页的处理不一致。这里用**真实信封**断言三段都在。
    mockRequest.mockRejectedValueOnce(new ApiError(
      403, 'FORBIDDEN', '内置技能面不可用',
      undefined,
      ['需要 capability:read 权限', '联系平台管理员为该角色补权限点'],
      { field: 'skills' },
    ) as never)
    render(<BuiltinSkills />)

    const box = await screen.findByTestId('builtin-error')
    expect(box).toHaveTextContent('内置技能面不可用')       // message
    expect(box).toHaveTextContent('字段 skills')            // details.field
    expect(box).toHaveTextContent('需要 capability:read 权限') // hints
    expect(box).toHaveTextContent('联系平台管理员为该角色补权限点')
    // R1-uxw-14:错误反馈必须进 live 区(读屏用户此前听不到)。
    expect(box).toHaveAttribute('role', 'alert')
    expect(box).toHaveAttribute('aria-live', 'assertive')
  })
})
