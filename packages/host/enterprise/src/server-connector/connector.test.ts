import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateBootstrap, EMPTY } from './bootstrap.ts'
import { sha256Fingerprint, checkFingerprint, saveFingerprint } from './tls.ts'

describe('validateBootstrap', () => {
  it('rejects null and empty models', () => {
    expect(validateBootstrap(null).fellBack).toBe(true)
    expect(validateBootstrap(EMPTY).fellBack).toBe(true)
  })

  it('falls back default_model to the first model', () => {
    const cfg = { ...EMPTY, models: [{ id: 'a', display_name: 'A' }, { id: 'b', display_name: 'B' }] }
    const r = validateBootstrap(cfg)
    expect(r.fellBack).toBe(true)
    expect(r.config.default_model).toBe('a')
  })

  it('accepts a valid config unchanged', () => {
    const cfg = { ...EMPTY, models: [{ id: 'a', display_name: 'A' }], default_model: 'a' }
    const r = validateBootstrap(cfg)
    expect(r.fellBack).toBe(false)
    expect(r.config.default_model).toBe('a')
  })
})

describe('tls fingerprint store', () => {
  it('pins and checks a host fingerprint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pico-tls-'))
    const store = join(dir, 'fingerprints.json')
    const fp = sha256Fingerprint(Buffer.from('hello'))
    expect(checkFingerprint(store, 'host:443', fp)).toBe('unknown')
    saveFingerprint(store, 'host:443', fp)
    expect(checkFingerprint(store, 'host:443', fp)).toBe('trusted')
    expect(checkFingerprint(store, 'host:443', 'other')).toBe('mismatch')
  })
})
