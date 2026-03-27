// Remote Relay APIクライアント
const API_BASE = '' // 同一オリジン

export interface RemoteSessionResponse {
  ok: boolean
  leaseId?: string
  clientName?: string
  state?: unknown
  message?: string
}

export type RemotePlaybackTarget = 'desktop' | 'mobile'

export interface RemotePlaybackDevice {
  id: RemotePlaybackTarget
  name: string
  description?: string
  selected: boolean
}

export interface RemoteState {
  mediaType: 'song' | 'radio' | 'podcast'
  source: 'navidrome' | 'local' | 'unsupported'
  src?: string
  signalPath?: string
  isPlaying: boolean
  currentTimeSeconds: number
  durationSeconds: number
  volume: number
  hasPrev: boolean
  hasNext: boolean
  canStream?: boolean
  playbackTarget?: RemotePlaybackTarget
  playbackDevices?: RemotePlaybackDevice[]
  nowPlaying?: {
    id?: string
    title?: string
    artist?: string
    album?: string
    coverArtId?: string
  }
}

export type RemoteCommand =
  | {
      type: 'playPause' | 'prev' | 'next'
    }
  | {
      type: 'seek' | 'setVolume'
      value: number
    }
  | {
      type: 'playAlbum'
      albumId: string
    }
  | {
      type: 'playSong'
      albumId: string
      songId: string
    }
  | {
      type: 'setPlaybackTarget'
      target: RemotePlaybackTarget
    }

// セッション取得
export async function claimSession(): Promise<RemoteSessionResponse> {
  const response = await fetch(`${API_BASE}/api/remote/session/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientName: 'Minato Remote Web' }),
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    return {
      ok: false,
      message: error.message || 'セッション取得に失敗しました',
    }
  }

  return response.json()
}

// ハートビート
export async function sendHeartbeat(leaseId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/remote/session/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leaseId }),
  })

  if (!response.ok) {
    throw new Error('Heartbeat failed')
  }
}

// セッション解放
export async function releaseSession(leaseId: string): Promise<void> {
  await fetch(`${API_BASE}/api/remote/session/release`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leaseId }),
  })
}

// 状態購読（SSE）
export function subscribeToEvents(leaseId: string): EventSource {
  return new EventSource(
    `${API_BASE}/api/remote/events?leaseId=${encodeURIComponent(leaseId)}`,
  )
}

// 現在の状態取得
export async function getCurrentState(leaseId: string): Promise<RemoteState> {
  const response = await fetch(
    `${API_BASE}/api/remote/state?leaseId=${encodeURIComponent(leaseId)}`,
  )

  if (!response.ok) {
    throw new Error('Failed to fetch state')
  }

  const payload = (await response.json()) as
    | { ok?: boolean; state?: RemoteState }
    | RemoteState

  if (payload && typeof payload === 'object' && 'state' in payload) {
    if (payload.state) {
      return payload.state
    }
    throw new Error('State payload is missing')
  }

  return payload as RemoteState
}

// コマンド送信
export async function sendCommand(
  leaseId: string,
  command: RemoteCommand,
): Promise<void> {
  const { type, ...rest } = command
  const response = await fetch(`${API_BASE}/api/remote/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leaseId, command: type, ...rest }),
  })

  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({}))
    const reason =
      typeof errorPayload?.message === 'string'
        ? errorPayload.message
        : 'Command failed'
    throw new Error(reason)
  }
}

// Navidrome Library API
export interface NavidromeArtist {
  id: string
  name: string
  albumCount: number
}

export interface NavidromeAlbum {
  id: string
  name: string
  artist: string
  year?: number
  coverArt?: string
}

export interface NavidromeSong {
  id: string
  title: string
  artist: string
  album: string
  duration: number
  track?: number
  coverArt?: string
}

export interface NavidromeGenre {
  value: string
  albumCount: number
  songCount: number
}

export interface GetAlbumsOptions {
  artistId?: string
  genre?: string
  type?: string
  limit?: number
  offset?: number
  signal?: AbortSignal
}

