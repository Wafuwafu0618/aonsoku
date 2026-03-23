import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { getM3u8Url, decryptSamples } from './wrapper-client'
import { resolveSegments, fetchSegment } from './hls-manager'

const LOG_TAG = '[AppleMusicPipeline]'
const FFMPEG_TIMEOUT_MS = 180_000
const DEFERRED_CLEANUP_DELAY_MS = 5 * 60 * 1000

export interface AppleMusicResolveResult {
  ok: boolean
  tempFilePath?: string
  durationSeconds?: number
  error?: { code: string; message: string }
}

// Track previous temp files to clean up
let previousTempFile: string | null = null

function cleanupPreviousTempFile(): void {
  if (!previousTempFile) return

  const filePath = previousTempFile
  previousTempFile = null

  fs.unlink(filePath, (error) => {
    if (error && error.code !== 'ENOENT') {
      console.warn(LOG_TAG, `Failed to clean up temp file ${filePath}:`, error.message)
    } else {
      console.log(LOG_TAG, `Cleaned up temp file: ${filePath}`)
    }
  })
}

function cleanupTempFileLater(filePath: string): void {
  setTimeout(() => {
    fs.unlink(filePath, (error) => {
      if (error && error.code !== 'ENOENT') {
        console.warn(LOG_TAG, `Deferred cleanup failed for ${filePath}:`, error.message)
      } else {
        console.log(LOG_TAG, `Deferred cleanup done: ${filePath}`)
      }
    })
  }, DEFERRED_CLEANUP_DELAY_MS)
}

function ffmpegBinary(): string {
  const envPath = process.env.AONSOKU_FFMPEG_PATH?.trim()
  if (envPath) return envPath

  const binaryName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const resourceCandidates = [
    path.join(process.resourcesPath, 'resources', 'bin', binaryName),
    path.join(process.resourcesPath, 'bin', binaryName),
    path.join(process.cwd(), 'resources', 'bin', binaryName),
  ]

  for (const candidate of resourceCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  return binaryName
}

interface Mp4BoxRef {
  type: string
  start: number
  end: number
  headerSize: number
}

function parseNextMp4Box(
  buffer: Buffer,
  offset: number,
  endOffset: number,
): Mp4BoxRef | null {
  if (offset + 8 > endOffset || offset + 8 > buffer.length) return null

  const size32 = buffer.readUInt32BE(offset)
  const type = buffer.toString('ascii', offset + 4, offset + 8)
  let headerSize = 8
  let boxSize = size32

  if (size32 === 1) {
    if (offset + 16 > endOffset || offset + 16 > buffer.length) return null
    const size64 = buffer.readBigUInt64BE(offset + 8)
    if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) return null
    boxSize = Number(size64)
    headerSize = 16
  } else if (size32 === 0) {
    boxSize = endOffset - offset
  }

  if (boxSize < headerSize) return null
  const boxEnd = offset + boxSize
  if (boxEnd > endOffset || boxEnd > buffer.length) return null

  return {
    type,
    start: offset,
    end: boxEnd,
    headerSize,
  }
}

function findChildBox(
  buffer: Buffer,
  parentStart: number,
  parentEnd: number,
  type: string,
): Mp4BoxRef | null {
  let cursor = parentStart
  while (cursor + 8 <= parentEnd) {
    const box = parseNextMp4Box(buffer, cursor, parentEnd)
    if (!box) break
    if (box.type === type) return box
    cursor = box.end
  }
  return null
}

function writeMp4BoxSize(buffer: Buffer, box: Mp4BoxRef, newSize: number): void {
  if (box.headerSize >= 16) {
    buffer.writeBigUInt64BE(BigInt(newSize), box.start + 8)
    return
  }
  buffer.writeUInt32BE(newSize, box.start)
}

function readHandlerType(buffer: Buffer, hdlr: Mp4BoxRef): string | undefined {
  const payloadStart = hdlr.start + hdlr.headerSize
  const handlerOffset = payloadStart + 8
  if (handlerOffset + 4 > hdlr.end || handlerOffset + 4 > buffer.length) {
    return undefined
  }
  return buffer.toString('ascii', handlerOffset, handlerOffset + 4)
}

