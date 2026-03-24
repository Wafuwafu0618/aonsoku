import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { getM3u8Url, decryptSamples } from './wrapper-client'
import { resolveSegments, fetchSegment } from './hls-manager'

const LOG_TAG = '[AppleMusicPipeline]'
const FFMPEG_TIMEOUT_MS = 180_000
const WRAPPER_PREFETCH_KEY_URI = 'skd://itunes.apple.com/P000000000/s1/e1'

function wrapperAdamIdForKeyUri(adamId: string, keyUri: string): string {
  // Wrapper's legacy protocol expects adamId "0" when prefetch key is used.
  // This primes/reuses preshare context and avoids FairPlay key persist failures.
  if (keyUri.trim().toLowerCase() === WRAPPER_PREFETCH_KEY_URI.toLowerCase()) {
    return '0'
  }
  return adamId
}

export interface AppleMusicResolveResult {
  ok: boolean
  tempFilePath?: string
  durationSeconds?: number
  error?: { code: string; message: string }
}

// Track previous temp files to clean up
let previousTempFile: string | null = null
const inFlightTrackResolves = new Map<string, Promise<AppleMusicResolveResult>>()

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

function ffmpegBinaryPath(): string | null {
  const envPath = process.env.AONSOKU_FFMPEG_PATH?.trim()
  if (envPath && fs.existsSync(envPath)) {
    return envPath
  }

  const binaryName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const candidates = [
    path.join(process.cwd(), 'resources', 'bin', binaryName),
    path.join(process.resourcesPath, 'resources', 'bin', binaryName),
    path.join(process.resourcesPath, 'bin', binaryName),
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

function parseBoxAt(
  data: Buffer,
  offset: number,
): { size: number; type: string; headerSize: number } | null {
  if (offset + 8 > data.length) return null
  const size32 = data.readUInt32BE(offset)
  const type = data.toString('ascii', offset + 4, offset + 8)

  if (size32 === 0) {
    return {
      size: data.length - offset,
      type,
      headerSize: 8,
    }
  }

  if (size32 === 1) {
    if (offset + 16 > data.length) return null
    const large = Number(data.readBigUInt64BE(offset + 8))
    if (!Number.isFinite(large) || large < 16) return null
    return {
      size: large,
      type,
      headerSize: 16,
    }
  }

  if (size32 < 8) return null
  return {
    size: size32,
    type,
    headerSize: 8,
  }
}

function encodeBox(type: string, headerSize: number, payload: Buffer): Buffer {
  const totalSize = headerSize + payload.length
  const header = Buffer.alloc(headerSize)

  if (headerSize === 16) {
    header.writeUInt32BE(1, 0)
    header.write(type, 4, 4, 'ascii')
    header.writeBigUInt64BE(BigInt(totalSize), 8)
  } else {
    header.writeUInt32BE(totalSize, 0)
    header.write(type, 4, 4, 'ascii')
  }

  return Buffer.concat([header, payload])
}

function audioSampleEntryChildrenOffset(entryPayload: Buffer): number {
  if (entryPayload.length < 28) return entryPayload.length
  const soundVersion = entryPayload.readUInt16BE(8)
  if (soundVersion === 1) return Math.min(entryPayload.length, 44)
  if (soundVersion === 2) return Math.min(entryPayload.length, 64)
  return 28
}

function parseChildBoxes(payload: Buffer, startOffset: number): Array<{ type: string; size: number; data: Buffer }> {
  const children: Array<{ type: string; size: number; data: Buffer }> = []
  let cursor = startOffset
  while (cursor < payload.length) {
    const parsed = parseBoxAt(payload, cursor)
    if (!parsed) break
    const end = cursor + parsed.size
    if (end > payload.length) break
    children.push({
      type: parsed.type,
      size: parsed.size,
      data: Buffer.from(payload.subarray(cursor, end)),
    })
    cursor = end
  }
  return children
}

function parseFrmaTypeFromSinf(sinfData: Buffer): string | undefined {
  const parsedSinf = parseBoxAt(sinfData, 0)
  if (!parsedSinf) return undefined
  const payload = sinfData.subarray(parsedSinf.headerSize)
  let cursor = 0
  while (cursor < payload.length) {
    const child = parseBoxAt(payload, cursor)
    if (!child) break
    const end = cursor + child.size
    if (end > payload.length) break
    if (child.type === 'frma') {
      const frmaPayload = payload.subarray(cursor + child.headerSize, end)
      if (frmaPayload.length >= 4) {
        return frmaPayload.toString('ascii', 0, 4)
      }
    }
    cursor = end
  }
  return undefined
}

interface StsdEntryInfo {
  type: string
  size: number
  data: Buffer
  hasEsds: boolean
  hasAlacConfig: boolean
  hasSinf: boolean
  frmaType?: string
}

function parseStsdEntryInfo(entryData: Buffer): StsdEntryInfo | null {
  const parsed = parseBoxAt(entryData, 0)
  if (!parsed) return null
  const payload = entryData.subarray(parsed.headerSize)
  const childOffset = audioSampleEntryChildrenOffset(payload)
  const childBoxes = parseChildBoxes(payload, childOffset)
  const hasEsds = childBoxes.some((child) => child.type === 'esds')
  const alacChild = childBoxes.find((child) => child.type === 'alac')
  const hasAlacConfig = Boolean(alacChild && alacChild.size >= 36)
  const sinfChild = childBoxes.find((child) => child.type === 'sinf')
  const frmaType = sinfChild ? parseFrmaTypeFromSinf(sinfChild.data) : undefined
  return {
    type: parsed.type,
    size: parsed.size,
    data: entryData,
    hasEsds,
    hasAlacConfig,
    hasSinf: Boolean(sinfChild),
    frmaType,
  }
}

function scoreStsdEntry(entry: StsdEntryInfo): number {
  let score = entry.size
  if (entry.type === 'alac' && entry.hasAlacConfig) score += 1_200_000
  if (entry.type === 'mp4a' && entry.hasEsds) score += 1_100_000
  if (entry.type === 'enca' && entry.frmaType === 'alac' && entry.hasAlacConfig) score += 900_000
  if (entry.type === 'enca' && entry.frmaType === 'mp4a' && entry.hasEsds) score += 850_000
  if (entry.type === 'enca') score -= 250_000
  if (entry.hasSinf) score -= 200_000
  if (entry.type === 'alac' && !entry.hasAlacConfig) score -= 1_000_000
  if (entry.type === 'mp4a' && !entry.hasEsds) score -= 800_000
  return score
}

function rewriteEncryptedEntryToClear(entry: StsdEntryInfo): { rewritten: Buffer; clearType: string } | null {
  if (entry.type !== 'enca') return null
  const clearType = entry.frmaType
  if (!clearType || (clearType !== 'mp4a' && clearType !== 'alac')) {
    return null
  }

  if (clearType === 'mp4a' && !entry.hasEsds) return null
  if (clearType === 'alac' && !entry.hasAlacConfig) return null

  const parsed = parseBoxAt(entry.data, 0)
  if (!parsed) return null
  const payload = entry.data.subarray(parsed.headerSize)
  const childOffset = audioSampleEntryChildrenOffset(payload)
  if (childOffset >= payload.length) return null

  const prefix = payload.subarray(0, childOffset)
  const keptChildren: Buffer[] = []
  let cursor = childOffset
  let removedSinf = false
  while (cursor < payload.length) {
    const child = parseBoxAt(payload, cursor)
    if (!child) {
      keptChildren.push(Buffer.from(payload.subarray(cursor)))
      break
    }
    const end = cursor + child.size
    if (end > payload.length) {
      keptChildren.push(Buffer.from(payload.subarray(cursor)))
      break
    }
    if (child.type !== 'sinf') {
      keptChildren.push(Buffer.from(payload.subarray(cursor, end)))
    } else {
      removedSinf = true
    }
    cursor = end
  }

  if (!removedSinf) return null
  const rewrittenPayload = Buffer.concat([Buffer.from(prefix), ...keptChildren])
  return {
    rewritten: encodeBox(clearType, parsed.headerSize, rewrittenPayload),
    clearType,
  }
}

function sanitizeStsdPayload(payload: Buffer): {
  payload: Buffer
  removedEntries: number
  selectedEntryType?: string
  selectedEntrySize?: number
} {
  if (payload.length < 8) return { payload, removedEntries: 0 }

  const entryCount = payload.readUInt32BE(4)
  if (entryCount <= 1) return { payload, removedEntries: 0 }

  const entries: StsdEntryInfo[] = []
  let cursor = 8
  for (let i = 0; i < entryCount && cursor < payload.length; i += 1) {
    const entry = parseBoxAt(payload, cursor)
    if (!entry) break
    const end = cursor + entry.size
    if (end > payload.length) break
    const entryInfo = parseStsdEntryInfo(Buffer.from(payload.subarray(cursor, end)))
    if (entryInfo) entries.push(entryInfo)
    cursor = end
  }

  if (entries.length === 0) return { payload, removedEntries: 0 }

  let selectedIndex = 0
  let selectedScore = Number.NEGATIVE_INFINITY
  for (let i = 0; i < entries.length; i += 1) {
    const score = scoreStsdEntry(entries[i])
    // Keep later entries when score ties.
    if (score >= selectedScore) {
      selectedScore = score
      selectedIndex = i
    }
  }

  const selectedRaw = entries[selectedIndex]
  const rewritten = rewriteEncryptedEntryToClear(selectedRaw)
  const selectedData = rewritten?.rewritten ?? selectedRaw.data
  const selectedType = rewritten?.clearType ?? selectedRaw.type
  const selectedSize = parseBoxAt(selectedData, 0)?.size ?? selectedRaw.size
  const fixedHead = Buffer.from(payload.subarray(0, 8))
  fixedHead.writeUInt32BE(1, 4)
  const removedEntries = Math.max(0, entries.length - 1)
  if (removedEntries > 0) {
    console.log(
      LOG_TAG,
      `stsd sanitize selected ${selectedType} (${selectedSize}B) from ${entries.length} entries`,
    )
  }
  return {
    payload: Buffer.concat([fixedHead, selectedData]),
    removedEntries,
    selectedEntryType: selectedType,
    selectedEntrySize: selectedSize,
  }
}

function rewriteBoxes(
  data: Buffer,
  containerTypes: Set<string>,
): { data: Buffer; changed: boolean; removedSampleEntries: number } {
  let offset = 0
  let changed = false
  let removedSampleEntries = 0
  const parts: Buffer[] = []

  while (offset < data.length) {
    const parsed = parseBoxAt(data, offset)
    if (!parsed) {
      // Keep trailing bytes as-is when box parsing fails.
      parts.push(Buffer.from(data.subarray(offset)))
      break
    }

    const boxEnd = offset + parsed.size
    if (boxEnd > data.length) {
      parts.push(Buffer.from(data.subarray(offset)))
      break
    }

    const box = data.subarray(offset, boxEnd)
    const payload = box.subarray(parsed.headerSize)
    let nextPayload = payload
    let localChanged = false
    let localRemoved = 0

    if (parsed.type === 'stsd') {
      const stsd = sanitizeStsdPayload(payload)
      nextPayload = stsd.payload
      localChanged = stsd.removedEntries > 0 || nextPayload.length !== payload.length
      localRemoved = stsd.removedEntries
    } else if (containerTypes.has(parsed.type)) {
      const rewritten = rewriteBoxes(payload, containerTypes)
      nextPayload = rewritten.data
      localChanged = rewritten.changed
      localRemoved = rewritten.removedSampleEntries
    }

    if (localChanged) {
      parts.push(encodeBox(parsed.type, parsed.headerSize, nextPayload))
      changed = true
    } else {
      parts.push(Buffer.from(box))
    }

    removedSampleEntries += localRemoved
    offset = boxEnd
  }

  return {
    data: changed ? Buffer.concat(parts) : data,
    changed,
    removedSampleEntries,
  }
}

function sanitizeInitSegmentForSymphonia(initSegment: Buffer): Buffer {
  const containerTypes = new Set([
    'moov',
    'trak',
    'mdia',
    'minf',
    'stbl',
    'edts',
    'dinf',
    'mvex',
    'moof',
    'traf',
  ])

  const rewritten = rewriteBoxes(initSegment, containerTypes)
  if (rewritten.removedSampleEntries > 0) {
    console.log(
      LOG_TAG,
      `Sanitized init segment for symphonia: removed ${rewritten.removedSampleEntries} extra sample entry(ies) from stsd`,
    )
  }
  return rewritten.data
}

interface SampleByteRange {
  offset: number
  length: number
}

interface ParsedTrun {
  sampleSizes: number[]
  dataOffset?: number
}

function readUInt24BE(data: Buffer, offset: number): number {
  return (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2]
}

function parseTfhdDefaultSampleSize(payload: Buffer): number | undefined {
  if (payload.length < 8) return undefined
  const flags = readUInt24BE(payload, 1)
  let cursor = 4 // version+flags
  cursor += 4 // track_ID
  if (flags & 0x000001) cursor += 8 // base_data_offset
  if (flags & 0x000002) cursor += 4 // sample_description_index
  if (flags & 0x000008) cursor += 4 // default_sample_duration
  if (!(flags & 0x000010)) return undefined // default_sample_size
  if (cursor + 4 > payload.length) return undefined
  return payload.readUInt32BE(cursor)
}

function parseTrun(payload: Buffer, defaultSampleSize?: number): ParsedTrun | null {
  if (payload.length < 8) return null
  const version = payload[0]
  void version
  const flags = readUInt24BE(payload, 1)
  let cursor = 4
  if (cursor + 4 > payload.length) return null
  const sampleCount = payload.readUInt32BE(cursor)
  cursor += 4

  let dataOffset: number | undefined
  if (flags & 0x000001) {
    if (cursor + 4 > payload.length) return null
    dataOffset = payload.readInt32BE(cursor)
    cursor += 4
  }
  if (flags & 0x000004) {
    if (cursor + 4 > payload.length) return null
    cursor += 4
  }

  const hasDuration = Boolean(flags & 0x000100)
  const hasSize = Boolean(flags & 0x000200)
  const hasFlags = Boolean(flags & 0x000400)
  const hasCtsOffset = Boolean(flags & 0x000800)
  const sampleSizes: number[] = []

  for (let i = 0; i < sampleCount; i += 1) {
    if (hasDuration) {
      if (cursor + 4 > payload.length) return null
      cursor += 4
    }

    let sampleSize = defaultSampleSize ?? 0
    if (hasSize) {
      if (cursor + 4 > payload.length) return null
      sampleSize = payload.readUInt32BE(cursor)
      cursor += 4
    }
    if (sampleSize <= 0) return null
    sampleSizes.push(sampleSize)

    if (hasFlags) {
      if (cursor + 4 > payload.length) return null
      cursor += 4
    }
    if (hasCtsOffset) {
      if (cursor + 4 > payload.length) return null
      cursor += 4
    }
  }

  return {
    sampleSizes,
    dataOffset,
  }
}

function parseTrafForTruns(payload: Buffer): ParsedTrun[] {
  const truns: ParsedTrun[] = []
  let defaultSampleSize: number | undefined
  let cursor = 0

  while (cursor < payload.length) {
    const parsed = parseBoxAt(payload, cursor)
    if (!parsed) break
    const boxEnd = cursor + parsed.size
    if (boxEnd > payload.length) break
    const boxPayload = payload.subarray(cursor + parsed.headerSize, boxEnd)

    if (parsed.type === 'tfhd') {
      defaultSampleSize = parseTfhdDefaultSampleSize(boxPayload)
    } else if (parsed.type === 'trun') {
      const parsedTrun = parseTrun(boxPayload, defaultSampleSize)
      if (parsedTrun) {
        truns.push(parsedTrun)
      }
    }

    cursor = boxEnd
  }

  return truns
}

function extractSampleRangesFromEncryptedFragment(segment: Buffer): SampleByteRange[] {
  let moofStart = -1
  let mdatDataStart = -1
  let mdatDataEnd = -1
  const truns: ParsedTrun[] = []

  let cursor = 0
  while (cursor < segment.length) {
    const parsed = parseBoxAt(segment, cursor)
    if (!parsed) break
    const boxEnd = cursor + parsed.size
    if (boxEnd > segment.length) break
    const payload = segment.subarray(cursor + parsed.headerSize, boxEnd)

    if (parsed.type === 'moof') {
      moofStart = cursor
      let moofCursor = 0
      while (moofCursor < payload.length) {
        const child = parseBoxAt(payload, moofCursor)
        if (!child) break
        const childEnd = moofCursor + child.size
        if (childEnd > payload.length) break
        const childPayload = payload.subarray(moofCursor + child.headerSize, childEnd)

        if (child.type === 'traf') {
          truns.push(...parseTrafForTruns(childPayload))
        }
        moofCursor = childEnd
      }
    } else if (parsed.type === 'mdat') {
      mdatDataStart = cursor + parsed.headerSize
      mdatDataEnd = boxEnd
    }

    cursor = boxEnd
  }

  if (moofStart < 0 || mdatDataStart < 0 || mdatDataEnd <= mdatDataStart || truns.length === 0) {
    return []
  }

  const ranges: SampleByteRange[] = []
  let sequentialCursor = mdatDataStart

  for (const trun of truns) {
    let sampleCursor = sequentialCursor
    if (typeof trun.dataOffset === 'number') {
      sampleCursor = moofStart + trun.dataOffset
    }

    if (sampleCursor < mdatDataStart || sampleCursor > mdatDataEnd) {
      throw new Error(
        `Invalid trun data_offset while parsing fragment (offset=${sampleCursor}, mdat=[${mdatDataStart},${mdatDataEnd}))`,
      )
    }

    for (const sampleSize of trun.sampleSizes) {
      const sampleEnd = sampleCursor + sampleSize
      if (sampleEnd > mdatDataEnd) {
        throw new Error(
          `Sample range exceeds mdat bounds while parsing fragment (offset=${sampleCursor}, size=${sampleSize}, mdatEnd=${mdatDataEnd})`,
        )
      }
      ranges.push({
        offset: sampleCursor,
        length: sampleSize,
      })
      sampleCursor = sampleEnd
    }

    sequentialCursor = sampleCursor
  }

  return ranges
}

async function transcodeToFlacIfPossible(inputFilePath: string): Promise<string> {
  const ffmpeg = ffmpegBinaryPath()
  if (!ffmpeg) {
    console.warn(LOG_TAG, 'FLAC conversion skipped (ffmpeg binary not found)')
    return inputFilePath
  }

  console.log(LOG_TAG, `FLAC conversion using ffmpeg: ${ffmpeg}`)

  try {
    let normalizedInputPath = inputFilePath
    const sourceStat = await fs.promises.stat(inputFilePath).catch(() => null)
    const normalizedPath = inputFilePath.replace(/\.[^.]+$/u, '.normalized.m4a')
    const remuxArgs = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-fflags',
      '+discardcorrupt',
      '-err_detect',
      'ignore_err',
      '-i',
      inputFilePath,
      '-vn',
      '-map',
      '0:a:0',
      '-c:a',
      'copy',
      '-movflags',
      '+faststart',
      normalizedPath,
    ]

    try {
      await runFfmpeg(ffmpeg, remuxArgs)
      const remuxStat = await fs.promises.stat(normalizedPath).catch(() => null)
      if (sourceStat && remuxStat && isRemuxLikelyValid(sourceStat.size, remuxStat.size)) {
        normalizedInputPath = normalizedPath
      } else {
        if (sourceStat && remuxStat) {
          console.warn(
            LOG_TAG,
            `M4A remux output looked invalid (output=${remuxStat.size}B, input=${sourceStat.size}B). Keeping original container.`,
          )
        }
        await fs.promises.unlink(normalizedPath).catch(() => undefined)
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await fs.promises.unlink(normalizedPath).catch(() => undefined)
      console.warn(LOG_TAG, `M4A remux skipped: ${reason}`)
    }

    const transcodeInputStat = await fs.promises.stat(normalizedInputPath).catch(() => null)
    const flacPath = normalizedInputPath.replace(/\.[^.]+$/u, '.flac')
    const flacArgs = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-fflags',
      '+discardcorrupt',
      '-err_detect',
      'ignore_err',
      '-i',
      normalizedInputPath,
      '-vn',
      '-map',
      '0:a:0',
      '-c:a',
      'flac',
      flacPath,
    ]
    await runFfmpeg(ffmpeg, flacArgs)

    const outputStat = await fs.promises.stat(flacPath).catch(() => null)
    if (transcodeInputStat && outputStat && !isOutputLikelyValid(transcodeInputStat.size, outputStat.size)) {
      await fs.promises.unlink(flacPath).catch(() => undefined)
      console.warn(
        LOG_TAG,
        `FLAC conversion output looked invalid (output=${outputStat.size}B, input=${transcodeInputStat.size}B). Falling back to ${path.basename(normalizedInputPath)}.`,
      )
      return normalizedInputPath
    }

    await fs.promises.unlink(inputFilePath).catch(() => undefined)
    if (normalizedInputPath !== inputFilePath) {
      await fs.promises.unlink(normalizedInputPath).catch(() => undefined)
    }
    console.log(LOG_TAG, `Converted assembled audio to FLAC: ${path.basename(flacPath)}`)
    return flacPath
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const normalizedPath = inputFilePath.replace(/\.[^.]+$/u, '.normalized.m4a')
    const normalizedStat = await fs.promises.stat(normalizedPath).catch(() => null)
    await fs.promises
      .unlink(inputFilePath.replace(/\.[^.]+$/u, '.flac'))
      .catch(() => undefined)
    await fs.promises
      .unlink(normalizedPath.replace(/\.[^.]+$/u, '.flac'))
      .catch(() => undefined)
    const inputStat = await fs.promises.stat(inputFilePath).catch(() => null)
    const fallbackPath =
      inputStat && normalizedStat
        ? isRemuxLikelyValid(inputStat.size, normalizedStat.size)
          ? normalizedPath
          : inputFilePath
        : inputStat
          ? inputFilePath
          : normalizedStat
            ? normalizedPath
            : inputFilePath
    if (fallbackPath === inputFilePath) {
      await fs.promises.unlink(normalizedPath).catch(() => undefined)
    }
    console.warn(LOG_TAG, `FLAC conversion skipped (ffmpeg unavailable or failed): ${reason}`)
    return fallbackPath
  }
}

function isOutputLikelyValid(inputBytes: number, outputBytes: number): boolean {
  const minimumExpectedBytes = Math.max(64 * 1024, Math.floor(inputBytes * 0.01))
  return outputBytes >= minimumExpectedBytes
}

function isRemuxLikelyValid(inputBytes: number, outputBytes: number): boolean {
  const minimumExpectedBytes = Math.max(256 * 1024, Math.floor(inputBytes * 0.6))
  const maximumExpectedBytes = Math.max(inputBytes + 8 * 1024 * 1024, Math.floor(inputBytes * 1.5))
  return outputBytes >= minimumExpectedBytes && outputBytes <= maximumExpectedBytes
}

async function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      ffmpegPath,
      args,
      {
        windowsHide: true,
        timeout: FFMPEG_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, _stdout, stderr) => {
        if (error) {
          const reason = stderr?.trim() || error.message
          reject(new Error(reason))
          return
        }
        resolve()
      },
    )
  })
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
  const existingTask = inFlightTrackResolves.get(adamId)
  if (existingTask) {
    console.log(LOG_TAG, `Reusing in-flight resolve for adamId ${adamId}`)
    return existingTask
  }

  const task = (async (): Promise<AppleMusicResolveResult> => {
    const resolveStart = Date.now()

    try {
      console.log(LOG_TAG, `Resolving adamId: ${adamId}`)

      // Step 1: Get M3U8 URL
      const m3u8Url = await getM3u8Url(adamId)

      // Step 2: Parse HLS playlist
      const resolved = await resolveSegments(m3u8Url)
      const segments = resolved.segments
      const selectedCodecs = resolved.selectedVariantCodecs?.toLowerCase() ?? ''
      const selectedBandwidth = resolved.selectedVariantBandwidth
      const selectedIsAlac = selectedCodecs.includes('alac')
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
      const keyedSegmentCount = segments.reduce(
        (count, seg) => count + (seg.keyUri ? 1 : 0),
        0,
      )
      console.log(
        LOG_TAG,
        `Segments with EXT-X-KEY URI: ${keyedSegmentCount}/${segments.length}`,
      )
      if (selectedCodecs) {
        console.log(
          LOG_TAG,
          `Selected stream metadata: codecs=${selectedCodecs}${typeof selectedBandwidth === 'number' ? ` bandwidth=${selectedBandwidth}` : ''}`,
        )
      }

      // Step 3 & 4: Download and decrypt segments
      const decryptedChunks: Buffer[] = []
      let loggedNoKeyWarning = false

      // Prepend init segment (#EXT-X-MAP) when available.
      // Without this, assembled fMP4 may miss moov and ffmpeg fails with
      // "moov atom not found".
      if (resolved.initSegment) {
        const initBufferRaw = await fetchSegment(
          resolved.initSegment.url,
          resolved.initSegment.byteRange,
        )
        const initBuffer = sanitizeInitSegmentForSymphonia(initBufferRaw)
        decryptedChunks.push(initBuffer)
        console.log(
          LOG_TAG,
          `Fetched init segment (${(initBuffer.length / 1024).toFixed(1)} KiB)`,
        )
      }

      // Process segments in batches to avoid overwhelming the wrapper
      const BATCH_SIZE = 5
      for (let i = 0; i < segments.length; i += BATCH_SIZE) {
        const batch = segments.slice(i, i + BATCH_SIZE)
        const batchStart = Date.now()

        // Download all segments in the batch in parallel
        const encryptedBuffers = await Promise.all(
          batch.map((seg) => fetchSegment(seg.url, seg.byteRange)),
        )

        // Decrypt segments that have EXT-X-KEY URI.
        // We decrypt at MP4 sample granularity (moof/trun/mdat) to preserve
        // container headers. Segment-level raw decrypt corrupts fMP4 structure.
        const decryptedBuffers: Buffer[] = [...encryptedBuffers]
        const keyedGroups = new Map<
          string,
          {
            chunkPayloads: Buffer[]
            writes: Array<{
              segmentIndex: number
              offset: number
              length: number
            }>
          }
        >()

        for (let j = 0; j < batch.length; j += 1) {
          const seg = batch[j]
          const keyUri = seg.keyUri
          if (!keyUri) {
            if (!loggedNoKeyWarning) {
              loggedNoKeyWarning = true
              console.warn(
                LOG_TAG,
                'No EXT-X-KEY URI found for segment(s). Skipping decrypt for clear segments.',
              )
            }
            continue
          }

          if (!Buffer.isBuffer(decryptedBuffers[j]) || decryptedBuffers[j] === encryptedBuffers[j]) {
            decryptedBuffers[j] = Buffer.from(encryptedBuffers[j])
          }

          const sampleRanges = extractSampleRangesFromEncryptedFragment(encryptedBuffers[j])
          if (sampleRanges.length === 0) {
            throw new Error(
              `Could not locate encrypted sample ranges (moof/trun/mdat) in segment ${i + j + 1}`,
            )
          }

          const group =
            keyedGroups.get(keyUri) ??
            (() => {
              const created = {
                chunkPayloads: [] as Buffer[],
                writes: [] as Array<{
                  segmentIndex: number
                  offset: number
                  length: number
                }>,
              }
              keyedGroups.set(keyUri, created)
              return created
            })()

          for (const range of sampleRanges) {
            // Wrapper decrypt primitive expects encrypted bytes aligned to 16-byte CBC blocks.
            // Keep trailing non-block tail bytes untouched.
            const encryptedLength = range.length & ~0xf
            if (encryptedLength <= 0) continue
            group.chunkPayloads.push(
              encryptedBuffers[j].subarray(range.offset, range.offset + encryptedLength),
            )
            group.writes.push({
              segmentIndex: j,
              offset: range.offset,
              length: encryptedLength,
            })
          }
        }

        for (const [keyUri, group] of keyedGroups.entries()) {
          const wrapperAdamId = wrapperAdamIdForKeyUri(adamId, keyUri)
          let decryptedChunks: Buffer[]
          try {
            decryptedChunks = await decryptSamples(
              wrapperAdamId,
              keyUri,
              group.chunkPayloads,
            )
          } catch (_firstError) {
            // Wrapper can occasionally close a decrypt socket early under load.
            // Retry once with a short backoff before failing the whole resolve.
            await new Promise((resolveRetry) => setTimeout(resolveRetry, 150))
            try {
              decryptedChunks = await decryptSamples(
                wrapperAdamId,
                keyUri,
                group.chunkPayloads,
              )
            } catch (secondError) {
              const reason =
                secondError instanceof Error ? secondError.message : String(secondError)
              throw new Error(
                `Decrypt failed for key URI ${keyUri} (batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(segments.length / BATCH_SIZE)}): ${reason}`,
              )
            }
          }

          if (decryptedChunks.length !== group.writes.length) {
            throw new Error(
              `Unexpected decrypt sample count for key URI ${keyUri} (batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(segments.length / BATCH_SIZE)}): expected ${group.writes.length}, got ${decryptedChunks.length}`,
            )
          }

          for (let k = 0; k < group.writes.length; k += 1) {
            const write = group.writes[k]
            const decrypted = decryptedChunks[k]
            if (decrypted.length !== write.length) {
              throw new Error(
                `Unexpected decrypted sample size for key URI ${keyUri} at write ${k}: expected ${write.length}, got ${decrypted.length}`,
              )
            }
            decrypted.copy(decryptedBuffers[write.segmentIndex], write.offset)
          }
        }

        for (const buf of decryptedBuffers) {
          decryptedChunks.push(buf)
        }

        const batchElapsed = Date.now() - batchStart
        console.log(
          LOG_TAG,
          `Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(segments.length / BATCH_SIZE)} done (${batchElapsed}ms)`,
        )
      }

      // Step 5: Assemble into temp file
      cleanupPreviousTempFile()

      const tempDir = os.tmpdir()
      const timestamp = Date.now()
      const tempFileName = `aonsoku-am-${adamId}-${timestamp}.m4a`
      const tempFilePath = path.join(tempDir, tempFileName)

      const assembled = Buffer.concat(decryptedChunks)
      await fs.promises.writeFile(tempFilePath, assembled)
      const playableFilePath = selectedIsAlac
        ? (() => {
            console.log(
              LOG_TAG,
              'Skipping FLAC conversion for ALAC variant to preserve original lossless stream container.',
            )
            return tempFilePath
          })()
        : await transcodeToFlacIfPossible(tempFilePath)

      previousTempFile = playableFilePath

      const totalElapsed = Date.now() - resolveStart
      console.log(
        LOG_TAG,
        `Resolved adamId ${adamId} → ${playableFilePath} (${(assembled.length / 1024 / 1024).toFixed(1)} MB, ${totalElapsed}ms)`,
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
  })()

  inFlightTrackResolves.set(adamId, task)
  try {
    return await task
  } finally {
    if (inFlightTrackResolves.get(adamId) === task) {
      inFlightTrackResolves.delete(adamId)
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
