import { TalosNotImplementedError } from '@/shared/errors'

export function startDaemon(): never {
  throw new TalosNotImplementedError('daemon.startDaemon')
}