function audioSampleEntryChildStart(entry: Mp4BoxRef): number {
  return entry.start + entry.headerSize + 28
}

function findSampleEntryChildBox(
  buffer: Buffer,
  sampleEntry: Mp4BoxRef,
  type: string,
): Mp4BoxRef | null {
  const childStart = audioSampleEntryChildStart(sampleEntry)
  if (childStart >= sampleEntry.end) return null
  return findChildBox(buffer, childStart, sampleEntry.end, type)
}

function readFrmaTypeFromSinf(
  buffer: Buffer,
  sampleEntry: Mp4BoxRef,
): string | undefined {
  const sinf = findSampleEntryChildBox(buffer, sampleEntry, 'sinf')
  if (!sinf) return undefined
  const frma = findChildBox(buffer, sinf.start + sinf.headerSize, sinf.end, 'frma')
  if (!frma) return undefined
  const payloadStart = frma.start + frma.headerSize
  if (payloadStart + 4 > frma.end || payloadStart + 4 > buffer.length) return undefined
  return buffer.toString('ascii', payloadStart, payloadStart + 4)
}

interface StsdEntryPick {
  entry: Mp4BoxRef
  frmaType?: string
  score: number
}

function scoreStsdEntry(buffer: Buffer, entry: Mp4BoxRef): StsdEntryPick {
  let score = 0
  const type = entry.type
  const frmaType = readFrmaTypeFromSinf(buffer, entry)
  const hasAlac = Boolean(findSampleEntryChildBox(buffer, entry, 'alac'))
  const hasEsds = Boolean(findSampleEntryChildBox(buffer, entry, 'esds'))

  if (type === 'alac' || type === 'mp4a' || type === 'ec-3') score += 60
  if (type === 'enca' && frmaType) score += 45
  if (hasAlac) score += 40
  if (hasEsds) score += 20

  // Prefer larger entries when quality score is same (more codec metadata).
  score += Math.min(entry.end - entry.start, 512) / 64

  return { entry, frmaType, score }
}

