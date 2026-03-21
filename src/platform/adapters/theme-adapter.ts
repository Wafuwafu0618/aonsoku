import { isDesktop } from '@/platform/capabilities'
import { Theme } from '@/types/themeContext'
import { hslToHex, hslToHsla } from '@/utils/getAverageColor'

/**
 * Theme Adapter
 *
 * タイトルバー色・ネイティブテーマの抽象化
 */

const DEFAULT_TITLE_BAR_COLOR = '#ff000000'
const DEFAULT_TITLE_BAR_SYMBOL = '#ffffff'

/**
 * タイトルバー色を設定
 * @param transparent - 透明モード（Big Player時等）
 */
export function setTitleBarColors(transparent = false): void {
  if (!isDesktop()) return

  let color = DEFAULT_TITLE_BAR_COLOR
  let symbol = DEFAULT_TITLE_BAR_SYMBOL

  const root = window.document.documentElement
  const styles = getComputedStyle(root)

  if (!transparent) {
    const isMinatoWave = root.classList.contains('minato-wave')
    symbol = hslToHsla(styles.getPropertyValue('--foreground').trim())
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

/**
 * ネイティブテーマを設定
 * @param isDark - ダークモードかどうか
 */
export function setNativeTheme(isDark: boolean): void {
  if (!isDesktop()) return

  window.api.setNativeTheme(isDark)
}

/**
 * 環境変数から有効なテーマを取得
 */
export function getValidThemeFromEnv(): Theme | null {
  const { APP_THEME } = window

  if (APP_THEME && Object.values(Theme).includes(APP_THEME as Theme)) {
    return APP_THEME as Theme
  }

  return null
}

// 後方互換性のためのエクスポート
export { setTitleBarColors as setDesktopTitleBarColors }
