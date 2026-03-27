import { type ChildProcess, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import type { Socket } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import {
  IpcChannels,
  NativeAudioEvent,
  RemotePlaybackDevice,
  RemotePlaybackTarget,
  RemoteRelayCommandPayload,
  RemoteRelayLifecycleEvent,
  RemoteRelayStateUpdatePayload,
} from '../../preload/types'
import { nativeAudioSidecar } from './native-audio-sidecar'
import {
  getRemoteRelaySettings,
  type RemoteRelayLastStatus,
  type RemoteRelayStreamProfile,
  type RemoteRelayTunnelStatus,
  saveRemoteRelayLastStatus,
} from './settings'

interface RemoteRelayClaimSession {
  leaseId: string
  clientName: string
  lastHeartbeatMs: number
}

interface RemoteRelayStatusResult {
  enabled: boolean
  localPort: number
  localUrl: string
  tunnelRunning: boolean
  tunnelStatus: RemoteRelayTunnelStatus
  tunnelMessage: string
  remoteSessionActive: boolean
  defaultProfile: RemoteRelayStreamProfile
  streamProfile: RemoteRelayStreamProfile
  cloudflaredPath: string
  tunnelArgs: string
}

const SESSION_TIMEOUT_MS = 15_000
const HEARTBEAT_INTERVAL_MS = 5_000
const STREAM_FILE_WAIT_MS = 4_000
const STREAM_FILE_POLL_MS = 100
const WS_AUDIO_PATH = '/ws/audio'
const WS_AUDIO_SAMPLE_RATE = 48_000
const WS_AUDIO_CHANNELS = 2
const WS_MAX_WRITABLE_BYTES = 512_000
const NATIVE_PCM_CHUNK_GRACE_MS = 2_500
const NATIVE_PCM_CHUNK_STALE_MS = 1_500
const FFMPEG_LOG_PREFIX = '[RemoteRelay][ffmpeg]'
const TUNNEL_LOG_PREFIX = '[RemoteRelay][cloudflared]'

const DEFAULT_STATE: RemoteRelayStateUpdatePayload = {
  mediaType: 'song',
  source: 'unsupported',
  src: undefined,
  isPlaying: false,
  currentTimeSeconds: 0,
  durationSeconds: 0,
  volume: 0,
  hasPrev: false,
  hasNext: false,
  nowPlaying: undefined,
}

const DEFAULT_PLAYBACK_TARGET: RemotePlaybackTarget = 'desktop'

const REMOTE_PLAYBACK_DEVICE_TEMPLATES: Omit<
  RemotePlaybackDevice,
  'selected'
>[] = [
  {
    id: 'desktop',
    name: 'このPC',
    description: 'ローカル再生（HQ SRC）',
  },
  {
    id: 'mobile',
    name: 'このスマホ',
    description: 'リモート配信（HQ SRC WS）',
  },
]

function nowMs(): number {
  return Date.now()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function toWebSocketAcceptValue(key: string): string {
  return createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, 'utf8')
    .digest('base64')
}

function encodeWsFrame(
  payload: Buffer,
  opcode: 0x1 | 0x2 | 0x8 | 0x9 | 0xa = 0x2,
): Buffer {
  const payloadLength = payload.length
  const header: number[] = [0x80 | opcode]

  if (payloadLength < 126) {
    header.push(payloadLength)
  } else if (payloadLength < 65_536) {
    header.push(126, (payloadLength >> 8) & 0xff, payloadLength & 0xff)
  } else {
    const lengthBigInt = BigInt(payloadLength)
    header.push(127)
    for (let shift = 56n; shift >= 0n; shift -= 8n) {
      header.push(Number((lengthBigInt >> shift) & 0xffn))
    }
  }

  return Buffer.concat([Buffer.from(header), payload])
}

function writeWsText(socket: Socket, message: string): void {
  socket.write(encodeWsFrame(Buffer.from(message, 'utf8'), 0x1))
}

function writeWsBinary(socket: Socket, payload: Buffer): void {
  socket.write(encodeWsFrame(payload, 0x2))
}

function tryHandleClientWsControlFrames(socket: Socket, chunk: Buffer): void {
  let offset = 0
  while (offset + 2 <= chunk.length) {
    const first = chunk[offset]
    const second = chunk[offset + 1]
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let cursor = offset + 2

    if (length === 126) {
      if (cursor + 2 > chunk.length) break
      length = chunk.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127) {
      if (cursor + 8 > chunk.length) break
      const bigLen = chunk.readBigUInt64BE(cursor)
      if (bigLen > BigInt(Number.MAX_SAFE_INTEGER)) break
      length = Number(bigLen)
      cursor += 8
    }

    const maskBytesLength = masked ? 4 : 0
    const frameSize = cursor + maskBytesLength + length - offset
    if (offset + frameSize > chunk.length) break

    if (opcode === 0x8) {
      socket.end()
      return
    }

    if (opcode === 0x9) {
      const mask = masked ? chunk.subarray(cursor, cursor + 4) : null
      const payloadStart = cursor + maskBytesLength
      const payloadEnd = payloadStart + length
      const payload = Buffer.from(chunk.subarray(payloadStart, payloadEnd))
      if (mask) {
        for (let i = 0; i < payload.length; i += 1) {
          payload[i] ^= mask[i % 4]
        }
      }
      socket.write(encodeWsFrame(payload, 0xa))
    }

    offset += frameSize
  }
}

function toBoundedPort(value: number, fallback: number): number {
  const rounded = Math.trunc(value)
  if (rounded < 1 || rounded > 65535) return fallback
  return rounded
}

function splitCommandLine(input: string): string[] {
  const trimmed = input.trim()
  if (trimmed.length === 0) return []

  const args: string[] = []
  const matcher = /"([^"]*)"|'([^']*)'|([^\s]+)/g

  let match: RegExpExecArray | null
  while ((match = matcher.exec(trimmed)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3] ?? '')
  }

  return args
}

function formatSampleRateKhz(rateHz: number): string {
  const khz = rateHz / 1000
  const value =
    Math.abs(khz - Math.round(khz)) < 0.0001
      ? String(Math.round(khz))
      : khz.toFixed(1)
  return `${value}kHz`
}

function resolveCodecFromSrc(src: string | undefined): string {
  const normalized = (src ?? '').toLowerCase()
  if (normalized.includes('.flac') || normalized.includes('format=flac'))
    return 'FLAC'
  if (
    normalized.includes('.m4a') ||
    normalized.includes('.alac') ||
    normalized.includes('format=alac')
  ) {
    return 'ALAC'
  }
  if (normalized.includes('.aac') || normalized.includes('format=aac'))
    return 'AAC'
  if (normalized.includes('.mp3') || normalized.includes('format=mp3'))
    return 'MP3'
  if (normalized.includes('.wav') || normalized.includes('format=wav'))
    return 'WAV'
  return 'PCM'
}

function ffmpegBinaryPath(): string {
  const envPath = process.env.AONSOKU_FFMPEG_PATH?.trim()
  if (envPath && fs.existsSync(envPath)) return envPath

  const binaryName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const candidates = [
    path.join(process.cwd(), 'resources', 'bin', binaryName),
    path.join(process.resourcesPath, 'resources', 'bin', binaryName),
    path.join(process.resourcesPath, 'bin', binaryName),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }

  return binaryName
}

function toFfmpegFileTarget(filePath: string): string {
  if (process.platform !== 'win32') {
    return filePath
  }

  const normalized = filePath.replace(/\\/g, '/')
  if (/^[A-Za-z]:\//.test(normalized)) {
    return `file:${normalized}`
  }

  return normalized
}

function getRemoteWebDistSearchCandidates(): string[] {
  const candidates = new Set<string>()
  candidates.add(path.join(__dirname, 'remote-web-dist'))

  const cwd = process.cwd()
  if (cwd) {
    candidates.add(
      path.join(cwd, 'electron', 'main', 'core', 'remote-web-dist'),
    )
    candidates.add(path.join(cwd, 'out', 'main', 'remote-web-dist'))
  }

  try {
    const appPath = app.getAppPath()
    if (appPath) {
      candidates.add(
        path.join(appPath, 'electron', 'main', 'core', 'remote-web-dist'),
      )
      candidates.add(path.join(appPath, 'out', 'main', 'remote-web-dist'))
    }
  } catch {
    // app path may be unavailable during very early bootstrap
  }

  return Array.from(candidates)
}

function resolveRemoteWebDistPath(): string | null {
  const candidates = getRemoteWebDistSearchCandidates()
  for (const candidate of candidates) {
    const indexPath = path.join(candidate, 'index.html')
    if (fs.existsSync(indexPath)) {
      return candidate
    }
  }
  return null
}

function decodeSourcePath(source: string): string {
  if (!source.startsWith('file://')) return source

  try {
    const parsed = new URL(source)
    return decodeURIComponent(parsed.pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  } catch {
    return source
  }
}

function createLeaseId(): string {
  return randomBytes(18).toString('base64url')
}

function createLastStatus(
  tunnelStatus: RemoteRelayTunnelStatus,
  message: string,
): RemoteRelayLastStatus {
  return {
    tunnelStatus,
    message,
    updatedAtMs: nowMs(),
  }
}

function isRemoteRelayCommandType(
  value: unknown,
): value is RemoteRelayCommandPayload['command'] {
  return (
    value === 'playPause' ||
    value === 'prev' ||
    value === 'next' ||
    value === 'seek' ||
    value === 'setVolume' ||
    value === 'playAlbum' ||
    value === 'playSong' ||
    value === 'setPlaybackTarget'
  )
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []

  await new Promise<void>((resolve, reject) => {
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    request.on('end', () => resolve())
    request.on('error', reject)
  })

  if (chunks.length === 0) return {}
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim().length === 0) return {}

  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('invalid-json')
  }
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

class RelayHlsPipeline {
  private process: ChildProcess | null = null
  private profile: RemoteRelayStreamProfile | null = null
  private source: string | null = null
  private outputRoot = path.join(os.tmpdir(), 'minato-remote-relay-hls')
  private lastError = ''

  async ensureStreaming(
    profile: RemoteRelayStreamProfile,
    source: string,
    startAtSeconds: number,
  ): Promise<void> {
    const normalizedSource = decodeSourcePath(source)
    if (
      this.process &&
      this.profile === profile &&
      this.source === normalizedSource
    ) {
      return
    }

    await this.stop()
    await this.start(profile, normalizedSource, startAtSeconds)
  }

  getPlaylistPath(profile: RemoteRelayStreamProfile): string {
    return path.join(this.outputRoot, profile, 'index.m3u8')
  }

  getSegmentPath(
    profile: RemoteRelayStreamProfile,
    segmentName: string,
  ): string {
    return path.join(this.outputRoot, profile, segmentName)
  }

