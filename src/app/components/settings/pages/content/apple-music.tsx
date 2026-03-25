import { CheckCircle2, RefreshCw, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'react-toastify'
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
import { Badge } from '@/app/components/ui/badge'
import { Button } from '@/app/components/ui/button'
import { Input } from '@/app/components/ui/input'
import { isDesktop } from '@/platform/capabilities'
import {
  appleMusicService,
  resolveAppleMusicErrorCode,
} from '@/service/apple-music'
import { useAppleMusicFavoriteGenres } from '@/store/app.store'

// よくある音楽ジャンルのリスト
const AVAILABLE_GENRES = [
  'J-Pop',
  'アニメ',
  'ロック',
  'ポップ',
  'ヒップホップ',
  'R&B',
  'クラシック',
  'ジャズ',
  'エレクトロニック',
  'K-Pop',
  '洋楽',
  'ボーカロイド',
  'ゲーム音楽',
  'サウンドトラック',
  'メタル',
  'フォーク',
  'インディー',
  'レゲエ',
  'ブルース',
  'ラテン',
]

type WrapperStatus = Awaited<
  ReturnType<typeof window.api.appleMusicWrapperGetStatus>
>

export function AppleMusicContent() {
  const desktop = isDesktop()
  const { genres: favoriteGenres, setGenres: setFavoriteGenres } =
    useAppleMusicFavoriteGenres()
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
  const [wrapperStatus, setWrapperStatus] = useState<WrapperStatus | null>(null)
  const [wrapperStatusText, setWrapperStatusText] = useState('未確認')
  const [wrapperUsername, setWrapperUsername] = useState('')
  const [wrapperPassword, setWrapperPassword] = useState('')
  const [wrapperTwoFactorCode, setWrapperTwoFactorCode] = useState('')
  const [wrapperLogsText, setWrapperLogsText] = useState('')
  const [wrapperMusicTokenPreview, setWrapperMusicTokenPreview] = useState('')
  const [isRefreshingWrapperStatus, setIsRefreshingWrapperStatus] =
    useState(false)
  const [isWrapperBuilding, setIsWrapperBuilding] = useState(false)
  const [isWrapperServiceStarting, setIsWrapperServiceStarting] =
    useState(false)
  const [isWrapperServiceStopping, setIsWrapperServiceStopping] =
    useState(false)
  const [isWrapperLoginStarting, setIsWrapperLoginStarting] = useState(false)
  const [isWrapperLoginStopping, setIsWrapperLoginStopping] = useState(false)
  const [isWrapperCodeSubmitting, setIsWrapperCodeSubmitting] = useState(false)
  const [isWrapperLogsLoading, setIsWrapperLogsLoading] = useState(false)
  const isWrapperServiceRunning = wrapperStatus?.service.state === 'running'
  const isWrapperLoginRunning = wrapperStatus?.login.state === 'running'
  const wrapperReadyForPlayback =
    wrapperStatus?.imageExists &&
    wrapperStatus?.hasMusicToken &&
    wrapperStatus?.accountReachable &&
    isWrapperServiceRunning
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
    const serviceCode = String(resolveAppleMusicErrorCode(error))
      .trim()
      .toLowerCase()
    const code =
      serviceCode.length > 0 && serviceCode !== 'unknown'
        ? serviceCode
        : inferCodeFromMessage(reason)
    return { code, reason }
  }

  function classifyErrorFromResult(
    codeLike: string | undefined,
    message: string,
  ): { code: string; reason: string } {
    const normalizedCode = String(codeLike ?? '')
      .trim()
      .toLowerCase()
    if (normalizedCode.length > 0) {
      return { code: normalizedCode, reason: message }
    }
    return { code: inferCodeFromMessage(message), reason: message }
  }

  function showClassifiedErrorToast(
    scope: string,
    code: string,
    reason: string,
  ) {
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
        toast.error(
          `${scope}に失敗: Desktop(Electron) 環境でのみ利用できます。`,
        )
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
        const message =
          result.error?.message ?? 'Apple Music サインインに失敗しました。'
        const { code, reason } = classifyErrorFromResult(
          result.error?.code,
          message,
        )
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

  async function refreshWrapperStatus(options?: { silent?: boolean }) {
    if (!desktop) return

    if (!options?.silent) {
      setIsRefreshingWrapperStatus(true)
      setWrapperStatusText('Wrapper Status: 取得中...')
    }

    try {
      const [nextStatus, tokenPreview] = await Promise.all([
        window.api.appleMusicWrapperGetStatus(),
        window.api.appleMusicWrapperGetMusicTokenPreview(),
      ])
      setWrapperStatus(nextStatus)
      setWrapperMusicTokenPreview(tokenPreview)
      setWrapperStatusText(
        `Wrapper Status: docker=${nextStatus.dockerAvailable ? 'ok' : 'ng'} service=${nextStatus.service.state} login=${nextStatus.login.state} reachable=${nextStatus.accountReachable ? 'yes' : 'no'}`,
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      setWrapperStatusText(`Wrapper Status: 失敗 (${reason})`)
      if (!options?.silent) {
        toast.error(`Wrapper状態取得に失敗: ${reason}`)
      }
    } finally {
      if (!options?.silent) {
        setIsRefreshingWrapperStatus(false)
      }
    }
  }

  async function handleWrapperBuildImage() {
    setIsWrapperBuilding(true)
    try {
      const result = await window.api.appleMusicWrapperBuildImage()
      if (!result.ok) {
        toast.error(`Wrapperイメージ作成に失敗: ${result.message}`)
      } else {
        toast.success('Wrapperイメージを作成しました。')
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(`Wrapperイメージ作成に失敗: ${reason}`)
    } finally {
      setIsWrapperBuilding(false)
      await refreshWrapperStatus({ silent: true })
    }
  }

  async function handleWrapperStartService() {
    setIsWrapperServiceStarting(true)
    try {
      const result = await window.api.appleMusicWrapperStartService()
      if (!result.ok) {
        toast.error(`Wrapper起動に失敗: ${result.message}`)
      } else {
        toast.success('Wrapperサービスを起動しました。')
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(`Wrapper起動に失敗: ${reason}`)
    } finally {
      setIsWrapperServiceStarting(false)
      await refreshWrapperStatus({ silent: true })
    }
  }

  async function handleWrapperStopService() {
    setIsWrapperServiceStopping(true)
    try {
      const result = await window.api.appleMusicWrapperStopService()
      if (!result.ok) {
        toast.error(`Wrapper停止に失敗: ${result.message}`)
      } else {
        toast.success('Wrapperサービスを停止しました。')
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(`Wrapper停止に失敗: ${reason}`)
    } finally {
      setIsWrapperServiceStopping(false)
      await refreshWrapperStatus({ silent: true })
    }
  }

  async function handleWrapperStartLogin() {
    if (!wrapperUsername.trim() || !wrapperPassword) {
      toast.error('Apple IDとパスワードを入力してください。')
      return
    }

    setIsWrapperLoginStarting(true)
    try {
      const result = await window.api.appleMusicWrapperStartLogin({
        username: wrapperUsername.trim(),
        password: wrapperPassword,
      })
      if (!result.ok) {
        toast.error(`Wrapperログイン開始に失敗: ${result.message}`)
      } else {
        toast.success('Wrapperログインを開始しました。SMS/2FAコードを入力してください。')
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(`Wrapperログイン開始に失敗: ${reason}`)
    } finally {
      setIsWrapperLoginStarting(false)
      await refreshWrapperStatus({ silent: true })
    }
  }

  async function handleWrapperStopLogin() {
    setIsWrapperLoginStopping(true)
    try {
      const result = await window.api.appleMusicWrapperStopLogin()
      if (!result.ok) {
        toast.error(`Wrapperログイン停止に失敗: ${result.message}`)
      } else {
        toast.success('Wrapperログインコンテナを停止しました。')
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(`Wrapperログイン停止に失敗: ${reason}`)
    } finally {
      setIsWrapperLoginStopping(false)
      await refreshWrapperStatus({ silent: true })
    }
  }

  async function handleWrapperSubmitTwoFactorCode() {
    if (!wrapperTwoFactorCode.trim()) {
      toast.error('2FAコードを入力してください。')
      return
    }

    setIsWrapperCodeSubmitting(true)
    try {
      const result = await window.api.appleMusicWrapperSubmitTwoFactorCode(
        wrapperTwoFactorCode.trim(),
      )
      if (!result.ok) {
        toast.error(`2FAコード送信に失敗: ${result.message}`)
      } else {
        toast.success('2FAコードを送信しました。ログイン完了を待ってください。')
        setWrapperTwoFactorCode('')
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(`2FAコード送信に失敗: ${reason}`)
    } finally {
      setIsWrapperCodeSubmitting(false)
      await refreshWrapperStatus({ silent: true })
    }
  }

  async function handleLoadWrapperLogs() {
    setIsWrapperLogsLoading(true)
    try {
      const target = wrapperStatus?.login.state === 'running' ? 'login' : 'service'
      const result = await window.api.appleMusicWrapperGetLogs(target)
      if (!result.ok) {
        toast.error(`Wrapperログ取得に失敗: ${result.message}`)
      }
      setWrapperLogsText(result.logs || '')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(`Wrapperログ取得に失敗: ${reason}`)
    } finally {
      setIsWrapperLogsLoading(false)
    }
  }

  useEffect(() => {
    if (!desktop) return
    void refreshWrapperStatus({ silent: true })
  }, [desktop])

  return (
    <Root>
      <Header>
        <HeaderTitle>Apple Music</HeaderTitle>
        <HeaderDescription>
          MusicKit JS を使って Apple Music
          の検索・ブラウズと再生準備を行います。
          再生パイプライン自体は別実装です。
        </HeaderDescription>
      </Header>

      <Content>
        <ContentItem>
          <ContentItemTitle>Apple Music Sign-In</ContentItemTitle>
          <ContentItemForm className="max-w-none w-3/5 justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              Apple ID でログインして、music.apple.com
              のセッションをアプリで利用します。サインインウィンドウは自動で閉じません。
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
            Apple Music
            のサインイン機能はデスクトップ(Electron)環境でのみ利用できます。
          </p>
        )}

        <p className="text-xs text-muted-foreground">
          このモードでは Developer Token / Music User Token
          の手動入力は不要です。 music.apple.com
          のログインセッションをそのまま利用します。
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
          <ContentItemTitle>Wrapper Control (Docker)</ContentItemTitle>
          <ContentItemForm className="max-w-none w-3/5 flex-col items-start gap-3">
            <p className="text-xs text-muted-foreground">
              初回は 1 → 2 → 3 の順で実行してください。完了後は 4
              の開始/停止だけで運用できます。
            </p>
            <div className="w-full rounded-md border p-3 space-y-2">
              <p className="text-xs text-muted-foreground">現在の状態</p>
              <div className="flex flex-wrap gap-2">
                <Badge variant={wrapperStatus?.dockerAvailable ? 'default' : 'outline'}>
                  Docker {wrapperStatus?.dockerAvailable ? 'OK' : 'NG'}
                </Badge>
                <Badge variant={wrapperStatus?.imageExists ? 'default' : 'outline'}>
                  Image {wrapperStatus?.imageExists ? 'Built' : 'Missing'}
                </Badge>
                <Badge variant={isWrapperLoginRunning ? 'default' : 'outline'}>
                  Login {isWrapperLoginRunning ? 'Running' : 'Stopped'}
                </Badge>
                <Badge variant={isWrapperServiceRunning ? 'default' : 'outline'}>
                  Service {isWrapperServiceRunning ? 'Running' : 'Stopped'}
                </Badge>
                <Badge variant={wrapperStatus?.hasMusicToken ? 'default' : 'outline'}>
                  Token {wrapperStatus?.hasMusicToken ? 'Present' : 'Missing'}
                </Badge>
                <Badge variant={wrapperStatus?.accountReachable ? 'default' : 'outline'}>
                  Reachable {wrapperStatus?.accountReachable ? 'Yes' : 'No'}
                </Badge>
                <Badge variant={wrapperReadyForPlayback ? 'default' : 'outline'}>
                  Playback {wrapperReadyForPlayback ? 'Ready' : 'Not Ready'}
                </Badge>
              </div>
              <p className="text-[11px] text-muted-foreground">{wrapperStatusText}</p>
              <p className="text-[11px] text-muted-foreground break-all">
                Wrapper Dir: {wrapperStatus?.wrapperDirPath ?? 'not found'}
              </p>
              {wrapperMusicTokenPreview && (
                <p className="text-[11px] text-muted-foreground break-all">
                  Token Preview: {wrapperMusicTokenPreview}
                </p>
              )}
              <div className="flex w-full flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void refreshWrapperStatus()}
                  disabled={!desktop || isRefreshingWrapperStatus}
                >
                  {isRefreshingWrapperStatus ? (
                    <>
                      <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                      Refreshing...
                    </>
                  ) : (
                    'Refresh Status'
                  )}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void handleLoadWrapperLogs()}
                  disabled={!desktop || isWrapperLogsLoading}
                >
                  {isWrapperLogsLoading ? (
                    <>
                      <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                      Loading Logs...
                    </>
                  ) : (
                    'Load Logs'
                  )}
                </Button>
              </div>
            </div>

            <div className="w-full rounded-md border p-3 space-y-3">
              <p className="text-sm font-medium">1. 初回のみ: イメージ作成</p>
              <p className="text-xs text-muted-foreground">
                Build Image は最初だけ実行すればOKです。
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void handleWrapperBuildImage()}
                disabled={!desktop || isWrapperBuilding}
              >
                {isWrapperBuilding ? (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                    Building...
                  </>
                ) : (
                  'Build Image'
                )}
              </Button>
            </div>

            <div className="w-full rounded-md border p-3 space-y-3">
              <p className="text-sm font-medium">2. 初回のみ: Apple ID ログイン開始</p>
              <div className="grid w-full grid-cols-1 gap-2 md:grid-cols-2">
                <Input
                  type="text"
                  value={wrapperUsername}
                  onChange={(event) => setWrapperUsername(event.target.value)}
                  placeholder="Apple ID"
                />
                <Input
                  type="password"
                  value={wrapperPassword}
                  onChange={(event) => setWrapperPassword(event.target.value)}
                  placeholder="Password"
                />
              </div>
              <div className="flex w-full flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void handleWrapperStartLogin()}
                  disabled={!desktop || isWrapperLoginStarting || isWrapperLoginRunning}
                >
                  {isWrapperLoginStarting ? (
                    <>
                      <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                      Starting Login...
                    </>
                  ) : (
                    'Start Login'
                  )}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void handleWrapperStopLogin()}
                  disabled={!desktop || isWrapperLoginStopping || !isWrapperLoginRunning}
                >
                  {isWrapperLoginStopping ? (
                    <>
                      <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                      Stopping Login...
                    </>
                  ) : (
                    'Stop Login'
                  )}
                </Button>
              </div>
            </div>

            <div className="w-full rounded-md border p-3 space-y-3">
              <p className="text-sm font-medium">3. 初回のみ: 2FAコード送信</p>
              <p className="text-xs text-muted-foreground">
                スマホに届いた数字コードを入力して送信します。
              </p>
              <div className="grid w-full grid-cols-1 gap-2 md:grid-cols-[1fr_auto]">
                <Input
                  type="text"
                  value={wrapperTwoFactorCode}
                  onChange={(event) => setWrapperTwoFactorCode(event.target.value)}
                  placeholder="2FA code (digits)"
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void handleWrapperSubmitTwoFactorCode()}
                  disabled={!desktop || isWrapperCodeSubmitting}
                >
                  {isWrapperCodeSubmitting ? (
                    <>
                      <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                      Sending...
                    </>
                  ) : (
                    'Send 2FA'
                  )}
                </Button>
              </div>
            </div>

            <div className="w-full rounded-md border p-3 space-y-3">
              <p className="text-sm font-medium">4. 通常運用: サービス開始 / 停止</p>
              <p className="text-xs text-muted-foreground">
                2FA完了後はここだけ使えば再生できます。
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void handleWrapperStartService()}
                  disabled={
                    !desktop || isWrapperServiceStarting || isWrapperServiceRunning
                  }
                >
                  {isWrapperServiceStarting ? (
                    <>
                      <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                      Starting...
                    </>
                  ) : (
                    'Start Service'
                  )}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void handleWrapperStopService()}
                  disabled={
                    !desktop || isWrapperServiceStopping || !isWrapperServiceRunning
                  }
                >
                  {isWrapperServiceStopping ? (
                    <>
                      <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                      Stopping...
                    </>
                  ) : (
                    'Stop Service'
                  )}
                </Button>
              </div>
            </div>

            {wrapperLogsText.trim().length > 0 && (
              <pre className="w-full max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/30 p-2 text-[11px] text-muted-foreground">
                {wrapperLogsText}
              </pre>
            )}
          </ContentItemForm>
        </ContentItem>
      </Content>

      <ContentSeparator />

      <Content>
        <ContentItem>
          <ContentItemTitle>Diagnostics (On-demand)</ContentItemTitle>
          <ContentItemForm className="max-w-none w-3/5 justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              通常時は詳細ログを表示しません。問題時のみ Collect
              して必要なら詳細を展開してください。
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
              問題を検知しました。必要に応じて `Collect Debug Log`
              を実行してください。
            </p>
          ) : null}
          {isDiagnosticsExpanded && diagnosticsText ? (
            <pre className="mt-3 w-3/5 whitespace-pre-wrap break-all rounded-md border bg-muted/30 p-2 text-[11px] text-muted-foreground">
              {diagnosticsText}
            </pre>
          ) : null}
        </ContentItem>

        <ContentSeparator />

        <ContentItem>
          <ContentItemTitle>Favorite Genres</ContentItemTitle>
          <ContentItemForm>
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Select your favorite music genres for personalized
                recommendations.
              </p>
              <div className="flex flex-wrap gap-2">
                {AVAILABLE_GENRES.map((genre) => {
                  const isSelected = favoriteGenres.includes(genre)
                  return (
                    <Badge
                      key={genre}
                      variant={isSelected ? 'default' : 'outline'}
                      className="cursor-pointer px-3 py-1 text-sm"
                      onClick={() => {
                        if (isSelected) {
                          setFavoriteGenres(
                            favoriteGenres.filter((g) => g !== genre),
                          )
                        } else {
                          setFavoriteGenres([...favoriteGenres, genre])
                        }
                      }}
                    >
                      {isSelected && '✓ '}
                      {genre}
                    </Badge>
                  )
                })}
              </div>
              {favoriteGenres.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  Selected: {favoriteGenres.join(', ')}
                </p>
              )}
            </div>
          </ContentItemForm>
        </ContentItem>
      </Content>
    </Root>
  )
}
