/**
 * Local Library Index
 *
 * ローカル音源管理の公開API
 */

// メタデータサービス
export {
  detectFormat,
  extractMetadata,
  extractMetadataBatch,
  extractMetadataFromFile,
  terminateWorker,
} from './metadata/metadata-service'
export {
  convertLocalTrackToISong,
  createLocalAlbumId,
  createLocalAlbumIdFromTrack,
  createLocalArtistId,
  getContentType,
  isLocalAlbumId,
  isLocalArtistId,
  toLocalSongId,
} from './mappers/subsonic'

// リポジトリ
export {
  clearLyricsCache,
  createLyricsLookupKey,
  clearAllTracks,
  deleteTrack,
  getAllTracks,
  getTracksCount,
  getTracksPage,
  getLyricsCacheStats,
  getLastScanTime,
  getMetadataValue,
  getLibraryStats,
  getTrack,
  getTrackByFilePath,
  saveTrack,
  saveTracksBatch,
  removeTracksByDirectory,
  searchTracks,
  searchTracksCount,
  searchTracksPage,
  setMetadataValue,
  setLastScanTime,
  getLyricsByLookupKey,
  markLyricsError,
  markLyricsNotFound,
  shouldRetryLyricsFetch,
  upsertLyrics,
} from './repository'
// スキャナー
export {
  getDefaultScanner,
  LocalLibraryScanner,
  scanDirectories,
} from './scanner'
// 型定義
export type {
  LyricsCacheRecord,
  LyricsCacheStats,
  LyricsCacheSource,
  LyricsCacheStatus,
  LyricsLookupInput,
} from './repository'
export type {
  LocalTrack,
  ScanCompleteCallback,
  ScanError,
  ScannerConfig,
  ScanProgress,
  ScanProgressCallback,
  ScanResult,
} from './types'
