import { Theme } from '@/types/themeContext'
import { isDesktop } from './desktop'
import { hslToHex, hslToHsla } from './getAverageColor'

const DEFAULT_TITLE_BAR_COLOR = '#ff000000'
const DEFAULT_TITLE_BAR_SYMBOL = '#ffffff'

export function setDesktopTitleBarColors(transparent = false) {
  if (!isDesktop()) return

  let color = DEFAULT_TITLE_BAR_COLOR
  let symbol = DEFAULT_TITLE_BAR_SYMBOL

  const root = window.document.documentElement
  const styles = getComputedStyle(root)

  if (!transparent) {
    const isMinatoWave = root.classList.contains('minato-wave')
    symbol = hslToHsla(styles.getPropertyValue('--foreground').trim())

    // Keep native Windows caption buttons visually aligned with the themed
    // header by letting the web header paint the background in Minato Wave.
    color = isMinatoWave
      ? '#00000000'
      : hslToHsla(styles.getPropertyValue('--background').trim(), 1)
  }

  const bgColor = hslToHex(styles.getPropertyValue('--background').trim())

  window.api.setTitleBarOverlayColors({
    color,
    symbol,
    bgColor,
  })
}

export function getValidThemeFromEnv(): Theme | null {
  const { APP_THEME } = window

  if (APP_THEME && Object.values(Theme).includes(APP_THEME as Theme)) {
    return APP_THEME as Theme
  }

  return null
}
