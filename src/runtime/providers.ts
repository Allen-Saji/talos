import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import { TalosConfigError } from '@/shared/errors'
import type { ProviderRouter } from './types'

/**
 * Provider router. v1 supports OpenAI (default) and Anthropic.
 *
 * Model id format: `<provider>/<model>` e.g. `openai/gpt-4o-mini`, `anthropic/claude-sonnet-4-20250514`.
 * Bare ids without a slash default to the OpenAI provider.
 */
export type ProviderConfig = {
  openaiApiKey?: string
  openaiBaseUrl?: string
  anthropicApiKey?: string
  anthropicBaseUrl?: string
}

export function createProviderRouter(config: ProviderConfig = {}): ProviderRouter {
  const openaiClient = createOpenAI({
    apiKey: config.openaiApiKey ?? process.env.OPENAI_API_KEY,
    baseURL: config.openaiBaseUrl ?? process.env.OPENAI_BASE_URL,
  })

  const anthropicClient = createAnthropic({
    apiKey: config.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY,
    baseURL: config.anthropicBaseUrl ?? process.env.ANTHROPIC_BASE_URL,
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
      if (providerName === 'anthropic') {
        return anthropicClient(model as Parameters<typeof anthropicClient>[0])
      }
      throw new TalosConfigError(
        `unknown provider "${providerName}" in modelId "${modelId}" (supported: openai, anthropic)`,
      )
    },
  }
}
