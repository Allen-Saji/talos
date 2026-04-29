import type { KnowledgeChunkHit } from './types'

export type SystemPromptInput = {
  persona: string
  /** Latest thread summary (warm tier) */
  warmSummary?: string | null
  /** Cross-thread cold recall summaries */
  coldRecallSummaries?: string[]
  /** Top knowledge chunks from the daily ETH cron */
  knowledgeChunks?: KnowledgeChunkHit[]
  /** Tool names mounted on this run, surfaced for the LLM's awareness */
  toolNames?: string[]
}

/**
 * Letta-style single concatenated system prompt. Empty blocks are omitted.
 * Sections are surfaced top-down: persona, knowledge, cross-thread recall,
 * thread summary, then a manifest of available tools.
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
  const blocks: string[] = []
  blocks.push(input.persona.trim())

  if (input.knowledgeChunks && input.knowledgeChunks.length > 0) {
    const items = input.knowledgeChunks.map((c) => `- [${c.source}] ${c.content}`).join('\n')
    blocks.push(`Recent ETH ecosystem state:\n${items}`)
  }

  if (input.coldRecallSummaries && input.coldRecallSummaries.length > 0) {
    const items = input.coldRecallSummaries.map((s) => `- ${s}`).join('\n')
    blocks.push(`Prior context (other conversations):\n${items}`)
  }

  if (input.warmSummary && input.warmSummary.trim().length > 0) {
    blocks.push(`Thread summary so far:\n${input.warmSummary.trim()}`)
  }

  if (input.toolNames && input.toolNames.length > 0) {
    blocks.push(`Tools available: ${input.toolNames.join(', ')}`)
  }

  return blocks.join('\n\n')
}
