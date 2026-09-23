/**
 * R4-D-1（2026-09-23 第四轮审计，P1）的**用户可见后果**判据（能力中心面板侧）。
 *
 * 现场：批准集为 `{1.0.0-rc10, 1.0.0-rc2}` 时服务端允许先发 rc10 再发 rc2（Go 判 rc2 更大），
 * 而客户端旧 tokenizer 把 rc10 当更大 ⇒ 卡片选出 rc10 当"最新"、`hasUpdateFor` 对已装 rc2
 * 的用户返回 true ⇒ **把降级当升级**（并把他引向更旧的版本）。反向的漏更新：`1.0.0-rc1` 与
 * `1.0.0-rc.1` 被判相等 ⇒ 界面显示"已是最新"，用户永远拿不到那一版。
 *
 * 本文件驱动的是**归约链**（`mergeItems` → `hasUpdateFor` → `planCardAction`），断言"卡片上会
 * 显示什么"；比较器本身由 `version-compare-corpus.spec.ts` 的共享语料逐条钉住。两层都要有：
 * 只钉比较器不钉归约链，出现"选了数组最后一个元素"这类调用点错误时仍然全绿。
 *
 * 变异验证：把 `src/client/version-compare.ts` 换回旧 tokenizer ⇒ 第 2 条（降级当升级）
 * 与第 4 条（rc1 vs rc.1 漏更新）红。
 */
import { describe, expect, it } from 'vitest'
import {
  hasUpdateFor,
  latestApprovedVersionByName,
  mergeItems,
  planCardAction,
  type CapabilityItem,
} from '../src/client/CapabilityCenterPanel.tsx'

describe('R4-D-1 的用户可见后果：不得把降级当升级、不得漏更新', () => {
  const approved = (version: string, versions: string[]): CapabilityItem => ({
    kind: 'skill', source: 'org', name: 'demo', displayName: '', version,
    description: '', author: 'a', status: 'approved', versions,
  })

  it('批准集 {rc10, rc2}：卡片的最新版本是 rc2（不是 rc10）', () => {
    const rows = [
      approved('1.0.0-rc10', ['1.0.0-rc10']),
      approved('1.0.0-rc2', ['1.0.0-rc2']),
    ]
    const merged = mergeItems(rows)
    expect(merged).toHaveLength(1)
    expect(merged[0]!.versions).toEqual(['1.0.0-rc10', '1.0.0-rc2'])
    expect(merged[0]!.version).toBe('1.0.0-rc2')
    // 另有 reduce 选版的入口（服务端目录投影），口径必须一致。
    expect(latestApprovedVersionByName(rows, 'skill', 'demo')).toBe('1.0.0-rc2')
  })

  it('已装 rc2 ⇒ 不再提示「更新」（旧实现在这里把降级当升级）', () => {
    const merged = mergeItems([
      { ...approved('1.0.0-rc2', ['1.0.0-rc10', '1.0.0-rc2']), installed: true, installedVersion: '1.0.0-rc2' },
    ])
    expect(hasUpdateFor(merged[0]!)).toBe(false)
    // 卡片动作不是「更新」（有更新时会给 {kind:'update'}）。
    expect(planCardAction(merged[0]!).kind).not.toBe('update')
  })

  it('已装 rc10 ⇒ 仍提示「更新到 rc2」（真升级不许漏）', () => {
    const merged = mergeItems([
      { ...approved('1.0.0-rc2', ['1.0.0-rc10', '1.0.0-rc2']), installed: true, installedVersion: '1.0.0-rc10' },
    ])
    expect(hasUpdateFor(merged[0]!)).toBe(true)
    expect(planCardAction(merged[0]!)).toEqual({ kind: 'update', version: '1.0.0-rc2' })
  })

  it('rc1 与 rc.1 不是同一个版本 ⇒ 已装 rc.1 的用户能拿到 rc1（旧实现判相等 ⇒ 漏更新）', () => {
    const merged = mergeItems([
      { ...approved('1.0.0-rc1', ['1.0.0-rc.1', '1.0.0-rc1']), installed: true, installedVersion: '1.0.0-rc.1' },
    ])
    expect(merged[0]!.versions).toEqual(['1.0.0-rc.1', '1.0.0-rc1'])
    expect(merged[0]!.version).toBe('1.0.0-rc1')
    expect(hasUpdateFor(merged[0]!)).toBe(true)
  })
})
