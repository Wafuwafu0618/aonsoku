import { createStore, delMany, entries } from 'idb-keyval'
import { httpClient } from '@/api/httpClient'
import {
  createLyricsLookupKey,
  getLyricsByLookupKey,
  getMetadataValue,
  markLyricsError,
  markLyricsNotFound,
  setMetadataValue,
  shouldRetryLyricsFetch,
  upsertLyrics,
  type LyricsLookupInput,
} from '@/local-library'
import { usePlayerStore } from '@/store/player.store'
import {
  ILyric,
  IStructuredLine,
  IStructuredLyric,
  LyricsResponse,
  StructuredLyricsResponse,
} from '@/types/responses/song'
import { lrclibClient } from '@/utils/appName'
import { checkServerType, getServerExtensions } from '@/utils/servers'

interface GetLyricsData {
  id: string
  artist: string
  title: string
  album?: string
  duration?: number
}

interface LRCLibResponse {
  id: number
  trackName: string
  artistName: string
  albumName?: string | null
  duration?: number | null
  instrumental?: boolean
  plainLyrics?: string | null
  syncedLyrics?: string | null
}

interface LrclibLyricResult extends ILyric {
  synced: boolean
  errorMessage?: string
}

interface LrclibLookupCandidate {
  artist: string
  title: string
  album?: string
  duration?: number
}

interface LrclibFetchAttemptResult {
  status: 'found' | 'not_found' | 'error'
  lyric?: LrclibLyricResult
  errorMessage?: string
}

interface PersistLyricsFoundInput {
  lookupInput: LyricsLookupInput
  lookupKey: string
  getLyricsData: GetLyricsData
  lyrics: ILyric
  source: 'lrclib' | 'subsonic'
}

interface PersistLyricsMissInput {
  lookupInput: LyricsLookupInput
  lookupKey: string
  getLyricsData: GetLyricsData
  lastErrorMessage?: string
}

interface LegacyLyricsValue {
  artist: string
  title: string
  value: string
}

interface LegacyLyricsRecord {
  key: string
  value: LegacyLyricsValue
}

export interface LyricsRuntimeMetrics {
  totalRequests: number
  cacheFoundHits: number
  cacheSuppressedByRetry: number
  networkAttempts: number
  successfulResolutions: number
  emptyResolutions: number
  lrclibRequests: number
  lrclibHits: number
  lrclibNotFound: number
  lrclibErrors: number
  legacyMigrationRuns: number
  legacyEntriesMigrated: number
}

const LEGACY_LYRICS_DB_NAME = 'keyval-store'
const LEGACY_LYRICS_STORE_NAME = 'keyval'
const LEGACY_LYRICS_PREFIX = 'lyrics:'
const LEGACY_LYRICS_MIGRATION_META_KEY = 'lyrics:legacy-migration:v1'

const lyricsRuntimeMetrics: LyricsRuntimeMetrics = {
  totalRequests: 0,
  cacheFoundHits: 0,
  cacheSuppressedByRetry: 0,
  networkAttempts: 0,
  successfulResolutions: 0,
  emptyResolutions: 0,
  lrclibRequests: 0,
  lrclibHits: 0,
  lrclibNotFound: 0,
  lrclibErrors: 0,
  legacyMigrationRuns: 0,
  legacyEntriesMigrated: 0,
}

let legacyMigrationPromise: Promise<void> | undefined
const legacyLyricsStore = createStore(
  LEGACY_LYRICS_DB_NAME,
  LEGACY_LYRICS_STORE_NAME,
)

function incrementLyricsMetric(
  metric: keyof LyricsRuntimeMetrics,
  amount = 1,
): void {
  lyricsRuntimeMetrics[metric] += amount
}

function countLyricsResolution(lyricsValue: string | undefined): void {
  if (formatLyrics(lyricsValue ?? '') === '') {
    incrementLyricsMetric('emptyResolutions')
    return
  }

  incrementLyricsMetric('successfulResolutions')
}

function isLegacyLyricsValue(value: unknown): value is LegacyLyricsValue {
  if (!value || typeof value !== 'object') return false

  const candidate = value as Partial<LegacyLyricsValue>
  return (
    typeof candidate.artist === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.value === 'string'
  )
}

