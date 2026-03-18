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

// リポジトリ
export {
  clearAllTracks,
  deleteTrack,
  getAllTracks,
  getLastScanTime,
  getLibraryStats,
  getTrack,
  getTrackByFilePath,
  saveTrack,
  saveTracksBatch,
  searchTracks,
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
