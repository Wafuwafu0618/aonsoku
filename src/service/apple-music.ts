import {
  AppleMusicAlbum,
  AppleMusicBrowseResult,
  AppleMusicLibraryPageResult,
  AppleMusicLibraryResult,
  AppleMusicPlaylist,
  AppleMusicSearchResult,
  AppleMusicSong,
} from '@/types/responses/apple-music'

const DEFAULT_SEARCH_TYPES = ['songs', 'albums', 'playlists']
const DEFAULT_STOREFRONT = 'us'
const DEFAULT_ARTWORK_SIZE = 600

type UnknownRecord = Record<string, unknown>

export type AppleMusicServiceErrorCode =
  | 'timeout'
  | 'cancelled'
  | 'invoke-failed'
  | 'parse-failed'
  | 'api-failed'
  | 'invalid-response'
  | 'unsupported-action'
  | 'unauthorized'
  | 'desktop-only'
  | 'unknown'

export class AppleMusicServiceError extends Error {
  readonly code: AppleMusicServiceErrorCode | string

  constructor(code: AppleMusicServiceErrorCode | string, message: string) {
    super(message)
    this.name = 'AppleMusicServiceError'
    this.code = code
  }
}

function inferAppleMusicErrorCodeFromMessage(message: string): AppleMusicServiceErrorCode {
  const normalized = message.toLowerCase()
  if (
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('タイムアウト')
  ) {
    return 'timeout'
  }
  if (
    normalized.includes('cancelled') ||
    normalized.includes('canceled') ||
    normalized.includes('キャンセル')
  ) {
    return 'cancelled'
  }
  if (normalized.includes('invoke-failed')) return 'invoke-failed'
  if (normalized.includes('parse-failed')) return 'parse-failed'
  if (normalized.includes('invalid-response')) return 'invalid-response'
  if (normalized.includes('api-failed')) return 'api-failed'
  if (normalized.includes('unsupported-action')) return 'unsupported-action'
  if (normalized.includes('not authorized') || normalized.includes('未認証')) {
    return 'unauthorized'
  }
  return 'unknown'
}

export function resolveAppleMusicErrorCode(error: unknown): AppleMusicServiceErrorCode | string {
  if (error instanceof AppleMusicServiceError) {
    return error.code
  }
  const message = error instanceof Error ? error.message : String(error)
  return inferAppleMusicErrorCodeFromMessage(message)
}

function requireRecord(
  value: unknown,
  context: string,
): UnknownRecord {
  const record = asRecord(value)
  if (record) return record
  throw new AppleMusicServiceError(
    'parse-failed',
    `Apple Music ${context} のレスポンス解析に失敗しました。`,
  )
}

export interface AppleMusicService {
  initialize(): Promise<void>
  isAuthorized(): boolean
  getStorefrontId(): string
  search(query: string, types: string[]): Promise<AppleMusicSearchResult>
  getCatalogAlbum(id: string): Promise<AppleMusicAlbum>
  getCatalogPlaylist(id: string): Promise<AppleMusicPlaylist>
  getLibraryPage(options?: {
    limit?: number
    offset?: number
  }): Promise<AppleMusicLibraryPageResult>
  getLibrary(): Promise<AppleMusicLibraryResult>
  getBrowse(options?: {
    newReleasesLimit?: number
    topChartsLimit?: number
  }): Promise<AppleMusicBrowseResult>
}

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object') return null
  return value as UnknownRecord
}

function asRecordArray(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is UnknownRecord => Boolean(asRecord(entry)))
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asNullableNumber(value: unknown): number | null {
  const numeric = asNumber(value)
  return typeof numeric === 'number' ? numeric : null
}

function toArtworkUrl(template: string | undefined): string {
  if (!template) return ''

  return template
    .replace('{w}', String(DEFAULT_ARTWORK_SIZE))
    .replace('{h}', String(DEFAULT_ARTWORK_SIZE))
}

function getResourceAttributes(resource: UnknownRecord): UnknownRecord {
  return asRecord(resource.attributes) ?? {}
}