function parseLegacyLyricsLookupFlags(
  legacyKey: string,
): Pick<LyricsLookupInput, 'preferSyncedLyrics' | 'songLyricsEnabled'> | null {
  const parts = legacyKey.split(':')
  if (parts.length < 5 || parts[0] !== 'lyrics') return null

  const type = parts[parts.length - 2]
  const serverExtension = parts[parts.length - 1]
  if (!type || !serverExtension) return null

  if (type !== 'synced' && type !== 'plain') return null
  if (serverExtension !== 'internal' && serverExtension !== 'external') {
    return null
  }

  return {
    preferSyncedLyrics: type === 'synced',
    songLyricsEnabled: serverExtension === 'internal',
  }
}

function toLegacyLyricsRecord(
  entry: [IDBValidKey, unknown],
): LegacyLyricsRecord | null {
  const [key, value] = entry
  if (typeof key !== 'string' || !key.startsWith(LEGACY_LYRICS_PREFIX)) {
    return null
  }
  if (!isLegacyLyricsValue(value)) return null

  const normalizedValue = formatLyrics(value.value)
  if (normalizedValue === '') return null

  return {
    key,
    value: {
      artist: value.artist,
      title: value.title,
      value: normalizedValue,
    },
  }
}

async function migrateLegacyLyricsCache(): Promise<number> {
  const legacyEntries = await entries<string, unknown>(legacyLyricsStore)
  if (legacyEntries.length === 0) return 0

  const now = Date.now()
  const migratedKeys: IDBValidKey[] = []
  let migratedCount = 0

  for (const entry of legacyEntries) {
    const legacyRecord = toLegacyLyricsRecord(entry)
    if (!legacyRecord) continue

    const legacyLookupFlags = parseLegacyLyricsLookupFlags(legacyRecord.key)
    if (!legacyLookupFlags) continue

    const lookupInput: LyricsLookupInput = {
      artist: legacyRecord.value.artist,
      title: legacyRecord.value.title,
      preferSyncedLyrics: legacyLookupFlags.preferSyncedLyrics,
      songLyricsEnabled: legacyLookupFlags.songLyricsEnabled,
    }
    const lookupKey = createLyricsLookupKey(lookupInput)

    await upsertLyrics({
      lookupKey,
      artist: legacyRecord.value.artist,
      title: legacyRecord.value.title,
      preferSyncedLyrics: lookupInput.preferSyncedLyrics,
      songLyricsEnabled: lookupInput.songLyricsEnabled,
      status: 'found',
      value: legacyRecord.value.value,
      synced: isSyncedLyric(legacyRecord.value.value),
      source: 'subsonic',
      failureCount: 0,
      nextRetryAt: 0,
      updatedAt: now,
    })

    migratedKeys.push(legacyRecord.key)
    migratedCount += 1
  }

  if (migratedKeys.length > 0) {
    await delMany(migratedKeys, legacyLyricsStore)
  }

  return migratedCount
}

async function ensureLegacyLyricsCacheMigrated(): Promise<void> {
  if (legacyMigrationPromise) return legacyMigrationPromise

  legacyMigrationPromise = (async () => {
    const isMigrationCompleted = await getMetadataValue<boolean>(
      LEGACY_LYRICS_MIGRATION_META_KEY,
    )
    if (isMigrationCompleted) return

    incrementLyricsMetric('legacyMigrationRuns')

    const migratedCount = await migrateLegacyLyricsCache()
    if (migratedCount > 0) {
      incrementLyricsMetric('legacyEntriesMigrated', migratedCount)
    }

    await setMetadataValue(LEGACY_LYRICS_MIGRATION_META_KEY, true)
  })().catch(() => {})

  return legacyMigrationPromise
}

function getLyricsRuntimeMetrics(): LyricsRuntimeMetrics {
  return { ...lyricsRuntimeMetrics }
}

function resetLyricsRuntimeMetrics(): void {
  const metricKeys = Object.keys(
    lyricsRuntimeMetrics,
  ) as Array<keyof LyricsRuntimeMetrics>

  for (const key of metricKeys) {
    lyricsRuntimeMetrics[key] = 0
  }
}

