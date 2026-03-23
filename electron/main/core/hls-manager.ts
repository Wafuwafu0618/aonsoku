import * as https from 'node:https'
import * as http from 'node:http'

const LOG_TAG = '[HlsManager]'

export interface HlsMediaSegment {
  url: string
  duration: number
  byteRange?: { length: number; offset: number }
  keyUri?: string
}

interface HlsVariant {
  bandwidth: number
  url: string
  codecs?: string
}

export interface HlsInitSegment {
  url: string
  byteRange?: { length: number; offset: number }
}

export interface HlsResolveResult {
  segments: HlsMediaSegment[]
  initSegment?: HlsInitSegment
  keyUri?: string
}

/**
 * Parse an HLS master playlist and return the highest-bandwidth variant URL,
 * then parse that media playlist into individual segments plus key/init metadata.
 */
export async function resolveSegments(masterUrl: string): Promise<HlsResolveResult> {
  console.log(LOG_TAG, `Fetching master playlist: ${masterUrl.slice(0, 100)}...`)
  const masterBody = await fetchText(masterUrl)

  // Determine if this is a master playlist or a media playlist
  if (masterBody.includes('#EXT-X-STREAM-INF')) {
    const variants = parseMasterPlaylist(masterBody, masterUrl)
    if (variants.length === 0) {
      throw new Error(`${LOG_TAG} No variants found in master playlist`)
    }

    // Prefer variants that are likely symphonia-compatible by inspecting
    // the init segment's stsd entry count (when available).
    variants.sort((a, b) => b.bandwidth - a.bandwidth)
    let fallback:
      | {
          variant: HlsVariant
          resolved: HlsResolveResult
          stsdEntryCount?: number
        }
      | null = null

    for (const variant of variants) {
      try {
        const mediaBody = await fetchText(variant.url)
        const resolved = parseMediaPlaylist(mediaBody, variant.url)
        if (resolved.segments.length === 0) {
          continue
        }

        const stsdEntryCount = await readInitSegmentStsdEntryCount(resolved)
        if (
          !fallback ||
          normalizeStsdEntryCount(stsdEntryCount) <
            normalizeStsdEntryCount(fallback.stsdEntryCount)
        ) {
          fallback = { variant, resolved, stsdEntryCount }
        }

        const compatible =
          stsdEntryCount === undefined || stsdEntryCount <= 1
        console.log(
          LOG_TAG,
          `Variant probe: bandwidth=${variant.bandwidth} codecs=${variant.codecs ?? 'unknown'} stsdEntries=${stsdEntryCount ?? 'n/a'} compatible=${compatible}`,
        )

        if (compatible) {
          console.log(
            LOG_TAG,
            `Selected variant: bandwidth=${variant.bandwidth} codecs=${variant.codecs ?? 'unknown'}`,
          )
          return resolved
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        console.warn(
          LOG_TAG,
          `Variant probe failed: bandwidth=${variant.bandwidth} reason=${reason}`,
        )
      }
    }

    if (fallback) {
      console.warn(
        LOG_TAG,
        `Using fallback variant: bandwidth=${fallback.variant.bandwidth} codecs=${fallback.variant.codecs ?? 'unknown'} stsdEntries=${fallback.stsdEntryCount ?? 'n/a'}`,
      )
      return fallback.resolved
    }

    throw new Error(`${LOG_TAG} No playable variant found in master playlist`)
  }

  // Already a media playlist (no master)
  return parseMediaPlaylist(masterBody, masterUrl)
}

function parseMasterPlaylist(body: string, baseUrl: string): HlsVariant[] {
  const lines = body.split('\n').map((line) => line.trim())
  const variants: HlsVariant[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue

    const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/)
    const bandwidth = bandwidthMatch ? Number.parseInt(bandwidthMatch[1], 10) : 0
    const codecsMatch = line.match(/CODECS="([^"]+)"/i)
    const codecs = codecsMatch ? codecsMatch[1] : undefined

    const nextLine = lines[i + 1]
    if (nextLine && !nextLine.startsWith('#')) {
      variants.push({
        bandwidth,
        codecs,
        url: resolveUrl(nextLine, baseUrl),
      })
    }
  }

  return variants
}

