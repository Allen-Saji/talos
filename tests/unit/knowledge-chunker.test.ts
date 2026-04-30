import { describe, expect, it } from 'vitest'
import { chunk, estimateTokens } from '@/knowledge/chunker'

describe('knowledge chunker', () => {
  it('returns no chunks for empty / whitespace-only input', () => {
    expect(chunk('')).toEqual([])
    expect(chunk('   \n\n   ')).toEqual([])
  })

  it('returns a single chunk when text fits the budget', () => {
    const text = 'short paragraph one.\n\nshort paragraph two.'
    const out = chunk(text, { targetTokens: 512 })
    expect(out.length).toBe(1)
    expect(out[0]).toContain('short paragraph one')
    expect(out[0]).toContain('short paragraph two')
  })

  it('splits when the budget is exceeded and stays under target per chunk', () => {
    const para = 'word '.repeat(200).trim() // ~1000 chars ≈ 250 tok
    const text = `${para}\n\n${para}\n\n${para}\n\n${para}`
    const out = chunk(text, { targetTokens: 300, overlapTokens: 0 })
    expect(out.length).toBeGreaterThanOrEqual(2)
    for (const c of out) expect(estimateTokens(c)).toBeLessThanOrEqual(300)
  })

  it('overlap repeats trailing characters of the prior chunk into the next', () => {
    const tail = 'TAIL_MARKER_XYZ'
    const para1 = `${'a '.repeat(200)}${tail}`
    const para2 = 'b '.repeat(200)
    const text = `${para1}\n\n${para2}`
    const out = chunk(text, { targetTokens: 120, overlapTokens: 16 })
    expect(out.length).toBeGreaterThan(1)
    expect(out[1]).toContain(tail)
  })

  it('keeps a code fence atomic across chunk boundaries', () => {
    const fence = ['```ts', 'function f() {', '  return 42', '}', '```'].join('\n')
    const filler = 'x'.repeat(2000)
    const text = `${filler}\n\n${fence}\n\n${filler}`
    const out = chunk(text, { targetTokens: 200 })
    const fenceChunk = out.find((c) => c.includes('```'))
    expect(fenceChunk).toBeDefined()
    expect(fenceChunk).toContain('```ts')
    expect(fenceChunk).toContain('return 42')
    expect(fenceChunk).toContain('```')
  })

  it('emits an oversized fence as its own chunk rather than splitting', () => {
    const huge = `\`\`\`\n${'line\n'.repeat(500)}\`\`\``
    const out = chunk(huge, { targetTokens: 128 })
    expect(out.length).toBe(1)
    expect(out[0]).toContain('```')
  })

  it('handles unterminated fences without losing content', () => {
    const text = '```ts\nfunction f() {\nreturn 1\n'
    const out = chunk(text, { targetTokens: 128 })
    expect(out.length).toBe(1)
    expect(out[0]).toContain('return 1')
  })

  it('rejects bad option ranges', () => {
    expect(() => chunk('x', { targetTokens: 0 })).toThrow()
    expect(() => chunk('x', { targetTokens: 100, overlapTokens: 100 })).toThrow()
    expect(() => chunk('x', { targetTokens: 100, overlapTokens: -1 })).toThrow()
  })
})
