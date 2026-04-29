import { describe, expect, it } from 'vitest'
import { shouldAudit } from '@/keeperhub/middleware'
import type { ToolAnnotations } from '@/mcp-host'
import { defaultMcpServers, namespaceToolName } from '@/mcp-host'

const evmmcp = () => {
  const server = defaultMcpServers().find((s) => s.name === 'evmmcp')
  if (!server) throw new Error('evmmcp server not found in defaults')
  return server
}

describe('defaultMcpServers — evm-mcp', () => {
  it('is wired as stdio via npx', () => {
    const s = evmmcp()
    expect(s.transport).toBe('stdio')
    expect(s.command).toBe('npx')
    expect(s.args).toEqual(expect.arrayContaining(['-y']))
    expect(s.args?.[1]).toMatch(/^@mcpdotdirect\/evm-mcp-server/)
  })

  it('declares staticAnnotations for tools missed by KNOWN_READONLY', () => {
    const s = evmmcp()
    const overrides = s.staticAnnotations ?? {}
    expect(overrides.resolve_ens_name).toEqual({ readOnly: true })
    expect(overrides.lookup_ens_address).toEqual({ readOnly: true })
    expect(overrides.wait_for_transaction).toEqual({ readOnly: true })
    expect(overrides.read_contract).toEqual({ readOnly: true })
    expect(overrides.multicall).toEqual({ readOnly: true })
  })
})

// ---------------------------------------------------------------------------
// Audit-routing table — every evm-mcp tool, namespaced as `evmmcp_${name}`,
// run through `shouldAudit` with the annotations the host *would* compute
// after merging staticAnnotations over parsed annotations.
//
// Intent:
//  - Every read tool should bypass audit (`shouldAudit === false`).
//  - Every write/signing tool should route through audit.
//  - The reason field documents *why* — KNOWN_READONLY regex match,
//    explicit annotation, or audit-by-default.
// ---------------------------------------------------------------------------

type Row = {
  /** Tool name as exposed by mcpdotdirect/evm-mcp-server (pre-namespace). */
  tool: string
  /** Whether this tool mutates chain state. Drives the `audit` expectation. */
  mutating: boolean
}

const EVM_MCP_TOOLS: Row[] = [
  // Wallet/network
  { tool: 'get_wallet_address', mutating: false },
  { tool: 'get_chain_info', mutating: false },
  { tool: 'get_supported_networks', mutating: false },
  { tool: 'get_gas_price', mutating: false },
  // ENS
  { tool: 'resolve_ens_name', mutating: false },
  { tool: 'lookup_ens_address', mutating: false },
  // Blocks/txs
  { tool: 'get_block', mutating: false },
  { tool: 'get_latest_block', mutating: false },
  { tool: 'get_transaction', mutating: false },
  { tool: 'get_transaction_receipt', mutating: false },
  { tool: 'wait_for_transaction', mutating: false },
  // Balances
  { tool: 'get_balance', mutating: false },
  { tool: 'get_token_balance', mutating: false },
  { tool: 'get_allowance', mutating: false },
  // Contracts
  { tool: 'get_contract_abi', mutating: false },
  { tool: 'read_contract', mutating: false },
  { tool: 'multicall', mutating: false },
  // Transfers / writes
  { tool: 'transfer_native', mutating: true },
  { tool: 'transfer_erc20', mutating: true },
  { tool: 'approve_token_spending', mutating: true },
  { tool: 'write_contract', mutating: true },
  // NFT reads
  { tool: 'get_nft_info', mutating: false },
  { tool: 'get_erc1155_balance', mutating: false },
  // Signing — off-chain but trust-sensitive; audit-by-default is the right call.
  { tool: 'sign_message', mutating: true },
  { tool: 'sign_typed_data', mutating: true },
]

describe('evm-mcp audit-routing table', () => {
  const overrides = evmmcp().staticAnnotations ?? {}

  it.each(EVM_MCP_TOOLS)('routes $tool correctly (mutating=$mutating)', ({ tool, mutating }) => {
    const namespaced = namespaceToolName('evmmcp', tool)
    // Simulate what the host computes: defaults from parseToolAnnotations
    // (all-false, since evm-mcp ships no MCP-level annotations) merged with
    // any static override.
    const baseAnnotations: ToolAnnotations = {
      mutates: false,
      readOnly: false,
      destructive: false,
    }
    const annotations: ToolAnnotations = {
      ...baseAnnotations,
      ...(overrides[tool] ?? {}),
    }

    const decision = shouldAudit(namespaced, annotations)

    if (mutating) {
      expect(decision.shouldAudit).toBe(true)
    } else {
      expect(decision.shouldAudit).toBe(false)
    }
  })

  it('covers every tool the upstream README documents', () => {
    // Tracks v2.0.4 surface. Adjust if upstream adds/removes tools.
    expect(EVM_MCP_TOOLS).toHaveLength(25)
  })
})
