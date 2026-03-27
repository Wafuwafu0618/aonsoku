import { Client } from 'discord-rpc'

const ActivityType = {
  Game: 0,
  Streaming: 1,
  Listening: 2,
  Watching: 3,
  Custom: 4,
  Competing: 5,
}

type IActivity = {
  timestamps?: {
    start?: number
    end?: number
  }
  details?: string
  state?: string
  assets?: {
    large_image?: string
    large_text?: string
    small_image?: string
    small_text?: string
  }
  instance?: boolean
  type?: number
}

export type PayloadType = {
  pid: number
  activity: IActivity | null
}

export const DEFAULT_LARGE_IMAGE = 'icon'
export const DEFAULT_SMALL_IMAGE = 'song_icon'

let discord: Client | null = null
let lastPayload: PayloadType | null = null
let activeClientId: string | null = null
let connectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
let isReady = false

function readViteDiscordClientId(): string {
  try {
    const envValue = (
      import.meta as ImportMeta & {
        env?: Record<string, string | undefined>
      }
    ).env?.MAIN_VITE_DISCORD_CLIENT_ID
    return (envValue ?? '').trim()
  } catch {
    return ''
  }
}

function clampPresenceText(value: string | undefined, maxLength: number): string {
  const normalized = (value ?? '').trim()
  if (normalized.length <= maxLength) return normalized
  return normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd() + '…'
}

function buildDiscordPresenceArgs(data: IActivity): Record<string, unknown> {
  return {
    details: clampPresenceText(data.details, 128),
    state: clampPresenceText(data.state, 128),
    startTimestamp:
      typeof data.timestamps?.start === 'number' ? data.timestamps.start : undefined,
    endTimestamp:
      typeof data.timestamps?.end === 'number' ? data.timestamps.end : undefined,
    largeImageKey: data.assets?.large_image,
    largeImageText: data.assets?.large_text,
    smallImageKey: data.assets?.small_image,
    smallImageText: data.assets?.small_text,
    instance: data.instance === true,
  }
}

function setActivityWithFallback(data: IActivity): void {
  if (!discord || !isReady) return

  const fullArgs = buildDiscordPresenceArgs(data)
  discord
    .setActivity(fullArgs)
    .catch((error: unknown) => {
      const argsWithoutAssets = {
        ...fullArgs,
        largeImageKey: undefined,
        largeImageText: undefined,
        smallImageKey: undefined,
        smallImageText: undefined,
      }
      console.warn(
        '[DiscordRPC] setActivity failed with assets. Retrying without assets.',
        error,
      )
      return discord?.setActivity(argsWithoutAssets)
    })
    .catch((error: unknown) => {
      console.error('[DiscordRPC] Failed to set activity:', error)
    })
}

function isValidDiscordClientId(value: string): boolean {
  return /^\d{17,20}$/.test(value)
}

function resolveClientId(
  candidate?: string,
): { value: string | null; source: 'settings' | 'env' | null } {
  const fromPayload = candidate?.trim() ?? ''
  if (fromPayload.length > 0 && isValidDiscordClientId(fromPayload)) {
    return { value: fromPayload, source: 'settings' }
  }

  const envCandidates = [
    readViteDiscordClientId(),
    process.env.MAIN_VITE_DISCORD_CLIENT_ID?.trim() ?? '',
    process.env.DISCORD_CLIENT_ID?.trim() ?? '',
    process.env.VITE_DISCORD_CLIENT_ID?.trim() ?? '',
  ]
  for (const envValue of envCandidates) {
    if (envValue.length > 0 && isValidDiscordClientId(envValue)) {
      return { value: envValue, source: 'env' }
    }
  }

  if (fromPayload.length > 0) {
    console.warn(
      `[DiscordRPC] Ignoring invalid Client ID from settings: "${fromPayload}". Expected Discord Application ID (numeric).`,
    )
  }

  return { value: null, source: null }
}

function scheduleLogin(delayMs: number): void {
  if (connectTimer) return
  connectTimer = setTimeout(() => {
    connectTimer = null
    loginRPC()
  }, delayMs)
}

function resetClient(reason: string): void {
  if (connectTimer) {
    clearTimeout(connectTimer)
    connectTimer = null
  }

  const current = discord
  discord = null
  isReady = false
  reconnectAttempts = 0

  if (!current) return

  current.removeAllListeners()
  current.destroy().catch((error: unknown) => {
    console.warn('[DiscordRPC] Failed to destroy RPC client:', error)
  })
  console.log(`[DiscordRPC] ${reason}`)
}

function init(clientId?: string) {
  const resolved = resolveClientId(clientId)
  if (!resolved.value) {
    console.warn(
      '[DiscordRPC] Client ID is not configured (or invalid). Use Discord Application ID (numeric) in settings or env.',
    )
    return
  }
  const resolvedClientId = resolved.value
  if (activeClientId !== resolvedClientId) {
    console.log(`[DiscordRPC] Using client ID from ${resolved.source}.`)
    if (discord) {
      resetClient('Client ID changed. Reconnecting RPC client.')
    }
    activeClientId = resolvedClientId
  }

  if (discord) {
    if (!isReady) scheduleLogin(0)
    return
  }

  discord = new Client({ transport: 'ipc' })

  discord.on('ready', () => {
    isReady = true
    reconnectAttempts = 0
    applyLastPayload()
  })

  discord.on('disconnected', () => {
    isReady = false
    scheduleLogin(1000)
  })

  discord.on('error', (error) => {
    console.error('[DiscordRPC] RPC client error:', error)
  })

  scheduleLogin(0)
}

function applyLastPayload(): void {
  if (!discord || !isReady) return
  if (!lastPayload) return

  if (lastPayload.activity === null) {
    discord.clearActivity().catch((error: unknown) => {
      console.error('[DiscordRPC] Failed to clear activity:', error)
    })
    return
  }

  setActivityWithFallback(lastPayload.activity)
}

function loginRPC() {
  if (!discord) return
  if (!activeClientId) return

  discord
    .login({ clientId: activeClientId })
    .catch((error) => {
      reconnectAttempts += 1
      console.error(
        `[DiscordRPC] Login failed (attempt ${reconnectAttempts}):`,
        error,
      )
      const nextDelay = Math.min(5000, 1000 + reconnectAttempts * 500)
      scheduleLogin(nextDelay)
    })
}

function set(data: IActivity | null) {
  if (data) {
    data.instance = true
    data.type = ActivityType.Listening
  }
  const payload = {
    pid: process.pid,
    activity: data,
  }
  lastPayload = payload
  if (!discord || !isReady) return

  if (data === null) {
    discord.clearActivity().catch((error: unknown) => {
      console.error('[DiscordRPC] Failed to clear activity:', error)
    })
    return
  }

  setActivityWithFallback(data)
}

export const RPC = {
  init,
  set,
}
