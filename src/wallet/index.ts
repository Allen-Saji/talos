import { TalosNotImplementedError } from '@/shared/errors'

export function createWallet(): never {
  throw new TalosNotImplementedError('wallet.createWallet')
}