  getErrorMessage(): string {
    return this.lastError
  }

  async stop(): Promise<void> {
    const active = this.process
    this.process = null
    this.profile = null
    this.source = null

    if (active && !active.killed) {
      active.kill()
    }
  }

  private async start(
    profile: RemoteRelayStreamProfile,
    source: string,
    startAtSeconds: number,
  ): Promise<void> {
    const targetDir = path.join(this.outputRoot, profile)
    await fsp.rm(targetDir, { recursive: true, force: true })
    await fsp.mkdir(targetDir, { recursive: true })

    const playlistPath = this.getPlaylistPath(profile)
    const segmentPattern = path.join(targetDir, `${profile}-%06d.m4s`)
    const ffmpegPlaylistPath = toFfmpegFileTarget(playlistPath)
    const ffmpeg = ffmpegBinaryPath()
    const safeStartAt = Math.max(0, startAtSeconds)

    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      ...(safeStartAt > 0 ? ['-ss', safeStartAt.toFixed(3)] : []),
      '-i',
      source,
      '-vn',
      '-map',
      '0:a:0',
      '-ac',
      '2',
      ...(profile === 'alac'
        ? ['-c:a', 'alac']
        : ['-c:a', 'aac', '-b:a', '256k']),
      '-f',
      'hls',
      '-hls_time',
      '1',
      '-hls_list_size',
      '6',
      '-hls_flags',
      'delete_segments+append_list+omit_endlist+independent_segments+program_date_time',
      '-hls_segment_type',
      'fmp4',
      '-hls_fmp4_init_filename',
      `${profile}-init.mp4`,
      '-hls_segment_filename',
      segmentPattern,
      ffmpegPlaylistPath,
    ]

    this.lastError = ''
    const processRef = spawn(ffmpeg, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    this.process = processRef
    this.profile = profile
    this.source = source

    processRef.stderr?.on('data', (chunk: Buffer) => {
      const message = chunk.toString('utf8').trim()
      if (message.length === 0) return
      this.lastError = message
      console.warn(FFMPEG_LOG_PREFIX, message)
    })

    processRef.on('exit', (code, signal) => {
      if (this.process !== processRef) return
      this.process = null
      this.profile = null
      this.source = null
      if (code !== 0 && signal !== 'SIGTERM') {
        this.lastError = `ffmpeg exited unexpectedly (code=${code}, signal=${signal})`
      }
    })

    processRef.on('error', (error) => {
      if (this.process !== processRef) return
      this.lastError = `Failed to start ffmpeg: ${String(error)}`
      this.process = null
      this.profile = null
      this.source = null
    })
  }
}

class RelayPcmPipeline {
  private process: ChildProcess | null = null
  private source: string | null = null
  private lastError = ''
  private onChunk: ((chunk: Buffer) => void) | null = null

  setChunkHandler(handler: ((chunk: Buffer) => void) | null): void {
    this.onChunk = handler
  }

  isActive(): boolean {
    return this.process !== null
  }

  async ensureStreaming(source: string, startAtSeconds: number): Promise<void> {
    const normalizedSource = decodeSourcePath(source)
    if (this.process && this.source === normalizedSource) {
      return
    }

    await this.stop()
    await this.start(normalizedSource, startAtSeconds)
  }

  getErrorMessage(): string {
    return this.lastError
  }

  async stop(): Promise<void> {
    const active = this.process
    this.process = null
    this.source = null

    if (active && !active.killed) {
      active.kill()
    }
  }

  private async start(source: string, startAtSeconds: number): Promise<void> {
    const ffmpeg = ffmpegBinaryPath()
    const safeStartAt = Math.max(0, startAtSeconds)

    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-re',
      ...(safeStartAt > 0 ? ['-ss', safeStartAt.toFixed(3)] : []),
      '-i',
      source,
      '-vn',
      '-map',
      '0:a:0',
      '-ac',
      String(WS_AUDIO_CHANNELS),
      '-ar',
      String(WS_AUDIO_SAMPLE_RATE),
      '-f',
      's16le',
      'pipe:1',
    ]

    this.lastError = ''
    const processRef = spawn(ffmpeg, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.process = processRef
    this.source = source

    processRef.stdout?.on('data', (chunk: Buffer) => {
      if (!this.onChunk || chunk.length === 0) return
      this.onChunk(Buffer.from(chunk))
    })

    processRef.stderr?.on('data', (chunk: Buffer) => {
      const message = chunk.toString('utf8').trim()
      if (message.length === 0) return
      this.lastError = message
      console.warn(`${FFMPEG_LOG_PREFIX}[pcm-fallback]`, message)
    })

    processRef.on('exit', (code, signal) => {
      if (this.process !== processRef) return
      this.process = null
      this.source = null
      if (code !== 0 && signal !== 'SIGTERM') {
        this.lastError = `ffmpeg(pcm-fallback) exited unexpectedly (code=${code}, signal=${signal})`
      }
    })

    processRef.on('error', (error) => {
      if (this.process !== processRef) return
      this.lastError = `Failed to start ffmpeg(pcm-fallback): ${String(error)}`
      this.process = null
      this.source = null
    })
  }
}

interface RelayWsClient {
  socket: Socket
  leaseId: string
}

interface PendingRendererLibraryRequest {
  channel: string
  resolve: (value: unknown) => void
  timeout: NodeJS.Timeout
}

class RemoteRelayManager {
  private window: BrowserWindow | null = null
  private server: Server | null = null
  private sseClients = new Set<ServerResponse>()
  private wsClients = new Set<RelayWsClient>()
  private claimSession: RemoteRelayClaimSession | null = null
  private sessionPlaybackTarget: RemotePlaybackTarget | null = null
  private sessionExpiryTimer: NodeJS.Timeout
  private latestState: RemoteRelayStateUpdatePayload = DEFAULT_STATE
  private hlsPipeline = new RelayHlsPipeline()
  private fallbackPcmPipeline = new RelayPcmPipeline()
  private streamProfile: RemoteRelayStreamProfile =
    getRemoteRelaySettings().defaultProfile
  private relayPcmEnabled = false
  private nativeRelayPcmCommandUnsupported = false
  private relayPcmEnabledAtMs = 0
  private lastNativePcmChunkAtMs = 0
  private relayPcmFormat: {
    sampleRate: number
    channels: number
    sampleFormat: 's16le'
  } = {
    sampleRate: WS_AUDIO_SAMPLE_RATE,
    channels: WS_AUDIO_CHANNELS,
    sampleFormat: 's16le',
  }
  private tunnelProcess: ChildProcess | null = null
  private tunnelStatus: RemoteRelayTunnelStatus =
    getRemoteRelaySettings().lastStatus.tunnelStatus
  private tunnelMessage = getRemoteRelaySettings().lastStatus.message
  private serverPort: number | null = null
  private pendingRendererLibraryRequests = new Map<
    string,
    PendingRendererLibraryRequest
  >()
  private readonly rendererLibraryResponseHandler = (
    _: unknown,
    response: { requestId?: string; data?: unknown } | null,
  ): void => {
    const requestId =
      typeof response?.requestId === 'string' ? response.requestId : ''
    if (requestId.length === 0) return

    const pending = this.pendingRendererLibraryRequests.get(requestId)
    if (!pending) return

    clearTimeout(pending.timeout)
    this.pendingRendererLibraryRequests.delete(requestId)
    console.log(
      `[RemoteRelay] <- renderer response channel=${pending.channel} requestId=${requestId}`,
    )
    pending.resolve(response?.data ?? null)
  }

  constructor() {
    this.fallbackPcmPipeline.setChunkHandler((chunk) => {
      this.broadcastAudioChunk(chunk)
    })
    this.ensureRendererLibraryResponseListener()

    this.sessionExpiryTimer = setInterval(() => {
      this.evictExpiredSession()
    }, 1000)
  }

  setWindow(window: BrowserWindow | null): void {
    this.window = window
    this.ensureRendererLibraryResponseListener()
  }

  handleNativeAudioEvent(event: NativeAudioEvent): void {
    if (event.type === 'relayPcmFormat') {
      const sampleRate =
        typeof event.sampleRateHz === 'number' &&
        Number.isFinite(event.sampleRateHz)
          ? Math.max(8_000, Math.trunc(event.sampleRateHz))
          : WS_AUDIO_SAMPLE_RATE
      const channels =
        typeof event.channels === 'number' && Number.isFinite(event.channels)
          ? Math.max(1, Math.trunc(event.channels))
          : WS_AUDIO_CHANNELS
      this.relayPcmFormat = {
        sampleRate,
        channels,
        sampleFormat: 's16le',
      }

      const formatPayload = JSON.stringify({
        type: 'format',
        sampleRate,
        channels,
        sampleFormat: 's16le',
      })
      for (const client of this.wsClients) {
        if (!this.assertLeaseValid(client.leaseId) || client.socket.destroyed)
          continue
        writeWsText(client.socket, formatPayload)
      }
      return
    }

    if (event.type !== 'relayPcmChunk') return
    if (typeof event.pcmBase64 !== 'string' || event.pcmBase64.length === 0)
      return

    try {
      const chunk = Buffer.from(event.pcmBase64, 'base64')
      if (chunk.length === 0) return
      this.lastNativePcmChunkAtMs = nowMs()
      if (this.fallbackPcmPipeline.isActive()) {
        this.fallbackPcmPipeline.stop().catch((error) => {
          console.warn(
            '[RemoteRelay] Failed to stop PCM fallback after native chunk:',
            error,
          )
        })
      }
      this.broadcastAudioChunk(chunk)
    } catch {
      // invalid base64 payload is ignored
    }
  }

  handleRendererStateUpdate(payload: RemoteRelayStateUpdatePayload): void {
    this.latestState = {
      ...payload,
      signalPath: this.buildSignalPath(payload),
    }
    this.broadcastEvent('state', this.buildStateResponse())
    this.ensurePcmSync().catch((error) => {
      console.warn('[RemoteRelay] Failed to sync stream state:', error)
    })
  }

  getStatus(): RemoteRelayStatusResult {
    const settings = getRemoteRelaySettings()
    const localPort = toBoundedPort(settings.localPort, 39096)

    return {
      enabled: settings.enabled,
      localPort,
      localUrl: `http://127.0.0.1:${localPort}`,
      tunnelRunning: Boolean(this.tunnelProcess),
      tunnelStatus: this.tunnelStatus,
      tunnelMessage: this.tunnelMessage,
      remoteSessionActive: this.isSessionActive(),
      defaultProfile: settings.defaultProfile,
      streamProfile: this.streamProfile,
      cloudflaredPath: settings.cloudflaredPath,
      tunnelArgs: settings.tunnelArgs,
    }
  }

