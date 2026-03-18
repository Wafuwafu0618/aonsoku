/**
 * Metadata Extraction Service
 *
 * Web Workerを使用したメタデータ抽出のラッパー
 */

import type { MetadataParseResult } from '../types'

// Workerインスタンス（遅延初期化）
let worker: Worker | null = null

/**
 * Workerを取得または作成
 */
function getWorker(): Worker {
  if (!worker) {
    // Vite環境ではnew URL()構文を使用
    worker = new Worker(new URL('./metadata-worker.ts', import.meta.url), {
      type: 'module',
    })
  }
  return worker
}

/**
 * Workerを終了
 */
export function terminateWorker(): void {
  if (worker) {
    worker.terminate()
    worker = null
  }
}

/**
 * 単一ファイルのメタデータを抽出
 */
export async function extractMetadata(
  filePath: string,
  fileData: ArrayBuffer,
  format: 'mp3' | 'flac' | 'aac' | 'alac' | 'other',
): Promise<MetadataParseResult> {
  return new Promise((resolve) => {
    const w = getWorker()

    const handleMessage = (event: MessageEvent) => {
      const { type, filePath: resultPath, result, error } = event.data

      if (resultPath === filePath) {
        w.removeEventListener('message', handleMessage)

        if (type === 'result') {
          resolve(result)
        } else if (type === 'error') {
          resolve({ success: false, error })
        }
      }
    }

    w.addEventListener('message', handleMessage)
    w.postMessage({
      type: 'extract',
      filePath,
      fileData,
      format,
    })
  })
}

/**
 * 複数ファイルのメタデータをバッチ抽出
 */
export async function extractMetadataBatch(
  files: Array<{
    filePath: string
    fileData: ArrayBuffer
    format: 'mp3' | 'flac' | 'aac' | 'alac' | 'other'
  }>,
  onProgress?: (current: number, total: number) => void,
): Promise<Array<{ filePath: string; result: MetadataParseResult }>> {
  const results: Array<{ filePath: string; result: MetadataParseResult }> = []
  const w = getWorker()

  return new Promise((resolve) => {
    let completed = 0
    const total = files.length

    const handleMessage = (event: MessageEvent) => {
      const { type, filePath, result, error } = event.data

      if (type === 'result' || type === 'error') {
        results.push({
          filePath,
          result: type === 'result' ? result : { success: false, error },
        })

        completed++
        onProgress?.(completed, total)

        if (completed >= total) {
          w.removeEventListener('message', handleMessage)
          resolve(results)
        }
      }
    }

    w.addEventListener('message', handleMessage)

    // すべてのファイルを送信
    for (const file of files) {
      w.postMessage({
        type: 'extract',
        filePath: file.filePath,
        fileData: file.fileData,
        format: file.format,
      })
    }
  })
}

/**
 * ファイルフォーマットを判定
 */
export function detectFormat(
  filePath: string,
): 'mp3' | 'flac' | 'aac' | 'alac' | 'other' {
  const ext = filePath.toLowerCase().split('.').pop()

  switch (ext) {
    case 'mp3':
      return 'mp3'
    case 'flac':
      return 'flac'
    case 'm4a':
    case 'mp4':
      // m4a/mp4はAACかALACか判定が必要（ここでは仮にaac）
      return 'aac'
    case 'alac':
      return 'alac'
    default:
      return 'other'
  }
}

/**
 * ファイルを読み込んでメタデータを抽出
 */
export async function extractMetadataFromFile(
  file: File,
): Promise<MetadataParseResult> {
  const format = detectFormat(file.name)

  try {
    const arrayBuffer = await file.arrayBuffer()
    return extractMetadata(file.name, arrayBuffer, format)
  } catch (error) {
    return {
      success: false,
      error: `File read error: ${error instanceof Error ? error.message : 'Unknown'}`,
    }
  }
}
