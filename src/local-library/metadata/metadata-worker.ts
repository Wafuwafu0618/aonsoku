/**
 * Metadata Extraction Worker
 *
 * Web Workerでメタデータを抽出
 * 重い処理をメインスレッドから分離
 */

import type { LocalTrack, MetadataParseResult } from '../types'

// Workerコンテキスト型定義
declare const self: Worker & typeof globalThis

/**
 * Workerメッセージ型
 */
interface ExtractMessage {
  type: 'extract'
  filePath: string
  fileData: ArrayBuffer
  format: 'mp3' | 'flac' | 'aac' | 'alac' | 'other'
}

interface ExtractResultMessage {
  type: 'result'
  filePath: string
  result: MetadataParseResult
}

interface ExtractErrorMessage {
  type: 'error'
  filePath: string
  error: string
}

type MetadataValue = string | number[]
type ITunesMetadata = Record<string, MetadataValue>

interface ParsedAudioProperties {
  duration?: number
  bitrate?: number
  sampleRate?: number
  channels?: number
}

function toPositiveNumber(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined
  }

  return value
}

function safeDurationSeconds(value: number): number | undefined {
  const duration = toPositiveNumber(value)
  if (!duration) return undefined

  return Math.max(1, Math.round(duration))
}

function readAscii(data: ArrayBuffer, start: number, end: number): string {
  const decoder = new TextDecoder('ascii')
  return decoder.decode(data.slice(start, end))
}

function parseMp3AudioProperties(fileData: ArrayBuffer): ParsedAudioProperties {
  const bytes = new Uint8Array(fileData)
  if (bytes.length < 4) return {}

  let audioOffset = 0

  if (
    bytes.length >= 10 &&
    bytes[0] === 0x49 &&
    bytes[1] === 0x44 &&
    bytes[2] === 0x33
  ) {
    const id3Size =
      ((bytes[6] & 0x7f) << 21) |
      ((bytes[7] & 0x7f) << 14) |
      ((bytes[8] & 0x7f) << 7) |
      (bytes[9] & 0x7f)
    audioOffset = 10 + id3Size
  }

  let frameOffset = audioOffset
  const scanLimit = Math.min(bytes.length - 4, audioOffset + 128 * 1024)

  while (frameOffset < scanLimit) {
    const b0 = bytes[frameOffset]
    const b1 = bytes[frameOffset + 1]
    if (b0 === 0xff && (b1 & 0xe0) === 0xe0) break
    frameOffset += 1
  }

  if (frameOffset >= scanLimit) return {}

  const header =
    (bytes[frameOffset] << 24) |
    (bytes[frameOffset + 1] << 16) |
    (bytes[frameOffset + 2] << 8) |
    bytes[frameOffset + 3]

  const versionBits = (header >>> 19) & 0x3
  const layerBits = (header >>> 17) & 0x3
  const bitrateIndex = (header >>> 12) & 0xf
  const sampleRateIndex = (header >>> 10) & 0x3
  const channelMode = (header >>> 6) & 0x3

  if (
    versionBits === 0x1 ||
    layerBits === 0x0 ||
    bitrateIndex === 0x0 ||
    bitrateIndex === 0xf ||
    sampleRateIndex === 0x3
  ) {
    return {}
  }

  const isMpeg1 = versionBits === 0x3
  const isMpeg2 = versionBits === 0x2
  const version: 'mpeg1' | 'mpeg2' | 'mpeg25' = isMpeg1
    ? 'mpeg1'
    : isMpeg2
      ? 'mpeg2'
      : 'mpeg25'
  const layer: 'layer1' | 'layer2' | 'layer3' =
    layerBits === 0x3 ? 'layer1' : layerBits === 0x2 ? 'layer2' : 'layer3'

  const sampleRateTable: Record<typeof version, number[]> = {
    mpeg1: [44100, 48000, 32000],
    mpeg2: [22050, 24000, 16000],
    mpeg25: [11025, 12000, 8000],
  }

  const bitrateTable: Record<typeof version, Record<typeof layer, number[]>> = {
    mpeg1: {
      layer1: [
        0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0,
      ],
      layer2: [
        0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0,
      ],
      layer3: [
        0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
      ],
    },
    mpeg2: {
      layer1: [
        0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0,
      ],
      layer2: [
        0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
      ],
      layer3: [
        0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
      ],
    },
    mpeg25: {
      layer1: [
        0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0,
      ],
      layer2: [
        0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
      ],
      layer3: [
        0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
      ],
    },
  }

  const sampleRate = sampleRateTable[version][sampleRateIndex]
  const bitrate = bitrateTable[version][layer][bitrateIndex]

  if (!sampleRate || !bitrate) return {}

  let audioBytes = Math.max(0, bytes.length - audioOffset)

  if (bytes.length >= 128) {
    const tailTag = readAscii(fileData, bytes.length - 128, bytes.length - 125)
    if (tailTag === 'TAG') {
      audioBytes = Math.max(0, audioBytes - 128)
    }
  }

  const duration = safeDurationSeconds((audioBytes * 8) / (bitrate * 1000))

  return {
    duration,
    bitrate: toPositiveNumber(bitrate),
    sampleRate: toPositiveNumber(sampleRate),
    channels: channelMode === 0x3 ? 1 : 2,
  }
}

