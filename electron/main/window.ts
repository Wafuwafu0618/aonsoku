import { is, platform } from '@electron-toolkit/utils'
import { BrowserWindow } from 'electron'
import { join } from 'path'
import { electron } from '../../package.json'
import { colorsState } from './core/colors'
import { setupDownloads } from './core/downloads'
import { setupEvents, setupIpcEvents } from './core/events'
import { appIcon } from './core/icon'
import { titleBarOverlay } from './core/titleBarOverlay'
import { setUpdaterWindow } from './core/updater'
import { StatefulBrowserWindow } from './core/windowPosition'
import { createTray } from './tray'

export let mainWindow: BrowserWindow | null = null

const { defaultWidth, defaultHeight, defaultBgColor } = electron.window

function applyWindowTransparencyMaterial(window: BrowserWindow) {
  if (platform.isWindows) {
    ;(
      window as BrowserWindow & {
        setBackgroundMaterial?: (
          material: 'auto' | 'none' | 'mica' | 'acrylic' | 'tabbed',
        ) => void
      }
    ).setBackgroundMaterial?.('acrylic')
  }

  if (platform.isMacOS) {
    window.setVibrancy('under-window')
  }
}

export function createWindow(): void {
  const backgroundColor = colorsState.get('bgColor') ?? defaultBgColor
  const useTransparentWindow = platform.isWindows || platform.isMacOS

  mainWindow = new StatefulBrowserWindow({
    width: defaultWidth,
    height: defaultHeight,
    minWidth: defaultWidth,
    minHeight: defaultHeight,
    backgroundColor: useTransparentWindow ? '#00000000' : backgroundColor,
    transparent: useTransparentWindow,
    supportMaximize: true,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    visualEffectState: 'followWindow',
    roundedCorners: true,
    frame: false,
    ...(platform.isWindows ? { titleBarOverlay } : {}),
    trafficLightPosition: { x: 15, y: 14 },
    icon: appIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
    },
  })

  applyWindowTransparencyMaterial(mainWindow)

  createTray()
  setupEvents(mainWindow)
  setupIpcEvents(mainWindow)
  setupDownloads(mainWindow)
  setUpdaterWindow(mainWindow)

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'), {
      hash: '/',
    })
  }
}