function getResourceRelationships(resource: UnknownRecord): UnknownRecord {
  return asRecord(resource.relationships) ?? {}
}

function resolveSongAdamId(resource: UnknownRecord): string {
  const attributes = getResourceAttributes(resource)
  const playParams = asRecord(attributes.playParams) ?? {}
  const catalog = asRecord(getResourceRelationships(resource).catalog)
  const catalogData = asRecordArray(catalog?.data)

  return (
    asString(playParams.catalogId) ??
    asString(playParams.id) ??
    asString(catalogData[0]?.id) ??
    asString(resource.id) ??
    ''
  )
}

function resolveAlbumCatalogId(resource: UnknownRecord): string {
  const attributes = getResourceAttributes(resource)
  const playParams = asRecord(attributes.playParams) ?? {}
  const catalog = asRecord(getResourceRelationships(resource).catalog)
  const catalogData = asRecordArray(catalog?.data)

  return (
    asString(playParams.catalogId) ??
    asString(catalogData[0]?.id) ??
    asString(playParams.id) ??
    asString(resource.id) ??
    ''
  )
}

function mapSong(resource: UnknownRecord): AppleMusicSong {
  const attributes = getResourceAttributes(resource)
  const artwork = asRecord(attributes.artwork)
  const genreNames =
    (Array.isArray(attributes.genreNames) ? attributes.genreNames : []).filter(
      (name): name is string => typeof name === 'string',
    )
  const durationMs = asNumber(attributes.durationInMillis) ?? 0
  const adamId = resolveSongAdamId(resource)

  return {
    id: asString(resource.id) ?? adamId,
    adamId,
    title: asString(attributes.name) ?? '',
    artistName: asString(attributes.artistName) ?? '',
    albumName: asString(attributes.albumName) ?? '',
    durationMs,
    artworkUrl: toArtworkUrl(asString(artwork?.url)),
    trackNumber: asNumber(attributes.trackNumber),
    discNumber: asNumber(attributes.discNumber),
    genreNames,
    contentRating: asString(attributes.contentRating),
    url: asString(attributes.url),
  }
}

function mapAlbum(resource: UnknownRecord): AppleMusicAlbum {
  const attributes = getResourceAttributes(resource)
  const relationships = getResourceRelationships(resource)
  const artwork = asRecord(attributes.artwork)
  const songResources = readSectionData(relationships.tracks)
  const catalogId = resolveAlbumCatalogId(resource)

  return {
    id: asString(resource.id) ?? catalogId,
    catalogId,
    name: asString(attributes.name) ?? '',
    artistName: asString(attributes.artistName) ?? '',
    artworkUrl: toArtworkUrl(asString(artwork?.url)),
    trackCount:
      asNumber(attributes.trackCount) ??
      songResources.length,
    releaseDate: asString(attributes.releaseDate) ?? '',
    songs: songResources.map(mapSong),
    url: asString(attributes.url),
  }
}

function mapPlaylist(resource: UnknownRecord): AppleMusicPlaylist {
  const attributes = getResourceAttributes(resource)
  const relationships = getResourceRelationships(resource)
  const artwork = asRecord(attributes.artwork)
  const songResources = readSectionData(relationships.tracks)

  return {
    id: asString(resource.id) ?? '',
    name: asString(attributes.name) ?? '',
    curatorName: asString(attributes.curatorName),
    artworkUrl: toArtworkUrl(asString(artwork?.url)),
    trackCount:
      asNumber(attributes.trackCount) ??
      songResources.length,
    songs: songResources.map(mapSong),
    url: asString(attributes.url),
  }
}

