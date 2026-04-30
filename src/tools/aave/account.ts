import { tool } from 'ai'
import type { Address, PublicClient } from 'viem'
import { z } from 'zod'
import {
  BASE_CURRENCY_DECIMALS,
  HEALTH_FACTOR_DECIMALS,
  LTV_DECIMALS,
  POOL_ABI,
  SEPOLIA_AAVE,
} from './contracts'

const AccountSchema = z.object({
  user: z
    .string()
    .optional()
    .describe('Wallet address to inspect. Defaults to the connected wallet when omitted.'),
})

export type AccountDataResult = {
  user: Address
  totalCollateralUsd: string
  totalDebtUsd: string
  availableBorrowsUsd: string
  currentLiquidationThreshold: string
  ltv: string
  healthFactor: string
  raw: {
    totalCollateralBase: string
    totalDebtBase: string
    availableBorrowsBase: string
    currentLiquidationThreshold: string
    ltv: string
    healthFactor: string
  }
}

/**
 * Build the `aave_get_user_account_data` tool. Calls Pool.getUserAccountData
 * and returns the six aggregate numbers Aave maintains per account, formatted
 * to human-readable units alongside the raw bigints. Read-only; the leading
 * `_get_` opts out of KeeperHub audit via the KNOWN_READONLY regex.
 *
 * `healthFactor == 2^256 - 1` means the user has no open borrow positions —
 * Aave returns the max uint as a sentinel. We surface it as `"infinity"` for
 * the agent.
 */
export function buildAccountTool(opts: { publicClient: PublicClient; walletAddress: Address }) {
  return tool({
    description:
      'Read aggregate Aave V3 account data on Sepolia: total collateral (USD), total debt (USD), available to borrow (USD), liquidation threshold, LTV, and health factor. Read-only; no state changes. Defaults to the connected wallet.',
    inputSchema: AccountSchema,
    execute: async (args): Promise<AccountDataResult> => {
      const target = (args.user ?? opts.walletAddress) as Address

      const result = (await opts.publicClient.readContract({
        address: SEPOLIA_AAVE.pool as Address,
        abi: POOL_ABI,
        functionName: 'getUserAccountData',
        args: [target],
      })) as readonly [bigint, bigint, bigint, bigint, bigint, bigint]

      const [
        totalCollateralBase,
        totalDebtBase,
        availableBorrowsBase,
        currentLiquidationThreshold,
        ltv,
        healthFactor,
      ] = result

      const MAX_UINT256 = (1n << 256n) - 1n
      const healthFactorHuman =
        healthFactor === MAX_UINT256
          ? 'infinity'
          : formatUnits(healthFactor, HEALTH_FACTOR_DECIMALS)

      return {
        user: target,
        totalCollateralUsd: formatUnits(totalCollateralBase, BASE_CURRENCY_DECIMALS),
        totalDebtUsd: formatUnits(totalDebtBase, BASE_CURRENCY_DECIMALS),
        availableBorrowsUsd: formatUnits(availableBorrowsBase, BASE_CURRENCY_DECIMALS),
        currentLiquidationThreshold: formatUnits(currentLiquidationThreshold, LTV_DECIMALS),
        ltv: formatUnits(ltv, LTV_DECIMALS),
        healthFactor: healthFactorHuman,
        raw: {
          totalCollateralBase: totalCollateralBase.toString(),
          totalDebtBase: totalDebtBase.toString(),
          availableBorrowsBase: availableBorrowsBase.toString(),
          currentLiquidationThreshold: currentLiquidationThreshold.toString(),
          ltv: ltv.toString(),
          healthFactor: healthFactor.toString(),
        },
      }
    },
  })
}

function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n
  const v = negative ? -value : value
  const str = v.toString().padStart(decimals + 1, '0')
  const head = str.slice(0, str.length - decimals)
  const tail = str.slice(str.length - decimals).replace(/0+$/, '')
  const out = tail.length > 0 ? `${head}.${tail}` : head
  return negative ? `-${out}` : out
}
