import { ScheduleService } from '@deepseek-ai/dsh-schedule'
import { describe, expect, it } from 'vitest'

type Session = { serverURL: string, username: string } | null

function serviceWith(rows: Map<string, any>, getSession: () => Session): any {
  const service = Object.create(ScheduleService.prototype) as any
  service.ctx = { get: (name: string) => (name === 'picoSession' ? { getSession } : undefined) }
  service.serialize = (work: () => Promise<unknown>) => work()
  service.getDomain = async () => ({
    table: () => ({
      entries: () => [...rows.entries()],
      get: (id: string) => rows.get(id),
      put: async (id: string, value: unknown) => { rows.set(id, value) },
      delete: async (id: string) => { rows.delete(id) },
    }),
  })
  service.reminderTargetRefusal = () => undefined
  service.emitChanged = () => {}
  service.runtime = { requestDrive: () => {} }
  return service
}

const owner = (username: string): string => JSON.stringify(['https://a.example', username])
const record = (id: string): Record<string, unknown> => ({
  id,
  title: id,
  prompt: `${id} prompt`,
  scheduledAt: new Date(Date.now() + 60_000).toISOString(),
  kind: 'at',
})

function rowsFor(): Map<string, any> {
  return new Map([
    ['a', { sessionId: 's1', owner: owner('alice'), record: record('a'), status: 'active' }],
    ['b', { sessionId: 's1', owner: owner('bob'), record: record('b'), status: 'active' }],
    ['u', { sessionId: 's1', record: record('u'), status: 'active' }],
  ])
}

describe('ScheduleService account isolation', () => {
  it('lists and catalogs only the current account rows', async () => {
    const service = serviceWith(rowsFor(), () => ({ serverURL: 'https://a.example', username: 'alice' }))
    expect((await service.list({ sessionId: 's1' })).map((row: { id: string }) => row.id)).toEqual(['a'])
    expect((await service.catalog()).map((row: { id: string }) => row.id)).toEqual(['a'])
  })

  it('treats other-account and unowned rows as not found for history/delete/update', async () => {
    const rows = rowsFor()
    const service = serviceWith(rows, () => ({ serverURL: 'https://a.example', username: 'alice' }))
    expect(await service.history({ id: 'b', sessionId: 's1', limit: 10 })).toMatchObject({ code: 'schedule_not_found' })
    expect(await service.delete({ id: 'b', sessionId: 's1' })).toMatchObject({ deleted: false, code: 'schedule_not_found' })
    expect(await service.update({ id: 'b', sessionId: 's1' })).toMatchObject({ updated: false, code: 'schedule_not_found' })
    expect(rows.has('b')).toBe(true)
    expect(await service.delete({ id: 'a', sessionId: 's1' })).toMatchObject({ deleted: true })
  })

  it('shows nothing while signed out', async () => {
    const service = serviceWith(rowsFor(), () => null)
    expect(await service.list({ sessionId: 's1' })).toEqual([])
    expect(await service.catalog()).toEqual([])
    expect(await service.history({ id: 'a', sessionId: 's1', limit: 10 })).toMatchObject({ code: 'schedule_not_found' })
  })
})
