import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { app } from 'electron'
import {
  NativeAudioCommandResult,
  NativeAudioDeviceInfo,
  NativeAudioErrorPayload,
  NativeAudioEvent,
  NativeAudioInitializeResult,
  NativeAudioLoadRequest,
  NativeAudioOutputMode,
} from '../../preload/types'

type SidecarCommand =
  | 'initialize'
  | 'listDevices'
  | 'setOutputMode'
  | 'setRelayPcm'
  | 'load'
  | 'play'
  | 'pause'
  | 'seek'
  | 'setVolume'
  | 'setLoop'
  | 'setPlaybackRate'
  | 'dispose'

type RelayPcmMode = 'tap' | 'streamOnly'

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
  error?: NativeAudioErrorPayload
}

interface SidecarEventEnvelope {
  kind: 'event'
  event: NativeAudioEvent
}

interface PendingRequest {
  command: SidecarCommand
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
  timeoutRef: NodeJS.Timeout
}

const SIDECAR_BINARY_NAME =
  process.platform === 'win32'
    ? 'aonsoku-native-audio-engine.exe'
    : 'aonsoku-native-audio-engine'

const SIDECAR_REQUEST_TIMEOUT_MS = 10000
const SIDECAR_LOAD_REQUEST_TIMEOUT_MS = 30000
const SIDECAR_INITIALIZE_REQUEST_TIMEOUT_MS = 15000

function resolveCommandTimeoutMs(command: SidecarCommand): number {
  if (command === 'load') return SIDECAR_LOAD_REQUEST_TIMEOUT_MS
  if (command === 'initialize') return SIDECAR_INITIALIZE_REQUEST_TIMEOUT_MS

  return SIDECAR_REQUEST_TIMEOUT_MS
}

function toNativeCommandError(
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): NativeAudioErrorPayload {
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
  const envPath = process.env.AONSOKU_NATIVE_AUDIO_SIDECAR_PATH
  if (envPath && (await fileExists(envPath))) {
    return envPath
  }

  const cwd = process.cwd()
  const appPath = app.getAppPath()

  const candidates = [
    join(cwd, 'native', 'engine', 'target', 'debug', SIDECAR_BINARY_NAME),
    join(cwd, 'native', 'engine', 'target', 'release', SIDECAR_BINARY_NAME),
    join(appPath, 'native', 'engine', 'target', 'debug', SIDECAR_BINARY_NAME),
    join(appPath, 'native', 'engine', 'target', 'release', SIDECAR_BINARY_NAME),
    join(
      process.resourcesPath,
      'resources',
      'native-audio-engine',
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

class NativeAudioSidecarClient {
  private process: ChildProcessWithoutNullStreams | null = null
  private pendingRequests = new Map<string, PendingRequest>()
  private requestSequence = 0
  private startPromise: Promise<void> | null = null
  private eventListener: ((event: NativeAudioEvent) => void) | null = null

  setEventListener(listener: ((event: NativeAudioEvent) => void) | null): void {
    this.eventListener = listener
  }

  async initialize(): Promise<NativeAudioInitializeResult> {
    try {
      const result = await this.sendCommand<NativeAudioInitializeResult>(
        'initialize',
      )
      return result
    } catch (error) {
      const normalizedError = toNativeCommandError(
        error,
        'initialize-failed',
        'Failed to initialize native audio sidecar.',
      )
      return {
        ok: false,
        version: '0.0.0',
        engine: 'rust-sidecar',
        message: normalizedError.message,
      }
    }
  }

  async listDevices(): Promise<NativeAudioDeviceInfo[]> {
    try {
      const result = await this.sendCommand<NativeAudioDeviceInfo[]>(
        'listDevices',
      )
      return result
    } catch {
      return []
    }
  }

  async setOutputMode(mode: NativeAudioOutputMode): Promise<NativeAudioCommandResult> {
    return this.sendCommandResult('setOutputMode', { mode })
  }

  async setRelayPcm(
    enabled: boolean,
    mode: RelayPcmMode = 'tap',
  ): Promise<NativeAudioCommandResult> {
    return this.sendCommandResult('setRelayPcm', { enabled, mode })
  }

  async load(payload: NativeAudioLoadRequest): Promise<NativeAudioCommandResult> {
    return this.sendCommandResult('load', payload)
  }

  async play(): Promise<NativeAudioCommandResult> {
    return this.sendCommandResult('play')
  }

  async pause(): Promise<NativeAudioCommandResult> {
    return this.sendCommandResult('pause')
  }

  async seek(positionSeconds: number): Promise<NativeAudioCommandResult> {
    return this.sendCommandResult('seek', { positionSeconds })
  }

  async setVolume(volume: number): Promise<NativeAudioCommandResult> {
    return this.sendCommandResult('setVolume', { volume })
  }

  async setLoop(loop: boolean): Promise<NativeAudioCommandResult> {
    return this.sendCommandResult('setLoop', { loop })
  }

  async setPlaybackRate(playbackRate: number): Promise<NativeAudioCommandResult> {
    return this.sendCommandResult('setPlaybackRate', { playbackRate })
  }

  async dispose(): Promise<NativeAudioCommandResult> {
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
      message: 'Native audio sidecar was shut down.',
    })
  }

  private async sendCommandResult(
    command: SidecarCommand,
    params?: unknown,
  ): Promise<NativeAudioCommandResult> {
    try {
      const result = await this.sendCommand<NativeAudioCommandResult>(
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
        error: toNativeCommandError(
          error,
          'sidecar-command-failed',
          `Native audio sidecar command failed: ${command}`,
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
            'Rust sidecar binary was not found. Build native/engine first.',
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
        console.error('[NativeAudioSidecar] stderr:', line)
      })

      sidecarProcess.on('error', (error) => {
        console.error('[NativeAudioSidecar] process error:', error)
        this.rejectAllPending({
          code: 'sidecar-process-error',
          message: 'Native audio sidecar process error.',
          details: { error: String(error) },
        })
      })

      sidecarProcess.on('exit', (code, signal) => {
        this.process = null
        this.rejectAllPending({
          code: 'sidecar-process-exit',
          message: 'Native audio sidecar process exited.',
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

  private rejectAllPending(error: NativeAudioErrorPayload): void {
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
      console.error('[NativeAudioSidecar] Invalid JSON line:', line)
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
      console.error(
        '[NativeAudioSidecar] command failed:',
        `id=${parsed.id}`,
        `command=${pending.command}`,
        `code=${parsed.error?.code ?? 'sidecar-command-error'}`,
        `message=${parsed.error?.message ?? 'Sidecar command returned an error.'}`,
      )
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
        message: 'Native audio sidecar process is not running.',
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
        command,
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
          message: 'Failed to send command to native audio sidecar.',
          details: {
            error: String(error),
            command,
          },
        })
      })
    })
  }
}

export const nativeAudioSidecar = new NativeAudioSidecarClient()
