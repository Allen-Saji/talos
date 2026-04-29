import { getChains, getConnections, getQuote, getStatus, getTokens } from '@lifi/sdk'
import { type Tool, tool } from 'ai'
import { z } from 'zod'
import type { ToolAnnotations } from '@/mcp-host'
import { ensureLifiSdk } from './client'

/**
 * Read-only Li.Fi tools. All wrap `@lifi/sdk` calls and return the raw
 * response untouched — the LLM (or downstream summarizer) handles
 * formatting. We don't transform shapes here because the response payloads
 * carry meaningful nested data the model can quote (route steps, fees,
 * ETAs, bridge selection rationale).
 *
 * Write tools (executeQuote/approveToken/transferNative/transferToken) are
 * deferred until the wallet module lands — they need a viem signer that the
 * runtime doesn't yet manage. When wallet wiring lands, this file gains a
 * separate `writeTools()` factory that takes a `WalletClient` argument.
 */

/** Chain reference — accepts numeric chain id or short slug (e.g. 'eth'). */
const ChainRef = z.union([z.number().int().positive(), z.string().min(1)])

const lifi_get_chains = tool({
  description:
    'List EVM, Solana, and other chains supported by Li.Fi for cross-chain bridging and swaps. Returns chain id, name, native token, RPC URLs.',
  inputSchema: z.object({
    chainTypes: z
      .array(z.enum(['EVM', 'SVM', 'MVM', 'UTXO', 'TVM']))
      .optional()
      .describe('Filter by chain virtual machine. Omit to return all.'),
  }),
  execute: async ({ chainTypes }) => {
    ensureLifiSdk()
    const chains = await getChains(chainTypes ? ({ chainTypes } as never) : undefined)
    return chains
  },
})

const lifi_get_tokens = tool({
  description:
    'List tokens supported by Li.Fi on one or more chains. Used to discover token addresses + symbols + decimals before requesting a quote.',
  inputSchema: z.object({
    chains: z
      .array(ChainRef)
      .optional()
      .describe('Restrict to specific chain ids/slugs. Omit for all chains.'),
  }),
  execute: async ({ chains }) => {
    ensureLifiSdk()
    const tokens = await getTokens(chains ? { chains: chains as never } : undefined)
    return tokens
  },
})

const lifi_get_connections = tool({
  description:
    'List bridges, exchanges, and routes available between a (fromChain, fromToken) and (toChain, toToken) pair. Use this before getQuote to verify a route exists at all.',
  inputSchema: z.object({
    fromChain: ChainRef,
    toChain: ChainRef,
    fromToken: z.string().optional().describe('From token address or symbol. Omit for any.'),
    toToken: z.string().optional().describe('To token address or symbol. Omit for any.'),
  }),
  execute: async (params) => {
    ensureLifiSdk()
    const connections = await getConnections(params as never)
    return connections
  },
})

const lifi_get_quote = tool({
  description:
    'Get the best route to swap or bridge a token amount across chains. Returns selected bridge, expected output amount, fees, gas estimate, ETA, and step-by-step transactions. The single most useful Li.Fi tool — use this whenever the user asks "what is the rate / best route" for a cross-chain transfer.',
  inputSchema: z.object({
    fromChain: ChainRef,
    fromToken: z.string().describe('Token address (preferred) or symbol on the source chain'),
    toChain: ChainRef,
    toToken: z.string().describe('Token address (preferred) or symbol on the destination chain'),
    fromAmount: z
      .string()
      .describe(
        'Source amount in smallest unit (wei / atomic units). Use a string to avoid JS-number precision loss.',
      ),
    fromAddress: z
      .string()
      .describe(
        'Source wallet address. Quotes incorporate allowance checks; for inspection-only use any valid address.',
      ),
    toAddress: z.string().optional().describe('Destination address. Defaults to fromAddress.'),
    slippage: z
      .number()
      .min(0)
      .max(0.5)
      .optional()
      .describe('Max slippage tolerance, e.g. 0.005 for 0.5%.'),
  }),
  execute: async (params) => {
    ensureLifiSdk()
    const quote = await getQuote(params as never)
    return quote
  },
})

const lifi_get_status = tool({
  description:
    'Check the status of a cross-chain transfer by source tx hash. Returns DONE / FAILED / PENDING along with destination tx hash on success. Cross-chain transfers can take minutes to hours depending on the bridge.',
  inputSchema: z.object({
    txHash: z.string().describe('The source-chain transaction hash returned by execute_quote.'),
    bridge: z
      .string()
      .optional()
      .describe(
        'Bridge tool key from the quote response (e.g. "stargate", "across"). Required for cross-chain.',
      ),
    fromChain: ChainRef.optional(),
    toChain: ChainRef.optional(),
  }),
  execute: async (params) => {
    ensureLifiSdk()
    const status = await getStatus(params as never)
    return status
  },
})

/**
 * Annotations for every tool above. Pure reads — no chain mutation,
 * no off-chain trust impact. Routed to bypass KeeperHub workflow audit.
 */
const READ_ONLY: ToolAnnotations = {
  mutates: false,
  readOnly: true,
  destructive: false,
}

/** Pre-namespaced tool record — names match `lifi_${operation}`. */
export function lifiReadTools(): {
  tools: Record<string, Tool>
  annotations: Record<string, ToolAnnotations>
} {
  const tools: Record<string, Tool> = {
    lifi_get_chains,
    lifi_get_tokens,
    lifi_get_connections,
    lifi_get_quote,
    lifi_get_status,
  }
  const annotations: Record<string, ToolAnnotations> = Object.fromEntries(
    Object.keys(tools).map((name) => [name, READ_ONLY]),
  )
  return { tools, annotations }
}
