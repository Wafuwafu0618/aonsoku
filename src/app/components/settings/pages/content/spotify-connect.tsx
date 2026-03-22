import { Play, Power, RefreshCw, Square } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'react-toastify'
import {
  onSpotifyConnectEvent,
  spotifyConnectListDevices,
  spotifyConnectOAuthAuthorize,
  spotifyConnectOAuthRefresh,
  spotifyConnectPlayUri,
  spotifyConnectDispose,
  spotifyConnectInitialize,
  spotifyConnectSetActiveDevice,
  spotifyConnectStartReceiver,
  spotifyConnectStatus,
} from '@/platform'
import { isDesktop } from '@/platform/capabilities'
import type {
  SpotifyConnectDeviceInfo,
  SpotifyConnectEvent,
  SpotifyConnectStatusResult,
} from '@/platform/contracts/desktop-contract'
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
import { Input } from '@/app/components/ui/input'

const EMPTY_STATUS: SpotifyConnectStatusResult = {
  ok: false,
  initialized: false,
  receiverRunning: false,
  sessionConnected: false,
  isPlaying: false,
  currentTimeSeconds: 0,
  durationSeconds: 0,
  volume: 1,
}

const OAUTH_CACHE_KEY = 'spotify-connect-oauth-cache-v1'

function formatEventForLog(event: SpotifyConnectEvent): string {
  const eventType = event.type || 'unknown'

  if (typeof event.message === 'string' && event.message.length > 0) {
    return `${eventType}: ${event.message}`
  }

  if (typeof event.error?.message === 'string') {
    return `${eventType}: ${event.error.message}`
  }

  return eventType
}

