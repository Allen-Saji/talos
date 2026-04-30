import { tool } from 'ai'
import { type Address, type Hex, type PublicClient, parseUnits, type WalletClient } from 'viem'
import { z } from 'zod'
import type { MutateRoute } from '@/keeperhub'
import { ERC20_ABI, INTEREST_RATE_MODE_VARIABLE, POOL_ABI, SEPOLIA_AAVE } from './contracts'
import { resolveAaveToken } from './tokens'

const MAX_UINT256 = (1n << 256n) - 1n

const RepaySchema = z.object({
  token: z
    .string()
    .describe('Token symbol (USDC, DAI, WETH, USDT, WBTC, AAVE, LINK, GHO) or 0x address'),
  amount: z
    .string()
    .describe(
      'Repay amount in token human units (e.g. "100" for 100 USDC), or "max" to clear the entire variable-rate debt.',
    ),
  onBehalfOf: z
    .string()
    .optional()
    .describe('Optional debt owner whose debt is reduced. Defaults to the connected wallet.'),
})

export type RepayResult = {
  token: { symbol: string; address: Address }
  amount: string
  amountRaw: string
  interestRateMode: 'variable'
  onBehalfOf: Address
  isMax: boolean
  txHash?: Hex
}

/**
 * Build the `aave_repay` tool. Calls `Pool.repay(asset, amount,
 * interestRateMode=2, onBehalfOf)`. Pool pulls the underlying via
 * `transferFrom`, so the wallet must have approved the Pool first
 * (`aave_approve_pool`).
 *
 * `amount: "max"` resolves to `type(uint256).max`, which Aave treats as
 * "repay the full outstanding debt" — the contract reads the actual debt
 * amount + interest accrued at execution time. The agent is told this in
 * the description.
 */
export function buildRepayTool(opts: {
  walletClient: WalletClient
  publicClient: PublicClient
  walletAddress: Address
}) {
  return tool({
    description:
      'Repay a variable-rate debt position on Aave V3 (Sepolia). Pool must be pre-approved (call aave_approve_pool first). Pass amount="max" to repay the entire outstanding debt at execution time. Mutates state; routed through KeeperHub when configured.',
    inputSchema: RepaySchema,
    execute: async (args): Promise<RepayResult> => {
      const token = resolveAaveToken(args.token)
      const isMax = args.amount.toLowerCase() === 'max'
      const amountRaw = isMax ? MAX_UINT256 : parseUnits(args.amount, token.decimals)
      const onBehalfOf = (args.onBehalfOf ?? opts.walletAddress) as Address

      // Allowance precondition. For "max" we can't know the exact debt without
      // an extra Pool read, so we just require *some* allowance and let the
      // Pool's transferFrom enforce the rest at execution time.
      const allowance = (await opts.publicClient.readContract({
        address: token.address,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [opts.walletAddress, SEPOLIA_AAVE.pool as Address],
      })) as bigint
      if (!isMax && allowance < amountRaw) {
        throw new Error(
          `insufficient allowance: Aave Pool has ${allowance.toString()} but needs ${amountRaw.toString()}; call aave_approve_pool first`,
        )
      }
      if (isMax && allowance === 0n) {
        throw new Error(
          'insufficient allowance: Aave Pool has 0 approval for "max" repay; call aave_approve_pool with at least the expected debt amount first',
        )
      }

      const txHash = await opts.walletClient.writeContract({
        account: opts.walletClient.account ?? opts.walletAddress,
        chain: opts.walletClient.chain ?? null,
        address: SEPOLIA_AAVE.pool as Address,
        abi: POOL_ABI,
        functionName: 'repay',
        args: [token.address, amountRaw, INTEREST_RATE_MODE_VARIABLE, onBehalfOf],
      })

      return {
        token: { symbol: token.symbol, address: token.address },
        amount: args.amount,
        amountRaw: amountRaw.toString(),
        interestRateMode: 'variable',
        onBehalfOf,
        isMax,
        txHash,
      }
    },
  })
}

/** KeeperHub mutate route for `aave_repay` — `Pool.repay(...)`. */
export const buildRepayRoute =
  (opts: { walletAddress: Address }): MutateRoute =>
  (args) => {
    const parsed = RepaySchema.parse(args)
    const token = resolveAaveToken(parsed.token)
    const isMax = parsed.amount.toLowerCase() === 'max'
    const amountRaw = isMax ? MAX_UINT256 : parseUnits(parsed.amount, token.decimals)
    const onBehalfOf = (parsed.onBehalfOf ?? opts.walletAddress) as Address
    return {
      network: 'sepolia',
      contract_address: SEPOLIA_AAVE.pool,
      function_name: 'repay',
      function_args: [
        token.address,
        amountRaw.toString(),
        INTEREST_RATE_MODE_VARIABLE.toString(),
        onBehalfOf,
      ],
      abi: POOL_ABI,
    }
  }
