import { useQueryClient } from '@tanstack/react-query'
import { FolderPlus, RefreshCw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Content,
  ContentItem,
  ContentItemForm,
  ContentItemTitle,
  ContentSeparator,
  Header,
  HeaderDescription,
  HeaderTitle,
  Root,
} from '@/app/components/settings/section'
import { Button } from '@/app/components/ui/button'
import {
  getDefaultScanner,
  getLastScanTime,
  getLibraryStats,
  LocalLibraryScanner,
  removeTracksByDirectory,
} from '@/local-library'
import { pickLocalLibraryDirectory } from '@/platform'
import {
  useLocalLibraryActions,
  useLocalLibraryDirectories,
  useLocalLibraryStatus,
} from '@/store/local-library.store'
import { queryKeys } from '@/utils/queryKeys'

type LibraryStats = {
  totalTracks: number
  totalArtists: number
  totalAlbums: number
}

function normalizeDirectoryPath(path: string): string {
  return path.replace(/[\\/]+$/, '').toLowerCase()
}

export function LocalLibraryContent() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const scanner = useMemo<LocalLibraryScanner>(() => getDefaultScanner(), [])
  const directories = useLocalLibraryDirectories()
  const { isScanning, progress, lastScanAt } = useLocalLibraryStatus()
  const {
    addDirectory,
    removeDirectory,
    setScanning,
    setProgress,
    setLastScanAt,
  } = useLocalLibraryActions()
  const [stats, setStats] = useState<LibraryStats>({
    totalTracks: 0,
    totalArtists: 0,
    totalAlbums: 0,
  })
  const [isUpdatingLibrary, setIsUpdatingLibrary] = useState(false)

  const refreshLibrarySummary = useCallback(async () => {
    const [scanTime, libraryStats] = await Promise.all([
      getLastScanTime(),
      getLibraryStats(),
    ])

    setLastScanAt(scanTime)
    setStats({
      totalTracks: libraryStats.totalTracks,
      totalArtists: libraryStats.totalArtists,
      totalAlbums: libraryStats.totalAlbums,
    })
  }, [setLastScanAt])

  useEffect(() => {
    let mounted = true

    async function initialize() {
      if (!mounted) return
      await refreshLibrarySummary()
      if (!mounted) return
    }

    initialize().catch(() => {
      // ignore initialization errors to keep settings page usable
    })

    return () => {
      mounted = false
    }
  }, [refreshLibrarySummary])

  async function handleAddDirectory() {
    const selected = await pickLocalLibraryDirectory()
    if (!selected) return

    addDirectory(selected.path)
  }

  async function handleStartScan() {
    if (directories.length === 0 || isUpdatingLibrary) return

    setScanning(true)
    setProgress({
      totalFiles: 0,
      processedFiles: 0,
      foundTracks: 0,
      status: 'scanning',
    })

    try {
      await scanner.scan(
        directories,
        (scanProgress) => {
          setProgress({
            totalFiles: scanProgress.totalFiles,
            processedFiles: scanProgress.processedFiles,
            foundTracks: scanProgress.foundTracks,
            status: scanProgress.status,
            currentFile: scanProgress.currentFile,
            errorMessage:
              scanProgress.errors.length > 0
                ? scanProgress.errors[scanProgress.errors.length - 1].error
                : undefined,
          })
        },
        async () => {
          await refreshLibrarySummary()
        },
      )
    } catch (error) {
      setProgress({
        ...progress,
        status: 'error',
        errorMessage:
          error instanceof Error
            ? error.message
            : 'スキャン中に不明なエラーが発生しました',
      })
    } finally {
      setScanning(false)
    }
  }

  async function handleRemoveDirectory(path: string) {
    if (isScanning || isUpdatingLibrary) return

    const normalizedTarget = normalizeDirectoryPath(path)
    const remainingDirectories = directories.filter(
      (directory) => normalizeDirectoryPath(directory) !== normalizedTarget,
    )

    setIsUpdatingLibrary(true)

    try {
      await removeTracksByDirectory(path, remainingDirectories)
      removeDirectory(path)
      await refreshLibrarySummary()

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [queryKeys.song.all] }),
        queryClient.invalidateQueries({ queryKey: [queryKeys.album.all] }),
        queryClient.invalidateQueries({ queryKey: [queryKeys.album.single] }),
        queryClient.invalidateQueries({ queryKey: [queryKeys.artist.all] }),
        queryClient.invalidateQueries({ queryKey: [queryKeys.artist.single] }),
        queryClient.invalidateQueries({
          queryKey: [queryKeys.artist.topSongs],
        }),
      ])
    } catch (error) {
      setProgress({
        ...progress,
        status: 'error',
        errorMessage:
          error instanceof Error
            ? error.message
            : 'ローカルライブラリ更新中に不明なエラーが発生しました',
      })
    } finally {
      setIsUpdatingLibrary(false)
    }
  }

  const progressPercent =
    progress.totalFiles > 0
      ? Math.round((progress.processedFiles / progress.totalFiles) * 100)
      : 0

  return (
    <Root>
      <Header>
        <HeaderTitle>{t('settings.content.localLibrary.group')}</HeaderTitle>
        <HeaderDescription>
          {t('settings.content.localLibrary.description')}
        </HeaderDescription>
      </Header>

      <Content>
        <ContentItem>
          <ContentItemTitle>
            {t('settings.content.localLibrary.directories.label')}
          </ContentItemTitle>
          <ContentItemForm>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleAddDirectory}
              disabled={isScanning || isUpdatingLibrary}
            >
              <FolderPlus className="w-4 h-4 mr-2" />
              {t('settings.content.localLibrary.actions.addDirectory')}
            </Button>
          </ContentItemForm>
        </ContentItem>

        <div className="space-y-2 rounded-md border p-3">
          {directories.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('settings.content.localLibrary.directories.empty')}
            </p>
          ) : (
            directories.map((directory) => (
              <div
                key={directory}
                className="flex items-center justify-between gap-3"
              >
                <span className="text-sm truncate" title={directory}>
                  {directory}
                </span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  onClick={() => handleRemoveDirectory(directory)}
                  disabled={isScanning || isUpdatingLibrary}
                  aria-label={t(
                    'settings.content.localLibrary.actions.removeDirectory',
                  )}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            ))
          )}
        </div>

        <ContentItem>
          <ContentItemTitle>
            {t('settings.content.localLibrary.actions.scan')}
          </ContentItemTitle>
          <ContentItemForm>
            <Button
              type="button"
              size="sm"
              onClick={handleStartScan}
              disabled={isScanning || isUpdatingLibrary || directories.length === 0}
            >
              <RefreshCw
                className={`w-4 h-4 mr-2 ${isScanning ? 'animate-spin' : ''}`}
              />
              {isScanning
                ? t('settings.content.localLibrary.actions.scanning')
                : t('settings.content.localLibrary.actions.startScan')}
            </Button>
          </ContentItemForm>
        </ContentItem>

        <div className="space-y-1 text-sm text-muted-foreground">
          <div>
            {t('settings.content.localLibrary.stats.totalTracks', {
              count: stats.totalTracks,
            })}
          </div>
          <div>
            {t('settings.content.localLibrary.stats.totalArtists', {
              count: stats.totalArtists,
            })}
          </div>
          <div>
            {t('settings.content.localLibrary.stats.totalAlbums', {
              count: stats.totalAlbums,
            })}
          </div>
          <div>
            {lastScanAt
              ? t('settings.content.localLibrary.stats.lastScan', {
                  date: new Date(lastScanAt).toLocaleString('ja-JP'),
                })
              : t('settings.content.localLibrary.stats.lastScanNever')}
          </div>
        </div>

        {(progress.status === 'scanning' || progress.status === 'error') && (
          <div className="space-y-2 rounded-md border p-3">
            <div className="flex justify-between text-sm">
              <span>{t('settings.content.localLibrary.progress.label')}</span>
              <span>
                {progress.processedFiles}/{progress.totalFiles} (
                {progressPercent}
                %)
              </span>
            </div>
            {progress.currentFile && (
              <p
                className="text-xs text-muted-foreground truncate"
                title={progress.currentFile}
              >
                {progress.currentFile}
              </p>
            )}
            {progress.errorMessage && (
              <p className="text-xs text-destructive">
                {progress.errorMessage}
              </p>
            )}
          </div>
        )}
      </Content>

      <ContentSeparator />
    </Root>
  )
}
