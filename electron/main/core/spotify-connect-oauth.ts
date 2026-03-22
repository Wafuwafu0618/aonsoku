import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { URL, URLSearchParams } from 'node:url'
import { shell } from 'electron'
import {
  SpotifyConnectOAuthAuthorizeRequest,
  SpotifyConnectOAuthRefreshRequest,
  SpotifyConnectOAuthTokenResult,
} from '../../preload/types'

const SPOTIFY_ACCOUNTS_BASE_URL = 'https://accounts.spotify.com'
const DEFAULT_SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-private',
]
const DEFAULT_REDIRECT_PORT = 4381
const OAUTH_TIMEOUT_MS = 180_000

function toBase64Url(bytes: Buffer): string {
  return bytes
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function randomBase64Url(bytes: number): string {
  return toBase64Url(randomBytes(bytes))
}

function createCodeChallenge(verifier: string): string {
  const digest = createHash('sha256').update(verifier).digest()
  return toBase64Url(digest)
}

function renderOAuthResponseHtml(message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Spotify OAuth</title></head><body><h3>${message}</h3><p>You can close this window.</p></body></html>`
}

function readRequestUrl(request: IncomingMessage): URL | null {
  if (!request.url) return null
  try {
    return new URL(request.url, 'http://127.0.0.1')
  } catch {
    return null
  }
}

function sendHtml(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(body)
}

async function exchangeCodeForToken(params: {
  clientId: string
  code: string
  codeVerifier: string
  redirectUri: string
}): Promise<SpotifyConnectOAuthTokenResult> {
  const body = new URLSearchParams({
    client_id: params.clientId,
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  })

  let response: Awaited<ReturnType<typeof fetch>>
  try {
    response = await fetch(`${SPOTIFY_ACCOUNTS_BASE_URL}/api/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    })
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'spotify-token-network-error',
        message: 'Failed to reach Spotify token endpoint.',
        details: {
          error: String(error),
        },
      },
    }
  }

  let json: unknown
  try {
    json = await response.json()
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'spotify-token-invalid-json',
        message: 'Spotify token endpoint returned invalid JSON.',
        details: {
          status: response.status,
          error: String(error),
        },
      },
    }
  }

  const payload = typeof json === 'object' && json !== null ? json : {}
  if (!response.ok) {
    return {
      ok: false,
      error: {
        code: 'spotify-token-exchange-failed',
        message: 'Failed to exchange authorization code.',
        details: {
          status: response.status,
          payload,
        },
      },
    }
  }

  const accessToken =
    typeof (payload as { access_token?: unknown }).access_token === 'string'
      ? ((payload as { access_token: string }).access_token as string)
      : ''
  const refreshToken =
    typeof (payload as { refresh_token?: unknown }).refresh_token === 'string'
      ? ((payload as { refresh_token: string }).refresh_token as string)
      : undefined
  const expiresIn =
    typeof (payload as { expires_in?: unknown }).expires_in === 'number'
      ? ((payload as { expires_in: number }).expires_in as number)
      : undefined
  const scope =
    typeof (payload as { scope?: unknown }).scope === 'string'
      ? ((payload as { scope: string }).scope as string)
      : undefined
  const tokenType =
    typeof (payload as { token_type?: unknown }).token_type === 'string'
      ? ((payload as { token_type: string }).token_type as string)
      : undefined

  if (!accessToken) {
    return {
      ok: false,
      error: {
        code: 'spotify-token-missing-access-token',
        message: 'Spotify token response did not include access_token.',
        details: {
          payload,
        },
      },
    }
  }

  return {
    ok: true,
    accessToken,
    refreshToken,
    expiresIn,
    scope,
    tokenType,
    obtainedAtEpochMs: Date.now(),
  }
}

let authorizeInFlight = false

