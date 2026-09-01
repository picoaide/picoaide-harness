import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { request, ADMIN_API } from '../api'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Badge } from '../components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../components/ui/dialog'
import { Checkbox } from '../components/ui/checkbox'
import { Skeleton } from '../components/ui/skeleton'
import { PageHeader } from '../components/page-header'
import { EmptyState } from '../components/empty-state'
import { ArchivePreviewDialog, ArchivePreviewData } from '../components/archive-preview-dialog'
import { Store, Download, Package, Activity } from 'lucide-react'
import { deptTreeOptions } from '../lib/utils'

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
}

interface Grant {
  grantee_type: string
  grantee: string
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
  const [grants, setGrants] = useState<Grant[]>([])
  const [grantTarget, setGrantTarget] = useState('')
  const [grantGroups, setGrantGroups] = useState<string[]>([])
  const [grantSaving, setGrantSaving] = useState(false)

  // 弹窗内操作错误(审计 A5-L4):靠近操作点展示,页面级错误只留给加载失败
  const [dialogError, setDialogError] = useState('')
  // P1-6: 提交中操作标识(双击守卫 + 按钮禁用/loading)。null = 空闲,值为操作 key。
  const [busy, setBusy] = useState<string | null>(null)

  const loadSkills = useCallback(async () => {
    setSkillsLoading(true)
    setSkillsError('')
    try {
      const s = await request(`${ADMIN_API}/skills`)
      setSkills(s.skills ?? [])
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

  // ---- 授权 ----
  function grantPath(d: { kind: 'skill'; name: string; id: number }): string {
    return `${ADMIN_API}/skills/${encodeURIComponent(d.name)}/grant`
  }

  function grantsPath(d: { kind: 'skill'; name: string; id: number }): string {
    return `${ADMIN_API}/skills/${encodeURIComponent(d.name)}/grants`
  }

  async function openGrants(d: { kind: 'skill'; name: string; id: number }) {
    setDialogError('')
    try {
      const data = await request(grantsPath(d))
      setGrants(data.grants ?? [])
      setGrantGroups((data.grants ?? []).filter((g: Grant) => g.grantee_type === 'group').map((g: Grant) => g.grantee))
      setGrantTarget('')
      setGrantDialog(d)
    } catch (err: any) {
      setDialogError(err.message)
    }
  }

  // 保存部门多选 = 整组替换(原子;用户授权保留)。审计 A5-M6:
  // 覆盖语义必须确认 + 明示,避免取消勾选一个部门就把其它部门授权静默清掉。
  async function saveDeptGrants() {
    if (grantSaving || !grantDialog) return // P1-6: 双击守卫
    if (!window.confirm('保存部门授权将覆盖该资源的全部部门授权(用户授权不受影响)。确定保存?')) return
    setGrantSaving(true)
    setDialogError('')
    try {
      await request(grantsPath(grantDialog), {
        method: 'PUT',
        body: JSON.stringify({ groups: grantGroups }),
      })
      setGrantDialog(null)
      loadSkills()
    } catch (err: any) {
      setDialogError(err.message)
    } finally {
      setGrantSaving(false)
    }
  }

  function toggleGroup(name: string) {
    setGrantGroups((prev) => (prev.includes(name) ? prev.filter((g) => g !== name) : [...prev, name]))
  }

  async function doGrant() {
    if (busy || !grantDialog || !grantTarget.trim()) return // P1-6: 双击守卫
    const isGroup = grantTarget.trim().startsWith('@')
    setDialogError('')
    setBusy('grant')
    try {
      await request(grantPath(grantDialog), {
        method: 'PUT',
        body: JSON.stringify(isGroup ? { group: grantTarget.trim().slice(1) } : { username: grantTarget.trim() }),
      })
      setGrantTarget('')
      openGrants(grantDialog)
    } catch (err: any) {
      setDialogError(err.message)
    } finally {
      setBusy(null)
    }
  }

  async function revokeGrant(g: Grant) {
    if (busy || !grantDialog) return // P1-6: 双击守卫
    if (!window.confirm(`撤销「${g.grantee}」的授权?`)) return
    setDialogError('')
    setBusy(`revoke-${g.grantee_type}-${g.grantee}`)
    try {
      await request(grantPath(grantDialog), {
        method: 'DELETE',
        body: JSON.stringify(g.grantee_type === 'group' ? { group: g.grantee } : { username: g.grantee }),
      })
      openGrants(grantDialog)
    } catch (err: any) {
      setDialogError(err.message)
    } finally {
      setBusy(null)
    }
  }

  const deptOptions = useMemo(() => {
    const nameById = new Map(departments.map((d) => [d.id, d.name]))
    return deptTreeOptions(departments).map((o) => ({ ...o, name: nameById.get(o.id) ?? '' }))
  }, [departments])

  return (
    <div className="space-y-6">
      <PageHeader
        title="商城管理"
        desc="技能资源上架与授权分发:未授权用户不可见不可安装"
      />
      {opError && <div className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">{opError}</div>}

      <Card>
        <CardHeader>
          <CardTitle>技能(Skill)</CardTitle>
          <CardDescription>压缩包上传(归档存数据库)+ 授权制;未授权用户不可见不可安装(授权用户或部门组)</CardDescription>
          <div className="flex justify-end">
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
                    {s.enabled ? <Badge variant="success">上架</Badge> : <Badge variant="outline">已下架</Badge>}
                  </div>
                  <p className="mt-3 line-clamp-3 flex-1 text-xs leading-relaxed text-slate-500" title={s.description || undefined}>{s.description || '暂无描述'}</p>
                  <div className="mt-3 flex items-center gap-1.5 truncate text-xs text-slate-500">
                    <Package className="h-3 w-3 shrink-0" /><span className="truncate">压缩包直存数据库</span>
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
                    <Button variant="outline" onClick={() => openGrants({ kind: 'skill', name: s.name, id: 0 })}>授权</Button>
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
            <p className="text-xs text-muted-foreground">
              展示名 / 描述 / 作者 / 分类一律取自包内 SKILL.md（包内即真相），此处无需填写
            </p>
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

      <Dialog open={grantDialog !== null} onOpenChange={(v) => !v && setGrantDialog(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>授权「{grantDialog?.name}」</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {grants.length > 0 && (
              <div className="space-y-2 rounded-md border p-3">
                {grants.map((g) => (
                  <div key={`${g.grantee_type}:${g.grantee}`} className="flex flex-wrap items-center gap-2 text-sm">
                    <Badge variant={g.grantee_type === 'group' ? 'outline' : 'secondary'}>
                      {g.grantee_type === 'group' ? `@${g.grantee}` : g.grantee}
                    </Badge>
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => revokeGrant(g)}>{busy === `revoke-${g.grantee_type}-${g.grantee}` ? '撤销中…' : '撤销'}</Button>
                  </div>
                ))}
              </div>
            )}
            {grants.length === 0 && (
              <div className="text-xs text-muted-foreground">未授权:所有用户均不可见(严格默认),请授权用户或部门组</div>
            )}
            <div className="space-y-1">
              <Label>部门(多选:一个资源可授权多个部门,成员共享无需重复上传)</Label>
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2">
                {deptOptions.map((o) => (
                  <label key={o.id} className="flex cursor-pointer items-center gap-2 text-sm">
                    <Checkbox
                      checked={grantGroups.includes(o.name)}
                      onChange={() => toggleGroup(o.name)}
                    />
                    {o.label}
                  </label>
                ))}
                {deptOptions.length === 0 && <div className="text-xs text-muted-foreground">暂无部门</div>}
              </div>
              <p className="text-xs text-muted-foreground">「保存部门授权」将覆盖该资源的全部部门授权(用户授权不受影响)</p>
              <Button size="sm" variant="outline" className="mt-1 w-full" disabled={grantSaving || busy !== null} onClick={saveDeptGrants}>{grantSaving ? '保存中…' : '保存部门授权'}</Button>
            </div>
            <div className="space-y-1">
              <Label htmlFor="grant-user">用户名(单个,可选)</Label>
              <Input id="grant-user" placeholder="如 alice" value={grantTarget} onChange={(e) => setGrantTarget(e.target.value)} />
            </div>
            {dialogError && <div className="text-sm text-destructive">{dialogError}</div>}
            <Button className="w-full" disabled={!grantTarget.trim() || grantSaving || busy !== null} onClick={doGrant}>{busy === 'grant' ? '处理中…' : '添加用户授权'}</Button>
          </div>
        </DialogContent>
      </Dialog>
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
