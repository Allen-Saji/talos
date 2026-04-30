import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import type { ProviderRouter } from '@/runtime/types'

/**
 * Mock LLM that replays the demo conversation deterministically. AI SDK v6
 * calls `doStream` once per agent step (between tool-call resolutions); each
 * call here returns the chunk set the agent should emit at that step.
 *
 * The recorded conversation matches the demo prompt:
 *   "what's my eth balance, then quote me 0.01 ETH -> USDC on Sepolia, then execute"
 *
 * Step 1: tool-call `agentkit_wallet_get_balance`
 * Step 2: tool-call `uniswap_get_quote`
 * Step 3: tool-call `uniswap_swap_exact_in`
 * Step 4: final text containing balance + quoted USDC + tx hash
 *
 * The shape of `StreamChunk` mirrors `LanguageModelV3StreamPart` but is kept
 * structural so we don't take a transitive `@ai-sdk/provider` dependency in
 * this test directory.
 */

type StreamChunk =
  | { type: 'stream-start'; warnings: unknown[] }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | {
      type: 'tool-call'
      toolCallId: string
      toolName: string
      input: string
    }
  | {
      type: 'finish'
      usage: { inputTokens: number; outputTokens: number; totalTokens: number }
      finishReason: 'tool-calls' | 'stop'
    }

const USAGE = { inputTokens: 12, outputTokens: 6, totalTokens: 18 }

function toolCallStep(toolName: string, toolCallId: string, args: unknown): StreamChunk[] {
  return [
    { type: 'stream-start', warnings: [] },
    {
      type: 'tool-call',
      toolCallId,
      toolName,
      input: JSON.stringify(args),
    },
    { type: 'finish', usage: USAGE, finishReason: 'tool-calls' },
  ]
}

function textStep(text: string): StreamChunk[] {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 't-final' },
    { type: 'text-delta', id: 't-final', delta: text },
    { type: 'text-end', id: 't-final' },
    { type: 'finish', usage: USAGE, finishReason: 'stop' },
  ]
}

export const DEMO_FINAL_TEXT =
  'Your wallet holds 1.0 ETH on Sepolia. ' +
  '0.01 ETH quotes for 25.00 USDC at the 3000 bps fee tier. ' +
  'Swap submitted: 0xabc123def456abc123def456abc123def456abc123def456abc123def456abc1.'

export const DEMO_TOOL_ARGS = {
  quote: {
    tokenIn: 'ETH',
    tokenOut: 'USDC',
    amountIn: '0.01',
    fee: 3000,
  },
  swap: {
    tokenIn: 'ETH',
    tokenOut: 'USDC',
    amountIn: '0.01',
    amountOutMinimum: '24750000', // 25.0 USDC * (1 - 1% slippage), 6 decimals
    fee: 3000,
  },
} as const

/**
 * Build a `ProviderRouter` whose only model is the recorded demo conversation.
 * Every call to `provider.resolve(...)` returns the same model so an agent
 * configured with any `modelId` ends up here.
 */
export function createDemoMockProvider(): ProviderRouter {
  const chunkSets: StreamChunk[][] = [
    toolCallStep('agentkit_wallet_get_balance', 'tc-balance-1', {}),
    toolCallStep('uniswap_get_quote', 'tc-quote-2', DEMO_TOOL_ARGS.quote),
    toolCallStep('uniswap_swap_exact_in', 'tc-swap-3', DEMO_TOOL_ARGS.swap),
    textStep(DEMO_FINAL_TEXT),
  ]
  let call = 0
  const model = new MockLanguageModelV3({
    doStream: async () => {
      const chunks = chunkSets[call] ?? chunkSets[chunkSets.length - 1] ?? []
      call++
      return { stream: simulateReadableStream({ chunks }) } as never
    },
  })
  return { resolve: () => model }
}
