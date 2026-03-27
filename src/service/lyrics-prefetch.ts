import { lyrics } from './lyrics'
import { usePlayerStore } from '@/store/player.store'

export interface LyricsPrefetchRequest {
  id: string
  artist: string
  title: string
  album?: string
  duration?: number
}

const MAX_CONCURRENT_PREFETCH = 2
const COMPLETED_KEY_LIMIT = 20_000
const queuedRequests: LyricsPrefetchRequest[] = []
const queuedKeys = new Set<string>()
const completedKeys = new Set<string>()
let activeJobs = 0

function normalizePrefetchPart(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function normalizeDuration(duration: number | undefined): string {
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    return ''
  }
  return String(Math.round(duration))
}

function toPrefetchKey(request: LyricsPrefetchRequest): string {
  return [
    normalizePrefetchPart(request.id),
    normalizePrefetchPart(request.artist),
    normalizePrefetchPart(request.title),
    normalizePrefetchPart(request.album),
    normalizeDuration(request.duration),
  ].join('|')
}

function canPrefetchLyrics(): boolean {
  const { lrclib } = usePlayerStore.getState().settings.privacy
  return lrclib.enabled && !window.DISABLE_LRCLIB
}

function processQueue(): void {
  if (!canPrefetchLyrics()) {
    queuedRequests.length = 0
    queuedKeys.clear()
    return
  }

  while (activeJobs < MAX_CONCURRENT_PREFETCH && queuedRequests.length > 0) {
    const nextRequest = queuedRequests.shift()
    if (!nextRequest) break

    const requestKey = toPrefetchKey(nextRequest)
    queuedKeys.delete(requestKey)

    activeJobs += 1

    void lyrics
      .getLyrics(nextRequest)
      .catch(() => {
        // Intentionally ignored: prefetch failures are non-fatal.
      })
      .finally(() => {
        activeJobs -= 1
        if (completedKeys.size >= COMPLETED_KEY_LIMIT) {
          completedKeys.clear()
        }
        completedKeys.add(requestKey)
        processQueue()
      })
  }
}

function isValidPrefetchRequest(request: LyricsPrefetchRequest): boolean {
  return (
    request.id.trim().length > 0 &&
    request.artist.trim().length > 0 &&
    request.title.trim().length > 0
  )
}

export function enqueueLyricsPrefetch(request: LyricsPrefetchRequest): void {
  if (!canPrefetchLyrics()) return
  if (!isValidPrefetchRequest(request)) return

  const requestKey = toPrefetchKey(request)
  if (queuedKeys.has(requestKey) || completedKeys.has(requestKey)) return

  queuedKeys.add(requestKey)
  queuedRequests.push(request)
  processQueue()
}

export function enqueueLyricsPrefetchBatch(
  requests: LyricsPrefetchRequest[],
): void {
  if (!canPrefetchLyrics()) return

  for (const request of requests) {
    enqueueLyricsPrefetch(request)
  }
}

export function resetLyricsPrefetchQueue(): void {
  queuedRequests.length = 0
  queuedKeys.clear()
  completedKeys.clear()
  activeJobs = 0
}