export function SpotifyConnectContent() {
  const desktop = isDesktop()
  const [deviceName, setDeviceName] = useState('Minato Spotify Connect')
  const [cacheDir, setCacheDir] = useState('')
  const [zeroconfPortInput, setZeroconfPortInput] = useState('')
  const [librespotPath, setLibrespotPath] = useState('')
  const [oauthClientId, setOauthClientId] = useState('')
  const [oauthRedirectPortInput, setOauthRedirectPortInput] = useState('4381')
  const [accessToken, setAccessToken] = useState('')
  const [refreshToken, setRefreshToken] = useState('')
  const [tokenExpiresAtEpochMs, setTokenExpiresAtEpochMs] = useState<number | null>(
    null,
  )
  const [spotifyUriInput, setSpotifyUriInput] = useState('spotify:track:')
  const [devices, setDevices] = useState<SpotifyConnectDeviceInfo[]>([])
  const [selectedDeviceId, setSelectedDeviceId] = useState('')
  const [status, setStatus] = useState<SpotifyConnectStatusResult>(EMPTY_STATUS)
  const [latestEvent, setLatestEvent] = useState<string>('未受信')
  const [eventLogs, setEventLogs] = useState<string[]>([])
  const [isInitializing, setIsInitializing] = useState(false)
  const [isStartingReceiver, setIsStartingReceiver] = useState(false)
  const [isRefreshingStatus, setIsRefreshingStatus] = useState(false)
  const [isListingDevices, setIsListingDevices] = useState(false)
  const [isSettingActiveDevice, setIsSettingActiveDevice] = useState(false)
  const [isPlayingUri, setIsPlayingUri] = useState(false)
  const [isAuthorizingOAuth, setIsAuthorizingOAuth] = useState(false)
  const [isRefreshingOAuthToken, setIsRefreshingOAuthToken] = useState(false)
  const [isDisposing, setIsDisposing] = useState(false)
  const [oauthCacheHydrated, setOauthCacheHydrated] = useState(false)

  const isAnyActionRunning = useMemo(
    () =>
      isInitializing ||
      isStartingReceiver ||
      isRefreshingStatus ||
      isListingDevices ||
      isSettingActiveDevice ||
      isPlayingUri ||
      isAuthorizingOAuth ||
      isRefreshingOAuthToken ||
      isDisposing,
    [
      isDisposing,
      isInitializing,
      isListingDevices,
      isAuthorizingOAuth,
      isPlayingUri,
      isRefreshingOAuthToken,
      isRefreshingStatus,
      isSettingActiveDevice,
      isStartingReceiver,
    ],
  )

  const refreshStatus = useCallback(async () => {
    if (!desktop) return

    setIsRefreshingStatus(true)
    try {
      const nextStatus = await spotifyConnectStatus()
      setStatus(nextStatus)
      if (typeof nextStatus.activeDeviceId === 'string') {
        setSelectedDeviceId(nextStatus.activeDeviceId)
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(`Spotify Connect status取得に失敗: ${reason}`)
    } finally {
      setIsRefreshingStatus(false)
    }
  }, [desktop])

  const refreshDevices = useCallback(async () => {
    if (!desktop) return

    setIsListingDevices(true)
    try {
      const result = await spotifyConnectListDevices()
      if (!result.ok) {
        toast.error(result.error?.message ?? 'Spotify device一覧取得に失敗しました')
        return
      }

      setDevices(result.devices)
      setSelectedDeviceId((current) => {
        if (result.activeDeviceId) return result.activeDeviceId
        if (current.length > 0) return current
        return result.devices[0]?.id ?? ''
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(`Spotify device一覧取得に失敗: ${reason}`)
    } finally {
      setIsListingDevices(false)
    }
  }, [desktop])

  useEffect(() => {
    if (!desktop) return

    refreshStatus().catch(() => {
      // ignore initial fetch error to keep settings UI responsive
    })

    const unsubscribe = onSpotifyConnectEvent((event) => {
      const logLine = formatEventForLog(event)
      const timestamp = new Date().toLocaleTimeString('ja-JP')
      const rendered = `[${timestamp}] ${logLine}`

      setLatestEvent(rendered)
      setEventLogs((previous) => [rendered, ...previous].slice(0, 8))
    })

    return () => {
      unsubscribe()
    }
  }, [desktop, refreshStatus])

  useEffect(() => {
    if (!desktop) return
    try {
      const raw = window.localStorage.getItem(OAUTH_CACHE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as {
        clientId?: unknown
        redirectPortInput?: unknown
        refreshToken?: unknown
        accessToken?: unknown
        tokenExpiresAtEpochMs?: unknown
      }
      if (typeof parsed.clientId === 'string') {
        setOauthClientId(parsed.clientId)
      }
      if (typeof parsed.redirectPortInput === 'string') {
        setOauthRedirectPortInput(parsed.redirectPortInput)
      }
      if (typeof parsed.refreshToken === 'string') {
        setRefreshToken(parsed.refreshToken)
      }
      if (typeof parsed.accessToken === 'string') {
        setAccessToken(parsed.accessToken)
      }
      if (
        typeof parsed.tokenExpiresAtEpochMs === 'number' &&
        Number.isFinite(parsed.tokenExpiresAtEpochMs)
      ) {
        setTokenExpiresAtEpochMs(parsed.tokenExpiresAtEpochMs)
      }
    } catch {
      // ignore invalid cache payload
    } finally {
      setOauthCacheHydrated(true)
    }
  }, [desktop])

  useEffect(() => {
    if (!desktop || !oauthCacheHydrated) return
    try {
      window.localStorage.setItem(
        OAUTH_CACHE_KEY,
        JSON.stringify({
          clientId: oauthClientId,
          redirectPortInput: oauthRedirectPortInput,
          refreshToken,
          accessToken,
          tokenExpiresAtEpochMs,
        }),
      )
    } catch {
      // ignore storage write failures
    }
  }, [
    desktop,
    oauthCacheHydrated,
    oauthClientId,
    oauthRedirectPortInput,
    refreshToken,
    accessToken,
    tokenExpiresAtEpochMs,
  ])

  async function handleInitialize() {
    if (!desktop) return

    const zeroconfPortTrimmed = zeroconfPortInput.trim()
    let zeroconfPort: number | undefined
    if (zeroconfPortTrimmed.length > 0) {
      const parsedPort = Number.parseInt(zeroconfPortTrimmed, 10)
      if (
        Number.isNaN(parsedPort) ||
        parsedPort <= 0 ||
        parsedPort > 65535
      ) {
        toast.error('zeroconfPort は 1-65535 の整数を入力してください')
        return
      }
      zeroconfPort = parsedPort
    }

    setIsInitializing(true)
    try {
      const result = await spotifyConnectInitialize({
        deviceName: deviceName.trim() || undefined,
        cacheDir: cacheDir.trim() || undefined,
        zeroconfPort,
        librespotPath: librespotPath.trim() || undefined,
        accessToken: accessToken.trim() || undefined,
      })

      if (!result.ok) {
        toast.error(result.message ?? 'Spotify Connect initialize に失敗しました')
      } else {
        toast.success('Spotify Connect sidecar を初期化しました')
      }
      await refreshStatus()
      await refreshDevices()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(`Spotify Connect initialize 失敗: ${reason}`)
    } finally {
      setIsInitializing(false)
    }
  }

  async function handleStartReceiver() {
    if (!desktop) return

    setIsStartingReceiver(true)
    try {
      const result = await spotifyConnectStartReceiver()
      if (!result.ok) {
        toast.error(result.error?.message ?? 'receiver 起動に失敗しました')
      } else {
        toast.success('Spotify Connect receiver を起動しました')
      }
      await refreshStatus()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(`receiver 起動失敗: ${reason}`)
    } finally {
      setIsStartingReceiver(false)
    }
  }

  async function handleSetActiveDevice() {
    if (!desktop) return
    if (selectedDeviceId.trim().length === 0) {
      toast.error('setActiveDevice には deviceId が必要です')
      return
    }

    setIsSettingActiveDevice(true)
    try {
      const result = await spotifyConnectSetActiveDevice({
        deviceId: selectedDeviceId.trim(),
        transferPlayback: true,
      })
      if (!result.ok) {
        toast.error(result.error?.message ?? 'active device 切替に失敗しました')
      } else {
        toast.success('active device を切り替えました')
      }
      await refreshDevices()
      await refreshStatus()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(`active device 切替失敗: ${reason}`)
    } finally {
      setIsSettingActiveDevice(false)
    }
  }

  async function handlePlayUri() {
    if (!desktop) return
    const spotifyUri = spotifyUriInput.trim()
    if (!spotifyUri.startsWith('spotify:')) {
      toast.error('playUri には spotify: で始まるURIが必要です')
      return
    }

    setIsPlayingUri(true)
    try {
      const result = await spotifyConnectPlayUri({
        spotifyUri,
        deviceId: selectedDeviceId.trim() || undefined,
      })
      if (!result.ok) {
        toast.error(result.error?.message ?? 'URI再生に失敗しました')
      } else {
        toast.success('Spotify URI の再生を要求しました')
      }
      await refreshStatus()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(`URI再生失敗: ${reason}`)
    } finally {
      setIsPlayingUri(false)
    }
  }

  async function handleAuthorizeOAuth() {
    if (!desktop) return
    const clientId = oauthClientId.trim()
    if (clientId.length === 0) {
      toast.error('OAuth Client ID を入力してください')
      return
    }

    const port = Number.parseInt(oauthRedirectPortInput.trim(), 10)
    if (Number.isNaN(port) || port < 1 || port > 65535) {
      toast.error('OAuth Redirect Port は 1-65535 の整数を入力してください')
      return
    }

    setIsAuthorizingOAuth(true)
    try {
      const result = await spotifyConnectOAuthAuthorize({
        clientId,
        redirectPort: port,
      })
      if (!result.ok || !result.accessToken) {
        toast.error(result.error?.message ?? 'Spotify OAuth認可に失敗しました')
        return
      }

      setAccessToken(result.accessToken)
      if (result.refreshToken) {
        setRefreshToken(result.refreshToken)
      }
      if (typeof result.expiresIn === 'number' && result.expiresIn > 0) {
        setTokenExpiresAtEpochMs(Date.now() + result.expiresIn * 1000)
      } else {
        setTokenExpiresAtEpochMs(null)
      }
      toast.success('Spotify OAuth認可に成功しました')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(`Spotify OAuth認可に失敗: ${reason}`)
    } finally {
      setIsAuthorizingOAuth(false)
    }
  }

  async function handleRefreshOAuthToken() {
    if (!desktop) return
    const clientId = oauthClientId.trim()
    if (clientId.length === 0) {
      toast.error('OAuth Client ID を入力してください')
      return
    }
    const nextRefreshToken = refreshToken.trim()
    if (nextRefreshToken.length === 0) {
      toast.error('Refresh Token が空です')
      return
    }

    setIsRefreshingOAuthToken(true)
    try {
      const result = await spotifyConnectOAuthRefresh({
        clientId,
        refreshToken: nextRefreshToken,
      })
      if (!result.ok || !result.accessToken) {
        toast.error(result.error?.message ?? 'Spotify token refresh に失敗しました')
        return
      }

      setAccessToken(result.accessToken)
      if (result.refreshToken) {
        setRefreshToken(result.refreshToken)
      }
      if (typeof result.expiresIn === 'number' && result.expiresIn > 0) {
        setTokenExpiresAtEpochMs(Date.now() + result.expiresIn * 1000)
      } else {
        setTokenExpiresAtEpochMs(null)
      }
      toast.success('Spotify access token を更新しました')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(`Spotify token refresh に失敗: ${reason}`)
    } finally {
      setIsRefreshingOAuthToken(false)
    }
  }

  async function handleDispose() {
    if (!desktop) return

    setIsDisposing(true)
    try {
      const result = await spotifyConnectDispose()
      if (!result.ok) {
        toast.error(result.error?.message ?? 'receiver 停止に失敗しました')
      } else {
        toast.success('Spotify Connect receiver を停止しました')
        setDevices([])
        setSelectedDeviceId('')
      }
      await refreshStatus()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(`receiver 停止失敗: ${reason}`)
    } finally {
      setIsDisposing(false)
    }
  }

  return (
    <Root>
      <Header>
        <HeaderTitle>Spotify Connect (Beta)</HeaderTitle>
        <HeaderDescription>
          Sidecar/librespot と Controller API の疎通確認用。OAuth認可で token
          を取得して外部Spotifyデバイスの列挙・切替・URI再生を試せます。
        </HeaderDescription>
      </Header>

      <Content>
        <ContentItem>
          <ContentItemTitle>Device Name</ContentItemTitle>
          <ContentItemForm className="w-3/5 max-w-none">
            <Input
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
              placeholder="Minato Spotify Connect"
              disabled={!desktop || isAnyActionRunning}
            />
          </ContentItemForm>
        </ContentItem>

        <ContentItem>
          <ContentItemTitle>Cache Directory</ContentItemTitle>
          <ContentItemForm className="w-3/5 max-w-none">
            <Input
              value={cacheDir}
              onChange={(event) => setCacheDir(event.target.value)}
              placeholder="C:\\aonsoku\\tmp\\spotify-cache (optional)"
              disabled={!desktop || isAnyActionRunning}
            />
          </ContentItemForm>
        </ContentItem>

        <ContentItem>
          <ContentItemTitle>Zeroconf Port</ContentItemTitle>
          <ContentItemForm className="w-3/5 max-w-none">
            <Input
              value={zeroconfPortInput}
              onChange={(event) => setZeroconfPortInput(event.target.value)}
              placeholder="24879 (optional)"
              disabled={!desktop || isAnyActionRunning}
            />
          </ContentItemForm>
        </ContentItem>

        <ContentItem>
          <ContentItemTitle>librespot Path</ContentItemTitle>
          <ContentItemForm className="w-3/5 max-w-none">
            <Input
              value={librespotPath}
              onChange={(event) => setLibrespotPath(event.target.value)}
              placeholder="C:\\aonsoku\\native\\third_party\\librespot-0.8.0\\target\\release\\librespot.exe (optional)"
              disabled={!desktop || isAnyActionRunning}
            />
          </ContentItemForm>
        </ContentItem>

        <ContentItem>
          <ContentItemTitle>OAuth Client ID</ContentItemTitle>
          <ContentItemForm className="w-3/5 max-w-none">
            <Input
              value={oauthClientId}
              onChange={(event) => setOauthClientId(event.target.value)}
              placeholder="Spotify App Client ID"
              disabled={!desktop || isAnyActionRunning}
            />
          </ContentItemForm>
        </ContentItem>

        <ContentItem>
          <ContentItemTitle>OAuth Redirect Port</ContentItemTitle>
          <ContentItemForm className="w-3/5 max-w-none">
            <Input
              value={oauthRedirectPortInput}
              onChange={(event) => setOauthRedirectPortInput(event.target.value)}
              placeholder="4381"
              disabled={!desktop || isAnyActionRunning}
            />
          </ContentItemForm>
        </ContentItem>

        <ContentItem>
          <ContentItemTitle>Spotify Access Token</ContentItemTitle>
          <ContentItemForm className="w-3/5 max-w-none">
            <Input
              value={accessToken}
              onChange={(event) => setAccessToken(event.target.value)}
              placeholder="BQ... (user-read-playback-state, user-modify-playback-state, user-read-private)"
              disabled={!desktop || isAnyActionRunning}
            />
          </ContentItemForm>
        </ContentItem>

        <ContentItem>
          <ContentItemTitle>Spotify Refresh Token</ContentItemTitle>
          <ContentItemForm className="w-3/5 max-w-none">
            <Input
              value={refreshToken}
              onChange={(event) => setRefreshToken(event.target.value)}
              placeholder="OAuth authorize 後に自動入力"
              disabled={!desktop || isAnyActionRunning}
            />
          </ContentItemForm>
        </ContentItem>

        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={refreshStatus}
            disabled={!desktop || isAnyActionRunning}
          >
            <RefreshCw
              className={`w-4 h-4 mr-2 ${isRefreshingStatus ? 'animate-spin' : ''}`}
            />
            Status
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={refreshDevices}
            disabled={!desktop || isAnyActionRunning}
          >
            <RefreshCw
              className={`w-4 h-4 mr-2 ${isListingDevices ? 'animate-spin' : ''}`}
            />
            List Devices
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleAuthorizeOAuth}
            disabled={!desktop || isAnyActionRunning}
          >
            OAuth Authorize
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleRefreshOAuthToken}
            disabled={
              !desktop ||
              isAnyActionRunning ||
              oauthClientId.trim().length === 0 ||
              refreshToken.trim().length === 0
            }
          >
            OAuth Refresh
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={handleInitialize}
            disabled={!desktop || isAnyActionRunning}
          >
            <Power className="w-4 h-4 mr-2" />
            Initialize
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={handleStartReceiver}
            disabled={!desktop || isAnyActionRunning}
          >
            <Play className="w-4 h-4 mr-2" />
            Start Receiver
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={handleDispose}
            disabled={!desktop || isAnyActionRunning}
          >
            <Square className="w-4 h-4 mr-2" />
            Dispose
          </Button>
        </div>

        <div className="space-y-2 rounded-md border p-3">
          <div className="text-xs text-muted-foreground">Controller Commands</div>
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <select
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              value={selectedDeviceId}
              onChange={(event) => setSelectedDeviceId(event.target.value)}
              disabled={!desktop || isAnyActionRunning || devices.length === 0}
            >
              {devices.length === 0 && <option value="">(devices empty)</option>}
              {devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}
                  {device.type ? ` (${device.type})` : ''}
                  {device.isActive ? ' [active]' : ''}
                </option>
              ))}
            </select>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleSetActiveDevice}
              disabled={!desktop || isAnyActionRunning || selectedDeviceId.length === 0}
            >
              Set Active Device
            </Button>
          </div>
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            <Input
              value={spotifyUriInput}
              onChange={(event) => setSpotifyUriInput(event.target.value)}
              placeholder="spotify:track:..."
              disabled={!desktop || isAnyActionRunning}
            />
            <Button
              type="button"
              size="sm"
              onClick={handlePlayUri}
              disabled={!desktop || isAnyActionRunning}
            >
              Play URI
            </Button>
          </div>
        </div>

        <div className="space-y-1 rounded-md border p-3 text-xs text-muted-foreground">
          <div>initialized: {String(status.initialized)}</div>
          <div>receiverRunning: {String(status.receiverRunning)}</div>
          <div>sessionConnected: {String(status.sessionConnected)}</div>
          <div>isPlaying: {String(status.isPlaying)}</div>
          <div>activeDeviceId: {status.activeDeviceId ?? '(none)'}</div>
          <div>
            tokenExpiresAt:{' '}
            {tokenExpiresAtEpochMs
              ? new Date(tokenExpiresAtEpochMs).toLocaleString('ja-JP')
              : '(unknown)'}
          </div>
          <div>volume: {status.volume.toFixed(2)}</div>
          <div>currentTimeSeconds: {status.currentTimeSeconds.toFixed(2)}</div>
          <div>durationSeconds: {status.durationSeconds.toFixed(2)}</div>
          {status.error?.message && (
            <div className="text-destructive">error: {status.error.message}</div>
          )}
          <div className="pt-2 border-t">latestEvent: {latestEvent}</div>
          {eventLogs.length > 0 && (
            <div className="max-h-24 overflow-y-auto space-y-1 pt-1">
              {eventLogs.map((line, index) => (
                <div key={`${line}-${index}`}>{line}</div>
              ))}
            </div>
          )}
        </div>

        {!desktop && (
          <div className="text-xs text-muted-foreground">
            Spotify Connect 検証UIはデスクトップ環境でのみ利用できます。
          </div>
        )}
      </Content>

      <ContentSeparator />
    </Root>
  )
}
