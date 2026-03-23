import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'react-toastify'
import { isDesktop } from '@/platform/capabilities'
import { appleMusicService } from '@/service/apple-music'
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

export function AppleMusicContent() {
  const desktop = isDesktop()
  const [isAuthorized, setIsAuthorized] = useState(false)
  const [storefrontId, setStorefrontId] = useState('unknown')
  const [librarySummary, setLibrarySummary] = useState<{
    songs: number
    albums: number
    playlists: number
  } | null>(null)
  const [isInitializing, setIsInitializing] = useState(false)
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false)
  const [isSigningIn, setIsSigningIn] = useState(false)
  const [isCollectingDebugReport, setIsCollectingDebugReport] = useState(false)
  const [lastRequestDebugText, setLastRequestDebugText] = useState('')
  const [debugReportText, setDebugReportText] = useState('')

  async function collectDebugReport(options?: { copyToClipboard?: boolean }) {
    if (!desktop) return null

    setIsCollectingDebugReport(true)
    try {
      const report = await window.api.appleMusicGetDebugReport()
      setDebugReportText(report)

      if (options?.copyToClipboard) {
        await navigator.clipboard.writeText(report)
        toast.success('Apple Music デバッグログをコピーしました。')
      }

      return report
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(`Apple Music デバッグログ取得に失敗: ${reason}`)
      return null
    } finally {
      setIsCollectingDebugReport(false)
    }
  }

  async function handleCopyDebugReport() {
    if (!debugReportText) {
      await collectDebugReport({ copyToClipboard: true })
      return
    }

    try {
      await navigator.clipboard.writeText(debugReportText)
      toast.success('Apple Music デバッグログをコピーしました。')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(`コピーに失敗: ${reason}`)
    }
  }

  async function initializeSession(successMessage: string) {
    setIsInitializing(true)
    try {
      await appleMusicService.initialize()
      setIsAuthorized(appleMusicService.isAuthorized())
      setStorefrontId(appleMusicService.getStorefrontId())
      toast.success(successMessage)
      return true
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(`Apple Music 初期化に失敗: ${reason}`)
      setIsAuthorized(false)
      return false
    } finally {
      setIsInitializing(false)
    }
  }

  async function handleInitialize() {
    await initializeSession('Apple Music セッションを確認しました。')
  }

  async function handleSignIn() {
    if (!desktop) return

    setIsSigningIn(true)
    try {
      const result = await window.api.appleMusicOpenSignInWindow()
      if (!result.ok) {
        const code = result.error?.code ?? 'unknown'
        const message = result.error?.message ?? 'Apple Music サインインに失敗しました。'

        if (code === 'cancelled') {
          toast.info('Apple Music サインインをキャンセルしました。')
        } else if (code === 'timeout') {
          toast.error('Apple Music サインインがタイムアウトしました。再度お試しください。')
          await collectDebugReport()
        } else {
          toast.error(`Apple Music サインインに失敗: ${message}`)
          await collectDebugReport()
        }
        return
      }
      await initializeSession('Apple Music サインインが完了しました。')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(`Apple Music サインイン処理に失敗: ${reason}`)
      await collectDebugReport()
    } finally {
      setIsSigningIn(false)
    }
  }

  async function handleLoadLibrarySummary() {
    setIsLoadingLibrary(true)
    setLastRequestDebugText('')
    try {
      if (!appleMusicService.isAuthorized()) {
        try {
          await appleMusicService.initialize()
          setIsAuthorized(appleMusicService.isAuthorized())
          setStorefrontId(appleMusicService.getStorefrontId())
        } catch {
          // let getLibrary surface the concrete error
        }
      }
      const result = await appleMusicService.getLibrary()

      setLibrarySummary({
        songs: result.songs.length,
        albums: result.albums.length,
        playlists: result.playlists.length,
      })
      setLastRequestDebugText('')
      setIsAuthorized(appleMusicService.isAuthorized())
      toast.success('Apple Music ライブラリ情報を取得しました。')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const normalizedReason = reason.toLowerCase()
      const isUnauthorized =
        normalizedReason.includes('401') ||
        normalizedReason.includes('status code: 401')

      if (desktop && isUnauthorized) {
        const debug = await window.api
          .appleMusicGetLastRequestDebug()
          .catch(() => null)

        if (debug) {
          const hasAuthorization = Boolean(debug.headers.authorization)
          const hasMusicUserToken = Boolean(debug.headers['music-user-token'])
          const hasMediaUserToken = Boolean(debug.headers['media-user-token'])
          const hasAnyUserToken = hasMusicUserToken || hasMediaUserToken
          const headerLines = Object.entries(debug.headers)
            .map(([key, value]) => `${key}: ${value}`)
            .join('\n')
          const debugText = [
            `time: ${new Date(debug.timestampMs).toISOString()}`,
            `status: ${debug.statusCode ?? 'unknown'}`,
            `method: ${debug.method}`,
            `url: ${debug.url}`,
            headerLines,
          ]
            .filter((line) => line.length > 0)
            .join('\n')

          console.info('[Apple Music] last request debug', debug)
          setLastRequestDebugText(debugText)
          toast.error(
            `Apple Music ライブラリ取得に失敗: 401 (status=${debug.statusCode ?? 'unknown'}, Authorization=${hasAuthorization ? 'present' : 'missing'}, Music-User-Token=${hasMusicUserToken ? 'present' : 'missing'}, Media-User-Token=${hasMediaUserToken ? 'present' : 'missing'}, UserToken(any)=${hasAnyUserToken ? 'present' : 'missing'})`,
          )
          return
        }
      }

      toast.error(`Apple Music ライブラリ取得に失敗: ${reason}`)
    } finally {
      setIsLoadingLibrary(false)
    }
  }

  return (
    <Root>
      <Header>
        <HeaderTitle>Apple Music</HeaderTitle>
        <HeaderDescription>
          MusicKit JS を使って Apple Music の検索・ブラウズと再生準備を行います。
          再生パイプライン自体は別実装です。
        </HeaderDescription>
      </Header>

      <Content>
        <ContentItem>
          <ContentItemTitle>Apple Music Sign-In</ContentItemTitle>
          <ContentItemForm className="max-w-none w-3/5 justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              Apple ID でログインして、music.apple.com のセッションをアプリで利用します。サインインウィンドウは自動で閉じません。
            </span>
            <Button
              type="button"
              size="sm"
              onClick={handleSignIn}
              disabled={!desktop || isSigningIn || isInitializing}
            >
              {isSigningIn ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  サインイン中...
                </>
              ) : (
                'Apple Music にサインイン'
              )}
            </Button>
          </ContentItemForm>
        </ContentItem>

        {!desktop && (
          <p className="text-xs text-muted-foreground">
            Apple Music のサインイン機能はデスクトップ(Electron)環境でのみ利用できます。
          </p>
        )}

        <p className="text-xs text-muted-foreground">
          このモードでは Developer Token / Music User Token の手動入力は不要です。
          music.apple.com のログインセッションをそのまま利用します。
        </p>

        <ContentItem>
          <ContentItemTitle>Connection</ContentItemTitle>
          <ContentItemForm className="max-w-none w-3/5 justify-between gap-3">
            <div className="text-xs text-muted-foreground flex items-center gap-2">
              {isAuthorized ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              ) : (
                <XCircle className="w-4 h-4 text-rose-500" />
              )}
              <span>
                {isAuthorized ? 'Authorized' : 'Not authorized'} / storefront:{' '}
                {storefrontId}
              </span>
            </div>
            <Button
              type="button"
              size="sm"
              onClick={handleInitialize}
              disabled={isInitializing || isSigningIn}
            >
              {isInitializing ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  Initializing...
                </>
              ) : (
                'Initialize'
              )}
            </Button>
          </ContentItemForm>
        </ContentItem>
      </Content>

      <ContentSeparator />

      <Content>
        <ContentItem>
          <ContentItemTitle>Account Library Check</ContentItemTitle>
          <ContentItemForm className="max-w-none w-3/5 justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              {librarySummary
                ? `Songs: ${librarySummary.songs} / Albums: ${librarySummary.albums} / Playlists: ${librarySummary.playlists}`
                : '未取得'}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleLoadLibrarySummary}
              disabled={isLoadingLibrary || isInitializing || isSigningIn}
            >
              {isLoadingLibrary ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  Loading...
                </>
              ) : (
                'Check'
              )}
            </Button>
          </ContentItemForm>
          {lastRequestDebugText ? (
            <pre className="mt-3 w-3/5 whitespace-pre-wrap break-all rounded-md border bg-muted/30 p-2 text-[11px] text-muted-foreground">
              {lastRequestDebugText}
            </pre>
          ) : null}
        </ContentItem>
      </Content>

      <ContentSeparator />

      <Content>
        <ContentItem>
          <ContentItemTitle>Debug Report (Copy/Paste)</ContentItemTitle>
          <ContentItemForm className="max-w-none w-3/5 justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              サインイン判定トレース、セッションCookie概要、最終APIリクエスト情報を1つのテキストで取得します。
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void collectDebugReport()}
                disabled={!desktop || isCollectingDebugReport || isSigningIn}
              >
                {isCollectingDebugReport ? (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                    Collecting...
                  </>
                ) : (
                  'Collect Debug Log'
                )}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void handleCopyDebugReport()}
                disabled={!desktop || isCollectingDebugReport || isSigningIn}
              >
                Copy Debug Log
              </Button>
            </div>
          </ContentItemForm>
          {debugReportText ? (
            <pre className="mt-3 w-3/5 whitespace-pre-wrap break-all rounded-md border bg-muted/30 p-2 text-[11px] text-muted-foreground">
              {debugReportText}
            </pre>
          ) : null}
        </ContentItem>
      </Content>
    </Root>
  )
}
