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
import { ERC20_ABI, SEPOLIA_AAVE } from './contracts'
import { resolveAaveToken } from './tokens'

const ApproveSchema = z.object({
  token: z
    .string()
    .describe('Token symbol (USDC, DAI, WETH, USDT, WBTC, AAVE, LINK, GHO) or 0x address'),
  amount: z.string().describe('Approval amount in token human units (e.g. "100" for 100 USDC)'),
})

export type AaveApproveResult = {
  token: { symbol: string; address: Address }
  spender: Address
  amount: string
  amountRaw: string
  txHash?: Hex
}

/**
 * Build the `aave_approve_pool` tool. Approves the Aave V3 Pool to spend
 * `amount` of `token` from the wallet. Required before:
 * - `aave_supply` (Pool pulls the underlying)
 * - `aave_repay` (Pool pulls the underlying being repaid)
 *
 * Mirrors `uniswap_approve_router`: direct viem `sendTransaction` when
 * unrouted, KeeperHub-routed via the `MutateRoute` below otherwise. Account
 * is bound from the wallet client so viem signs locally.
 */
export function buildAaveApproveTool(opts: {
  walletClient: WalletClient
  publicClient: PublicClient
  walletAddress: Address
}) {
  return tool({
    description:
      'Approve the Aave V3 Pool (Sepolia) to spend a token from the wallet. Required before aave_supply (the Pool pulls the underlying) and aave_repay. Mutates state; routed through KeeperHub when configured.',
    inputSchema: ApproveSchema,
    execute: async (args): Promise<AaveApproveResult> => {
      const token = resolveAaveToken(args.token)
      const amountRaw = parseUnits(args.amount, token.decimals)

      const data = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [SEPOLIA_AAVE.pool as Address, amountRaw],
      })

      const txHash = await opts.walletClient.sendTransaction({
        account: opts.walletClient.account ?? opts.walletAddress,
        chain: opts.walletClient.chain ?? null,
        to: token.address,
        data,
      })

      return {
        token: { symbol: token.symbol, address: token.address },
        spender: SEPOLIA_AAVE.pool as Address,
        amount: args.amount,
        amountRaw: amountRaw.toString(),
        txHash,
      }
    },
  })
}

/**
 * KeeperHub mutate route for `aave_approve_pool`. Encodes a single
 * `ERC20.approve(Pool, amount)` call.
 */
export const buildAaveApproveRoute = (): MutateRoute => (args) => {
  const parsed = ApproveSchema.parse(args)
  const token = resolveAaveToken(parsed.token)
  const amountRaw = parseUnits(parsed.amount, token.decimals)
  return {
    network: 'sepolia',
    contract_address: token.address,
    function_name: 'approve',
    function_args: [SEPOLIA_AAVE.pool, amountRaw.toString()],
    abi: ERC20_ABI,
  }
}
