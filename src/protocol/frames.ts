import { z } from 'zod'

export const PROTOCOL_VERSION = '0.1.0'

export const HelloFrame = z.object({
  type: z.literal('hello'),
  version: z.string(),
  client: z.string().optional(),
})
export type HelloFrame = z.infer<typeof HelloFrame>

export const AuthFrame = z.object({
  type: z.literal('auth'),
  token: z.string().min(1),
})
export type AuthFrame = z.infer<typeof AuthFrame>

export const RunStartFrame = z.object({
  type: z.literal('run-start'),
  threadId: z.string().min(1),
  prompt: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type RunStartFrame = z.infer<typeof RunStartFrame>

export const RunCancelFrame = z.object({
  type: z.literal('run-cancel'),
  runId: z.string().min(1),
})
export type RunCancelFrame = z.infer<typeof RunCancelFrame>

export const KnowledgeRefreshFrame = z.object({
  type: z.literal('knowledge-refresh'),
  /** Echoed back on the result frame so callers can correlate. */
  requestId: z.string().min(1),
})
export type KnowledgeRefreshFrame = z.infer<typeof KnowledgeRefreshFrame>

export const ClientFrame = z.discriminatedUnion('type', [
  HelloFrame,
  AuthFrame,
  RunStartFrame,
  RunCancelFrame,
  KnowledgeRefreshFrame,
])
export type ClientFrame = z.infer<typeof ClientFrame>

export const HelloAckFrame = z.object({
  type: z.literal('hello-ack'),
  version: z.string(),
  serverTime: z.string(),
})
export type HelloAckFrame = z.infer<typeof HelloAckFrame>

export const RunEventFrame = z.object({
  type: z.literal('run-event'),
  runId: z.string(),
  event: z.unknown(),
})
export type RunEventFrame = z.infer<typeof RunEventFrame>

export const RunDoneFrame = z.object({
  type: z.literal('run-done'),
  runId: z.string(),
  finishReason: z.string().optional(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
})
export type RunDoneFrame = z.infer<typeof RunDoneFrame>

export const ErrorFrame = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
  runId: z.string().optional(),
  /** Set when the error was raised in response to a non-run request (e.g. knowledge-refresh). */
  requestId: z.string().optional(),
})
export type ErrorFrame = z.infer<typeof ErrorFrame>

export const KnowledgeSourceReportFrame = z.object({
  source: z.string(),
  fetched: z.number().int().nonnegative(),
  chunks: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  error: z.string().optional(),
})
export type KnowledgeSourceReportFrame = z.infer<typeof KnowledgeSourceReportFrame>

export const KnowledgeRefreshDoneFrame = z.object({
  type: z.literal('knowledge-refresh-done'),
  requestId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  totalDurationMs: z.number().int().nonnegative(),
  sources: z.array(KnowledgeSourceReportFrame),
})
export type KnowledgeRefreshDoneFrame = z.infer<typeof KnowledgeRefreshDoneFrame>

export const ServerFrame = z.discriminatedUnion('type', [
  HelloAckFrame,
  RunEventFrame,
  RunDoneFrame,
  KnowledgeRefreshDoneFrame,
  ErrorFrame,
])
export type ServerFrame = z.infer<typeof ServerFrame>
