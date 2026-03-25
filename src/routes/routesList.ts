import { AlbumListType } from '@/types/responses/album'
import { AlbumsFilters, YearFilter } from '@/utils/albumsFilter'

const LIBRARY = {
  HOME: '/',
  ARTISTS: '/library/artists',
  SONGS: '/library/songs',
  ALBUMS: '/library/albums',
  FAVORITES: '/library/favorites',
  MIXES: '/library/mixes',
  PLAYLISTS: '/library/playlists',
  APPLE_MUSIC: '/library/apple-music',
  PODCASTS: '/library/podcasts',
  EPISODES: '/library/episodes',
  RADIOS: '/library/radios',
}

const ARTIST = {
  PAGE: (artistId: string) => `${LIBRARY.ARTISTS}/${artistId}`,
  PATH: `${LIBRARY.ARTISTS}/:artistId`,
}

const ALBUM = {
  PAGE: (albumId: string) => `${LIBRARY.ALBUMS}/${albumId}`,
  PATH: `${LIBRARY.ALBUMS}/:albumId`,
}

const ALBUMS = {
  GENRE: (genre: string) =>
    `${LIBRARY.ALBUMS}?filter=${AlbumsFilters.ByGenre}&genre=${encodeURIComponent(genre)}`,
  ARTIST: (id: string, name: string) =>
    `${LIBRARY.ALBUMS}?filter=${AlbumsFilters.ByDiscography}&artistId=${id}&artistName=${encodeURIComponent(name)}`,
  RECENTLY_PLAYED: `${LIBRARY.ALBUMS}?filter=${AlbumsFilters.RecentlyPlayed}`,
  MOST_PLAYED: `${LIBRARY.ALBUMS}?filter=${AlbumsFilters.MostPlayed}`,
  RECENTLY_ADDED: `${LIBRARY.ALBUMS}?filter=${AlbumsFilters.RecentlyAdded}`,
  RANDOM: `${LIBRARY.ALBUMS}?filter=${AlbumsFilters.Random}`,
  SEARCH: (query: string) =>
    `${LIBRARY.ALBUMS}?filter=${AlbumsFilters.Search}&query=${encodeURIComponent(query)}`,
  YEAR: (yearFilter: YearFilter) =>
    `${LIBRARY.ALBUMS}?filter=${AlbumsFilters.ByYear}&yearFilter=${yearFilter}`,
  GENERIC: (filter: AlbumListType) => `${LIBRARY.ALBUMS}?filter=${filter}`,
}

const SONGS = {
  SEARCH: (query: string) =>
    `${LIBRARY.SONGS}?filter=${AlbumsFilters.Search}&query=${encodeURIComponent(query)}`,
  ARTIST_TRACKS: (id: string, name: string) =>
    `${LIBRARY.SONGS}?artistId=${id}&artistName=${encodeURIComponent(name)}`,
}

const FAVORITES = {
  PAGE: LIBRARY.FAVORITES,
}

const PLAYLIST = {
  PAGE: (playlistId: string) => `${LIBRARY.PLAYLISTS}/${playlistId}`,
  PATH: `${LIBRARY.PLAYLISTS}/:playlistId`,
}

const MIX = {
  PAGE: (mixId: string) => `${LIBRARY.MIXES}/${mixId}`,
  PATH: `${LIBRARY.MIXES}/:mixId`,
}

const PODCASTS = {
  PAGE: (podcastId: string) => `${LIBRARY.PODCASTS}/${podcastId}`,
  PATH: `${LIBRARY.PODCASTS}/:podcastId`,
}

const EPISODES = {
  PAGE: (episodeId: string) => `${LIBRARY.EPISODES}/${episodeId}`,
  PATH: `${LIBRARY.EPISODES}/:episodeId`,
  LATEST: `${LIBRARY.EPISODES}/latest`,
}

const APPLE_MUSIC_GENRE = {
  PAGE: (genre: string) => `/apple-music/genre/${encodeURIComponent(genre)}`,
  PATH: '/apple-music/genre/:genre',
}

const APPLE_MUSIC_ALBUM = {
  PAGE: (albumId: string, genre?: string) =>
    genre
      ? `/apple-music/album/${encodeURIComponent(albumId)}?genre=${encodeURIComponent(genre)}`
      : `/apple-music/album/${encodeURIComponent(albumId)}`,
  PATH: '/apple-music/album/:albumId',
}

const SERVER_CONFIG = '/server-config'

export const ROUTES = {
  LIBRARY,
  ARTIST,
  ALBUM,
  ALBUMS,
  SONGS,
  FAVORITES,
  PLAYLIST,
  MIX,
  PODCASTS,
  EPISODES,
  APPLE_MUSIC_GENRE,
  APPLE_MUSIC_ALBUM,
  SERVER_CONFIG,
}
