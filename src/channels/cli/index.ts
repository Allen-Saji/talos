import { TalosNotImplementedError } from '@/shared/errors'

export function startCliChannel(): never {
  throw new TalosNotImplementedError('channels.cli.startCliChannel')
}
