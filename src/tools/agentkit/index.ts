import { logger } from '@/shared/logger'
import { NativeToolSource } from '@/tools/native'
import { agentKitTools } from './tools'

/**
 * Build a NativeToolSource exposing AgentKit's cherry-picked action providers
 * (Pyth, Zerion, Compound, Morpho, Sushi router, 0x, Enso, Basename,
 * OpenSea, Zora). Read tools work against the configured wallet's address;
 * write tools require funds on Base Sepolia.
 *
 * If AgentKit init fails (e.g. transient upstream issue), returns an empty
 * NativeToolSource and logs a warning. This keeps the daemon booting even
 * when the AgentKit surface is unavailable — the rest of the tool sources
 * (evm-mcp, blockscout, lifi) carry on.
 */
export async function createAgentKitToolSource(): Promise<NativeToolSource> {
  try {
    const { tools, annotations } = await agentKitTools()
    return new NativeToolSource({
      name: 'agentkit',
      tools,
      annotations,
    })
  } catch (err) {
    logger.warn(
      { err, module: 'agentkit' },
      'AgentKit init failed — continuing with empty AgentKit surface',
    )
    return new NativeToolSource({
      name: 'agentkit',
      tools: {},
      annotations: {},
    })
  }
}

export { getAgentKit, resetAgentKitForTests } from './client'
export { agentKitTools, classifyAnnotations, READ_PATTERNS } from './tools'