function sanitizeInitSegmentStsd(initBuffer: Buffer): Buffer {
  const moov = findChildBox(initBuffer, 0, initBuffer.length, 'moov')
  if (!moov) return initBuffer

  let trak: Mp4BoxRef | null = null
  let trakCursor = moov.start + moov.headerSize
  while (trakCursor + 8 <= moov.end) {
    const candidate = parseNextMp4Box(initBuffer, trakCursor, moov.end)
    if (!candidate) break
    trakCursor = candidate.end
    if (candidate.type !== 'trak') continue

    const mdiaCandidate = findChildBox(
      initBuffer,
      candidate.start + candidate.headerSize,
      candidate.end,
      'mdia',
    )
    if (!mdiaCandidate) continue

    const hdlr = findChildBox(
      initBuffer,
      mdiaCandidate.start + mdiaCandidate.headerSize,
      mdiaCandidate.end,
      'hdlr',
    )
    if (!hdlr) continue
    if (readHandlerType(initBuffer, hdlr) !== 'soun') continue

    trak = candidate
    break
  }
  if (!trak) return initBuffer

  const mdia = findChildBox(
    initBuffer,
    trak.start + trak.headerSize,
    trak.end,
    'mdia',
  )
  if (!mdia) return initBuffer

  const minf = findChildBox(
    initBuffer,
    mdia.start + mdia.headerSize,
    mdia.end,
    'minf',
  )
  if (!minf) return initBuffer

  const stbl = findChildBox(
    initBuffer,
    minf.start + minf.headerSize,
    minf.end,
    'stbl',
  )
  if (!stbl) return initBuffer

  const stsd = findChildBox(
    initBuffer,
    stbl.start + stbl.headerSize,
    stbl.end,
    'stsd',
  )
  if (!stsd) return initBuffer

  const fullBoxStart = stsd.start + stsd.headerSize
  const sampleCountOffset = fullBoxStart + 4
  const firstEntryOffset = fullBoxStart + 8
  if (firstEntryOffset + 8 > stsd.end || sampleCountOffset + 4 > stsd.end) {
    return initBuffer
  }

  const sampleCount = initBuffer.readUInt32BE(sampleCountOffset)
  if (sampleCount <= 1) return initBuffer

  const entries: Mp4BoxRef[] = []
  let entryCursor = firstEntryOffset
  while (entryCursor + 8 <= stsd.end && entries.length < sampleCount) {
    const entry = parseNextMp4Box(initBuffer, entryCursor, stsd.end)
    if (!entry) break
    entries.push(entry)
    entryCursor = entry.end
  }
  if (entries.length === 0) return initBuffer

  const picked = entries
    .map((entry) => scoreStsdEntry(initBuffer, entry))
    .sort((a, b) => b.score - a.score)[0]
  if (!picked) return initBuffer

  const selectedBytes = Buffer.from(
    initBuffer.subarray(picked.entry.start, picked.entry.end),
  )
  const selectedType = selectedBytes.toString('ascii', 4, 8)
  if (selectedType === 'enca' && picked.frmaType && picked.frmaType.length === 4) {
    selectedBytes.write(picked.frmaType, 4, 4, 'ascii')
  }

  const fullBoxPrefix = Buffer.from(initBuffer.subarray(fullBoxStart, firstEntryOffset))
  if (fullBoxPrefix.length < 8) return initBuffer
  fullBoxPrefix.writeUInt32BE(1, 4)

  const stsdHeader = Buffer.from(
    initBuffer.subarray(stsd.start, stsd.start + stsd.headerSize),
  )
  const rebuiltStsd = Buffer.concat([stsdHeader, fullBoxPrefix, selectedBytes])
  rebuiltStsd.writeUInt32BE(rebuiltStsd.length, 0)

  const patched = Buffer.concat([
    initBuffer.subarray(0, stsd.start),
    rebuiltStsd,
    initBuffer.subarray(stsd.end),
  ])

  const removedBytes = stsd.end - stsd.start - rebuiltStsd.length
  if (removedBytes < 0) return initBuffer

  writeMp4BoxSize(patched, stbl, stbl.end - stbl.start - removedBytes)
  writeMp4BoxSize(patched, minf, minf.end - minf.start - removedBytes)
  writeMp4BoxSize(patched, mdia, mdia.end - mdia.start - removedBytes)
  writeMp4BoxSize(patched, trak, trak.end - trak.start - removedBytes)
  writeMp4BoxSize(patched, moov, moov.end - moov.start - removedBytes)

  console.log(
    LOG_TAG,
    `Sanitized init stsd sampleCount: ${sampleCount} -> 1 (selected=${selectedType}${picked.frmaType ? `->${picked.frmaType}` : ''}, removed ${removedBytes} bytes)`,
  )
  return patched
}

interface BufferRange {
  start: number
  end: number
}

interface TencInfo {
  ivSize: number
  cryptBlockCount: number
  skipBlockCount: number
}

function readUInt24BE(buffer: Buffer, offset: number): number {
  return (
    (buffer.readUInt8(offset) << 16) |
    (buffer.readUInt8(offset + 1) << 8) |
    buffer.readUInt8(offset + 2)
  )
}

