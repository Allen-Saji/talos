import { TalosNotImplementedError } from '@/shared/errors'

export interface RunOptions {
  threadId: string
  prompt: string
  metadata?: Record<string, unknown>
}

export function run(_options: RunOptions): never {
  throw new TalosNotImplementedError('runtime.run')
}