function normalizeTypeName(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function isSongResource(resource: UnknownRecord): boolean {
  if (normalizeTypeName(resource.type).includes('song')) return true

  const attributes = getResourceAttributes(resource)
  const playParams = asRecord(attributes.playParams) ?? {}
  if (normalizeTypeName(playParams.kind).includes('song')) return true

  const url = normalizeTypeName(attributes.url)
  return url.includes('/song/')
}

function readIncludedSongs(root: UnknownRecord): AppleMusicSong[] {
  const included = asRecordArray(root.included)
  if (included.length === 0) return []

  const songs = included.filter((resource) => isSongResource(resource))
  return songs.map(mapSong)
}

function normalizeLooseText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

function isAlbumNameMatch(target: string, candidate: string): boolean {
  const normalizedTarget = normalizeLooseText(target)
  const normalizedCandidate = normalizeLooseText(candidate)
  if (!normalizedTarget || !normalizedCandidate) return false
  if (normalizedTarget === normalizedCandidate) return true
  return (
    normalizedCandidate.includes(normalizedTarget) ||
    normalizedTarget.includes(normalizedCandidate)
  )
}

function readSearchSection(root: UnknownRecord, key: string): UnknownRecord[] {
  const directSection = asRecord(root[key])
  const directData = asRecordArray(directSection?.data)
  if (directData.length > 0) return directData

  const results = asRecord(root.results)
  const nestedSection = asRecord(results?.[key])
  return asRecordArray(nestedSection?.data)
}

function readResourceArray(root: UnknownRecord): UnknownRecord[] {
  const data = asRecordArray(root.data)
  if (data.length > 0) return data

  const results = asRecord(root.results)
  return asRecordArray(results?.data)
}

function isAppleMusicResourceRecord(record: UnknownRecord): boolean {
  return typeof asString(record.id) === 'string' && Boolean(asRecord(record.attributes))
}

function readSectionData(section: unknown): UnknownRecord[] {
  const sectionRecord = asRecord(section)
  if (sectionRecord) {
    const directData = asRecordArray(sectionRecord.data)
    if (directData.length > 0) return directData
  }

  if (!Array.isArray(section)) return []

  return section.flatMap((entry) => {
    const record = asRecord(entry)
    if (!record) return []

    const nestedData = asRecordArray(record.data)
    if (nestedData.length > 0) return nestedData

    return isAppleMusicResourceRecord(record) ? [record] : []
  })
}

function readBrowseSection(root: UnknownRecord, key: string): UnknownRecord[] {
  const direct = readSectionData(root[key])
  if (direct.length > 0) return direct

  const results = asRecord(root.results) ?? {}
  const nested = readSectionData(results[key])
  if (nested.length > 0) return nested

  const normalize = (value: unknown): string =>
    typeof value === 'string' ? value.trim().toLowerCase() : ''
  const singular = key.endsWith('s') ? key.slice(0, -1) : key
  const matchKey = (value: unknown): boolean => {
    const normalized = normalize(value)
    if (!normalized) return false
    if (normalized === key || normalized === singular) return true
    if (
      normalized.endsWith(`-${key}`) ||
      normalized.endsWith(`-${singular}`) ||
      normalized.endsWith(`/${key}`) ||
      normalized.endsWith(`/${singular}`)
    ) {
      return true
    }
    return normalized.includes(singular)
  }
  const inferByUrl = (value: unknown): string => {
    const normalized = normalize(value)
    if (!normalized) return ''
    if (normalized.includes('/song/')) return 'songs'
    if (normalized.includes('/album/')) return 'albums'
    if (normalized.includes('/playlist/')) return 'playlists'
    return ''
  }

  const queue: unknown[] = [root]
  const seen = new Set<unknown>()
  const allResources: UnknownRecord[] = []
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || typeof current !== 'object') continue
    if (seen.has(current)) continue
    seen.add(current)

    if (Array.isArray(current)) {
      for (const entry of current) {
        const entryRecord = asRecord(entry)
        if (entryRecord && isAppleMusicResourceRecord(entryRecord)) {
          allResources.push(entryRecord)
        }
        if (entry && typeof entry === 'object') {
          queue.push(entry)
        }
      }
      continue
    }

    const currentRecord = asRecord(current)
    if (!currentRecord) continue
    if (isAppleMusicResourceRecord(currentRecord)) {
      allResources.push(currentRecord)
    }

    const dataEntries = asRecordArray(currentRecord.data)
    if (dataEntries.length > 0) {
      for (const item of dataEntries) {
        allResources.push(item)
        queue.push(item)
      }
    }

    for (const nestedValue of Object.values(currentRecord)) {
      if (nestedValue && typeof nestedValue === 'object') {
        queue.push(nestedValue)
      }
    }
  }

  const filtered = allResources.filter((resource) => {
    if (matchKey(resource.type)) return true

    const attributes = asRecord(resource.attributes) ?? {}
    if (inferByUrl(attributes.url) === key) return true
    const playParams = asRecord(attributes.playParams) ?? {}
    return matchKey(playParams.kind)
  })

  if (filtered.length === 0) return []
  return dedupeByKey(filtered, (item) => asString(item.id) ?? '')
}

