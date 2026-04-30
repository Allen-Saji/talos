import { isAddress } from 'viem'

/**
 * Aave V3 Sepolia underlying token table. These addresses are the Aave-issued
 * mock ERC-20s, distinct from the Uniswap V3 Sepolia test tokens. The agent
 * resolves a symbol against THIS table when calling Aave tools — passing a
 * Uniswap USDC address into `aave_supply` would fail because there's no
 * Aave reserve for it.
 *
 * Source: https://github.com/bgd-labs/aave-address-book → AaveV3Sepolia.sol
 */
export type AaveSepoliaToken = {
  symbol: string
  address: `0x${string}`
  decimals: number
}

export const SEPOLIA_AAVE_TOKENS: Record<string, AaveSepoliaToken> = {
  USDC: {
    symbol: 'USDC',
    address: '0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8',
    decimals: 6,
  },
  DAI: {
    symbol: 'DAI',
    address: '0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357',
    decimals: 18,
  },
  WETH: {
    symbol: 'WETH',
    address: '0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c',
    decimals: 18,
  },
  USDT: {
    symbol: 'USDT',
    address: '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0',
    decimals: 6,
  },
  WBTC: {
    symbol: 'WBTC',
    address: '0x29f2D40B0605204364af54EC677bD022dA425d03',
    decimals: 8,
  },
  AAVE: {
    symbol: 'AAVE',
    address: '0x88541670E55cC00bEEFD87eB59EDd1b7C511AC9a',
    decimals: 18,
  },
  LINK: {
    symbol: 'LINK',
    address: '0xf8Fb3713D459D7C1018BD0A49D19b4C44290EBE5',
    decimals: 18,
  },
  GHO: {
    symbol: 'GHO',
    address: '0xc4bF5CbDaBE595361438F8c6a187bDc330539c60',
    decimals: 18,
  },
}

/**
 * Resolve a token reference (symbol or hex address) to an AaveSepoliaToken.
 * Symbols are case-insensitive. Addresses are accepted with relaxed checksum
 * validation and normalized to lowercase. Throws on unknown reference.
 *
 * NOTE: native ETH is intentionally not aliased to WETH here — Aave's `supply`
 * for native ETH requires the WrappedTokenGatewayV3 contract, which v1
 * doesn't wrap. The user supplies WETH directly.
 */
export function resolveAaveToken(input: string): AaveSepoliaToken {
  const upper = input.toUpperCase()
  if (SEPOLIA_AAVE_TOKENS[upper]) return SEPOLIA_AAVE_TOKENS[upper]
  if (isAddress(input, { strict: false })) {
    return {
      symbol: input,
      address: input.toLowerCase() as `0x${string}`,
      decimals: 18,
    }
  }
  throw new Error(
    `unknown Aave Sepolia token "${input}" (known: ${Object.keys(SEPOLIA_AAVE_TOKENS).join(', ')}, or pass a 0x address)`,
  )
}
