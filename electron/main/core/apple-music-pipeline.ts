import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { getM3u8Url, decryptSamples } from './wrapper-client'
import { resolveSegments, fetchSegment } from './hls-manager'

const LOG_TAG = '[AppleMusicPipeline]'

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
    const segments = await resolveSegments(m3u8Url)
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

    // Step 3 & 4: Download and decrypt segments
    const decryptedChunks: Buffer[] = []

    // Process segments in batches to avoid overwhelming the wrapper
    const BATCH_SIZE = 5
    for (let i = 0; i < segments.length; i += BATCH_SIZE) {
      const batch = segments.slice(i, i + BATCH_SIZE)
      const batchStart = Date.now()

      // Download all segments in the batch in parallel
      const encryptedBuffers = await Promise.all(
        batch.map((seg) => fetchSegment(seg.url)),
      )

      // Decrypt the batch through wrapper
      // Use the first segment's URL as the key URI context
      const keyUri = batch[0].url
      const decryptedBuffers = await decryptSamples(adamId, keyUri, encryptedBuffers)

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

    previousTempFile = tempFilePath

    const totalElapsed = Date.now() - resolveStart
    console.log(
      LOG_TAG,
      `Resolved adamId ${adamId} → ${tempFilePath} (${(assembled.length / 1024 / 1024).toFixed(1)} MB, ${totalElapsed}ms)`,
    )

    return {
      ok: true,
      tempFilePath,
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
