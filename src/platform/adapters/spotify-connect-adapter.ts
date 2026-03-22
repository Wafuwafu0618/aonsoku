import { isDesktop } from '@/platform/capabilities'
import type {
  SpotifyConnectCommandResult,
  SpotifyConnectEvent,
  SpotifyConnectInitializeRequest,
  SpotifyConnectInitializeResult,
  SpotifyConnectListDevicesResult,
  SpotifyConnectOAuthAuthorizeRequest,
  SpotifyConnectOAuthRefreshRequest,
  SpotifyConnectOAuthTokenResult,
  SpotifyConnectPlayUriRequest,
  SpotifyConnectSetActiveDeviceRequest,
  SpotifyConnectStatusResult,
} from '@/platform/contracts/desktop-contract'

function desktopOnlyError(): Error {
  return new Error('Spotify Connectはデスクトップ環境でのみ利用できます')
}

export async function spotifyConnectInitialize(
  payload?: SpotifyConnectInitializeRequest,
): Promise<SpotifyConnectInitializeResult> {
  if (!isDesktop()) throw desktopOnlyError()
  return window.api.spotifyConnectInitialize(payload)
}

export async function spotifyConnectStartReceiver(): Promise<SpotifyConnectCommandResult> {
  if (!isDesktop()) throw desktopOnlyError()
  return window.api.spotifyConnectStartReceiver()
}

export async function spotifyConnectStatus(): Promise<SpotifyConnectStatusResult> {
  if (!isDesktop()) throw desktopOnlyError()
  return window.api.spotifyConnectStatus()
}

export async function spotifyConnectListDevices(): Promise<SpotifyConnectListDevicesResult> {
  if (!isDesktop()) throw desktopOnlyError()
  return window.api.spotifyConnectListDevices()
}

export async function spotifyConnectSetActiveDevice(
  payload: SpotifyConnectSetActiveDeviceRequest,
): Promise<SpotifyConnectCommandResult> {
  if (!isDesktop()) throw desktopOnlyError()
  return window.api.spotifyConnectSetActiveDevice(payload)
}

export async function spotifyConnectPlayUri(
  payload: SpotifyConnectPlayUriRequest,
): Promise<SpotifyConnectCommandResult> {
  if (!isDesktop()) throw desktopOnlyError()
  return window.api.spotifyConnectPlayUri(payload)
}

export async function spotifyConnectOAuthAuthorize(
  payload: SpotifyConnectOAuthAuthorizeRequest,
): Promise<SpotifyConnectOAuthTokenResult> {
  if (!isDesktop()) throw desktopOnlyError()
  return window.api.spotifyConnectOAuthAuthorize(payload)
}

export async function spotifyConnectOAuthRefresh(
  payload: SpotifyConnectOAuthRefreshRequest,
): Promise<SpotifyConnectOAuthTokenResult> {
  if (!isDesktop()) throw desktopOnlyError()
  return window.api.spotifyConnectOAuthRefresh(payload)
}

export async function spotifyConnectDispose(): Promise<SpotifyConnectCommandResult> {
  if (!isDesktop()) throw desktopOnlyError()
  return window.api.spotifyConnectDispose()
}

export function onSpotifyConnectEvent(
  callback: (event: SpotifyConnectEvent) => void,
): () => void {
  if (!isDesktop()) return () => {}

  window.api.spotifyConnectEventListener(callback)
  return () => {
    window.api.removeSpotifyConnectEventListener()
  }
}