function readAudioTrackTencInfo(initBuffer: Buffer): TencInfo {
  const defaultInfo: TencInfo = {
    ivSize: 16,
    cryptBlockCount: 0,
    skipBlockCount: 0,
  }

  const moov = findChildBox(initBuffer, 0, initBuffer.length, 'moov')
  if (!moov) return defaultInfo

  let trakCursor = moov.start + moov.headerSize
  while (trakCursor + 8 <= moov.end) {
    const trak = parseNextMp4Box(initBuffer, trakCursor, moov.end)
    if (!trak) break
    trakCursor = trak.end
    if (trak.type !== 'trak') continue

    const mdia = findChildBox(
      initBuffer,
      trak.start + trak.headerSize,
      trak.end,
      'mdia',
    )
    if (!mdia) continue

    const hdlr = findChildBox(
      initBuffer,
      mdia.start + mdia.headerSize,
      mdia.end,
      'hdlr',
    )
    if (!hdlr || readHandlerType(initBuffer, hdlr) !== 'soun') continue

    const minf = findChildBox(
      initBuffer,
      mdia.start + mdia.headerSize,
      mdia.end,
      'minf',
    )
    if (!minf) continue
    const stbl = findChildBox(
      initBuffer,
      minf.start + minf.headerSize,
      minf.end,
      'stbl',
    )
    if (!stbl) continue
    const stsd = findChildBox(
      initBuffer,
      stbl.start + stbl.headerSize,
      stbl.end,
      'stsd',
    )
    if (!stsd) continue

    const stsdPayload = stsd.start + stsd.headerSize
    const firstEntryOffset = stsdPayload + 8
    if (firstEntryOffset + 8 > stsd.end) continue
    let entryCursor = firstEntryOffset
    while (entryCursor + 8 <= stsd.end) {
      const sampleEntry = parseNextMp4Box(initBuffer, entryCursor, stsd.end)
      if (!sampleEntry) break
      entryCursor = sampleEntry.end

      const sinf = findSampleEntryChildBox(initBuffer, sampleEntry, 'sinf')
      if (!sinf) continue
      const schi = findChildBox(
        initBuffer,
        sinf.start + sinf.headerSize,
        sinf.end,
        'schi',
      )
      if (!schi) continue
      const tenc = findChildBox(
        initBuffer,
        schi.start + schi.headerSize,
        schi.end,
        'tenc',
      )
      if (!tenc) continue

      const payloadStart = tenc.start + tenc.headerSize
      if (payloadStart + 4 > tenc.end) continue

      const version = initBuffer.readUInt8(payloadStart)
      let cursor = payloadStart + 4
      let cryptBlockCount = 0
      let skipBlockCount = 0

      if (version === 1) {
        if (cursor + 1 > tenc.end) continue
        const pattern = initBuffer.readUInt8(cursor)
        cryptBlockCount = (pattern >> 4) & 0x0f
        skipBlockCount = pattern & 0x0f
        cursor += 1
      }

      if (cursor + 2 > tenc.end) continue
      cursor += 1 // default_isProtected
      const ivSize = initBuffer.readUInt8(cursor)

      return {
        ivSize: ivSize > 0 ? ivSize : defaultInfo.ivSize,
        cryptBlockCount,
        skipBlockCount,
      }
    }
  }

  return defaultInfo
}

interface TfhdInfo {
  baseDataOffset: number
  defaultSampleSize: number
}

function parseTfhdInfo(
  buffer: Buffer,
  tfhd: Mp4BoxRef,
  moofStart: number,
): TfhdInfo | null {
  const payloadStart = tfhd.start + tfhd.headerSize
  if (payloadStart + 8 > tfhd.end) return null

  const flags = readUInt24BE(buffer, payloadStart + 1)
  let cursor = payloadStart + 4
  if (cursor + 4 > tfhd.end) return null
  cursor += 4 // track_ID

  let baseDataOffset = moofStart
  if ((flags & 0x000001) !== 0) {
    if (cursor + 8 > tfhd.end) return null
    const base64 = buffer.readBigUInt64BE(cursor)
    if (base64 > BigInt(Number.MAX_SAFE_INTEGER)) return null
    baseDataOffset = Number(base64)
    cursor += 8
  }

  if ((flags & 0x000002) !== 0) {
    if (cursor + 4 > tfhd.end) return null
    cursor += 4
  }
  if ((flags & 0x000008) !== 0) {
    if (cursor + 4 > tfhd.end) return null
    cursor += 4
  }

  let defaultSampleSize = 0
  if ((flags & 0x000010) !== 0) {
    if (cursor + 4 > tfhd.end) return null
    defaultSampleSize = buffer.readUInt32BE(cursor)
    cursor += 4
  }

  if ((flags & 0x000020) !== 0) {
    if (cursor + 4 > tfhd.end) return null
    cursor += 4
  }

  return {
    baseDataOffset,
    defaultSampleSize,
  }
}

interface TrunInfo {
  dataOffset?: number
  sampleSizes: number[]
}

interface SubsamplePattern {
  clearBytes: number
  protectedBytes: number
}

