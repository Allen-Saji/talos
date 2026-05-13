import type { Address, PublicClient, WalletClient } from 'viem'
import { NativeToolSource } from '@/tools/native'
import { buildApproveTool } from './approve'
import { buildQuoteTool } from './quote'
import { buildSwapTool } from './swap'

/**
 * Build the Uniswap V3 NativeToolSource. Three tools:
 *
 * - `uniswap_get_quote` (read) — QuoterV2 simulation plus pool address +
 *   liquidity from the Factory.
 * - `uniswap_approve_router` — `ERC20.approve(SwapRouter02, amount)`.
 * - `uniswap_swap_exact_in` — `SwapRouter02.exactInputSingle(...)`, slippage
 *   applied from a fresh quote.
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

  const annotations = {
    uniswap_get_quote: { readOnly: true, mutates: false },
    uniswap_approve_router: { mutates: true, readOnly: false },
    uniswap_swap_exact_in: { mutates: true, readOnly: false },
  }

  return new NativeToolSource({
    name: 'uniswap',
    tools,
    annotations,
  })
}
