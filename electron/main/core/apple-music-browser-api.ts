import { BrowserWindow, session as electronSession } from 'electron'

const APPLE_MUSIC_AUTH_PARTITION = 'persist:apple-music-auth'
const APPLE_MUSIC_URL = 'https://music.apple.com'
const WINDOW_LOAD_TIMEOUT_MS = 30_000
const SIGN_IN_TIMEOUT_MS = 5 * 60_000
const SIGN_IN_POLL_INTERVAL_MS = 1_500
const SESSION_AUTH_CHECK_TIMEOUT_MS = 20_000
const API_INVOKE_TIMEOUT_MS = 45_000
const AUTH_WINDOW_DEFAULT_WIDTH = 1280
const AUTH_WINDOW_DEFAULT_HEIGHT = 900
const AUTH_TRACE_MAX_LINES = 300
const COOKIE_NAME_SAMPLE_MAX = 80

export type AppleMusicApiAction =
  | 'status'
  | 'search'
  | 'catalog-album'
  | 'catalog-playlist'
  | 'library'
  | 'browse'

export type AppleMusicBrowseKind = 'new-releases' | 'top-charts'

export interface AppleMusicApiRequestPayload {
  action: AppleMusicApiAction
  query?: string
  types?: string[]
  id?: string
  limit?: number
  offset?: number
  browseKind?: AppleMusicBrowseKind
}

export interface AppleMusicApiResponse {
  ok: boolean
  data?: unknown
  error?: { code: string; message: string }
}

export interface AppleMusicOpenSignInResult {
  ok: boolean
  error?: { code: string; message: string }
}

let workerWindow: BrowserWindow | null = null
let workerReadyPromise: Promise<BrowserWindow> | null = null
let signInWindow: BrowserWindow | null = null
let signInInFlight: Promise<AppleMusicOpenSignInResult> | null = null
const authTraceLines: string[] = []
const managedWorkerWindows = new WeakSet<BrowserWindow>()

function summarizeValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NaN'
  if (typeof value === 'string') {
    const normalized = value.trim()
    if (!normalized) return '""'
    if (normalized.length > 120) return `${normalized.slice(0, 120)}...`
    return normalized
  }
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return `[array:${value.length}]`
  if (typeof value === 'object') return '[object]'
  return String(value)
}

function appendAuthTrace(step: string, details?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString()
  const detailText = details
    ? Object.entries(details)
        .map(([key, value]) => `${key}=${summarizeValue(value)}`)
        .join(' ')
    : ''
  const line = detailText.length > 0
    ? `${timestamp} ${step} ${detailText}`
    : `${timestamp} ${step}`
  authTraceLines.push(line)
  if (authTraceLines.length > AUTH_TRACE_MAX_LINES) {
    authTraceLines.splice(0, authTraceLines.length - AUTH_TRACE_MAX_LINES)
  }
}

function collectWindowState(): string {
  const signInState = !signInWindow
    ? 'none'
    : signInWindow.isDestroyed()
      ? 'destroyed'
      : 'alive'
  const workerState = !workerWindow
    ? 'none'
    : workerWindow.isDestroyed()
      ? 'destroyed'
      : 'alive'
  const inFlightState = signInInFlight ? 'yes' : 'no'
  return `signInWindow=${signInState} workerWindow=${workerState} signInInFlight=${inFlightState}`
}

async function collectCookieSnapshotLines(): Promise<string[]> {
  const targetSession = electronSession.fromPartition(APPLE_MUSIC_AUTH_PARTITION)
  const cookies = await targetSession.cookies.get({})
  const targetCookies = cookies.filter((cookie) =>
    cookie.domain.toLowerCase().includes('apple.com'),
  )

  const names = Array.from(new Set(targetCookies.map((cookie) => cookie.name)))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, COOKIE_NAME_SAMPLE_MAX)

  const domains = Array.from(new Set(targetCookies.map((cookie) => cookie.domain)))
    .sort((a, b) => a.localeCompare(b))

  const lines: string[] = []
  lines.push(
    `cookies.total=${cookies.length} cookies.appleDomain=${targetCookies.length} uniqueNames=${names.length} uniqueDomains=${domains.length}`,
  )
  lines.push(`cookies.names=${names.length > 0 ? names.join(', ') : '(none)'}`)
  lines.push(
    `cookies.domains=${domains.length > 0 ? domains.join(', ') : '(none)'}`,
  )
  return lines
}

export async function getAppleMusicDebugReport(): Promise<string> {
  const generatedAt = new Date().toISOString()
  const lines: string[] = []
  lines.push('=== Apple Music Debug Report ===')
  lines.push(`generatedAt=${generatedAt}`)
  lines.push(`authPartition=${APPLE_MUSIC_AUTH_PARTITION}`)
  lines.push(collectWindowState())

  try {
    const status = await invokeAppleMusicApi({ action: 'status' })
    lines.push(`status.ok=${status.ok ? 'true' : 'false'}`)
    if (status.ok && status.data && typeof status.data === 'object') {
      const data = status.data as Record<string, unknown>
      lines.push(`status.isAuthorized=${summarizeValue(data.isAuthorized)}`)
      lines.push(`status.storefrontId=${summarizeValue(data.storefrontId)}`)
      lines.push(
        `status.hasCachedMusicUserToken=${summarizeValue(data.hasCachedMusicUserToken)}`,
      )
    } else if (!status.ok) {
      lines.push(`status.errorCode=${summarizeValue(status.error?.code)}`)
      lines.push(`status.errorMessage=${summarizeValue(status.error?.message)}`)
    }
  } catch (error) {
    lines.push(
      `status.exception=${error instanceof Error ? error.message : String(error)}`,
    )
  }

  try {
    const cookieLines = await collectCookieSnapshotLines()
    lines.push(...cookieLines)
  } catch (error) {
    lines.push(
      `cookies.error=${error instanceof Error ? error.message : String(error)}`,
    )
  }

  lines.push('--- auth-trace ---')
  if (authTraceLines.length === 0) {
    lines.push('(no trace)')
  } else {
    lines.push(...authTraceLines)
  }

  return lines.join('\n')
}

