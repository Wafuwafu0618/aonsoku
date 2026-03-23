import * as net from 'node:net'
import * as http from 'node:http'

const LOG_TAG = '[WrapperClient]'

export interface WrapperConfig {
  host: string
  decryptPort: number
  m3u8Port: number
  accountPort: number
}

export interface WrapperAccountInfo {
  storefront_id: string
  dev_token: string
  music_token: string
}

const DEFAULT_CONFIG: WrapperConfig = {
  host: '127.0.0.1',
  decryptPort: 10020,
  m3u8Port: 20020,
  accountPort: 30020,
}

let activeConfig: WrapperConfig = { ...DEFAULT_CONFIG }

export function setWrapperConfig(config: Partial<WrapperConfig>): void {
  activeConfig = {
    host: config.host ?? DEFAULT_CONFIG.host,
    decryptPort: config.decryptPort ?? DEFAULT_CONFIG.decryptPort,
    m3u8Port: config.m3u8Port ?? DEFAULT_CONFIG.m3u8Port,
    accountPort: config.accountPort ?? DEFAULT_CONFIG.accountPort,
  }
  console.log(LOG_TAG, 'config updated', activeConfig)
}

export function getWrapperConfig(): WrapperConfig {
  return { ...activeConfig }
}

/**
 * Get HLS M3U8 URL for a given adamId.
 *
 * Protocol (port 20020):
 *   Send: uint8 adamIdLength, then adamId bytes
 *   Recv: text line ending with '\n' containing the M3U8 URL
 */
export async function getM3u8Url(adamId: string): Promise<string> {
  const adamIdBuf = Buffer.from(adamId, 'utf-8')

  if (adamIdBuf.length === 0 || adamIdBuf.length > 255) {
    throw new Error(`${LOG_TAG} Invalid adamId length: ${adamIdBuf.length}`)
  }

  return new Promise<string>((resolve, reject) => {
    const socket = new net.Socket()
    let responseData = ''
    let settled = false

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        socket.destroy()
        reject(new Error(`${LOG_TAG} M3U8 request timed out for adamId ${adamId}`))
      }
    }, 15_000)

    socket.connect(activeConfig.m3u8Port, activeConfig.host, () => {
      const header = Buffer.alloc(1)
      header.writeUInt8(adamIdBuf.length, 0)
      socket.write(Buffer.concat([header, adamIdBuf]))
    })

    socket.on('data', (chunk: Buffer) => {
      responseData += chunk.toString('utf-8')

      const newlineIdx = responseData.indexOf('\n')
      if (newlineIdx >= 0) {
        clearTimeout(timeout)
        settled = true
        socket.destroy()

        const url = responseData.slice(0, newlineIdx).trim()
        if (url.length === 0) {
          reject(new Error(`${LOG_TAG} Wrapper returned empty M3U8 URL for adamId ${adamId}`))
        } else {
          console.log(LOG_TAG, `M3U8 URL for ${adamId}: ${url.slice(0, 80)}...`)
          resolve(url)
        }
      }
    })

    socket.on('error', (error) => {
      if (!settled) {
        clearTimeout(timeout)
        settled = true
        reject(new Error(`${LOG_TAG} M3U8 socket error: ${error.message}`))
      }
    })

    socket.on('close', () => {
      if (!settled) {
        clearTimeout(timeout)
        settled = true
        reject(new Error(`${LOG_TAG} M3U8 socket closed before receiving response`))
      }
    })
  })
}

/**
 * Decrypt FairPlay-encrypted audio samples.
 *
 * Protocol (port 10020):
 *   Send: uint8 adamIdLen, adamId bytes, uint8 uriLen, uri bytes
 *   Then for each chunk: uint32LE chunkSize, chunk bytes
 *   Send uint32LE 0 to signal end of chunks for this key context
 *   Recv: for each chunk sent, uint32LE size then decrypted bytes
 */
