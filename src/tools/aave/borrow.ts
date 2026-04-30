import { tool } from 'ai'
import { type Address, type Hex, type PublicClient, parseUnits, type WalletClient } from 'viem'
import { z } from 'zod'
import type { MutateRoute } from '@/keeperhub'
import { INTEREST_RATE_MODE_VARIABLE, POOL_ABI, REFERRAL_CODE, SEPOLIA_AAVE } from './contracts'
import { resolveAaveToken } from './tokens'

const BorrowSchema = z.object({
  token: z
    .string()
    .describe('Token symbol (USDC, DAI, WETH, USDT, WBTC, AAVE, LINK, GHO) or 0x address'),
  amount: z.string().describe('Borrow amount in token human units (e.g. "100" for 100 USDC)'),
  onBehalfOf: z
    .string()
    .optional()
    .describe('Optional debt owner. Defaults to the connected wallet.'),
})

export type BorrowResult = {
  token: { symbol: string; address: Address }
  amount: string
  amountRaw: string
  interestRateMode: 'variable'
  onBehalfOf: Address
  txHash?: Hex
}

/**
 * Build the `aave_borrow` tool. Calls `Pool.borrow(asset, amount,
 * interestRateMode=2 [variable], referralCode=0, onBehalfOf)`. The user must
 * have collateral supplied + sufficient health factor — Aave reverts on
 * `availableBorrowsBase` underflow.
 *
 * Stable rate is hard-coded out: Aave V3 deprecated it, contracts revert.
 */
export function buildBorrowTool(opts: {
  walletClient: WalletClient
  publicClient: PublicClient
  walletAddress: Address
}) {
  return tool({
    description:
      'Borrow an ERC-20 token from Aave V3 (Sepolia) at the variable interest rate. Requires existing collateral + sufficient health factor; check aave_get_user_account_data first. Mutates state; routed through KeeperHub when configured.',
    inputSchema: BorrowSchema,
    execute: async (args): Promise<BorrowResult> => {
      const token = resolveAaveToken(args.token)
      const amountRaw = parseUnits(args.amount, token.decimals)
      const onBehalfOf = (args.onBehalfOf ?? opts.walletAddress) as Address

      const txHash = await opts.walletClient.writeContract({
        account: opts.walletClient.account ?? opts.walletAddress,
        chain: opts.walletClient.chain ?? null,
        address: SEPOLIA_AAVE.pool as Address,
        abi: POOL_ABI,
        functionName: 'borrow',
        args: [token.address, amountRaw, INTEREST_RATE_MODE_VARIABLE, REFERRAL_CODE, onBehalfOf],
      })

      return {
        token: { symbol: token.symbol, address: token.address },
        amount: args.amount,
        amountRaw: amountRaw.toString(),
        interestRateMode: 'variable',
        onBehalfOf,
        txHash,
      }
    },
  })
}

/** KeeperHub mutate route for `aave_borrow` — `Pool.borrow(...)`. */
export const buildBorrowRoute =
  (opts: { walletAddress: Address }): MutateRoute =>
  (args) => {
    const parsed = BorrowSchema.parse(args)
    const token = resolveAaveToken(parsed.token)
    const amountRaw = parseUnits(parsed.amount, token.decimals)
    const onBehalfOf = (parsed.onBehalfOf ?? opts.walletAddress) as Address
    return {
      network: 'sepolia',
      contract_address: SEPOLIA_AAVE.pool,
      function_name: 'borrow',
      function_args: [
        token.address,
        amountRaw.toString(),
        INTEREST_RATE_MODE_VARIABLE.toString(),
        REFERRAL_CODE,
        onBehalfOf,
      ],
      abi: POOL_ABI,
    }
  }
