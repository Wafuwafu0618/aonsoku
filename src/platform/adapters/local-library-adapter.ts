import { isDesktop } from '@/platform/capabilities'
import type {
  LocalLibraryDirectoryEntry,
  LocalLibraryFileContent,
  LocalLibraryFileEntry,
} from '@/platform/contracts/desktop-contract'

export async function pickLocalLibraryDirectory(): Promise<LocalLibraryDirectoryEntry | null> {
  if (!isDesktop()) return null

  return window.api.pickLocalLibraryDirectory()
}

export async function listLocalLibraryFiles(
  directories: string[],
): Promise<LocalLibraryFileEntry[]> {
  if (!isDesktop()) return []

  return window.api.listLocalLibraryFiles(directories)
}

export async function readLocalLibraryFile(
  path: string,
): Promise<LocalLibraryFileContent> {
  if (!isDesktop()) {
    throw new Error(
      'ローカルライブラリ読み込みはデスクトップ環境でのみ利用可能です',
    )
  }

  return window.api.readLocalLibraryFile(path)
}
