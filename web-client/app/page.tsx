'use client'
import { useState, useRef } from 'react'
import { supabase } from './supabase'

export default function Home() {
  const [status, setStatus] = useState('Idle');
  const [partner, setPartner] = useState<string | null>(null);
  
  // These refs hold the video elements on the screen
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  
  // These refs hold our connection data in the background
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<any>(null);
  const myIdRef = useRef<string>(Math.random().toString(36).substring(7));

  // Public Google STUN servers to figure out our network IP addresses
  const rtcConfig = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  };

  // --- PHASE 1: TURN ON THE CAMERA ---
  const startCamera = async () => {
    try {
      setStatus('Starting camera...');
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      return stream;
    } catch (error) {
      console.error("Camera error:", error);
      setStatus('Camera blocked. Please allow permissions.');
      return null;
    }
  };

  // --- PHASE 2: MATCHMAKING & SIGNALING ---
  const findMatch = async () => {
    const localStream = await startCamera();
    if (!localStream) return;

    setStatus('Searching for a partner...');

    // 1. Hit your Upstash Serverless Queue
    const res = await fetch('/api/match', {
      method: 'POST',
      body: JSON.stringify({ userId: myIdRef.current })
    });
    const data = await res.json();

    // 2. Determine who is calling who based on the database queue
    const roomId = data.match ? data.match : myIdRef.current;
    const isCaller = !!data.match; // If we found a match, WE are the caller.

    if (data.match) {
      setPartner(data.match);
      setStatus('Match found! Connecting...');
    } else {
      setStatus('Waiting in queue...');
    }

    // 3. Open a Supabase Realtime WebSocket for this specific Room ID
    const channel = supabase.channel(`room_${roomId}`);
    channelRef.current = channel;

    // 4. Set up the WebRTC Peer Connection
    const pc = new RTCPeerConnection(rtcConfig);
    peerConnectionRef.current = pc;

    // Add our local camera feed to the connection
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    // When the remote user's video arrives, attach it to the big screen!
    pc.ontrack = (event) => {
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    // When our browser finds an internet routing path (ICE), send it to Supabase
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        channel.send({
          type: 'broadcast',
          event: 'ice-candidate',
          payload: { candidate: event.candidate }
        });
      }
    };

    // 5. Listen for incoming WebRTC packets from Supabase
    channel.on('broadcast', { event: 'offer' }, async ({ payload }) => {
      await pc.setRemoteDescription(new RTCSessionDescription(payload.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      channel.send({
        type: 'broadcast',
        event: 'answer',
        payload: { answer }
      });
      setStatus('Connected! 🚀');
    });

    channel.on('broadcast', { event: 'answer' }, async ({ payload }) => {
      await pc.setRemoteDescription(new RTCSessionDescription(payload.answer));
      setStatus('Connected! 🚀');
    });

    channel.on('broadcast', { event: 'ice-candidate' }, async ({ payload }) => {
      await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
    });

    // 6. Finalize Subscription and Make the Call
    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED' && isCaller) {
        // If we are the caller, we kick off the handshake by sending an Offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        channel.send({
          type: 'broadcast',
          event: 'offer',
          payload: { offer }
        });
      }
    });
  };

  return (
    <main className="flex flex-col items-center justify-center min-h-screen bg-gray-950 text-white p-4">
      <h1 className="text-4xl font-bold mb-4 text-blue-500">Serverless WebRTC</h1>
      <p className="text-xl mb-8 text-gray-400">{status}</p>

      <div className="flex flex-col md:flex-row gap-4 mb-8 w-full max-w-5xl">
        {/* Remote Video (The big screen) */}
        <div className="flex-1 bg-gray-900 rounded-xl overflow-hidden shadow-lg border border-gray-800 relative aspect-video">
          <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-cover" />
          <div className="absolute top-4 left-4 bg-black/60 px-3 py-1 rounded text-sm text-gray-300">
            Partner {partner ? `(${partner})` : ''}
          </div>
        </div>

        {/* Local Video (Your camera) */}
        <div className="w-full md:w-1/3 bg-gray-900 rounded-xl overflow-hidden shadow-lg border border-gray-800 relative aspect-video">
          <video ref={localVideoRef} autoPlay playsInline muted className="w-full h-full object-cover transform scale-x-[-1]" />
          <div className="absolute top-4 left-4 bg-black/60 px-3 py-1 rounded text-sm text-gray-300">
            You
          </div>
        </div>
      </div>

      <button 
        onClick={findMatch}
        className="px-8 py-4 bg-blue-600 hover:bg-blue-700 rounded-lg font-bold text-xl transition shadow-lg shadow-blue-500/30"
      >
        Start Camera & Find Match
      </button>
    </main>
  )
}