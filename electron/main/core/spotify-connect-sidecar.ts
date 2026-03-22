import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { app } from 'electron'
import {
  SpotifyConnectCommandResult,
  SpotifyConnectListDevicesResult,
  SpotifyConnectErrorPayload,
  SpotifyConnectEvent,
  SpotifyConnectInitializeRequest,
  SpotifyConnectInitializeResult,
  SpotifyConnectPlayUriRequest,
  SpotifyConnectSetActiveDeviceRequest,
  SpotifyConnectStatusResult,
} from '../../preload/types'

type SidecarCommand =
  | 'initialize'
  | 'startReceiver'
  | 'status'
  | 'listDevices'
  | 'setActiveDevice'
  | 'playUri'
  | 'dispose'

interface SidecarRequest {
  kind: 'request'
  id: string
  command: SidecarCommand
  params?: unknown
}

interface SidecarResponse {
  kind: 'response'
  id: string
  ok: boolean
  result?: unknown
  error?: SpotifyConnectErrorPayload
}

interface SidecarEventEnvelope {
  kind: 'event'
  event: SpotifyConnectEvent
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
  timeoutRef: NodeJS.Timeout
}

const SIDECAR_BINARY_NAME =
  process.platform === 'win32'
    ? 'aonsoku-spotify-connect-engine.exe'
    : 'aonsoku-spotify-connect-engine'

const SIDECAR_REQUEST_TIMEOUT_MS = 10000
const SIDECAR_INITIALIZE_REQUEST_TIMEOUT_MS = 15000
const SIDECAR_CONTROLLER_REQUEST_TIMEOUT_MS = 20000

function resolveCommandTimeoutMs(command: SidecarCommand): number {
  if (command === 'initialize') return SIDECAR_INITIALIZE_REQUEST_TIMEOUT_MS
  if (
    command === 'listDevices' ||
    command === 'setActiveDevice' ||
    command === 'playUri'
  ) {
    return SIDECAR_CONTROLLER_REQUEST_TIMEOUT_MS
  }

  return SIDECAR_REQUEST_TIMEOUT_MS
}

function toSpotifyConnectError(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): SpotifyConnectErrorPayload {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error
  ) {
    const maybeError = error as {
      code?: unknown
      message?: unknown
      details?: unknown
    }
    if (
      typeof maybeError.code === 'string' &&
      typeof maybeError.message === 'string'
    ) {
      return {
        code: maybeError.code,
        message: maybeError.message,
        details:
          typeof maybeError.details === 'object' && maybeError.details !== null
            ? (maybeError.details as Record<string, unknown>)
            : undefined,
      }
    }
  }

  return {
    code: fallbackCode,
    message: fallbackMessage,
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function resolveSidecarBinaryPath(): Promise<string | null> {
  const envPath = process.env.AONSOKU_SPOTIFY_CONNECT_SIDECAR_PATH
  if (envPath && (await fileExists(envPath))) {
    return envPath
  }

  const cwd = process.cwd()
  const appPath = app.getAppPath()

  const candidates = [
    join(
      cwd,
      'native',
      'spotify-connect-engine',
      'target',
      'debug',
      SIDECAR_BINARY_NAME,
    ),
    join(
      cwd,
      'native',
      'spotify-connect-engine',
      'target',
      'release',
      SIDECAR_BINARY_NAME,
    ),
    join(
      appPath,
      'native',
      'spotify-connect-engine',
      'target',
      'debug',
      SIDECAR_BINARY_NAME,
    ),
    join(
      appPath,
      'native',
      'spotify-connect-engine',
      'target',
      'release',
      SIDECAR_BINARY_NAME,
    ),
    join(
      process.resourcesPath,
      'resources',
      'spotify-connect-engine',
      SIDECAR_BINARY_NAME,
    ),
  ]

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate
    }
  }

  return null
}

class SpotifyConnectSidecarClient {
  private process: ChildProcessWithoutNullStreams | null = null
  private pendingRequests = new Map<string, PendingRequest>()
  private requestSequence = 0
  private startPromise: Promise<void> | null = null
  private eventListener: ((event: SpotifyConnectEvent) => void) | null = null

  setEventListener(
    listener: ((event: SpotifyConnectEvent) => void) | null,
  ): void {
    this.eventListener = listener
  }

  async initialize(
    payload?: SpotifyConnectInitializeRequest,
  ): Promise<SpotifyConnectInitializeResult> {
    try {
      const result = await this.sendCommand<SpotifyConnectInitializeResult>(
        'initialize',
        payload,
      )
      return result
    } catch (error) {
      const normalizedError = toSpotifyConnectError(
        error,
        'initialize-failed',
        'Failed to initialize spotify connect sidecar.',
      )
      return {
        ok: false,
        version: '0.0.0',
        engine: 'spotify-connect-sidecar',
        message: normalizedError.message,
        receiverRunning: false,
      }
    }
  }

  async startReceiver(): Promise<SpotifyConnectCommandResult> {
    return this.sendCommandResult('startReceiver')
  }

  async status(): Promise<SpotifyConnectStatusResult> {
    try {
      return await this.sendCommand<SpotifyConnectStatusResult>('status')
    } catch (error) {
      return {
        ok: false,
        initialized: false,
        receiverRunning: false,
        sessionConnected: false,
        isPlaying: false,
        currentTimeSeconds: 0,
        durationSeconds: 0,
        volume: 1,
        activeDeviceId: undefined,
        error: toSpotifyConnectError(
          error,
          'status-failed',
          'Failed to query spotify connect status.',
        ),
      }
    }
  }