function parseFlacAudioProperties(fileData: ArrayBuffer): ParsedAudioProperties {
  if (fileData.byteLength < 42) return {}
  if (readAscii(fileData, 0, 4) !== 'fLaC') return {}

  let offset = 4

  while (offset + 4 <= fileData.byteLength) {
    const header = new DataView(fileData, offset, 4)
    const blockType = header.getUint8(0) & 0x7f
    const isLast = (header.getUint8(0) & 0x80) !== 0
    const blockSize =
      (header.getUint8(1) << 16) |
      (header.getUint8(2) << 8) |
      header.getUint8(3)

    offset += 4
    if (offset + blockSize > fileData.byteLength) break

    if (blockType === 0 && blockSize >= 18) {
      const view = new DataView(fileData, offset, blockSize)
      const sampleRate =
        (view.getUint8(10) << 12) |
        (view.getUint8(11) << 4) |
        (view.getUint8(12) >> 4)
      const channels = ((view.getUint8(12) >> 1) & 0x07) + 1
      const totalSamplesHigh = view.getUint8(13) & 0x0f
      const totalSamplesLow = view.getUint32(14, false)
      const totalSamples = totalSamplesHigh * 2 ** 32 + totalSamplesLow

      const duration =
        sampleRate > 0 ? safeDurationSeconds(totalSamples / sampleRate) : undefined
      const bitrate =
        duration && duration > 0
          ? toPositiveNumber(
              Math.round((fileData.byteLength * 8) / (duration * 1000)),
            )
          : undefined

      return {
        duration,
        bitrate,
        sampleRate: toPositiveNumber(sampleRate),
        channels: toPositiveNumber(channels),
      }
    }

    if (isLast) break
    offset += blockSize
  }

  return {}
}

function findMp4Box(
  data: ArrayBuffer,
  targetType: string,
  startOffset = 0,
  endOffset = data.byteLength,
): { offset: number; size: number } | null {
  let offset = startOffset

  while (offset + 8 <= endOffset) {
    const size = new DataView(data, offset, 4).getUint32(0, false)
    const type = readAscii(data, offset + 4, offset + 8)
    if (size < 8) break

    if (type === targetType) {
      return { offset, size }
    }

    offset += size
  }

  return null
}

