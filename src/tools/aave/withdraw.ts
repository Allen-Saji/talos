import { tool } from 'ai'
import { type Address, type Hex, type PublicClient, parseUnits, type WalletClient } from 'viem'
import { z } from 'zod'
import type { MutateRoute } from '@/keeperhub'
import { POOL_ABI, SEPOLIA_AAVE } from './contracts'
import { resolveAaveToken } from './tokens'

const MAX_UINT256 = (1n << 256n) - 1n

const WithdrawSchema = z.object({
  token: z
    .string()
    .describe('Token symbol (USDC, DAI, WETH, USDT, WBTC, AAVE, LINK, GHO) or 0x address'),
  amount: z
    .string()
    .describe(
      'Withdraw amount in token human units (e.g. "100" for 100 USDC), or "max" to redeem the entire aToken balance.',
    ),
  to: z
    .string()
    .optional()
    .describe('Recipient of the withdrawn underlying. Defaults to the connected wallet.'),
})

export type WithdrawResult = {
  token: { symbol: string; address: Address }
  amount: string
  amountRaw: string
  to: Address
  isMax: boolean
  txHash?: Hex
}

/**
 * Build the `aave_withdraw` tool. Calls `Pool.withdraw(asset, amount, to)` —
 * Pool burns the caller's aTokens and transfers the underlying to `to`. No
 * approval needed; the user already owns the aTokens.
 *
 * `amount: "max"` resolves to `type(uint256).max`, which Aave treats as
 * "redeem the full aToken balance" — the contract reads the live balance at
 * execution time.
 */
export function buildWithdrawTool(opts: {
  walletClient: WalletClient
  publicClient: PublicClient
  walletAddress: Address
}) {
  return tool({
    description:
      'Withdraw supplied tokens from Aave V3 (Sepolia) by redeeming aTokens. No approval required (the user owns the aTokens). Pass amount="max" to redeem the full aToken balance. Mutates state; routed through KeeperHub when configured.',
    inputSchema: WithdrawSchema,
    execute: async (args): Promise<WithdrawResult> => {
      const token = resolveAaveToken(args.token)
      const isMax = args.amount.toLowerCase() === 'max'
      const amountRaw = isMax ? MAX_UINT256 : parseUnits(args.amount, token.decimals)
      const to = (args.to ?? opts.walletAddress) as Address

      const txHash = await opts.walletClient.writeContract({
        account: opts.walletClient.account ?? opts.walletAddress,
        chain: opts.walletClient.chain ?? null,
        address: SEPOLIA_AAVE.pool as Address,
        abi: POOL_ABI,
        functionName: 'withdraw',
        args: [token.address, amountRaw, to],
      })

      return {
        token: { symbol: token.symbol, address: token.address },
        amount: args.amount,
        amountRaw: amountRaw.toString(),
        to,
        isMax,
        txHash,
      }
    },
  })
}

/** KeeperHub mutate route for `aave_withdraw` — `Pool.withdraw(...)`. */
export const buildWithdrawRoute =
  (opts: { walletAddress: Address }): MutateRoute =>
  (args) => {
    const parsed = WithdrawSchema.parse(args)
    const token = resolveAaveToken(parsed.token)
    const isMax = parsed.amount.toLowerCase() === 'max'
    const amountRaw = isMax ? MAX_UINT256 : parseUnits(parsed.amount, token.decimals)
    const to = (parsed.to ?? opts.walletAddress) as Address
    return {
      network: 'sepolia',
      contract_address: SEPOLIA_AAVE.pool,
      function_name: 'withdraw',
      function_args: [token.address, amountRaw.toString(), to],
      abi: POOL_ABI,
    }
  }