function normalizeSearchTypes(types: string[]): string[] {
  const filtered = types
    .map((type) => type.trim())
    .filter((type) => type.length > 0)

  return filtered.length > 0 ? filtered : DEFAULT_SEARCH_TYPES
}

function dedupeByKey<T>(items: T[], getKey: (item: T) => string): T[] {
  if (items.length <= 1) return items

  const seen = new Set<string>()
  const next: T[] = []
  for (const item of items) {
    const key = getKey(item).trim()
    if (!key) continue
    if (seen.has(key)) continue
    seen.add(key)
    next.push(item)
  }
  return next
}

function dedupeBrowseSongs(items: AppleMusicSong[]): AppleMusicSong[] {
  return dedupeByKey(items, (item) => item.adamId || item.id)
}

function dedupeBrowseAlbums(items: AppleMusicAlbum[]): AppleMusicAlbum[] {
  return dedupeByKey(items, (item) => item.id)
}

function dedupeBrowsePlaylists(items: AppleMusicPlaylist[]): AppleMusicPlaylist[] {
  return dedupeByKey(items, (item) => item.id)
}

class AppleMusicServiceImpl implements AppleMusicService {
  private authorized = false
  private storefrontId = DEFAULT_STOREFRONT

  private async invokeApi(payload: {
    action:
      | 'status'
      | 'search'
      | 'catalog-album'
      | 'catalog-playlist'
      | 'library'
      | 'browse'
    query?: string
    types?: string[]
    id?: string
    limit?: number
    offset?: number
    browseKind?: 'new-releases' | 'top-charts'
  }): Promise<unknown> {
    const api = (window as Window & { api?: unknown }).api as
      | {
          appleMusicApiRequest?: (request: {
            action:
              | 'status'
              | 'search'
              | 'catalog-album'
              | 'catalog-playlist'
              | 'library'
              | 'browse'
            query?: string
            types?: string[]
            id?: string
            limit?: number
            offset?: number
            browseKind?: 'new-releases' | 'top-charts'
          }) => Promise<{
            ok: boolean
            data?: unknown
            error?: { code?: string; message?: string }
          }>
        }
      | undefined

    if (!api?.appleMusicApiRequest) {
      throw new AppleMusicServiceError(
        'desktop-only',
        'Apple Music browser session API は Desktop(Electron) 環境でのみ利用できます。',
      )
    }

    const result = await api.appleMusicApiRequest(payload)
    if (!result?.ok) {
      const errorCode = asString(result?.error?.code)
      const normalizedCode = errorCode?.trim().toLowerCase()
      const message =
        result?.error?.message ?? 'Apple Music browser session API request failed.'
      throw new AppleMusicServiceError(
        normalizedCode && normalizedCode.length > 0
          ? normalizedCode
          : inferAppleMusicErrorCodeFromMessage(message),
        message,
      )
    }

    return result.data
  }

  async initialize(): Promise<void> {
    const raw = await this.invokeApi({ action: 'status' })
    const status = requireRecord(raw, 'status')
    const isAuthorized = Boolean(status.isAuthorized)
    const storefrontId = asString(status.storefrontId) ?? DEFAULT_STOREFRONT

    this.authorized = isAuthorized
    this.storefrontId = storefrontId

    if (!isAuthorized) {
      throw new AppleMusicServiceError(
        'unauthorized',
        'Apple Music セッションが未認証です。Settings > Content > Apple Music でサインインしてください。',
      )
    }
  }

