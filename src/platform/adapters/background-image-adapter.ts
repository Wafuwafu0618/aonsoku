import { isDesktop } from '@/platform/capabilities'
import type { BackgroundImageFileEntry } from '@/platform/contracts/desktop-contract'

export async function pickBackgroundImageFile(): Promise<BackgroundImageFileEntry | null> {
  if (!isDesktop()) return null

  return window.api.pickBackgroundImageFile()
}