  async startTunnel(): Promise<{ ok: boolean; message: string }> {
    const settings = getRemoteRelaySettings()
    if (!settings.enabled) {
      return {
        ok: false,
        message:
          'Remote relay is disabled. Enable it in Desktop settings first.',
      }
    }

    const localPort = toBoundedPort(settings.localPort, 39096)
    if (this.tunnelProcess) {
      return {
        ok: true,
        message: 'Cloudflare Tunnel is already running.',
      }
    }

    const cloudflaredPath = settings.cloudflaredPath.trim()
    if (cloudflaredPath.length === 0) {
      return {
        ok: false,
        message: 'cloudflared path is empty. Configure Desktop settings first.',
      }
    }

    if (!fs.existsSync(cloudflaredPath)) {
      return {
        ok: false,
        message: `cloudflared binary was not found: ${cloudflaredPath}`,
      }
    }

    const args = splitCommandLine(settings.tunnelArgs)
    if (args.length === 0) {
      return {
        ok: false,
        message:
          'Tunnel args are empty. Example: tunnel --url http://127.0.0.1:39096 run <name>',
      }
    }

    try {
      await this.ensureServerStarted(localPort)
      this.setTunnelStatus('starting', 'Starting cloudflared tunnel...')
      const processRef = spawn(cloudflaredPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.tunnelProcess = processRef

      processRef.stdout?.on('data', (chunk: Buffer) => {
        const line = chunk.toString('utf8').trim()
        if (line.length === 0) return
        console.log(TUNNEL_LOG_PREFIX, line)
      })

      processRef.stderr?.on('data', (chunk: Buffer) => {
        const line = chunk.toString('utf8').trim()
        if (line.length === 0) return
        console.warn(TUNNEL_LOG_PREFIX, line)
      })

      processRef.on('error', (error) => {
        if (this.tunnelProcess !== processRef) return
        this.tunnelProcess = null
        this.setTunnelStatus('error', `cloudflared failed: ${String(error)}`)
      })

      processRef.on('exit', (code, signal) => {
        if (this.tunnelProcess !== processRef) return
        this.tunnelProcess = null
        if (code === 0 || signal === 'SIGTERM') {
          this.setTunnelStatus('stopped', 'Cloudflare Tunnel stopped.')
        } else {
          this.setTunnelStatus(
            'error',
            `cloudflared exited unexpectedly (code=${code}, signal=${signal})`,
          )
        }
      })

      this.setTunnelStatus(
        'running',
        `Cloudflare Tunnel is running on local port ${localPort}.`,
      )
      return {
        ok: true,
        message: 'Cloudflare Tunnel started.',
      }
    } catch (error) {
      this.tunnelProcess = null
      this.setTunnelStatus(
        'error',
        `Failed to start cloudflared: ${String(error)}`,
      )
      return {
        ok: false,
        message: `Failed to start cloudflared: ${String(error)}`,
      }
    }
  }

  async stopTunnel(): Promise<{ ok: boolean; message: string }> {
    const hadTunnel = Boolean(this.tunnelProcess)
    if (this.tunnelProcess && !this.tunnelProcess.killed) {
      this.tunnelProcess.kill()
    }
    this.tunnelProcess = null

    await this.stopServer()
    this.setTunnelStatus('stopped', 'Cloudflare Tunnel stopped.')
    return {
      ok: true,
      message: hadTunnel
        ? 'Cloudflare Tunnel stopped.'
        : 'Remote relay server stopped.',
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.sessionExpiryTimer)
    this.clearPendingRendererLibraryRequests()
    ipcMain.removeListener(
      IpcChannels.RemoteLibraryResponse,
      this.rendererLibraryResponseHandler,
    )
    await this.stopTunnel()
  }

  private ensureRendererLibraryResponseListener(): void {
    const listeners = ipcMain.listeners(IpcChannels.RemoteLibraryResponse)
    const alreadyAttached = listeners.includes(
      this.rendererLibraryResponseHandler as (...args: unknown[]) => void,
    )
    if (alreadyAttached) return

    ipcMain.on(
      IpcChannels.RemoteLibraryResponse,
      this.rendererLibraryResponseHandler,
    )
    console.log('[RemoteRelay] Attached renderer library response listener')
  }

  private clearPendingRendererLibraryRequests(): void {
    for (const pending of this.pendingRendererLibraryRequests.values()) {
      clearTimeout(pending.timeout)
      pending.resolve(null)
    }
    this.pendingRendererLibraryRequests.clear()
  }

  private setTunnelStatus(
    status: RemoteRelayTunnelStatus,
    message: string,
  ): void {
    this.tunnelStatus = status
    this.tunnelMessage = message
    saveRemoteRelayLastStatus(createLastStatus(status, message))
    this.broadcastEvent('status', this.getStatus())
  }

  private isSessionActive(): boolean {
    return this.claimSession !== null
  }

  private evictExpiredSession(): void {
    if (!this.claimSession) return

    const elapsed = nowMs() - this.claimSession.lastHeartbeatMs
    if (elapsed <= SESSION_TIMEOUT_MS) return

    this.releaseSession('lease-timeout').catch((error) => {
      console.warn('[RemoteRelay] Failed to release timed-out session:', error)
    })
  }

  private async ensureServerStarted(port: number): Promise<void> {
    if (this.server && this.serverPort === port) return

    if (this.server) {
      await this.stopServer()
    }

    this.streamProfile = getRemoteRelaySettings().defaultProfile
    this.server = createServer((request, response) => {
      this.handleHttpRequest(request, response).catch((error) => {
        console.warn('[RemoteRelay] HTTP handler error:', error)
        if (!response.headersSent) {
          sendJson(response, 500, {
            ok: false,
            message: 'remote-relay-internal-error',
          })
        } else {
          response.end()
        }
      })
    })
    this.server.on('upgrade', (request, socket, head) => {
      this.handleWsUpgrade(request, socket, head).catch((error) => {
        console.warn('[RemoteRelay] WS upgrade error:', error)
        try {
          socket.write(
            'HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n',
          )
        } catch {
          // noop
        }
        socket.destroy()
      })
    })

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(port, '127.0.0.1', () => {
        this.server?.removeListener('error', reject)
        resolve()
      })
    })

