import { tool } from 'ai'
import { type Address, type Hex, type PublicClient, parseUnits, type WalletClient } from 'viem'
import { z } from 'zod'
import type { MutateRoute } from '@/keeperhub'
import { ERC20_ABI, POOL_ABI, REFERRAL_CODE, SEPOLIA_AAVE } from './contracts'
import { resolveAaveToken } from './tokens'

const SupplySchema = z.object({
  token: z
    .string()
    .describe('Token symbol (USDC, DAI, WETH, USDT, WBTC, AAVE, LINK, GHO) or 0x address'),
  amount: z.string().describe('Supply amount in token human units (e.g. "100" for 100 USDC)'),
  onBehalfOf: z
    .string()
    .optional()
    .describe('Optional aToken recipient. Defaults to the connected wallet.'),
})

export type SupplyResult = {
  token: { symbol: string; address: Address }
  amount: string
  amountRaw: string
  onBehalfOf: Address
  txHash?: Hex
}

/**
 * Build the `aave_supply` tool. Calls `Pool.supply(asset, amount, onBehalfOf,
 * referralCode=0)`. The connected wallet must have already approved the Pool
 * to spend `amount` of `token` (call `aave_approve_pool` first). The Pool
 * mints aTokens to `onBehalfOf` (defaults to the wallet).
 */
export function buildSupplyTool(opts: {
  walletClient: WalletClient
  publicClient: PublicClient
  walletAddress: Address
}) {
  return tool({
    description:
      'Supply (deposit) an ERC-20 token to Aave V3 (Sepolia) and mint aTokens. Pool must be pre-approved (call aave_approve_pool first). Mutates state; routed through KeeperHub when configured. Native ETH is not supported here — use WETH.',
    inputSchema: SupplySchema,
    execute: async (args): Promise<SupplyResult> => {
      const token = resolveAaveToken(args.token)
      const amountRaw = parseUnits(args.amount, token.decimals)
      const onBehalfOf = (args.onBehalfOf ?? opts.walletAddress) as Address

      // Fail-loud allowance precondition: Pool pulls the underlying via
      // transferFrom, so a missing allowance reverts after gas is burned.
      const allowance = (await opts.publicClient.readContract({
        address: token.address,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [opts.walletAddress, SEPOLIA_AAVE.pool as Address],
      })) as bigint
      if (allowance < amountRaw) {
        throw new Error(
          `insufficient allowance: Aave Pool has ${allowance.toString()} but needs ${amountRaw.toString()}; call aave_approve_pool first`,
        )
      }

      const txHash = await opts.walletClient.writeContract({
        account: opts.walletClient.account ?? opts.walletAddress,
        chain: opts.walletClient.chain ?? null,
        address: SEPOLIA_AAVE.pool as Address,
        abi: POOL_ABI,
        functionName: 'supply',
        args: [token.address, amountRaw, onBehalfOf, REFERRAL_CODE],
      })

      return {
        token: { symbol: token.symbol, address: token.address },
        amount: args.amount,
        amountRaw: amountRaw.toString(),
        onBehalfOf,
        txHash,
      }
    },
  })
}

/** KeeperHub mutate route for `aave_supply` — `Pool.supply(...)`. */
export const buildSupplyRoute =
  (opts: { walletAddress: Address }): MutateRoute =>
  (args) => {
    const parsed = SupplySchema.parse(args)
    const token = resolveAaveToken(parsed.token)
    const amountRaw = parseUnits(parsed.amount, token.decimals)
    const onBehalfOf = (parsed.onBehalfOf ?? opts.walletAddress) as Address
    return {
      network: 'sepolia',
      contract_address: SEPOLIA_AAVE.pool,
      function_name: 'supply',
      function_args: [token.address, amountRaw.toString(), onBehalfOf, REFERRAL_CODE],
      abi: POOL_ABI,
    }
  }
