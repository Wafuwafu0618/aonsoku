import { spotifyConnectOAuthRefresh } from '@/platform'
import { logger } from '@/utils/logger'

const SPOTIFY_WEB_API_BASE_URL = 'https://api.spotify.com/v1'
const OAUTH_CACHE_KEY = 'spotify-connect-oauth-cache-v1'
const TOKEN_REFRESH_SKEW_MS = 30_000
const FALLBACK_TOKEN_TTL_MS = 45 * 60 * 1000

interface SpotifyOAuthCachePayload {
  clientId?: string
  redirectPortInput?: string
  refreshToken?: string
  accessToken?: string
  tokenExpiresAtEpochMs?: number
}

interface SpotifySearchArtist {
  id: string
  name: string
  uri: string
}

interface SpotifySearchAlbum {
  id: string
  name: string
  uri: string
  release_date?: string
  images?: Array<{
    url: string
    width?: number
    height?: number
  }>
  artists: SpotifySearchArtist[]
}

interface SpotifySearchTrackItem {
  id: string
  name: string
  uri: string
  duration_ms: number
  disc_number?: number
  track_number?: number
  album: SpotifySearchAlbum
  artists: SpotifySearchArtist[]
}

interface SpotifySearchTracksResponse {
  tracks?: {
    items: SpotifySearchTrackItem[]
    total: number
    limit: number
    offset: number
  }
}

interface SpotifyPlaybackDeviceResponse {
  id?: string
  volume_percent?: number
}

interface SpotifyPlaybackArtistResponse {
  name?: string
}

interface SpotifyPlaybackAlbumResponse {
  name?: string
  images?: Array<{
    url?: string
    width?: number
    height?: number
  }>
}

interface SpotifyPlaybackTrackResponse {
  uri?: string
  name?: string
  duration_ms?: number
  artists?: SpotifyPlaybackArtistResponse[]
  album?: SpotifyPlaybackAlbumResponse
}

interface SpotifyPlaybackStateResponse {
  is_playing?: boolean
  progress_ms?: number
  device?: SpotifyPlaybackDeviceResponse
  item?: SpotifyPlaybackTrackResponse
}

export interface SpotifyTrackSearchResult {
  id: string
  title: string
  uri: string
  durationSeconds: number
  discNumber: number
  trackNumber: number
  album: {
    id: string
    title: string
    uri: string
    releaseDate?: string
    coverArtUrl?: string
    artists: SpotifySearchArtist[]
  }
  artists: SpotifySearchArtist[]
}

export interface SpotifyTrackSearchPage {
  tracks: SpotifyTrackSearchResult[]
  totalCount: number
  offset: number
  limit: number
}

export interface SpotifyPlaybackState {
  isPlaying: boolean
  progressSeconds: number
  durationSeconds: number
  volume: number
  activeDeviceId?: string
  activeTrack?: {
    spotifyUri: string
    title?: string
    artists?: string[]
    album?: string
    coverArtUrl?: string
    durationSeconds?: number
  }
}

let cachedAccessToken: string | null = null
let cachedAccessTokenExpiresAtEpochMs = 0
let tokenRefreshInFlight: Promise<string> | null = null

function readOAuthCache(): SpotifyOAuthCachePayload | null {
  if (typeof window === 'undefined') return null

  try {
    const raw = window.localStorage.getItem(OAUTH_CACHE_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw) as SpotifyOAuthCachePayload
    return parsed
  } catch {
    return null
  }
}

function writeOAuthRefreshToken(refreshToken: string): void {
  writeOAuthCache({
    refreshToken,
  })
}

function writeOAuthAccessToken(
  accessToken: string,
  tokenExpiresAtEpochMs: number,
): void {
  writeOAuthCache({
    accessToken,
    tokenExpiresAtEpochMs,
  })
}

function writeOAuthCache(patch: Partial<SpotifyOAuthCachePayload>): void {
  if (typeof window === 'undefined') return

  const current = readOAuthCache() ?? {}
  const next: SpotifyOAuthCachePayload = {
    ...current,
    ...patch,
  }

  try {
    window.localStorage.setItem(OAUTH_CACHE_KEY, JSON.stringify(next))
  } catch {
    // ignore localStorage write failures
  }
}

function parseSpotifyWebApiError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null

  const maybeError = payload as {
    error?: {
      status?: unknown
      message?: unknown
    }
  }

  if (!maybeError.error || typeof maybeError.error !== 'object') return null
  if (typeof maybeError.error.message !== 'string') return null

  return maybeError.error.message
}

function isInsufficientScopeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  const normalized = error.message.toLowerCase()
  return normalized.includes('scope')
}

function isInvalidLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) return false

  return error.message.toLowerCase().includes('invalid limit')
}

function resolveFallbackMarketFromLocale(): string {
  if (typeof navigator === 'undefined') return 'US'

  const language = navigator.language || ''
  const regionMatch = language.match(/-([a-z]{2})$/i)
  if (!regionMatch) return 'US'

  return regionMatch[1].toUpperCase()
}

type SpotifyImageLike = {
  url?: string
  width?: number
  height?: number
}

function getTrackCoverArtUrl(images?: SpotifyImageLike[]): string | undefined {
  if (!images || images.length === 0) return undefined

  return (
    images.find((image) => image.width === 300)?.url ??
    images[0]?.url ??
    undefined
  )
}

function parseReleaseYear(releaseDate?: string): number {
  if (!releaseDate || releaseDate.length < 4) return 0

  const year = Number.parseInt(releaseDate.slice(0, 4), 10)
  return Number.isFinite(year) ? year : 0
}

function normalizeIntegerInRange(params: {
  value: number
  fallback: number
  min: number
  max: number
}): number {
  const base = Number.isFinite(params.value)
    ? Math.trunc(params.value)
    : params.fallback

  if (base < params.min) return params.min
  if (base > params.max) return params.max

  return base
}

function parseSpotifyUriFromSource(source: string): string {
  const trimmed = source.trim()
  if (trimmed.startsWith('spotify:')) return trimmed

  try {
    const url = new URL(trimmed)
    const id = url.searchParams.get('id')
    if (!id) {
      throw new Error('Spotify URI is not included in source URL.')
    }

    if (id.startsWith('spotify:')) return id
    if (id.startsWith('track:') || id.startsWith('album:') || id.startsWith('playlist:')) {
      return `spotify:${id}`
    }
  } catch {
    // ignore URL parse failure
  }

  throw new Error(`Unsupported Spotify source: ${source}`)
}

async function refreshSpotifyAccessToken(): Promise<string> {
  const cache = readOAuthCache()
  const clientId = cache?.clientId?.trim()
  const refreshToken = cache?.refreshToken?.trim()

  if (!clientId || !refreshToken) {
    throw new Error(
      'Spotify OAuth設定が見つかりません。Settings > Content > Spotify Connect で OAuth Authorize を実行してください。',
    )
  }

  const result = await spotifyConnectOAuthRefresh({
    clientId,
    refreshToken,
  })

  if (!result.ok || !result.accessToken) {
    throw new Error(result.error?.message ?? 'Spotify access token refresh failed.')
  }

  cachedAccessToken = result.accessToken
  const expiresInMs =
    typeof result.expiresIn === 'number' && result.expiresIn > 0
      ? result.expiresIn * 1000
      : FALLBACK_TOKEN_TTL_MS
  cachedAccessTokenExpiresAtEpochMs = Date.now() + expiresInMs
  writeOAuthAccessToken(result.accessToken, cachedAccessTokenExpiresAtEpochMs)

  if (typeof result.refreshToken === 'string' && result.refreshToken.length > 0) {
    writeOAuthRefreshToken(result.refreshToken)
  }

  return result.accessToken
}

function getCachedAccessTokenFromStorage(): string | null {
  const cache = readOAuthCache()
  const accessToken = cache?.accessToken?.trim()
  const expiresAtEpochMs = cache?.tokenExpiresAtEpochMs

  if (!accessToken) return null
  if (!Number.isFinite(expiresAtEpochMs)) return null
  if ((expiresAtEpochMs as number) <= Date.now() + TOKEN_REFRESH_SKEW_MS) {
    return null
  }

  return accessToken
}

async function getSpotifyAccessToken(): Promise<string> {
  if (
    cachedAccessToken &&
    Date.now() + TOKEN_REFRESH_SKEW_MS < cachedAccessTokenExpiresAtEpochMs
  ) {
    return cachedAccessToken
  }

  const cachedStorageToken = getCachedAccessTokenFromStorage()
  if (cachedStorageToken) {
    cachedAccessToken = cachedStorageToken
    cachedAccessTokenExpiresAtEpochMs =
      readOAuthCache()?.tokenExpiresAtEpochMs ?? Date.now() + FALLBACK_TOKEN_TTL_MS
    return cachedStorageToken
  }

  if (!tokenRefreshInFlight) {
    tokenRefreshInFlight = refreshSpotifyAccessToken().finally(() => {
      tokenRefreshInFlight = null
    })
  }

  return tokenRefreshInFlight
}

