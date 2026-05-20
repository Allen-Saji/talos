import type { Address, PublicClient, WalletClient } from 'viem'
import { NativeToolSource } from '@/tools/native'
import { buildAccountTool } from './account'
import { buildAaveApproveTool } from './approve'
import { buildBorrowTool } from './borrow'
import { buildRepayTool } from './repay'
import { buildSupplyTool } from './supply'
import { buildWithdrawTool } from './withdraw'

/**
 * Build the Aave V3 NativeToolSource. Six tools:
 *
 * - `aave_get_user_account_data` (read) — reads Pool.getUserAccountData and
 *   returns aggregate collateral/debt/health.
 * - `aave_approve_pool` — `ERC20.approve(Pool, amount)`. Required before
 *   `aave_supply` and `aave_repay`.
 * - `aave_supply` — `Pool.supply(...)`. Mints aTokens.
 * - `aave_borrow` — `Pool.borrow(...)` at variable rate.
 * - `aave_repay` — `Pool.repay(...)` at variable rate.
 * - `aave_withdraw` — `Pool.withdraw(...)`. Burns aTokens.
 *
 * Variable rate is the only mode supported on Aave V3 (stable was deprecated).
 * Native ETH is not supported — use WETH directly.
 */
export function createAaveToolSource(opts: {
  walletClient: WalletClient
  publicClient: PublicClient
  walletAddress: Address
}): NativeToolSource {
  const account = buildAccountTool({
    publicClient: opts.publicClient,
    walletAddress: opts.walletAddress,
  })
  const approve = buildAaveApproveTool({
    walletClient: opts.walletClient,
    publicClient: opts.publicClient,
    walletAddress: opts.walletAddress,
  })
  const supply = buildSupplyTool({
    walletClient: opts.walletClient,
    publicClient: opts.publicClient,
    walletAddress: opts.walletAddress,
  })
  const borrow = buildBorrowTool({
    walletClient: opts.walletClient,
    publicClient: opts.publicClient,
    walletAddress: opts.walletAddress,
  })
  const repay = buildRepayTool({
    walletClient: opts.walletClient,
    publicClient: opts.publicClient,
    walletAddress: opts.walletAddress,
  })
  const withdraw = buildWithdrawTool({
    walletClient: opts.walletClient,
    publicClient: opts.publicClient,
    walletAddress: opts.walletAddress,
  })

  const tools = {
    aave_get_user_account_data: account,
    aave_approve_pool: approve,
    aave_supply: supply,
    aave_borrow: borrow,
    aave_repay: repay,
    aave_withdraw: withdraw,
  }

  const annotations = {
    aave_get_user_account_data: { readOnly: true, mutates: false },
    aave_approve_pool: { mutates: true, readOnly: false },
    aave_supply: { mutates: true, readOnly: false },
    aave_borrow: { mutates: true, readOnly: false },
    aave_repay: { mutates: true, readOnly: false },
    aave_withdraw: { mutates: true, readOnly: false },
  }

  return new NativeToolSource({
    name: 'aave',
    tools,
    annotations,
  })
}
