import { NativeToolSource } from '@/tools/native'
import { lifiReadTools } from './tools'

/**
 * Build a NativeToolSource exposing Li.Fi's read-only tools (5 tools, all
 * pre-namespaced as `lifi_*`).
 *
 * Wallet-bound write tools (executeQuote, approveToken, transfer*) are
 * deferred until the wallet module lands. Once it does, this factory will
 * accept a `WalletClient` argument and add the write tools when present.
 */
export function createLifiToolSource(): NativeToolSource {
  const { tools, annotations } = lifiReadTools()
  return new NativeToolSource({
    name: 'lifi',
    tools,
    annotations,
  })
}

export { ensureLifiSdk, resetLifiSdkForTests } from './client'
export { lifiReadTools } from './tools'