function parseSencPatterns(
  buffer: Buffer,
  traf: Mp4BoxRef,
  sampleCountHint: number,
  ivSize: number,
): SubsamplePattern[][] | null {
  const senc = findChildBox(
    buffer,
    traf.start + traf.headerSize,
    traf.end,
    'senc',
  )
  if (!senc) return null

  const payloadStart = senc.start + senc.headerSize
  if (payloadStart + 8 > senc.end) return null

  const flags = readUInt24BE(buffer, payloadStart + 1)
  const hasSubsamples = (flags & 0x000002) !== 0
  let cursor = payloadStart + 4
  const sampleCount = buffer.readUInt32BE(cursor)
  cursor += 4

  const patterns: SubsamplePattern[][] = []
  const targetCount = Math.min(sampleCount, sampleCountHint)
  for (let i = 0; i < targetCount; i += 1) {
    if (cursor + ivSize > senc.end) return null
    cursor += ivSize

    if (!hasSubsamples) {
      patterns.push([])
      continue
    }

    if (cursor + 2 > senc.end) return null
    const subsampleCount = buffer.readUInt16BE(cursor)
    cursor += 2

    const subs: SubsamplePattern[] = []
    for (let j = 0; j < subsampleCount; j += 1) {
      if (cursor + 6 > senc.end) return null
      const clearBytes = buffer.readUInt16BE(cursor)
      const protectedBytes = buffer.readUInt32BE(cursor + 2)
      cursor += 6
      subs.push({ clearBytes, protectedBytes })
    }
    patterns.push(subs)
  }

  return patterns
}

function parseTrunInfo(
  buffer: Buffer,
  trun: Mp4BoxRef,
  defaultSampleSize: number,
): TrunInfo | null {
  const payloadStart = trun.start + trun.headerSize
  if (payloadStart + 8 > trun.end) return null

  const version = buffer.readUInt8(payloadStart)
  const flags = readUInt24BE(buffer, payloadStart + 1)
  let cursor = payloadStart + 4

  if (cursor + 4 > trun.end) return null
  const sampleCount = buffer.readUInt32BE(cursor)
  cursor += 4

  let dataOffset: number | undefined
  if ((flags & 0x000001) !== 0) {
    if (cursor + 4 > trun.end) return null
    dataOffset = buffer.readInt32BE(cursor)
    cursor += 4
  }

  if ((flags & 0x000004) !== 0) {
    if (cursor + 4 > trun.end) return null
    cursor += 4
  }

  const sampleSizes: number[] = []
  for (let i = 0; i < sampleCount; i += 1) {
    if ((flags & 0x000100) !== 0) {
      if (cursor + 4 > trun.end) return null
      cursor += 4
    }

    let sampleSize = defaultSampleSize
    if ((flags & 0x000200) !== 0) {
      if (cursor + 4 > trun.end) return null
      sampleSize = buffer.readUInt32BE(cursor)
      cursor += 4
    }

    if ((flags & 0x000400) !== 0) {
      if (cursor + 4 > trun.end) return null
      cursor += 4
    }
    if ((flags & 0x000800) !== 0) {
      if (cursor + 4 > trun.end) return null
      cursor += 4
    }

    if (!Number.isFinite(sampleSize) || sampleSize < 0) {
      return null
    }
    sampleSizes.push(sampleSize)
  }

  // Keep parser aligned with potentially extended sample table payload.
  if (version !== 0 && version !== 1) {
    return null
  }

  return { dataOffset, sampleSizes }
}

function buildPatternRanges(
  start: number,
  decryptableLength: number,
  cryptBlockCount: number,
  skipBlockCount: number,
): BufferRange[] {
  const ranges: BufferRange[] = []
  const cryptBytes = cryptBlockCount * 16
  const skipBytes = skipBlockCount * 16

  if (cryptBytes <= 0 || skipBytes < 0) {
    const decryptLen = decryptableLength & ~0xf
    if (decryptLen > 0) {
      ranges.push({ start, end: start + decryptLen })
    }
    return ranges
  }

  let cursor = start
  let remaining = decryptableLength
  while (remaining >= cryptBytes) {
    ranges.push({ start: cursor, end: cursor + cryptBytes })
    cursor += cryptBytes
    remaining -= cryptBytes
    if (remaining <= 0) break
    const skip = Math.min(skipBytes, remaining)
    cursor += skip
    remaining -= skip
  }

  return ranges
}

