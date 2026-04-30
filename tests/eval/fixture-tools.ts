import { type Tool, tool } from 'ai'
import { z } from 'zod'
import type { ToolSource } from '@/runtime/types'

/**
 * Fixture tool source for the demo-flow eval. Exposes the three tools the
 * agent should call on the locked demo prompt — `agentkit_wallet_get_balance`,
 * `uniswap_get_quote`, `uniswap_swap_exact_in` — each with a canned
 * deterministic response so the eval is decoupled from real chain state,
 * AgentKit init, and Uniswap pool liquidity.
 *
 * Names are chosen to match what the production tool sources expose:
 *   - `uniswap_get_quote` and `uniswap_swap_exact_in` come from
 *     `src/tools/uniswap/source.ts` directly.
 *   - `agentkit_wallet_get_balance` follows AgentKit's
 *     `WalletActionProvider_get_balance` after Talos's normalization
 *     (`<Provider>ActionProvider_<rest>` -> `<provider>_<rest>`, then
 *     namespaced with `agentkit_`).
 *
 * If production tool names drift, this file is the canonical place to
 * realign — the eval asserts the names this source registers.
 */

export type FixtureCallLog = {
  name: string
  args: unknown
}

export const FIXTURE_TOOL_NAMES = {
  balance: 'agentkit_wallet_get_balance',
  quote: 'uniswap_get_quote',
  swap: 'uniswap_swap_exact_in',
} as const

export const FIXTURE_BALANCE = {
  ethBalance: '1.0',
  address: '0xE11A4f4F4f5d2d4b5C6f3D2E1f0A9B8C7D6E5F4a',
}

export const FIXTURE_QUOTE = {
  amountOut: '25000000', // 25 USDC (6 decimals)
  fee: 3000,
  poolAddress: '0xPoolDeadBeef',
  poolLiquidity: '987654321000',
}

export const FIXTURE_SWAP = {
  hash: '0xabc123def456abc123def456abc123def456abc123def456abc123def456abc1',
  status: 'success' as const,
}

/**
 * Tool source surfacing the three demo tools with canned responses. The
 * `calls` array on the returned source records every invocation in order so
 * the eval can assert the precise tool-call sequence — independent of how
 * the runtime emits stream events.
 */
export function createFixtureToolSource(): ToolSource & { calls: FixtureCallLog[] } {
  const calls: FixtureCallLog[] = []

  const tools: Record<string, Tool> = {
    [FIXTURE_TOOL_NAMES.balance]: tool({
      description: 'Read the wallet ETH balance on Sepolia (fixture).',
      inputSchema: z.object({}).passthrough(),
      execute: async (args) => {
        calls.push({ name: FIXTURE_TOOL_NAMES.balance, args })
        return FIXTURE_BALANCE
      },
    }),
    [FIXTURE_TOOL_NAMES.quote]: tool({
      description: 'Quote an exact-input swap on Uniswap V3 (fixture).',
      inputSchema: z.object({
        tokenIn: z.string(),
        tokenOut: z.string(),
        amountIn: z.string(),
        fee: z.number().optional(),
      }),
      execute: async (args) => {
        calls.push({ name: FIXTURE_TOOL_NAMES.quote, args })
        return FIXTURE_QUOTE
      },
    }),
    [FIXTURE_TOOL_NAMES.swap]: tool({
      description: 'Execute an exact-input swap on Uniswap V3 (fixture).',
      inputSchema: z.object({
        tokenIn: z.string(),
        tokenOut: z.string(),
        amountIn: z.string(),
        amountOutMinimum: z.string(),
        fee: z.number().optional(),
      }),
      execute: async (args) => {
        calls.push({ name: FIXTURE_TOOL_NAMES.swap, args })
        return FIXTURE_SWAP
      },
    }),
  }

  return {
    calls,
    async getTools(): Promise<Record<string, Tool>> {
      return tools
    },
  }
}
