import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { is, platform } from '@electron-toolkit/utils'
import { BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import {
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

const MUSIC_EXTENSIONS = new Set(['.mp3', '.flac', '.aac', '.m4a', '.alac'])

function isMusicFile(path: string): boolean {
  return MUSIC_EXTENSIONS.has(extname(path).toLowerCase())
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

export function setupIpcEvents(window: BrowserWindow | null) {
  if (!window) return

  ipcMain.removeAllListeners()

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
  ipcMain.handle(IpcChannels.NativeAudioLoad, (_, payload) =>
    nativeAudioSidecar.load(payload),
  )

  ipcMain.removeHandler(IpcChannels.NativeAudioPlay)
  ipcMain.handle(IpcChannels.NativeAudioPlay, () => nativeAudioSidecar.play())

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
}
