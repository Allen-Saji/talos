import { type Logger, pino } from 'pino'
import { loadEnv } from '@/config/env'

const env = loadEnv()

const isDev = env.NODE_ENV === 'development'

export const logger: Logger = pino({
  level: env.TALOS_LOG_LEVEL,
  base: { app: 'talos' },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname,app',
      },
    },
  }),
})

export function child(bindings: Record<string, unknown>): Logger {
  return logger.child(bindings)
}