function toLyricsLookupInput(
  getLyricsData: GetLyricsData,
  preferSyncedLyrics: boolean,
  songLyricsEnabled?: boolean,
): LyricsLookupInput {
  return {
    artist: getLyricsData.artist,
    title: getLyricsData.title,
    album: getLyricsData.album,
    duration: getLyricsData.duration,
    preferSyncedLyrics,
    songLyricsEnabled: Boolean(songLyricsEnabled),
  }
}

function createLegacyCompatibleLookupKey(input: LyricsLookupInput): string {
  return createLyricsLookupKey({
    ...input,
    album: undefined,
    duration: undefined,
  })
}

async function getLyrics(getLyricsData: GetLyricsData) {
  incrementLyricsMetric('totalRequests')
  await ensureLegacyLyricsCacheMigrated()

  const { preferSyncedLyrics } = usePlayerStore.getState().settings.lyrics
  const { songLyricsEnabled } = getServerExtensions()
  const lookupInput = toLyricsLookupInput(
    getLyricsData,
    preferSyncedLyrics,
    songLyricsEnabled,
  )
  const lookupKey = createLyricsLookupKey(lookupInput)
  const legacyCompatibleLookupKey = createLegacyCompatibleLookupKey(lookupInput)

  const cachedLyricsByLookupKey = await getLyricsByLookupKey(lookupKey)
  const cachedLyrics =
    cachedLyricsByLookupKey ??
    (legacyCompatibleLookupKey !== lookupKey
      ? await getLyricsByLookupKey(legacyCompatibleLookupKey)
      : undefined)

  if (cachedLyrics?.status === 'found' && cachedLyrics.value) {
    if (cachedLyrics.lookupKey !== lookupKey) {
      await safelyPersist(async () => {
        await upsertLyrics({
          ...cachedLyrics,
          lookupKey,
          album: lookupInput.album,
          duration: lookupInput.duration,
          updatedAt: Date.now(),
        })
      })
    }

    incrementLyricsMetric('cacheFoundHits')
    countLyricsResolution(cachedLyrics.value)
    return {
      artist: cachedLyrics.artist,
      title: cachedLyrics.title,
      value: cachedLyrics.value,
    }
  }

  if (!shouldRetryLyricsFetch(cachedLyrics)) {
    incrementLyricsMetric('cacheSuppressedByRetry')
    countLyricsResolution('')
    return toEmptyLyric(getLyricsData.artist, getLyricsData.title)
  }

  incrementLyricsMetric('networkAttempts')

  let osUnsyncedLyricsFound: ILyric | undefined
  let lastErrorMessage: string | undefined

  // First attempt to retrieve lyrics from the server.
  // If we know it supports the OpenSubsonic songLyrics extension with timing info, use that.
  // If the server does not support the extension or the lyrics returned from the server did
  // not include timing information, fetch them from the LrcLib
  if (songLyricsEnabled) {
    try {
      const response = await httpClient<StructuredLyricsResponse>(
        '/getLyricsBySongId',
        {
          method: 'GET',
          query: {
            id: getLyricsData.id,
          },
        },
      )

      if (response && preferSyncedLyrics) {
        const { structuredLyrics } = response.data.lyricsList

        if (structuredLyrics && structuredLyrics.length > 0) {
          const syncedLyrics = structuredLyrics.find((lyrics) => lyrics.synced)

          if (syncedLyrics) {
            const serverSyncedLyrics = osStructuredLyricsToILyric(syncedLyrics)
            await persistLyricsFound({
              lookupInput,
              lookupKey,
              getLyricsData,
              lyrics: serverSyncedLyrics,
              source: 'subsonic',
            })

            countLyricsResolution(serverSyncedLyrics.value)
            return serverSyncedLyrics
          }

          // Save the plain lyrics retrieved from the server
          const firstStructuredLyrics = structuredLyrics[0]
          if (firstStructuredLyrics) {
            osUnsyncedLyricsFound = osStructuredLyricsToILyric(
              firstStructuredLyrics,
            )
          }
        }
      }
    } catch (error) {
      lastErrorMessage = toErrorMessage(error)
    }
  }

  if (preferSyncedLyrics) {
    const lrclibLyrics = await getLyricsFromLRCLib(getLyricsData)

    if (lrclibLyrics.value) {
      await persistLyricsFound({
        lookupInput,
        lookupKey,
        getLyricsData,
        lyrics: lrclibLyrics,
        source: 'lrclib',
      })

      countLyricsResolution(lrclibLyrics.value)
      return lrclibLyrics
    }

    if (lrclibLyrics.errorMessage) {
      lastErrorMessage = lrclibLyrics.errorMessage
    }
  }

  // If the server supported the songLyrics extension and lrc did not have lyrics, we don't need to query the server and lrc again.
  // so return the plain lyrics if we found them
  if (osUnsyncedLyricsFound) {
    await persistLyricsFound({
      lookupInput,
      lookupKey,
      getLyricsData,
      lyrics: osUnsyncedLyricsFound,
      source: 'subsonic',
    })

    countLyricsResolution(osUnsyncedLyricsFound.value)
    return osUnsyncedLyricsFound
  }

  let response: LyricsResponse | undefined
  try {
    response = await httpClient<LyricsResponse>('/getLyrics', {
      method: 'GET',
      query: {
        artist: getLyricsData.artist,
        title: getLyricsData.title,
      },
    })
  } catch (error) {
    lastErrorMessage = toErrorMessage(error)
  }

  const lyricsFromServer = response?.data.lyrics
  const lyricValue = formatLyrics(lyricsFromServer?.value ?? '')
  const lyricNotFound = lyricValue === ''

  // If the Subsonic API did not return lyrics and the user does not prefer synced lyrics,
  // fallback to fetching lyrics from the LrcLib.
  // Note: If `preferSyncedLyrics` is true and we reached this point, it means the LrcLib
  // does not contain lyrics for the track, so the fallback is unnecessary in that case.
  if (lyricNotFound && !preferSyncedLyrics) {
    const lrclibLyrics = await getLyricsFromLRCLib(getLyricsData)

    if (lrclibLyrics.value) {
      await persistLyricsFound({
        lookupInput,
        lookupKey,
        getLyricsData,
        lyrics: lrclibLyrics,
        source: 'lrclib',
      })

      countLyricsResolution(lrclibLyrics.value)
      return lrclibLyrics
    }

    if (lrclibLyrics.errorMessage) {
      lastErrorMessage = lrclibLyrics.errorMessage
    }

    await persistLyricsMiss({
      lookupInput,
      lookupKey,
      getLyricsData,
      lastErrorMessage,
    })

    countLyricsResolution(lrclibLyrics.value)
    return lrclibLyrics
  }

  if (!lyricNotFound && lyricsFromServer) {
    const normalizedLyrics: ILyric = {
      artist: lyricsFromServer.artist ?? getLyricsData.artist,
      title: lyricsFromServer.title ?? getLyricsData.title,
      value: lyricValue,
    }

    await persistLyricsFound({
      lookupInput,
      lookupKey,
      getLyricsData,
      lyrics: normalizedLyrics,
      source: 'subsonic',
    })

    countLyricsResolution(normalizedLyrics.value)
    return normalizedLyrics
  }

  await persistLyricsMiss({
    lookupInput,
    lookupKey,
    getLyricsData,
    lastErrorMessage,
  })

  countLyricsResolution('')
  return toEmptyLyric(getLyricsData.artist, getLyricsData.title)
}

