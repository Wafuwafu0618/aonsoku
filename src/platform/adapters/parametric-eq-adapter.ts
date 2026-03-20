import { isDesktop } from '@/platform/capabilities'
import type { ParametricEqFileEntry } from '@/platform/contracts/desktop-contract'

export async function pickParametricEqFile(): Promise<ParametricEqFileEntry | null> {
  if (!isDesktop()) return null

  return window.api.pickParametricEqFile()
}
