import { useEffect, useRef, useState } from 'react'
import { request, ADMIN_API } from '../api'
import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from './ui/command'

export interface UserSearchOption {
  id: number
  username: string
  display_name?: string
}

/**
 * 用户可搜索下拉(G10 复用):输入关键词防抖调 GET /api/server/admin/users?q=
 * (服务端搜索, size≤200),候选展示 username+显示名,选中后显示 username。
 * 专用于「必须从系统内用户选择」的场景(部门主管/归属转移),杜绝手输错误。
 */
export function UserSearchSelect({
  value,
  onValueChange,
  placeholder,
  allowEmpty,
  emptyLabel,
  ariaLabel,
}: {
  value: string
  onValueChange: (value: string) => void
  placeholder?: string
  /** true 时候选首项为「未设置」(value='0'),供可选为空场景。 */
  allowEmpty?: boolean
  emptyLabel?: string
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [users, setUsers] = useState<UserSearchOption[]>([])
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const loadUsers = async (q: string) => {
    const current = ++seq.current
    setLoading(true)
    try {
      const params = new URLSearchParams({ page: '1', size: '200' })
      if (q !== '') params.set('q', q)
      const data = await request(`${ADMIN_API}/users?${params}`) as { users?: UserSearchOption[] }
      if (current !== seq.current) return
      setUsers(data.users ?? [])
    } catch {
      if (current === seq.current) setUsers([])
    } finally {
      if (current === seq.current) setLoading(false)
    }
  }

  useEffect(() => { void loadUsers('') }, [])
  useEffect(() => () => {
    if (debounce.current !== undefined) clearTimeout(debounce.current)
  }, [])

  const onQueryChange = (v: string) => {
    setQuery(v)
    if (debounce.current !== undefined) clearTimeout(debounce.current)
    debounce.current = setTimeout(() => { void loadUsers(v) }, 250)
  }

  const selected = users.find((u) => String(u.id) === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" role="combobox" aria-label={ariaLabel} className="w-full justify-between font-normal">
          <span className={selected || (allowEmpty && value === '0') ? '' : 'text-muted-foreground'}>
            {selected ? selected.username : allowEmpty && value === '0' ? (emptyLabel ?? '未设置') : (placeholder ?? '搜索并选择用户')}
          </span>
          <span className="opacity-50">▾</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="输入用户名或显示名搜索…"
            aria-label={ariaLabel ?? '搜索用户'}
            value={query}
            onValueChange={onQueryChange}
          />
          <CommandList>
            <CommandEmpty>{loading ? '搜索中…' : `未找到匹配「${query}」的用户`}</CommandEmpty>
            <CommandGroup>
              {allowEmpty && (
                <CommandItem
                  value="__empty__"
                  onSelect={() => {
                    onValueChange('0')
                    setOpen(false)
                    setQuery('')
                  }}
                >
                  <span className="text-muted-foreground">{emptyLabel ?? '未设置'}</span>
                </CommandItem>
              )}
              {users.map((u) => (
                <CommandItem
                  key={u.id}
                  value={`${u.username}${u.display_name ? ` ${u.display_name}` : ''}`}
                  onSelect={() => {
                    onValueChange(String(u.id))
                    setOpen(false)
                    setQuery('')
                  }}
                >
                  <span className="font-mono">{u.username}</span>
                  {u.display_name && u.display_name !== u.username && (
                    <span className="ml-2 text-muted-foreground">{u.display_name}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
