import type { Address, PublicClient, WalletClient } from 'viem'
import type { MutateRoute } from '@/keeperhub'
import { NativeToolSource } from '@/tools/native'
import { buildAccountTool } from './account'
import { buildAaveApproveRoute, buildAaveApproveTool } from './approve'
import { buildBorrowRoute, buildBorrowTool } from './borrow'
import { buildRepayRoute, buildRepayTool } from './repay'
import { buildSupplyRoute, buildSupplyTool } from './supply'
import { buildWithdrawRoute, buildWithdrawTool } from './withdraw'

/**
 * Build the Aave V3 NativeToolSource. Six tools:
 *
 * - `aave_get_user_account_data` (read; KNOWN_READONLY via `_get_`) — reads
 *   Pool.getUserAccountData and returns aggregate collateral/debt/health.
 * - `aave_approve_pool` (mutate, routed) — `ERC20.approve(Pool, amount)`.
 *   Required before `aave_supply` and `aave_repay`.
 * - `aave_supply` (mutate, routed) — `Pool.supply(...)`. Mints aTokens.
 * - `aave_borrow` (mutate, routed) — `Pool.borrow(...)` at variable rate.
 * - `aave_repay` (mutate, routed) — `Pool.repay(...)` at variable rate.
 * - `aave_withdraw` (mutate, routed) — `Pool.withdraw(...)`. Burns aTokens.
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

  // Annotations: only `aave_get_user_account_data` is read-only (also caught
  // by KNOWN_READONLY regex via `_get_`); the rest mutate.
  const annotations = {
    aave_get_user_account_data: { readOnly: true, mutates: false },
    aave_approve_pool: { mutates: true, readOnly: false },
    aave_supply: { mutates: true, readOnly: false },
    aave_borrow: { mutates: true, readOnly: false },
    aave_repay: { mutates: true, readOnly: false },
    aave_withdraw: { mutates: true, readOnly: false },
  }

  const routes: Record<string, MutateRoute> = {
    aave_approve_pool: buildAaveApproveRoute(),
    aave_supply: buildSupplyRoute({ walletAddress: opts.walletAddress }),
    aave_borrow: buildBorrowRoute({ walletAddress: opts.walletAddress }),
    aave_repay: buildRepayRoute({ walletAddress: opts.walletAddress }),
    aave_withdraw: buildWithdrawRoute({ walletAddress: opts.walletAddress }),
  }

  return new NativeToolSource({
    name: 'aave',
    tools,
    annotations,
    routes,
  })
}
