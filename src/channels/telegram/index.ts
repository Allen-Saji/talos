import { TalosNotImplementedError } from '@/shared/errors'

export function startTelegramChannel(): never {
  throw new TalosNotImplementedError('channels.telegram.startTelegramChannel')
}
