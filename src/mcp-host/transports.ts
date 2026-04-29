import {
  type StdioConfig,
  Experimental_StdioMCPTransport as StdioMCPTransport,
} from '@ai-sdk/mcp/mcp-stdio'
import type { McpServerConfig } from './index'

/** HTTP transport config shape (matches @ai-sdk/mcp internal type) */
type HttpTransportConfig = {
  type: 'sse' | 'http'
  url: string
  headers?: Record<string, string>
}

/**
 * Build an AI SDK transport from a server config.
 * - stdio: spawns a child process via StdioMCPTransport
 * - http: returns transport config object for createMCPClient
 */
export function buildTransport(
  config: McpServerConfig,
): InstanceType<typeof StdioMCPTransport> | HttpTransportConfig {
  if (config.transport === 'stdio') {
    if (!config.command) {
      throw new Error(`stdio server "${config.name}" requires a command`)
    }
    const stdioConfig: StdioConfig = {
      command: config.command,
      args: config.args,
    }
    return new StdioMCPTransport(stdioConfig)
  }

  if (config.transport === 'http') {
    if (!config.url) {
      throw new Error(`http server "${config.name}" requires a url`)
    }
    return {
      type: 'http' as const,
      url: config.url,
    }
  }

  throw new Error(`unknown transport "${config.transport}" for server "${config.name}"`)
}