function normalizeLrclibText(value: string | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^0-9a-z\u3040-\u30ff\u3400-\u9fff\s]/gi, ' ')
    .replace(/\s+/g, ' ')
}

function toPrimaryArtistName(artist: string): string {
  const trimmed = artist.trim()
  if (trimmed === '') return ''

  const withoutFeature = trimmed
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.+$/i, '')
    .trim()
  const splitCandidates = withoutFeature.split(/\s*(?:,|&|\/|、|・|×)\s*/g)
  const firstCandidate = splitCandidates[0]?.trim()

  return firstCandidate && firstCandidate.length > 0
    ? firstCandidate
    : withoutFeature
}

function normalizeTrackTitleForLookup(title: string): string {
  const withoutFeature = title
    .replace(/\s*[-–—]?\s*(?:feat\.?|ft\.?|featuring)\s+.+$/i, '')
    .trim()
  const withoutTrailingBracket = withoutFeature
    .replace(/\s*[\(\[\{][^\)\]\}]*[\)\]\}]\s*$/g, '')
    .trim()

  return withoutTrailingBracket || withoutFeature || title
}

function resolveLrclibApiBaseUrl(): string {
  const { lrclib } = usePlayerStore.getState().settings.privacy
  const defaultBaseUrl = 'https://lrclib.net'

  if (!lrclib.customUrlEnabled || lrclib.customUrl.trim() === '') {
    return `${defaultBaseUrl}/api`
  }

  const normalizedCustomBase = lrclib.customUrl.replace(/\/+$/, '')
  return `${normalizedCustomBase}/api`
}

