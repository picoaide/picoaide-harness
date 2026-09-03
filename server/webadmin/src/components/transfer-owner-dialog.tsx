import { useEffect, useRef, useState } from 'react'
import { request, ADMIN_API } from '../api'
import { Button } from './ui/button'
import { Label } from './ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator,
} from './ui/command'

interface UserOption {
  username: string
  display_name?: string
}

/**
 * 归属转移弹窗(2026-09-02,统一复用),2026-09-04 改为「用户可搜索下拉」:
 * PUT /api/server/admin/apps/:kind/:app_id/owner —— 市场技能管理页与
 * 能力中心组织审批页共用同一实现。归属只约束「谁能续传新版本」;
 * 转移后旧负责人不能再上传,新负责人获得续传权(版本须递增),服务端审计。
 *
 * 新负责人必须从服务端用户列表搜索选中(不允许自由输入),避免把用户名
 * 打错导致「转移给不存在的用户」;数据源 = GET /api/server/admin/users
 * (q= 服务端搜索,size≤200,super_admin 有 users:read 权限)。
 */
export function TransferOwnerDialog({
  open,
  kind,
  name,
  displayName,
  currentOwner,
  onClose,
  onSaved,
}: {
  open: boolean
  kind: 'skill' | 'agent'
  name: string
  displayName?: string
  currentOwner: string
  onClose: () => void
  onSaved: () => void
}) {
  const [owner, setOwner] = useState('')
  const [toOfficial, setToOfficial] = useState(false)
  const [query, setQuery] = useState('')
  const [users, setUsers] = useState<UserOption[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [listOpen, setListOpen] = useState(false)

  const seq = useRef(0)
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const loadUsers = async (q: string) => {
    const current = ++seq.current
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: '1', size: '200' })
      if (q !== '') params.set('q', q)
      const data = await request(`${ADMIN_API}/users?${params}`) as { users?: UserOption[] }
      if (current !== seq.current) return // 过期响应丢弃(快速输入时只有最新结果生效)
      setUsers(data.users ?? [])
    } catch {
      if (current === seq.current) setUsers([])
    } finally {
      if (current === seq.current) setLoading(false)
    }
  }

  // 打开时重置并拉取初始候选(空查询 = 前 200 名用户);查询输入防抖服务端搜索。
  const [lastOpen, setLastOpen] = useState(false)
  if (open !== lastOpen) {
    setLastOpen(open)
    if (open) {
      setOwner('')
      setToOfficial(false)
      setQuery('')
      setError('')
      setBusy(false)
      setListOpen(false)
      void loadUsers('')
    }
  }

  const onQueryChange = (value: string) => {
    setQuery(value)
    if (debounce.current !== undefined) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => { void loadUsers(value) }, 250)
  }

  useEffect(() => () => {
    if (debounce.current !== undefined) clearTimeout(debounce.current)
  }, [])

  const transfer = async () => {
    if ((!toOfficial && (owner === '' || owner === currentOwner)) || busy) return
    setBusy(true)
    setError('')
    try {
      await request(`${ADMIN_API}/apps/${kind}/${encodeURIComponent(name)}/owner`, {
        method: 'PUT',
        body: JSON.stringify(toOfficial ? { official: true } : { owner }),
      })
      onSaved()
      onClose()
    } catch (err: any) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>转移归属</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          将「{displayName || name}」的维护权转移给新负责人:原负责人不能再上传新版本,新负责人获得续传权(版本须递增)。
        </p>
        <div className="flex items-center gap-2 rounded-md border p-3">
          <input
            type="radio"
            id="transfer-target-user"
            name="transfer-target"
            className="h-4 w-4 accent-[#4176E6]"
            checked={!toOfficial}
            onChange={() => { setToOfficial(false) }}
          />
          <Label htmlFor="transfer-target-user" className="flex-1 cursor-pointer text-sm">
            转给用户(从下方列表搜索选择)
          </Label>
          <input
            type="radio"
            id="transfer-target-official"
            name="transfer-target"
            className="h-4 w-4 accent-[#4176E6]"
            checked={toOfficial}
            onChange={() => { setToOfficial(true) }}
          />
          <Label htmlFor="transfer-target-official" className="cursor-pointer text-sm font-medium text-[#1E40AF]">
            归属官方(蓝标,仅管理员可上传新版)
          </Label>
        </div>
        {!toOfficial && (
        <Popover open={listOpen} onOpenChange={setListOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" role="combobox" className="w-full justify-between font-normal">
              <span className={owner === '' ? 'text-muted-foreground' : ''}>
                {owner === '' ? (loading ? '加载用户…' : '搜索并选择新归属人') : owner}
              </span>
              <span className="opacity-50">▾</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
            <Command shouldFilter={false}>
              <CommandInput
                placeholder="输入用户名或显示名搜索…"
                aria-label="新归属人用户名"
                value={query}
                onValueChange={onQueryChange}
              />
              <CommandList>
                <CommandEmpty>
                  {loading ? '搜索中…' : query === '' ? '暂无用户' : `未找到匹配「${query}」的用户`}
                </CommandEmpty>
                <CommandGroup>
                  {users.map((u) => {
                    const isCurrent = u.username === currentOwner
                    return (
                      <CommandItem
                        key={u.username}
                        value={`${u.username}${u.display_name ? ` ${u.display_name}` : ''}`}
                        disabled={isCurrent}
                        onSelect={() => {
                          setOwner(u.username)
                          setQuery('')
                          setListOpen(false)
                        }}
                      >
                        <span className="font-mono">{u.username}</span>
                        {u.display_name && u.display_name !== u.username && (
                          <span className="ml-2 text-muted-foreground">{u.display_name}</span>
                        )}
                        {isCurrent && <span className="ml-auto text-[10px] text-muted-foreground">当前归属</span>}
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
                <CommandSeparator />
                <p className="p-2 text-[10px] text-muted-foreground">仅可选择系统内已有用户;匹配失败请检查用户名。</p>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        )}
        {toOfficial && (
          <p className="text-xs text-muted-foreground">
            归属官方后:技能/智能体卡片亮蓝色「官方」标,普通员工不能再上传新版,仅管理员可维护。当前归属：
            <span className="font-mono">{currentOwner || '官方'}</span>
          </p>
        )}
        {!toOfficial && (
        <p className="text-xs text-muted-foreground">
          当前归属人：<span className="font-mono">{currentOwner || '(官方)'}</span>
        </p>
        )}
        {!toOfficial && (
        <p className="text-xs text-muted-foreground">仅可选择系统内已有用户;匹配失败请检查用户名。</p>
        )}
        {error !== '' && <div className="text-sm text-destructive">{error}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button disabled={busy || owner === '' || owner === currentOwner} onClick={() => { void transfer() }}>
            {busy ? '处理中…' : '确认转移'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
