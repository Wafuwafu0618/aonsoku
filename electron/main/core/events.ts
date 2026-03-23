import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { is, platform } from '@electron-toolkit/utils'
import {
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  session as electronSession,
  shell,
  type Session,
} from 'electron'
import {
  AppleMusicRequestDebug,
  AppleMusicWrapperConfig,
  IpcChannels,
  LocalLibraryFileEntry,
  OverlayColors,
  ParametricEqFileEntry,
  PlayerStatePayload,
  SpotifyConnectOAuthAuthorizeRequest,
  SpotifyConnectOAuthRefreshRequest,
  SpotifyConnectPlayUriRequest,
  SpotifyConnectSetActiveDeviceRequest,
} from '../../preload/types'
import { isQuitting } from '../index'
import { tray, updateTray } from '../tray'
import { colorsState } from './colors'
import {
  clearDiscordRpcActivity,
  RpcPayload,
  setDiscordRpcActivity,
} from './discordRpc'
import { nativeAudioSidecar } from './native-audio-sidecar'
import {
  spotifyConnectOAuthAuthorize,
  spotifyConnectOAuthRefresh,
} from './spotify-connect-oauth'
import { spotifyConnectSidecar } from './spotify-connect-sidecar'
import { playerState } from './playerState'
import { getAppSetting, ISettingPayload, saveAppSettings } from './settings'
import { setTaskbarButtons } from './taskbar'
import { DEFAULT_TITLE_BAR_HEIGHT } from './titleBarOverlay'
import { resolveAppleMusicTrack } from './apple-music-pipeline'
import {
  getAppleMusicDebugReport,
  invokeAppleMusicApi,
  openAppleMusicSignInWindow,
} from './apple-music-browser-api'
import { setWrapperConfig } from './wrapper-client'

const MUSIC_EXTENSIONS = new Set(['.mp3', '.flac', '.aac', '.m4a', '.alac'])
const APPLE_MUSIC_REQUEST_FILTER = {
  urls: ['https://*.music.apple.com/*'],
}
const APPLE_MUSIC_AUTH_PARTITION = 'persist:apple-music-auth'
const appleMusicRequestDebugById = new Map<number, AppleMusicRequestDebug>()
const appleMusicDebugSessions = new WeakSet<Session>()
let lastAppleMusicRequestDebug: AppleMusicRequestDebug | null = null

function isMusicFile(path: string): boolean {
  return MUSIC_EXTENSIONS.has(extname(path).toLowerCase())
}

function normalizeHeaderValue(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') {
    const normalized = value.trim()
    return normalized.length > 0 ? normalized : null
  }

  if (!Array.isArray(value)) return null
  const firstValid = value
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0)

  return firstValid ?? null
}

function readHeaderValue(
  headers: Record<string, string | string[] | undefined>,
  key: string,
): string | null {
  const normalizedTarget = key.toLowerCase()

  for (const [headerKey, headerValue] of Object.entries(headers)) {
    if (headerKey.toLowerCase() !== normalizedTarget) continue
    return normalizeHeaderValue(headerValue)
  }

  return null
}

function maskToken(value: string): string {
  if (value.length <= 10) return `[len:${value.length}]`
  return `${value.slice(0, 6)}...${value.slice(-4)} [len:${value.length}]`
}

function sanitizeHeaderValue(key: string, value: string): string {
  const normalizedKey = key.toLowerCase()

  if (normalizedKey === 'authorization') {
    const matched = value.match(/^Bearer\s+(.+)$/i)
    if (!matched) return '[redacted]'
    return `Bearer ${maskToken(matched[1]?.trim() ?? '')}`
  }
  if (normalizedKey === 'media-user-token' || normalizedKey === 'music-user-token') {
    return maskToken(value)
  }
  if (normalizedKey === 'cookie' || normalizedKey === 'set-cookie') {
    return '[redacted]'
  }
  if (value.length > 180) {
    return `${value.slice(0, 180)}...`
  }

  return value
}

function toSanitizedHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {}

  for (const [key, rawValue] of Object.entries(headers)) {
    const normalizedValue = normalizeHeaderValue(rawValue)
    if (!normalizedValue) continue

    const normalizedKey = key.toLowerCase()
    result[normalizedKey] = sanitizeHeaderValue(normalizedKey, normalizedValue)
  }

  return result
}

function isAppleMusicApiRequestUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    if (host === 'api.music.apple.com' || host === 'amp-api.music.apple.com') {
      return true
    }
    if (host.startsWith('amp-api-') && host.endsWith('.music.apple.com')) {
      return true
    }
    return false
  } catch {
    return false
  }
}