function toLrclibLyricResult(
  response: LRCLibResponse,
  fallback: Pick<LrclibLookupCandidate, 'artist' | 'title'>,
): LrclibLyricResult {
  const finalLyric = response.syncedLyrics || response.plainLyrics || ''
  const formattedLyrics = formatLyrics(finalLyric)

  return {
    artist: (response.artistName || fallback.artist).trim(),
    title: (response.trackName || fallback.title).trim(),
    value: formattedLyrics,
    synced: isSyncedLyric(formattedLyrics),
  }
}

function createLrclibLookupCandidates(
  base: LrclibLookupCandidate,
): LrclibLookupCandidate[] {
  const primaryArtist = toPrimaryArtistName(base.artist)
  const normalizedTitle = normalizeTrackTitleForLookup(base.title)
  const candidates: LrclibLookupCandidate[] = [
    {
      artist: base.artist,
      title: base.title,
      album: base.album,
      duration: base.duration,
    },
    {
      artist: base.artist,
      title: base.title,
      album: base.album,
    },
    {
      artist: base.artist,
      title: base.title,
    },
    {
      artist: primaryArtist || base.artist,
      title: normalizedTitle || base.title,
    },
  ]

  const seen = new Set<string>()
  const deduped: LrclibLookupCandidate[] = []

  for (const candidate of candidates) {
    const key = [
      normalizeLrclibText(candidate.artist),
      normalizeLrclibText(candidate.title),
      normalizeLrclibText(candidate.album),
      typeof candidate.duration === 'number' ? String(Math.round(candidate.duration)) : '',
    ].join('|')

    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(candidate)
  }

  return deduped
}

async function fetchLrclibLyricsByGet(
  apiBaseUrl: string,
  candidate: LrclibLookupCandidate,
): Promise<LrclibFetchAttemptResult> {
  try {
    incrementLyricsMetric('lrclibRequests')

    const params = new URLSearchParams({
      artist_name: candidate.artist,
      track_name: candidate.title,
    })

    if (typeof candidate.duration === 'number' && Number.isFinite(candidate.duration)) {
      params.append('duration', String(Math.round(candidate.duration)))
    }
    if (candidate.album && candidate.album.trim().length > 0) {
      params.append('album_name', candidate.album)
    }

    const requestUrl = new URL(`${apiBaseUrl}/get`)
    requestUrl.search = params.toString()

    const request = await fetch(requestUrl.toString(), {
      headers: {
        'Lrclib-Client': lrclibClient,
      },
    })

    if (request.status === 404) {
      incrementLyricsMetric('lrclibNotFound')
      return { status: 'not_found' }
    }

    if (!request.ok) {
      incrementLyricsMetric('lrclibErrors')
      return {
        status: 'error',
        errorMessage: `LRCLIB request failed with status ${request.status}`,
      }
    }

    const response: LRCLibResponse = await request.json()
    const lyric = toLrclibLyricResult(response, candidate)

    if (lyric.value === '') {
      incrementLyricsMetric('lrclibNotFound')
      return { status: 'not_found' }
    }

    incrementLyricsMetric('lrclibHits')
    return {
      status: 'found',
      lyric,
    }
  } catch (error) {
    incrementLyricsMetric('lrclibErrors')
    return {
      status: 'error',
      errorMessage: toErrorMessage(error),
    }
  }
}