  async listDevices(): Promise<SpotifyConnectListDevicesResult> {
    try {
      return await this.sendCommand<SpotifyConnectListDevicesResult>('listDevices')
    } catch (error) {
      return {
        ok: false,
        devices: [],
        error: toSpotifyConnectError(
          error,
          'list-devices-failed',
          'Failed to query spotify connect devices.',
        ),
      }
    }
  }

  async setActiveDevice(
    payload: SpotifyConnectSetActiveDeviceRequest,
  ): Promise<SpotifyConnectCommandResult> {
    return this.sendCommandResult('setActiveDevice', payload)
  }

  async playUri(payload: SpotifyConnectPlayUriRequest): Promise<SpotifyConnectCommandResult> {
    return this.sendCommandResult('playUri', payload)
  }

  async dispose(): Promise<SpotifyConnectCommandResult> {
    return this.sendCommandResult('dispose')
  }

  async shutdown(): Promise<void> {
    this.eventListener = null

    const activeProcess = this.process
    if (!activeProcess) return

    await this.sendCommandResult('dispose')

    if (!activeProcess.killed) {
      activeProcess.kill()
    }

    this.process = null
    this.rejectAllPending({
      code: 'sidecar-shutdown',
      message: 'Spotify connect sidecar was shut down.',
    })
  }

  private async sendCommandResult(
    command: SidecarCommand,
    params?: unknown,
  ): Promise<SpotifyConnectCommandResult> {
    try {
      const result = await this.sendCommand<SpotifyConnectCommandResult>(
        command,
        params,
      )
      if (result && typeof result.ok === 'boolean') {
        return result
      }
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        error: toSpotifyConnectError(
          error,
          'sidecar-command-failed',
          `Spotify connect sidecar command failed: ${command}`,
        ),
      }
    }
  }

  private async ensureStarted(): Promise<void> {
    if (this.process) return
    if (this.startPromise) return this.startPromise

    this.startPromise = (async () => {
      const sidecarPath = await resolveSidecarBinaryPath()
      if (!sidecarPath) {
        throw {
          code: 'sidecar-not-found',
          message:
            'Spotify connect sidecar binary was not found. Build native/spotify-connect-engine first.',
          details: {
            expectedBinaryName: SIDECAR_BINARY_NAME,
          },
        }
      }

      const sidecarProcess = spawn(sidecarPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.process = sidecarProcess

      const stdoutReader = createInterface({
        input: sidecarProcess.stdout,
        crlfDelay: Infinity,
      })
      stdoutReader.on('line', (line) => this.handleStdoutLine(line))

      const stderrReader = createInterface({
        input: sidecarProcess.stderr,
        crlfDelay: Infinity,
      })
      stderrReader.on('line', (line) => {
        console.error('[SpotifyConnectSidecar] stderr:', line)
      })

      sidecarProcess.on('error', (error) => {
        console.error('[SpotifyConnectSidecar] process error:', error)
        this.rejectAllPending({
          code: 'sidecar-process-error',
          message: 'Spotify connect sidecar process error.',
          details: { error: String(error) },
        })
      })

      sidecarProcess.on('exit', (code, signal) => {
        this.process = null
        this.rejectAllPending({
          code: 'sidecar-process-exit',
          message: 'Spotify connect sidecar process exited.',
          details: { code, signal },
        })
      })
    })()

    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  private rejectAllPending(error: SpotifyConnectErrorPayload): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutRef)
      pending.reject(error)
    }
    this.pendingRequests.clear()
  }

  private handleStdoutLine(line: string): void {
    if (!line || line.trim().length === 0) return

    let parsed: SidecarResponse | SidecarEventEnvelope
    try {
      parsed = JSON.parse(line) as SidecarResponse | SidecarEventEnvelope
    } catch {
      console.error('[SpotifyConnectSidecar] Invalid JSON line:', line)
      return
    }

    if (parsed.kind === 'event') {
      this.eventListener?.(parsed.event)
      return
    }

    if (parsed.kind !== 'response') return

    const pending = this.pendingRequests.get(parsed.id)
    if (!pending) return

    clearTimeout(pending.timeoutRef)
    this.pendingRequests.delete(parsed.id)

    if (!parsed.ok) {
      pending.reject(
        parsed.error ?? {
          code: 'sidecar-command-error',
          message: 'Sidecar command returned an error.',
        },
      )
      return
    }

    pending.resolve(parsed.result)
  }

  private async sendCommand<T>(
    command: SidecarCommand,
    params?: unknown,
  ): Promise<T> {
    await this.ensureStarted()
    if (!this.process) {
      throw {
        code: 'sidecar-not-running',
        message: 'Spotify connect sidecar process is not running.',
      }
    }

    const requestId = `${Date.now()}-${this.requestSequence++}`
    const payload: SidecarRequest = {
      kind: 'request',
      id: requestId,
      command,
      params,
    }

    const serialized = JSON.stringify(payload)
    const timeoutMs = resolveCommandTimeoutMs(command)

    return await new Promise<T>((resolve, reject) => {
      const timeoutRef = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject({
          code: 'sidecar-timeout',
          message: `Sidecar command timed out: ${command}`,
          details: {
            timeoutMs,
          },
        })
      }, timeoutMs)

      this.pendingRequests.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timeoutRef,
      })

      this.process?.stdin.write(`${serialized}\n`, (error) => {
        if (!error) return

        clearTimeout(timeoutRef)
        this.pendingRequests.delete(requestId)
        reject({
          code: 'sidecar-stdin-write-failed',
          message: 'Failed to send command to spotify connect sidecar.',
          details: {
            error: String(error),
            command,
          },
        })
      })
    })
  }
}

export const spotifyConnectSidecar = new SpotifyConnectSidecarClient()
