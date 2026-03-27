import { useEffect, useRef } from 'react'
import type { RemotePlaybackTarget } from '../lib/remoteApi'

interface PcmChunk {
  left: Float32Array
  right: Float32Array
  offset: number
}

interface UseRemoteAudioStreamOptions {
  leaseId: string | undefined
  playbackTarget: RemotePlaybackTarget | undefined
  canStream: boolean
}

const DEFAULT_SAMPLE_RATE = 48_000
const DEFAULT_CHANNELS = 2
const MAX_BUFFERED_SECONDS = 2
const RECONNECT_DELAY_MS = 1_200

export function useRemoteAudioStream({
  leaseId,
  playbackTarget,
  canStream,
}: UseRemoteAudioStreamOptions): void {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const generationRef = useRef(0)
  const shouldConnectRef = useRef(false)

  const audioContextRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const queueRef = useRef<PcmChunk[]>([])
  const queuedFramesRef = useRef(0)

  const formatRef = useRef({
    sampleRate: DEFAULT_SAMPLE_RATE,
    channels: DEFAULT_CHANNELS,
  })

  function clearAudioQueue() {
    queueRef.current = []
    queuedFramesRef.current = 0
  }

  function destroyAudioEngine() {
    const processor = processorRef.current
    const context = audioContextRef.current

    if (processor) {
      try {
        processor.disconnect()
      } catch {
        // noop
      }
    }

    if (context) {
      void context.close().catch(() => {
        // noop
      })
    }

    processorRef.current = null
    audioContextRef.current = null
    clearAudioQueue()
  }

  function ensureAudioEngine() {
    if (audioContextRef.current && processorRef.current) return
    if (typeof window === 'undefined') return

    const AudioContextCtor =
      window.AudioContext ||
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((window as any).webkitAudioContext as typeof AudioContext | undefined)
    if (!AudioContextCtor) return

    const context = new AudioContextCtor({
      sampleRate: formatRef.current.sampleRate,
    })
    const processor = context.createScriptProcessor(2048, 0, 2)

    processor.onaudioprocess = (event) => {
      const outputLeft = event.outputBuffer.getChannelData(0)
      const outputRight = event.outputBuffer.getChannelData(1)
      const outputFrames = outputLeft.length
      let writeOffset = 0

      while (writeOffset < outputFrames) {
        const chunk = queueRef.current[0]
        if (!chunk) break

        const available = chunk.left.length - chunk.offset
        const copyFrames = Math.min(available, outputFrames - writeOffset)
        outputLeft.set(
          chunk.left.subarray(chunk.offset, chunk.offset + copyFrames),
          writeOffset,
        )
        outputRight.set(
          chunk.right.subarray(chunk.offset, chunk.offset + copyFrames),
          writeOffset,
        )

        chunk.offset += copyFrames
        writeOffset += copyFrames
        queuedFramesRef.current = Math.max(
          0,
          queuedFramesRef.current - copyFrames,
        )

        if (chunk.offset >= chunk.left.length) {
          queueRef.current.shift()
        }
      }

      if (writeOffset < outputFrames) {
        outputLeft.fill(0, writeOffset)
        outputRight.fill(0, writeOffset)
      }
    }

    processor.connect(context.destination)
    audioContextRef.current = context
    processorRef.current = processor
  }

  async function resumeAudioEngine() {
    ensureAudioEngine()
    const context = audioContextRef.current
    if (!context) return
    if (context.state === 'running') return
    try {
      await context.resume()
    } catch {
      // Autoplay policyにより拒否される場合は次のユーザー操作で再試行する
    }
  }

  function resetAudioEngineForFormatChange() {
    const context = audioContextRef.current
    if (!context) return
    if (context.sampleRate === formatRef.current.sampleRate) return
    destroyAudioEngine()
  }

  function pushPcmChunk(bufferLike: ArrayBuffer) {
    if (!(bufferLike instanceof ArrayBuffer)) return
    ensureAudioEngine()

    const channels = Math.max(1, Math.floor(formatRef.current.channels))
    const samples = new Int16Array(bufferLike)
    const frames = Math.floor(samples.length / channels)
    if (frames <= 0) return

    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    for (let i = 0; i < frames; i += 1) {
      const base = i * channels
      left[i] = samples[base] / 32768
      right[i] = channels > 1 ? samples[base + 1] / 32768 : left[i]
    }

    queueRef.current.push({
      left,
      right,
      offset: 0,
    })
    queuedFramesRef.current += frames

    const maxFrames = Math.max(
      formatRef.current.sampleRate,
      Math.floor(formatRef.current.sampleRate * MAX_BUFFERED_SECONDS),
    )
    while (queuedFramesRef.current > maxFrames && queueRef.current.length > 1) {
      const dropped = queueRef.current.shift()
      if (!dropped) break
      queuedFramesRef.current = Math.max(
        0,
        queuedFramesRef.current - Math.max(0, dropped.left.length - dropped.offset),
      )
    }
  }

  function closeAudioSocket() {
    generationRef.current += 1
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }

    const ws = wsRef.current
    wsRef.current = null
    if (!ws) return
    try {
      ws.close()
    } catch {
      // noop
    }
  }

  function connectAudioSocket() {
    if (!leaseId || typeof window === 'undefined') return
    closeAudioSocket()
    const generation = generationRef.current

    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl =
      `${scheme}//${window.location.host}/ws/audio?leaseId=` +
      encodeURIComponent(leaseId)
    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.addEventListener('open', () => {
      void resumeAudioEngine()
    })

    ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        try {
          const payload = JSON.parse(event.data) as {
            type?: string
            sampleRate?: number
            channels?: number
          }
          if (payload?.type === 'format') {
            formatRef.current.sampleRate =
              Number.isFinite(payload.sampleRate) && (payload.sampleRate ?? 0) > 0
                ? Math.floor(payload.sampleRate as number)
                : DEFAULT_SAMPLE_RATE
            formatRef.current.channels =
              Number.isFinite(payload.channels) && (payload.channels ?? 0) > 0
                ? Math.floor(payload.channels as number)
                : DEFAULT_CHANNELS
            clearAudioQueue()
            resetAudioEngineForFormatChange()
          }
        } catch {
          // noop
        }
        return
      }

      if (event.data instanceof ArrayBuffer) {
        pushPcmChunk(event.data)
        return
      }

      if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then((buffer) => {
          pushPcmChunk(buffer)
        })
      }
    })

    ws.addEventListener('close', () => {
      if (generation !== generationRef.current) return
      if (wsRef.current === ws) {
        wsRef.current = null
      }
      if (!shouldConnectRef.current) return
      reconnectTimerRef.current = setTimeout(() => {
        connectAudioSocket()
      }, RECONNECT_DELAY_MS)
    })
  }

  const shouldConnect =
    Boolean(leaseId) && playbackTarget === 'mobile' && canStream === true

  useEffect(() => {
    shouldConnectRef.current = shouldConnect
    if (!shouldConnect) {
      closeAudioSocket()
      destroyAudioEngine()
      return
    }

    connectAudioSocket()
    return () => {
      closeAudioSocket()
      destroyAudioEngine()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaseId, playbackTarget, canStream])

  useEffect(() => {
    if (!shouldConnect) return
    const resume = () => {
      void resumeAudioEngine()
    }
    window.addEventListener('pointerdown', resume, { passive: true })
    window.addEventListener('touchstart', resume, { passive: true })
    window.addEventListener('keydown', resume)
    return () => {
      window.removeEventListener('pointerdown', resume)
      window.removeEventListener('touchstart', resume)
      window.removeEventListener('keydown', resume)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldConnect])
}