function createWindow(show: boolean): BrowserWindow {
  appendAuthTrace('window.create.start', { show })
  const nextWindow = new BrowserWindow({
    width: AUTH_WINDOW_DEFAULT_WIDTH,
    height: AUTH_WINDOW_DEFAULT_HEIGHT,
    show,
    autoHideMenuBar: true,
    webPreferences: {
      partition: APPLE_MUSIC_AUTH_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })

  nextWindow.webContents.on(
    'console-message',
    (event) => {
      const params = event as unknown as {
        level?: number
        message?: string
        line?: number
        sourceId?: string
      }
      const level = typeof params.level === 'number' ? params.level : 0
      if (level < 2) return
      appendAuthTrace('window.console', {
        level,
        line: typeof params.line === 'number' ? params.line : 0,
        sourceId: typeof params.sourceId === 'string' ? params.sourceId : '',
        message: typeof params.message === 'string' ? params.message : '',
      })
    },
  )

  appendAuthTrace('window.create.done', { show })
  return nextWindow
}

function registerWorkerWindowLifecycle(targetWindow: BrowserWindow): void {
  if (managedWorkerWindows.has(targetWindow)) return
  managedWorkerWindows.add(targetWindow)

  targetWindow.on('closed', () => {
    appendAuthTrace('worker.closed')
    if (workerWindow === targetWindow) {
      workerWindow = null
      workerReadyPromise = null
    }
  })
}

function adoptWindowAsWorker(
  targetWindow: BrowserWindow,
  options?: { keepVisible?: boolean },
): void {
  if (targetWindow.isDestroyed()) return

  appendAuthTrace('worker.adopt.start')
  if (
    workerWindow &&
    workerWindow !== targetWindow &&
    !workerWindow.isDestroyed()
  ) {
    try {
      workerWindow.destroy()
    } catch {
      // ignore races where window got destroyed concurrently
    }
  }

  workerWindow = targetWindow
  workerReadyPromise = Promise.resolve(targetWindow)
  registerWorkerWindowLifecycle(targetWindow)

  if (!options?.keepVisible) {
    try {
      if (targetWindow.isVisible()) {
        targetWindow.hide()
      }
    } catch {
      // ignore visibility races
    }
  }

  appendAuthTrace('worker.adopt.done', { keepVisible: options?.keepVisible })
}

function waitForWindowLoad(targetWindow: BrowserWindow): Promise<BrowserWindow> {
  return new Promise<BrowserWindow>((resolve, reject) => {
    let webContents: BrowserWindow['webContents']
    try {
      webContents = targetWindow.webContents
    } catch (error) {
      reject(
        error instanceof Error
          ? error
          : new Error('Failed to access Apple Music window webContents.'),
      )
      return
    }

    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (settled) return
      settled = true
      timeout = null
      reject(new Error('Timed out loading music.apple.com.'))
    }, WINDOW_LOAD_TIMEOUT_MS)

    const cleanup = () => {
      try {
        webContents.removeListener('did-finish-load', onFinishLoad)
        webContents.removeListener('did-fail-load', onFailLoad)
      } catch {
        // ignore destroyed webContents race
      }
      try {
        targetWindow.removeListener('closed', onClosed)
      } catch {
        // ignore destroyed window race
      }
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
    }

    const onFinishLoad = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(targetWindow)
    }

    const onFailLoad = (
      _event: unknown,
      _errorCode: number,
      errorDescription: string,
      _validatedUrl: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame || settled) return
      settled = true
      cleanup()
      reject(
        new Error(
          errorDescription?.trim() || 'Failed to load music.apple.com.',
        ),
      )
    }

    const onClosed = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('Apple Music window was closed before load finished.'))
    }

    try {
      webContents.once('did-finish-load', onFinishLoad)
      webContents.once('did-fail-load', onFailLoad)
      targetWindow.once('closed', onClosed)
    } catch (error) {
      settled = true
      cleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }

    try {
      void targetWindow.loadURL(APPLE_MUSIC_URL).catch((error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      })
    } catch (error) {
      if (settled) return
      settled = true
      cleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

async function ensureWorkerWindow(): Promise<BrowserWindow> {
  if (workerWindow && !workerWindow.isDestroyed()) {
    appendAuthTrace('worker.reuse')
    return workerWindow
  }

  if (workerReadyPromise) {
    return workerReadyPromise
  }

  const nextWorker = createWindow(false)
  workerWindow = nextWorker
  appendAuthTrace('worker.create')
  registerWorkerWindowLifecycle(nextWorker)

  workerReadyPromise = waitForWindowLoad(nextWorker)
    .then((loadedWindow) => loadedWindow)
    .finally(() => {
      workerReadyPromise = null
    })
  void workerReadyPromise.catch(() => {
    // avoid noisy unhandled rejection when worker is reset during load
  })

  return workerReadyPromise
}

function resetWorkerWindow(): void {
  appendAuthTrace('worker.reset.start')
  if (workerWindow && !workerWindow.isDestroyed()) {
    try {
      workerWindow.destroy()
    } catch {
      // ignore races where window got destroyed concurrently
    }
  }
  workerWindow = null
  workerReadyPromise = null
  appendAuthTrace('worker.reset.done')
}

function readIsAuthorized(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return Boolean(record.isAuthorized)
}

async function isAppleMusicSessionAuthorized(): Promise<boolean> {
  appendAuthTrace('session.authorized.check.start')
  const result = await invokeAppleMusicApi({ action: 'status' })
  if (!result.ok) {
    appendAuthTrace('session.authorized.check.failed', {
      code: result.error?.code,
      message: result.error?.message,
    })
    return false
  }
  const authorized = readIsAuthorized(result.data)
  appendAuthTrace('session.authorized.check.done', { authorized })
  return authorized
}

async function isWindowAuthorized(targetWindow: BrowserWindow): Promise<boolean> {
  if (targetWindow.isDestroyed()) return false

  appendAuthTrace('window.authorized.check.start')
  try {
    const result = await targetWindow.webContents.executeJavaScript(
      `
        (async () => {
          try {
            const instance = window.MusicKit?.getInstance?.();
            const api = instance?.api;
            if (!api || typeof api.music !== 'function') return false;

            await api.music('/v1/me/storefront');
            return true;
          } catch {
            return false;
          }
        })()
      `,
      true,
    )
    const authorized = Boolean(result)
    appendAuthTrace('window.authorized.check.done', { authorized })
    return authorized
  } catch {
    appendAuthTrace('window.authorized.check.error')
    return false
  }
}

function readWindowUrl(targetWindow: BrowserWindow): string {
  if (targetWindow.isDestroyed()) return 'destroyed'
  try {
    return targetWindow.webContents.getURL() || '(empty)'
  } catch {
    return '(unavailable)'
  }
}

function isWindowLoadingMainFrame(targetWindow: BrowserWindow): boolean {
  if (targetWindow.isDestroyed()) return false
  try {
    return targetWindow.webContents.isLoadingMainFrame()
  } catch {
    return false
  }
}

function normalizeStorefrontId(value: unknown): string {
  if (typeof value !== 'string') return 'us'
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : 'us'
}

async function readWindowStatusDetails(targetWindow: BrowserWindow): Promise<{
  storefrontId: string
  hasCachedMusicUserToken: boolean
}> {
  if (targetWindow.isDestroyed()) {
    return {
      storefrontId: 'us',
      hasCachedMusicUserToken: false,
    }
  }

  try {
    const raw = await targetWindow.webContents.executeJavaScript(
      `
        (() => {
          try {
            const globalMusicKit = window.MusicKit;
            const instance =
              globalMusicKit && typeof globalMusicKit.getInstance === 'function'
                ? globalMusicKit.getInstance()
                : null;
            const storefront =
              instance && typeof instance.storefrontId === 'string'
                ? instance.storefrontId
                : '';
            return {
              storefrontId: typeof storefront === 'string' ? storefront.trim() : '',
              hasCachedMusicUserToken: Boolean(instance && instance.musicUserToken),
            };
          } catch {
            return {
              storefrontId: '',
              hasCachedMusicUserToken: false,
            };
          }
        })()
      `,
      true,
    )

    const record =
      raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
    return {
      storefrontId: normalizeStorefrontId(record?.storefrontId),
      hasCachedMusicUserToken: Boolean(record?.hasCachedMusicUserToken),
    }
  } catch (error) {
    appendAuthTrace('status.window.details.error', {
      message: error instanceof Error ? error.message : String(error),
    })
    return {
      storefrontId: 'us',
      hasCachedMusicUserToken: false,
    }
  }
}

async function tryStatusFromWindow(
  targetWindow: BrowserWindow,
  source: string,
): Promise<AppleMusicApiResponse | null> {
  if (targetWindow.isDestroyed()) return null

  appendAuthTrace('status.window.try.start', {
    source,
    url: readWindowUrl(targetWindow),
    loadingMainFrame: isWindowLoadingMainFrame(targetWindow),
  })

  let authorized = await isWindowAuthorized(targetWindow)

  if (!authorized && isWindowLoadingMainFrame(targetWindow)) {
    appendAuthTrace('status.window.try.waitForLoad.start', { source })
    try {
      await waitForWindowReadyToRunScript(targetWindow)
      appendAuthTrace('status.window.try.waitForLoad.done', { source })
    } catch (error) {
      appendAuthTrace('status.window.try.waitForLoad.error', {
        source,
        message: error instanceof Error ? error.message : String(error),
      })
    }

    if (!targetWindow.isDestroyed()) {
      authorized = await isWindowAuthorized(targetWindow)
    }
  }

  appendAuthTrace('status.window.try.done', { source, authorized })

  if (!authorized) return null

  const statusDetails = await readWindowStatusDetails(targetWindow)
  appendAuthTrace('status.window.try.details', { source, ...statusDetails })
  return {
    ok: true,
    data: {
      isAuthorized: true,
      storefrontId: statusDetails.storefrontId,
      hasCachedMusicUserToken: statusDetails.hasCachedMusicUserToken,
    },
  }
}

async function invokeStatusFromWindowState(): Promise<AppleMusicApiResponse> {
  const checkedWindows = new Set<BrowserWindow>()
  const tryCandidate = async (
    candidate: BrowserWindow | null,
    source: string,
  ): Promise<AppleMusicApiResponse | null> => {
    if (!candidate || candidate.isDestroyed()) return null
    if (checkedWindows.has(candidate)) return null
    checkedWindows.add(candidate)
    return tryStatusFromWindow(candidate, source)
  }

  const fromSignIn = await tryCandidate(signInWindow, 'signInWindow')
  if (fromSignIn) return fromSignIn

  const fromWorker = await tryCandidate(workerWindow, 'workerWindow')
  if (fromWorker) return fromWorker

  try {
    const ensuredWindow = await ensureWorkerWindow()
    const fromEnsuredWorker = await tryCandidate(ensuredWindow, 'ensuredWorker')
    if (fromEnsuredWorker) return fromEnsuredWorker
  } catch (error) {
    appendAuthTrace('status.window.ensure.error', {
      message: error instanceof Error ? error.message : String(error),
    })
  }

  appendAuthTrace('status.window.noAuthorizedWindow')
  return {
    ok: true,
    data: {
      isAuthorized: false,
      storefrontId: 'us',
      hasCachedMusicUserToken: false,
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timeoutId = setTimeout(() => {
      if (settled) return
      settled = true
      appendAuthTrace('timeout', { message: timeoutMessage, timeoutMs })
      reject(new Error(timeoutMessage))
    }, timeoutMs)

    void promise
      .then((value) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        resolve(value)
      })
      .catch((error) => {
        if (settled) return
        settled = true
        clearTimeout(timeoutId)
        reject(error)
      })
  })
}

