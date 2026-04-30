import { isAddress } from 'viem'
import { SEPOLIA_UNISWAP } from './contracts'

/**
 * Symbol -> Sepolia token table. Keep small — the tools accept either a
 * symbol from this table OR a hex address override, so adding a token only
 * matters when the agent should be able to refer to it by name.
 *
 * Sources:
 * - USDC (Circle Sepolia): https://faucet.circle.com/
 * - DAI (community Sepolia mock used by Uniswap pools)
 * - WETH (canonical Sepolia WETH9, also re-exported from contracts.ts)
 */
export type SepoliaToken = {
  symbol: string
  address: `0x${string}`
  decimals: number
}

export const SEPOLIA_TOKENS: Record<string, SepoliaToken> = {
  USDC: {
    symbol: 'USDC',
    address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    decimals: 6,
  },
  WETH: {
    symbol: 'WETH',
    address: SEPOLIA_UNISWAP.weth,
    decimals: 18,
  },
  ETH: {
    // Aliased to WETH — the agent says "ETH" and the swap is wrapped/unwrapped
    // implicitly via WETH. v1 keeps this explicit (no auto-wrap helper yet).
    symbol: 'ETH',
    address: SEPOLIA_UNISWAP.weth,
    decimals: 18,
  },
  DAI: {
    symbol: 'DAI',
    address: '0xB4F1737Af37711e9A5890D9510c9bB60e170CB0D',
    decimals: 18,
  },
}

/**
 * Resolve a token reference (symbol like "USDC" or hex address) to a
 * SepoliaToken record. Symbols are case-insensitive; addresses are checksummed
 * by viem `isAddress` and normalized to lowercase.
 *
 * Throws when the symbol is unknown and the input isn't a valid address.
 */
export function resolveToken(input: string): SepoliaToken {
  const upper = input.toUpperCase()
  if (SEPOLIA_TOKENS[upper]) return SEPOLIA_TOKENS[upper]
  // strict: false — accept any 0x-prefixed 40-hex address shape; we don't
  // require EIP-55 checksum from the agent, which often gets case wrong.
  if (isAddress(input, { strict: false })) {
    return {
      symbol: input,
      address: input.toLowerCase() as `0x${string}`,
      decimals: 18, // Best-effort default; on-chain `decimals()` is authoritative.
    }
  }
  throw new Error(
    `unknown token "${input}" (known: ${Object.keys(SEPOLIA_TOKENS).join(', ')}, or pass a 0x address)`,
  )
}
