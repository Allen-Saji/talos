import type { McpServerConfig } from './index'

/**
 * Default MCP servers Talos boots with.
 *
 * Each entry is connected at daemon startup by `lifecycle.ts`. Servers are
 * spawned with the parent process's environment, so any keys the user has set
 * (`EVM_PRIVATE_KEY`, `EVM_MNEMONIC`, `ETHERSCAN_API_KEY`, ...) are inherited
 * by the npx-launched child without explicit wiring.
 *
 * `staticAnnotations` corrects audit-routing for tools that the KeeperHub
 * middleware would otherwise route through workflow audit by default. The
 * middleware's `KNOWN_READONLY` regex covers most read patterns
 * (`_get_/`, `_balance$`, `_quote$`, ...) but a few read-only tools fall
 * outside the regex set and need an explicit `readOnly: true`.
 */
export function defaultMcpServers(): McpServerConfig[] {
  return [evmMcpServer()]
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
      // Read tools whose names don't match the `KNOWN_READONLY` regex set in
      // the KeeperHub middleware. Without these overrides the middleware
      // would conservatively route them through workflow audit, paying a
      // ~200ms round-trip on pure reads. See `src/keeperhub/middleware.ts`.
      resolve_ens_name: { readOnly: true },
      lookup_ens_address: { readOnly: true },
      wait_for_transaction: { readOnly: true },
      read_contract: { readOnly: true },
      multicall: { readOnly: true },
    },
  }
}
