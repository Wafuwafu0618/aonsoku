import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'react-toastify'
import { isDesktop } from '@/platform/capabilities'
import { appleMusicService, resolveAppleMusicErrorCode } from '@/service/apple-music'
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
  const [operationStatusText, setOperationStatusText] = useState('待機中')
  const [hasOperationalIssue, setHasOperationalIssue] = useState(false)
  const [isDiagnosticsExpanded, setIsDiagnosticsExpanded] = useState(false)
  const [lastRequestDebugText, setLastRequestDebugText] = useState('')
  const [debugReportText, setDebugReportText] = useState('')
  const hasDiagnosticsData =
    lastRequestDebugText.trim().length > 0 || debugReportText.trim().length > 0
  const diagnosticsText = [
    lastRequestDebugText
      ? `=== Last Request Debug ===\n${lastRequestDebugText}`
      : '',
    debugReportText
      ? `=== Apple Music Debug Report ===\n${debugReportText}`
      : '',
  ]
    .filter((entry) => entry.length > 0)
    .join('\n\n')

  function inferCodeFromMessage(message: string): string {
    const normalized = message.toLowerCase()
    if (
      normalized.includes('timed out') ||
      normalized.includes('timeout') ||
      normalized.includes('タイムアウト')
    ) {
      return 'timeout'
    }
    if (
      normalized.includes('cancelled') ||
      normalized.includes('canceled') ||
      normalized.includes('キャンセル')
    ) {
      return 'cancelled'
    }
    if (normalized.includes('invoke-failed')) return 'invoke-failed'
    if (normalized.includes('parse-failed')) return 'parse-failed'
    return 'unknown'
  }

  function classifyError(error: unknown): { code: string; reason: string } {
    const reason = error instanceof Error ? error.message : String(error)
    const serviceCode = String(resolveAppleMusicErrorCode(error)).trim().toLowerCase()
    const code = serviceCode.length > 0 && serviceCode !== 'unknown'
      ? serviceCode
      : inferCodeFromMessage(reason)
    return { code, reason }
  }

  function classifyErrorFromResult(
    codeLike: string | undefined,
    message: string,
  ): { code: string; reason: string } {
    const normalizedCode = String(codeLike ?? '').trim().toLowerCase()
    if (normalizedCode.length > 0) {
      return { code: normalizedCode, reason: message }
    }
    return { code: inferCodeFromMessage(message), reason: message }
  }

  function showClassifiedErrorToast(scope: string, code: string, reason: string) {
    switch (code) {
      case 'cancelled':
        toast.info(`${scope}をキャンセルしました。`)
        return
      case 'timeout':
        toast.error(`${scope}がタイムアウトしました。再度お試しください。`)
        return
      case 'invoke-failed':
        toast.error(`${scope}に失敗: セッション実行に失敗しました。`)
        return
      case 'parse-failed':
        toast.error(`${scope}に失敗: レスポンス解析に失敗しました。`)
        return
      case 'unauthorized':
        toast.error(`${scope}に失敗: Apple Music セッションが未認証です。`)
        return
      case 'desktop-only':
        toast.error(`${scope}に失敗: Desktop(Electron) 環境でのみ利用できます。`)
        return
      default:
        toast.error(`${scope}に失敗: ${reason}`)
    }
  }

  async function collectDebugReport(options?: {
    copyToClipboard?: boolean
    preserveOperationStatus?: boolean
  }) {
    if (!desktop) return null

    if (!options?.preserveOperationStatus) {
      setOperationStatusText('Debug Report: 収集中...')
    }
    setIsCollectingDebugReport(true)
    try {
      const report = await window.api.appleMusicGetDebugReport()
      setDebugReportText(report)
      setHasOperationalIssue(true)
      if (!options?.preserveOperationStatus) {
        setOperationStatusText('Debug Report: 取得完了')
      }

      if (options?.copyToClipboard) {
        await navigator.clipboard.writeText(report)
        toast.success('Apple Music デバッグログをコピーしました。')
      }

      return report
    } catch (error) {
      const { code, reason } = classifyError(error)
      if (!options?.preserveOperationStatus) {
        setOperationStatusText(`Debug Report: 失敗 (${code})`)
      }
      showClassifiedErrorToast('Apple Music デバッグログ取得', code, reason)
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

  async function initializeSession(
    successMessage: string,
    options?: { progressPrefix?: string },
  ) {
    const progressPrefix = options?.progressPrefix ?? 'Initialize'
    setOperationStatusText(`${progressPrefix}: セッション状態を確認中...`)
    setIsInitializing(true)
    try {
      await appleMusicService.initialize()
      setIsAuthorized(appleMusicService.isAuthorized())
      setStorefrontId(appleMusicService.getStorefrontId())
      setHasOperationalIssue(false)
      toast.success(successMessage)
      setOperationStatusText(
        `${progressPrefix}: 完了 (Authorized / storefront: ${appleMusicService.getStorefrontId()})`,
      )
      return true
    } catch (error) {
      const { code, reason } = classifyError(error)
      setHasOperationalIssue(true)
      setOperationStatusText(`${progressPrefix}: 失敗 (${code})`)
      showClassifiedErrorToast('Apple Music 初期化', code, reason)
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

    setOperationStatusText('Sign-In: Apple ID の操作を待機しています...')
    setIsSigningIn(true)
    try {
      const result = await window.api.appleMusicOpenSignInWindow()
      if (!result.ok) {
        const message = result.error?.message ?? 'Apple Music サインインに失敗しました。'
        const { code, reason } = classifyErrorFromResult(result.error?.code, message)
        setHasOperationalIssue(true)
        setOperationStatusText(`Sign-In: 失敗 (${code})`)
        showClassifiedErrorToast('Apple Music サインイン', code, reason)
        if (code !== 'cancelled') {
          await collectDebugReport({ preserveOperationStatus: true })
        }
        return
      }
      setOperationStatusText('Sign-In: 認証完了。Initialize を実行中...')
      const initialized = await initializeSession(
        'Apple Music サインインが完了しました。',
        { progressPrefix: 'Sign-In -> Initialize' },
      )
      if (initialized) {
        setHasOperationalIssue(false)
        setOperationStatusText('Sign-In -> Initialize: 完了')
      }
    } catch (error) {
      const { code, reason } = classifyError(error)
      setHasOperationalIssue(true)
      setOperationStatusText(`Sign-In: 失敗 (${code})`)
      showClassifiedErrorToast('Apple Music サインイン処理', code, reason)
      await collectDebugReport({ preserveOperationStatus: true })
    } finally {
      setIsSigningIn(false)
    }
  }

  async function handleLoadLibrarySummary() {
    setOperationStatusText('Library Check: ライブラリ情報を取得中...')
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
      setHasOperationalIssue(false)
      setOperationStatusText(
        `Library Check: 完了 (Songs: ${result.songs.length}, Albums: ${result.albums.length}, Playlists: ${result.playlists.length})`,
      )
      setLastRequestDebugText('')
      setIsAuthorized(appleMusicService.isAuthorized())
      toast.success('Apple Music ライブラリ情報を取得しました。')
    } catch (error) {
      const { code, reason } = classifyError(error)
      setHasOperationalIssue(true)
      setOperationStatusText(`Library Check: 失敗 (${code})`)
      const normalizedReason = reason.toLowerCase()
      const isUnauthorized =
        normalizedReason.includes('401') ||
        normalizedReason.includes('status code: 401')

      if (desktop && isUnauthorized) {
        const debug = await window.api
          .appleMusicGetLastRequestDebug()
          .catch(() => null)

        if (debug) {
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
          toast.error('Apple Music ライブラリ取得に失敗: 401')
          return
        }
      }

      showClassifiedErrorToast('Apple Music ライブラリ取得', code, reason)
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
        <p className="text-xs text-muted-foreground">
          進行状態: {operationStatusText}
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
        </ContentItem>
      </Content>

      <ContentSeparator />

      <Content>
        <ContentItem>
          <ContentItemTitle>Diagnostics (On-demand)</ContentItemTitle>
          <ContentItemForm className="max-w-none w-3/5 justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              通常時は詳細ログを表示しません。問題時のみ Collect して必要なら詳細を展開してください。
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
                disabled={
                  !desktop ||
                  isCollectingDebugReport ||
                  isSigningIn ||
                  !hasDiagnosticsData
                }
              >
                Copy Debug Log
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setIsDiagnosticsExpanded((current) => !current)}
                disabled={!hasDiagnosticsData && !hasOperationalIssue}
              >
                {isDiagnosticsExpanded ? 'Hide Details' : 'Show Details'}
              </Button>
            </div>
          </ContentItemForm>
          {hasOperationalIssue && !hasDiagnosticsData ? (
            <p className="mt-3 w-3/5 text-[11px] text-muted-foreground">
              問題を検知しました。必要に応じて `Collect Debug Log` を実行してください。
            </p>
          ) : null}
          {isDiagnosticsExpanded && diagnosticsText ? (
            <pre className="mt-3 w-3/5 whitespace-pre-wrap break-all rounded-md border bg-muted/30 p-2 text-[11px] text-muted-foreground">
              {diagnosticsText}
            </pre>
          ) : null}
        </ContentItem>
      </Content>
    </Root>
  )
}
