import { electronAPI } from '@electron-toolkit/preload'
import { contextBridge, ipcRenderer } from 'electron'
import {
  IAonsokuAPI,
  IpcChannels,
  NativeAudioEvent,
  NativeAudioOutputMode,
  PlayerStateListenerActions,
} from './types'

// Custom APIs for renderer
const api: IAonsokuAPI = {
  enterFullScreen: () => ipcRenderer.send(IpcChannels.ToggleFullscreen, true),
  exitFullScreen: () => ipcRenderer.send(IpcChannels.ToggleFullscreen, false),
  isFullScreen: () => ipcRenderer.invoke(IpcChannels.IsFullScreen),
  fullscreenStatusListener: (func) => {
    ipcRenderer.on(IpcChannels.FullscreenStatus, (_, status: boolean) =>
      func(status),
    )
  },
  removeFullscreenStatusListener: () => {
    ipcRenderer.removeAllListeners(IpcChannels.FullscreenStatus)
  },
  isMaximized: () => ipcRenderer.invoke(IpcChannels.IsMaximized),
  maximizedStatusListener: (func) => {
    ipcRenderer.on(IpcChannels.MaximizedStatus, (_, status: boolean) =>
      func(status),
    )
  },
  removeMaximizedStatusListener: () => {
    ipcRenderer.removeAllListeners(IpcChannels.MaximizedStatus)
  },
  toggleMaximize: (isMaximized) =>
    ipcRenderer.send(IpcChannels.ToggleMaximize, isMaximized),
  toggleMinimize: () => ipcRenderer.send(IpcChannels.ToggleMinimize),
  closeWindow: () => ipcRenderer.send(IpcChannels.CloseWindow),
  setTitleBarOverlayColors: (color) =>
    ipcRenderer.send(IpcChannels.ThemeChanged, color),
  setNativeTheme: (isDark) =>
    ipcRenderer.send(IpcChannels.UpdateNativeTheme, isDark),
  downloadFile: (payload) =>
    ipcRenderer.send(IpcChannels.HandleDownloads, payload),
  downloadCompletedListener: (func) => {
    ipcRenderer.once(IpcChannels.DownloadCompleted, (_, fileId: string) =>
      func(fileId),
    )
  },
  downloadFailedListener: (func) => {
    ipcRenderer.once(IpcChannels.DownloadFailed, (_, fileId: string) =>
      func(fileId),
    )
  },
  updatePlayerState: (payload) => {
    ipcRenderer.send(IpcChannels.UpdatePlayerState, payload)
  },
  playerStateListener: (func) => {
    ipcRenderer.on(
      IpcChannels.PlayerStateListener,
      (_, state: PlayerStateListenerActions) => func(state),
    )
  },
  setDiscordRpcActivity: (payload) => {
    ipcRenderer.send(IpcChannels.SetDiscordRpcActivity, payload)
  },
  clearDiscordRpcActivity: () => {
    ipcRenderer.send(IpcChannels.ClearDiscordRpcActivity)
  },
  saveAppSettings: (payload) => {
    ipcRenderer.send(IpcChannels.SaveAppSettings, payload)
  },
  checkForUpdates: () => ipcRenderer.invoke(IpcChannels.CheckForUpdates),
  downloadUpdate: () => ipcRenderer.send(IpcChannels.DownloadUpdate),
  quitAndInstall: () => ipcRenderer.send(IpcChannels.QuitAndInstall),
  onUpdateAvailable: (callback) => {
    ipcRenderer.on(IpcChannels.UpdateAvailable, (_, info) => callback(info))
  },
  onUpdateNotAvailable: (callback) => {
    ipcRenderer.on(IpcChannels.UpdateNotAvailable, () => callback())
  },
  onUpdateError: (callback) => {
    ipcRenderer.on(IpcChannels.UpdateError, (_, error) => callback(error))
  },
  onDownloadProgress: (callback) => {
    ipcRenderer.on(IpcChannels.DownloadProgress, (_, progress) =>
      callback(progress),
    )
  },
  onUpdateDownloaded: (callback) => {
    ipcRenderer.on(IpcChannels.UpdateDownloaded, (_, info) => callback(info))
  },
  pickLocalLibraryDirectory: () =>
    ipcRenderer.invoke(IpcChannels.PickLocalLibraryDirectory),
  listLocalLibraryFiles: (directories) =>
    ipcRenderer.invoke(IpcChannels.ListLocalLibraryFiles, directories),
  readLocalLibraryFile: (path) =>
    ipcRenderer.invoke(IpcChannels.ReadLocalLibraryFile, path),
  nativeAudioInitialize: () =>
    ipcRenderer.invoke(IpcChannels.NativeAudioInitialize),
  nativeAudioListDevices: () =>
    ipcRenderer.invoke(IpcChannels.NativeAudioListDevices),
  nativeAudioSetOutputMode: (mode: NativeAudioOutputMode) =>
    ipcRenderer.invoke(IpcChannels.NativeAudioSetOutputMode, mode),
  nativeAudioLoad: (payload) =>
    ipcRenderer.invoke(IpcChannels.NativeAudioLoad, payload),
  nativeAudioPlay: () => ipcRenderer.invoke(IpcChannels.NativeAudioPlay),
  nativeAudioPause: () => ipcRenderer.invoke(IpcChannels.NativeAudioPause),
  nativeAudioSeek: (positionSeconds) =>
    ipcRenderer.invoke(IpcChannels.NativeAudioSeek, positionSeconds),
  nativeAudioSetVolume: (volume) =>
    ipcRenderer.invoke(IpcChannels.NativeAudioSetVolume, volume),
  nativeAudioSetLoop: (loop) =>
    ipcRenderer.invoke(IpcChannels.NativeAudioSetLoop, loop),
  nativeAudioSetPlaybackRate: (playbackRate) =>
    ipcRenderer.invoke(IpcChannels.NativeAudioSetPlaybackRate, playbackRate),
  nativeAudioDispose: () => ipcRenderer.invoke(IpcChannels.NativeAudioDispose),
  nativeAudioEventListener: (func) => {
    ipcRenderer.on(IpcChannels.NativeAudioEvent, (_, event: NativeAudioEvent) =>
      func(event),
    )
  },
  removeNativeAudioEventListener: () => {
    ipcRenderer.removeAllListeners(IpcChannels.NativeAudioEvent)
  },
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-expect-error (define in dts)
  window.electron = electronAPI
  // @ts-expect-error (define in dts)
  window.api = api
}
