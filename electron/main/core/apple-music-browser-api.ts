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
    (_event, level, message, line, sourceId) => {
      if (level < 2) return
      appendAuthTrace('window.console', {
        level,
        line,
        sourceId,
        message,
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

function buildApiScript(payload: AppleMusicApiRequestPayload): string {
  const serializedPayload = JSON.stringify(payload)

  return `
    (async () => {
      const payload = ${serializedPayload};
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const ensureMusicKitInstance = async () => {
        for (let i = 0; i < 80; i += 1) {
          try {
            const globalMusicKit = window.MusicKit;
            const instance = globalMusicKit?.getInstance?.();
            if (instance?.api) return instance;
          } catch {}
          await wait(250);
        }
        throw new Error('MusicKit instance is not ready in music.apple.com session.');
      };

      try {
        const instance = await ensureMusicKitInstance();
        const api = instance.api;
        const storefrontId = instance.storefrontId || 'us';
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
          if (direct && typeof direct === 'object') return direct;
          const results = root.results;
          if (!results || typeof results !== 'object') return null;
          const nested = results[key];
          return nested && typeof nested === 'object' ? nested : null;
        };
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
        const EMPTY_SEARCH_RESULT = {
          songs: { data: [] },
          albums: { data: [] },
          playlists: { data: [] },
        };
        const readSearchSectionData = (root, key) => {
          const sectionRoot = readSectionRoot(root, key);
          if (Array.isArray(sectionRoot)) {
            return toObjectArray(sectionRoot);
          }
          return extractResourceArray(sectionRoot);
        };
        const normalizeSearchResult = (root) => {
          const songs = readSearchSectionData(root, 'songs');
          const albums = readSearchSectionData(root, 'albums');
          const playlists = readSearchSectionData(root, 'playlists');

          return {
            songs: { data: songs },
            albums: { data: albums },
            playlists: { data: playlists },
          };
        };
        const hasAnySearchResult = (root) => {
          const normalized = normalizeSearchResult(root);
          return (
            normalized.songs.data.length > 0 ||
            normalized.albums.data.length > 0 ||
            normalized.playlists.data.length > 0
          );
        };
        const readEntityIdFromHref = (href, entity) => {
          const normalizedHref = typeof href === 'string' ? href.trim() : '';
          if (!normalizedHref) return '';

          const entityMatched = normalizedHref.match(
            new RegExp('/' + entity + '/[^/?#]+/([^/?#]+)'),
          );
          if (entityMatched && entityMatched[1]) return entityMatched[1];

          const numericMatched = normalizedHref.match(/\/(\d+)(?:[/?#]|$)/);
          if (numericMatched && numericMatched[1]) return numericMatched[1];

          const pathSegments = normalizedHref
            .split(/[?#]/)[0]
            .split('/')
            .filter((entry) => entry.length > 0);
          return pathSegments[pathSegments.length - 1] ?? '';
        };
        const toAbsoluteMusicUrl = (href) => {
          try {
            return new URL(String(href || ''), 'https://music.apple.com').toString();
          } catch {
            return '';
          }
        };
        const cleanupText = (value) =>
          String(value || '')
            .replace(/\s+/g, ' ')
            .trim();
        const scrapeSearchFromHtml = async (query, limit) => {
          const searchUrl =
            'https://music.apple.com/' +
            encodeURIComponent(storefrontId) +
            '/search?term=' +
            encodeURIComponent(query);
          const response = await fetch(searchUrl, {
            credentials: 'include',
            cache: 'no-store',
          });
          if (!response.ok) {
            throw new Error('search html fetch failed with status ' + response.status);
          }

          const html = await response.text();
          const parser = new DOMParser();
          const doc = parser.parseFromString(html, 'text/html');
          const uniqueIds = {
            songs: new Set(),
            albums: new Set(),
            playlists: new Set(),
          };
          const songs = [];
          const albums = [];
          const playlists = [];

          const collect = (selector, entity, target, mapper) => {
            const elements = Array.from(doc.querySelectorAll(selector));

            for (const element of elements) {
              if (target.length >= limit) break;

              const href = element.getAttribute('href') || '';
              const id = readEntityIdFromHref(href, entity);
              if (!id) continue;
              if (uniqueIds[entity + 's']?.has(id)) continue;

              const titleFromText = cleanupText(element.textContent);
              const titleFromAria = cleanupText(element.getAttribute('aria-label'));
              const title = titleFromText || titleFromAria || id;
              const url = toAbsoluteMusicUrl(href);
              const resource = mapper({
                id,
                title,
                url,
              });

              uniqueIds[entity + 's']?.add(id);
              target.push(resource);
            }
          };

          collect('a[href*="/song/"]', 'song', songs, ({ id, title, url }) => ({
            id,
            type: 'songs',
            attributes: {
              name: title,
              artistName: '',
              albumName: '',
              durationInMillis: 0,
              genreNames: [],
              artwork: { url: '' },
              url,
              playParams: { id, catalogId: id },
            },
          }));
          collect('a[href*="/album/"]', 'album', albums, ({ id, title, url }) => ({
            id,
            type: 'albums',
            attributes: {
              name: title,
              artistName: '',
              releaseDate: '',
              trackCount: 0,
              artwork: { url: '' },
              url,
            },
          }));
          collect('a[href*="/playlist/"]', 'playlist', playlists, ({ id, title, url }) => ({
            id,
            type: 'playlists',
            attributes: {
              name: title,
              curatorName: 'Apple Music',
              trackCount: 0,
              artwork: { url: '' },
              url,
            },
          }));

          return {
            songs: { data: songs },
            albums: { data: albums },
            playlists: { data: playlists },
          };
        };

        if (payload.action === 'status') {
          let isAuthorized = false;
          let resolvedStorefrontId = storefrontId;

          if (typeof api.music === 'function') {
            try {
              const meStorefront = await api.music('/v1/me/storefront');
              const storefrontResources = extractResourceArray(meStorefront);
              const storefrontCandidate =
                storefrontResources.length > 0 && storefrontResources[0]
                  ? String(storefrontResources[0].id || '').trim()
                  : '';
              if (storefrontCandidate) {
                resolvedStorefrontId = storefrontCandidate;
              }
              isAuthorized = true;
            } catch {
              isAuthorized = false;
            }
          }

          return {
            ok: true,
            data: {
              isAuthorized,
              storefrontId: resolvedStorefrontId,
              hasCachedMusicUserToken: Boolean(instance.musicUserToken),
            },
          };
        }

        if (payload.action === 'search') {
          const query = String(payload.query || '').trim();
          const limit = normalizePositiveInteger(payload.limit, 25, 50);
          const types = Array.isArray(payload.types)
            ? payload.types.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
            : [];

          if (!query) {
            return {
              ok: true,
              data: EMPTY_SEARCH_RESULT,
            };
          }

          const normalizedTypes = types.length > 0 ? types : ['songs', 'albums', 'playlists'];
          const searchTypeCsv = normalizedTypes.join(',');

          let primaryResult = null;

          if (typeof api.search === 'function') {
            try {
              primaryResult = await api.search(query, {
                types: normalizedTypes,
                limit,
              });
            } catch {
              // fallback to alternative signatures below
            }

            if (!hasAnySearchResult(primaryResult)) {
              try {
                primaryResult = await api.search(query, {
                  types: searchTypeCsv,
                  limit,
                });
              } catch {
                // fallback to api.music below
              }
            }
          }

          if (!hasAnySearchResult(primaryResult)) {
            try {
              primaryResult = await api.music('/v1/catalog/' + storefrontId + '/search', {
                term: query,
                types: searchTypeCsv,
                limit,
              });
            } catch {
              // fallback to html scraping below
            }
          }

          if (hasAnySearchResult(primaryResult)) {
            return {
              ok: true,
              data: {
                ...normalizeSearchResult(primaryResult),
                _source: 'api',
              },
            };
          }

          try {
            const domFallback = await scrapeSearchFromHtml(query, limit);
            if (
              domFallback.songs.data.length > 0 ||
              domFallback.albums.data.length > 0 ||
              domFallback.playlists.data.length > 0
            ) {
              return {
                ok: true,
                data: {
                  ...domFallback,
                  _source: 'dom-fallback',
                },
              };
            }
          } catch {
            // fallback to empty
          }

          return {
            ok: true,
            data: {
              ...EMPTY_SEARCH_RESULT,
              _source: 'empty',
            },
          };
        }

        if (payload.action === 'catalog-album') {
          const id = String(payload.id || '').trim();
          if (!id) throw new Error('album id is required.');
          const raw = await api.music('/v1/catalog/' + storefrontId + '/albums/' + id, {
            include: 'tracks',
          });
          return { ok: true, data: raw };
        }

        if (payload.action === 'catalog-playlist') {
          const id = String(payload.id || '').trim();
          if (!id) throw new Error('playlist id is required.');
          const raw = await api.music('/v1/catalog/' + storefrontId + '/playlists/' + id, {
            include: 'tracks',
          });
          return { ok: true, data: raw };
        }

        if (payload.action === 'library') {
          const limit = normalizePositiveInteger(payload.limit, 25, 100);
          const offset = normalizePositiveInteger(payload.offset, 0, 100_000);
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
        }

        if (payload.action === 'browse') {
          const browseKind = payload.browseKind === 'top-charts'
            ? 'top-charts'
            : 'new-releases';
          const limit = normalizePositiveInteger(payload.limit, 12, 50);

          if (browseKind === 'new-releases') {
            const raw = await api.music('/v1/catalog/' + storefrontId + '/new-releases', {
              limit,
            });
            const albums = extractResourceArray(readSectionRoot(raw, 'albums'));
            return {
              ok: true,
              data: {
                browseKind,
                albums,
                raw,
              },
            };
          }

          const raw = await api.music('/v1/catalog/' + storefrontId + '/charts', {
            types: 'songs,albums,playlists',
            limit,
          });
          const songs = extractResourceArray(readSectionRoot(raw, 'songs'));
          const albums = extractResourceArray(readSectionRoot(raw, 'albums'));
          const playlists = extractResourceArray(readSectionRoot(raw, 'playlists'));
          return {
            ok: true,
            data: {
              browseKind,
              songs,
              albums,
              playlists,
              raw,
            },
          };
        }

        throw new Error('Unsupported Apple Music API action: ' + payload.action);
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
      const script =
        payload.action === 'library'
          ? buildLibraryApiScript(payload)
          : buildApiScript(payload)
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
