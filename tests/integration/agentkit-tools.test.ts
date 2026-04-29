import { describe, expect, it } from 'vitest'
import { classifyAnnotations, READ_PATTERNS } from '@/tools/agentkit'

/**
 * AgentKit tool-name classifier table. The classifier doesn't see annotations
 * from the upstream SDK — we infer mutates/readOnly from the tool name. This
 * test pins down the contract for known tools across the 10 cherry-picked
 * action providers (Pyth, Zerion, Compound, Morpho, Sushi, 0x, Enso,
 * Basename, OpenSea, Zora).
 */

type Row = {
  tool: string
  mutating: boolean
  /** Optional note explaining the case. */
  why?: string
}

const TOOLS: Row[] = [
  // Pyth — entire surface is reads
  { tool: 'pyth_fetch_price', mutating: false },
  { tool: 'pyth_fetch_price_feed_id', mutating: false },

  // Zerion — wallet portfolio queries (reads, gated by API key)
  { tool: 'zerion_fetch_portfolio', mutating: false },
  { tool: 'zerion_fetch_chain_distribution', mutating: false },
  { tool: 'zerion_fetch_position_summary', mutating: false },

  // Compound — supply/borrow are writes; positions are reads
  { tool: 'compound_supply', mutating: true },
  { tool: 'compound_borrow', mutating: true },
  { tool: 'compound_repay', mutating: true },
  { tool: 'compound_withdraw', mutating: true },
  { tool: 'compound_get_portfolio', mutating: false, why: '_get_ pattern' },

  // Morpho
  { tool: 'morpho_deposit', mutating: true },
  { tool: 'morpho_withdraw', mutating: true },

  // Sushi router — swaps are writes
  { tool: 'sushi_router_swap', mutating: true },
  { tool: 'sushi_router_get_quote', mutating: false, why: '_get_ + _quote' },

  // 0x — quote is a read; execute is a write
  { tool: 'zero_x_get_swap_quote', mutating: false },
  { tool: 'zero_x_execute_swap', mutating: true },

  // Enso — route gathering (read) + execute (write)
  { tool: 'enso_route', mutating: true, why: 'no read pattern matches' },
  { tool: 'enso_get_route', mutating: false },

  // Basename — register vs resolve
  { tool: 'basename_register_basename', mutating: true },
  { tool: 'basename_resolve_basename', mutating: false, why: '_resolve pattern' },

  // OpenSea — listings/buys are writes
  { tool: 'opensea_list_nft', mutating: false, why: '_list pattern (read of listings)' },
  { tool: 'opensea_buy_nft', mutating: true },
  { tool: 'opensea_get_collection', mutating: false },

  // Zora — mints/buys are writes; reads less common in surface
  { tool: 'zora_mint_token', mutating: true },
  { tool: 'zora_get_token_info', mutating: false },
]

describe('classifyAnnotations', () => {
  it.each(TOOLS)('$tool → mutating=$mutating ($why)', ({ tool, mutating }) => {
    const annotations = classifyAnnotations(tool)
    expect(annotations.mutates).toBe(mutating)
    expect(annotations.readOnly).toBe(!mutating)
    expect(annotations.destructive).toBe(false)
  })

  it('exposes a non-empty list of read patterns', () => {
    expect(READ_PATTERNS.length).toBeGreaterThan(5)
  })

  it('defaults unknown tool names to mutates:true (audit-by-default posture)', () => {
    const a = classifyAnnotations('unfamiliar_tool_name')
    expect(a.mutates).toBe(true)
    expect(a.readOnly).toBe(false)
  })
})
