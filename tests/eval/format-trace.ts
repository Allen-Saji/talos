import type { FixtureCallLog } from './fixture-tools'

/**
 * Pretty-prints a side-by-side diff of expected vs actual tool-call sequences.
 * Used in the demo-flow eval's failure message so a regression points
 * directly at the divergence (which call drifted, what args differed).
 */
export function formatTrace(
  expected: readonly string[],
  actual: readonly FixtureCallLog[],
): string {
  const lines: string[] = []
  lines.push('expected vs actual tool-call sequence:')
  const max = Math.max(expected.length, actual.length)
  const padCol = 36
  for (let i = 0; i < max; i++) {
    const exp = expected[i] ?? '<missing>'
    const got = actual[i]?.name ?? '<missing>'
    const marker = exp === got ? ' ' : '!'
    const entry = actual[i]
    const argsTail = entry !== undefined ? `  args=${safeStringify(entry.args)}` : ''
    lines.push(
      `  ${marker} ${pad(`${i + 1}.`, 4)}${pad(`expected: ${exp}`, padCol)}` +
        `actual: ${got}${argsTail}`,
    )
  }
  return lines.join('\n')
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s
  return s + ' '.repeat(n - s.length)
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
