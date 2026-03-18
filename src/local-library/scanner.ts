/**
 * Local Library Scanner
 *
 * ファイルシステムスキャン機能
 * - チャンク処理によるUIブロック回避
 * - 進捗コールバック対応
 */

import {
  LocalTrack,
  ScanCompleteCallback,
  ScanError,
  ScannerConfig,
  ScanProgress,
  ScanProgressCallback,
  ScanResult,
} from './types'

// 対応する音楽ファイル拡張子
const MUSIC_EXTENSIONS = [
  '.mp3',
  '.flac',
  '.aac',
  '.m4a', // AAC/ALAC共用
  '.alac',
]

// デフォルト設定
const DEFAULT_CONFIG: ScannerConfig = {
  directories: [],
  recursive: true,
  skipHiddenFiles: true,
  supportedFormats: MUSIC_EXTENSIONS,
  chunkSize: 100,
}

/**
 * ファイルパスから拡張子を取得
 */
function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.')
  return lastDot === -1 ? '' : filePath.slice(lastDot).toLowerCase()
}

/**
 * 隠しファイルかどうかチェック
 */
function isHiddenFile(filePath: string): boolean {
  const fileName = filePath.split(/[/\\]/).pop() || ''
  return fileName.startsWith('.')
}

/**
 * 音楽ファイルかどうかチェック
 */
function isMusicFile(filePath: string, supportedFormats: string[]): boolean {
  const ext = getExtension(filePath)
  return supportedFormats.includes(ext)
}

/**
 * メインスレッドに制御を戻す
 */
function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * 配列をチャンクに分割
 */
function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize))
  }
  return chunks
}

/**
 * ディレクトリ内の音楽ファイルを再帰的に取得
 */
async function scanDirectory(
  dirPath: string,
  config: ScannerConfig,
  onProgress?: (currentFile: string) => void,
): Promise<string[]> {
  const musicFiles: string[] = []
  const errors: string[] = []

  try {
    // File System Access APIを使用（Electron環境）
    const dirHandle = await (window as any).showDirectoryPicker()

    async function traverseDirectory(
      handle: FileSystemDirectoryHandle,
      path: string,
    ) {
      for await (const entry of handle.values()) {
        const entryPath = path ? `${path}/${entry.name}` : entry.name

        if (config.skipHiddenFiles && isHiddenFile(entry.name)) {
          continue
        }

        if (entry.kind === 'directory' && config.recursive) {
          await traverseDirectory(entry as FileSystemDirectoryHandle, entryPath)
        } else if (entry.kind === 'file') {
          if (isMusicFile(entry.name, config.supportedFormats)) {
            musicFiles.push(entryPath)
            onProgress?.(entryPath)
          }
        }
      }
    }

    await traverseDirectory(dirHandle, '')
  } catch (error) {
    // File System Access API非対応の場合はフォールバック
    console.warn('File System Access API not available, using fallback')
    return scanDirectoryFallback(dirPath, config, onProgress)
  }

  return musicFiles
}

/**
 * フォールバックスキャン（File System Access API非対応時）
 */
async function scanDirectoryFallback(
  dirPath: string,
  config: ScannerConfig,
  onProgress?: (currentFile: string) => void,
): Promise<string[]> {
  // 実装はElectronのipcRenderer経由で行う
  // ここではプレースホルダー
  console.warn('Fallback scanning not yet implemented')
  return []
}

/**
 * スキャナークラス
 */
export class LocalLibraryScanner {
  private config: ScannerConfig
  private isScanning = false
  private isPaused = false
  private abortController: AbortController | null = null

