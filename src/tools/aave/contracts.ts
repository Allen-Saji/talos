import { type Abi, parseAbi } from 'viem'

/**
 * Aave V3 Sepolia deployment.
 *
 * `pool` is the proxy hit for supply/borrow/repay/withdraw and
 * `getUserAccountData`. `addressesProvider` and `dataProvider` are not used
 * directly by the v1 tools — kept for future use (e.g. reading per-reserve
 * config) and for completeness.
 *
 * Source: https://github.com/bgd-labs/aave-address-book → AaveV3Sepolia.sol
 */
export const SEPOLIA_AAVE = {
  pool: '0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951',
  addressesProvider: '0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A',
  dataProvider: '0x3e9708d80f7B3e43118013075F7e95CE3AB31F31',
} as const

/**
 * Aave V3 only supports variable interest rate mode (stable was deprecated).
 * `borrow` and `repay` take this as a `uint256` argument; we hard-code `2n`.
 */
export const INTEREST_RATE_MODE_VARIABLE = 2n

/**
 * Currently inactive on-chain (pre-allocated for a referral program that
 * never launched). Pass `0` per the docs.
 */
export const REFERRAL_CODE = 0

/**
 * ABI fragments for the four mutate paths plus `getUserAccountData`.
 * Hand-written `parseAbi` keeps the bundle small and avoids pulling the full
 * Aave artifact JSON.
 */
export const POOL_ABI: Abi = parseAbi([
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external',
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external',
  'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) external returns (uint256)',
  'function withdraw(address asset, uint256 amount, address to) external returns (uint256)',
  'function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
])

/** Minimal ERC20 ABI for approve + allowance reads (Pool spender). */
export const ERC20_ABI: Abi = parseAbi([
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
])

/**
 * Aave V3 reports collateral/debt amounts in USD with 8 decimals (the
 * "base currency" in price-oracle terms). Helper for human-readable output.
 */
export const BASE_CURRENCY_DECIMALS = 8

/** Health factor, LTV, liquidation threshold scaling. */
export const HEALTH_FACTOR_DECIMALS = 18
export const LTV_DECIMALS = 4
