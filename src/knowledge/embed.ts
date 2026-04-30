import type { EmbeddingsService } from '@/runtime/types'

const DEFAULT_BATCH_SIZE = 50

/**
 * Embed a list of texts in batches that fit OpenAI's input limit comfortably.
 * The cap is 100 inputs per request; we pick {DEFAULT_BATCH_SIZE} for token-
 * budget headroom (50 chunks × ~512 tok ≈ 25K tokens, well under 8K-per-input
 * × 100 cap, but safer for retries).
 */
export async function embedBatch(
  embeddings: EmbeddingsService,
  texts: readonly string[],
  opts: { batchSize?: number } = {},
): Promise<number[][]> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE
  if (batchSize <= 0) throw new Error('batchSize must be > 0')
  if (texts.length === 0) return []

  const out: number[][] = []
  for (let i = 0; i < texts.length; i += batchSize) {
    const slice = texts.slice(i, i + batchSize)
    const vectors = await embeddings.embedMany([...slice])
    if (vectors.length !== slice.length) {
      throw new Error(`embedMany returned ${vectors.length} vectors for ${slice.length} inputs`)
    }
    out.push(...vectors)
  }
  return out
}
