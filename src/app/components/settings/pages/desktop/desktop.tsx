import { Play, Square } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'react-toastify'
import {
  remoteRelayGetStatus,
  remoteRelayStartTunnel,
  remoteRelayStopTunnel,
} from '@/platform'
import { isDesktop } from '@/platform/capabilities'
import type { RemoteRelayStatus } from '@/platform/contracts/desktop-contract'
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
import { Switch } from '@/app/components/ui/switch'
import { useAppDesktopActions, useAppDesktopData } from '@/store/app.store'

const EMPTY_REMOTE_STATUS: RemoteRelayStatus = {
  enabled: false,
  localPort: 39096,
  localUrl: 'http://127.0.0.1:39096',
  tunnelRunning: false,
  tunnelStatus: 'stopped',
  tunnelMessage: '',
  remoteSessionActive: false,
  defaultProfile: 'alac',
  streamProfile: 'alac',
  cloudflaredPath: '',
  tunnelArgs: '',
}

export function DesktopSettings() {
  const { t } = useTranslation()
  const desktopEnabled = isDesktop()
  const { minimizeToTray, remoteRelay } = useAppDesktopData()
  const {
    setMinimizeToTray,
    setRemoteRelayCloudflaredPath,
    setRemoteRelayDefaultProfile,
    setRemoteRelayEnabled,
    setRemoteRelayLocalPort,
    setRemoteRelayTunnelArgs,
  } = useAppDesktopActions()
  const [remoteStatus, setRemoteStatus] = useState<RemoteRelayStatus>(
    EMPTY_REMOTE_STATUS,
  )
  const [isStartingTunnel, setIsStartingTunnel] = useState(false)
  const [isStoppingTunnel, setIsStoppingTunnel] = useState(false)
  const [isRefreshingStatus, setIsRefreshingStatus] = useState(false)

  const refreshRemoteStatus = useCallback(async () => {
    if (!desktopEnabled) return

    setIsRefreshingStatus(true)
    try {
      const status = await remoteRelayGetStatus()
      setRemoteStatus(status)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(t('settings.desktop.remote.statusFetchError', { reason }))
    } finally {
      setIsRefreshingStatus(false)
    }
  }, [desktopEnabled, t])

  useEffect(() => {
    if (!desktopEnabled) return
    refreshRemoteStatus().catch(() => {
      // ignore startup fetch failures in settings screen
    })
  }, [desktopEnabled, refreshRemoteStatus])

  async function handleStartTunnel() {
    if (!desktopEnabled) return
    setIsStartingTunnel(true)
    try {
      const result = await remoteRelayStartTunnel()
      if (result.ok) {
        toast.success(result.message)
      } else {
        toast.error(result.message)
      }
      await refreshRemoteStatus()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(t('settings.desktop.remote.startError', { reason }))
    } finally {
      setIsStartingTunnel(false)
    }
  }

  async function handleStopTunnel() {
    if (!desktopEnabled) return
    setIsStoppingTunnel(true)
    try {
      const result = await remoteRelayStopTunnel()
      if (result.ok) {
        toast.success(result.message)
      } else {
        toast.error(result.message)
      }
      await refreshRemoteStatus()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      toast.error(t('settings.desktop.remote.stopError', { reason }))
    } finally {
      setIsStoppingTunnel(false)
    }
  }

  return (
    <Root>
      <Header>
        <HeaderTitle>{t('settings.desktop.general.group')}</HeaderTitle>
        <HeaderDescription>
          {t('settings.desktop.general.description')}
        </HeaderDescription>
      </Header>
      <Content>
        <ContentItem>
          <ContentItemTitle info={t('settings.desktop.general.tray.info')}>
            {t('settings.desktop.general.tray.label')}
          </ContentItemTitle>
          <ContentItemForm>
            <Switch
              checked={minimizeToTray}
              onCheckedChange={setMinimizeToTray}
            />
          </ContentItemForm>
        </ContentItem>
        <ContentItem>
          <ContentItemTitle info={t('settings.desktop.remote.enabled.info')}>
            {t('settings.desktop.remote.enabled.label')}
          </ContentItemTitle>
          <ContentItemForm>
            <Switch
              checked={remoteRelay.enabled}
              onCheckedChange={setRemoteRelayEnabled}
            />
          </ContentItemForm>
        </ContentItem>
        <ContentItem>
          <ContentItemTitle info={t('settings.desktop.remote.localPort.info')}>
            {t('settings.desktop.remote.localPort.label')}
          </ContentItemTitle>
          <ContentItemForm>
            <Input
              type="number"
              min={1}
              max={65535}
              value={remoteRelay.localPort}
              onChange={(event) => {
                const parsed = Number.parseInt(event.target.value, 10)
                if (!Number.isFinite(parsed)) return
                if (parsed < 1 || parsed > 65535) return
                setRemoteRelayLocalPort(parsed)
              }}
              className="w-[140px]"
            />
          </ContentItemForm>
        </ContentItem>
        <ContentItem>
          <ContentItemTitle info={t('settings.desktop.remote.defaultProfile.info')}>
            {t('settings.desktop.remote.defaultProfile.label')}
          </ContentItemTitle>
          <ContentItemForm>
            <select
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
              value={remoteRelay.defaultProfile}
              onChange={(event) => {
                const value = event.target.value === 'aac' ? 'aac' : 'alac'
                setRemoteRelayDefaultProfile(value)
              }}
            >
              <option value="alac">ALAC</option>
              <option value="aac">AAC</option>
            </select>
          </ContentItemForm>
        </ContentItem>
        <ContentItem>
          <ContentItemTitle info={t('settings.desktop.remote.cloudflaredPath.info')}>
            {t('settings.desktop.remote.cloudflaredPath.label')}
          </ContentItemTitle>
          <ContentItemForm>
            <Input
              value={remoteRelay.cloudflaredPath}
              onChange={(event) =>
                setRemoteRelayCloudflaredPath(event.target.value)
              }
              placeholder={t(
                'settings.desktop.remote.cloudflaredPath.placeholder',
              )}
            />
          </ContentItemForm>
        </ContentItem>
        <ContentItem>
          <ContentItemTitle info={t('settings.desktop.remote.tunnelArgs.info')}>
            {t('settings.desktop.remote.tunnelArgs.label')}
          </ContentItemTitle>
          <ContentItemForm>
            <Input
              value={remoteRelay.tunnelArgs}
              onChange={(event) => setRemoteRelayTunnelArgs(event.target.value)}
              placeholder={t('settings.desktop.remote.tunnelArgs.placeholder')}
            />
          </ContentItemForm>
        </ContentItem>
        <ContentItem>
          <ContentItemTitle info={t('settings.desktop.remote.status.info')}>
            {t('settings.desktop.remote.status.label')}
          </ContentItemTitle>
          <ContentItemForm>
            <div className="flex flex-col gap-2 w-full items-end">
              <p className="text-xs text-right text-muted-foreground">
                {t('settings.desktop.remote.status.value', {
                  status: remoteStatus.tunnelStatus,
                  message:
                    remoteStatus.tunnelMessage ||
                    t('settings.desktop.remote.status.empty'),
                })}
              </p>
              <p className="text-xs text-right text-muted-foreground">
                {t('settings.desktop.remote.status.localUrl', {
                  url: remoteStatus.localUrl,
                })}
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={isRefreshingStatus}
                  onClick={() => {
                    refreshRemoteStatus().catch(() => {
                      // noop
                    })
                  }}
                >
                  {t('settings.desktop.remote.actions.refresh')}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={isStartingTunnel || isStoppingTunnel}
                  onClick={handleStartTunnel}
                >
                  <Play className="size-3.5 mr-1" />
                  {t('settings.desktop.remote.actions.start')}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isStartingTunnel || isStoppingTunnel}
                  onClick={handleStopTunnel}
                >
                  <Square className="size-3.5 mr-1" />
                  {t('settings.desktop.remote.actions.stop')}
                </Button>
              </div>
            </div>
          </ContentItemForm>
        </ContentItem>
      </Content>
      <ContentSeparator />
    </Root>
  )
}
