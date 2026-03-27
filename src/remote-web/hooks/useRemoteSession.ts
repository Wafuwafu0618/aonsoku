import { useCallback, useEffect, useState } from 'react'
import * as remoteApi from '../lib/remoteApi'

interface RemoteSession {
  leaseId: string
  clientName: string
  lastHeartbeatMs: number
}

export function useRemoteSession() {
  const [session, setSession] = useState<RemoteSession | null>(null)
  const [isClaiming, setIsClaiming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // セッション取得
  const claim = useCallback(async () => {
    setIsClaiming(true)
    setError(null)

    try {
      const response = await remoteApi.claimSession()
      if (response.ok && response.leaseId) {
        setSession({
          leaseId: response.leaseId,
          clientName: response.clientName ?? 'Minato Remote Web',
          lastHeartbeatMs: Date.now(),
        })
      } else {
        setError(response.message || 'セッションの取得に失敗しました')
      }
    } catch (err) {
      setError('サーバーに接続できません')
    } finally {
      setIsClaiming(false)
    }
  }, [])

  // ハートビート
  useEffect(() => {
    if (!session) return

    const interval = setInterval(async () => {
      try {
        await remoteApi.sendHeartbeat(session.leaseId)
        setSession((prev) =>
          prev ? { ...prev, lastHeartbeatMs: Date.now() } : null,
        )
      } catch {
        // ハートビート失敗時はセッションを解放
        setSession(null)
      }
    }, 5000)

    return () => clearInterval(interval)
  }, [session])

  // セッション解放
  const release = useCallback(async () => {
    if (session) {
      try {
        await remoteApi.releaseSession(session.leaseId)
      } catch {
        // エラーは無視
      }
    }
    setSession(null)
  }, [session])

  return {
    session,
    isClaiming,
    error,
    claim,
    release,
  }
}