function parseMediaPlaylist(body: string, baseUrl: string): HlsResolveResult {
  const lines = body.split('\n').map((line) => line.trim())
  const segments: HlsMediaSegment[] = []
  let currentDuration = 0
  let pendingByteRange: { length: number; offset?: number } | undefined
  let nextByteRangeOffset: number | null = null
  let lastSegmentUrl = ''
  let currentKeyUri: string | undefined
  let initSegment: HlsInitSegment | undefined

  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      const durationMatch = line.match(/#EXTINF:([\d.]+)/)
      currentDuration = durationMatch ? Number.parseFloat(durationMatch[1]) : 0
      continue
    }

    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const rangeMatch = line.match(/#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?/)
      if (rangeMatch) {
        const length = Number.parseInt(rangeMatch[1], 10)
        const offset = rangeMatch[2]
          ? Number.parseInt(rangeMatch[2], 10)
          : undefined
        pendingByteRange = { length, offset }
      }
      continue
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseTagAttributes(line)
      const method = attrs.METHOD?.toUpperCase()
      if (method === 'NONE') {
        currentKeyUri = undefined
        continue
      }

      const nextKeyUri = attrs.URI ? resolveUrl(attrs.URI, baseUrl) : undefined
      // Prefer FairPlay key URI when available.
      const keyFormat = attrs.KEYFORMAT?.toLowerCase()
      if (!keyFormat || keyFormat.includes('streamingkeydelivery')) {
        currentKeyUri = nextKeyUri
      }
      continue
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseTagAttributes(line)
      if (attrs.URI) {
        const mapByteRange = attrs.BYTERANGE
          ? parseByteRangeAttr(attrs.BYTERANGE)
          : undefined
        initSegment = {
          url: resolveUrl(attrs.URI, baseUrl),
          byteRange: mapByteRange,
        }
      }
      continue
    }

    // Skip directives and empty lines
    if (line.length === 0 || line.startsWith('#')) continue

    // This is a segment URL
    const resolvedUrl = resolveUrl(line, baseUrl)
    let byteRange: { length: number; offset: number } | undefined
    if (pendingByteRange) {
      const inferredOffset =
        typeof pendingByteRange.offset === 'number'
          ? pendingByteRange.offset
          : resolvedUrl === lastSegmentUrl && nextByteRangeOffset !== null
            ? nextByteRangeOffset
            : 0
      byteRange = { length: pendingByteRange.length, offset: inferredOffset }
      nextByteRangeOffset = inferredOffset + pendingByteRange.length
    } else {
      nextByteRangeOffset = null
    }

    segments.push({
      url: resolvedUrl,
      duration: currentDuration,
      byteRange,
      keyUri: currentKeyUri,
    })

    lastSegmentUrl = resolvedUrl
    currentDuration = 0
    pendingByteRange = undefined
  }

  console.log(LOG_TAG, `Parsed ${segments.length} segments`)
  return {
    segments,
    initSegment,
    keyUri: segments.find((segment) => Boolean(segment.keyUri))?.keyUri,
  }
}

/**
 * Fetch a single segment as a Buffer.
 */
export async function fetchSegment(
  url: string,
  byteRange?: { length: number; offset: number },
): Promise<Buffer> {
  return fetchBinary(url, byteRange)
}

function resolveUrl(relative: string, base: string): string {
  try {
    return new URL(relative, base).toString()
  } catch {
    return relative
  }
}

