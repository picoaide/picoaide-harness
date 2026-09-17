import { useCallback, useEffect, useRef, useState } from 'react'
import { request, ADMIN_API } from '../api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Textarea } from '../components/ui/textarea'
import { Label } from '../components/ui/label'
import { Badge } from '../components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../components/ui/dialog'
import { Skeleton } from '../components/ui/skeleton'
import { EmptyState } from '../components/empty-state'
import { ArchivePreviewDialog, ArchivePreviewData } from '../components/archive-preview-dialog'
import { TransferOwnerDialog } from '../components/transfer-owner-dialog'
import { CapabilityLockPanel } from '../components/capability-lock-panel'
import { GrantDialog } from '../components/grant-dialog'
import { Store, Download, Package, Activity, UserCog } from 'lucide-react'

interface Skill {
  id: number
  name: string
  version: string
  description: string
  author: string
  enabled: boolean
  /** 0040: 'git' | 'upload' — upload 模式归档存 DB。 */
  source?: string
  downloads: number
  calls: number
  /** 0059: 官方属性(蓝标, 仅管理员可上传)。 */
  official?: boolean
  /** 0059 质量(精选 featured 保留; 官方语义移交 official)。 */
  quality?: string
  /** 来源渠道: market=市场(管理端直上架) || org=员工上传(审批后)。 */
  channel?: 'market' | 'org'
}

interface Dept {
  id: number
  parent_id: number
  name: string
}

// ---- 表单状态 ----
const EMPTY_SKILL_FORM = {
  name: '',
  version: '',
  description: '',
  author: '',
  // 压缩包(0052:归档是唯一内容入口)。
  archiveFile: null as File | null,
}

/** 归档上传表单(0040 存 DB / 0052 唯一入口):版本必填。 */
function isUploadMode(form: typeof EMPTY_SKILL_FORM): boolean {
  return form.archiveFile !== null
}

