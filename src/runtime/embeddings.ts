import { createOpenAI } from '@ai-sdk/openai'
import { embed, embedMany } from 'ai'
import type { EmbeddingsService } from './types'

/**
 * OpenAI text-embedding-3-small (1536-dim). Architecture-locked choice;
 * matches the vector(1536) columns in the schema.
 */
export type EmbeddingsConfig = {
  openaiApiKey?: string
  openaiBaseUrl?: string
  model?: string
}

const DEFAULT_MODEL = 'text-embedding-3-small'

export function createOpenAIEmbeddings(config: EmbeddingsConfig = {}): EmbeddingsService {
  const openaiClient = createOpenAI({
    apiKey: config.openaiApiKey ?? process.env.OPENAI_API_KEY,
    baseURL: config.openaiBaseUrl ?? process.env.OPENAI_BASE_URL,
  })
  const model = openaiClient.embedding(config.model ?? DEFAULT_MODEL)

  return {
    embed: async (text) => (await embed({ model, value: text })).embedding,
    embedMany: async (texts) => (await embedMany({ model, values: texts })).embeddings,
  }
}