export async function spotifyConnectOAuthAuthorize(
  payload: SpotifyConnectOAuthAuthorizeRequest,
): Promise<SpotifyConnectOAuthTokenResult> {
  if (authorizeInFlight) {
    return {
      ok: false,
      error: {
        code: 'oauth-in-progress',
        message: 'Spotify OAuth authorization is already in progress.',
      },
    }
  }

  const clientId = payload.clientId.trim()
  if (!clientId) {
    return {
      ok: false,
      error: {
        code: 'invalid-client-id',
        message: 'clientId is required.',
      },
    }
  }

  const redirectPort = payload.redirectPort ?? DEFAULT_REDIRECT_PORT
  if (!Number.isInteger(redirectPort) || redirectPort < 1 || redirectPort > 65535) {
    return {
      ok: false,
      error: {
        code: 'invalid-redirect-port',
        message: 'redirectPort must be an integer between 1 and 65535.',
      },
    }
  }

  const scopes = payload.scopes?.length ? payload.scopes : DEFAULT_SCOPES
  const normalizedScopes = scopes.map((scope) => scope.trim()).filter(Boolean)
  if (normalizedScopes.length === 0) {
    return {
      ok: false,
      error: {
        code: 'invalid-scopes',
        message: 'At least one OAuth scope is required.',
      },
    }
  }

  const codeVerifier = randomBase64Url(64)
  const codeChallenge = createCodeChallenge(codeVerifier)
  const state = randomBase64Url(32)
  const redirectUri = `http://127.0.0.1:${redirectPort}/callback`

  authorizeInFlight = true
  const server = createServer()
  try {
    const callbackPromise = new Promise<{ code: string }>((resolve, reject) => {
      let settled = false
      const resolveOnce = (value: { code: string }) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const rejectOnce = (reason: {
        code: string
        message: string
        details?: Record<string, unknown>
      }) => {
        if (settled) return
        settled = true
        reject(reason)
      }

      server.on('request', (request, response) => {
        const url = readRequestUrl(request)
        if (!url || url.pathname !== '/callback') {
          sendHtml(response, 404, renderOAuthResponseHtml('Not Found'))
          return
        }

        const responseState = url.searchParams.get('state')
        const responseCode = url.searchParams.get('code')
        const responseError = url.searchParams.get('error')

        if (responseError) {
          sendHtml(
            response,
            400,
            renderOAuthResponseHtml(`Spotify authorization failed: ${responseError}`),
          )
          rejectOnce({
            code: 'spotify-authorization-denied',
            message: 'Spotify authorization was denied.',
            details: {
              error: responseError,
            },
          })
          return
        }

        if (!responseCode || !responseState || responseState !== state) {
          sendHtml(response, 400, renderOAuthResponseHtml('Invalid OAuth callback'))
          rejectOnce({
            code: 'spotify-invalid-callback',
            message: 'Received invalid OAuth callback.',
          })
          return
        }

        sendHtml(response, 200, renderOAuthResponseHtml('Spotify authorization completed'))
        resolveOnce({ code: responseCode })
      })
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(redirectPort, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })

    const authUrl = new URL(`${SPOTIFY_ACCOUNTS_BASE_URL}/authorize`)
    authUrl.searchParams.set('client_id', clientId)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('scope', normalizedScopes.join(' '))
    authUrl.searchParams.set('code_challenge_method', 'S256')
    authUrl.searchParams.set('code_challenge', codeChallenge)
    authUrl.searchParams.set('state', state)

    await shell.openExternal(authUrl.toString())

    const callbackResult = await Promise.race([
      callbackPromise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject({
              code: 'spotify-oauth-timeout',
              message: 'Timed out waiting for Spotify OAuth callback.',
            }),
          OAUTH_TIMEOUT_MS,
        ),
      ),
    ])

    return await exchangeCodeForToken({
      clientId,
      code: callbackResult.code,
      codeVerifier,
      redirectUri,
    })
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      'message' in error &&
      typeof (error as { code?: unknown }).code === 'string' &&
      typeof (error as { message?: unknown }).message === 'string'
    ) {
      const normalizedError = error as {
        code: string
        message: string
        details?: unknown
      }
      return {
        ok: false,
        error: {
          code: normalizedError.code,
          message: normalizedError.message,
          details:
            typeof normalizedError.details === 'object' && normalizedError.details !== null
              ? (normalizedError.details as Record<string, unknown>)
              : undefined,
        },
      }
    }

    return {
      ok: false,
      error: {
        code: 'spotify-oauth-failed',
        message: 'Spotify OAuth authorization failed.',
        details: {
          error: String(error),
        },
      },
    }
  } finally {
    authorizeInFlight = false
    if (server.listening) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
    }
  }
}

export async function spotifyConnectOAuthRefresh(
  payload: SpotifyConnectOAuthRefreshRequest,
): Promise<SpotifyConnectOAuthTokenResult> {
  const clientId = payload.clientId.trim()
  if (!clientId) {
    return {
      ok: false,
      error: {
        code: 'invalid-client-id',
        message: 'clientId is required.',
      },
    }
  }

  const refreshToken = payload.refreshToken.trim()
  if (!refreshToken) {
    return {
      ok: false,
      error: {
        code: 'invalid-refresh-token',
        message: 'refreshToken is required.',
      },
    }
  }

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })

  let response: Awaited<ReturnType<typeof fetch>>
  try {
    response = await fetch(`${SPOTIFY_ACCOUNTS_BASE_URL}/api/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    })
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'spotify-token-network-error',
        message: 'Failed to reach Spotify token endpoint.',
        details: {
          error: String(error),
        },
      },
    }
  }

  let json: unknown
  try {
    json = await response.json()
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'spotify-token-invalid-json',
        message: 'Spotify token endpoint returned invalid JSON.',
        details: {
          status: response.status,
          error: String(error),
        },
      },
    }
  }

  const payloadJson = typeof json === 'object' && json !== null ? json : {}
  if (!response.ok) {
    return {
      ok: false,
      error: {
        code: 'spotify-token-refresh-failed',
        message: 'Failed to refresh Spotify access token.',
        details: {
          status: response.status,
          payload: payloadJson,
        },
      },
    }
  }

  const accessToken =
    typeof (payloadJson as { access_token?: unknown }).access_token === 'string'
      ? ((payloadJson as { access_token: string }).access_token as string)
      : ''
  const nextRefreshToken =
    typeof (payloadJson as { refresh_token?: unknown }).refresh_token === 'string'
      ? ((payloadJson as { refresh_token: string }).refresh_token as string)
      : refreshToken
  const expiresIn =
    typeof (payloadJson as { expires_in?: unknown }).expires_in === 'number'
      ? ((payloadJson as { expires_in: number }).expires_in as number)
      : undefined
  const scope =
    typeof (payloadJson as { scope?: unknown }).scope === 'string'
      ? ((payloadJson as { scope: string }).scope as string)
      : undefined
  const tokenType =
    typeof (payloadJson as { token_type?: unknown }).token_type === 'string'
      ? ((payloadJson as { token_type: string }).token_type as string)
      : undefined

  if (!accessToken) {
    return {
      ok: false,
      error: {
        code: 'spotify-token-missing-access-token',
        message: 'Spotify token response did not include access_token.',
        details: {
          payload: payloadJson,
        },
      },
    }
  }

  return {
    ok: true,
    accessToken,
    refreshToken: nextRefreshToken,
    expiresIn,
    scope,
    tokenType,
    obtainedAtEpochMs: Date.now(),
  }
}