export default function Marketplace() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [departments, setDepartments] = useState<Dept[]>([])

  const [skillsLoading, setSkillsLoading] = useState(true)
  const [skillsError, setSkillsError] = useState('')
  // 操作失败(下架/上架等)独立错误态:不与「技能加载失败」混淆(UX 改进)
  const [opError, setOpError] = useState('')

  // 技能:新增/编辑共用一个表单(审计 A5-M2)
  const [skillDialog, setSkillDialog] = useState(false)
  const [skillEdit, setSkillEdit] = useState<Skill | null>(null)
  const [skillForm, setSkillForm] = useState(EMPTY_SKILL_FORM)
  // 编辑已上架技能时上传新版压缩包(0040 上传模式)
  // 审批预览:管理员上架前后都要能看到包内到底是什么(2026-09-01)
  const [preview, setPreview] = useState<ArchivePreviewData | null>(null)
  const [previewKey, setPreviewKey] = useState('')
  const [previewName, setPreviewName] = useState('')
  const [replaceDialog, setReplaceDialog] = useState<Skill | null>(null)
  const [replaceFile, setReplaceFile] = useState<File | null>(null)
  const [replaceVersion, setReplaceVersion] = useState('')
  const [replaceBusy, setReplaceBusy] = useState(false)

  // 授权
  const [grantDialog, setGrantDialog] = useState<{ kind: 'skill'; name: string; id: number } | null>(null)
  // 归属转移(2026-09-02):技能归属人 = 首个成功占名者(apps.owner)。
  // 锁定管理(2026-09-04 从审批页迁入市场页)
  const [lockOpen, setLockOpen] = useState(false)
  const [transferSkill, setTransferSkill] = useState<Skill | null>(null)

  // 弹窗内操作错误(审计 A5-L4):靠近操作点展示,页面级错误只留给加载失败
  const [dialogError, setDialogError] = useState('')
  // P1-6: 提交中操作标识(双击守卫 + 按钮禁用/loading)。null = 空闲,值为操作 key。
  const [busy, setBusy] = useState<string | null>(null)

  const loadSkills = useCallback(async () => {
    setSkillsLoading(true)
    setSkillsError('')
    try {
      const [s, approvals] = await Promise.all([
        request(`${ADMIN_API}/skills`),
        request(`${ADMIN_API}/capabilities/approvals?status=approved&type=skill`).catch(() => ({ approvals: [] })),
      ])
      const merged: Skill[] = [...(s.skills ?? [])]
      for (const row of (approvals.approvals ?? []) as { name: string; version: string; display_name: string; description: string; author: string; downloads?: number; calls?: number; official?: boolean; quality?: string }[]) {
        // UI 归一: 员工上传(审批通过)的技能并入技能市场页, 来源徽章 org
        merged.push({
          id: 0, name: row.name, version: row.version, description: row.description,
          author: row.author, enabled: true, downloads: row.downloads ?? 0, calls: row.calls ?? 0,
          official: row.official, quality: row.quality, channel: 'org',
        })
      }
      // 排序定案: 官方 → 精选(featured) → score(calls*3+downloads) 降序 → 名称升序
      const score = (x: Skill): number => (x.calls ?? 0) * 3 + (x.downloads ?? 0)
      merged.sort((a, b) => {
        if (!!a.official !== !!b.official) return a.official ? -1 : 1
        if (!!(a.quality === 'featured') !== !!(b.quality === 'featured')) return a.quality === 'featured' ? -1 : 1
        if (score(a) !== score(b)) return score(b) - score(a)
        return a.name.localeCompare(b.name)
      })
      setSkills(merged)
    } catch (err: any) {
      setSkillsError(err.message)
    } finally {
      setSkillsLoading(false)
    }
  }, [])

  const loadDepartments = useCallback(async () => {
    try {
      const dep = await request(`${ADMIN_API}/departments`)
      setDepartments(dep.departments ?? [])
    } catch {
      // 部门列表仅授权对话框使用,加载失败不阻塞主页面
    }
  }, [])

  useEffect(() => { loadSkills(); loadDepartments() }, [loadSkills, loadDepartments])

  // ---- 技能 ----
  const archiveInput = useRef<HTMLInputElement>(null)

  async function saveSkill() {
    if (busy) return // P1-6: 双击守卫
    setDialogError('')
    const name = skillForm.name.trim()
    if (!name) { setDialogError('名称必填'); return }
    const uploadMode = isUploadMode(skillForm)
    // 0052:git 源模式已移除——新建技能必须随压缩包上架(发布期严格校验)。
    if (!skillEdit && !uploadMode) { setDialogError('请选择技能压缩包(.zip)'); return }
    if (uploadMode && !skillForm.version.trim()) { setDialogError('版本必填(需与包内 SKILL.md 的 version 一致)'); return }
    setBusy('save-skill')
    try {
      if (skillEdit) {
        await request(`${ADMIN_API}/skills/${encodeURIComponent(skillEdit.name)}`, {
          method: 'PUT',
          body: JSON.stringify({
            name: skillEdit.name,
            version: skillForm.version,
            description: skillForm.description,
            author: skillForm.author,
          }),
        })
      } else {
        // 先建行(仅登记名称与元数据),再上传归档(0052:归档唯一入口)。
        const created = await request(`${ADMIN_API}/skills`, {
          method: 'POST',
          body: JSON.stringify({
            name,
            version: '',
            description: skillForm.description,
            author: skillForm.author,
          }),
        })
        if (uploadMode) {
          const file = skillForm.archiveFile!
          const body = await readAsBase64(file)
          await request(`${ADMIN_API}/skills/${encodeURIComponent(name)}/archive`, {
            method: 'POST',
            body: JSON.stringify({ version: skillForm.version.trim(), archive: body }),
          })
          if (created?.skill) created.skill.source = 'upload'
        }
      }
      setSkillDialog(false)
      setSkillEdit(null)
      setSkillForm(EMPTY_SKILL_FORM)
      loadSkills()
    } catch (err: any) {
      setDialogError(err.message)
    } finally {
      setBusy(null)
    }
  }

  function openCreateSkill() {
    setDialogError('')
    setSkillEdit(null)
    setSkillForm(EMPTY_SKILL_FORM)
    setSkillDialog(true)
  }

  function openEditSkill(s: Skill) {
    setDialogError('')
    setSkillEdit(s)
    setSkillForm({ name: s.name, version: s.version, description: s.description, author: s.author, archiveFile: null })
    setSkillDialog(true)
  }

  async function disableSkill(name: string) {
    if (busy) return // P1-6: 双击守卫
    if (!window.confirm(`下架技能 ${name}?员工建议清单将不再展示(可重新上架)。`)) return
    setOpError('')
    setBusy(`disable-skill-${name}`)
    try {
      await request(`${ADMIN_API}/skills/${encodeURIComponent(name)}`, { method: 'DELETE' })
      loadSkills()
    } catch (err: any) {
      setOpError(`下架失败:${err.message}`)
    } finally {
      setBusy(null)
    }
  }

  async function enableSkill(name: string) {
    if (busy) return // P1-6: 双击守卫
    setOpError('')
    setBusy(`enable-skill-${name}`)
    try {
      await request(`${ADMIN_API}/skills/${encodeURIComponent(name)}/enable`, { method: 'POST' })
      loadSkills()
    } catch (err: any) {
      setOpError(`上架失败:${err.message}`)
    } finally {
      setBusy(null)
    }
  }

  // ---- 审批预览 ----
  const openPreview = async (s2: Skill) => {
    setPreviewName(s2.name)
    setPreviewKey(`${s2.name}@${s2.version}`)
    setPreview(null)
    try {
      const data = await request<ArchivePreviewData>(`${ADMIN_API}/skills/${encodeURIComponent(s2.name)}/preview`)
      setPreview(data)
    } catch (e) {
      const err = e as Error
      setOpError(`预览失败:${err.message}`)
      setPreviewKey('')
    }
  }

  // ---- 存量规范化(决策 2026-09-01 §八:产出合规的 patch+1 新版本) ----
  const normalize = async (s2: Skill) => {
    if (!window.confirm(
      `规范化「${s2.name}」?\n\n将把包内 SKILL.md 改写为符合发布标准的内容` +
      `(中文名迁到 title、剥离 BOM、补齐必填字段),并作为新版本发布。原版本不会被修改。`)) return
    setBusy(`normalize-${s2.name}`)
    setOpError('')
    try {
      const r = await request<{ version: string; changes?: string[] }>(
        `${ADMIN_API}/skills/${encodeURIComponent(s2.name)}/normalize`, { method: 'POST' })
      window.alert(`已规范化为 v${r.version}\n\n${(r.changes ?? []).join('\n') || '无需改动'}`)
      await loadSkills()
    } catch (e) {
      setOpError(`规范化失败:${(e as Error).message}`)
    } finally { setBusy(null) }
  }

  // ---- 上传新版压缩包(0040:归档存 DB) ----
  function openReplace(s: Skill) {
    setReplaceDialog(s)
    setReplaceFile(null)
    setReplaceVersion('')
    setDialogError('')
  }

  async function doReplace() {
    if (!replaceDialog || replaceBusy) return
    if (!replaceFile) { setDialogError('请选择压缩包(.zip)'); return }
    if (!replaceVersion.trim()) { setDialogError('版本必填'); return }
    setReplaceBusy(true)
    setDialogError('')
    try {
      const body = await readAsBase64(replaceFile)
      await request(`${ADMIN_API}/skills/${encodeURIComponent(replaceDialog.name)}/archive`, {
        method: 'POST',
        body: JSON.stringify({ version: replaceVersion.trim(), archive: body }),
      })
      setReplaceDialog(null)
      loadSkills()
    } catch (err: any) {
      setDialogError(err.message)
    } finally {
      setReplaceBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      {opError && <div className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{opError}</div>}

      <Card>
        <CardHeader>
          <CardTitle>技能(Skill)</CardTitle>
          <CardDescription>官方技能(蓝标) / 员工上传(审批后);授权制;未授权用户不可见不可安装</CardDescription>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setLockOpen(true)}>锁定管理</Button>
            <Button size="sm" onClick={openCreateSkill}>上架技能</Button>
          </div>
        </CardHeader>
        <CardContent>
          {skillsError ? (
            <div className="flex items-center justify-between rounded-md border border-destructive/40 p-3 text-sm text-destructive">
              <span>技能加载失败:{skillsError}</span>
              <Button size="sm" variant="outline" onClick={loadSkills}>重试</Button>
            </div>
          ) : skillsLoading ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-40 w-full" />)}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {skills.map((s) => (
                <div
                  key={s.name}
                  className="group flex flex-col rounded-lg border bg-card p-4 transition-all duration-200 hover:border-[#1E40AF]/40 hover:shadow-md"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-blue-50 text-[#1E40AF]">
                        <Store className="h-4 w-4" />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">{s.name}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {s.version ? `v${s.version}` : '—'}
                          {s.source === 'upload' && <Badge variant="outline" className="ml-1.5 px-1 py-0 text-[10px]">上传包</Badge>}
                        </div>
                      </div>
                    </div>
                    <span className="flex items-center gap-1.5">
                      {s.official && <Badge className="bg-[#1E40AF] text-white hover:bg-[#1E40AF]">官方</Badge>}
                      {s.quality === 'featured' && <Badge variant="secondary">精选</Badge>}
                      {s.channel === 'org' && <Badge variant="outline">员工上传</Badge>}
                      {s.enabled ? <Badge variant="success">上架</Badge> : <Badge variant="outline">已下架</Badge>}
                    </span>
                  </div>
                  <p className="mt-3 line-clamp-3 flex-1 text-xs leading-relaxed text-slate-500" title={s.description || undefined}>{s.description || '暂无描述'}</p>
                  <div className="mt-3 flex items-center gap-1.5 truncate text-xs text-slate-500">
                    <Package className="h-3 w-3 shrink-0" /><span className="truncate">压缩包直存数据库</span>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 truncate text-xs text-slate-500" title="归属人:首个成功发布者,只有归属人(及管理员)能更新该技能">
                    <UserCog className="h-3 w-3 shrink-0" /><span className="truncate">归属 {s.official ? '官方' : (s.author || '未指定')}</span>
                  </div>
                  <div className="mt-2 flex items-center gap-3 text-[11px] text-slate-500">
                    <span className="inline-flex items-center gap-1"><Download className="h-3 w-3" />下载 {s.downloads ?? 0}</span>
                    <span className="inline-flex items-center gap-1"><Activity className="h-3 w-3" />调用 {s.calls ?? 0}</span>
                  </div>
                  <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-3">
                    <Button variant="outline" onClick={() => void openPreview(s)}>预览</Button>
                    <Button variant="outline" disabled={busy !== null} onClick={() => void normalize(s)}>
                      {busy === `normalize-${s.name}` ? '规范化中…' : '规范化'}
                    </Button>
                    <Button variant="outline" onClick={() => openEditSkill(s)}>编辑</Button>
                    <Button variant="outline" onClick={() => openReplace(s)}>上传新版</Button>
                    <Button variant="outline" onClick={() => setTransferSkill(s)} title="转移归属(负责人)">归属</Button>
                    <Button variant="outline" onClick={() => setGrantDialog({ kind: 'skill', name: s.name, id: 0 })}>授权</Button>
                    {s.enabled
                      ? <Button variant="destructive" disabled={busy !== null} onClick={() => disableSkill(s.name)}>{busy === `disable-skill-${s.name}` ? '下架中…' : '下架'}</Button>
                      : <Button variant="outline" disabled={busy !== null} onClick={() => enableSkill(s.name)}>{busy === `enable-skill-${s.name}` ? '上架中…' : '重新上架'}</Button>}
                  </div>
                </div>
              ))}
              {skills.length === 0 && (
                <div className="col-span-full">
                  <EmptyState
                    icon={<Store className="h-5 w-5 text-muted-foreground" />}
                    title="暂无技能"
                    desc="点击「上架技能」上传压缩包或从 Git 源接入第一个技能"
                  />
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 新增/编辑弹窗 */}
      <Dialog open={skillDialog} onOpenChange={(v) => { setSkillDialog(v); if (!v) { setSkillEdit(null); setSkillForm(EMPTY_SKILL_FORM) } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{skillEdit ? `编辑技能 ${skillEdit.name}` : '上架技能'}</DialogTitle>
            <DialogDescription>两种模式:压缩包上传(推荐,归档直存数据库)或 Git 源</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="skill-name">名称</Label>
              <Input id="skill-name" value={skillForm.name} disabled={!!skillEdit} onChange={(e) => setSkillForm({ ...skillForm, name: e.target.value })} />
              {skillEdit && <p className="text-xs text-muted-foreground">名称不可修改(唯一键);如需改名请下架后重新上架</p>}
            </div>
            <div className="space-y-1">
              <Label htmlFor="skill-archive">压缩包(.zip,推荐)</Label>
              <input
                id="skill-archive"
                ref={archiveInput}
                type="file"
                accept=".zip"
                className="block w-full text-sm"
                onChange={(e) => setSkillForm({ ...skillForm, archiveFile: e.target.files?.[0] ?? null })}
              />
              <p className="text-xs text-muted-foreground">
                归档直存数据库;包内 SKILL.md 需含 name/title/version/description/author/category,发布时严格校验
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {/* 编辑态不显示版本:版本只能随归档一起由「上传新版」写入
                  (元数据 PUT 改版本会造成行版本与包内容失配,服务端已拒绝)。 */}
              <div className="space-y-1" hidden={!!skillEdit}>
                <Label htmlFor="skill-version">版本(须与包内 SKILL.md 的 version 一致)</Label>
                <Input id="skill-version" value={skillForm.version} onChange={(e) => setSkillForm({ ...skillForm, version: e.target.value })} />
                <p className="text-xs text-muted-foreground">压缩包模式必填</p>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="skill-desc">描述(G5: 编辑态可覆盖包内值)</Label>
              <Textarea
                id="skill-desc"
                rows={3}
                value={skillForm.description ?? ''}
                onChange={(e) => setSkillForm({ ...skillForm, description: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">新上架时描述取自包内 SKILL.md;可在此修正展示文案。</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="skill-author">作者(G5: 编辑态可覆盖包内值)</Label>
              <Input id="skill-author" value={skillForm.author ?? ''} onChange={(e) => setSkillForm({ ...skillForm, author: e.target.value })} />
              <p className="text-xs text-muted-foreground">作者 = 归属人(可经「归属」转移);此处仅改署名展示。</p>
            </div>
            {dialogError && <div className="text-sm text-destructive">{dialogError}</div>}
            <Button className="w-full" disabled={busy !== null} onClick={saveSkill}>{busy === 'save-skill' ? '处理中…' : (skillEdit ? '保存修改' : '上架')}</Button>
          </div>
        </DialogContent>
      </Dialog>

      <ArchivePreviewDialog
        openKey={previewKey}
        data={preview}
        mainTitle="SKILL.md"
        mainContent={preview?.skill_md ?? ''}
        fileBase={previewName ? `${ADMIN_API}/skills/${encodeURIComponent(previewName)}` : ''}
        onClose={() => { setPreviewKey(''); setPreview(null) }}
      />

      {/* 锁定管理(2026-09-04 从审批页迁入市场页) */}
      <CapabilityLockPanel open={lockOpen} onClose={() => setLockOpen(false)} />

      {/* 归属转移(2026-09-02):公共弹窗,与服务端的 /apps/:kind/:app_id/owner 同源。 */}
      <TransferOwnerDialog
        open={transferSkill !== null}
        kind="skill"
        name={transferSkill?.name ?? ''}
        displayName={transferSkill?.name}
        currentOwner={transferSkill?.author ?? ''}
        onClose={() => { setTransferSkill(null) }}
        onSaved={() => { setTransferSkill(null); void loadSkills() }}
      />

      {/* 上传新版压缩包弹窗(0040) */}
      <Dialog open={replaceDialog !== null} onOpenChange={(v) => { if (!v) { setReplaceDialog(null); setDialogError('') } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>上传新版「{replaceDialog?.name}」</DialogTitle>
            <DialogDescription>压缩包直存数据库;版本号与包内 SKILL.md 元数据需对应</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="replace-version">版本</Label>
              <Input id="replace-version" value={replaceVersion} placeholder="如 2.0.0" onChange={(e) => setReplaceVersion(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>压缩包(.zip)</Label>
              <input
                type="file"
                accept=".zip"
                className="block w-full text-sm"
                onChange={(e) => setReplaceFile(e.target.files?.[0] ?? null)}
              />
            </div>
            {dialogError && <div className="text-sm text-destructive">{dialogError}</div>}
            <Button className="w-full" disabled={replaceBusy} onClick={doReplace}>{replaceBusy ? '上传中…' : '上传'}</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 2026-09-17 独立验证 R3：这里原先有 GrantDialog 的第二份拷贝（同一逻辑两份实现），
          其中"授权列表未落地也渲染未授权 + 保存可点"会导致 PUT {groups: []} 清空全部部门授权。
          统一用 components/grant-dialog.tsx（已加 grantsLoaded 闸门）。 */}
      <GrantDialog
        open={grantDialog !== null}
        name={grantDialog?.name ?? ''}
        basePath={`${ADMIN_API}/skills/${encodeURIComponent(grantDialog?.name ?? '')}`}
        departments={departments}
        onClose={() => setGrantDialog(null)}
        onSaved={() => loadSkills()}
      />
    </div>
  )
}

/** 读取文件为 base64(与共享技能上传同构:JSON base64 归档)。 */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsDataURL(file)
  })
}
