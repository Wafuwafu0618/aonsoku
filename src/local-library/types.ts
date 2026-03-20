/**
 * Local Library Types
 *
 * ローカル音源管理用の型定義
 */

import { MediaSource } from '@/domain/media-source'

/**
 * ローカル曲メタデータ
 */
export interface LocalTrack {
  id: string
  source: MediaSource
  sourceId: string // ファイルパスをハッシュ化したもの
  filePath: string // 絶対パス

  // メタデータ
  title: string
  artist: string
  album: string
  albumArtist?: string
  trackNumber?: number
  discNumber?: number
  year?: number
  genre?: string
  duration: number // 秒
  bitrate?: number // kbps
  sampleRate?: number // Hz
  channels?: number

  // ファイル情報
  fileSize: number // bytes
  modifiedAt: number // Unix timestamp (ms)
  createdAt: number // Unix timestamp (ms)

  // アートワーク
  coverArt?: string // Data URL or file path

  // フォーマット情報
  format: 'mp3' | 'flac' | 'aac' | 'alac' | 'other'
  codec: string
}

/**
 * スキャン進捗
 */
export interface ScanProgress {
  status: 'idle' | 'scanning' | 'paused' | 'completed' | 'error'
  currentFile?: string
  totalFiles: number
  processedFiles: number
  foundTracks: number
  errors: ScanError[]
  startTime?: number
  estimatedEndTime?: number
}

/**
 * スキャンエラー
 */
export interface ScanError {
  filePath: string
  error: string
  timestamp: number
}

/**
 * スキャン設定
 */
export interface ScannerConfig {
  directories: string[]
  recursive: boolean
  skipHiddenFiles: boolean
  supportedFormats: string[]
  chunkSize: number // チャンクサイズ（ファイル数）
}

/**
 * スキャン結果
 */
export interface ScanResult {
  tracks: LocalTrack[]
  errors: ScanError[]
  duration: number // スキャンにかかった時間（ms）
  stats: {
    totalFiles: number
    musicFiles: number
    unsupportedFiles: number
  }
}

/**
 * スキャン進捗コールバック
 */
export type ScanProgressCallback = (progress: ScanProgress) => void

/**
 * スキャン完了コールバック
 */
export type ScanCompleteCallback = (result: ScanResult) => void

/**
 * メタデータ抽出結果
 */
export interface MetadataParseResult {
  success: boolean
  track?: Partial<LocalTrack>
  error?: string
}