  constructor(config: Partial<ScannerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * スキャン実行
   */
  async scan(
    directories?: string[],
    onProgress?: ScanProgressCallback,
    onComplete?: ScanCompleteCallback,
  ): Promise<ScanResult> {
    if (this.isScanning) {
      throw new Error('Scan already in progress')
    }

    this.isScanning = true
    this.abortController = new AbortController()
    const dirs = directories || this.config.directories

    const startTime = Date.now()
    const result: ScanResult = {
      tracks: [],
      errors: [],
      duration: 0,
      stats: {
        totalFiles: 0,
        musicFiles: 0,
        unsupportedFiles: 0,
      },
    }

    try {
      // 1. すべての音楽ファイルパスを収集
      onProgress?.({
        status: 'scanning',
        totalFiles: 0,
        processedFiles: 0,
        foundTracks: 0,
        errors: [],
        startTime,
      })

      const allMusicFiles: string[] = []
      for (const dir of dirs) {
        if (this.abortController.signal.aborted) break
        const files = await scanDirectory(dir, this.config, (file) => {
          onProgress?.({
            status: 'scanning',
            currentFile: file,
            totalFiles: allMusicFiles.length,
            processedFiles: allMusicFiles.length,
            foundTracks: result.tracks.length,
            errors: result.errors,
            startTime,
          })
        })
        allMusicFiles.push(...files)
      }

      result.stats.totalFiles = allMusicFiles.length
      result.stats.musicFiles = allMusicFiles.length

      // 2. チャンク処理でメタデータ抽出
      const chunks = chunkArray(allMusicFiles, this.config.chunkSize)
      let processedCount = 0

      for (const chunk of chunks) {
        if (this.abortController.signal.aborted) break

        // 一時停止チェック
        while (this.isPaused && !this.abortController.signal.aborted) {
          await yieldToMainThread()
        }

        // チャンク処理（メタデータ抽出は後続タスク）
        // ここではファイルパスだけ収集
        processedCount += chunk.length

        // UI更新
        onProgress?.({
          status: 'scanning',
          totalFiles: allMusicFiles.length,
          processedFiles: processedCount,
          foundTracks: result.tracks.length,
          errors: result.errors,
          startTime,
          estimatedEndTime: this.calculateETA(
            startTime,
            processedCount,
            allMusicFiles.length,
          ),
        })

        // メインスレッドに制御を戻す
        await yieldToMainThread()
      }

      result.duration = Date.now() - startTime

      onProgress?.({
        status: 'completed',
        totalFiles: allMusicFiles.length,
        processedFiles: processedCount,
        foundTracks: result.tracks.length,
        errors: result.errors,
        startTime,
      })

      onComplete?.(result)
      return result
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      result.errors.push({
        filePath: '',
        error: errorMsg,
        timestamp: Date.now(),
      })

      onProgress?.({
        status: 'error',
        totalFiles: result.stats.totalFiles,
        processedFiles: 0,
        foundTracks: result.tracks.length,
        errors: result.errors,
        startTime,
      })

      throw error
    } finally {
      this.isScanning = false
      this.isPaused = false
      this.abortController = null
    }
  }

  /**
   * スキャン一時停止
   */
  pause(): void {
    this.isPaused = true
  }

  /**
   * スキャン再開
   */
  resume(): void {
    this.isPaused = false
  }

  /**
   * スキャン中止
   */
  abort(): void {
    this.abortController?.abort()
  }

  /**
   * スキャン中かどうか
   */
  get scanning(): boolean {
    return this.isScanning
  }

  /**
   * 推定終了時間を計算
   */
  private calculateETA(
    startTime: number,
    processed: number,
    total: number,
  ): number {
    if (processed === 0) return 0
    const elapsed = Date.now() - startTime
    const rate = elapsed / processed
    const remaining = total - processed
    return Date.now() + rate * remaining
  }

  /**
   * 設定更新
   */
  updateConfig(config: Partial<ScannerConfig>): void {
    if (this.isScanning) {
      throw new Error('Cannot update config while scanning')
    }
    this.config = { ...this.config, ...config }
  }
}

// シングルトンインスタンス
let defaultScanner: LocalLibraryScanner | null = null

/**
 * デフォルトスキャナーを取得
 */
export function getDefaultScanner(): LocalLibraryScanner {
  if (!defaultScanner) {
    defaultScanner = new LocalLibraryScanner()
  }
  return defaultScanner
}

/**
 * スキャン実行（簡易版）
 */
export async function scanDirectories(
  directories: string[],
  onProgress?: ScanProgressCallback,
): Promise<ScanResult> {
  const scanner = new LocalLibraryScanner({ directories })
  return scanner.scan(directories, onProgress)
}
