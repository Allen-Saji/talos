import { loadEnv } from '@/config/env'
import type { McpServerConfig } from './index'

/**
 * Default MCP servers Talos boots with.
 *
 * Each entry is connected at daemon startup by `lifecycle.ts`. Stdio servers
 * are spawned with the parent process's environment, so any keys the user has
 * set (`EVM_PRIVATE_KEY`, `EVM_MNEMONIC`, `ETHERSCAN_API_KEY`, ...) are
 * inherited by the npx-launched child without explicit wiring. HTTP servers
 * connect via the URL configured here (overridable via env).
 *
 * `staticAnnotations` provides per-tool metadata overrides for tools whose
 * upstream MCP server doesn't ship accurate readOnly/mutates hints.
 */
export function defaultMcpServers(): McpServerConfig[] {
  return [evmMcpServer(), blockscoutMcpServer()]
}

/**
 * mcpdotdirect/evm-mcp-server — generic EVM MCP wrapping `viem` with 24 tools
 * across 60+ networks. Read tools dominate; write tools require the user to
 * set `EVM_PRIVATE_KEY` or `EVM_MNEMONIC` in their environment.
 *
 * RPC URLs are hardcoded upstream (no env-var override). For the demo this is
 * acceptable since (a) defaults work for read paths, (b) custom Aave/Uniswap
 * MCPs (PR-5/6) own their viem client and read RPCs from env. If we ever need
 * Alchemy here we'd vendor a patched fork.
 *
 * Reference: https://github.com/mcpdotdirect/evm-mcp-server
 */
function evmMcpServer(): McpServerConfig {
  return {
    name: 'evmmcp',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@mcpdotdirect/evm-mcp-server@2.0.4'],
    staticAnnotations: {
      // Override annotations for tools whose names don't self-declare read-only
      // intent. Surfaces accurate metadata to downstream consumers.
      resolve_ens_name: { readOnly: true },
      lookup_ens_address: { readOnly: true },
      wait_for_transaction: { readOnly: true },
      read_contract: { readOnly: true },
      multicall: { readOnly: true },
    },
  }
}

/**
 * Blockscout MCP server — Python service exposing 16 read-only tools wrapping
 * Blockscout's indexed chain explorer APIs (Etherscan-shaped surface, but
 * multi-chain via Chainscout instance routing). Strict superset of evm-mcp's
 * read coverage for transaction history, token transfers, NFT holdings, ABIs.
 *
 * Hosted at `https://mcp.blockscout.com/mcp` by default; override with the
 * `BLOCKSCOUT_MCP_URL` env var to point at a self-hosted instance. No API key
 * required for the hosted endpoint.
 *
 * Reference: https://github.com/blockscout/mcp-server
 */
function blockscoutMcpServer(): McpServerConfig {
  const env = loadEnv()
  return {
    name: 'blockscout',
    transport: 'http',
    url: env.BLOCKSCOUT_MCP_URL,
  }
}
