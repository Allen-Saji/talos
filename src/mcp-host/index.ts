import { TalosNotImplementedError } from '@/shared/errors'

export interface McpServerConfig {
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
}

export class McpHost {
  start(_servers: McpServerConfig[]): Promise<void> {
    throw new TalosNotImplementedError('McpHost.start')
  }

  stop(): Promise<void> {
    throw new TalosNotImplementedError('McpHost.stop')
  }

  listTools(): never {
    throw new TalosNotImplementedError('McpHost.listTools')
  }
}
