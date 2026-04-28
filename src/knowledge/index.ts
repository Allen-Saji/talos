import { TalosNotImplementedError } from '@/shared/errors'

export function runKnowledgeCron(): never {
  throw new TalosNotImplementedError('knowledge.runKnowledgeCron')
}

export function retrieveTopK(_query: string, _k = 5): never {
  throw new TalosNotImplementedError('knowledge.retrieveTopK')
}
