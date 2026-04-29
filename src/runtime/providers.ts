import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import { TalosConfigError } from '@/shared/errors'
import type { ProviderRouter } from './types'

/**
 * Provider router. v1 supports OpenAI only; multi-provider lands in v1.1
 * by adding more `providerName === 'X'` branches.
 *
 * Model id format: `<provider>/<model>` e.g. `openai/gpt-4o-mini`.
 * Bare ids without a slash default to the OpenAI provider.
 */
export type ProviderConfig = {
  openaiApiKey?: string
}

export function createProviderRouter(config: ProviderConfig = {}): ProviderRouter {
  const openaiClient = createOpenAI({
    apiKey: config.openaiApiKey ?? process.env.OPENAI_API_KEY,
  })

  return {
    resolve(modelId: string): LanguageModel {
      const [providerName, ...rest] = modelId.includes('/')
        ? modelId.split('/')
        : ['openai', modelId]
      const model = rest.join('/') || providerName

      if (providerName === 'openai') {
        return openaiClient(model as Parameters<typeof openaiClient>[0])
      }
      throw new TalosConfigError(
        `unknown provider "${providerName}" in modelId "${modelId}" (only openai supported in v1)`,
      )
    },
  }
}
