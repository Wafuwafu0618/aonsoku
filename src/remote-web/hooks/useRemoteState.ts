import { useCallback, useEffect, useRef, useState } from 'react'
import type { RemoteState } from '../lib/remoteApi'
import * as remoteApi from '../lib/remoteApi'

type ConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'

export function useRemoteState(leaseId: string | undefined) {
  const [state, setState] = useState<RemoteState | null>(null)
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('disconnected')
  const eventSourceRef = useRef<EventSource | null>(null)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const connect = useCallback(() => {
    if (!leaseId) return

    setConnectionStatus('connecting')

    try {
      const es = remoteApi.subscribeToEvents(leaseId)
      eventSourceRef.current = es

      es.onopen = () => {
        setConnectionStatus('connected')
      }

      const handleStateEvent = (event: MessageEvent<string>) => {
        try {
          const data = JSON.parse(event.data)
          if (data && typeof data === 'object') {
            // event: state で { ok, state, ... } が来る
            if ('state' in data && data.state) {
              setState(data.state as RemoteState)
              return
            }
            // 互換: 直接 state が来るケース
            if ('isPlaying' in data || 'currentTimeSeconds' in data) {
              setState(data as RemoteState)
            }
          }
        } catch {
          // パースエラーは無視
        }
      }
      es.addEventListener('state', handleStateEvent as EventListener)

      // 念のため default message も処理
      es.onmessage = (event) => {
        handleStateEvent(event)
      }

      es.onerror = () => {
        setConnectionStatus('disconnected')
        es.close()

        // 自動再接続
        reconnectTimeoutRef.current = setTimeout(() => {
          setConnectionStatus('reconnecting')
          connect()
        }, 3000)
      }
    } catch {
      setConnectionStatus('disconnected')
    }
  }, [leaseId])

  useEffect(() => {
    if (!leaseId) {
      setState(null)
      setConnectionStatus('disconnected')
      return
    }

    void remoteApi
      .getCurrentState(leaseId)
      .then((current) => setState(current))
      .catch(() => {
        // 初回取得失敗はSSE更新で回復させる
      })
    connect()

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close()
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
      }
    }
  }, [leaseId, connect])

  return {
    state,
    connectionStatus,
  }
}
