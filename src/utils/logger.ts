import { isDev } from './env'

function normalizeLogArg(arg: unknown): unknown {
  if (arg instanceof Error) {
    return {
      name: arg.name,
      message: arg.message,
      stack: arg.stack,
    }
  }

  if (typeof arg === 'object' && arg !== null) {
    try {
      return JSON.parse(JSON.stringify(arg))
    } catch {
      return String(arg)
    }
  }

  return arg
}

export const logger = {
  info: (message: string, ...args: unknown[]) => {
    if (isDev) {
      console.info(`[logger] ${message}`, ...args.map(normalizeLogArg))
    }
  },
  warn: (message: string, ...args: unknown[]) => {
    console.warn(`[logger] ${message}`, ...args.map(normalizeLogArg))
  },
  error: (message: string, ...args: unknown[]) => {
    console.error(`[logger] ${message}`, ...args.map(normalizeLogArg))
  },
}
