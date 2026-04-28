import { TalosNotImplementedError } from '@/shared/errors'

export function registerTools(): never {
  throw new TalosNotImplementedError('tools.registerTools')
}
