import { tool } from 'ai'
import {
  type Address,
  encodeFunctionData,
  type Hex,
  type PublicClient,
  parseUnits,
  type WalletClient,
} from 'viem'
import { z } from 'zod'
import type { MutateRoute } from '@/keeperhub'
import { ERC20_ABI, SEPOLIA_UNISWAP } from './contracts'
import { resolveToken } from './tokens'

const ApproveSchema = z.object({
  token: z.string().describe('Token symbol (USDC, WETH, DAI) or 0x address'),
  amount: z.string().describe('Approval amount in token human units (e.g. "100" for 100 USDC)'),
})

export type ApproveResult = {
  token: { symbol: string; address: Address }
  spender: Address
  amount: string
  amountRaw: string
  txHash?: Hex
}

/**
 * Build the `uniswap_approve_router` tool. Approves SwapRouter02 to spend
 * `amount` of `token` from the wallet. Two roles:
 *
 * 1. **Direct execute** (no KH route configured) — sends an `approve` tx
 *    via the wallet client and returns the tx hash.
 * 2. **KeeperHub-routed** (production) — middleware swaps in the
 *    `MutateRoute` below and KH executes the approve, returning workflow
 *    metadata. Audit row records the route.
 */
export function buildApproveTool(opts: {
  walletClient: WalletClient
  publicClient: PublicClient
  walletAddress: Address
}) {
  return tool({
    description:
      'Approve the Uniswap V3 SwapRouter02 to spend a token from the wallet. Required before swap_exact_in. Mutates state; routed through KeeperHub workflow when configured.',
    inputSchema: ApproveSchema,
    execute: async (args): Promise<ApproveResult> => {
      const token = resolveToken(args.token)
      const amountRaw = parseUnits(args.amount, token.decimals)

      const data = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [SEPOLIA_UNISWAP.swapRouter02 as Address, amountRaw],
      })

      // viem's WalletClient.sendTransaction is the lowest-friction send for an
      // arbitrary calldata; writeContract would re-encode args we already have.
      // Pass the bound Account so viem signs locally (eth_sendRawTransaction)
      // instead of falling back to wallet_sendTransaction (browser-wallet RPC,
      // unsupported by public node providers).
      const txHash = await opts.walletClient.sendTransaction({
        account: opts.walletClient.account ?? opts.walletAddress,
        chain: opts.walletClient.chain ?? null,
        to: token.address,
        data,
      })

      return {
        token: { symbol: token.symbol, address: token.address },
        spender: SEPOLIA_UNISWAP.swapRouter02 as Address,
        amount: args.amount,
        amountRaw: amountRaw.toString(),
        txHash,
      }
    },
  })
}

/**
 * KeeperHub mutate route for `uniswap_approve_router`. Maps tool args to a
 * single `ERC20.approve(spender, amount)` contract call.
 */
export const buildApproveRoute = (): MutateRoute => (args) => {
  const parsed = ApproveSchema.parse(args)
  const token = resolveToken(parsed.token)
  const amountRaw = parseUnits(parsed.amount, token.decimals)
  return {
    network: 'sepolia',
    contract_address: token.address,
    function_name: 'approve',
    function_args: [SEPOLIA_UNISWAP.swapRouter02, amountRaw.toString()],
    abi: ERC20_ABI,
  }
}