function parseTagAttributes(line: string): Record<string, string> {
  const separatorIndex = line.indexOf(':')
  if (separatorIndex < 0) return {}

  const raw = line.slice(separatorIndex + 1)
  const attrs: Record<string, string> = {}
  const regex = /([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/gi
  let match: RegExpExecArray | null
  while ((match = regex.exec(raw)) !== null) {
    const key = match[1]
    const value = match[2]
    if (!value) continue
    attrs[key] =
      value.startsWith('"') && value.endsWith('"')
        ? value.slice(1, -1)
        : value
  }
  return attrs
}

function parseByteRangeAttr(value: string): { length: number; offset: number } {
  const [lengthRaw, offsetRaw] = value.split('@')
  const length = Number.parseInt(lengthRaw, 10)
  const offset = offsetRaw ? Number.parseInt(offsetRaw, 10) : 0
  return {
    length: Number.isFinite(length) ? length : 0,
    offset: Number.isFinite(offset) ? offset : 0,
  }
}

async function readInitSegmentStsdEntryCount(
  resolved: HlsResolveResult,
): Promise<number | undefined> {
  if (!resolved.initSegment) return undefined

  const initBuffer = await fetchBinary(
    resolved.initSegment.url,
    resolved.initSegment.byteRange,
  )
  return extractFirstTrackStsdEntryCount(initBuffer)
}

interface Mp4Box {
  type: string
  start: number
  end: number
  headerSize: number
}

function parseNextMp4Box(
  buffer: Buffer,
  offset: number,
  endOffset: number,
): Mp4Box | null {
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
): Mp4Box | null {
  let cursor = parentStart
  while (cursor + 8 <= parentEnd) {
    const box = parseNextMp4Box(buffer, cursor, parentEnd)
    if (!box) break
    if (box.type === type) return box
    cursor = box.end
  }
  return null
}

function extractFirstTrackStsdEntryCount(buffer: Buffer): number | undefined {
  const moov = findChildBox(buffer, 0, buffer.length, 'moov')
  if (!moov) return undefined

  let trakCursor = moov.start + moov.headerSize
  while (trakCursor + 8 <= moov.end) {
    const trak = parseNextMp4Box(buffer, trakCursor, moov.end)
    if (!trak) break
    trakCursor = trak.end
    if (trak.type !== 'trak') continue

    const mdia = findChildBox(
      buffer,
      trak.start + trak.headerSize,
      trak.end,
      'mdia',
    )
    if (!mdia) continue

    const hdlr = findChildBox(
      buffer,
      mdia.start + mdia.headerSize,
      mdia.end,
      'hdlr',
    )
    if (!hdlr) continue
    const handlerType = readHandlerType(buffer, hdlr)
    if (handlerType !== 'soun') continue

    const minf = findChildBox(
      buffer,
      mdia.start + mdia.headerSize,
      mdia.end,
      'minf',
    )
    if (!minf) continue

    const stbl = findChildBox(
      buffer,
      minf.start + minf.headerSize,
      minf.end,
      'stbl',
    )
    if (!stbl) continue

    const stsd = findChildBox(
      buffer,
      stbl.start + stbl.headerSize,
      stbl.end,
      'stsd',
    )
    if (!stsd) continue

    const payloadStart = stsd.start + stsd.headerSize
    if (payloadStart + 8 > stsd.end || payloadStart + 8 > buffer.length) {
      return undefined
    }

    return buffer.readUInt32BE(payloadStart + 4)
  }

  return undefined
}

function readHandlerType(buffer: Buffer, hdlr: Mp4Box): string | undefined {
  const payloadStart = hdlr.start + hdlr.headerSize
  // version+flags(4) + pre_defined(4) + handler_type(4)
  const handlerOffset = payloadStart + 8
  if (handlerOffset + 4 > hdlr.end || handlerOffset + 4 > buffer.length) {
    return undefined
  }
  return buffer.toString('ascii', handlerOffset, handlerOffset + 4)
}

function normalizeStsdEntryCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return Number.MAX_SAFE_INTEGER
  }
  return value
}

function fetchText(url: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const getter = url.startsWith('https') ? https.get : http.get

    const request = getter(url, { timeout: 15_000 }, (response) => {
      // Follow redirects
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        fetchText(response.headers.location).then(resolve, reject)
        return
      }

      if (response.statusCode && response.statusCode >= 400) {
        reject(new Error(`${LOG_TAG} HTTP ${response.statusCode} for ${url.slice(0, 80)}`))
        return
      }

      let body = ''
      response.setEncoding('utf-8')
      response.on('data', (chunk: string) => {
        body += chunk
      })
      response.on('end', () => resolve(body))
      response.on('error', reject)
    })

    request.on('error', reject)
    request.on('timeout', () => {
      request.destroy()
      reject(new Error(`${LOG_TAG} Timeout fetching ${url.slice(0, 80)}`))
    })
  })
}

function fetchBinary(
  url: string,
  byteRange?: { length: number; offset: number },
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const getter = url.startsWith('https') ? https.get : http.get
    const headers =
      byteRange && byteRange.length > 0
        ? {
            Range: `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`,
          }
        : undefined

    const request = getter(url, { timeout: 30_000, headers }, (response) => {
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        fetchBinary(response.headers.location, byteRange).then(resolve, reject)
        return
      }

      if (response.statusCode && response.statusCode >= 400) {
        reject(new Error(`${LOG_TAG} HTTP ${response.statusCode} for ${url.slice(0, 80)}`))
        return
      }

      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve(Buffer.concat(chunks)))
      response.on('error', reject)
    })

    request.on('error', reject)
    request.on('timeout', () => {
      request.destroy()
      reject(new Error(`${LOG_TAG} Timeout fetching ${url.slice(0, 80)}`))
    })
  })
}
