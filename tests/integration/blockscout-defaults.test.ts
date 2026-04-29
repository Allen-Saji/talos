import { describe, expect, it } from 'vitest'
import { shouldAudit } from '@/keeperhub/middleware'
import type { ToolAnnotations } from '@/mcp-host'
import { defaultMcpServers, namespaceToolName } from '@/mcp-host'

const blockscout = () => {
  const server = defaultMcpServers().find((s) => s.name === 'blockscout')
  if (!server) throw new Error('blockscout server not found in defaults')
  return server
}

describe('defaultMcpServers — blockscout', () => {
  it('is wired as Streamable HTTP', () => {
    const s = blockscout()
    expect(s.transport).toBe('http')
    expect(s.url).toMatch(/^https?:\/\//)
  })

  it('defaults to the hosted endpoint when no env override is set', () => {
    const s = blockscout()
    // Allow either the public host (default) or a user-configured override.
    expect(s.url).toBeTruthy()
    if (!process.env.BLOCKSCOUT_MCP_URL) {
      expect(s.url).toBe('https://mcp.blockscout.com/mcp')
    }
  })

  it('declares no staticAnnotations (regex covers every tool)', () => {
    const s = blockscout()
    // Every tool starts with `blockscout_` after namespacing, so the
    // `^blockscout_` regex in KNOWN_READONLY catches all of them.
    expect(s.staticAnnotations).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Audit-routing table — every blockscout-mcp tool, namespaced as
// `blockscout_${name}`, run through `shouldAudit`. All 16 are read-only and
// must bypass audit via the `^blockscout_` regex (KNOWN_READONLY).
//
// Including the underscore-padded `__unlock_blockchain_analysis__` tool, which
// also starts with `blockscout_` after namespacing.
// ---------------------------------------------------------------------------

const BLOCKSCOUT_TOOLS: string[] = [
  '__unlock_blockchain_analysis__',
  'get_chains_list',
  'get_address_by_ens_name',
  'lookup_token_by_symbol',
  'get_contract_abi',
  'inspect_contract_code',
  'get_address_info',
  'get_tokens_by_address',
  'get_block_number',
  'get_transactions_by_address',
  'get_token_transfers_by_address',
  'nft_tokens_by_address',
  'get_block_info',
  'get_transaction_info',
  'read_contract',
  'direct_api_call',
]

describe('blockscout audit-routing table', () => {
  it.each(BLOCKSCOUT_TOOLS)('routes %s as a read-only bypass', (tool) => {
    const namespaced = namespaceToolName('blockscout', tool)
    // Blockscout ships no MCP-level annotations from the upstream; defaults
    // are all-false from parseToolAnnotations.
    const annotations: ToolAnnotations = {
      mutates: false,
      readOnly: false,
      destructive: false,
    }
    const decision = shouldAudit(namespaced, annotations)
    expect(decision.shouldAudit).toBe(false)
    expect(decision.reason).toBe('KNOWN_READONLY')
  })

  it('covers every tool the upstream documents', () => {
    // Tracks the upstream's current surface (16 tools at v0.x). Adjust if
    // the server adds new tools.
    expect(BLOCKSCOUT_TOOLS).toHaveLength(16)
  })
})