async function waitForSessionAuthorization(maxAttempts: number): Promise<boolean> {
  for (
    let attempt = 0;
    attempt < maxAttempts;
    attempt += 1
  ) {
    appendAuthTrace('session.authorized.retry.attempt', {
      attempt: attempt + 1,
      maxAttempts,
    })
    try {
      const authorized = await withTimeout(
        isAppleMusicSessionAuthorized(),
        SESSION_AUTH_CHECK_TIMEOUT_MS,
        'Timed out waiting for Apple Music session authorization check.',
      )
      if (authorized) return true
    } catch {
      appendAuthTrace('session.authorized.retry.error', { attempt: attempt + 1 })
      // transient worker races can happen right after sign-in close; keep retrying
    }
    if (attempt < maxAttempts - 1) {
      await sleep(500)
    }
  }

  return false
}

function isRetryableWorkerError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : ''

  const normalized = message.toLowerCase()

  return (
    normalized.includes('window was closed before load finished') ||
    normalized.includes('worker window was closed during load') ||
    normalized.includes('object has been destroyed') ||
    normalized.includes('webcontents was destroyed') ||
    normalized.includes('script failed to execute')
  )
}

async function runSignInWindowFlow(): Promise<AppleMusicOpenSignInResult> {
  appendAuthTrace('signin.flow.start')
  try {
    if (!signInWindow || signInWindow.isDestroyed()) {
      const nextWindow = createWindow(true)
      signInWindow = nextWindow
      appendAuthTrace('signin.window.created')
      signInWindow.on('closed', () => {
        appendAuthTrace('signin.window.closed')
        if (signInWindow === nextWindow) {
          signInWindow = null
        }
      })
      await waitForWindowLoad(nextWindow)
      appendAuthTrace('signin.window.loaded')
    }

    if (!signInWindow || signInWindow.isDestroyed()) {
      return {
        ok: false,
        error: {
          code: 'unknown',
          message: 'Apple Music サインインウィンドウの作成に失敗しました。',
        },
      }
    }

    signInWindow.show()
    signInWindow.focus()
    appendAuthTrace('signin.window.shown')
  } catch (error) {
    appendAuthTrace('signin.flow.error', {
      message: error instanceof Error ? error.message : String(error),
    })
    return {
      ok: false,
      error: {
        code: 'load-failed',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }

  appendAuthTrace('signin.flow.precheck.skipped')

  return new Promise<AppleMusicOpenSignInResult>((resolve) => {
    const currentWindow = signInWindow
    if (!currentWindow || currentWindow.isDestroyed()) {
      resolve({
        ok: false,
        error: {
          code: 'unknown',
          message: 'Apple Music サインインウィンドウが見つかりません。',
        },
      })
      return
    }

    let settled = false
    let checking = false
    let authorizedSeenInWindow = false
    let intervalId: ReturnType<typeof setInterval> | null = null
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const finalize = (result: AppleMusicOpenSignInResult) => {
      if (settled) return
      settled = true
      appendAuthTrace('signin.flow.finalize', {
        ok: result.ok,
        code: result.error?.code,
      })

      if (intervalId) {
        clearInterval(intervalId)
        intervalId = null
      }
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }

      currentWindow.removeListener('closed', onClosed)
      resolve(result)
    }

    const onClosed = () => {
      if (signInWindow === currentWindow) {
        signInWindow = null
      }
      if (settled) return

      if (authorizedSeenInWindow) {
        appendAuthTrace('signin.window.closed.authorizedFromWindow')
        finalize({ ok: true })
        return
      }

      void waitForSessionAuthorization(10)
        .then((authorized) => {
          appendAuthTrace('signin.window.closed.authorizedCheck.done', { authorized })
          if (authorized) {
            finalize({ ok: true })
            return
          }
          finalize({
            ok: false,
            error: {
              code: 'cancelled',
              message: 'Apple Music サインインがキャンセルされました。',
            },
          })
        })
        .catch(() => {
          appendAuthTrace('signin.window.closed.authorizedCheck.error')
          finalize({
            ok: false,
            error: {
              code: 'cancelled',
              message: 'Apple Music サインインがキャンセルされました。',
            },
          })
        })
    }

    currentWindow.on('closed', onClosed)

    const checkAuthorization = async () => {
      if (settled || checking) return
      checking = true
      appendAuthTrace('signin.poll.check.start')
      try {
        const authorizedInSignInWindow = await isWindowAuthorized(currentWindow)
        if (authorizedInSignInWindow) {
          appendAuthTrace('signin.poll.authorizedByWindow')
          authorizedSeenInWindow = true
          adoptWindowAsWorker(currentWindow, { keepVisible: true })
          appendAuthTrace('signin.poll.authorizedCooldown.start')
          await sleep(1000)
          appendAuthTrace('signin.poll.authorizedCooldown.end')
          finalize({ ok: true })
          return
        }

        appendAuthTrace('signin.poll.notAuthorized')
      } catch {
        appendAuthTrace('signin.poll.check.error')
        // keep polling until timeout/close
      } finally {
        checking = false
        appendAuthTrace('signin.poll.check.end')
      }
    }

    intervalId = setInterval(() => {
      void checkAuthorization()
    }, SIGN_IN_POLL_INTERVAL_MS)
    void checkAuthorization()

    timeoutId = setTimeout(() => {
      finalize({
        ok: false,
        error: {
          code: 'timeout',
          message: 'Apple Music サインインがタイムアウトしました。',
        },
      })
      if (!currentWindow.isDestroyed()) {
        currentWindow.close()
      }
    }, SIGN_IN_TIMEOUT_MS)
  })
}

export async function openAppleMusicSignInWindow(): Promise<AppleMusicOpenSignInResult> {
  if (signInInFlight) {
    appendAuthTrace('signin.flow.reuseInFlight')
    return signInInFlight
  }

  appendAuthTrace('signin.flow.enqueue')
  signInInFlight = runSignInWindowFlow().finally(() => {
    appendAuthTrace('signin.flow.clearInFlight')
    signInInFlight = null
  })

  return signInInFlight
}

function buildLibraryApiScript(payload: AppleMusicApiRequestPayload): string {
  const serializedPayload = JSON.stringify(payload)

  return `
    (async () => {
      const payload = ${serializedPayload};
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const ensureMusicKitInstance = async () => {
        for (let i = 0; i < 80; i += 1) {
          try {
            const globalMusicKit = window.MusicKit;
            const instance = globalMusicKit && typeof globalMusicKit.getInstance === 'function'
              ? globalMusicKit.getInstance()
              : null;
            if (instance && instance.api) return instance;
          } catch {}
          await wait(250);
        }
        throw new Error('MusicKit instance is not ready in music.apple.com session.');
      };

      const normalizePositiveInteger = (value, fallback, max) => {
        const normalized = Number(value);
        if (!Number.isFinite(normalized)) return fallback;
        const floored = Math.floor(normalized);
        if (floored <= 0) return fallback;
        return Math.min(floored, max);
      };

      const toObjectArray = (value) =>
        Array.isArray(value)
          ? value.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
          : [];

      const extractResourceArray = (root) => {
        if (!root || typeof root !== 'object') return [];

        const directData = toObjectArray(root.data);
        if (Array.isArray(root.data)) {
          return directData;
        }

        const queue = Object.values(root);
        const seen = new Set();
        while (queue.length > 0) {
          const current = queue.shift();
          if (!current || typeof current !== 'object') continue;
          if (seen.has(current)) continue;
          seen.add(current);

          const currentData = toObjectArray(current.data);
          if (Array.isArray(current.data)) {
            return currentData;
          }

          for (const nested of Object.values(current)) {
            if (nested && typeof nested === 'object') {
              queue.push(nested);
            }
          }
        }

        return [];
      };

      const parseNextOffset = (root, fallbackOffset, fallbackLimit, itemCount) => {
        if (root && typeof root === 'object') {
          const nextValue = typeof root.next === 'string' ? root.next : null;
          if (nextValue) {
            try {
              const parsed = new URL(nextValue, 'https://music.apple.com');
              const offsetRaw = parsed.searchParams.get('offset');
              const offset = Number(offsetRaw);
              if (Number.isFinite(offset) && offset >= 0) {
                return Math.floor(offset);
              }
            } catch {}
          }
        }

        if (itemCount >= fallbackLimit) {
          return fallbackOffset + fallbackLimit;
        }
        return null;
      };

      try {
        const instance = await ensureMusicKitInstance();
        const api = instance.api;
        const limit = normalizePositiveInteger(payload.limit, 25, 100);
        const rawOffset = Number(payload.offset);
        const offset =
          Number.isFinite(rawOffset) && rawOffset >= 0
            ? Math.floor(rawOffset)
            : 0;

        const [songsRaw, albumsRaw, playlistsRaw] = await Promise.all([
          api.music('/v1/me/library/songs', { limit, offset }),
          api.music('/v1/me/library/albums', { limit, offset }),
          api.music('/v1/me/library/playlists', { limit, offset }),
        ]);

        const songs = extractResourceArray(songsRaw);
        const albums = extractResourceArray(albumsRaw);
        const playlists = extractResourceArray(playlistsRaw);
        const songsNextOffset = parseNextOffset(songsRaw, offset, limit, songs.length);
        const albumsNextOffset = parseNextOffset(albumsRaw, offset, limit, albums.length);
        const playlistsNextOffset = parseNextOffset(playlistsRaw, offset, limit, playlists.length);
        const nextOffsetCandidates = [songsNextOffset, albumsNextOffset, playlistsNextOffset]
          .filter((value) => Number.isFinite(value));
        const nextOffset = nextOffsetCandidates.length > 0
          ? Math.max(...nextOffsetCandidates)
          : null;

        return {
          ok: true,
          data: {
            limit,
            offset,
            nextOffset,
            songsNextOffset,
            albumsNextOffset,
            playlistsNextOffset,
            songs,
            albums,
            playlists,
            songsRaw,
            albumsRaw,
            playlistsRaw,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error: {
            code: 'api-failed',
            message,
          },
        };
      }
    })();
  `
}

function buildSearchApiScript(payload: AppleMusicApiRequestPayload): string {
  const serializedPayload = JSON.stringify(payload)

  return `
    (async () => {
      const payload = ${serializedPayload};
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const ensureMusicKitInstance = async () => {
        for (let i = 0; i < 80; i += 1) {
          try {
            const globalMusicKit = window.MusicKit;
            const instance = globalMusicKit && typeof globalMusicKit.getInstance === 'function'
              ? globalMusicKit.getInstance()
              : null;
            if (instance && instance.api) return instance;
          } catch {}
          await wait(250);
        }
        throw new Error('MusicKit instance is not ready in music.apple.com session.');
      };

      const normalizePositiveInteger = (value, fallback, max) => {
        const normalized = Number(value);
        if (!Number.isFinite(normalized)) return fallback;
        const floored = Math.floor(normalized);
        if (floored <= 0) return fallback;
        return Math.min(floored, max);
      };

      const toObjectArray = (value) =>
        Array.isArray(value)
          ? value.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
          : [];

      const EMPTY_SEARCH_DATA = {
        songs: { data: [] },
        albums: { data: [] },
        playlists: { data: [] },
      };

      const readSectionRoot = (root, key) => {
        if (!root || typeof root !== 'object') return null;
        const direct = root[key];
        if (Array.isArray(direct)) return direct;
        if (direct && typeof direct === 'object') return direct;
        const results = root.results;
        if (!results || typeof results !== 'object') return null;
        const nested = results[key];
        if (Array.isArray(nested)) return nested;
        return nested && typeof nested === 'object' ? nested : null;
      };

      const extractResourceArray = (root) => {
        if (Array.isArray(root)) return toObjectArray(root);
        if (!root || typeof root !== 'object') return [];

        const directData = toObjectArray(root.data);
        if (Array.isArray(root.data)) {
          return directData;
        }

        const queue = Object.values(root);
        const seen = new Set();
        while (queue.length > 0) {
          const current = queue.shift();
          if (!current || typeof current !== 'object') continue;
          if (seen.has(current)) continue;
          seen.add(current);

          if (Array.isArray(current)) {
            const currentArray = toObjectArray(current);
            if (currentArray.length > 0) {
              return currentArray;
            }
            continue;
          }

          const currentData = toObjectArray(current.data);
          if (Array.isArray(current.data)) {
            return currentData;
          }

          for (const nested of Object.values(current)) {
            if (nested && typeof nested === 'object') {
              queue.push(nested);
            }
          }
        }

        return [];
      };

      const readSectionData = (root, key) => {
        const sectionRoot = readSectionRoot(root, key);
        const sectionData = extractResourceArray(sectionRoot);
        if (sectionData.length > 0) return sectionData;

        const normalizeTypeName = (value) =>
          typeof value === 'string' ? value.trim().toLowerCase() : '';
        const singularKey = key.endsWith('s') ? key.slice(0, -1) : key;
        const matchTypeKey = (typeName) => {
          const normalizedType = normalizeTypeName(typeName);
          if (!normalizedType) return false;
          if (normalizedType === key || normalizedType === singularKey) return true;
          if (normalizedType.endsWith('-' + key) || normalizedType.endsWith('-' + singularKey)) {
            return true;
          }
          if (normalizedType.endsWith('/' + key) || normalizedType.endsWith('/' + singularKey)) {
            return true;
          }
          return normalizedType.includes(singularKey);
        };
        const classifyByUrl = (urlValue) => {
          const normalizedUrl = normalizeTypeName(urlValue);
          if (!normalizedUrl) return '';
          if (normalizedUrl.includes('/playlist/')) return 'playlists';
          if (normalizedUrl.includes('/album/')) return 'albums';
          if (normalizedUrl.includes('/song/')) return 'songs';
          return '';
        };

        const allData = extractResourceArray(root);
        return allData.filter((entry) => {
          const type = typeof entry.type === 'string' ? entry.type : '';
          if (matchTypeKey(type)) return true;

          const attributes =
            entry.attributes && typeof entry.attributes === 'object'
              ? entry.attributes
              : null;
          const playParams =
            attributes &&
            attributes.playParams &&
            typeof attributes.playParams === 'object'
              ? attributes.playParams
              : null;
          const inferredType =
            classifyByUrl(attributes ? attributes.url : '') ||
            (playParams && matchTypeKey(playParams.kind) ? key : '');
          return inferredType === key;
        });
      };

      const normalizeSearchResult = (root) => ({
        songs: { data: readSectionData(root, 'songs') },
        albums: { data: readSectionData(root, 'albums') },
        playlists: { data: readSectionData(root, 'playlists') },
      });

      const hasAnyNormalizedResult = (normalized) =>
        Boolean(
          normalized &&
            normalized.songs &&
            normalized.albums &&
            normalized.playlists &&
            Array.isArray(normalized.songs.data) &&
            Array.isArray(normalized.albums.data) &&
            Array.isArray(normalized.playlists.data) &&
            (normalized.songs.data.length > 0 ||
              normalized.albums.data.length > 0 ||
              normalized.playlists.data.length > 0),
        );

      const hasAnySearchResult = (root) => {
        const normalized = normalizeSearchResult(root);
        return hasAnyNormalizedResult(normalized);
      };

      try {
        const instance = await ensureMusicKitInstance();
        const api = instance.api;
        const storefrontId = instance.storefrontId || 'us';
        const query = String(payload.query || '').trim();
        const limit = normalizePositiveInteger(payload.limit, 25, 50);
        const types = Array.isArray(payload.types)
          ? payload.types.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
          : [];

        if (!query) {
          return {
            ok: true,
            data: {
              songs: EMPTY_SEARCH_DATA.songs,
              albums: EMPTY_SEARCH_DATA.albums,
              playlists: EMPTY_SEARCH_DATA.playlists,
              _source: 'empty',
            },
          };
        }

        const normalizedTypes = types.length > 0 ? types : ['songs', 'albums', 'playlists'];
        const searchTypeCsv = normalizedTypes.join(',');
        let raw = null;
        let rawSource = 'none';
        const sourceParts = [];

        if (typeof api.search === 'function') {
          try {
            raw = await api.search(query, { types: normalizedTypes, limit });
            rawSource = 'api.search.types-array';
          } catch {}
          if (!hasAnySearchResult(raw)) {
            try {
              raw = await api.search(query, { types: searchTypeCsv, limit });
              rawSource = 'api.search.types-csv';
            } catch {}
          }
          if (!hasAnySearchResult(raw)) {
            try {
              raw = await api.search(query, { limit });
              rawSource = 'api.search.limit-only';
            } catch {}
          }
        }

        if (!hasAnySearchResult(raw)) {
          try {
            raw = await api.music('/v1/catalog/' + storefrontId + '/search', {
              term: query,
              types: normalizedTypes,
              limit,
            });
            rawSource = 'api.music.types-array';
          } catch {}
        }

        if (!hasAnySearchResult(raw)) {
          try {
            raw = await api.music('/v1/catalog/' + storefrontId + '/search', {
              term: query,
              types: searchTypeCsv,
              limit,
            });
            rawSource = 'api.music.types-csv';
          } catch {}
        }

        const dedupeResources = (items) => {
          const next = [];
          const seen = new Set();
          const list = Array.isArray(items) ? items : [];
          for (const item of list) {
            if (!item || typeof item !== 'object') continue;
            const id = typeof item.id === 'string' ? item.id : '';
            const type = typeof item.type === 'string' ? item.type : '';
            const attributes =
              item.attributes && typeof item.attributes === 'object'
                ? item.attributes
                : null;
            const name = attributes && typeof attributes.name === 'string' ? attributes.name : '';
            const key = type + ':' + id + ':' + name;
            if (seen.has(key)) continue;
            seen.add(key);
            next.push(item);
          }
          return next;
        };
        const fetchSingleType = async (typeKey) => {
          let candidate = null;
          let source = '';
          if (typeof api.search === 'function') {
            try {
              candidate = await api.search(query, { types: [typeKey], limit });
              source = 'api.search.single-array';
            } catch {}
            let section = readSectionData(candidate, typeKey);
            if (section.length > 0) return { data: section, source };

            try {
              candidate = await api.search(query, { types: typeKey, limit });
              source = 'api.search.single-csv';
            } catch {}
            section = readSectionData(candidate, typeKey);
            if (section.length > 0) return { data: section, source };
          }

          try {
            candidate = await api.music('/v1/catalog/' + storefrontId + '/search', {
              term: query,
              types: [typeKey],
              limit,
            });
            source = 'api.music.single-array';
          } catch {}
          let section = readSectionData(candidate, typeKey);
          if (section.length > 0) return { data: section, source };

          try {
            candidate = await api.music('/v1/catalog/' + storefrontId + '/search', {
              term: query,
              types: typeKey,
              limit,
            });
            source = 'api.music.single-csv';
          } catch {}
          section = readSectionData(candidate, typeKey);
          if (section.length > 0) return { data: section, source };

          return { data: [], source: '' };
        };

        if (rawSource !== 'none') {
          sourceParts.push(rawSource);
        }
        const normalized = normalizeSearchResult(raw);
        const requestedTypeSet = new Set(normalizedTypes);
        const sectionKeys = ['songs', 'albums', 'playlists'];
        for (const sectionKey of sectionKeys) {
          if (!requestedTypeSet.has(sectionKey)) continue;
          const currentSection = normalized[sectionKey];
          if (!currentSection || !Array.isArray(currentSection.data)) continue;
          if (currentSection.data.length > 0) continue;

          const singleTypeResult = await fetchSingleType(sectionKey);
          if (singleTypeResult.data.length === 0) continue;

          normalized[sectionKey] = {
            data: dedupeResources(singleTypeResult.data),
          };
          if (singleTypeResult.source) {
            sourceParts.push(sectionKey + ':' + singleTypeResult.source);
          }
        }

        if (hasAnyNormalizedResult(normalized)) {
          return {
            ok: true,
            data: {
              songs: normalized.songs,
              albums: normalized.albums,
              playlists: normalized.playlists,
              _source: sourceParts.join('+') || 'api',
            },
          };
        }

        return {
          ok: true,
          data: {
            songs: EMPTY_SEARCH_DATA.songs,
            albums: EMPTY_SEARCH_DATA.albums,
            playlists: EMPTY_SEARCH_DATA.playlists,
            _source: 'empty',
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error: {
            code: 'api-failed',
            message,
          },
        };
      }
    })();
  `
}

function buildCatalogAlbumApiScript(payload: AppleMusicApiRequestPayload): string {
  const serializedPayload = JSON.stringify(payload)

  return `
    (async () => {
      const payload = ${serializedPayload};
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const ensureMusicKitInstance = async () => {
        for (let i = 0; i < 80; i += 1) {
          try {
            const globalMusicKit = window.MusicKit;
            const instance = globalMusicKit && typeof globalMusicKit.getInstance === 'function'
              ? globalMusicKit.getInstance()
              : null;
            if (instance && instance.api) return instance;
          } catch {}
          await wait(250);
        }
        throw new Error('MusicKit instance is not ready in music.apple.com session.');
      };

      const toObjectArray = (value) =>
        Array.isArray(value)
          ? value.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
          : [];

      const readFirstResource = (root) => {
        if (!root || typeof root !== 'object') return null;
        const data = toObjectArray(root.data);
        if (data.length > 0) return data[0];
        const results = root.results;
        if (!results || typeof results !== 'object') return null;
        const nestedData = toObjectArray(results.data);
        return nestedData.length > 0 ? nestedData[0] : null;
      };

      const readTracks = (resource) => {
        if (!resource || typeof resource !== 'object') return [];
        const relationships =
          resource.relationships && typeof resource.relationships === 'object'
            ? resource.relationships
            : null;
        const tracks =
          relationships &&
          relationships.tracks &&
          typeof relationships.tracks === 'object'
            ? relationships.tracks
            : null;
        return toObjectArray(tracks && tracks.data);
      };

      const upsertTracks = (root, tracksData) => {
        if (!root || typeof root !== 'object') return false;
        if (!Array.isArray(tracksData) || tracksData.length === 0) return false;
        const resource = readFirstResource(root);
        if (!resource || typeof resource !== 'object') return false;

        if (!resource.relationships || typeof resource.relationships !== 'object') {
          resource.relationships = {};
        }
        if (
          !resource.relationships.tracks ||
          typeof resource.relationships.tracks !== 'object'
        ) {
          resource.relationships.tracks = {};
        }
        resource.relationships.tracks.data = tracksData;
        return true;
      };

      const readNextOffset = (root) => {
        if (!root || typeof root !== 'object') return null;
        const nextValue = typeof root.next === 'string' ? root.next : '';
        if (!nextValue) return null;
        try {
          const parsed = new URL(nextValue, 'https://music.apple.com');
          const offsetRaw = parsed.searchParams.get('offset');
          const offset = Number(offsetRaw);
          if (Number.isFinite(offset) && offset >= 0) {
            return Math.floor(offset);
          }
        } catch {}
        return null;
      };

      const fetchAllTracks = async (api, path) => {
        const merged = [];
        const seen = new Set();
        let offset = 0;

        for (let i = 0; i < 20; i += 1) {
          const pageRaw = await api.music(path + '/tracks', {
            limit: 100,
            offset,
          });
          const page = toObjectArray(pageRaw && pageRaw.data);
          for (const track of page) {
            const id = typeof track.id === 'string' ? track.id : '';
            const type = typeof track.type === 'string' ? track.type : '';
            const key = id + ':' + type;
            if (key && seen.has(key)) continue;
            if (key) seen.add(key);
            merged.push(track);
          }

          const nextOffset = readNextOffset(pageRaw);
          if (nextOffset === null) {
            if (page.length < 100) break;
            offset += 100;
          } else {
            if (nextOffset <= offset) break;
            offset = nextOffset;
          }
        }

        return merged;
      };

      const fetchSongsByAlbumFilter = async (api, storefrontId, id) => {
        const merged = [];
        const seen = new Set();
        let offset = 0;

        for (let i = 0; i < 20; i += 1) {
          const pageRaw = await api.music('/v1/catalog/' + storefrontId + '/songs', {
            'filter[albums]': id,
            limit: 100,
            offset,
          });
          const page = toObjectArray(pageRaw && pageRaw.data);
          for (const song of page) {
            const songId = typeof song.id === 'string' ? song.id : '';
            const songType = typeof song.type === 'string' ? song.type : '';
            const key = songId + ':' + songType;
            if (key && seen.has(key)) continue;
            if (key) seen.add(key);
            merged.push(song);
          }

          const nextOffset = readNextOffset(pageRaw);
          if (nextOffset === null) {
            if (page.length < 100) break;
            offset += 100;
          } else {
            if (nextOffset <= offset) break;
            offset = nextOffset;
          }
        }

        return merged;
      };

      try {
        const instance = await ensureMusicKitInstance();
        const api = instance.api;
        const storefrontId = instance.storefrontId || 'us';
        const id = String(payload.id || '').trim();
        if (!id) throw new Error('album id is required.');

        const catalogPath = '/v1/catalog/' + storefrontId + '/albums/' + id;

        let catalogRaw = null;
        try {
          catalogRaw = await api.music(catalogPath, { include: 'tracks' });
        } catch {}

        const catalogWithIncludeTracks = readTracks(readFirstResource(catalogRaw));
        if (catalogRaw && catalogWithIncludeTracks.length > 0) {
          return { ok: true, data: catalogRaw };
        }

        if (!catalogRaw) {
          try {
            catalogRaw = await api.music(catalogPath);
          } catch {}
        }

        if (catalogRaw) {
          try {
            const tracks = await fetchAllTracks(api, catalogPath);
            if (tracks.length > 0) {
              upsertTracks(catalogRaw, tracks);
            }
          } catch {}
          const catalogTracksAfterFallback = readTracks(readFirstResource(catalogRaw));
          if (catalogTracksAfterFallback.length > 0) {
            return { ok: true, data: catalogRaw };
          }
        }

        const libraryPath = '/v1/me/library/albums/' + id;
        let libraryRaw = null;
        try {
          libraryRaw = await api.music(libraryPath, { include: 'tracks,catalog' });
        } catch {}

        const libraryWithIncludeTracks = readTracks(readFirstResource(libraryRaw));
        if (libraryRaw && libraryWithIncludeTracks.length > 0) {
          return { ok: true, data: libraryRaw };
        }

        if (libraryRaw) {
          try {
            const tracks = await fetchAllTracks(api, libraryPath);
            if (tracks.length > 0) {
              upsertTracks(libraryRaw, tracks);
            }
          } catch {}
          const libraryTracksAfterFallback = readTracks(readFirstResource(libraryRaw));
          if (libraryTracksAfterFallback.length > 0) {
            return { ok: true, data: libraryRaw };
          }
        }

        try {
          const songsByFilter = await fetchSongsByAlbumFilter(
            api,
            storefrontId,
            id,
          );
          if (songsByFilter.length > 0) {
            if (catalogRaw) {
              upsertTracks(catalogRaw, songsByFilter);
              return { ok: true, data: catalogRaw };
            }
            if (libraryRaw) {
              upsertTracks(libraryRaw, songsByFilter);
              return { ok: true, data: libraryRaw };
            }
          }
        } catch {}

        if (catalogRaw && readFirstResource(catalogRaw)) {
          return { ok: true, data: catalogRaw };
        }
        if (libraryRaw && readFirstResource(libraryRaw)) {
          return { ok: true, data: libraryRaw };
        }

        throw new Error('Album not found in catalog/library.');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error: {
            code: 'api-failed',
            message,
          },
        };
      }
    })();
  `
}

function buildCatalogPlaylistApiScript(payload: AppleMusicApiRequestPayload): string {
  const serializedPayload = JSON.stringify(payload)

  return `
    (async () => {
      const payload = ${serializedPayload};
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const ensureMusicKitInstance = async () => {
        for (let i = 0; i < 80; i += 1) {
          try {
            const globalMusicKit = window.MusicKit;
            const instance = globalMusicKit && typeof globalMusicKit.getInstance === 'function'
              ? globalMusicKit.getInstance()
              : null;
            if (instance && instance.api) return instance;
          } catch {}
          await wait(250);
        }
        throw new Error('MusicKit instance is not ready in music.apple.com session.');
      };

      try {
        const instance = await ensureMusicKitInstance();
        const api = instance.api;
        const storefrontId = instance.storefrontId || 'us';
        const id = String(payload.id || '').trim();
        if (!id) throw new Error('playlist id is required.');

        const raw = await api.music('/v1/catalog/' + storefrontId + '/playlists/' + id, {
          include: 'tracks',
        });
        return { ok: true, data: raw };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error: {
            code: 'api-failed',
            message,
          },
        };
      }
    })();
  `
}

function buildBrowseApiScript(payload: AppleMusicApiRequestPayload): string {
  const serializedPayload = JSON.stringify(payload)

  return `
    (async () => {
      const payload = ${serializedPayload};
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const ensureMusicKitInstance = async () => {
        for (let i = 0; i < 80; i += 1) {
          try {
            const globalMusicKit = window.MusicKit;
            const instance = globalMusicKit && typeof globalMusicKit.getInstance === 'function'
              ? globalMusicKit.getInstance()
              : null;
            if (instance && instance.api) return instance;
          } catch {}
          await wait(250);
        }
        throw new Error('MusicKit instance is not ready in music.apple.com session.');
      };

      const normalizePositiveInteger = (value, fallback, max) => {
        const normalized = Number(value);
        if (!Number.isFinite(normalized)) return fallback;
        const floored = Math.floor(normalized);
        if (floored <= 0) return fallback;
        return Math.min(floored, max);
      };

      const toObjectArray = (value) =>
        Array.isArray(value)
          ? value.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
          : [];

      const readSectionRoot = (root, key) => {
        if (!root || typeof root !== 'object') return null;
        const direct = root[key];
        if (Array.isArray(direct)) return direct;
        if (direct && typeof direct === 'object') return direct;
        const results = root.results;
        if (!results || typeof results !== 'object') return null;
        const nested = results[key];
        if (Array.isArray(nested)) return nested;
        return nested && typeof nested === 'object' ? nested : null;
      };

      const normalizeTypeName = (value) =>
        typeof value === 'string' ? value.trim().toLowerCase() : '';
      const singularize = (value) =>
        value.endsWith('s') ? value.slice(0, -1) : value;
      const dedupeResources = (items) => {
        const list = Array.isArray(items) ? items : [];
        const next = [];
        const seen = new Set();
        for (const item of list) {
          if (!item || typeof item !== 'object') continue;
          const id = typeof item.id === 'string' ? item.id : '';
          const type = typeof item.type === 'string' ? item.type : '';
          if (!id) continue;
          const key = type + ':' + id;
          if (seen.has(key)) continue;
          seen.add(key);
          next.push(item);
        }
        return next;
      };

      const extractResourceArray = (root) => {
        if (Array.isArray(root)) {
          return toObjectArray(root);
        }
        if (!root || typeof root !== 'object') return [];

        const directData = toObjectArray(root.data);
        if (Array.isArray(root.data)) {
          return directData;
        }

        const queue = Object.values(root);
        const seen = new Set();
        while (queue.length > 0) {
          const current = queue.shift();
          if (!current || typeof current !== 'object') continue;
          if (seen.has(current)) continue;
          seen.add(current);

          const currentData = toObjectArray(current.data);
          if (Array.isArray(current.data)) {
            return currentData;
          }

          for (const nested of Object.values(current)) {
            if (nested && typeof nested === 'object') {
              queue.push(nested);
            }
          }
        }

        return [];
      };
      const isResourceRecord = (value) =>
        Boolean(
          value &&
            typeof value === 'object' &&
            typeof value.id === 'string' &&
            value.attributes &&
            typeof value.attributes === 'object',
        );
      const extractAllResources = (root) => {
        if (!root || typeof root !== 'object') return [];

        const queue = [root];
        const seen = new Set();
        const out = [];
        while (queue.length > 0) {
          const current = queue.shift();
          if (!current || typeof current !== 'object') continue;
          if (seen.has(current)) continue;
          seen.add(current);

          if (Array.isArray(current)) {
            for (const entry of current) {
              if (isResourceRecord(entry)) {
                out.push(entry);
              }
              if (entry && typeof entry === 'object') {
                queue.push(entry);
              }
            }
            continue;
          }

          if (isResourceRecord(current)) {
            out.push(current);
          }

          if (Array.isArray(current.data)) {
            for (const item of current.data) {
              if (isResourceRecord(item)) {
                out.push(item);
              }
              if (item && typeof item === 'object') {
                queue.push(item);
              }
            }
          }

          for (const nested of Object.values(current)) {
            if (nested && typeof nested === 'object') {
              queue.push(nested);
            }
          }
        }

        return dedupeResources(out);
      };
      const matchesBrowseKey = (value, key) => {
        const normalized = normalizeTypeName(value);
        if (!normalized) return false;
        const singularKey = singularize(key);
        if (normalized === key || normalized === singularKey) return true;
        if (
          normalized.endsWith('-' + key) ||
          normalized.endsWith('-' + singularKey) ||
          normalized.endsWith('/' + key) ||
          normalized.endsWith('/' + singularKey)
        ) {
          return true;
        }
        return normalized.includes(singularKey);
      };
      const inferBrowseKey = (resource) => {
        if (!resource || typeof resource !== 'object') return '';
        if (matchesBrowseKey(resource.type, 'songs')) return 'songs';
        if (matchesBrowseKey(resource.type, 'albums')) return 'albums';
        if (matchesBrowseKey(resource.type, 'playlists')) return 'playlists';

        const attributes =
          resource.attributes && typeof resource.attributes === 'object'
            ? resource.attributes
            : null;
        const url = normalizeTypeName(attributes && attributes.url);
        if (url.includes('/song/')) return 'songs';
        if (url.includes('/album/')) return 'albums';
        if (url.includes('/playlist/')) return 'playlists';

        const playParams =
          attributes &&
          attributes.playParams &&
          typeof attributes.playParams === 'object'
            ? attributes.playParams
            : null;
        const kind = playParams ? playParams.kind : '';
        if (matchesBrowseKey(kind, 'songs')) return 'songs';
        if (matchesBrowseKey(kind, 'albums')) return 'albums';
        if (matchesBrowseKey(kind, 'playlists')) return 'playlists';
        return '';
      };
      const readResourcesByKey = (root, key) => {
        const sectionRoot = readSectionRoot(root, key);
        const sectionData = dedupeResources(extractResourceArray(sectionRoot));
        if (sectionData.length > 0) return sectionData;

        const allData = extractAllResources(root);
        const filtered = allData.filter((resource) => inferBrowseKey(resource) === key);
        return dedupeResources(filtered);
      };

      try {
        const instance = await ensureMusicKitInstance();
        const api = instance.api;
        const storefrontId = instance.storefrontId || 'us';
        const browseKind = payload.browseKind === 'top-charts'
          ? 'top-charts'
          : 'new-releases';
        const limit = normalizePositiveInteger(payload.limit, 12, 50);

        if (browseKind === 'new-releases') {
          const raw = await api.music('/v1/catalog/' + storefrontId + '/new-releases', {
            limit,
          });
          let albums = readResourcesByKey(raw, 'albums');
          let fallbackSource = '';
          if (albums.length === 0) {
            try {
              const fallbackRaw = await api.music('/v1/catalog/' + storefrontId + '/charts', {
                types: 'albums',
                limit,
              });
              albums = readResourcesByKey(fallbackRaw, 'albums');
              if (albums.length > 0) {
                fallbackSource = 'charts:albums';
              }
            } catch {}
          }
          return {
            ok: true,
            data: {
              browseKind,
              albums,
              raw,
              fallbackSource,
            },
          };
        }

        const fetchChartSectionFallback = async (key) => {
          const typeCandidates = [key, [key]];
          for (const types of typeCandidates) {
            try {
              const singleRaw = await api.music('/v1/catalog/' + storefrontId + '/charts', {
                types,
                limit,
              });
              const section = readResourcesByKey(singleRaw, key);
              if (section.length > 0) {
                return {
                  section,
                  source: Array.isArray(types) ? 'single-array' : 'single-csv',
                };
              }
            } catch {}
          }
          return { section: [], source: '' };
        };

        const raw = await api.music('/v1/catalog/' + storefrontId + '/charts', {
          types: 'songs,albums,playlists',
          limit,
        });
        let songs = readResourcesByKey(raw, 'songs');
        let albums = readResourcesByKey(raw, 'albums');
        let playlists = readResourcesByKey(raw, 'playlists');
        const fallbackSources = [];

        if (songs.length === 0) {
          const fallback = await fetchChartSectionFallback('songs');
          if (fallback.section.length > 0) {
            songs = fallback.section;
            fallbackSources.push('songs:' + fallback.source);
          }
        }
        if (albums.length === 0) {
          const fallback = await fetchChartSectionFallback('albums');
          if (fallback.section.length > 0) {
            albums = fallback.section;
            fallbackSources.push('albums:' + fallback.source);
          }
        }
        if (playlists.length === 0) {
          const fallback = await fetchChartSectionFallback('playlists');
          if (fallback.section.length > 0) {
            playlists = fallback.section;
            fallbackSources.push('playlists:' + fallback.source);
          }
        }
        return {
          ok: true,
          data: {
            browseKind,
            songs,
            albums,
            playlists,
            raw,
            fallbackSources,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error: {
            code: 'api-failed',
            message,
          },
        };
      }
    })();
  `
}

async function waitForWindowReadyToRunScript(
  targetWindow: BrowserWindow,
): Promise<void> {
  if (targetWindow.isDestroyed()) {
    throw new Error('Apple Music worker window is destroyed.')
  }

  const { webContents } = targetWindow
  if (!webContents.isLoadingMainFrame()) return

  await new Promise<void>((resolve, reject) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (settled) return
      settled = true
      timeout = null
      reject(new Error('Timed out waiting for Apple Music worker window load.'))
    }, WINDOW_LOAD_TIMEOUT_MS)

    const cleanup = () => {
      try {
        webContents.removeListener('did-finish-load', onFinishLoad)
        webContents.removeListener('did-fail-load', onFailLoad)
      } catch {
        // ignore destroyed webContents race
      }
      try {
        targetWindow.removeListener('closed', onClosed)
      } catch {
        // ignore destroyed window race
      }
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
    }

    const onFinishLoad = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }

    const onFailLoad = (
      _event: unknown,
      _errorCode: number,
      errorDescription: string,
      _validatedUrl: string,
      isMainFrame: boolean,
    ) => {
      if (settled || !isMainFrame) return
      settled = true
      cleanup()
      reject(
        new Error(
          errorDescription?.trim() ||
            'Failed to load Apple Music worker window.',
        ),
      )
    }

    const onClosed = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('Apple Music worker window was closed during load.'))
    }

    try {
      webContents.once('did-finish-load', onFinishLoad)
      webContents.once('did-fail-load', onFailLoad)
      targetWindow.once('closed', onClosed)
    } catch (error) {
      settled = true
      cleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

export async function invokeAppleMusicApi(
  payload: AppleMusicApiRequestPayload,
): Promise<AppleMusicApiResponse> {
  appendAuthTrace('api.invoke.start', { action: payload.action })

  if (payload.action === 'status') {
    appendAuthTrace('api.invoke.status.windowStrategy.start')
    const statusResult = await invokeStatusFromWindowState()
    appendAuthTrace('api.invoke.status.windowStrategy.done', {
      ok: statusResult.ok,
    })
    return statusResult
  }

  let lastError: unknown = null

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      appendAuthTrace('api.invoke.attempt', { action: payload.action, attempt: attempt + 1 })
      const targetWindow = await ensureWorkerWindow()
      await waitForWindowReadyToRunScript(targetWindow)
      let script: string
      switch (payload.action) {
        case 'library':
          script = buildLibraryApiScript(payload)
          break
        case 'search':
          script = buildSearchApiScript(payload)
          break
        case 'catalog-album':
          script = buildCatalogAlbumApiScript(payload)
          break
        case 'catalog-playlist':
          script = buildCatalogPlaylistApiScript(payload)
          break
        case 'browse':
          script = buildBrowseApiScript(payload)
          break
        default:
          return {
            ok: false,
            error: {
              code: 'unsupported-action',
              message: `Unsupported Apple Music API action: ${payload.action}`,
            },
          }
      }
      const result = (await withTimeout(
        targetWindow.webContents.executeJavaScript(script, true) as Promise<unknown>,
        API_INVOKE_TIMEOUT_MS,
        `Timed out executing Apple Music browser API action: ${payload.action}`,
      )) as AppleMusicApiResponse

      if (!result || typeof result !== 'object') {
        appendAuthTrace('api.invoke.invalidResponse', { action: payload.action })
        return {
          ok: false,
          error: {
            code: 'invalid-response',
            message: 'Invalid response from Apple Music browser session.',
          },
        }
      }

      if (payload.action === 'search' && result.ok && result.data && typeof result.data === 'object') {
        const data = result.data as Record<string, unknown>
        const songsCount =
          data.songs &&
          typeof data.songs === 'object' &&
          Array.isArray((data.songs as Record<string, unknown>).data)
            ? ((data.songs as Record<string, unknown>).data as unknown[]).length
            : 0
        const albumsCount =
          data.albums &&
          typeof data.albums === 'object' &&
          Array.isArray((data.albums as Record<string, unknown>).data)
            ? ((data.albums as Record<string, unknown>).data as unknown[]).length
            : 0
        const playlistsCount =
          data.playlists &&
          typeof data.playlists === 'object' &&
          Array.isArray((data.playlists as Record<string, unknown>).data)
            ? ((data.playlists as Record<string, unknown>).data as unknown[]).length
            : 0
        appendAuthTrace('api.search.source', {
          source:
            typeof data._source === 'string'
              ? data._source
              : 'unknown',
          songs: songsCount,
          albums: albumsCount,
          playlists: playlistsCount,
        })
      }
      if (payload.action === 'browse' && result.ok && result.data && typeof result.data === 'object') {
        const data = result.data as Record<string, unknown>
        const songsCount = Array.isArray(data.songs) ? data.songs.length : 0
        const albumsCount = Array.isArray(data.albums) ? data.albums.length : 0
        const playlistsCount = Array.isArray(data.playlists) ? data.playlists.length : 0
        appendAuthTrace('api.browse.counts', {
          browseKind:
            typeof data.browseKind === 'string'
              ? data.browseKind
              : 'unknown',
          songs: songsCount,
          albums: albumsCount,
          playlists: playlistsCount,
          fallback:
            Array.isArray(data.fallbackSources) && data.fallbackSources.length > 0
              ? data.fallbackSources.join(',')
              : typeof data.fallbackSource === 'string' && data.fallbackSource.length > 0
                ? data.fallbackSource
              : 'none',
        })
      }

      appendAuthTrace('api.invoke.done', { action: payload.action, ok: result.ok })
      return result
    } catch (error) {
      lastError = error
      appendAuthTrace('api.invoke.error', {
        action: payload.action,
        attempt: attempt + 1,
        message: error instanceof Error ? error.message : String(error),
      })

      const shouldRetry = attempt === 0 && isRetryableWorkerError(error)
      if (!shouldRetry) break

      const shouldPreserveCurrentWindow =
        Boolean(workerWindow) &&
        workerWindow === signInWindow &&
        !workerWindow.isDestroyed()

      if (shouldPreserveCurrentWindow) {
        appendAuthTrace('api.invoke.retry.preserveWorkerWindow', {
          action: payload.action,
        })
      } else {
        resetWorkerWindow()
      }
      await sleep(250)
    }
  }

  appendAuthTrace('api.invoke.failed', {
    action: payload.action,
    message: lastError instanceof Error ? lastError.message : String(lastError),
  })
  return {
    ok: false,
    error: {
      code: 'invoke-failed',
      message:
        lastError instanceof Error ? lastError.message : String(lastError),
    },
  }
}
