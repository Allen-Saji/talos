import { TalosNotImplementedError } from '@/shared/errors'

export * from './schema'

export function createDb(): never {
  throw new TalosNotImplementedError('persistence.createDb')
}

export function runMigrations(): never {
  throw new TalosNotImplementedError('persistence.runMigrations')
}
