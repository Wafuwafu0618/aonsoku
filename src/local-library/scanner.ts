import { createDomainId } from '@/domain/id'
import {
  listLocalLibraryFiles,
  readLocalLibraryFile,
} from '@/platform/adapters/local-library-adapter'
import { detectFormat, extractMetadata } from './metadata/metadata-service'
import {
  buildSearchIndex,
  clearAllTracks,
  saveTracksBatch,
  setLastScanTime,
} from './repository'
import type {
  LocalTrack,
  ScanCompleteCallback,
  ScanError,
  ScannerConfig,
  ScanProgress,
  ScanProgressCallback,
  ScanResult,
} from './types'

const DEFAULT_CONFIG: ScannerConfig = {
  directories: [],
  recursive: true,
  skipHiddenFiles: true,
  supportedFormats: ['.mp3', '.flac', '.aac', '.m4a', '.alac'],
  chunkSize: 25,
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize))
  }
  return chunks
}

function toScanError(filePath: string, error: unknown): ScanError {
  return {
    filePath,
    error: error instanceof Error ? error.message : 'Unknown error',
    timestamp: Date.now(),
  }
}

function toLocalTrack(base: {
  filePath: string
  size: number
  modifiedAt: number
  createdAt: number
}): LocalTrack {
  const sourceId = base.filePath

  return {
    id: createDomainId('local', sourceId),
    source: 'local',
    sourceId,
    filePath: base.filePath,
    title: base.filePath.split(/[\\/]/).pop() ?? 'Unknown Track',
    artist: 'Unknown Artist',
    album: 'Unknown Album',
    duration: 0,
    fileSize: base.size,
    modifiedAt: base.modifiedAt,
    createdAt: base.createdAt,
    format: 'other',
    codec: 'Unknown',
  }
}

export class LocalLibraryScanner {
  private config: ScannerConfig
  private isScanning = false
  private isPaused = false
  private abortController: AbortController | null = null

  constructor(config: Partial<ScannerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  async scan(
    directories?: string[],
    onProgress?: ScanProgressCallback,
    onComplete?: ScanCompleteCallback,
  ): Promise<ScanResult> {
    if (this.isScanning) {
      throw new Error('Scan already in progress')
    }

    const startTime = Date.now()
    const progress: ScanProgress = {
      status: 'scanning',
      totalFiles: 0,
      processedFiles: 0,
      foundTracks: 0,
      errors: [],
      startTime,
    }

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

    this.isScanning = true
    this.abortController = new AbortController()

    try {
      const activeDirectories =
        directories && directories.length > 0
          ? directories
          : this.config.directories

      if (activeDirectories.length === 0) {
        progress.status = 'completed'
        onProgress?.(progress)
        onComplete?.(result)
        return result
      }

      const files = await listLocalLibraryFiles(activeDirectories)
      result.stats.totalFiles = files.length
      result.stats.musicFiles = files.length
      progress.totalFiles = files.length
      onProgress?.(progress)

      await clearAllTracks()

      const chunks = chunkArray(files, this.config.chunkSize)
      const tracksToSave: LocalTrack[] = []

      for (const chunk of chunks) {
        if (this.abortController.signal.aborted) break

        while (this.isPaused && !this.abortController.signal.aborted) {
          await yieldToMainThread()
        }

        for (const file of chunk) {
          if (this.abortController.signal.aborted) break

          progress.currentFile = file.path

          try {
            const fileContent = await readLocalLibraryFile(file.path)
            const format = detectFormat(file.path)
            const metadata = await extractMetadata(
              file.path,
              fileContent.data,
              format,
            )

            const baseTrack = toLocalTrack({
              filePath: file.path,
              size: file.size,
              modifiedAt: file.modifiedAt,
              createdAt: file.createdAt,
            })

            const mergedTrack: LocalTrack = {
              ...baseTrack,
              ...(metadata.track ?? {}),
              id: createDomainId('local', baseTrack.sourceId),
              source: 'local',
              sourceId: baseTrack.sourceId,
              filePath: file.path,
              fileSize: file.size,
              modifiedAt: file.modifiedAt,
              createdAt: file.createdAt,
            }

            tracksToSave.push(mergedTrack)
            result.tracks.push(mergedTrack)
          } catch (error) {
            const scanError = toScanError(file.path, error)
            result.errors.push(scanError)
            progress.errors = result.errors
          }

          progress.processedFiles += 1
          progress.foundTracks = result.tracks.length
          progress.estimatedEndTime = this.calculateETA(
            startTime,
            progress.processedFiles,
            progress.totalFiles,
          )
          onProgress?.({ ...progress })
        }

        await yieldToMainThread()
      }

      if (tracksToSave.length > 0) {
        await saveTracksBatch(tracksToSave)
        await buildSearchIndex(tracksToSave)
      }

      const finishedAt = Date.now()
      await setLastScanTime(finishedAt)

      result.duration = finishedAt - startTime
      progress.status = this.abortController.signal.aborted
        ? 'idle'
        : 'completed'
      onProgress?.({ ...progress })
      onComplete?.(result)

      return result
    } catch (error) {
      const scanError = toScanError(progress.currentFile ?? '', error)
      result.errors.push(scanError)
      progress.status = 'error'
      progress.errors = result.errors
      onProgress?.({ ...progress })
      throw error
    } finally {
      this.isScanning = false
      this.isPaused = false
      this.abortController = null
    }
  }

  pause(): void {
    this.isPaused = true
  }

  resume(): void {
    this.isPaused = false
  }

  abort(): void {
    this.abortController?.abort()
  }

  get scanning(): boolean {
    return this.isScanning
  }

  updateConfig(config: Partial<ScannerConfig>): void {
    if (this.isScanning) {
      throw new Error('Cannot update config while scanning')
    }

    this.config = { ...this.config, ...config }
  }

  private calculateETA(
    startTime: number,
    processed: number,
    total: number,
  ): number {
    if (processed <= 0 || total <= 0) return 0
    const elapsed = Date.now() - startTime
    const rate = elapsed / processed
    const remaining = total - processed
    return Date.now() + rate * Math.max(0, remaining)
  }
}

let defaultScanner: LocalLibraryScanner | null = null

export function getDefaultScanner(): LocalLibraryScanner {
  if (!defaultScanner) {
    defaultScanner = new LocalLibraryScanner()
  }

  return defaultScanner
}

export async function scanDirectories(
  directories: string[],
  onProgress?: ScanProgressCallback,
): Promise<ScanResult> {
  const scanner = new LocalLibraryScanner({ directories })
  return scanner.scan(directories, onProgress)
}
