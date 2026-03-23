export interface AppleMusicSong {
  id: string
  adamId: string
  title: string
  artistName: string
  albumName: string
  durationMs: number
  artworkUrl: string
  trackNumber?: number
  discNumber?: number
  genreNames: string[]
  contentRating?: string
  url?: string
}

export interface AppleMusicAlbum {
  id: string
  name: string
  artistName: string
  artworkUrl: string
  trackCount: number
  releaseDate: string
  songs: AppleMusicSong[]
  url?: string
}

export interface AppleMusicPlaylist {
  id: string
  name: string
  curatorName?: string
  artworkUrl: string
  trackCount: number
  songs: AppleMusicSong[]
  url?: string
}

export interface AppleMusicSearchResult {
  songs: AppleMusicSong[]
  albums: AppleMusicAlbum[]
  playlists: AppleMusicPlaylist[]
}

export interface AppleMusicLibraryResult {
  songs: AppleMusicSong[]
  albums: AppleMusicAlbum[]
  playlists: AppleMusicPlaylist[]
}

export interface AppleMusicLibraryPageResult extends AppleMusicLibraryResult {
  limit: number
  offset: number
  nextOffset: number | null
  songsNextOffset: number | null
  albumsNextOffset: number | null
  playlistsNextOffset: number | null
}

export interface AppleMusicBrowseResult {
  newReleases: AppleMusicAlbum[]
  topSongs: AppleMusicSong[]
  topAlbums: AppleMusicAlbum[]
  topPlaylists: AppleMusicPlaylist[]
}
