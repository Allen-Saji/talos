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

export const ClientFrame = z.discriminatedUnion('type', [
  HelloFrame,
  AuthFrame,
  RunStartFrame,
  RunCancelFrame,
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
})
export type ErrorFrame = z.infer<typeof ErrorFrame>

export const ServerFrame = z.discriminatedUnion('type', [
  HelloAckFrame,
  RunEventFrame,
  RunDoneFrame,
  ErrorFrame,
])
export type ServerFrame = z.infer<typeof ServerFrame>
