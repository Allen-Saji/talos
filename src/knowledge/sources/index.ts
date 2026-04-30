import { createDefillamaHacksSource, createDefillamaProtocolsSource } from './defillama'
import { createEfBlogSource } from './ef-blog'
import { createL2BeatSource } from './l2beat'
import { createSnapshotSource } from './snapshot'
import type { KnowledgeSource, SourceDeps } from './types'

export {
  createDefillamaHacksSource,
  createDefillamaProtocolsSource,
} from './defillama'
export { createEfBlogSource } from './ef-blog'
export { createL2BeatSource } from './l2beat'
export { createSnapshotSource, DEFAULT_SNAPSHOT_SPACES } from './snapshot'
export type { HttpFetch, KnowledgeSource, KnowledgeSourceItem, SourceDeps } from './types'

/**
 * Default source set Talos boots with. Five sources:
 *  - defillama:protocols (TVL ranks)
 *  - defillama:hacks (recent DeFi exploits)
 *  - l2beat:summary (rollup state)
 *  - snapshot:proposals (governance)
 *  - ef-blog (ETH-level news)
 */
export function defaultKnowledgeSources(deps: SourceDeps = {}): KnowledgeSource[] {
  return [
    createDefillamaProtocolsSource(deps),
    createDefillamaHacksSource(deps),
    createL2BeatSource(deps),
    createSnapshotSource(deps),
    createEfBlogSource(deps),
  ]
}
