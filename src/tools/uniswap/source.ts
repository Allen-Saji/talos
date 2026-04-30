import type { Address, PublicClient, WalletClient } from 'viem'
import type { MutateRoute } from '@/keeperhub'
import { NativeToolSource } from '@/tools/native'
import { buildApproveRoute, buildApproveTool } from './approve'
import { buildQuoteTool } from './quote'
import { buildSwapRoute, buildSwapTool } from './swap'

/**
 * Build the Uniswap V3 NativeToolSource. Three tools:
 *
 * - `uniswap_get_quote` (read; KNOWN_READONLY via `_get_`) — QuoterV2 simulation
 *   plus pool address + liquidity from the Factory.
 * - `uniswap_approve_router` (mutate, routed) — `ERC20.approve(SwapRouter02, amount)`.
 * - `uniswap_swap_exact_in` (mutate, routed) — `SwapRouter02.exactInputSingle(...)`,
 *   slippage applied from a fresh quote.
 *
 * Demo flow is two mutate calls (approve then swap); both are KeeperHub-routed
 * when KH is configured. Without KH, both fall back to direct viem sends.
 */
export function createUniswapToolSource(opts: {
  walletClient: WalletClient
  publicClient: PublicClient
  walletAddress: Address
}): NativeToolSource {
  const quote = buildQuoteTool(opts.publicClient)
  const approve = buildApproveTool({
    walletClient: opts.walletClient,
    publicClient: opts.publicClient,
    walletAddress: opts.walletAddress,
  })
  const swap = buildSwapTool({
    walletClient: opts.walletClient,
    publicClient: opts.publicClient,
    walletAddress: opts.walletAddress,
  })

  const tools = {
    uniswap_get_quote: quote,
    uniswap_approve_router: approve,
    uniswap_swap_exact_in: swap,
  }

  // Annotations: get_quote is read-only (also caught by KNOWN_READONLY regex —
  // belt-and-braces), approve + swap mutate.
  const annotations = {
    uniswap_get_quote: { readOnly: true, mutates: false },
    uniswap_approve_router: { mutates: true, readOnly: false },
    uniswap_swap_exact_in: { mutates: true, readOnly: false },
  }

  const routes: Record<string, MutateRoute> = {
    uniswap_approve_router: buildApproveRoute(),
    uniswap_swap_exact_in: buildSwapRoute({
      walletAddress: opts.walletAddress,
      publicClient: opts.publicClient,
    }),
  }

  return new NativeToolSource({
    name: 'uniswap',
    tools,
    annotations,
    routes,
  })
}
