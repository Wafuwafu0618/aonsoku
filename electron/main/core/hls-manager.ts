import * as https from 'node:https'
import * as http from 'node:http'

const LOG_TAG = '[HlsManager]'

export interface HlsMediaSegment {
  url: string
  duration: number
  byteRange?: { length: number; offset: number }
  keyUri?: string
}

export interface HlsInitSegment {
  url: string
  byteRange?: { length: number; offset: number }
}

export interface HlsResolveResult {
  segments: HlsMediaSegment[]
  initSegment?: HlsInitSegment
  selectedVariantCodecs?: string
  selectedVariantBandwidth?: number
}

interface HlsVariant {
  bandwidth: number
  url: string
  codecs?: string
}

/**
 * Parse an HLS master playlist and return the highest-bandwidth variant URL,
 * then parse that media playlist into individual segments.
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

    // Prefer ALAC variants first to keep Apple Music lossless quality when available.
    const alacVariants = variants.filter((variant) => {
      const codecs = variant.codecs?.toLowerCase() ?? ''
      return codecs.includes('alac')
    })
    const aacVariants = variants.filter((variant) => {
      const codecs = variant.codecs?.toLowerCase() ?? ''
      return codecs.includes('mp4a')
    })

    const candidates =
      alacVariants.length > 0
        ? alacVariants
        : aacVariants.length > 0
          ? aacVariants
          : variants
    candidates.sort((a, b) => b.bandwidth - a.bandwidth)
    const best = candidates[0]
    console.log(
      LOG_TAG,
      `Selected variant: bandwidth=${best.bandwidth}${best.codecs ? ` codecs=${best.codecs}` : ''}${alacVariants.length > 0 ? ' (alac-preferred)' : aacVariants.length > 0 ? ' (aac-fallback)' : ''}`,
    )

    const mediaBody = await fetchText(best.url)
    return parseMediaPlaylist(mediaBody, best.url, {
      selectedVariantCodecs: best.codecs,
      selectedVariantBandwidth: best.bandwidth,
    })
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
    const codecs = codecsMatch?.[1]

    const nextLine = lines[i + 1]
    if (nextLine && !nextLine.startsWith('#')) {
      variants.push({
        bandwidth,
        url: resolveUrl(nextLine, baseUrl),
        codecs,
      })
    }
  }

  return variants
}

function parseMediaPlaylist(
  body: string,
  baseUrl: string,
  meta?: {
    selectedVariantCodecs?: string
    selectedVariantBandwidth?: number
  },
): HlsResolveResult {
  const lines = body.split('\n').map((line) => line.trim())
  const segments: HlsMediaSegment[] = []
  let currentDuration = 0
  let currentByteRange: { length: number; offset?: number } | undefined
  let currentKeyUri: string | undefined
  let nextByteRangeOffset: number | null = null
  let lastSegmentUrl = ''
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
        currentByteRange = { length, offset }
      }
      continue
    }

    if (line.startsWith('#EXT-X-KEY:')) {
      const uriMatch = line.match(/URI="([^"]+)"/i)
      currentKeyUri = uriMatch ? resolveUrl(uriMatch[1], baseUrl) : undefined
      continue
    }

    if (line.startsWith('#EXT-X-MAP:')) {
      const uriMatch = line.match(/URI="([^"]+)"/i)
      const byteRangeMatch = line.match(/BYTERANGE="(\d+)(?:@(\d+))?"/i)
      if (uriMatch) {
        const mapUrl = resolveUrl(uriMatch[1], baseUrl)
        const mapByteRange =
          byteRangeMatch && byteRangeMatch[1]
            ? {
                length: Number.parseInt(byteRangeMatch[1], 10),
                offset: byteRangeMatch[2]
                  ? Number.parseInt(byteRangeMatch[2], 10)
                  : 0,
              }
            : undefined
        initSegment = {
          url: mapUrl,
          byteRange: mapByteRange,
        }

        // Seed BYTERANGE cursor so first media segment can infer offset
        // when @offset is omitted and URL is identical.
        if (mapByteRange) {
          lastSegmentUrl = mapUrl
          nextByteRangeOffset = mapByteRange.offset + mapByteRange.length
        }
      }
      continue
    }

    // Skip directives and empty lines
    if (line.length === 0 || line.startsWith('#')) continue

    // This is a segment URL
    const resolvedUrl = resolveUrl(line, baseUrl)
    let byteRange: { length: number; offset: number } | undefined
    if (currentByteRange) {
      const inferredOffset =
        typeof currentByteRange.offset === 'number'
          ? currentByteRange.offset
          : resolvedUrl === lastSegmentUrl && nextByteRangeOffset !== null
            ? nextByteRangeOffset
            : 0
      byteRange = {
        length: currentByteRange.length,
        offset: inferredOffset,
      }
      nextByteRangeOffset = inferredOffset + currentByteRange.length
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
    currentByteRange = undefined
  }

  console.log(LOG_TAG, `Parsed ${segments.length} segments`)
  return {
    segments,
    initSegment,
    selectedVariantCodecs: meta?.selectedVariantCodecs,
    selectedVariantBandwidth: meta?.selectedVariantBandwidth,
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