function setupAppleMusicRequestDebug(targetSession: Session): void {
  if (appleMusicDebugSessions.has(targetSession)) {
    return
  }
  appleMusicDebugSessions.add(targetSession)

  targetSession.webRequest.onBeforeSendHeaders(
    APPLE_MUSIC_REQUEST_FILTER,
    (details, callback) => {
      const requestHeaders = {
        ...(details.requestHeaders ?? {}),
      }
      const isAppleMusicApiRequest = isAppleMusicApiRequestUrl(details.url)
      if (isAppleMusicApiRequest) {
        const musicUserToken = readHeaderValue(requestHeaders, 'music-user-token')
        const mediaUserToken = readHeaderValue(requestHeaders, 'media-user-token')
        if (!musicUserToken && mediaUserToken) {
          requestHeaders['Music-User-Token'] = mediaUserToken
        }

        appleMusicRequestDebugById.set(details.id, {
          requestId: details.id,
          url: details.url,
          method: details.method,
          timestampMs: Date.now(),
          headers: toSanitizedHeaders(requestHeaders),
        })

        if (appleMusicRequestDebugById.size > 200) {
          appleMusicRequestDebugById.clear()
        }
      }

      callback({
        requestHeaders,
      })
    },
  )

  targetSession.webRequest.onCompleted(APPLE_MUSIC_REQUEST_FILTER, (details) => {
    const pending = appleMusicRequestDebugById.get(details.id)
    if (!pending) return

    const completed: AppleMusicRequestDebug = {
      ...pending,
      statusCode: details.statusCode,
    }

    lastAppleMusicRequestDebug = completed
    appleMusicRequestDebugById.delete(details.id)
  })

  targetSession.webRequest.onErrorOccurred(APPLE_MUSIC_REQUEST_FILTER, (details) => {
    const pending = appleMusicRequestDebugById.get(details.id)
    if (!pending) return

    lastAppleMusicRequestDebug = {
      ...pending,
      statusCode: -1,
    }
    appleMusicRequestDebugById.delete(details.id)
  })
}

function getFileEntryKey(path: string): string {
  return platform.isWindows ? path.toLowerCase() : path
}

async function walkMusicFiles(
  dirPath: string,
): Promise<LocalLibraryFileEntry[]> {
  const entries = await readdir(dirPath, { withFileTypes: true })
  const files: LocalLibraryFileEntry[] = []

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name)

    if (entry.isDirectory()) {
      try {
        const nested = await walkMusicFiles(fullPath)
        files.push(...nested)
      } catch {
        // unreadable directory is skipped
      }
      continue
    }

    if (!entry.isFile() || !isMusicFile(fullPath)) {
      continue
    }

    try {
      const fileStat = await stat(fullPath)
      files.push({
        path: fullPath,
        name: entry.name,
        size: fileStat.size,
        modifiedAt: fileStat.mtimeMs,
        createdAt: fileStat.birthtimeMs,
      })
    } catch {
      // unreadable file is skipped
    }
  }

  return files
}

export function setupEvents(window: BrowserWindow | null) {
  if (!window) return

  window.on('ready-to-show', async () => {
    window.show()
  })

  window.on('show', () => {
    setTaskbarButtons()
    updateTray()
  })

  window.on('hide', () => {
    updateTray()
  })

  window.webContents.once('did-finish-load', () => {
    nativeTheme.on('updated', () => {
      setTaskbarButtons()
    })
  })

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  window.on('enter-full-screen', () => {
    window.webContents.send(IpcChannels.FullscreenStatus, true)
  })

  window.on('leave-full-screen', () => {
    window.webContents.send(IpcChannels.FullscreenStatus, false)
  })

  window.on('maximize', () => {
    window.webContents.send(IpcChannels.MaximizedStatus, true)
  })

  window.on('unmaximize', () => {
    window.webContents.send(IpcChannels.MaximizedStatus, false)
  })

  window.on('close', (event) => {
    if (isQuitting) {
      if (tray && !tray.isDestroyed()) tray.destroy()
      return
    }

    if (is.dev || !getAppSetting('minimizeToTray')) {
      if (tray && !tray.isDestroyed()) tray.destroy()
      return
    }

    event.preventDefault()
    window.hide()
  })

  window.on('page-title-updated', (_, title) => {
    updateTray(title)
  })
}

