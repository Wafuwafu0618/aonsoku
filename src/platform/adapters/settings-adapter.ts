import { isDesktop } from '@/platform/capabilities'
import type { ISettingPayload } from '@/platform/contracts/desktop-contract'

/**
 * Settings Adapter
 *
 * アプリ設定の永続化の抽象化
 */

/**
 * アプリ設定を保存
 */
export function saveAppSettings(payload: ISettingPayload): void {
  if (!isDesktop()) return

  window.api.saveAppSettings(payload)
}
