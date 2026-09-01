import { describe, expect, it, vi } from 'vitest'
import type { NativeWebContents } from '../src/electron-adapter.ts'
import { captureScreenshot } from '../src/shots.ts'

interface FakeImage {
  size: { width: number; height: number }
  getSize: () => { width: number; height: number }
  toJPEG: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
}

function image(width: number, height = 800): FakeImage {
  const img: FakeImage = {
    size: { width, height },
    getSize: () => img.size,
    toJPEG: vi.fn(() => Buffer.from('jpeg-bytes')),
    resize: vi.fn(() => img),
  }
  return img
}

function webContents(inner: FakeImage | null): NativeWebContents {
  return {
    isDestroyed: () => inner === null,
    capturePage: vi.fn(async () => inner),
  } as unknown as NativeWebContents
}

describe('captureScreenshot', () => {
  it('returns a JPEG data URL with default width and quality', async () => {
    const url = await captureScreenshot(webContents(image(1024)))
    expect(url).toBe(`data:image/jpeg;base64,${Buffer.from('jpeg-bytes').toString('base64')}`)
  })

  it('downscales when the page is wider than maxWidth', async () => {
    const img = image(4000)
    const url = await captureScreenshot(webContents(img), 1280, 70)
    expect(img.resize).toHaveBeenCalledWith({ width: 1280, quality: 'good' })
    expect(url).toMatch(/^data:image\/jpeg;base64,/)
  })

  it('passes through width at-or-below maxWidth unchanged', async () => {
    const img = image(1280)
    await captureScreenshot(webContents(img), 1280, 70)
    expect(img.resize).not.toHaveBeenCalled()
  })

  it('clamps quality into 1..100', async () => {
    const img = image(800)
    await captureScreenshot(webContents(img), 1280, 0)
    expect(img.toJPEG).toHaveBeenCalledWith(1)
    await captureScreenshot(webContents(img), 1280, 101)
    expect(img.toJPEG).toHaveBeenCalledWith(100)
    await captureScreenshot(webContents(img), 1280, -5)
    expect(img.toJPEG).toHaveBeenCalledWith(1)
  })

  it('throws when the tab was destroyed', async () => {
    await expect(captureScreenshot(webContents(null))).rejects.toThrow('browser: tab was destroyed')
  })

  it('clamps maxWidth to at least 1px', async () => {
    const img = image(2000)
    await captureScreenshot(webContents(img), 0, 70)
    expect(img.resize).toHaveBeenCalledWith({ width: 1, quality: 'good' })
  })
})