function parseMp4AudioProperties(fileData: ArrayBuffer): ParsedAudioProperties {
  const moov = findMp4Box(fileData, 'moov')
  if (!moov) return {}

  const moovStart = moov.offset + 8
  const moovEnd = moov.offset + moov.size
  const mvhd = findMp4Box(fileData, 'mvhd', moovStart, moovEnd)
  if (!mvhd) return {}

  const bodyOffset = mvhd.offset + 8
  if (bodyOffset + 4 > fileData.byteLength) return {}

  const view = new DataView(fileData)
  const version = view.getUint8(bodyOffset)

  let timescale = 0
  let durationUnits = 0

  if (version === 1) {
    if (bodyOffset + 32 > fileData.byteLength) return {}
    timescale = view.getUint32(bodyOffset + 20, false)
    const upper = view.getUint32(bodyOffset + 24, false)
    const lower = view.getUint32(bodyOffset + 28, false)
    durationUnits = upper * 2 ** 32 + lower
  } else {
    if (bodyOffset + 20 > fileData.byteLength) return {}
    timescale = view.getUint32(bodyOffset + 12, false)
    durationUnits = view.getUint32(bodyOffset + 16, false)
  }

  if (timescale <= 0 || durationUnits <= 0) return {}

  const duration = safeDurationSeconds(durationUnits / timescale)
  const bitrate =
    duration && duration > 0
      ? toPositiveNumber(
          Math.round((fileData.byteLength * 8) / (duration * 1000)),
        )
      : undefined

  return {
    duration,
    bitrate,
  }
}

function getMetadataString(
  metadata: ITunesMetadata,
  key: string,
): string | undefined {
  const value = metadata[key]
  return typeof value === 'string' ? value : undefined
}

function getMetadataTuple(
  metadata: ITunesMetadata,
  key: string,
): number[] | undefined {
  const value = metadata[key]
  return Array.isArray(value) ? value : undefined
}

/**
 * メタデータ抽出メイン関数
 */
