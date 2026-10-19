import * as schedule from '@deepseek-ai/dsh-schedule'
import { describe, expect, it } from 'vitest'

interface OwnerHelpers {
  ownerMatches: (ctx: { get: (name: string) => unknown }, owner: string | undefined) => boolean
  picoOwner: (ctx: { get: (name: string) => unknown }) => string | undefined
}

const helpers = schedule as unknown as OwnerHelpers
const ctxWithSession = (session: { serverURL: string, username: string } | null): { get: (name: string) => unknown } => ({
  get: (name: string) => (name === 'picoSession' ? { getSession: () => session } : undefined),
})
const ctxWithoutSession = { get: () => undefined }

describe('schedule owner scoping', () => {
  it('fails closed when the account-aware host is signed out', () => {
    expect(helpers.ownerMatches(ctxWithSession(null), undefined)).toBe(false)
    expect(helpers.ownerMatches(ctxWithSession(null), '["https://a.example","alice"]')).toBe(false)
  })

  it('hides unowned and other-account tasks when signed in', () => {
    const alice = ctxWithSession({ serverURL: 'https://a.example', username: 'alice' })
    const bob = helpers.picoOwner(ctxWithSession({ serverURL: 'https://a.example', username: 'bob' }))
    expect(helpers.ownerMatches(alice, helpers.picoOwner(alice))).toBe(true)
    expect(helpers.ownerMatches(alice, bob)).toBe(false)
    expect(helpers.ownerMatches(alice, undefined)).toBe(false)
  })

  it('normalizes trailing slashes and surrounding whitespace in the owner key', () => {
    const ctx = ctxWithSession({ serverURL: 'https://a.example/', username: ' alice ' })
    expect(helpers.picoOwner(ctx)).toBe('["https://a.example","alice"]')
    expect(helpers.ownerMatches(ctx, '["https://a.example","alice"]')).toBe(true)
  })

  it('keeps non-enterprise hosts (no picoSession service) backward compatible', () => {
    expect(helpers.ownerMatches(ctxWithoutSession, undefined)).toBe(true)
    expect(helpers.ownerMatches(ctxWithoutSession, '["https://a.example","alice"]')).toBe(true)
  })
})
