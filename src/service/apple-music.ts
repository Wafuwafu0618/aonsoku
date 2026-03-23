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
  const tracks = asRecord(relationships.tracks)
  const songResources = asRecordArray(tracks?.data)

  return {
    id: asString(resource.id) ?? '',
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
  const tracks = asRecord(relationships.tracks)
  const songResources = asRecordArray(tracks?.data)

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
  return readSectionData(results[key])
}

function normalizeSearchTypes(types: string[]): string[] {
  const filtered = types
    .map((type) => type.trim())
    .filter((type) => type.length > 0)

  return filtered.length > 0 ? filtered : DEFAULT_SEARCH_TYPES
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
      throw new Error(
        'Apple Music browser session API は Desktop(Electron) 環境でのみ利用できます。',
      )
    }

    const result = await api.appleMusicApiRequest(payload)
    if (!result?.ok) {
      const message =
        result?.error?.message ?? 'Apple Music browser session API request failed.'
      throw new Error(message)
    }

    return result.data
  }

  async initialize(): Promise<void> {
    const raw = await this.invokeApi({ action: 'status' })
    const status = asRecord(raw) ?? {}
    const isAuthorized = Boolean(status.isAuthorized)
    const storefrontId = asString(status.storefrontId) ?? DEFAULT_STOREFRONT

    this.authorized = isAuthorized
    this.storefrontId = storefrontId

    if (!isAuthorized) {
      throw new Error(
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

    const payload = asRecord(raw) ?? {}

    return {
      songs: readSearchSection(payload, 'songs').map(mapSong),
      albums: readSearchSection(payload, 'albums').map(mapAlbum),
      playlists: readSearchSection(payload, 'playlists').map(mapPlaylist),
    }
  }

  async getCatalogAlbum(id: string): Promise<AppleMusicAlbum> {
    const albumId = id.trim()
    if (albumId.length === 0) {
      throw new Error('album id が空です。')
    }

    const raw = await this.invokeApi({
      action: 'catalog-album',
      id: albumId,
    })
    const payload = asRecord(raw) ?? {}
    const firstResource = readResourceArray(payload)[0]
    if (!firstResource) {
      throw new Error('Album not found in Apple Music catalog.')
    }

    return mapAlbum(firstResource)
  }

  async getCatalogPlaylist(id: string): Promise<AppleMusicPlaylist> {
    const playlistId = id.trim()
    if (playlistId.length === 0) {
      throw new Error('playlist id が空です。')
    }

    const raw = await this.invokeApi({
      action: 'catalog-playlist',
      id: playlistId,
    })
    const payload = asRecord(raw) ?? {}
    const firstResource = readResourceArray(payload)[0]
    if (!firstResource) {
      throw new Error('Playlist not found in Apple Music catalog.')
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
    const payload = asRecord(raw) ?? {}
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

    const newReleasesPayload = asRecord(newReleasesRaw) ?? {}
    const topChartsPayload = asRecord(topChartsRaw) ?? {}

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
      newReleases: newReleasesBase.map(mapAlbum),
      topSongs: topSongsBase.map(mapSong),
      topAlbums: topAlbumsBase.map(mapAlbum),
      topPlaylists: topPlaylistsBase.map(mapPlaylist),
    }
  }
}

export const appleMusicService: AppleMusicService = new AppleMusicServiceImpl()