  isAuthorized(): boolean {
    return this.authorized
  }

  getStorefrontId(): string {
    return this.storefrontId
  }

  async search(query: string, types: string[]): Promise<AppleMusicSearchResult> {
    const keyword = query.trim()
    if (keyword.length === 0) {
      return {
        songs: [],
        albums: [],
        playlists: [],
      }
    }

    const searchTypes = normalizeSearchTypes(types)
    const raw = await this.invokeApi({
      action: 'search',
      query: keyword,
      types: searchTypes,
    })

    const payload = requireRecord(raw, 'search')

    return {
      songs: readSearchSection(payload, 'songs').map(mapSong),
      albums: readSearchSection(payload, 'albums').map(mapAlbum),
      playlists: readSearchSection(payload, 'playlists').map(mapPlaylist),
    }
  }

  async getCatalogAlbum(id: string): Promise<AppleMusicAlbum> {
    const albumId = id.trim()
    if (albumId.length === 0) {
      throw new AppleMusicServiceError('parse-failed', 'album id が空です。')
    }

    const raw = await this.invokeApi({
      action: 'catalog-album',
      id: albumId,
    })
    const payload = requireRecord(raw, 'catalog album')
    const firstResource = readResourceArray(payload)[0]
    if (!firstResource) {
      throw new AppleMusicServiceError('parse-failed', 'Album not found in Apple Music catalog.')
    }

    const mappedAlbum = mapAlbum(firstResource)
    if (mappedAlbum.songs.length > 0) {
      return mappedAlbum
    }

    const includedSongs = readIncludedSongs(payload)
    if (includedSongs.length > 0) {
      return {
        ...mappedAlbum,
        songs: includedSongs,
        trackCount: Math.max(mappedAlbum.trackCount, includedSongs.length),
      }
    }

    // Last-resort fallback: Apple Music API sometimes omits track relationships.
    // Try recovering track list from search and keep only same-album songs.
    const fallbackQuery = [mappedAlbum.artistName, mappedAlbum.name]
      .filter((part) => part.trim().length > 0)
      .join(' ')
      .trim()

    if (fallbackQuery.length === 0) {
      return mappedAlbum
    }

    try {
      const fallbackSearch = await this.search(fallbackQuery, ['songs'])
      const targetArtistName = normalizeLooseText(mappedAlbum.artistName)
      const albumMatchedSongs = fallbackSearch.songs.filter((song) =>
        isAlbumNameMatch(mappedAlbum.name, song.albumName),
      )

      const strictMatchedSongs =
        targetArtistName.length === 0
          ? albumMatchedSongs
          : albumMatchedSongs.filter(
              (song) => normalizeLooseText(song.artistName) === targetArtistName,
            )

      const albumSongs =
        strictMatchedSongs.length > 0
          ? strictMatchedSongs
          : albumMatchedSongs

      if (albumSongs.length === 0) {
        return mappedAlbum
      }

      return {
        ...mappedAlbum,
        songs: albumSongs,
        trackCount: Math.max(mappedAlbum.trackCount, albumSongs.length),
      }
    } catch {
      return mappedAlbum
    }
  }

  async getCatalogPlaylist(id: string): Promise<AppleMusicPlaylist> {
    const playlistId = id.trim()
    if (playlistId.length === 0) {
      throw new AppleMusicServiceError('parse-failed', 'playlist id が空です。')
    }

    const raw = await this.invokeApi({
      action: 'catalog-playlist',
      id: playlistId,
    })
    const payload = requireRecord(raw, 'catalog playlist')
    const firstResource = readResourceArray(payload)[0]
    if (!firstResource) {
      throw new AppleMusicServiceError(
        'parse-failed',
        'Playlist not found in Apple Music catalog.',
      )
    }

    return mapPlaylist(firstResource)
  }

