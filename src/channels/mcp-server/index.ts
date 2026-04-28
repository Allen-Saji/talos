import { TalosNotImplementedError } from '@/shared/errors'

export function startMcpServerChannel(): never {
  throw new TalosNotImplementedError('channels.mcp-server.startMcpServerChannel')
}
