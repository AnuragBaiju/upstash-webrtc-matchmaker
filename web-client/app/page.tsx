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
  const [localIsMain, setLocalIsMain] = useState(false) // Track which video is expanded

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
    setLocalIsMain(false)
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
      config: { broadcast: { self: false } }
    })
    channelRef.current = channel

    // Build peer connection
    const pc = createPeerConnection(localStream, channel, isCaller)

    // ── Signaling listeners ────────────────────────────────────────────────────
    channel.on('broadcast', { event: 'joined' }, async ({ payload }: any) => {
      if (!isCaller) {
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

    channel.on('broadcast', { event: 'offer' }, async ({ payload }: any) => {
      if (payload.from === MY_ID) return
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
        iceCandidateQueueRef.current.push(payload.candidate)
      }
    })

    channel.on('broadcast', { event: 'disconnect' }, () => {
      setAppState('disconnected')
      cleanup()
    })

    channel.subscribe(async (status: string) => {
      if (status !== 'SUBSCRIBED') return

      if (isCaller) {
        channel.send({
          type: 'broadcast',
          event: 'joined',
          payload: { callerId: MY_ID }
        })
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
    idle: 'Ready to say hi?',
    camera: 'Warming up camera...',
    searching: 'Looking for someone...',
    waiting: 'Waiting for a match...',
    connecting: 'Connecting...',
    connected: `Chatting ${formatTime(connectionTime)}`,
    disconnected: 'They stepped away',
    error: 'Camera permission needed'
  }

  const isConnected = appState === 'connected'
  const isActive = ['searching', 'waiting', 'connecting', 'connected'].includes(appState)

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Quicksand:wght@500;600;700&family=Nunito:wght@400;600;700&display=swap');

        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
          /* New Theme Variables */
          --bg: #21243D;
          --surface: #2b2f4c;
          --surface-glass: rgba(43, 47, 76, 0.7);
          --text: #FFFFFF;
          --muted: #A0AEC0;
          --accent: #FF7C7C;
          --accent-hover: #fa6666;
          --accent-minor: #FFD082;
          --danger: #FF7C7C;
          --success: #48BB78;
          
          --shadow-sm: 0 4px 6px -1px rgba(0, 0, 0, 0.3);
          --shadow-lg: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
          --shadow-xl: 0 20px 40px -10px rgba(0, 0, 0, 0.6);
        }

        body { 
          background: var(--bg); 
          color: var(--text);
          font-family: 'Nunito', sans-serif;
          -webkit-font-smoothing: antialiased;
        }

        .app {
          min-height: 100dvh;
          display: flex;
          flex-direction: column;
          align-items: center;
          padding: 16px;
          position: relative;
        }

        /* ── Header & Status Bar ── */
        .top-bar {
          width: 100%;
          max-width: 1200px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 24px;
          background: var(--surface);
          border-radius: 100px;
          box-shadow: var(--shadow-sm);
          margin-bottom: 16px;
          z-index: 10;
        }

        .logo {
          font-family: 'Quicksand', sans-serif;
          font-size: 24px;
          font-weight: 700;
          color: var(--accent);
          letter-spacing: -0.5px;
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .status-container {
          display: flex;
          align-items: center;
          gap: 8px;
          font-weight: 600;
          color: var(--text);
        }

        .status-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          transition: background 0.3s;
        }
        .status-dot.idle { background: var(--muted); }
        .status-dot.searching, .status-dot.waiting, .status-dot.connecting { background: var(--accent-minor); animation: pulse 1.5s infinite; }
        .status-dot.connected { background: var(--success); }
        .status-dot.disconnected, .status-dot.error { background: var(--danger); }

        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }

        /* ── Video Stage ── */
        .stage {
          position: relative;
          width: 100%;
          max-width: 1400px;
          flex: 1;
          background: var(--surface);
          border-radius: 32px;
          box-shadow: var(--shadow-lg);
          overflow: hidden;
          margin-bottom: 16px;
        }

        .video-card {
          position: absolute;
          border-radius: 32px;
          overflow: hidden;
          background: var(--surface);
          transition: all 0.5s cubic-bezier(0.25, 1, 0.5, 1);
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

        /* Main Fullscreen Video */
        .video-card.main {
          inset: 0;
          width: 100%;
          height: 100%;
          z-index: 1;
          border-radius: 32px;
        }

        /* Picture-in-Picture Video */
        .video-card.pip {
          bottom: 100px; /* Leave room for controls */
          right: 24px;
          width: 160px;
          height: 240px;
          z-index: 5;
          border: 4px solid var(--surface);
          box-shadow: var(--shadow-xl);
          cursor: pointer;
        }

        @media (min-width: 768px) {
          .video-card.pip {
            width: 220px;
            height: 310px;
            bottom: 32px;
            right: 32px;
          }
        }

        .video-card.pip:hover {
          transform: scale(1.05);
        }

        /* Placeholder Content */
        .video-placeholder {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 16px;
          background: var(--surface);
        }

        .avatar-circle {
          width: 80px;
          height: 80px;
          border-radius: 50%;
          background: var(--bg);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 32px;
          box-shadow: var(--shadow-sm);
          color: var(--accent-minor);
        }

        .placeholder-label {
          font-family: 'Quicksand', sans-serif;
          font-size: 16px;
          font-weight: 600;
          color: var(--muted);
        }

        /* Labels over video */
        .video-label {
          position: absolute;
          top: 16px;
          left: 16px;
          font-weight: 700;
          font-size: 12px;
          color: var(--text);
          background: var(--surface-glass);
          backdrop-filter: blur(8px);
          padding: 6px 14px;
          border-radius: 100px;
          box-shadow: var(--shadow-sm);
          border: 1px solid rgba(255, 255, 255, 0.05);
        }

        /* ── Controls Overlay ── */
        .controls-wrapper {
          position: absolute;
          bottom: 24px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 10;
          display: flex;
          gap: 12px;
          background: var(--surface-glass);
          backdrop-filter: blur(12px);
          padding: 12px 20px;
          border-radius: 100px;
          box-shadow: var(--shadow-lg);
          border: 1px solid rgba(255, 255, 255, 0.05);
        }

        .btn {
          font-family: 'Quicksand', sans-serif;
          font-weight: 700;
          font-size: 15px;
          border: none;
          border-radius: 100px;
          cursor: pointer;
          padding: 12px 24px;
          transition: all 0.2s ease;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .btn:active { transform: scale(0.95); }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }

        .btn-primary {
          background: var(--accent);
          color: #fff;
          box-shadow: 0 4px 14px rgba(255, 124, 124, 0.3);
        }
        .btn-primary:hover:not(:disabled) { 
          background: var(--accent-hover); 
          transform: translateY(-2px); 
        }

        .btn-secondary {
          background: rgba(255, 255, 255, 0.1);
          color: var(--text);
        }
        .btn-secondary:hover { background: rgba(255, 255, 255, 0.15); }
        .btn-secondary.active { 
          background: var(--accent); 
          color: #fff; 
        }

        .btn-danger {
          background: rgba(255, 124, 124, 0.15);
          color: var(--accent);
          border: 1px solid rgba(255, 124, 124, 0.3);
        }
        .btn-danger:hover { background: rgba(255, 124, 124, 0.25); }

        .btn-skip {
          background: rgba(255, 208, 130, 0.15);
          color: var(--accent-minor);
          border: 1px solid rgba(255, 208, 130, 0.3);
        }
        .btn-skip:hover { background: rgba(255, 208, 130, 0.25); }

      `}</style>

      <main className="app">
        {/* ── Top Bar ── */}
        <header className="top-bar">
          <div className="logo">
            👋 strangr
          </div>
          <div className="status-container">
            <div className={`status-dot ${appState}`} />
            <span>{statusLabel[appState]}</span>
          </div>
        </header>

        {/* ── Video Stage ── */}
        <div className="stage">
          {/* Remote Video Container */}
          <div 
            className={`video-card remote ${localIsMain ? 'pip' : 'main'}`}
            onClick={() => localIsMain && setLocalIsMain(false)}
          >
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              style={{ display: isConnected ? 'block' : 'none' }}
            />
            {!isConnected && (
              <div className="video-placeholder">
                <div className="avatar-circle">
                  {appState === 'idle' ? '☕' : appState === 'searching' ? '🔍' : '⏳'}
                </div>
                <span className="placeholder-label">
                  {appState === 'idle' ? 'Ready when you are' :
                   appState === 'searching' ? 'Finding a friendly face...' :
                   appState === 'waiting' ? 'Waiting for someone...' :
                   appState === 'connecting' ? 'Say hi! 👋' : 'Looking for connection...'}
                </span>
              </div>
            )}
            <div className="video-label">
              {partnerId ? `Stranger` : 'Stranger'}
            </div>
          </div>

          {/* Local Video Container */}
          <div 
            className={`video-card local ${!localIsMain ? 'pip' : 'main'}`}
            onClick={() => !localIsMain && setLocalIsMain(true)}
          >
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              style={{ display: localStreamRef.current ? 'block' : 'none' }}
            />
            {!localStreamRef.current && (
              <div className="video-placeholder">
                <div className="avatar-circle">😊</div>
                <span className="placeholder-label">You</span>
              </div>
            )}
            <div className="video-label">You</div>
          </div>

          {/* ── Controls Overlay ── */}
          <div className="controls-wrapper">
            {/* Start / Find Match */}
            {!isActive && (
              <button
                className="btn btn-primary"
                onClick={findMatch}
                disabled={appState === 'camera'}
              >
                {appState === 'idle' ? '✨ Start Chatting' :
                 appState === 'disconnected' ? '🔄 Find New Match' :
                 appState === 'error' ? '🔄 Try Again' : '...'}
              </button>
            )}

            {/* Skip */}
            {isConnected && (
              <button className="btn btn-skip" onClick={skip}>
                ⏭️ Next
              </button>
            )}

            {/* Mic Toggle */}
            {isActive && (
              <button
                className={`btn btn-secondary ${isMuted ? 'active' : ''}`}
                onClick={toggleMute}
              >
                {isMuted ? '🔇 Muted' : '🎙️ Mic On'}
              </button>
            )}

            {/* Camera Toggle */}
            {isActive && (
              <button
                className={`btn btn-secondary ${isCamOff ? 'active' : ''}`}
                onClick={toggleCam}
              >
                {isCamOff ? '📷 Cam Off' : '📸 Cam On'}
              </button>
            )}

            {/* Leave */}
            {isActive && (
              <button className="btn btn-danger" onClick={disconnect}>
                ❌ Leave
              </button>
            )}
          </div>
        </div>
      </main>
    </>
  )
}