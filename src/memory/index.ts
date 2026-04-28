import { TalosNotImplementedError } from '@/shared/errors'

export function getHotMessages(_threadId: string, _limit = 20): never {
  throw new TalosNotImplementedError('memory.getHotMessages')
}

export function getWarmSummary(_threadId: string): never {
  throw new TalosNotImplementedError('memory.getWarmSummary')
}

export function getColdRecall(_query: string, _threshold = 0.78, _topK = 3): never {
  throw new TalosNotImplementedError('memory.getColdRecall')
}
