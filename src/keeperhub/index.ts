import { TalosNotImplementedError } from '@/shared/errors'

export const KNOWN_READONLY: readonly RegExp[] = [
  /_get_/,
  /_quote$/,
  /_status$/,
  /_balance$/,
  /_position$/,
  /_search/,
  /^blockscout_/,
] as const

export function shouldAudit(_toolName: string, _annotations?: { mutates?: boolean }): never {
  throw new TalosNotImplementedError('keeperhub.shouldAudit')
}

export function createKeeperHubMiddleware(): never {
  throw new TalosNotImplementedError('keeperhub.createKeeperHubMiddleware')
}