export async function getGenres(
  leaseId: string,
  limit?: number,
  signal?: AbortSignal,
): Promise<NavidromeGenre[]> {
  const url = new URL(
    `${API_BASE}/api/remote/library/genres`,
    window.location.origin,
  )
  url.searchParams.set('leaseId', leaseId)
  if (typeof limit === 'number' && Number.isFinite(limit)) {
    url.searchParams.set('limit', String(Math.trunc(limit)))
  }

  const response = await fetch(url.toString(), { signal })
  if (!response.ok) throw new Error('Failed to fetch genres')
  return response.json()
}

export async function getArtists(
  leaseId: string,
  limit?: number,
  offset?: number,
  signal?: AbortSignal,
): Promise<NavidromeArtist[]> {
  const url = new URL(
    `${API_BASE}/api/remote/library/artists`,
    window.location.origin,
  )
  url.searchParams.set('leaseId', leaseId)
  if (typeof limit === 'number' && Number.isFinite(limit)) {
    url.searchParams.set('limit', String(Math.trunc(limit)))
  }
  if (typeof offset === 'number' && Number.isFinite(offset)) {
    url.searchParams.set('offset', String(Math.trunc(offset)))
  }

  const response = await fetch(url.toString(), { signal })
  if (!response.ok) throw new Error('Failed to fetch artists')
  return response.json()
}

export async function getAlbums(
  leaseId: string,
  options: GetAlbumsOptions = {},
): Promise<NavidromeAlbum[]> {
  const { artistId, genre, type, limit, offset, signal } = options
  const url = new URL(
    `${API_BASE}/api/remote/library/albums`,
    window.location.origin,
  )
  url.searchParams.set('leaseId', leaseId)
  if (artistId) url.searchParams.set('artistId', artistId)
  if (genre) url.searchParams.set('genre', genre)
  if (type) url.searchParams.set('type', type)
  if (typeof limit === 'number' && Number.isFinite(limit)) {
    url.searchParams.set('limit', String(Math.trunc(limit)))
  }
  if (typeof offset === 'number' && Number.isFinite(offset)) {
    url.searchParams.set('offset', String(Math.trunc(offset)))
  }

  const response = await fetch(url.toString(), { signal })
  if (!response.ok) throw new Error('Failed to fetch albums')
  return response.json()
}

export async function getAlbumsByGenre(
  leaseId: string,
  genre: string,
  limit = 16,
  signal?: AbortSignal,
): Promise<NavidromeAlbum[]> {
  return getAlbums(leaseId, {
    genre,
    type: 'byGenre',
    limit,
    offset: 0,
    signal,
  })
}

export async function getSongs(
  leaseId: string,
  albumId?: string,
  limit?: number,
  offset?: number,
  signal?: AbortSignal,
): Promise<NavidromeSong[]> {
  const url = new URL(
    `${API_BASE}/api/remote/library/songs`,
    window.location.origin,
  )
  url.searchParams.set('leaseId', leaseId)
  if (albumId) url.searchParams.set('albumId', albumId)
  if (typeof limit === 'number' && Number.isFinite(limit)) {
    url.searchParams.set('limit', String(Math.trunc(limit)))
  }
  if (typeof offset === 'number' && Number.isFinite(offset)) {
    url.searchParams.set('offset', String(Math.trunc(offset)))
  }

  const response = await fetch(url.toString(), { signal })
  if (!response.ok) throw new Error('Failed to fetch songs')
  return response.json()
}

export async function searchLibrary(
  leaseId: string,
  query: string,
  signal?: AbortSignal,
): Promise<{
  artists: NavidromeArtist[]
  albums: NavidromeAlbum[]
  songs: NavidromeSong[]
}> {
  const response = await fetch(
    `${API_BASE}/api/remote/library/search?leaseId=${encodeURIComponent(leaseId)}&query=${encodeURIComponent(query)}`,
    { signal },
  )
  if (!response.ok) throw new Error('Failed to search')
  return response.json()
}
