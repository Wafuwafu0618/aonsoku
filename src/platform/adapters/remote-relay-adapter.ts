import { isDesktop } from '@/platform/capabilities'
import type {
  RemoteRelayCommandPayload,
  RemoteRelayLifecycleEvent,
  RemoteRelayStatus,
  RemoteRelayStateUpdatePayload,
  RemoteRelayTunnelCommandResult,
} from '@/platform/contracts/desktop-contract'

const EMPTY_STATUS: RemoteRelayStatus = {
  enabled: false,
  localPort: 39096,
  localUrl: 'http://127.0.0.1:39096',
  tunnelRunning: false,
  tunnelStatus: 'stopped',
  tunnelMessage: 'Remote relay is disabled.',
  remoteSessionActive: false,
  defaultProfile: 'alac',
  streamProfile: 'alac',
  cloudflaredPath: '',
  tunnelArgs: '',
}

const EMPTY_COMMAND_RESULT: RemoteRelayTunnelCommandResult = {
  ok: false,
  message: 'Remote relay is unavailable in this environment.',
}

export function remoteRelayUpdateState(payload: RemoteRelayStateUpdatePayload): void {
  if (!isDesktop()) return
  window.api.remoteRelayUpdateState(payload)
}

export async function remoteRelayGetStatus(): Promise<RemoteRelayStatus> {
  if (!isDesktop()) return EMPTY_STATUS
  return await window.api.remoteRelayGetStatus()
}

export async function remoteRelayStartTunnel(): Promise<RemoteRelayTunnelCommandResult> {
  if (!isDesktop()) return EMPTY_COMMAND_RESULT
  return await window.api.remoteRelayStartTunnel()
}

export async function remoteRelayStopTunnel(): Promise<RemoteRelayTunnelCommandResult> {
  if (!isDesktop()) return EMPTY_COMMAND_RESULT
  return await window.api.remoteRelayStopTunnel()
}

export function onRemoteRelayCommand(
  callback: (payload: RemoteRelayCommandPayload) => void,
): () => void {
  if (!isDesktop()) {
    return () => {}
  }

  window.api.removeRemoteRelayCommandListener()
  window.api.remoteRelayCommandListener(callback)
  return () => {
    window.api.removeRemoteRelayCommandListener()
  }
}

export function onRemoteRelayLifecycle(
  callback: (payload: RemoteRelayLifecycleEvent) => void,
): () => void {
  if (!isDesktop()) {
    return () => {}
  }

  window.api.removeRemoteRelayLifecycleListener()
  window.api.remoteRelayLifecycleListener(callback)
  return () => {
    window.api.removeRemoteRelayLifecycleListener()
  }
}