  async getLibraryPage(options?: {
    limit?: number
    offset?: number
  }): Promise<AppleMusicLibraryPageResult> {
    const raw = await this.invokeApi({
      action: 'library',
      limit: options?.limit,
      offset: options?.offset,
    })
    const payload = requireRecord(raw, 'library')
    const songsResources = asRecordArray(payload.songs)
    const albumsResources = asRecordArray(payload.albums)
    const playlistsResources = asRecordArray(payload.playlists)

    const songsBase =
      songsResources.length > 0
        ? songsResources
        : readResourceArray(asRecord(payload.songsRaw) ?? {})
    const albumsBase =
      albumsResources.length > 0
        ? albumsResources
        : readResourceArray(asRecord(payload.albumsRaw) ?? {})
    const playlistsBase =
      playlistsResources.length > 0
        ? playlistsResources
        : readResourceArray(asRecord(payload.playlistsRaw) ?? {})

    const songs = songsBase.map(mapSong)
    const albums = albumsBase.map(mapAlbum)
    const playlists = playlistsBase.map(mapPlaylist)

    return {
      limit: asNumber(payload.limit) ?? (options?.limit ?? 25),
      offset: asNumber(payload.offset) ?? (options?.offset ?? 0),
      nextOffset: asNullableNumber(payload.nextOffset),
      songsNextOffset: asNullableNumber(payload.songsNextOffset),
      albumsNextOffset: asNullableNumber(payload.albumsNextOffset),
      playlistsNextOffset: asNullableNumber(payload.playlistsNextOffset),
      songs,
      albums,
      playlists,
    }
  }

  async getLibrary(): Promise<AppleMusicLibraryResult> {
    const page = await this.getLibraryPage()
    return {
      songs: page.songs,
      albums: page.albums,
      playlists: page.playlists,
    }
  }

  async getBrowse(options?: {
    newReleasesLimit?: number
    topChartsLimit?: number
  }): Promise<AppleMusicBrowseResult> {
    const [newReleasesRaw, topChartsRaw] = await Promise.all([
      this.invokeApi({
        action: 'browse',
        browseKind: 'new-releases',
        limit: options?.newReleasesLimit ?? 12,
      }),
      this.invokeApi({
        action: 'browse',
        browseKind: 'top-charts',
        limit: options?.topChartsLimit ?? 10,
      }),
    ])

    const newReleasesPayload = requireRecord(newReleasesRaw, 'browse(new-releases)')
    const topChartsPayload = requireRecord(topChartsRaw, 'browse(top-charts)')

    const newReleasesResources = asRecordArray(newReleasesPayload.albums)
    const newReleasesRawRoot = asRecord(newReleasesPayload.raw) ?? {}
    const newReleasesBase =
      newReleasesResources.length > 0
        ? newReleasesResources
        : readBrowseSection(newReleasesRawRoot, 'albums')

    const topSongsResources = asRecordArray(topChartsPayload.songs)
    const topAlbumsResources = asRecordArray(topChartsPayload.albums)
    const topPlaylistsResources = asRecordArray(topChartsPayload.playlists)
    const topChartsRawRoot = asRecord(topChartsPayload.raw) ?? {}

    const topSongsBase =
      topSongsResources.length > 0
        ? topSongsResources
        : readBrowseSection(topChartsRawRoot, 'songs')
    const topAlbumsBase =
      topAlbumsResources.length > 0
        ? topAlbumsResources
        : readBrowseSection(topChartsRawRoot, 'albums')
    const topPlaylistsBase =
      topPlaylistsResources.length > 0
        ? topPlaylistsResources
        : readBrowseSection(topChartsRawRoot, 'playlists')

    return {
      newReleases: dedupeBrowseAlbums(newReleasesBase.map(mapAlbum)),
      topSongs: dedupeBrowseSongs(topSongsBase.map(mapSong)),
      topAlbums: dedupeBrowseAlbums(topAlbumsBase.map(mapAlbum)),
      topPlaylists: dedupeBrowsePlaylists(topPlaylistsBase.map(mapPlaylist)),
    }
  }
}

export const appleMusicService: AppleMusicService = new AppleMusicServiceImpl()