function scoreLrclibSearchCandidate(
  candidate: LRCLibResponse,
  target: Pick<LrclibLookupCandidate, 'artist' | 'title' | 'duration'>,
): number {
  const normalizedCandidateArtist = normalizeLrclibText(candidate.artistName)
  const normalizedCandidateTitle = normalizeLrclibText(candidate.trackName)
  const normalizedTargetArtist = normalizeLrclibText(target.artist)
  const normalizedTargetTitle = normalizeLrclibText(target.title)

  let score = 0
  if (normalizedCandidateArtist === normalizedTargetArtist) {
    score += 5
  } else if (
    normalizedCandidateArtist.includes(normalizedTargetArtist) ||
    normalizedTargetArtist.includes(normalizedCandidateArtist)
  ) {
    score += 3
  }

  if (normalizedCandidateTitle === normalizedTargetTitle) {
    score += 5
  } else if (
    normalizedCandidateTitle.includes(normalizedTargetTitle) ||
    normalizedTargetTitle.includes(normalizedCandidateTitle)
  ) {
    score += 3
  }

  if (
    typeof target.duration === 'number' &&
    Number.isFinite(target.duration) &&
    typeof candidate.duration === 'number' &&
    Number.isFinite(candidate.duration)
  ) {
    const durationDiff = Math.abs(Math.round(target.duration) - Math.round(candidate.duration))
    if (durationDiff <= 2) score += 2
    else if (durationDiff <= 5) score += 1
  }

  return score
}

async function fetchLrclibLyricsBySearch(
  apiBaseUrl: string,
  candidate: Pick<LrclibLookupCandidate, 'artist' | 'title' | 'duration'>,
): Promise<LrclibFetchAttemptResult> {
  try {
    incrementLyricsMetric('lrclibRequests')

    const params = new URLSearchParams({
      artist_name: candidate.artist,
      track_name: candidate.title,
    })
    const requestUrl = new URL(`${apiBaseUrl}/search`)
    requestUrl.search = params.toString()

    const request = await fetch(requestUrl.toString(), {
      headers: {
        'Lrclib-Client': lrclibClient,
      },
    })

    if (request.status === 404) {
      incrementLyricsMetric('lrclibNotFound')
      return { status: 'not_found' }
    }

    if (!request.ok) {
      incrementLyricsMetric('lrclibErrors')
      return {
        status: 'error',
        errorMessage: `LRCLIB search failed with status ${request.status}`,
      }
    }

    const response = (await request.json()) as LRCLibResponse[] | undefined
    const candidates = Array.isArray(response) ? response : []
    if (candidates.length === 0) {
      incrementLyricsMetric('lrclibNotFound')
      return { status: 'not_found' }
    }

    const bestMatch = candidates
      .slice()
      .sort(
        (left, right) =>
          scoreLrclibSearchCandidate(right, candidate) -
          scoreLrclibSearchCandidate(left, candidate),
      )[0]

    if (!bestMatch) {
      incrementLyricsMetric('lrclibNotFound')
      return { status: 'not_found' }
    }

    const lyric = toLrclibLyricResult(bestMatch, candidate)
    if (lyric.value === '') {
      incrementLyricsMetric('lrclibNotFound')
      return { status: 'not_found' }
    }

    incrementLyricsMetric('lrclibHits')
    return {
      status: 'found',
      lyric,
    }
  } catch (error) {
    incrementLyricsMetric('lrclibErrors')
    return {
      status: 'error',
      errorMessage: toErrorMessage(error),
    }
  }
}

async function getLyricsFromLRCLib(
  getLyricsData: GetLyricsData,
): Promise<LrclibLyricResult> {
  const { lrclib } = usePlayerStore.getState().settings.privacy
  const { isLms } = checkServerType()

  const { title, album, duration } = getLyricsData

  // LMS server tends to join all artists into a single string
  // Ex: "Cartoon, Jeja, Daniel Levi, Time To Talk"
  // To LRCLIB work correctly, we have to send only one
  const artist = isLms
    ? getLyricsData.artist.split(',')[0]
    : getLyricsData.artist

  if (!lrclib.enabled || window.DISABLE_LRCLIB) {
    return {
      artist,
      title,
      value: '',
      synced: false,
    }
  }

  const apiBaseUrl = resolveLrclibApiBaseUrl()
  const lookupCandidates = createLrclibLookupCandidates({
    artist,
    title,
    album,
    duration,
  })
  let lastErrorMessage: string | undefined

  for (const candidate of lookupCandidates) {
    const attempt = await fetchLrclibLyricsByGet(apiBaseUrl, candidate)
    if (attempt.status === 'found' && attempt.lyric) {
      return attempt.lyric
    }
    if (attempt.status === 'error' && attempt.errorMessage) {
      lastErrorMessage = attempt.errorMessage
    }
  }

  const seenSearchCandidates = new Set<string>()
  const searchCandidates = lookupCandidates
    .map((candidate) => ({
      artist: candidate.artist,
      title: candidate.title,
      duration: candidate.duration,
    }))
    .filter((candidate) => {
      const key = [
        normalizeLrclibText(candidate.artist),
        normalizeLrclibText(candidate.title),
      ].join('|')
      if (seenSearchCandidates.has(key)) return false
      seenSearchCandidates.add(key)
      return true
    })
    .slice(0, 2)

  for (const candidate of searchCandidates) {
    const attempt = await fetchLrclibLyricsBySearch(apiBaseUrl, candidate)
    if (attempt.status === 'found' && attempt.lyric) {
      return attempt.lyric
    }
    if (attempt.status === 'error' && attempt.errorMessage) {
      lastErrorMessage = attempt.errorMessage
    }
  }

  return {
    artist,
    title,
    value: '',
    synced: false,
    errorMessage: lastErrorMessage,
  }
}