function findSampleDecryptRanges(
  segment: Buffer,
  tencInfo: TencInfo,
): BufferRange[] | null {
  const moof = findChildBox(segment, 0, segment.length, 'moof')
  const mdat = findChildBox(segment, 0, segment.length, 'mdat')
  if (!moof || !mdat) return null

  const payloadStart = mdat.start + mdat.headerSize
  const payloadEnd = mdat.end
  if (payloadStart >= payloadEnd) return null

  const ranges: BufferRange[] = []
  let trafCursor = moof.start + moof.headerSize

  while (trafCursor + 8 <= moof.end) {
    const traf = parseNextMp4Box(segment, trafCursor, moof.end)
    if (!traf) break
    trafCursor = traf.end
    if (traf.type !== 'traf') continue

    const tfhd = findChildBox(
      segment,
      traf.start + traf.headerSize,
      traf.end,
      'tfhd',
    )
    if (!tfhd) continue

    const tfhdInfo = parseTfhdInfo(segment, tfhd, moof.start)
    if (!tfhdInfo) continue

    let trunCursor = traf.start + traf.headerSize
    let runningSampleCursor = payloadStart

    while (trunCursor + 8 <= traf.end) {
      const child = parseNextMp4Box(segment, trunCursor, traf.end)
      if (!child) break
      trunCursor = child.end
      if (child.type !== 'trun') continue

      const trun = parseTrunInfo(segment, child, tfhdInfo.defaultSampleSize)
      if (!trun) continue
      const sencPatterns = parseSencPatterns(
        segment,
        traf,
        trun.sampleSizes.length,
        tencInfo.ivSize,
      )

      let sampleCursor =
        typeof trun.dataOffset === 'number'
          ? tfhdInfo.baseDataOffset + trun.dataOffset
          : runningSampleCursor

      for (let sampleIndex = 0; sampleIndex < trun.sampleSizes.length; sampleIndex += 1) {
        const sampleSize = trun.sampleSizes[sampleIndex]
        const subPatterns = sencPatterns?.[sampleIndex] ?? []

        if (subPatterns.length > 0) {
          let offsetInSample = 0
          for (const sub of subPatterns) {
            offsetInSample += sub.clearBytes
            if (sub.protectedBytes > 0) {
              const subStart = sampleCursor + offsetInSample
              const subRanges = buildPatternRanges(
                subStart,
                sub.protectedBytes,
                tencInfo.cryptBlockCount,
                tencInfo.skipBlockCount,
              )
              for (const range of subRanges) {
                if (
                  range.start >= payloadStart &&
                  range.end <= payloadEnd &&
                  range.start < range.end
                ) {
                  ranges.push(range)
                }
              }
            }
            offsetInSample += sub.protectedBytes
          }
        } else {
          const sampleRanges = buildPatternRanges(
            sampleCursor,
            sampleSize,
            tencInfo.cryptBlockCount,
            tencInfo.skipBlockCount,
          )
          for (const range of sampleRanges) {
            if (
              range.start >= payloadStart &&
              range.end <= payloadEnd &&
              range.start < range.end
            ) {
              ranges.push(range)
            }
          }
        }
        sampleCursor += sampleSize
      }

      runningSampleCursor = sampleCursor
    }
  }

  return ranges.length > 0 ? ranges : null
}

function findMdatPayloadRanges(segment: Buffer): BufferRange[] {
  const ranges: BufferRange[] = []
  let offset = 0

  while (offset + 8 <= segment.length) {
    const box = parseNextMp4Box(segment, offset, segment.length)
    if (!box) break

    if (box.type === 'mdat' && box.end > box.start + box.headerSize) {
      ranges.push({
        start: box.start + box.headerSize,
        end: box.end,
      })
    }

    offset = box.end
  }

  return ranges
}