    this.serverPort = port
  }

  private async stopServer(): Promise<void> {
    await this.releaseSession('server-stopped')
    await this.ensurePcmSync(true)
    await this.hlsPipeline.stop()

    for (const client of this.sseClients) {
      try {
        client.end()
      } catch {
        // noop
      }
    }
    this.sseClients.clear()

    for (const client of this.wsClients) {
      try {
        client.socket.end()
      } catch {
        // noop
      }
    }
    this.wsClients.clear()

    const activeServer = this.server
    this.server = null
    this.serverPort = null

    if (activeServer) {
      await new Promise<void>((resolve) => {
        activeServer.close(() => resolve())
      })
    }
  }

  private async handleHttpRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const host = request.headers.host ?? '127.0.0.1'
    const parsedUrl = new URL(request.url ?? '/', `http://${host}`)
    const pathname = parsedUrl.pathname
    const method = (request.method ?? 'GET').toUpperCase()

    if (method === 'GET' && pathname === '/') {
      await this.serveRemoteWebApp(response)
      return
    }

    // Serve static assets from remote-web-dist
    if (method === 'GET' && pathname.startsWith('/assets/')) {
      await this.serveStaticFile(pathname, response)
      return
    }

    if (method === 'GET' && pathname === '/healthz') {
      sendJson(response, 200, {
        ok: true,
        status: this.getStatus(),
      })
      return
    }

    if (method === 'POST' && pathname === '/api/remote/session/claim') {
      await this.handleClaimSession(request, response)
      return
    }

    if (method === 'POST' && pathname === '/api/remote/session/heartbeat') {
      await this.handleHeartbeat(request, response)
      return
    }

    if (method === 'DELETE' && pathname === '/api/remote/session/release') {
      await this.handleReleaseSession(request, response)
      return
    }

    if (method === 'GET' && pathname === '/api/remote/state') {
      sendJson(response, 200, this.buildStateResponse())
      return
    }

    if (method === 'GET' && pathname === '/api/remote/events') {
      const leaseId = this.extractLeaseIdFromQuery(request)
      if (!this.assertLeaseValid(leaseId)) {
        sendJson(response, 403, {
          ok: false,
          message: 'invalid-session',
        })
        return
      }
      this.handleSseConnect(response)
      return
    }

    if (method === 'POST' && pathname === '/api/remote/commands') {
      await this.handleCommand(request, response)
      return
    }

    if (method === 'POST' && pathname === '/api/remote/stream/profile') {
      await this.handleProfileChange(request, response)
      return
    }

    if (method === 'GET' && pathname.startsWith('/stream/')) {
      await this.handleStreamFile(pathname, response)
      return
    }

    // Library API endpoints
    if (method === 'GET' && pathname === '/api/remote/library/genres') {
      await this.handleLibraryGenres(request, response)
      return
    }

    if (method === 'GET' && pathname === '/api/remote/library/artists') {
      await this.handleLibraryArtists(request, response)
      return
    }

    if (method === 'GET' && pathname === '/api/remote/library/albums') {
      await this.handleLibraryAlbums(request, response)
      return
    }

    if (method === 'GET' && pathname === '/api/remote/library/songs') {
      await this.handleLibrarySongs(request, response)
      return
    }

    if (method === 'GET' && pathname === '/api/remote/library/search') {
      await this.handleLibrarySearch(request, response)
      return
    }

    if (method === 'GET' && pathname === '/api/remote/cover') {
      await this.handleCoverArt(request, response)
      return
    }

    sendJson(response, 404, {
      ok: false,
      message: 'not-found',
    })
  }

  private buildStateResponse(): Record<string, unknown> {
    const playbackTarget = this.getPlaybackTarget()
    const playbackDevices = this.buildPlaybackDevices(playbackTarget)
    const canStream = this.canStreamCurrentState(playbackTarget)
    const state = {
      ...this.latestState,
      playbackTarget,
      playbackDevices,
      canStream,
    }

    return {
      ok: true,
      state,
      streamProfile: this.streamProfile,
      remoteSessionActive: this.isSessionActive(),
      canStream,
      playbackTarget,
      playbackDevices,
    }
  }

  private getPlaybackTarget(): RemotePlaybackTarget {
    return this.sessionPlaybackTarget ?? DEFAULT_PLAYBACK_TARGET
  }

  private buildPlaybackDevices(
    playbackTarget: RemotePlaybackTarget,
  ): RemotePlaybackDevice[] {
    return REMOTE_PLAYBACK_DEVICE_TEMPLATES.map((device) => ({
      ...device,
      selected: device.id === playbackTarget,
    }))
  }

  private canStreamCurrentState(
    playbackTarget: RemotePlaybackTarget = this.getPlaybackTarget(),
  ): boolean {
    return (
      playbackTarget === 'mobile' &&
      Boolean(this.claimSession) &&
      this.latestState.isPlaying === true &&
      this.latestState.mediaType === 'song' &&
      (this.latestState.source === 'local' ||
        this.latestState.source === 'navidrome') &&
      typeof this.latestState.src === 'string' &&
      this.latestState.src.trim().length > 0
    )
  }

  private buildSignalPath(
    nextState: RemoteRelayStateUpdatePayload,
  ): string | undefined {
    if (nextState.mediaType !== 'song') return undefined

    const codec =
      typeof nextState.sourceCodec === 'string' &&
      nextState.sourceCodec.trim().length > 0
        ? nextState.sourceCodec.trim().toUpperCase()
        : resolveCodecFromSrc(nextState.src)

    const sourceRateHz =
      typeof nextState.sourceSampleRateHz === 'number' &&
      Number.isFinite(nextState.sourceSampleRateHz) &&
      nextState.sourceSampleRateHz > 0
        ? Math.trunc(nextState.sourceSampleRateHz)
        : undefined

    const targetRateHz =
      typeof nextState.targetSampleRateHz === 'number' &&
      Number.isFinite(nextState.targetSampleRateHz) &&
      nextState.targetSampleRateHz > 0
        ? Math.trunc(nextState.targetSampleRateHz)
        : sourceRateHz

    const filterLabel =
      typeof nextState.oversamplingFilterId === 'string' &&
      nextState.oversamplingFilterId.trim().length > 0
        ? nextState.oversamplingFilterId.trim()
        : 'bypass'

    if (sourceRateHz && targetRateHz) {
      return `${codec}, ${formatSampleRateKhz(sourceRateHz)}→${formatSampleRateKhz(targetRateHz)}, ${filterLabel}`
    }

    if (typeof nextState.signalPath === 'string' && nextState.signalPath.trim()) {
      return nextState.signalPath.trim()
    }

    return `${codec}, ${filterLabel}`
  }

  private handleSseConnect(response: ServerResponse): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    this.sseClients.add(response)
    this.writeSseEvent(response, 'state', this.buildStateResponse())
    this.writeSseEvent(response, 'status', this.getStatus())

    response.on('close', () => {
      this.sseClients.delete(response)
    })
  }

  private writeSseEvent(
    response: ServerResponse,
    eventName: string,
    payload: unknown,
  ): void {
    response.write(`event: ${eventName}\n`)
    response.write(`data: ${JSON.stringify(payload)}\n\n`)
  }

  private broadcastEvent(eventName: string, payload: unknown): void {
    for (const client of this.sseClients) {
      this.writeSseEvent(client, eventName, payload)
    }
  }

  private extractLeaseId(
    request: IncomingMessage,
    body: Record<string, unknown>,
  ): string {
    const headerLeaseId = request.headers['x-remote-lease']
    if (typeof headerLeaseId === 'string' && headerLeaseId.trim().length > 0) {
      return headerLeaseId.trim()
    }

    const bodyLeaseId = body.leaseId
    if (typeof bodyLeaseId === 'string' && bodyLeaseId.trim().length > 0) {
      return bodyLeaseId.trim()
    }

    return ''
  }

  private assertLeaseValid(leaseId: string): boolean {
    return Boolean(this.claimSession && this.claimSession.leaseId === leaseId)
  }

  private async handleClaimSession(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let body: Record<string, unknown>
    try {
      body = (await readJsonBody(request)) as Record<string, unknown>
    } catch {
      sendJson(response, 400, {
        ok: false,
        message: 'invalid-json',
      })
      return
    }

    const forceTakeover = body.forceTakeover === true

    if (this.claimSession && !forceTakeover) {
      sendJson(response, 409, {
        ok: false,
        message: 'remote-session-already-claimed',
        claimedBy: this.claimSession.clientName,
      })
      return
    }

    if (this.claimSession && forceTakeover) {
      await this.releaseSession('session-taken-over')
    }

    const clientName =
      typeof body.clientName === 'string' ? body.clientName.trim() : ''
    this.claimSession = {
      leaseId: createLeaseId(),
      clientName: clientName.length > 0 ? clientName : 'remote-client',
      lastHeartbeatMs: nowMs(),
    }
    this.sessionPlaybackTarget = DEFAULT_PLAYBACK_TARGET

    this.emitLifecycle({
      remoteSessionActive: true,
      reason: 'session-claimed',
    })
    await this.ensurePcmSync()

    sendJson(response, 200, {
      ok: true,
      leaseId: this.claimSession.leaseId,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      timeoutMs: SESSION_TIMEOUT_MS,
      state: this.buildStateResponse(),
    })
  }

  private async handleHeartbeat(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let body: Record<string, unknown>
    try {
      body = (await readJsonBody(request)) as Record<string, unknown>
    } catch {
      sendJson(response, 400, {
        ok: false,
        message: 'invalid-json',
      })
      return
    }

    const leaseId = this.extractLeaseId(request, body)
    if (!this.assertLeaseValid(leaseId)) {
      sendJson(response, 403, {
        ok: false,
        message: 'invalid-lease',
      })
      return
    }

    if (this.claimSession) {
      this.claimSession.lastHeartbeatMs = nowMs()
    }
    sendJson(response, 200, {
      ok: true,
      serverTimeMs: nowMs(),
    })
  }

  private async handleReleaseSession(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let body: Record<string, unknown> = {}
    try {
      body = (await readJsonBody(request)) as Record<string, unknown>
    } catch {
      // ignore body parse errors for release request
    }

    const leaseId = this.extractLeaseId(request, body)
    if (!this.assertLeaseValid(leaseId)) {
      sendJson(response, 403, {
        ok: false,
        message: 'invalid-lease',
      })
      return
    }

    await this.releaseSession('session-released')
    sendJson(response, 200, {
      ok: true,
    })
  }

  private async handleCommand(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let body: Record<string, unknown>
    try {
      body = (await readJsonBody(request)) as Record<string, unknown>
    } catch {
      sendJson(response, 400, {
        ok: false,
        message: 'invalid-json',
      })
      return
    }

    const leaseId = this.extractLeaseId(request, body)
    if (!this.assertLeaseValid(leaseId)) {
      sendJson(response, 403, {
        ok: false,
        message: 'invalid-lease',
      })
      return
    }

    const command = body.command
    const value = body.value
    const albumId =
      typeof body.albumId === 'string' && body.albumId.trim().length > 0
        ? body.albumId.trim()
        : undefined
    const songId =
      typeof body.songId === 'string' && body.songId.trim().length > 0
        ? body.songId.trim()
        : undefined
    const target =
      body.target === 'desktop'
        ? 'desktop'
        : body.target === 'mobile'
          ? 'mobile'
          : undefined
    if (!isRemoteRelayCommandType(command)) {
      sendJson(response, 400, {
        ok: false,
        message: 'invalid-command',
      })
      return
    }

    if (
      (command === 'seek' || command === 'setVolume') &&
      value !== undefined &&
      (typeof value !== 'number' || !Number.isFinite(value))
    ) {
      sendJson(response, 400, {
        ok: false,
        message: 'invalid-command-value',
      })
      return
    }

    if (command === 'playAlbum' && !albumId) {
      sendJson(response, 400, {
        ok: false,
        message: 'invalid-command-value',
      })
      return
    }

    if (command === 'playSong' && (!albumId || !songId)) {
      sendJson(response, 400, {
        ok: false,
        message: 'invalid-command-value',
      })
      return
    }

    if (command === 'setPlaybackTarget') {
      if (!target) {
        sendJson(response, 400, {
          ok: false,
          message: 'invalid-command-value',
        })
        return
      }

      this.sessionPlaybackTarget = target
      await this.ensurePcmSync(true)
      if (target === 'desktop') {
        this.closeWsClients()
      }
      this.broadcastEvent('state', this.buildStateResponse())
      sendJson(response, 200, {
        ok: true,
        target,
      })
      return
    }

    const payload: RemoteRelayCommandPayload = {
      command,
      value: typeof value === 'number' ? value : undefined,
      albumId,
      songId,
      target,
    }
    this.dispatchRemoteCommand(payload)

    if (payload.command === 'seek' && typeof payload.value === 'number') {
      this.latestState = {
        ...this.latestState,
        currentTimeSeconds: Math.max(0, payload.value),
      }
      await this.ensurePcmSync()
    }

    sendJson(response, 200, {
      ok: true,
    })
  }

  private async handleProfileChange(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let body: Record<string, unknown>
    try {
      body = (await readJsonBody(request)) as Record<string, unknown>
    } catch {
      sendJson(response, 400, {
        ok: false,
        message: 'invalid-json',
      })
      return
    }

    const leaseId = this.extractLeaseId(request, body)
    if (!this.assertLeaseValid(leaseId)) {
      sendJson(response, 403, {
        ok: false,
        message: 'invalid-lease',
      })
      return
    }

    const profile =
      body.profile === 'aac' ? 'aac' : body.profile === 'alac' ? 'alac' : null
    if (!profile) {
      sendJson(response, 400, {
        ok: false,
        message: 'invalid-profile',
      })
      return
    }

    this.streamProfile = profile
    await this.ensureHlsSync(true)
    this.broadcastEvent('state', this.buildStateResponse())

    sendJson(response, 200, {
      ok: true,
      profile,
    })
  }

  private async handleStreamFile(
    pathname: string,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.claimSession) {
      sendJson(response, 403, {
        ok: false,
        message: 'session-required',
      })
      return
    }

    const parts = pathname.split('/').filter(Boolean)
    if (parts.length < 3 || parts[0] !== 'stream') {
      sendJson(response, 404, {
        ok: false,
        message: 'not-found',
      })
      return
    }

    const profile = parts[1]
    if (profile !== 'alac' && profile !== 'aac') {
      sendJson(response, 400, {
        ok: false,
        message: 'invalid-profile',
      })
      return
    }

    const fileName = path.basename(parts.slice(2).join('/'))
    if (fileName.length === 0) {
      sendJson(response, 404, {
        ok: false,
        message: 'missing-file',
      })
      return
    }

    await this.ensureHlsSync()

    const filePath =
      fileName === 'index.m3u8'
        ? this.hlsPipeline.getPlaylistPath(profile)
        : this.hlsPipeline.getSegmentPath(profile, fileName)

    const exists = await this.waitForStreamFile(filePath)
    if (!exists) {
      sendJson(response, 503, {
        ok: false,
        message: 'stream-not-ready',
        details: this.hlsPipeline.getErrorMessage(),
      })
      return
    }

    const ext = path.extname(fileName).toLowerCase()
    const contentType =
      ext === '.m3u8'
        ? 'application/vnd.apple.mpegurl'
        : ext === '.m4s' || ext === '.mp4'
          ? 'video/iso.segment'
          : 'application/octet-stream'
    const buffer = await fsp.readFile(filePath)
    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
    })
    response.end(buffer)
  }

  private async waitForStreamFile(filePath: string): Promise<boolean> {
    if (fs.existsSync(filePath)) return true

    const deadline = nowMs() + STREAM_FILE_WAIT_MS
    while (nowMs() < deadline) {
      if (fs.existsSync(filePath)) return true

      const errorMessage = this.hlsPipeline.getErrorMessage()
      if (errorMessage.length > 0) return false

      await sleep(STREAM_FILE_POLL_MS)
    }

    return fs.existsSync(filePath)
  }

  private async handleWsUpgrade(
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): Promise<void> {
    const host = request.headers.host ?? '127.0.0.1'
    const parsedUrl = new URL(request.url ?? '/', `http://${host}`)
    if (parsedUrl.pathname !== WS_AUDIO_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    const leaseId = parsedUrl.searchParams.get('leaseId')?.trim() ?? ''
    if (!this.assertLeaseValid(leaseId)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    const upgradeHeader = request.headers.upgrade
    const wsKey = request.headers['sec-websocket-key']
    if (
      typeof upgradeHeader !== 'string' ||
      upgradeHeader.toLowerCase() !== 'websocket' ||
      typeof wsKey !== 'string' ||
      wsKey.trim().length === 0
    ) {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    const acceptValue = toWebSocketAcceptValue(wsKey.trim())
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptValue}`,
        '\r\n',
      ].join('\r\n'),
    )

    for (const existing of this.wsClients) {
      try {
        existing.socket.end()
      } catch {
        // noop
      }
    }
    this.wsClients.clear()

    const client: RelayWsClient = {
      socket,
      leaseId,
    }
    this.wsClients.add(client)

    const cleanup = () => {
      this.wsClients.delete(client)
    }

    socket.on('data', (chunk: Buffer) => {
      tryHandleClientWsControlFrames(socket, chunk)
    })
    if (head.length > 0) {
      tryHandleClientWsControlFrames(socket, head)
    }
    socket.on('end', cleanup)
    socket.on('close', cleanup)
    socket.on('error', cleanup)

    writeWsText(
      socket,
      JSON.stringify({
        type: 'format',
        sampleRate: this.relayPcmFormat.sampleRate,
        channels: this.relayPcmFormat.channels,
        sampleFormat: this.relayPcmFormat.sampleFormat,
      }),
    )

    await this.ensurePcmSync()
  }

  private broadcastAudioChunk(chunk: Buffer): void {
    if (!this.claimSession || !this.canStreamCurrentState()) return
    if (this.wsClients.size === 0) return

    for (const client of [...this.wsClients]) {
      if (!this.assertLeaseValid(client.leaseId) || client.socket.destroyed) {
        this.wsClients.delete(client)
        try {
          client.socket.end()
        } catch {
          // noop
        }
        continue
      }

      if (client.socket.writableLength > WS_MAX_WRITABLE_BYTES) {
        continue
      }

      try {
        writeWsBinary(client.socket, chunk)
      } catch {
        this.wsClients.delete(client)
        try {
          client.socket.destroy()
        } catch {
          // noop
        }
      }
    }
  }

  private dispatchRemoteCommand(payload: RemoteRelayCommandPayload): void {
    if (!this.window || this.window.isDestroyed()) return
    this.window.webContents.send(IpcChannels.RemoteRelayCommand, payload)
  }

  private emitLifecycle(payload: RemoteRelayLifecycleEvent): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send(IpcChannels.RemoteRelayLifecycle, payload)
    }
    this.broadcastEvent('lifecycle', payload)
  }

  private async releaseSession(reason: string): Promise<void> {
    if (!this.claimSession) return
    this.claimSession = null
    this.sessionPlaybackTarget = null
    await this.hlsPipeline.stop()
    await this.ensurePcmSync(false)
    this.closeWsClients()
    this.emitLifecycle({
      remoteSessionActive: false,
      reason,
    })
  }

  private async ensurePcmSync(forceRestart = false): Promise<void> {
    const shouldEnable = Boolean(
      this.claimSession && this.canStreamCurrentState(),
    )
    if (this.nativeRelayPcmCommandUnsupported) {
      if (!shouldEnable) {
        await this.fallbackPcmPipeline.stop()
        return
      }
      await this.ensureFallbackPcmSync(forceRestart)
      return
    }
    if (!shouldEnable) {
      if (this.relayPcmEnabled || forceRestart) {
        const result = await nativeAudioSidecar.setRelayPcm(false)
        if (!result.ok) {
          console.warn(
            '[RemoteRelay] Failed to disable native relay PCM tap:',
            result.error?.message ?? 'unknown-error',
          )
        }
      }
      this.relayPcmEnabled = false
      this.relayPcmEnabledAtMs = 0
      this.lastNativePcmChunkAtMs = 0
      await this.fallbackPcmPipeline.stop()
      this.relayPcmFormat = {
        sampleRate: WS_AUDIO_SAMPLE_RATE,
        channels: WS_AUDIO_CHANNELS,
        sampleFormat: 's16le',
      }
      this.closeWsClients()
      return
    }

    if (forceRestart) {
      this.lastNativePcmChunkAtMs = 0
      this.relayPcmEnabledAtMs = 0
      await this.fallbackPcmPipeline.stop()
    }

    if (!this.relayPcmEnabled || forceRestart) {
      const result = await nativeAudioSidecar.setRelayPcm(true, 'streamOnly')
      if (!result.ok) {
        this.relayPcmEnabled = false
        if (result.error?.code === 'unknown-command') {
          this.nativeRelayPcmCommandUnsupported = true
          console.warn(
            '[RemoteRelay] Native sidecar does not support setRelayPcm. Using ffmpeg PCM fallback.',
          )
        }
        console.warn(
          '[RemoteRelay] Failed to enable native relay PCM tap. Falling back to ffmpeg PCM:',
          result.error?.message ?? 'unknown-error',
        )
        await this.ensureFallbackPcmSync(forceRestart)
        return
      }

      this.relayPcmEnabled = true
      this.relayPcmEnabledAtMs = nowMs()
      this.lastNativePcmChunkAtMs = 0
    }

    const currentMs = nowMs()
    const withinGrace =
      this.lastNativePcmChunkAtMs === 0 &&
      this.relayPcmEnabledAtMs > 0 &&
      currentMs - this.relayPcmEnabledAtMs <= NATIVE_PCM_CHUNK_GRACE_MS
    const nativeChunkFresh =
      this.lastNativePcmChunkAtMs > 0 &&
      currentMs - this.lastNativePcmChunkAtMs <= NATIVE_PCM_CHUNK_STALE_MS

    if (withinGrace || nativeChunkFresh) {
      await this.fallbackPcmPipeline.stop()
      return
    }

    await this.ensureFallbackPcmSync(forceRestart)
  }

  private closeWsClients(): void {
    for (const client of this.wsClients) {
      try {
        client.socket.end()
      } catch {
        // noop
      }
    }
    this.wsClients.clear()
  }

  private async ensureFallbackPcmSync(forceRestart = false): Promise<void> {
    if (!this.canStreamCurrentState()) {
      await this.fallbackPcmPipeline.stop()
      return
    }

    const source = this.latestState.src as string
    if (forceRestart) {
      await this.fallbackPcmPipeline.stop()
    }
    await this.fallbackPcmPipeline.ensureStreaming(
      source,
      this.latestState.currentTimeSeconds,
    )
  }

  private async ensureHlsSync(forceRestart = false): Promise<void> {
    if (!this.claimSession) return
    if (!this.canStreamCurrentState()) {
      await this.hlsPipeline.stop()
      return
    }

    const source = this.latestState.src as string

    if (forceRestart) {
      await this.hlsPipeline.stop()
    }

    await this.hlsPipeline.ensureStreaming(
      this.streamProfile,
      source,
      this.latestState.currentTimeSeconds,
    )
  }

  private buildRemoteWebHtml(): string {
    const relayState = this.buildStateResponse()
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Minato Remote Relay</title>
  <style>
    :root {
      --background: #0e1116;
      --foreground: #e7ecf5;
      --muted-foreground: #97a4b8;
      --border: #2a313d;
      --secondary: #171d28;
      --secondary-foreground: #d5deea;
      --primary: #4f8cff;
      --primary-foreground: #071529;
      --danger: #f78f8f;
      --success: #7fe0bc;
    }
    html, body {
      margin: 0;
      padding: 0;
      min-height: 100%;
      background: var(--background);
      color: var(--foreground);
      font-family: "Segoe UI", "Noto Sans JP", sans-serif;
    }
    * { box-sizing: border-box; }
    .app {
      max-width: 560px;
      margin: 0 auto;
      min-height: 100dvh;
      padding: 12px;
      display: grid;
      grid-template-rows: auto auto auto auto;
      gap: 10px;
    }
    .panel, .status-panel {
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--secondary);
    }
    .status-panel {
      padding: 10px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }
    .brand {
      font-size: 12px;
      color: var(--muted-foreground);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-right: auto;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 12px;
      color: var(--secondary-foreground);
      background: #141a24;
    }
    .status.active::before {
      content: "";
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: var(--success);
    }
    .status.error::before {
      content: "";
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: var(--danger);
    }
    .target-switch {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-left: auto;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 2px;
      background: #141a24;
    }
    .target-switch-btn {
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: var(--secondary-foreground);
      font-size: 11px;
      line-height: 1;
      padding: 6px 10px;
      cursor: pointer;
    }
    .target-switch-btn.active {
      background: var(--primary);
      color: var(--primary-foreground);
      font-weight: 600;
    }
    .panel {
      padding: 10px;
    }
    .track-row {
      display: grid;
      grid-template-columns: 70px 1fr;
      gap: 10px;
      align-items: center;
    }
    .artwork {
      width: 70px;
      height: 70px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: #101723;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 24px;
      color: var(--muted-foreground);
    }
    .track-title {
      font-size: 14px;
      font-weight: 600;
      line-height: 1.4;
      margin: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .track-meta {
      margin: 0;
      color: var(--muted-foreground);
      font-size: 12px;
      margin-top: 3px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .state {
      margin-top: 4px;
      font-size: 11px;
      color: var(--muted-foreground);
    }
    .controls-panel {
      display: grid;
      gap: 10px;
    }
    .controls-row {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 6px;
    }
    .icon-btn {
      width: 40px;
      height: 40px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--secondary-foreground);
      font-size: 15px;
      cursor: pointer;
    }
    .icon-btn:disabled { opacity: 0.45; cursor: default; }
    .play-btn {
      width: 44px;
      height: 44px;
      border-radius: 999px;
      border: 0;
      background: var(--primary);
      color: var(--primary-foreground);
      font-size: 17px;
      font-weight: 700;
      cursor: pointer;
    }
    .progress-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    input[type="range"] {
      width: 100%;
      accent-color: var(--primary);
      margin: 0;
    }
    .time-row {
      display: grid;
      grid-template-columns: 40px 1fr 40px;
      gap: 8px;
      justify-content: space-between;
      align-items: center;
      color: var(--muted-foreground);
      font-size: 11px;
    }
    .volume-row {
      display: grid;
      grid-template-columns: 32px 1fr 32px;
      gap: 8px;
      align-items: center;
    }
    .ghost-btn {
      border: 1px solid var(--border);
      background: transparent;
      color: var(--secondary-foreground);
      border-radius: 8px;
      height: 32px;
      padding: 0 12px;
      font-size: 12px;
      cursor: pointer;
    }
    .footer-actions {
      display: flex;
      justify-content: flex-end;
      margin-top: 2px;
    }
    .log-title {
      color: var(--muted-foreground);
      font-size: 12px;
      text-transform: uppercase;
      margin-bottom: 6px;
      letter-spacing: 0.06em;
    }
    .log {
      max-height: 120px;
      overflow: auto;
      font-size: 12px;
      color: var(--muted-foreground);
      line-height: 1.45;
      white-space: pre-wrap;
      border-top: 1px solid var(--border);
      padding-top: 6px;
    }
  </style>
</head>
<body>
  <main class="app">
    <section class="status-panel">
      <div class="brand">Minato Remote</div>
      <span class="status active" id="sessionBadge">session: connecting</span>
      <span class="status" id="profileBadge">transport: ws-pcm</span>
      <div class="target-switch">
        <button id="btnTargetDesktop" class="target-switch-btn active" type="button">PC</button>
        <button id="btnTargetMobile" class="target-switch-btn" type="button">Mobile</button>
      </div>
    </section>

    <section class="panel">
      <div class="track-row">
        <div class="artwork"><span id="coverGlyph">♪</span></div>
        <div>
          <p class="track-title" id="trackTitle">No track</p>
          <p class="track-meta" id="trackMeta">Waiting for playback state...</p>
          <p class="state" id="stateText">state: idle</p>
        </div>
      </div>
    </section>

    <section class="panel controls-panel">
      <div class="controls-row">
        <button id="btnPrev" class="icon-btn" aria-label="Previous">⏮</button>
        <button id="btnPlayPause" class="play-btn" aria-label="Play Pause">▶</button>
        <button id="btnNext" class="icon-btn" aria-label="Next">⏭</button>
      </div>
      <div class="progress-row">
        <input id="seekRange" type="range" min="0" max="0" step="1" value="0" />
      </div>
      <div class="time-row">
        <span id="timeCurrent">0:00</span>
        <span></span>
        <span id="timeDuration">0:00</span>
      </div>
      <div class="volume-row">
        <button id="btnVolDown" class="icon-btn" aria-label="Volume Down">−</button>
        <input id="volumeRange" type="range" min="0" max="100" step="1" value="0" />
        <button id="btnVolUp" class="icon-btn" aria-label="Volume Up">＋</button>
      </div>
      <div class="footer-actions">
        <button id="btnReconnect" class="ghost-btn">Reconnect Session</button>
      </div>
    </section>

    <section class="panel">
      <div class="log-title">Remote Log</div>
      <div class="log" id="logBox"></div>
    </section>
  </main>
  <script>
    (() => {
      const initial = ${JSON.stringify(relayState)};
      let leaseId = null;
      let heartbeat = null;
      let eventSource = null;
      let audioSocket = null;
      let audioSocketReconnectTimer = null;
      let audioSocketGeneration = 0;
      let currentState = initial.state || null;
      let isSeeking = false;
      let isVolumeSliding = false;
      let audioContext = null;
      let scriptNode = null;
      let pcmQueue = [];
      let queuedFrames = 0;
      const maxBufferedSeconds = 2;
      const defaultFormat = {
        sampleRate: 48000,
        channels: 2,
      };
      let audioFormat = { ...defaultFormat };

      const el = {
        sessionBadge: document.getElementById('sessionBadge'),
        profileBadge: document.getElementById('profileBadge'),
        btnTargetDesktop: document.getElementById('btnTargetDesktop'),
        btnTargetMobile: document.getElementById('btnTargetMobile'),
        coverGlyph: document.getElementById('coverGlyph'),
        trackTitle: document.getElementById('trackTitle'),
        trackMeta: document.getElementById('trackMeta'),
        stateText: document.getElementById('stateText'),
        seekRange: document.getElementById('seekRange'),
        timeCurrent: document.getElementById('timeCurrent'),
        timeDuration: document.getElementById('timeDuration'),
        btnPrev: document.getElementById('btnPrev'),
        btnPlayPause: document.getElementById('btnPlayPause'),
        btnNext: document.getElementById('btnNext'),
        volumeRange: document.getElementById('volumeRange'),
        btnVolDown: document.getElementById('btnVolDown'),
        btnVolUp: document.getElementById('btnVolUp'),
        btnReconnect: document.getElementById('btnReconnect'),
        logBox: document.getElementById('logBox'),
      };

      function log(line) {
        const timestamp = new Date().toLocaleTimeString();
        const next = '[' + timestamp + '] ' + line;
        el.logBox.textContent = next + '\\n' + el.logBox.textContent;
      }

      function fmt(sec) {
        const safe = Math.max(0, Number.isFinite(sec) ? sec : 0);
        const m = Math.floor(safe / 60);
        const s = Math.floor(safe % 60).toString().padStart(2, '0');
        return m + ':' + s;
      }

      async function api(method, url, body) {
        const response = await fetch(url, {
          method,
          headers: { 'content-type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
        const text = await response.text();
        let json = {};
        try { json = JSON.parse(text); } catch {}
        if (!response.ok) {
          const message = typeof json.message === 'string' ? json.message : response.status + ' ' + response.statusText;
          const error = new Error(message);
          error.code = message;
          error.status = response.status;
          throw error;
        }
        return json;
      }

      function clearAudioQueue() {
        pcmQueue = [];
        queuedFrames = 0;
      }

      function ensureAudioEngine() {
        if (audioContext && scriptNode) return;

        const nextContext = new window.AudioContext({
          sampleRate: audioFormat.sampleRate,
        });
        const nextNode = nextContext.createScriptProcessor(2048, 0, 2);
        nextNode.onaudioprocess = (event) => {
          const outputLeft = event.outputBuffer.getChannelData(0);
          const outputRight = event.outputBuffer.getChannelData(1);
          const outputFrames = outputLeft.length;
          let writeOffset = 0;

          while (writeOffset < outputFrames) {
            const chunk = pcmQueue[0];
            if (!chunk) break;

            const available = chunk.left.length - chunk.offset;
            const copyFrames = Math.min(available, outputFrames - writeOffset);
            outputLeft.set(
              chunk.left.subarray(chunk.offset, chunk.offset + copyFrames),
              writeOffset,
            );
            outputRight.set(
              chunk.right.subarray(chunk.offset, chunk.offset + copyFrames),
              writeOffset,
            );

            chunk.offset += copyFrames;
            writeOffset += copyFrames;
            queuedFrames -= copyFrames;

            if (chunk.offset >= chunk.left.length) {
              pcmQueue.shift();
            }
          }

          if (writeOffset < outputFrames) {
            outputLeft.fill(0, writeOffset);
            outputRight.fill(0, writeOffset);
          }
        };

        nextNode.connect(nextContext.destination);
        audioContext = nextContext;
        scriptNode = nextNode;

        if (audioContext.sampleRate !== audioFormat.sampleRate) {
          log(
            'audio context sampleRate mismatch: ctx=' +
              audioContext.sampleRate +
              ', stream=' +
              audioFormat.sampleRate,
          );
        }
      }

      async function resumeAudioEngine() {
        ensureAudioEngine();
        if (!audioContext) return;
        if (audioContext.state === 'running') return;

        try {
          await audioContext.resume();
        } catch {
          // browser autoplay policy; resume will be retried on user interaction
        }
      }

      function resetAudioEngineForFormatChange() {
        if (!audioContext) return;
        if (audioContext.sampleRate === audioFormat.sampleRate) return;
        try {
          if (scriptNode) {
            scriptNode.disconnect();
          }
        } catch {
          // noop
        }
        try {
          audioContext.close();
        } catch {
          // noop
        }
        audioContext = null;
        scriptNode = null;
        clearAudioQueue();
      }

      function pushPcmChunk(bufferLike) {
        if (!(bufferLike instanceof ArrayBuffer)) return;
        ensureAudioEngine();

        const samples = new Int16Array(bufferLike);
        const frames = Math.floor(samples.length / 2);
        if (frames <= 0) return;

        const left = new Float32Array(frames);
        const right = new Float32Array(frames);
        for (let i = 0; i < frames; i += 1) {
          left[i] = samples[i * 2] / 32768;
          right[i] = samples[i * 2 + 1] / 32768;
        }

        pcmQueue.push({
          left,
          right,
          offset: 0,
        });
        queuedFrames += frames;

        const maxFrames = Math.max(
          audioFormat.sampleRate,
          Math.floor(audioFormat.sampleRate * maxBufferedSeconds),
        );
        while (queuedFrames > maxFrames && pcmQueue.length > 1) {
          const dropped = pcmQueue.shift();
          if (dropped) {
            queuedFrames -= Math.max(0, dropped.left.length - dropped.offset);
          }
        }
      }

      function closeAudioSocket() {
        audioSocketGeneration += 1;
        if (audioSocketReconnectTimer) {
          clearTimeout(audioSocketReconnectTimer);
          audioSocketReconnectTimer = null;
        }
        if (!audioSocket) return;
        const activeSocket = audioSocket;
        audioSocket = null;
        try {
          activeSocket.close();
        } catch {
          // noop
        }
      }

      function connectAudioSocket() {
        if (!leaseId) return;
        closeAudioSocket();
        const generation = audioSocketGeneration;

        const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl =
          scheme +
          '//' +
          location.host +
          '/ws/audio?leaseId=' +
          encodeURIComponent(leaseId);

        const ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';
        audioSocket = ws;

        ws.addEventListener('open', () => {
          log('audio websocket connected');
          resumeAudioEngine();
        });

        ws.addEventListener('message', (event) => {
          if (typeof event.data === 'string') {
            try {
              const payload = JSON.parse(event.data);
              if (payload && payload.type === 'format') {
                audioFormat.sampleRate =
                  Number.isFinite(payload.sampleRate) && payload.sampleRate > 0
                    ? Math.floor(payload.sampleRate)
                    : defaultFormat.sampleRate;
                audioFormat.channels =
                  Number.isFinite(payload.channels) && payload.channels > 0
                    ? Math.floor(payload.channels)
                    : defaultFormat.channels;
                el.profileBadge.textContent =
                  'transport: ws-pcm ' +
                  audioFormat.sampleRate +
                  'Hz/' +
                  audioFormat.channels +
                  'ch';
                resetAudioEngineForFormatChange();
              }
            } catch {
              // ignore
            }
            return;
          }

          pushPcmChunk(event.data);
        });

        ws.addEventListener('close', () => {
          if (generation !== audioSocketGeneration) return;
          if (audioSocket === ws) {
            audioSocket = null;
          }
          if (leaseId) {
            audioSocketReconnectTimer = setTimeout(() => {
              connectAudioSocket();
            }, 1200);
          }
        });

        ws.addEventListener('error', () => {
          log('audio websocket error');
        });
      }

      async function claimSession(forceTakeover = false) {
        try {
          const claimed = await api('POST', '/api/remote/session/claim', {
            clientName: 'mobile-web',
            forceTakeover: forceTakeover === true,
          });
          leaseId = claimed.leaseId;
          el.sessionBadge.classList.remove('error');
          el.sessionBadge.classList.add('active');
          el.sessionBadge.textContent = 'session: active';
          log(forceTakeover ? 'session claimed by takeover' : 'session claimed');
          const claimState = claimed && claimed.state ? claimed.state : null;
          if (claimState && claimState.canStream) {
            connectAudioSocket();
          } else {
            log('waiting for stream readiness...');
          }
        } catch (error) {
          if (!forceTakeover && error && error.code === 'remote-session-already-claimed') {
            log('session already claimed, taking over...');
            return claimSession(true);
          }
          throw error;
        }

        if (heartbeat) clearInterval(heartbeat);
        heartbeat = setInterval(() => {
          api('POST', '/api/remote/session/heartbeat', { leaseId }).catch((error) => {
            log('heartbeat failed: ' + error.message);
          });
        }, 5000);
      }

      async function sendCommand(command, value) {
        if (!leaseId) return;
        await resumeAudioEngine();
        await api('POST', '/api/remote/commands', { leaseId, command, value });
      }

      async function sendPlaybackTarget(target) {
        if (!leaseId) return;
        await api('POST', '/api/remote/commands', {
          leaseId,
          command: 'setPlaybackTarget',
          target,
        });
      }

      function updateState(payload) {
        const state = payload && payload.state ? payload.state : null;
        if (!state) return;
        const canStream =
          Boolean(state && state.canStream) || Boolean(payload && payload.canStream);
        const playbackTarget =
          state && typeof state.playbackTarget === 'string'
            ? state.playbackTarget
            : 'desktop';
        if (el.btnTargetDesktop && el.btnTargetMobile) {
          el.btnTargetDesktop.classList.toggle('active', playbackTarget === 'desktop');
          el.btnTargetMobile.classList.toggle('active', playbackTarget === 'mobile');
        }
        if (leaseId && canStream && !audioSocket) {
          connectAudioSocket();
        }
        if (!canStream && audioSocket) {
          closeAudioSocket();
          clearAudioQueue();
        }
        currentState = state;
        const title = state.nowPlaying && state.nowPlaying.title ? state.nowPlaying.title : 'No track';
        const artist = state.nowPlaying && state.nowPlaying.artist ? state.nowPlaying.artist : '';
        const album = state.nowPlaying && state.nowPlaying.album ? state.nowPlaying.album : '';
        el.coverGlyph.textContent = title && title !== 'No track'
          ? title.slice(0, 1).toUpperCase()
          : '♪';
        el.trackTitle.textContent = title;
        el.trackMeta.textContent = [artist, album].filter(Boolean).join(' - ') || 'No metadata';
        el.stateText.textContent = (state.isPlaying ? 'playing' : 'paused') + ' / ' + state.source;
        el.btnPlayPause.textContent = state.isPlaying ? '❚❚' : '▶';
        el.btnPrev.disabled = !Boolean(state.hasPrev);
        el.btnNext.disabled = !Boolean(state.hasNext);
        const duration = Number.isFinite(state.durationSeconds) ? Math.max(0, state.durationSeconds) : 0;
        const current = Number.isFinite(state.currentTimeSeconds) ? Math.max(0, state.currentTimeSeconds) : 0;
        el.seekRange.max = String(Math.max(0, Math.floor(duration)));
        if (!isSeeking) {
          el.seekRange.value = String(Math.floor(current));
          el.timeCurrent.textContent = fmt(current);
        }
        el.timeDuration.textContent = fmt(duration);
        if (!isVolumeSliding) {
          const volume = Number.isFinite(state.volume) ? Math.max(0, Math.min(100, Math.floor(state.volume))) : 0;
          el.volumeRange.value = String(volume);
        }
      }

      el.btnPrev.addEventListener('click', () => {
        sendCommand('prev').catch((error) => log('command failed: ' + error.message));
      });
      el.btnPlayPause.addEventListener('click', () => {
        sendCommand('playPause').then(() => {
        }).catch((error) => log('command failed: ' + error.message));
      });
      el.btnNext.addEventListener('click', () => {
        sendCommand('next').catch((error) => log('command failed: ' + error.message));
      });
      el.btnVolDown.addEventListener('click', () => {
        const base = currentState ? currentState.volume : 0;
        sendCommand('setVolume', Math.max(0, base - 5)).catch((error) => log('command failed: ' + error.message));
      });
      el.btnVolUp.addEventListener('click', () => {
        const base = currentState ? currentState.volume : 0;
        sendCommand('setVolume', Math.min(100, base + 5)).catch((error) => log('command failed: ' + error.message));
      });
      el.volumeRange.addEventListener('input', () => {
        isVolumeSliding = true;
      });
      el.volumeRange.addEventListener('change', () => {
        isVolumeSliding = false;
        const next = Number.parseFloat(el.volumeRange.value);
        sendCommand('setVolume', Math.max(0, Math.min(100, next))).catch((error) => log('volume failed: ' + error.message));
      });
      el.volumeRange.addEventListener('pointerup', () => {
        isVolumeSliding = false;
      });
      el.seekRange.addEventListener('input', () => {
        isSeeking = true;
        const next = Number.parseFloat(el.seekRange.value);
        el.timeCurrent.textContent = fmt(next);
      });
      el.seekRange.addEventListener('change', () => {
        const next = Number.parseFloat(el.seekRange.value);
        isSeeking = false;
        sendCommand('seek', next).catch((error) => log('seek failed: ' + error.message));
      });
      el.seekRange.addEventListener('pointerup', () => {
        isSeeking = false;
      });
      el.btnReconnect.addEventListener('click', async () => {
        try {
          await api('DELETE', '/api/remote/session/release', { leaseId });
        } catch {}
        leaseId = null;
        closeAudioSocket();
        clearAudioQueue();
        el.sessionBadge.classList.remove('active');
        el.sessionBadge.classList.add('error');
        el.sessionBadge.textContent = 'session: reconnecting...';
        claimSession(true).catch((error) => log('claim failed: ' + error.message));
      });
      el.btnTargetDesktop.addEventListener('click', () => {
        sendPlaybackTarget('desktop').catch((error) => log('target failed: ' + error.message));
      });
      el.btnTargetMobile.addEventListener('click', () => {
        sendPlaybackTarget('mobile').catch((error) => log('target failed: ' + error.message));
      });

      window.addEventListener('pointerdown', () => {
        resumeAudioEngine();
      }, { passive: true });

      window.addEventListener('beforeunload', () => {
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        closeAudioSocket();
        if (!leaseId) return;
        navigator.sendBeacon(
          '/api/remote/session/release',
          JSON.stringify({ leaseId }),
        );
      });

      updateState(initial);
      el.profileBadge.textContent = 'transport: ws-pcm';

      claimSession()
        .then(() => {
          eventSource = new EventSource(
            '/api/remote/events?leaseId=' + encodeURIComponent(leaseId),
          );
          eventSource.addEventListener('state', (event) => {
            try {
              const payload = JSON.parse(event.data);
              updateState(payload);
            } catch {}
          });
          eventSource.addEventListener('lifecycle', (event) => {
            try {
              const payload = JSON.parse(event.data);
              if (!payload.remoteSessionActive) {
                el.sessionBadge.classList.remove('active');
                el.sessionBadge.classList.add('error');
                el.sessionBadge.textContent = 'session: inactive (' + (payload.reason || 'released') + ')';
                leaseId = null;
                if (heartbeat) {
                  clearInterval(heartbeat);
                  heartbeat = null;
                }
                closeAudioSocket();
                clearAudioQueue();
              }
            } catch {}
          });
        })
        .catch((error) => {
          el.sessionBadge.classList.remove('active');
          el.sessionBadge.classList.add('error');
          el.sessionBadge.textContent = 'session: failed';
          log('session claim failed: ' + error.message);
        });
    })();
  </script>
</body>
</html>`
  }

  // Library API handlers - communicate with renderer process
  private async fetchFromRenderer<T>(
    channel: string,
    data: unknown,
  ): Promise<T | null> {
    if (!this.window || this.window.isDestroyed()) {
      console.warn('[RemoteRelay] Window not available')
      return null
    }

    this.ensureRendererLibraryResponseListener()

    return new Promise((resolve) => {
      const requestId = `${Date.now()}-${Math.random()}`
      console.log(
        `[RemoteRelay] -> renderer request channel=${channel} requestId=${requestId}`,
      )

      const timeout = setTimeout(() => {
        console.log(
          `[RemoteRelay] renderer request timeout channel=${channel} requestId=${requestId}`,
        )
        this.pendingRendererLibraryRequests.delete(requestId)
        resolve(null)
      }, 10000)

      this.pendingRendererLibraryRequests.set(requestId, {
        channel,
        resolve: (value) => resolve(value as T | null),
        timeout,
      })

      // Send request to renderer
      this.window?.webContents.send(IpcChannels.RemoteLibraryRequest, {
        requestId,
        channel,
        data,
      })
    })
  }

  private async handleLibraryArtists(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const leaseId = this.extractLeaseIdFromQuery(request)
    if (!this.assertLeaseValid(leaseId)) {
      sendJson(response, 403, { ok: false, message: 'invalid-session' })
      return
    }

    const host = request.headers.host ?? '127.0.0.1'
    const parsedUrl = new URL(request.url ?? '/', `http://${host}`)
    const limit = this.parseBoundedInt(
      parsedUrl.searchParams.get('limit'),
      50,
      1,
      200,
    )
    const offset = this.parseBoundedInt(
      parsedUrl.searchParams.get('offset'),
      0,
      0,
      100_000,
    )

    try {
      const result = await this.fetchFromRenderer<unknown[]>('get-artists', {
        limit,
        offset,
      })
      console.log(
        `[RemoteRelay] library artists result count=${Array.isArray(result) ? result.length : 0}`,
      )
      sendJson(response, 200, result ?? [])
    } catch (error) {
      console.error('[RemoteRelay] Failed to get artists:', error)
      sendJson(response, 500, { ok: false, message: 'failed-to-fetch' })
    }
  }

  private async handleLibraryGenres(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const leaseId = this.extractLeaseIdFromQuery(request)
    if (!this.assertLeaseValid(leaseId)) {
      sendJson(response, 403, { ok: false, message: 'invalid-session' })
      return
    }

    const host = request.headers.host ?? '127.0.0.1'
    const parsedUrl = new URL(request.url ?? '/', `http://${host}`)
    const limit = this.parseBoundedInt(
      parsedUrl.searchParams.get('limit'),
      6,
      1,
      30,
    )

    try {
      const result = await this.fetchFromRenderer<unknown[]>('get-genres', {
        limit,
      })
      console.log(
        `[RemoteRelay] library genres result count=${Array.isArray(result) ? result.length : 0}`,
      )
      sendJson(response, 200, result ?? [])
    } catch (error) {
      console.error('[RemoteRelay] Failed to get genres:', error)
      sendJson(response, 500, { ok: false, message: 'failed-to-fetch' })
    }
  }

  private async handleLibraryAlbums(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const leaseId = this.extractLeaseIdFromQuery(request)
    if (!this.assertLeaseValid(leaseId)) {
      sendJson(response, 403, { ok: false, message: 'invalid-session' })
      return
    }

    const host = request.headers.host ?? '127.0.0.1'
    const parsedUrl = new URL(request.url ?? '/', `http://${host}`)
    const artistId = parsedUrl.searchParams.get('artistId') ?? undefined
    const genre = parsedUrl.searchParams.get('genre') ?? undefined
    const type = parsedUrl.searchParams.get('type') ?? undefined
    const limit = this.parseBoundedInt(
      parsedUrl.searchParams.get('limit'),
      50,
      1,
      200,
    )
    const offset = this.parseBoundedInt(
      parsedUrl.searchParams.get('offset'),
      0,
      0,
      100_000,
    )

    try {
      const result = await this.fetchFromRenderer<unknown[]>('get-albums', {
        artistId,
        genre,
        type,
        limit,
        offset,
      })
      console.log(
        `[RemoteRelay] library albums result count=${Array.isArray(result) ? result.length : 0}`,
      )
      sendJson(response, 200, result ?? [])
    } catch (error) {
      console.error('[RemoteRelay] Failed to get albums:', error)
      sendJson(response, 500, { ok: false, message: 'failed-to-fetch' })
    }
  }

  private async handleLibrarySongs(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const leaseId = this.extractLeaseIdFromQuery(request)
    if (!this.assertLeaseValid(leaseId)) {
      sendJson(response, 403, { ok: false, message: 'invalid-session' })
      return
    }

    const host = request.headers.host ?? '127.0.0.1'
    const parsedUrl = new URL(request.url ?? '/', `http://${host}`)
    const albumId = parsedUrl.searchParams.get('albumId') ?? undefined
    const limit = this.parseBoundedInt(
      parsedUrl.searchParams.get('limit'),
      50,
      1,
      200,
    )
    const offset = this.parseBoundedInt(
      parsedUrl.searchParams.get('offset'),
      0,
      0,
      100_000,
    )

    try {
      const result = await this.fetchFromRenderer<unknown[]>('get-songs', {
        albumId,
        limit,
        offset,
      })
      console.log(
        `[RemoteRelay] library songs result count=${Array.isArray(result) ? result.length : 0}`,
      )
      sendJson(response, 200, result ?? [])
    } catch (error) {
      console.error('[RemoteRelay] Failed to get songs:', error)
      sendJson(response, 500, { ok: false, message: 'failed-to-fetch' })
    }
  }

  private parseBoundedInt(
    raw: string | null,
    fallback: number,
    min: number,
    max: number,
  ): number {
    if (typeof raw !== 'string' || raw.trim().length === 0) return fallback
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return fallback
    const rounded = Math.trunc(parsed)
    if (rounded < min) return min
    if (rounded > max) return max
    return rounded
  }

  private async handleLibrarySearch(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const leaseId = this.extractLeaseIdFromQuery(request)
    if (!this.assertLeaseValid(leaseId)) {
      sendJson(response, 403, { ok: false, message: 'invalid-session' })
      return
    }

    const host = request.headers.host ?? '127.0.0.1'
    const parsedUrl = new URL(request.url ?? '/', `http://${host}`)
    const query = (parsedUrl.searchParams.get('query') ?? '').trim()

    if (query.length < 2) {
      sendJson(response, 200, { artists: [], albums: [], songs: [] })
      return
    }

    try {
      const result = await this.fetchFromRenderer<{
        artists: unknown[]
        albums: unknown[]
        songs: unknown[]
      }>('search', { query })
      console.log(
        `[RemoteRelay] library search result counts artists=${
          Array.isArray(result?.artists) ? result.artists.length : 0
        } albums=${Array.isArray(result?.albums) ? result.albums.length : 0} songs=${
          Array.isArray(result?.songs) ? result.songs.length : 0
        } query="${query}"`,
      )
      sendJson(response, 200, result ?? { artists: [], albums: [], songs: [] })
    } catch (error) {
      console.error('[RemoteRelay] Failed to search:', error)
      sendJson(response, 500, { ok: false, message: 'failed-to-search' })
    }
  }

  private async handleCoverArt(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const leaseId = this.extractLeaseIdFromQuery(request)
    if (!this.assertLeaseValid(leaseId)) {
      sendJson(response, 403, { ok: false, message: 'invalid-session' })
      return
    }

    const host = request.headers.host ?? '127.0.0.1'
    const parsedUrl = new URL(request.url ?? '/', `http://${host}`)
    const coverArtId = parsedUrl.searchParams.get('id')

    if (!coverArtId) {
      sendJson(response, 400, { ok: false, message: 'missing-id' })
      return
    }

    try {
      const result = await this.fetchFromRenderer<{
        data?: string
        contentType?: string
        url?: string
      }>('get-cover-art', { coverArtId })

      if (result?.data && result?.contentType) {
        response.writeHead(200, {
          'Content-Type': result.contentType,
          'Cache-Control': 'public, max-age=3600',
        })
        response.end(Buffer.from(result.data, 'base64'))
      } else if (result?.url) {
        const upstream = await fetch(result.url)
        if (!upstream.ok) {
          console.warn(
            `[RemoteRelay] upstream cover fetch failed id=${coverArtId} status=${upstream.status}`,
          )
          sendJson(response, 404, { ok: false, message: 'not-found' })
          return
        }

        const contentType =
          upstream.headers.get('content-type') || 'image/jpeg'
        const buffer = Buffer.from(await upstream.arrayBuffer())
        response.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=3600',
        })
        response.end(buffer)
      } else {
        console.warn(
          `[RemoteRelay] cover art payload missing for id=${coverArtId}`,
        )
        sendJson(response, 404, { ok: false, message: 'not-found' })
      }
    } catch (error) {
      console.error('[RemoteRelay] Failed to get cover art:', error)
      sendJson(response, 500, { ok: false, message: 'failed-to-fetch' })
    }
  }

  private extractLeaseIdFromQuery(request: IncomingMessage): string {
    const host = request.headers.host ?? '127.0.0.1'
    const parsedUrl = new URL(request.url ?? '/', `http://${host}`)
    return parsedUrl.searchParams.get('leaseId') ?? ''
  }

  // Serve React Remote Web App
  private async serveRemoteWebApp(response: ServerResponse): Promise<void> {
    const distPath = resolveRemoteWebDistPath()

    console.log(
      '[RemoteRelay] Remote web dist candidates:',
      getRemoteWebDistSearchCandidates(),
    )
    console.log('[RemoteRelay] __dirname:', __dirname)
    console.log('[RemoteRelay] Resolved dist path:', distPath ?? '<not-found>')

    try {
      if (distPath) {
        const indexPath = path.join(distPath, 'index.html')
        console.log('[RemoteRelay] Serving React build')
        const content = await fsp.readFile(indexPath, 'utf-8')
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
        })
        response.end(content)
      } else {
        // Fallback to embedded HTML
        console.log(
          '[RemoteRelay] React build not found, serving fallback HTML',
        )
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        response.end(this.buildRemoteWebHtml())
      }
    } catch (error) {
      console.error('[RemoteRelay] Failed to serve Remote Web app:', error)
      response.writeHead(500, { 'Content-Type': 'text/plain' })
      response.end('Internal Server Error')
    }
  }

  // Serve static assets from React build
  private async serveStaticFile(
    pathname: string,
    response: ServerResponse,
  ): Promise<void> {
    const distPath = resolveRemoteWebDistPath()
    if (!distPath) {
      sendJson(response, 404, {
        ok: false,
        message: 'remote-web-dist-not-found',
      })
      return
    }

    const filePath = path.resolve(distPath, `.${pathname}`)
    const normalizedDistPath = path.resolve(distPath)

    // Security: ensure file is within dist directory
    const isWithinDist =
      filePath === normalizedDistPath ||
      filePath.startsWith(`${normalizedDistPath}${path.sep}`)
    if (!isWithinDist) {
      sendJson(response, 403, { ok: false, message: 'forbidden' })
      return
    }

    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase()
        const contentType = this.getContentType(ext)
        const content = await fsp.readFile(filePath)
        response.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=31536000', // 1 year for assets
        })
        response.end(content)
      } else {
        sendJson(response, 404, { ok: false, message: 'not-found' })
      }
    } catch (error) {
      console.error('[RemoteRelay] Failed to serve static file:', error)
      sendJson(response, 500, { ok: false, message: 'failed-to-serve' })
    }
  }

  private getContentType(ext: string): string {
    const mimeTypes: Record<string, string> = {
      '.js': 'application/javascript',
      '.mjs': 'application/javascript',
      '.css': 'text/css',
      '.html': 'text/html',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ttf': 'font/ttf',
      '.otf': 'font/otf',
      '.eot': 'application/vnd.ms-fontobject',
    }
    return mimeTypes[ext] ?? 'application/octet-stream'
  }
}

export const remoteRelayManager = new RemoteRelayManager()