function formatLyrics(lyrics: string) {
  return lyrics.trim().replaceAll('\r\n', '\n')
}

function toEmptyLyric(artist: string, title: string): ILyric {
  return {
    artist,
    title,
    value: '',
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'Unknown error'
}

function isSyncedLyric(lyrics: string): boolean {
  const lyric = lyrics.trim()
  return (
    lyric.startsWith('[00:') ||
    lyric.startsWith('[01:') ||
    lyric.startsWith('[02:')
  )
}

async function safelyPersist(operation: () => Promise<void>): Promise<void> {
  try {
    await operation()
  } catch {}
}

async function persistLyricsFound({
  lookupInput,
  lookupKey,
  getLyricsData,
  lyrics,
  source,
}: PersistLyricsFoundInput): Promise<void> {
  const value = formatLyrics(lyrics.value ?? '')
  if (value === '') return

  await safelyPersist(async () => {
    await upsertLyrics({
      lookupKey,
      trackId: getLyricsData.id,
      artist: lyrics.artist ?? getLyricsData.artist,
      title: lyrics.title ?? getLyricsData.title,
      album: getLyricsData.album,
      duration: getLyricsData.duration,
      preferSyncedLyrics: lookupInput.preferSyncedLyrics,
      songLyricsEnabled: lookupInput.songLyricsEnabled,
      status: 'found',
      value,
      synced: isSyncedLyric(value),
      source,
      failureCount: 0,
      nextRetryAt: 0,
      updatedAt: Date.now(),
    })
  })
}

async function persistLyricsMiss({
  lookupInput,
  lookupKey,
  getLyricsData,
  lastErrorMessage,
}: PersistLyricsMissInput): Promise<void> {
  await safelyPersist(async () => {
    if (lastErrorMessage) {
      await markLyricsError({
        ...lookupInput,
        lookupKey,
        trackId: getLyricsData.id,
        errorMessage: lastErrorMessage,
      })
      return
    }

    await markLyricsNotFound({
      ...lookupInput,
      lookupKey,
      trackId: getLyricsData.id,
    })
  })
}

function osStructuredLyricsToILyric(lyrics: IStructuredLyric): ILyric {
  return {
    artist: lyrics.displayArtist,
    title: lyrics.displayTitle,
    value: formatLyrics(lyrics.line.map(osLineToILyricLine).join('\n')),
  }
}

function osLineToILyricLine(line: IStructuredLine): string {
  if (line.start !== undefined) {
    return `[${osStartMsToSongTimestamp(line.start)}] ${line.value}`
  }
  return line.value
}

function osStartMsToSongTimestamp(startTime: number): string {
  // Date() isoString is formatted as:
  // YYYY-MM-DDTHH:mm:ss.sssZ -> mm:ss.ss
  // 2011-10-05T14:48:00.000Z -> 48:00.00
  return new Date(startTime).toISOString().slice(14, -2)
}

export const lyrics = {
  getLyrics,
  getLyricsFromLRCLib,
  getRuntimeMetrics: getLyricsRuntimeMetrics,
  resetRuntimeMetrics: resetLyricsRuntimeMetrics,
}
