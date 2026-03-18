/**
 * Local Library Index
 *
 * ローカル音源管理の公開API
 */

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

// メタデータパーサー（後続タスクで実装）
// export * from './metadata/id3-parser'
// export * from './metadata/vorbis-parser'
// export * from './metadata/mp4-parser'
