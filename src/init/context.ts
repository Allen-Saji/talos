/**
 * Init wizard accumulator. Each step reads what it needs from `existing`
 * (idempotency state) and writes results back to `results`. The orchestrator
 * uses both to decide what to print in the final summary and to allow later
 * steps to reference earlier-step output without re-prompting.
 */

import type { paths as Paths } from '@/config/paths'
import type { ExistingState } from './detect'

export type WizardMode = 'interactive' | 'non-interactive'

export type IdempotencyChoice = 'keep' | 'reset' | 'partial-oauth-only'

export type StepName =
  | 'welcome'
  | 'openai-key'
  | 'wallet'
  | 'keeperhub-oauth'
  | 'channels'
  | 'daemon-token'
  | 'migrations'
  | 'service'
  | 'summary'

export type StepResult = {
  status: 'done' | 'skipped' | 'kept'
  /** Free-form text the summary can echo back. */
  summary?: string
  /** Step-specific machine-readable detail. */
  data?: Record<string, unknown>
}

export type WizardContext = {
  mode: WizardMode
  paths: typeof Paths
  /** Skipping the KH OAuth step entirely (flag-driven or graceful fallback). */
  skipKeeperhub: boolean
  /** Skipping service install (auto in non-interactive). */
  skipService: boolean
  /** Pre-init detection results — what already exists on disk. */
  existing: ExistingState
  /** User's choice when existing config detected. */
  idempotency: IdempotencyChoice
  /** Per-step results. */
  results: Partial<Record<StepName, StepResult>>
}
