'use client'
import { useState, useRef, useEffect, useCallback } from 'react'
import { supabase } from './supabase'

// ─── Types ────────────────────────────────────────────────────────────────────
type AppState = 'idle' | 'camera' | 'searching' | 'waiting' | 'connecting' | 'connected' | 'disconnected' | 'error'

// ─── Constants ────────────────────────────────────────────────────────────────
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ]
}

// Generate a stable user ID for the lifetime of this page load
const MY_ID = Math.random().toString(36).substring(2, 10)

// ─── Component ────────────────────────────────────────────────────────────────
export default function Home() {
  const [appState, setAppState] = useState<AppState>('idle')
  const [partnerId, setPartnerId] = useState<string | null>(null)
  const [connectionTime, setConnectionTime] = useState(0)
  const [isMuted, setIsMuted] = useState(false)
  const [isCamOff, setIsCamOff] = useState(false)

  const localVideoRef = useRef<HTMLVideoElement>(null)
  const remoteVideoRef = useRef<HTMLVideoElement>(null)

  // Stable refs — never cause re-renders
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const channelRef = useRef<any>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  // Buffer ICE candidates that arrive before remote description is set
  const iceCandidateQueueRef = useRef<RTCIceCandidateInit[]>([])
  const remoteDescSetRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const isSearchingRef = useRef(false)

  // ── Cleanup everything ──────────────────────────────────────────────────────
  const cleanup = useCallback(async () => {
    isSearchingRef.current = false

    // Stop timer
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }

    // Close peer connection
    if (pcRef.current) {
      pcRef.current.ontrack = null
      pcRef.current.onicecandidate = null
      pcRef.current.onconnectionstatechange = null
      pcRef.current.close()
      pcRef.current = null
    }

    // Unsubscribe from Supabase channel
    if (channelRef.current) {
      await supabase.removeChannel(channelRef.current)
      channelRef.current = null
    }

    // Reset state
    iceCandidateQueueRef.current = []
    remoteDescSetRef.current = false

    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null
    }

    setPartnerId(null)
    setConnectionTime(0)
  }, [])

  // ── Stop camera entirely ────────────────────────────────────────────────────
  const stopCamera = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop())
      localStreamRef.current = null
    }
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null
    }
  }, [])

  // ── Start local camera ──────────────────────────────────────────────────────
  const startCamera = useCallback(async (): Promise<MediaStream | null> => {
    setAppState('camera')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: { echoCancellation: true, noiseSuppression: true }
      })
      localStreamRef.current = stream
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream
      }
      return stream
    } catch (err) {
      console.error('Camera error:', err)
      setAppState('error')
      return null
    }
  }, [])

  // ── Flush buffered ICE candidates ───────────────────────────────────────────
  const flushIceCandidates = useCallback(async (pc: RTCPeerConnection) => {
    while (iceCandidateQueueRef.current.length > 0) {
      const candidate = iceCandidateQueueRef.current.shift()!
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate))
      } catch (e) {
        console.warn('ICE candidate add failed:', e)
      }
    }
  }, [])

  // ── Build and wire up the RTCPeerConnection ─────────────────────────────────
  const createPeerConnection = useCallback((
    localStream: MediaStream,
    channel: any,
    isCaller: boolean
  ) => {
    const pc = new RTCPeerConnection(RTC_CONFIG)
    pcRef.current = pc

    // Add local tracks
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream))

    // Remote video
    pc.ontrack = (event) => {
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0]
      }
    }

    // ICE candidates → send over Supabase
    pc.onicecandidate = (event) => {
      if (event.candidate && channelRef.current) {
        channelRef.current.send({
          type: 'broadcast',
          event: 'ice-candidate',
          payload: { candidate: event.candidate.toJSON(), from: MY_ID }
        })
      }
    }

    // Connection state tracking
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      console.log('Connection state:', state)
      if (state === 'connected') {
        setAppState('connected')
        // Start call timer
        timerRef.current = setInterval(() => {
          setConnectionTime(t => t + 1)
        }, 1000)
      } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        setAppState('disconnected')
        cleanup()
      }
    }

    return pc
  }, [cleanup, flushIceCandidates])

  // ── Main: find a match ──────────────────────────────────────────────────────
  const findMatch = useCallback(async () => {
    if (isSearchingRef.current) return
    isSearchingRef.current = true

    // Cleanup any previous session
    await cleanup()

    // Start camera if not already running
    let localStream = localStreamRef.current
    if (!localStream) {
      localStream = await startCamera()
      if (!localStream) return
    }

    setAppState('searching')

    // ── Hit the matchmaking API ────────────────────────────────────────────────
    let data: { match?: string; waitRoomId?: string }
    try {
      const res = await fetch('/api/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: MY_ID })
      })
      data = await res.json()
    } catch (err) {
      console.error('Match API error:', err)
      setAppState('error')
      isSearchingRef.current = false
      return
    }

    // data.match = the ID of the user we matched with (we are CALLER)
    // data.waitRoomId = we are waiting in queue as this room (we are CALLEE)
    const isCaller = !!data.match
    const roomId = isCaller ? data.match! : data.waitRoomId ?? MY_ID

    if (isCaller) {
      setPartnerId(data.match!)
      setAppState('connecting')
    } else {
      setAppState('waiting')
    }

    // ── Open Supabase Realtime channel ─────────────────────────────────────────
    const channel = supabase.channel(`room_${roomId}`, {
      config: { broadcast: { self: false } } // CRITICAL: don't receive our own messages
    })
    channelRef.current = channel

    // Build peer connection
    const pc = createPeerConnection(localStream, channel, isCaller)

    // ── Signaling listeners ────────────────────────────────────────────────────

    // Callee woken up: someone joined, start the handshake
    channel.on('broadcast', { event: 'joined' }, async ({ payload }: any) => {
      if (!isCaller) {
        // We're the callee, someone matched with us — now WE become the caller
        setPartnerId(payload.callerId)
        setAppState('connecting')
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        channel.send({
          type: 'broadcast',
          event: 'offer',
          payload: { offer, from: MY_ID }
        })
      }
    })

    // Offer received (callee → caller flow or direct)
    channel.on('broadcast', { event: 'offer' }, async ({ payload }: any) => {
      if (payload.from === MY_ID) return // ignore our own
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(payload.offer))
        remoteDescSetRef.current = true
        await flushIceCandidates(pc)
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        channel.send({
          type: 'broadcast',
          event: 'answer',
          payload: { answer, from: MY_ID }
        })
      } catch (e) {
        console.error('Offer handling error:', e)
      }
    })

    // Answer received
    channel.on('broadcast', { event: 'answer' }, async ({ payload }: any) => {
      if (payload.from === MY_ID) return
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(payload.answer))
        remoteDescSetRef.current = true
        await flushIceCandidates(pc)
      } catch (e) {
        console.error('Answer handling error:', e)
      }
    })

    // ICE candidates — queue them if remote description not yet set
    channel.on('broadcast', { event: 'ice-candidate' }, async ({ payload }: any) => {
      if (payload.from === MY_ID) return
      if (!payload.candidate) return
      if (remoteDescSetRef.current && pcRef.current) {
        try {
          await pcRef.current.addIceCandidate(new RTCIceCandidate(payload.candidate))
        } catch (e) {
          console.warn('ICE add error:', e)
        }
      } else {
        // Buffer it — remote description not ready yet
        iceCandidateQueueRef.current.push(payload.candidate)
      }
    })

    // Partner disconnected
    channel.on('broadcast', { event: 'disconnect' }, () => {
      setAppState('disconnected')
      cleanup()
    })

    // ── Subscribe and initiate if caller ──────────────────────────────────────
    channel.subscribe(async (status: string) => {
      if (status !== 'SUBSCRIBED') return

      if (isCaller) {
        // Notify the waiting user that we've joined
        channel.send({
          type: 'broadcast',
          event: 'joined',
          payload: { callerId: MY_ID }
        })
        // Give a tiny tick so the callee's 'joined' listener fires and they send offer
        // If callee doesn't respond in 500ms, we send the offer ourselves as fallback
        setTimeout(async () => {
          if (pc.signalingState === 'stable' && !pc.remoteDescription) {
            try {
              const offer = await pc.createOffer()
              await pc.setLocalDescription(offer)
              channel.send({
                type: 'broadcast',
                event: 'offer',
                payload: { offer, from: MY_ID }
              })
            } catch (e) {
              console.error('Fallback offer error:', e)
            }
          }
        }, 500)
      }
    })
  }, [cleanup, startCamera, createPeerConnection, flushIceCandidates])

  // ── Skip / Next ─────────────────────────────────────────────────────────────
  const skip = useCallback(async () => {
    if (channelRef.current) {
      channelRef.current.send({
        type: 'broadcast',
        event: 'disconnect',
        payload: {}
      })
    }
    await cleanup()
    // Re-enter matchmaking automatically
    findMatch()
  }, [cleanup, findMatch])

  // ── Disconnect entirely ─────────────────────────────────────────────────────
  const disconnect = useCallback(async () => {
    if (channelRef.current) {
      channelRef.current.send({
        type: 'broadcast',
        event: 'disconnect',
        payload: {}
      })
    }
    await cleanup()
    stopCamera()
    setAppState('idle')
  }, [cleanup, stopCamera])

  // ── Toggle mute ─────────────────────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return
    localStreamRef.current.getAudioTracks().forEach(t => {
      t.enabled = !t.enabled
    })
    setIsMuted(m => !m)
  }, [])

  // ── Toggle camera ───────────────────────────────────────────────────────────
  const toggleCam = useCallback(() => {
    if (!localStreamRef.current) return
    localStreamRef.current.getVideoTracks().forEach(t => {
      t.enabled = !t.enabled
    })
    setIsCamOff(c => !c)
  }, [])

  // ── Cleanup on unmount ──────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      cleanup()
      stopCamera()
    }
  }, [cleanup, stopCamera])

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60).toString().padStart(2, '0')
    const s = (secs % 60).toString().padStart(2, '0')
    return `${m}:${s}`
  }

  const statusLabel: Record<AppState, string> = {
    idle: 'Ready to connect',
    camera: 'Starting camera...',
    searching: 'Finding someone...',
    waiting: 'Waiting for a match...',
    connecting: 'Connecting...',
    connected: `Connected ${formatTime(connectionTime)}`,
    disconnected: 'Disconnected',
    error: 'Camera permission denied'
  }

  const isConnected = appState === 'connected'
  const isActive = ['searching', 'waiting', 'connecting', 'connected'].includes(appState)

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=JetBrains+Mono:wght@400;500&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
          --bg: #080a0f;
          --surface: #0e1117;
          --border: rgba(255,255,255,0.07);
          --text: #e8eaf0;
          --muted: rgba(232,234,240,0.4);
          --accent: #00e5ff;
          --accent-dim: rgba(0,229,255,0.12);
          --accent-glow: rgba(0,229,255,0.3);
          --danger: #ff3b5c;
          --danger-dim: rgba(255,59,92,0.12);
          --success: #00e096;
          --warn: #ffb800;
        }

        body { background: var(--bg); }

        .app {
          font-family: 'Syne', sans-serif;
          min-height: 100dvh;
          background: var(--bg);
          color: var(--text);
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 20px 16px 32px;
          position: relative;
          overflow: hidden;
        }

        /* Animated background grid */
        .app::before {
          content: '';
          position: fixed;
          inset: 0;
          background-image:
            linear-gradient(rgba(0,229,255,0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(0,229,255,0.03) 1px, transparent 1px);
          background-size: 40px 40px;
          animation: gridDrift 20s linear infinite;
          pointer-events: none;
          z-index: 0;
        }

        /* Ambient glow orbs */
        .app::after {
          content: '';
          position: fixed;
          width: 600px;
          height: 600px;
          background: radial-gradient(circle, rgba(0,229,255,0.04) 0%, transparent 70%);
          top: -200px;
          left: 50%;
          transform: translateX(-50%);
          pointer-events: none;
          z-index: 0;
        }

        @keyframes gridDrift {
          0% { background-position: 0 0; }
          100% { background-position: 40px 40px; }
        }

        /* ── Header ── */
        .header {
          position: relative;
          z-index: 1;
          text-align: center;
          margin-bottom: 24px;
          width: 100%;
          max-width: 960px;
          display: flex;
          align-items: center;
          justify-content: space-between;
        }

        .logo {
          display: flex;
          align-items: baseline;
          gap: 6px;
        }

        .logo-word {
          font-size: 22px;
          font-weight: 800;
          letter-spacing: -0.5px;
          color: var(--text);
        }

        .logo-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--accent);
          box-shadow: 0 0 12px var(--accent-glow);
          animation: pulse 2s ease-in-out infinite;
          display: inline-block;
          margin-left: 2px;
          vertical-align: middle;
        }

        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.6; transform: scale(0.8); }
        }

        .user-id {
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          color: var(--muted);
          background: var(--surface);
          border: 1px solid var(--border);
          padding: 4px 10px;
          border-radius: 20px;
        }

        /* ── Status bar ── */
        .status-bar {
          position: relative;
          z-index: 1;
          width: 100%;
          max-width: 960px;
          margin-bottom: 16px;
          display: flex;
          align-items: center;
          gap: 10px;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 10px 16px;
        }

        .status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          flex-shrink: 0;
          transition: background 0.3s;
        }

        .status-dot.idle { background: var(--muted); }
        .status-dot.searching, .status-dot.waiting, .status-dot.connecting {
          background: var(--warn);
          animation: blink 1s ease-in-out infinite;
        }
        .status-dot.connected { background: var(--success); box-shadow: 0 0 8px var(--success); }
        .status-dot.disconnected { background: var(--danger); }
        .status-dot.error { background: var(--danger); }
        .status-dot.camera { background: var(--warn); }

        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }

        .status-text {
          font-family: 'JetBrains Mono', monospace;
          font-size: 13px;
          color: var(--text);
          flex: 1;
        }

        .partner-badge {
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          color: var(--accent);
          background: var(--accent-dim);
          border: 1px solid rgba(0,229,255,0.2);
          padding: 3px 8px;
          border-radius: 20px;
        }

        /* ── Video Stage ── */
        .stage {
          position: relative;
          z-index: 1;
          width: 100%;
          max-width: 960px;
          display: grid;
          grid-template-columns: 1fr;
          gap: 12px;
          margin-bottom: 16px;
        }

        @media (min-width: 640px) {
          .stage {
            grid-template-columns: 1fr 280px;
            grid-template-rows: auto;
          }
        }

        /* Remote video */
        .video-card {
          position: relative;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 16px;
          overflow: hidden;
          aspect-ratio: 16/9;
        }

        .video-card.remote {
          border-color: rgba(0,229,255,0.15);
        }

        .video-card video {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }

        .video-card.local video {
          transform: scaleX(-1);
        }

        /* Placeholder when no video */
        .video-placeholder {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 12px;
        }

        .avatar-ring {
          width: 72px;
          height: 72px;
          border-radius: 50%;
          border: 2px solid var(--border);
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
        }

        .avatar-ring.searching {
          border-color: var(--warn);
          animation: spin-ring 2s linear infinite;
        }

        @keyframes spin-ring {
          0% { box-shadow: 0 0 0 0 rgba(255,184,0,0.4); }
          50% { box-shadow: 0 0 0 8px rgba(255,184,0,0); }
          100% { box-shadow: 0 0 0 0 rgba(255,184,0,0); }
        }

        .avatar-icon {
          font-size: 28px;
          opacity: 0.3;
        }

        .placeholder-label {
          font-size: 13px;
          color: var(--muted);
          font-family: 'JetBrains Mono', monospace;
        }

        /* Scanning line effect */
        .video-card.remote.searching::after {
          content: '';
          position: absolute;
          left: 0;
          right: 0;
          height: 2px;
          background: linear-gradient(90deg, transparent, var(--accent), transparent);
          animation: scanline 2s linear infinite;
          top: 0;
        }

        @keyframes scanline {
          0% { top: 0%; opacity: 1; }
          100% { top: 100%; opacity: 0; }
        }

        /* Video label */
        .video-label {
          position: absolute;
          top: 12px;
          left: 12px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          color: var(--text);
          background: rgba(8,10,15,0.7);
          backdrop-filter: blur(8px);
          padding: 4px 10px;
          border-radius: 20px;
          border: 1px solid var(--border);
        }

        /* Live indicator */
        .live-badge {
          position: absolute;
          top: 12px;
          right: 12px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 10px;
          font-weight: 500;
          color: #fff;
          background: var(--danger);
          padding: 3px 8px;
          border-radius: 20px;
          display: flex;
          align-items: center;
          gap: 4px;
        }

        .live-badge::before {
          content: '';
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: #fff;
          animation: blink 1s ease-in-out infinite;
        }

        /* ── Controls ── */
        .controls {
          position: relative;
          z-index: 1;
          width: 100%;
          max-width: 960px;
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          justify-content: center;
        }

        .btn {
          font-family: 'Syne', sans-serif;
          font-weight: 700;
          font-size: 14px;
          letter-spacing: 0.3px;
          border: none;
          border-radius: 12px;
          cursor: pointer;
          padding: 12px 24px;
          transition: all 0.15s ease;
          display: flex;
          align-items: center;
          gap: 8px;
          position: relative;
          overflow: hidden;
        }

        .btn:active { transform: scale(0.97); }
        .btn:disabled { opacity: 0.4; cursor: not-allowed; }

        .btn-primary {
          background: var(--accent);
          color: #000;
          box-shadow: 0 0 24px var(--accent-glow), 0 4px 12px rgba(0,0,0,0.3);
        }

        .btn-primary:hover:not(:disabled) {
          box-shadow: 0 0 36px var(--accent-glow), 0 4px 16px rgba(0,0,0,0.3);
          background: #1af0ff;
        }

        .btn-ghost {
          background: var(--surface);
          color: var(--text);
          border: 1px solid var(--border);
        }

        .btn-ghost:hover:not(:disabled) {
          border-color: rgba(255,255,255,0.15);
          background: rgba(255,255,255,0.05);
        }

        .btn-ghost.active {
          background: var(--accent-dim);
          border-color: rgba(0,229,255,0.25);
          color: var(--accent);
        }

        .btn-danger {
          background: var(--danger-dim);
          color: var(--danger);
          border: 1px solid rgba(255,59,92,0.2);
        }

        .btn-danger:hover:not(:disabled) {
          background: rgba(255,59,92,0.2);
          box-shadow: 0 0 16px rgba(255,59,92,0.2);
        }

        .btn-skip {
          background: rgba(255,184,0,0.1);
          color: var(--warn);
          border: 1px solid rgba(255,184,0,0.2);
        }

        .btn-skip:hover:not(:disabled) {
          background: rgba(255,184,0,0.18);
        }

        /* ── Footer ── */
        .footer {
          position: relative;
          z-index: 1;
          margin-top: 24px;
          font-size: 11px;
          color: var(--muted);
          font-family: 'JetBrains Mono', monospace;
          text-align: center;
        }

        /* ── Responsive ── */
        @media (max-width: 639px) {
          .controls { gap: 8px; }
          .btn { padding: 11px 18px; font-size: 13px; }
        }
      `}</style>

      <main className="app">
        {/* ── Header ── */}
        <header className="header">
          <div className="logo">
            <span className="logo-word">strangr</span>
            <span className="logo-dot" />
          </div>
          <span className="user-id">#{MY_ID}</span>
        </header>

        {/* ── Status Bar ── */}
        <div className="status-bar">
          <div className={`status-dot ${appState}`} />
          <span className="status-text">{statusLabel[appState]}</span>
          {partnerId && <span className="partner-badge">#{partnerId}</span>}
        </div>

        {/* ── Video Stage ── */}
        <div className="stage">
          {/* Remote */}
          <div className={`video-card remote ${!isConnected ? appState : ''}`}>
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              style={{ display: isConnected ? 'block' : 'none' }}
            />
            {!isConnected && (
              <div className="video-placeholder">
                <div className={`avatar-ring ${appState === 'searching' || appState === 'waiting' || appState === 'connecting' ? 'searching' : ''}`}>
                  <span className="avatar-icon">
                    {appState === 'idle' || appState === 'camera' ? '👤' : '⌛'}
                  </span>
                </div>
                <span className="placeholder-label">
                  {appState === 'idle' ? 'no one yet' :
                   appState === 'camera' ? 'starting up...' :
                   appState === 'searching' ? 'scanning...' :
                   appState === 'waiting' ? 'in queue...' :
                   appState === 'connecting' ? 'handshaking...' :
                   appState === 'disconnected' ? 'disconnected' :
                   appState === 'error' ? 'check permissions' : ''}
                </span>
              </div>
            )}
            <div className="video-label">
              {partnerId ? `#${partnerId}` : 'stranger'}
            </div>
            {isConnected && <div className="live-badge">LIVE</div>}
          </div>

          {/* Local */}
          <div className="video-card local">
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              style={{ display: localStreamRef.current ? 'block' : 'none' }}
            />
            {!localStreamRef.current && (
              <div className="video-placeholder">
                <div className="avatar-ring">
                  <span className="avatar-icon">📷</span>
                </div>
                <span className="placeholder-label">you</span>
              </div>
            )}
            <div className="video-label">you</div>
          </div>
        </div>

        {/* ── Controls ── */}
        <div className="controls">
          {/* Start / Find Match */}
          {!isActive && (
            <button
              className="btn btn-primary"
              onClick={findMatch}
              disabled={appState === 'camera'}
            >
              {appState === 'idle' ? '⚡ Start & Match' :
               appState === 'disconnected' ? '↺ Find New Match' :
               appState === 'error' ? '↺ Try Again' : '…'}
            </button>
          )}

          {/* Skip to next (when connected) */}
          {isConnected && (
            <button className="btn btn-skip" onClick={skip}>
              ⏭ Next
            </button>
          )}

          {/* Mute / Unmute */}
          {isActive && (
            <button
              className={`btn btn-ghost ${isMuted ? 'active' : ''}`}
              onClick={toggleMute}
            >
              {isMuted ? '🔇 Unmute' : '🎙 Mute'}
            </button>
          )}

          {/* Cam on/off */}
          {isActive && (
            <button
              className={`btn btn-ghost ${isCamOff ? 'active' : ''}`}
              onClick={toggleCam}
            >
              {isCamOff ? '📷 Cam On' : '📷 Cam Off'}
            </button>
          )}

          {/* Disconnect */}
          {isActive && (
            <button className="btn btn-danger" onClick={disconnect}>
              ✕ Leave
            </button>
          )}
        </div>

        <footer className="footer">
          end-to-end encrypted · peer-to-peer · no recording
        </footer>
      </main>
    </>
  )
}