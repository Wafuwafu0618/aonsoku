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
  clearAllTracks,
  deleteTrack,
  getAllTracks,
  getTracksCount,
  getTracksPage,
  getLastScanTime,
  getLibraryStats,
  getTrack,
  getTrackByFilePath,
  saveTrack,
  saveTracksBatch,
  removeTracksByDirectory,
  searchTracks,
  searchTracksCount,
  searchTracksPage,
  setLastScanTime,
} from './repository'
// スキャナー
export {
  getDefaultScanner,
  LocalLibraryScanner,
  scanDirectories,
} from './scanner'
// 型定義
export type {
  LocalTrack,
  ScanCompleteCallback,
  ScanError,
  ScannerConfig,
  ScanProgress,
  ScanProgressCallback,
  ScanResult,
} from './types'