async function decryptSegmentMdatPayloads(
  adamId: string,
  keyUri: string,
  segment: Buffer,
  tencInfo: TencInfo,
): Promise<Buffer> {
  const sampleRanges = findSampleDecryptRanges(segment, tencInfo)
  const ranges = sampleRanges ?? findMdatPayloadRanges(segment)
  if (sampleRanges) {
    console.log(LOG_TAG, `Decrypt mode=sample-ranges count=${sampleRanges.length}`)
  }
  if (ranges.length === 0) return segment

  const decryptableRanges: Array<{ range: BufferRange; decryptLen: number }> = []
  const encryptedChunks: Buffer[] = []

  for (const range of ranges) {
    const payloadLength = range.end - range.start
    const decryptLen = payloadLength & ~0xf
    if (decryptLen <= 0) continue

    decryptableRanges.push({ range, decryptLen })
    encryptedChunks.push(
      Buffer.from(segment.subarray(range.start, range.start + decryptLen)),
    )
  }

  if (encryptedChunks.length === 0) return segment

  const decryptedChunks = await decryptSamples(adamId, keyUri, encryptedChunks)
  if (decryptedChunks.length !== encryptedChunks.length) {
    throw new Error(
      `${LOG_TAG} Decrypt payload count mismatch: got ${decryptedChunks.length}, expected ${encryptedChunks.length}`,
    )
  }

  const merged = Buffer.from(segment)
  for (let i = 0; i < decryptableRanges.length; i += 1) {
    const { range, decryptLen } = decryptableRanges[i]
    const decrypted = decryptedChunks[i]
    if (decrypted.length !== decryptLen) {
      throw new Error(
        `${LOG_TAG} Decrypt payload size mismatch: got ${decrypted.length}, expected ${decryptLen}`,
      )
    }
    decrypted.copy(merged, range.start)
  }

  return merged
}

async function transcodeToFlacIfPossible(inputFilePath: string): Promise<string> {
  const flacPath = inputFilePath.replace(/\.[^.]+$/u, '.flac')
  const ffmpeg = ffmpegBinary()
  console.log(LOG_TAG, `FLAC conversion using ffmpeg: ${ffmpeg}`)

  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    inputFilePath,
    '-vn',
    '-map',
    '0:a:0',
    '-c:a',
    'flac',
    flacPath,
  ]

  try {
    const { stderr } = await new Promise<{ stderr: string }>((resolve, reject) => {
      execFile(
        ffmpeg,
        args,
        {
          windowsHide: true,
          timeout: FFMPEG_TIMEOUT_MS,
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, _stdout, stderrOutput) => {
          if (error) {
            const reason =
              stderrOutput && stderrOutput.trim().length > 0
                ? stderrOutput.trim()
                : error.message
            reject(new Error(reason))
            return
          }
          resolve({ stderr: stderrOutput ?? '' })
        },
      )
    })

    if (!fs.existsSync(flacPath)) {
      throw new Error('ffmpeg finished but FLAC output was not created')
    }

    await fs.promises.unlink(inputFilePath).catch(() => undefined)
    console.log(
      LOG_TAG,
      `Converted assembled audio to FLAC: ${path.basename(flacPath)}`,
      stderr ? `(ffmpeg: ${stderr.slice(0, 120)}...)` : '',
    )
    return flacPath
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await fs.promises.unlink(flacPath).catch(() => undefined)
    console.warn(
      LOG_TAG,
      `FLAC conversion skipped (ffmpeg unavailable or failed): ${reason}`,
    )
    return inputFilePath
  }
}

/**
 * Resolve an Apple Music track by adamId:
 *   1. Get M3U8 URL from wrapper
 *   2. Parse HLS playlist → segments
 *   3. Download each segment
 *   4. Decrypt through wrapper
 *   5. Assemble into temp file
 *   6. Return temp file path for native audio sidecar
 */
