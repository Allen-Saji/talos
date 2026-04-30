/**
 * Token-aware-ish chunker for ETH ecosystem text. We don't pull `tiktoken`
 * (~2MB binary) for v1 — the ~4 chars-per-token heuristic is good enough for
 * sizing chunks within OpenAI's 8192-token input cap and producing
 * deterministic outputs. Iterate if recall quality demands it.
 *
 * Strategy: split on paragraph boundaries (`\n\n`), greedily pack until the
 * target token budget is hit, then emit. Adjacent chunks share `overlapTokens`
 * worth of trailing text from the previous chunk so a fact spanning a
 * paragraph break still appears whole in at least one chunk.
 *
 * Markdown code fences (```...```) are kept atomic — the chunker never splits
 * a fenced block. If a fence on its own exceeds the budget, it ships solo and
 * we accept the over-budget chunk rather than emit broken markdown.
 */

const CHARS_PER_TOKEN = 4
const DEFAULT_TARGET_TOKENS = 512
const DEFAULT_OVERLAP_TOKENS = 64

export type ChunkOptions = {
  /** Target chunk size in tokens (estimated). Default 512. */
  targetTokens?: number
  /** Overlap between consecutive chunks in tokens. Default 64. */
  overlapTokens?: number
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Split markdown-ish text into atoms: paragraphs and code fences. Fences are
 * preserved as single atoms so the chunker can keep them whole; everything
 * else is split on blank lines.
 */
function splitAtoms(text: string): string[] {
  const atoms: string[] = []
  const lines = text.split('\n')
  let buf: string[] = []
  let inFence = false

  const flushBuf = () => {
    if (buf.length === 0) return
    const joined = buf.join('\n').trim()
    buf = []
    if (joined.length === 0) return
    for (const para of joined.split(/\n{2,}/)) {
      const trimmed = para.trim()
      if (trimmed.length > 0) atoms.push(trimmed)
    }
  }

  for (const line of lines) {
    const isFenceMarker = /^```/.test(line.trimStart())
    if (isFenceMarker && !inFence) {
      flushBuf()
      buf.push(line)
      inFence = true
      continue
    }
    if (isFenceMarker && inFence) {
      buf.push(line)
      atoms.push(buf.join('\n'))
      buf = []
      inFence = false
      continue
    }
    buf.push(line)
  }

  if (inFence) {
    // Unterminated fence — treat the rest as one atom so we don't lose content.
    atoms.push(buf.join('\n'))
  } else {
    flushBuf()
  }

  return atoms
}

/**
 * Trailing-character window of approximately `overlapTokens` tokens. Used to
 * seed the next chunk so paragraph-spanning context survives.
 */
function overlapTail(text: string, overlapTokens: number): string {
  if (overlapTokens <= 0) return ''
  const charBudget = overlapTokens * CHARS_PER_TOKEN
  if (text.length <= charBudget) return text
  return text.slice(text.length - charBudget)
}

export function chunk(text: string, opts: ChunkOptions = {}): string[] {
  const target = opts.targetTokens ?? DEFAULT_TARGET_TOKENS
  const overlap = opts.overlapTokens ?? DEFAULT_OVERLAP_TOKENS
  if (target <= 0) throw new Error('targetTokens must be > 0')
  if (overlap < 0 || overlap >= target) {
    throw new Error('overlapTokens must satisfy 0 <= overlap < target')
  }

  const trimmed = text.trim()
  if (trimmed.length === 0) return []

  const atoms = splitAtoms(trimmed)
  if (atoms.length === 0) return []

  const out: string[] = []
  let current: string[] = []
  let currentTokens = 0

  const emit = () => {
    if (current.length === 0) return
    const joined = current.join('\n\n').trim()
    if (joined.length === 0) {
      current = []
      currentTokens = 0
      return
    }
    out.push(joined)
    const tail = overlapTail(joined, overlap).trim()
    current = tail.length > 0 ? [tail] : []
    currentTokens = current.length > 0 ? estimateTokens(current[0] ?? '') : 0
  }

  for (const atom of atoms) {
    const atomTokens = estimateTokens(atom)

    // Single atom over budget: flush current, ship the atom solo (over-budget
    // is acceptable for code fences / very long paragraphs).
    if (atomTokens > target) {
      if (current.length > 0) emit()
      out.push(atom)
      current = []
      currentTokens = 0
      continue
    }

    // Adding this atom would exceed budget — flush, then start a new chunk
    // (which already contains the overlap tail from the previous emit).
    if (currentTokens + atomTokens > target && current.length > 0) {
      emit()
    }
    current.push(atom)
    currentTokens += atomTokens
  }

  if (current.length > 0) {
    const joined = current.join('\n\n').trim()
    if (joined.length > 0) out.push(joined)
  }

  return out
}