export async function getSpotifyAccessTokenForPlaybackControl(): Promise<string> {
  return getSpotifyAccessToken()
}

function buildSpotifyPlayerQuery(params: {
  path: string
  deviceId?: string
  positionMs?: number
}): string {
  const queryParams = new URLSearchParams()

  if (params.deviceId && params.deviceId.trim().length > 0) {
    queryParams.set('device_id', params.deviceId.trim())
  }
  if (typeof params.positionMs === 'number' && Number.isFinite(params.positionMs)) {
    queryParams.set('position_ms', String(Math.max(0, Math.floor(params.positionMs))))
  }

  const serialized = queryParams.toString()
  if (!serialized) {
    return params.path
  }

  return `${params.path}?${serialized}`
}

async function spotifyWebApiRequest<T>(
  path: string,
  init: RequestInit = {},
  allowRetry = true,
): Promise<T> {
  const accessToken = await getSpotifyAccessToken()
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${accessToken}`)

  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(`${SPOTIFY_WEB_API_BASE_URL}${path}`, {
    ...init,
    headers,
  })

  if (response.status === 401 && allowRetry) {
    cachedAccessToken = null
    cachedAccessTokenExpiresAtEpochMs = 0
    return spotifyWebApiRequest<T>(path, init, false)
  }

  if (response.status === 204) {
    return undefined as T
  }

  const textPayload = await response.text()
  const jsonPayload =
    textPayload.length > 0 ? (JSON.parse(textPayload) as unknown) : undefined

  if (!response.ok) {
    const detail = parseSpotifyWebApiError(jsonPayload)
    const message = detail
      ? `Spotify Web API request failed (${response.status}): ${detail}`
      : `Spotify Web API request failed with status ${response.status}.`
    throw new Error(message)
  }

  return jsonPayload as T
}

export async function spotifySearchTracks(params: {
  query: string
  limit: number
  offset: number
}): Promise<SpotifyTrackSearchPage> {
  const limit = normalizeIntegerInRange({
    value: params.limit,
    fallback: 20,
    min: 1,
    max: 50,
  })
  const offset = normalizeIntegerInRange({
    value: params.offset,
    fallback: 0,
    min: 0,
    max: 1000,
  })

  const query = params.query.trim()
  if (!query) {
    return {
      tracks: [],
      totalCount: 0,
      offset,
      limit,
    }
  }

  async function searchWithMarket(
    market: string | null,
    requestLimit: number,
  ): Promise<SpotifySearchTracksResponse> {
    const queryParams = new URLSearchParams({
      q: query,
      type: 'track',
      limit: requestLimit.toString(),
      offset: offset.toString(),
    })

    if (market) {
      queryParams.set('market', market)
    }

    return spotifyWebApiRequest<SpotifySearchTracksResponse>(
      `/search?${queryParams.toString()}`,
      {
        method: 'GET',
      },
    )
  }

  let response: SpotifySearchTracksResponse
  let currentLimit = limit

  const executePrimarySearch = async (): Promise<SpotifySearchTracksResponse> => {
    return searchWithMarket('from_token', currentLimit)
  }

  try {
    response = await executePrimarySearch()
  } catch (error) {
    if (isInvalidLimitError(error)) {
      logger.warn('Spotify search returned invalid limit. Retrying with fallback limit.', {
        originalLimit: currentLimit,
        fallbackLimit: 20,
      })
      currentLimit = 20
      try {
        response = await executePrimarySearch()
      } catch (retryError) {
        if (!isInvalidLimitError(retryError)) {
          throw retryError
        }

        logger.warn(
          'Spotify search still returned invalid limit with fallback 20. Retrying with 10.',
        )
        currentLimit = 10
        response = await executePrimarySearch()
      }
    } else if (!isInsufficientScopeError(error)) {
      throw error
    } else {
      const fallbackMarket = resolveFallbackMarketFromLocale()
      try {
        response = await searchWithMarket(fallbackMarket, currentLimit)
      } catch {
        response = await searchWithMarket(null, currentLimit)
      }
    }
  }

  const tracks = response.tracks?.items ?? []
  const totalCount = response.tracks?.total ?? 0

  return {
    tracks: tracks.map((track) => ({
      id: track.id,
      title: track.name,
      uri: track.uri,
      durationSeconds: Math.max(0, Math.floor(track.duration_ms / 1000)),
      discNumber: track.disc_number ?? 0,
      trackNumber: track.track_number ?? 0,
      album: {
        id: track.album.id,
        title: track.album.name,
        uri: track.album.uri,
        releaseDate: track.album.release_date,
        coverArtUrl: getTrackCoverArtUrl(track.album.images),
        artists: track.album.artists ?? [],
      },
      artists: track.artists ?? [],
    })),
    totalCount,
    offset,
    limit: currentLimit,
  }
}

export async function spotifyPausePlayback(): Promise<void> {
  await spotifyWebApiRequest<void>('/me/player/pause', {
    method: 'PUT',
  })
}

export async function spotifyPausePlaybackOnDevice(deviceId?: string): Promise<void> {
  const path = buildSpotifyPlayerQuery({
    path: '/me/player/pause',
    deviceId,
  })
  await spotifyWebApiRequest<void>(path, {
    method: 'PUT',
  })
}

export async function spotifyResumePlayback(): Promise<void> {
  await spotifyWebApiRequest<void>('/me/player/play', {
    method: 'PUT',
  })
}

export async function spotifyResumePlaybackOnDevice(deviceId?: string): Promise<void> {
  const path = buildSpotifyPlayerQuery({
    path: '/me/player/play',
    deviceId,
  })
  await spotifyWebApiRequest<void>(path, {
    method: 'PUT',
  })
}

export async function spotifySeekPlayback(
  positionSeconds: number,
  deviceId?: string,
): Promise<void> {
  const positionMs = Math.max(0, Math.floor(positionSeconds * 1000))
  const path = buildSpotifyPlayerQuery({
    path: '/me/player/seek',
    deviceId,
    positionMs,
  })
  await spotifyWebApiRequest<void>(path, {
    method: 'PUT',
  })
}

export async function spotifyGetPlaybackState(): Promise<SpotifyPlaybackState | null> {
  const payload = await spotifyWebApiRequest<SpotifyPlaybackStateResponse | undefined>(
    '/me/player?additional_types=track',
    {
      method: 'GET',
    },
  )

  if (!payload || typeof payload !== 'object') {
    return null
  }

  const rawProgressMs =
    typeof payload.progress_ms === 'number' && Number.isFinite(payload.progress_ms)
      ? payload.progress_ms
      : 0
  const progressSeconds = Math.max(0, Math.floor(rawProgressMs / 1000))

  const rawDurationMs =
    typeof payload.item?.duration_ms === 'number' &&
    Number.isFinite(payload.item.duration_ms)
      ? payload.item.duration_ms
      : 0
  const durationSeconds = Math.max(0, Math.floor(rawDurationMs / 1000))

  const volumePercent =
    typeof payload.device?.volume_percent === 'number' &&
    Number.isFinite(payload.device.volume_percent)
      ? payload.device.volume_percent
      : 100
  const volume = Math.max(0, Math.min(1, volumePercent / 100))

  const activeTrackUri = payload.item?.uri?.trim()
  const activeTrack =
    activeTrackUri && activeTrackUri.startsWith('spotify:')
      ? {
          spotifyUri: activeTrackUri,
          title: payload.item?.name,
          artists:
            payload.item?.artists
              ?.map((artist) => artist?.name?.trim())
              .filter((name): name is string => Boolean(name)) ?? undefined,
          album: payload.item?.album?.name,
          coverArtUrl: getTrackCoverArtUrl(payload.item?.album?.images),
          durationSeconds: durationSeconds > 0 ? durationSeconds : undefined,
        }
      : undefined

  return {
    isPlaying: Boolean(payload.is_playing),
    progressSeconds,
    durationSeconds,
    volume,
    activeDeviceId: payload.device?.id?.trim() || undefined,
    activeTrack,
  }
}

export function normalizeSpotifyPlaybackSource(source: string): string {
  const spotifyUri = parseSpotifyUriFromSource(source)
  if (!spotifyUri.startsWith('spotify:')) {
    throw new Error(`Invalid Spotify URI: ${spotifyUri}`)
  }

  return spotifyUri
}

export function getSpotifySongYearFromReleaseDate(releaseDate?: string): number {
  return parseReleaseYear(releaseDate)
}