export async function decryptSamples(
  adamId: string,
  uri: string,
  encryptedChunks: Buffer[],
): Promise<Buffer[]> {
  const adamIdBuf = Buffer.from(adamId, 'utf-8')
  const uriBuf = Buffer.from(uri, 'utf-8')

  if (adamIdBuf.length === 0 || adamIdBuf.length > 255) {
    throw new Error(`${LOG_TAG} Invalid adamId length: ${adamIdBuf.length}`)
  }
  if (uriBuf.length === 0 || uriBuf.length > 255) {
    throw new Error(`${LOG_TAG} Invalid URI length: ${uriBuf.length}`)
  }

  return new Promise<Buffer[]>((resolve, reject) => {
    const socket = new net.Socket()
    const decryptedChunks: Buffer[] = []
    let responseBuf = Buffer.alloc(0)
    let expectedChunks = encryptedChunks.length
    let settled = false

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        socket.destroy()
        reject(new Error(`${LOG_TAG} Decrypt request timed out`))
      }
    }, 60_000)

    socket.connect(activeConfig.decryptPort, activeConfig.host, () => {
      // Send adamId header
      const adamIdHeader = Buffer.alloc(1)
      adamIdHeader.writeUInt8(adamIdBuf.length, 0)
      socket.write(Buffer.concat([adamIdHeader, adamIdBuf]))

      // Send URI header
      const uriHeader = Buffer.alloc(1)
      uriHeader.writeUInt8(uriBuf.length, 0)
      socket.write(Buffer.concat([uriHeader, uriBuf]))

      // Send each encrypted chunk
      for (const chunk of encryptedChunks) {
        const sizeHeader = Buffer.alloc(4)
        sizeHeader.writeUInt32LE(chunk.length, 0)
        socket.write(Buffer.concat([sizeHeader, chunk]))
      }

      // Send terminator (size = 0)
      const terminator = Buffer.alloc(4)
      terminator.writeUInt32LE(0, 0)
      socket.write(terminator)
    })

    socket.on('data', (chunk: Buffer) => {
      responseBuf = Buffer.concat([responseBuf, chunk])

      // Parse decrypted chunks from the response buffer
      while (decryptedChunks.length < expectedChunks && responseBuf.length >= 4) {
        // Each response is the same size as the input (decrypted in-place)
        const expectedSize = encryptedChunks[decryptedChunks.length].length
        if (responseBuf.length < expectedSize) break

        decryptedChunks.push(responseBuf.subarray(0, expectedSize))
        responseBuf = responseBuf.subarray(expectedSize)
      }

      if (decryptedChunks.length >= expectedChunks) {
        clearTimeout(timeout)
        settled = true
        socket.destroy()
        resolve(decryptedChunks.map((b) => Buffer.from(b)))
      }
    })

    socket.on('error', (error) => {
      if (!settled) {
        clearTimeout(timeout)
        settled = true
        reject(new Error(`${LOG_TAG} Decrypt socket error: ${error.message}`))
      }
    })

    socket.on('close', () => {
      if (!settled) {
        clearTimeout(timeout)
        settled = true
        if (decryptedChunks.length >= expectedChunks) {
          resolve(decryptedChunks.map((b) => Buffer.from(b)))
        } else {
          reject(
            new Error(
              `${LOG_TAG} Decrypt socket closed early. Got ${decryptedChunks.length}/${expectedChunks} chunks`,
            ),
          )
        }
      }
    })
  })
}

/**
 * Get account info from wrapper's HTTP endpoint (port 30020).
 */
export async function getAccountInfo(): Promise<WrapperAccountInfo> {
  return new Promise<WrapperAccountInfo>((resolve, reject) => {
    const url = `http://${activeConfig.host}:${activeConfig.accountPort}/`

    const request = http.get(url, { timeout: 10_000 }, (response) => {
      let body = ''

      response.on('data', (chunk: Buffer | string) => {
        body += typeof chunk === 'string' ? chunk : chunk.toString('utf-8')
      })

      response.on('end', () => {
        try {
          const parsed = JSON.parse(body) as WrapperAccountInfo
          if (
            !parsed.storefront_id ||
            !parsed.dev_token ||
            !parsed.music_token
          ) {
            reject(new Error(`${LOG_TAG} Incomplete account info from wrapper`))
            return
          }
          console.log(LOG_TAG, `Account info: storefront=${parsed.storefront_id}`)
          resolve(parsed)
        } catch (error) {
          reject(
            new Error(
              `${LOG_TAG} Failed to parse account info: ${error instanceof Error ? error.message : String(error)}`,
            ),
          )
        }
      })
    })

    request.on('error', (error) => {
      reject(new Error(`${LOG_TAG} Account info request failed: ${error.message}`))
    })

    request.on('timeout', () => {
      request.destroy()
      reject(new Error(`${LOG_TAG} Account info request timed out`))
    })
  })
}

/**
 * Quick health check — tries to connect to the account port.
 */
export async function isWrapperAvailable(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket()

    const timeout = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, 3_000)

    socket.connect(activeConfig.accountPort, activeConfig.host, () => {
      clearTimeout(timeout)
      socket.destroy()
      resolve(true)
    })

    socket.on('error', () => {
      clearTimeout(timeout)
      resolve(false)
    })
  })
}