export async function resolveAppleMusicTrack(
  adamId: string,
): Promise<AppleMusicResolveResult> {
  const resolveStart = Date.now()

  try {
    console.log(LOG_TAG, `Resolving adamId: ${adamId}`)

    // Step 1: Get M3U8 URL
    const m3u8Url = await getM3u8Url(adamId)

    // Step 2: Parse HLS playlist
    const resolved = await resolveSegments(m3u8Url)
    const segments = resolved.segments
    if (segments.length === 0) {
      return {
        ok: false,
        error: {
          code: 'apple-music-no-segments',
          message: `No segments found in HLS playlist for adamId ${adamId}`,
        },
      }
    }

    // Calculate total duration from segment metadata
    const totalDuration = segments.reduce((sum, seg) => sum + seg.duration, 0)
    console.log(LOG_TAG, `Total segments: ${segments.length}, duration: ${totalDuration.toFixed(1)}s`)

    // Step 3: Fetch init segment if present.
    const assembledChunks: Buffer[] = []
    let tencInfo: TencInfo = {
      ivSize: 16,
      cryptBlockCount: 0,
      skipBlockCount: 0,
    }
    if (resolved.initSegment) {
      const initBuffer = await fetchSegment(
        resolved.initSegment.url,
        resolved.initSegment.byteRange,
      )
      tencInfo = readAudioTrackTencInfo(initBuffer)
      const sanitizedInit = sanitizeInitSegmentStsd(initBuffer)
      assembledChunks.push(sanitizedInit)
      console.log(
        LOG_TAG,
        `Fetched init segment (${(sanitizedInit.length / 1024).toFixed(1)} KiB) tenc(iv=${tencInfo.ivSize},crypt=${tencInfo.cryptBlockCount},skip=${tencInfo.skipBlockCount})`,
      )
    }

    // Step 4 & 5: Download and decrypt media segments.
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i]
      const segmentStart = Date.now()

      const encryptedSegment = await fetchSegment(segment.url, segment.byteRange)
      const segmentKeyUri =
        segment.keyUri && Buffer.byteLength(segment.keyUri, 'utf-8') <= 255
          ? segment.keyUri
          : null
      const playlistKeyUri =
        resolved.keyUri && Buffer.byteLength(resolved.keyUri, 'utf-8') <= 255
          ? resolved.keyUri
          : null
      const decryptUri = segmentKeyUri ?? playlistKeyUri
      if (i === 0) {
        const source = segmentKeyUri
          ? 'segment-key'
          : playlistKeyUri
            ? 'playlist-key'
            : 'none'
        console.log(
          LOG_TAG,
          `Decrypt URI source=${source} len=${decryptUri ? Buffer.byteLength(decryptUri, 'utf-8') : 0}`,
        )
      }
      const decryptedSegment = decryptUri
        ? await decryptSegmentMdatPayloads(
            adamId,
            decryptUri,
            encryptedSegment,
            tencInfo,
          )
        : encryptedSegment

      assembledChunks.push(decryptedSegment)

      const segmentElapsed = Date.now() - segmentStart
      if ((i + 1) % 10 === 0 || i === segments.length - 1) {
        console.log(
          LOG_TAG,
          `Segment ${i + 1}/${segments.length} done (${segmentElapsed}ms)`,
        )
      }
    }

    // Step 6: Assemble into temp file

    const tempDir = os.tmpdir()
    const timestamp = Date.now()
    const tempFileName = `aonsoku-am-${adamId}-${timestamp}.m4a`
    const tempFilePath = path.join(tempDir, tempFileName)

    const assembled = Buffer.concat(assembledChunks)
    await fs.promises.writeFile(tempFilePath, assembled)
    const playableFilePath = await transcodeToFlacIfPossible(tempFilePath)

    if (previousTempFile && previousTempFile !== playableFilePath) {
      cleanupTempFileLater(previousTempFile)
    }
    previousTempFile = playableFilePath

    const totalElapsed = Date.now() - resolveStart
    console.log(
      LOG_TAG,
      `Resolved adamId ${adamId} -> ${playableFilePath} (${(assembled.length / 1024 / 1024).toFixed(1)} MB, ${totalElapsed}ms)`,
    )

    return {
      ok: true,
      tempFilePath: playableFilePath,
      durationSeconds: totalDuration,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(LOG_TAG, `Failed to resolve adamId ${adamId}:`, message)

    return {
      ok: false,
      error: {
        code: 'apple-music-resolve-failed',
        message,
      },
    }
  }
}

/**
 * Clean up all temp files created by the pipeline.
 * Called on app shutdown.
 */
export function cleanupAllTempFiles(): void {
  cleanupPreviousTempFile()
}
