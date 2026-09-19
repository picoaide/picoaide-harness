import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import BuiltinSkills from './BuiltinSkills'
import { request } from '../api'
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
  title: 'PicoAide 应用构建（WASM 应用）',
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
  problems: [] as Array<{ name: string; reason: string }>,
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

  it('技能被跳过时点名技能与原因（这正是"接口 200 + 空数组"看不见的部分）', async () => {
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
    expect(box).toHaveTextContent('1 条技能被跳过')
    expect(box).toHaveTextContent('app-builder')
    expect(box).toHaveTextContent('必须等于应用 ID')
    // 空清单 + 有原因 ⇒ 不能说成"目录不存在"。
    expect(await screen.findByTestId('builtin-empty')).toHaveTextContent('没有一条技能通过校验')
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
})
