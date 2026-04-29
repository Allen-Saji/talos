import { TalosConfigError } from '@/shared/errors'
import type { Agent } from './types'

/**
 * Map-based agent registry, agent-kit shape. Multi-agent ready;
 * v1 ships with a single `talos-eth` agent.
 */
export class AgentRegistry {
  private readonly agents = new Map<string, Agent>()
  private defaultAgentId: string | null = null

  register(agent: Agent, opts: { default?: boolean } = {}): void {
    this.agents.set(agent.id, agent)
    if (opts.default || this.defaultAgentId === null) {
      this.defaultAgentId = agent.id
    }
  }

  get(id?: string): Agent {
    const targetId = id ?? this.defaultAgentId
    if (!targetId) {
      throw new TalosConfigError('agent registry is empty; register at least one agent')
    }
    const agent = this.agents.get(targetId)
    if (!agent) {
      throw new TalosConfigError(`unknown agent "${targetId}"`)
    }
    return agent
  }

  list(): Agent[] {
    return Array.from(this.agents.values())
  }

  has(id: string): boolean {
    return this.agents.has(id)
  }
}

export const TALOS_ETH_AGENT: Agent = {
  id: 'talos-eth',
  persona:
    'You are Talos, a vertical Ethereum agent. You help the user interact with EVM chains: query balances, swap tokens, supply/borrow on lending protocols, bridge assets. You favor Arbitrum and Base for cost. When in doubt, ask before broadcasting a mutating transaction. Be concise.',
  modelId: 'openai/gpt-4o-mini',
}