function formatLastAppleMusicRequestDebug(
  debug: AppleMusicRequestDebug | null,
): string {
  if (!debug) return 'lastRequestDebug: (none)'

  const headerLines = Object.entries(debug.headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')

  return [
    '--- last-request-debug ---',
    `time=${new Date(debug.timestampMs).toISOString()}`,
    `requestId=${debug.requestId}`,
    `status=${debug.statusCode ?? 'unknown'}`,
    `method=${debug.method}`,
    `url=${debug.url}`,
    headerLines.length > 0 ? headerLines : '(no headers)',
  ].join('\n')
}

export function setupIpcEvents(window: BrowserWindow | null) {
  if (!window) return

  ipcMain.removeAllListeners()
  setupAppleMusicRequestDebug(window.webContents.session)
  setupAppleMusicRequestDebug(
    electronSession.fromPartition(APPLE_MUSIC_AUTH_PARTITION),
  )

  nativeAudioSidecar.setEventListener((event) => {
    if (window.isDestroyed()) return
    window.webContents.send(IpcChannels.NativeAudioEvent, event)
  })
  spotifyConnectSidecar.setEventListener((event) => {
    if (window.isDestroyed()) return
    window.webContents.send(IpcChannels.SpotifyConnectEvent, event)
  })

  ipcMain.on(IpcChannels.ToggleFullscreen, (_, isFullscreen: boolean) => {
    window.setFullScreen(isFullscreen)
  })

  ipcMain.removeHandler(IpcChannels.IsFullScreen)
  ipcMain.handle(IpcChannels.IsFullScreen, () => {
    return window.isFullScreen()
  })

  ipcMain.removeHandler(IpcChannels.IsMaximized)
  ipcMain.handle(IpcChannels.IsMaximized, () => {
    return window.isMaximized()
  })

  ipcMain.on(IpcChannels.ToggleMaximize, (_, isMaximized: boolean) => {
    if (isMaximized) {
      window.unmaximize()
    } else {
      window.maximize()
    }
  })

  ipcMain.on(IpcChannels.ToggleMinimize, () => {
    window.minimize()
  })

  ipcMain.on(IpcChannels.CloseWindow, () => {
    window.close()
  })

  ipcMain.on(IpcChannels.ThemeChanged, (_, colors: OverlayColors) => {
    const { color, symbol, bgColor } = colors

    if (bgColor) {
      colorsState.set('bgColor', bgColor)
    }

    if (platform.isMacOS || platform.isLinux) return

    window.setTitleBarOverlay({
      color,
      height: DEFAULT_TITLE_BAR_HEIGHT,
      symbolColor: symbol,
    })
  })

  ipcMain.on(IpcChannels.UpdateNativeTheme, (_, isDark: boolean) => {
    nativeTheme.themeSource = isDark ? 'dark' : 'light'
  })

  ipcMain.on(
    IpcChannels.UpdatePlayerState,
    (_, payload: PlayerStatePayload) => {
      playerState.setAll(payload)

      setTimeout(() => {
        setTaskbarButtons()
        updateTray()
      }, 150)
    },
  )

  ipcMain.on(IpcChannels.SetDiscordRpcActivity, (_, payload: RpcPayload) => {
    setDiscordRpcActivity(payload)
  })

  ipcMain.on(IpcChannels.ClearDiscordRpcActivity, () => {
    clearDiscordRpcActivity()
  })

  ipcMain.on(IpcChannels.SaveAppSettings, (_, payload: ISettingPayload) => {
    saveAppSettings(payload)
  })

  ipcMain.removeHandler(IpcChannels.PickLocalLibraryDirectory)
  ipcMain.handle(IpcChannels.PickLocalLibraryDirectory, async () => {
    const result = await dialog.showOpenDialog(window, {
      title: 'ローカルライブラリフォルダを選択',
      properties: ['openDirectory'],
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    const selectedPath = result.filePaths[0]

    return {
      path: selectedPath,
      name: basename(selectedPath),
    }
  })

  ipcMain.removeHandler(IpcChannels.PickParametricEqFile)
  ipcMain.handle(
    IpcChannels.PickParametricEqFile,
    async (): Promise<ParametricEqFileEntry | null> => {
      const result = await dialog.showOpenDialog(window, {
        title: 'Parametric EQファイルを選択',
        properties: ['openFile'],
        filters: [{ name: 'Text Files', extensions: ['txt'] }],
      })

      if (result.canceled || result.filePaths.length === 0) {
        return null
      }

      const selectedPath = result.filePaths[0]
      return {
        path: selectedPath,
        name: basename(selectedPath),
      }
    },
  )

  ipcMain.removeHandler(IpcChannels.ListLocalLibraryFiles)
  ipcMain.handle(
    IpcChannels.ListLocalLibraryFiles,
    async (_, directories: string[]) => {
      const allFilesByPath = new Map<string, LocalLibraryFileEntry>()

      for (const directory of directories) {
        try {
          const fileStat = await stat(directory)
          if (!fileStat.isDirectory()) continue

          const files = await walkMusicFiles(directory)
          for (const file of files) {
            const fileKey = getFileEntryKey(file.path)
            if (!allFilesByPath.has(fileKey)) {
              allFilesByPath.set(fileKey, file)
            }
          }
        } catch {
          // invalid directory is skipped
        }
      }

      return Array.from(allFilesByPath.values())
    },
  )

  ipcMain.removeHandler(IpcChannels.ReadLocalLibraryFile)
  ipcMain.handle(IpcChannels.ReadLocalLibraryFile, async (_, path: string) => {
    const [buffer, fileStat] = await Promise.all([readFile(path), stat(path)])

    return {
      path,
      data: buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ),
      size: fileStat.size,
      modifiedAt: fileStat.mtimeMs,
      createdAt: fileStat.birthtimeMs,
    }
  })

  ipcMain.removeHandler(IpcChannels.NativeAudioInitialize)
  ipcMain.handle(IpcChannels.NativeAudioInitialize, () =>
    nativeAudioSidecar.initialize(),
  )

  ipcMain.removeHandler(IpcChannels.NativeAudioListDevices)
  ipcMain.handle(IpcChannels.NativeAudioListDevices, () =>
    nativeAudioSidecar.listDevices(),
  )

  ipcMain.removeHandler(IpcChannels.NativeAudioSetOutputMode)
  ipcMain.handle(IpcChannels.NativeAudioSetOutputMode, (_, mode) =>
    nativeAudioSidecar.setOutputMode(mode),
  )

  ipcMain.removeHandler(IpcChannels.NativeAudioLoad)
  ipcMain.handle(IpcChannels.NativeAudioLoad, async (_, payload) => {
    const src =
      payload && typeof payload === 'object' && 'src' in payload
        ? String((payload as { src?: unknown }).src ?? '')
        : ''
    const srcPreview = src.length > 120 ? `${src.slice(0, 120)}...` : src
    console.log(
      '[NativeAudioIPC] load invoke',
      `autoplay=${Boolean((payload as { autoplay?: unknown })?.autoplay)}`,
      `src=${srcPreview}`,
    )

    const result = await nativeAudioSidecar.load(payload)
    if (!result.ok) {
      console.warn(
        '[NativeAudioIPC] load failed',
        result.error?.code,
        result.error?.message,
      )
    } else {
      console.log('[NativeAudioIPC] load ok')
    }
    return result
  })

  ipcMain.removeHandler(IpcChannels.NativeAudioPlay)
  ipcMain.handle(IpcChannels.NativeAudioPlay, async () => {
    console.log('[NativeAudioIPC] play invoke')
    const result = await nativeAudioSidecar.play()
    if (!result.ok) {
      console.warn(
        '[NativeAudioIPC] play failed',
        result.error?.code,
        result.error?.message,
      )
    } else {
      console.log('[NativeAudioIPC] play ok')
    }
    return result
  })

  ipcMain.removeHandler(IpcChannels.NativeAudioPause)
  ipcMain.handle(IpcChannels.NativeAudioPause, () => nativeAudioSidecar.pause())

  ipcMain.removeHandler(IpcChannels.NativeAudioSeek)
  ipcMain.handle(IpcChannels.NativeAudioSeek, (_, positionSeconds: number) =>
    nativeAudioSidecar.seek(positionSeconds),
  )

  ipcMain.removeHandler(IpcChannels.NativeAudioSetVolume)
  ipcMain.handle(IpcChannels.NativeAudioSetVolume, (_, volume: number) =>
    nativeAudioSidecar.setVolume(volume),
  )

  ipcMain.removeHandler(IpcChannels.NativeAudioSetLoop)
  ipcMain.handle(IpcChannels.NativeAudioSetLoop, (_, loop: boolean) =>
    nativeAudioSidecar.setLoop(loop),
  )

  ipcMain.removeHandler(IpcChannels.NativeAudioSetPlaybackRate)
  ipcMain.handle(
    IpcChannels.NativeAudioSetPlaybackRate,
    (_, playbackRate: number) => nativeAudioSidecar.setPlaybackRate(playbackRate),
  )

  ipcMain.removeHandler(IpcChannels.NativeAudioDispose)
  ipcMain.handle(IpcChannels.NativeAudioDispose, () => nativeAudioSidecar.dispose())

  ipcMain.removeHandler(IpcChannels.SpotifyConnectInitialize)
  ipcMain.handle(IpcChannels.SpotifyConnectInitialize, (_, payload) =>
    spotifyConnectSidecar.initialize(payload),
  )

  ipcMain.removeHandler(IpcChannels.SpotifyConnectStartReceiver)
  ipcMain.handle(IpcChannels.SpotifyConnectStartReceiver, () =>
    spotifyConnectSidecar.startReceiver(),
  )

  ipcMain.removeHandler(IpcChannels.SpotifyConnectStatus)
  ipcMain.handle(IpcChannels.SpotifyConnectStatus, () =>
    spotifyConnectSidecar.status(),
  )

  ipcMain.removeHandler(IpcChannels.SpotifyConnectListDevices)
  ipcMain.handle(IpcChannels.SpotifyConnectListDevices, () =>
    spotifyConnectSidecar.listDevices(),
  )

  ipcMain.removeHandler(IpcChannels.SpotifyConnectSetActiveDevice)
  ipcMain.handle(
    IpcChannels.SpotifyConnectSetActiveDevice,
    (_, payload: SpotifyConnectSetActiveDeviceRequest) =>
      spotifyConnectSidecar.setActiveDevice(payload),
  )

  ipcMain.removeHandler(IpcChannels.SpotifyConnectPlayUri)
  ipcMain.handle(
    IpcChannels.SpotifyConnectPlayUri,
    (_, payload: SpotifyConnectPlayUriRequest) =>
      spotifyConnectSidecar.playUri(payload),
  )

  ipcMain.removeHandler(IpcChannels.SpotifyConnectOAuthAuthorize)
  ipcMain.handle(
    IpcChannels.SpotifyConnectOAuthAuthorize,
    (_, payload: SpotifyConnectOAuthAuthorizeRequest) =>
      spotifyConnectOAuthAuthorize(payload),
  )

  ipcMain.removeHandler(IpcChannels.SpotifyConnectOAuthRefresh)
  ipcMain.handle(
    IpcChannels.SpotifyConnectOAuthRefresh,
    (_, payload: SpotifyConnectOAuthRefreshRequest) =>
      spotifyConnectOAuthRefresh(payload),
  )

  ipcMain.removeHandler(IpcChannels.SpotifyConnectDispose)
  ipcMain.handle(IpcChannels.SpotifyConnectDispose, () =>
    spotifyConnectSidecar.dispose(),
  )

  ipcMain.removeHandler(IpcChannels.AppleMusicResolve)
  ipcMain.handle(
    IpcChannels.AppleMusicResolve,
    (_, adamId: string) => resolveAppleMusicTrack(adamId),
  )

  ipcMain.removeHandler(IpcChannels.AppleMusicSetWrapperConfig)
  ipcMain.handle(
    IpcChannels.AppleMusicSetWrapperConfig,
    (_, config: AppleMusicWrapperConfig) => {
      setWrapperConfig(config)
    },
  )

  ipcMain.removeHandler(IpcChannels.AppleMusicGetLastRequestDebug)
  ipcMain.handle(IpcChannels.AppleMusicGetLastRequestDebug, () => {
    return lastAppleMusicRequestDebug
  })

  ipcMain.removeHandler(IpcChannels.AppleMusicGetDebugReport)
  ipcMain.handle(IpcChannels.AppleMusicGetDebugReport, async () => {
    const browserReport = await getAppleMusicDebugReport().catch((error) => {
      const reason = error instanceof Error ? error.message : String(error)
      return [
        '=== Apple Music Debug Report ===',
        `generatedAt=${new Date().toISOString()}`,
        `browserReport.error=${reason}`,
      ].join('\n')
    })
    const requestReport = formatLastAppleMusicRequestDebug(
      lastAppleMusicRequestDebug,
    )
    return `${browserReport}\n${requestReport}`
  })

  ipcMain.removeHandler(IpcChannels.AppleMusicOpenSignInWindow)
  ipcMain.handle(IpcChannels.AppleMusicOpenSignInWindow, () =>
    openAppleMusicSignInWindow(),
  )

  ipcMain.removeHandler(IpcChannels.AppleMusicApiRequest)
  ipcMain.handle(IpcChannels.AppleMusicApiRequest, (_, payload) =>
    invokeAppleMusicApi(payload),
  )
}