async function extractMetadata(
  filePath: string,
  fileData: ArrayBuffer,
  format: string,
): Promise<MetadataParseResult> {
  try {
    // フォーマット別にパーサーを選択
    switch (format) {
      case 'mp3':
        return await extractMP3Metadata(filePath, fileData)
      case 'flac':
        return await extractFLACMetadata(filePath, fileData)
      case 'aac':
      case 'alac':
        return await extractMP4Metadata(filePath, fileData)
      default:
        return {
          success: false,
          error: `Unsupported format: ${format}`,
        }
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * MP3/ID3v2メタデータ抽出
 */
async function extractMP3Metadata(
  filePath: string,
  fileData: ArrayBuffer,
): Promise<MetadataParseResult> {
  try {
    const audioProps = parseMp3AudioProperties(fileData)
    const decoder = new TextDecoder('utf-8')

    // ID3v2ヘッダー確認
    const id3Header = decoder.decode(fileData.slice(0, 10))
    if (!id3Header.startsWith('ID3')) {
      // ID3タグなし - 基本情報のみ返す
      return {
        success: true,
        track: {
          ...createBasicTrack(filePath, fileData.byteLength, 'mp3'),
          duration: audioProps.duration,
          bitrate: audioProps.bitrate,
          sampleRate: audioProps.sampleRate,
          channels: audioProps.channels,
        },
      }
    }

    // ID3v2バージョン取得
    const version = id3Header.charCodeAt(3)
    // タグサイズ取得（同期safe integer）
    const sizeBytes = new Uint8Array(fileData.slice(6, 10))
    const tagSize =
      ((sizeBytes[0] & 0x7f) << 21) |
      ((sizeBytes[1] & 0x7f) << 14) |
      ((sizeBytes[2] & 0x7f) << 7) |
      (sizeBytes[3] & 0x7f)

    // タグ本体を解析
    const tagData = fileData.slice(10, 10 + tagSize)
    const metadata = parseID3Frames(tagData, version)

    return {
      success: true,
      track: {
        ...createBasicTrack(filePath, fileData.byteLength, 'mp3'),
        duration: audioProps.duration,
        title: metadata.title || getFilenameWithoutExt(filePath),
        artist: metadata.artist || 'Unknown Artist',
        album: metadata.album || 'Unknown Album',
        albumArtist: metadata.albumArtist,
        trackNumber: metadata.trackNumber,
        discNumber: metadata.discNumber,
        year: metadata.year,
        genre: metadata.genre,
        bitrate: audioProps.bitrate,
        sampleRate: audioProps.sampleRate,
        channels: audioProps.channels,
      },
    }
  } catch (error) {
    return {
      success: false,
      error: `MP3 parse error: ${error instanceof Error ? error.message : 'Unknown'}`,
    }
  }
}

/**
 * ID3v2フレーム解析
 */
function parseID3Frames(
  tagData: ArrayBuffer,
  version: number,
): {
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  trackNumber?: number
  discNumber?: number
  year?: number
  genre?: string
} {
  const result: ReturnType<typeof parseID3Frames> = {}
  const dataView = new DataView(tagData)
  const decoder = new TextDecoder('utf-8')

  let offset = version >= 3 ? 0 : 0 // ID3v2.2は別処理が必要
  const tagSize = tagData.byteLength

  while (offset < tagSize - 10) {
    // フレームID取得
    let frameId: string
    let frameSize: number

    if (version >= 3) {
      // ID3v2.3/2.4
      frameId = decoder.decode(tagData.slice(offset, offset + 4))
      frameSize = dataView.getUint32(offset + 4, false)
      // frameFlags = dataView.getUint16(offset + 8, false)
      offset += 10
    } else {
      // ID3v2.2（3文字ID）
      frameId = decoder.decode(tagData.slice(offset, offset + 3))
      frameSize =
        (dataView.getUint8(offset + 3) << 16) |
        (dataView.getUint8(offset + 4) << 8) |
        dataView.getUint8(offset + 5)
      offset += 6
    }

    if (frameId === '\x00\x00\x00\x00' || frameId === '\x00\x00\x00') {
      break // パディング到達
    }

    const frameData = tagData.slice(offset, offset + frameSize)
    const text = decodeID3Text(frameData)

    // 主要フレームを抽出
    switch (frameId) {
      case 'TIT2': // タイトル
      case 'TT2': // ID3v2.2
        result.title = text
        break
      case 'TPE1': // アーティスト
      case 'TP1': // ID3v2.2
        result.artist = text
        break
      case 'TALB': // アルバム
      case 'TAL': // ID3v2.2
        result.album = text
        break
      case 'TPE2': // アルバムアーティスト
      case 'TP2': // ID3v2.2
        result.albumArtist = text
        break
      case 'TRCK': // トラック番号
      case 'TRK': // ID3v2.2
        result.trackNumber = parseInt(text.split('/')[0], 10) || undefined
        break
      case 'TPOS': // ディスク番号
      case 'TPA': // ID3v2.2
        result.discNumber = parseInt(text.split('/')[0], 10) || undefined
        break
      case 'TYER': // 年（ID3v2.3）
      case 'TYE': // ID3v2.2
        result.year = parseInt(text, 10) || undefined
        break
      case 'TDRC': // 録音日時（ID3v2.4）
        result.year = parseInt(text.substring(0, 4), 10) || undefined
        break
      case 'TCON': // ジャンル
      case 'TCO': // ID3v2.2
        result.genre = text.replace(/^\(\d+\)/, '') // (13)Pop → Pop
        break
    }

    offset += frameSize
  }

  return result
}

/**
 * ID3テキストフレームデコード
 */
function decodeID3Text(frameData: ArrayBuffer): string {
  if (frameData.byteLength < 1) return ''

  const dataView = new DataView(frameData)
  const encoding = dataView.getUint8(0)
  const textData = frameData.slice(1)

  let decoder: TextDecoder
  switch (encoding) {
    case 0: // ISO-8859-1
      decoder = new TextDecoder('iso-8859-1')
      break
    case 1: // UTF-16 with BOM
      decoder = new TextDecoder('utf-16')
      break
    case 2: // UTF-16BE without BOM
      decoder = new TextDecoder('utf-16be')
      break
    case 3: // UTF-8
      decoder = new TextDecoder('utf-8')
      break
    default:
      decoder = new TextDecoder('utf-8')
  }

  const text = decoder.decode(textData)
  // 終端null文字を除去
  return text.replaceAll('\0', '').trim()
}

/**
 * FLAC/Vorbisメタデータ抽出
 */
async function extractFLACMetadata(
  filePath: string,
  fileData: ArrayBuffer,
): Promise<MetadataParseResult> {
  try {
    const audioProps = parseFlacAudioProperties(fileData)
    const decoder = new TextDecoder('utf-8')

    // fLaCマーカー確認
    const marker = decoder.decode(fileData.slice(0, 4))
    if (marker !== 'fLaC') {
      return {
        success: false,
        error: 'Invalid FLAC file: missing fLaC marker',
      }
    }

    let offset = 4
    const metadata: Record<string, string> = {}

    // メタデータブロックを解析
    while (offset < fileData.byteLength) {
      const blockHeader = new DataView(fileData.slice(offset, offset + 4))
      const blockType = blockHeader.getUint8(0) & 0x7f
      const isLast = (blockHeader.getUint8(0) & 0x80) !== 0
      const blockSize =
        (blockHeader.getUint8(1) << 16) |
        (blockHeader.getUint8(2) << 8) |
        blockHeader.getUint8(3)

      offset += 4

      if (blockType === 4) {
        // VORBIS_COMMENTブロック
        const vorbisData = fileData.slice(offset, offset + blockSize)
        parseVorbisComment(vorbisData, metadata)
        break // 必要なメタデータ取得済み
      }

      if (isLast) break
      offset += blockSize
    }

    return {
      success: true,
      track: {
        ...createBasicTrack(filePath, fileData.byteLength, 'flac'),
        duration: audioProps.duration,
        title: metadata.TITLE || getFilenameWithoutExt(filePath),
        artist: metadata.ARTIST || 'Unknown Artist',
        album: metadata.ALBUM || 'Unknown Album',
        albumArtist: metadata.ALBUMARTIST,
        trackNumber: metadata.TRACKNUMBER
          ? parseInt(metadata.TRACKNUMBER, 10)
          : undefined,
        discNumber: metadata.DISCNUMBER
          ? parseInt(metadata.DISCNUMBER, 10)
          : undefined,
        year: metadata.DATE
          ? parseInt(metadata.DATE.substring(0, 4), 10)
          : undefined,
        genre: metadata.GENRE,
        bitrate: audioProps.bitrate,
        sampleRate: audioProps.sampleRate,
        channels: audioProps.channels,
      },
    }
  } catch (error) {
    return {
      success: false,
      error: `FLAC parse error: ${error instanceof Error ? error.message : 'Unknown'}`,
    }
  }
}

/**
 * Vorbis Comment解析
 */
function parseVorbisComment(
  data: ArrayBuffer,
  metadata: Record<string, string>,
): void {
  const dataView = new DataView(data)
  const decoder = new TextDecoder('utf-8')
  let offset = 0

  // vendor string length
  const vendorLength = dataView.getUint32(offset, true)
  offset += 4

  // vendor string (skip)
  offset += vendorLength

  // user comment list length
  const commentCount = dataView.getUint32(offset, true)
  offset += 4

  // comments
  for (let i = 0; i < commentCount && offset < data.byteLength; i++) {
    const commentLength = dataView.getUint32(offset, true)
    offset += 4

    const commentData = data.slice(offset, offset + commentLength)
    const comment = decoder.decode(commentData)
    offset += commentLength

    // "FIELD=value"形式を解析
    const eqIndex = comment.indexOf('=')
    if (eqIndex > 0) {
      const field = comment.substring(0, eqIndex).toUpperCase()
      const value = comment.substring(eqIndex + 1)
      metadata[field] = value
    }
  }
}

/**
 * MP4（AAC/ALAC）メタデータ抽出
 */
async function extractMP4Metadata(
  filePath: string,
  fileData: ArrayBuffer,
): Promise<MetadataParseResult> {
  try {
    const audioProps = parseMp4AudioProperties(fileData)
    // ftypボックス確認
    const decoder = new TextDecoder('ascii')
    const ftypType = decoder.decode(fileData.slice(4, 8))

    if (ftypType !== 'ftyp') {
      return {
        success: false,
        error: 'Invalid MP4 file: missing ftyp box',
      }
    }

    // moovボックスを探す
    let offset = 0
    let moovData: ArrayBuffer | null = null

    while (offset < fileData.byteLength - 8) {
      const size = new DataView(fileData.slice(offset, offset + 4)).getUint32(
        0,
        false,
      )
      const type = decoder.decode(fileData.slice(offset + 4, offset + 8))

      if (type === 'moov') {
        moovData = fileData.slice(offset + 8, offset + size)
        break
      }

      offset += size
    }

    if (!moovData) {
      return {
        success: false,
        error: 'MP4 moov box not found',
      }
    }

    // udta/meta/ilstからiTunesメタデータを抽出
    const metadata = parseITunesMetadata(moovData)

    // コーデック判定（ALAC vs AAC）
    const format = detectMP4Codec(fileData)

    return {
      success: true,
      track: {
        ...createBasicTrack(filePath, fileData.byteLength, format),
        duration: audioProps.duration,
        title:
          getMetadataString(metadata, '©nam') ||
          getFilenameWithoutExt(filePath),
        artist: getMetadataString(metadata, '©ART') || 'Unknown Artist',
        album: getMetadataString(metadata, '©alb') || 'Unknown Album',
        albumArtist: getMetadataString(metadata, 'aART'),
        trackNumber: getMetadataTuple(metadata, 'trkn')?.[0],
        discNumber: getMetadataTuple(metadata, 'disk')?.[0],
        year: getMetadataString(metadata, '©day')
          ? parseInt(getMetadataString(metadata, '©day') ?? '', 10)
          : undefined,
        genre: getMetadataString(metadata, '©gen'),
        bitrate: audioProps.bitrate,
      },
    }
  } catch (error) {
    return {
      success: false,
      error: `MP4 parse error: ${error instanceof Error ? error.message : 'Unknown'}`,
    }
  }
}

/**
 * iTunesメタデータ（ilst）解析
 */
function parseITunesMetadata(moovData: ArrayBuffer): ITunesMetadata {
  const metadata: ITunesMetadata = {}
  const decoder = new TextDecoder('ascii')
  let offset = 0

  while (offset < moovData.byteLength - 8) {
    const size = new DataView(moovData.slice(offset, offset + 4)).getUint32(
      0,
      false,
    )
    const type = decoder.decode(moovData.slice(offset + 4, offset + 8))

    if (type === 'udta') {
      // udta内を探索
      const udtaData = moovData.slice(offset + 8, offset + size)
      return parseMetadataBox(udtaData)
    }

    offset += size
  }

  return metadata
}

/**
 * メタデータボックス解析
 */
function parseMetadataBox(data: ArrayBuffer): ITunesMetadata {
  const metadata: ITunesMetadata = {}
  const decoder = new TextDecoder('ascii')
  let offset = 0

  while (offset < data.byteLength - 8) {
    const size = new DataView(data.slice(offset, offset + 4)).getUint32(
      0,
      false,
    )
    const type = decoder.decode(data.slice(offset + 4, offset + 8))

    if (type === 'meta') {
      // meta box（version/flagsスキップ）
      const metaData = data.slice(offset + 12, offset + size)
      return parseMetadataBox(metaData)
    } else if (type === 'ilst') {
      // iTunes item list
      const ilstData = data.slice(offset + 8, offset + size)
      return parseITunesItemList(ilstData)
    }

    offset += size
  }

  return metadata
}

/**
 * iTunesアイテムリスト解析
 */
function parseITunesItemList(data: ArrayBuffer): ITunesMetadata {
  const metadata: ITunesMetadata = {}
  const decoder = new TextDecoder('ascii')
  const textDecoder = new TextDecoder('utf-8')
  let offset = 0

  while (offset < data.byteLength - 8) {
    const size = new DataView(data.slice(offset, offset + 4)).getUint32(
      0,
      false,
    )
    const itemType = decoder.decode(data.slice(offset + 4, offset + 8))

    // データ取得（data box内）
    const itemData = data.slice(offset + 8, offset + size)
    let value: MetadataValue | null = null

    // data boxを探す
    let dataOffset = 0
    while (dataOffset < itemData.byteLength - 8) {
      const dataSize = new DataView(
        itemData.slice(dataOffset, dataOffset + 4),
      ).getUint32(0, false)
      const dataType = decoder.decode(
        itemData.slice(dataOffset + 4, dataOffset + 8),
      )

      if (dataType === 'data') {
        // data box: version(1) + flags(3) + null(4) + value
        const valueData = itemData.slice(dataOffset + 16, dataOffset + dataSize)

        // trknやdiskはバイナリ構造
        if (itemType === 'trkn' || itemType === 'disk') {
          const view = new DataView(valueData)
          const current = view.getUint16(2, false)
          const total = view.getUint16(4, false)
          value = [current, total]
        } else {
          value = textDecoder.decode(valueData)
        }
        break
      }

      dataOffset += dataSize
    }

    if (value !== null) {
      metadata[itemType] = value
    }

    offset += size
  }

  return metadata
}

/**
 * MP4コーデック判定
 */
function detectMP4Codec(fileData: ArrayBuffer): 'aac' | 'alac' {
  // stsdボックス内のコーデックタイプを確認
  // 簡易判定: ファイル拡張子で判定（実際にはmoov/trak/mdia/minf/stbl/stsdを解析する必要あり）
  // ここでは'alac'を含むかどうかで判定（簡易）
  const decoder = new TextDecoder('ascii')
  const searchLength = Math.min(fileData.byteLength, 100000) // 先頭100KBのみ
  const text = decoder.decode(fileData.slice(0, searchLength))

  return text.includes('alac') ? 'alac' : 'aac'
}

/**
 * 基本トラック情報作成
 */
function createBasicTrack(
  filePath: string,
  fileSize: number,
  format: 'mp3' | 'flac' | 'aac' | 'alac' | 'other',
): Partial<LocalTrack> {
  const now = Date.now()

  return {
    source: 'local',
    sourceId: generateFileHash(filePath),
    filePath,
    fileSize,
    format,
    codec:
      format === 'mp3'
        ? 'MP3'
        : format === 'flac'
          ? 'FLAC'
          : format === 'aac'
            ? 'AAC'
            : format === 'alac'
              ? 'ALAC'
              : 'Unknown',
    modifiedAt: now, // 実際にはファイルシステムから取得
    createdAt: now,
  }
}

/**
 * ファイルパスからハッシュ生成
 */
function generateFileHash(filePath: string): string {
  // 簡易ハッシュ（実際にはより堅牢なハッシュ関数を使用）
  let hash = 0
  for (let i = 0; i < filePath.length; i++) {
    const char = filePath.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash // 32bit整数に収める
  }
  return `local-${Math.abs(hash).toString(16).padStart(8, '0')}`
}

/**
 * ファイル名（拡張子なし）を取得
 */
function getFilenameWithoutExt(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  const filename = parts[parts.length - 1]
  const lastDot = filename.lastIndexOf('.')
  return lastDot === -1 ? filename : filename.substring(0, lastDot)
}

// Workerメッセージハンドラ
self.onmessage = async (event: MessageEvent<ExtractMessage>) => {
  const { type, filePath, fileData, format } = event.data

  if (type === 'extract') {
    const result = await extractMetadata(filePath, fileData, format)

    if (result.success) {
      self.postMessage({
        type: 'result',
        filePath,
        result,
      } as ExtractResultMessage)
    } else {
      self.postMessage({
        type: 'error',
        filePath,
        error: result.error || 'Unknown error',
      } as ExtractErrorMessage)
    }
  }
}

export {}
