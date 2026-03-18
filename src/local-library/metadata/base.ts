/**
 * Metadata Parser Base
 *
 * メタデータ抽出の基本インターフェース
 */

import { LocalTrack } from '../types'

/**
 * メタデータ抽出結果
 */
export interface MetadataParseResult {
  success: boolean
  track?: Partial<LocalTrack>
  error?: string
}

/**
 * メタデータパーサーインターフェース
 */
export interface MetadataParser {
  /**
   * 対応フォーマットかどうかチェック
   */
  canParse(filePath: string): boolean

  /**
   * メタデータを抽出
   */
  parse(file: File | Blob): Promise<MetadataParseResult>
}

/**
 * ファイルハッシュを生成（ID生成用）
 */
export async function generateFileHash(filePath: string): Promise<string> {
  // 簡易実装: ファイルパスをBase64エンコード
  // 実際にはファイル内容のハッシュを使うべき
  return btoa(unescape(encodeURIComponent(filePath)))
}

/**
 * ファイル情報を取得
 */
export async function getFileInfo(file: File): Promise<{
  size: number
  modifiedAt: number
  createdAt: number
}> {
  return {
    size: file.size,
    modifiedAt: file.lastModified,
    createdAt: file.lastModified, // File APIでは作成日時取得不可
  }
}

/**
 * ファイルをArrayBufferとして読み込み
 */
export function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(file)
  })
}

/**
 * ファイルをData URLとして読み込み（アートワーク用）
 */
export function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}
