'use strict';

// ─── Voice Chat (WebRTC mesh, signaled via existing WebSocket) ────────────────

const Voice = (() => {
  let _ws          = null;
  let _myId        = null;
  let localStream  = null;
  let muted        = false;
  let voiceAudioCtx = null;

  const peers        = new Map();   // id -> RTCPeerConnection
  const iceQueues    = new Map();   // id -> RTCIceCandidateInit[] (buffered before remoteDesc)
  const speakingSet  = new Set();   // ids currently speaking (including self)

  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  // ── VAD ────────────────────────────────────────────────────────────────────

  function getVoiceAudioCtx() {
    if (!voiceAudioCtx) voiceAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return voiceAudioCtx;
  }

  // Returns a cancel fn. onActive/onSilent called on transitions.
  function startVAD(stream, id, onActive, onSilent) {
    let analyser;
    try {
      const ac  = getVoiceAudioCtx();
      const src = ac.createMediaStreamSource(stream);
      analyser  = ac.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
    } catch (_) { return () => {}; }

    const buf        = new Uint8Array(analyser.frequencyBinCount);
    const THRESHOLD  = 22;
    const HOLD_MS    = 700;
    let   active     = false;
    let   holdTimer  = null;

    const interval = setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      let rms = 0;
      for (let i = 0; i < buf.length; i++) rms += (buf[i] - 128) ** 2;
      rms = Math.sqrt(rms / buf.length);

      if (rms > THRESHOLD) {
        clearTimeout(holdTimer); holdTimer = null;
        if (!active) { active = true; onActive(); }
      } else if (active && !holdTimer) {
        holdTimer = setTimeout(() => { active = false; holdTimer = null; onSilent(); }, HOLD_MS);
      }
    }, 80);

    return () => { clearInterval(interval); clearTimeout(holdTimer); };
  }

  // ── Peer connections ────────────────────────────────────────────────────────

  function send(obj) {
    if (_ws && _ws.readyState === WebSocket.OPEN) _ws.send(JSON.stringify(obj));
  }

  function makePC(remoteId) {
    if (peers.has(remoteId)) peers.get(remoteId).close();

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peers.set(remoteId, pc);
    iceQueues.set(remoteId, []);

    if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) send({ type: 'rtc_ice', to: remoteId, candidate: candidate.toJSON() });
    };

    pc.ontrack = ({ streams }) => {
      if (!streams[0]) return;
      attachAudio(remoteId, streams[0]);
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) dropPeer(remoteId);
    };

    return pc;
  }

  function attachAudio(id, stream) {
    let el = document.getElementById(`vc-audio-${id}`);
    if (!el) {
      el = document.createElement('audio');
      el.id        = `vc-audio-${id}`;
      el.autoplay  = true;
      el.style.display = 'none';
      document.body.appendChild(el);
    }
    el.srcObject = stream;
  }

  async function drainIceQueue(remoteId) {
    const pc    = peers.get(remoteId);
    const queue = iceQueues.get(remoteId) || [];
    iceQueues.set(remoteId, []);
    for (const c of queue) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (_) {}
    }
  }

  async function initiateOffer(remoteId) {
    const pc    = makePC(remoteId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: 'rtc_offer', to: remoteId, sdp: offer.sdp });
  }

  async function handleOffer(remoteId, sdp) {
    const pc = makePC(remoteId);
    await pc.setRemoteDescription({ type: 'offer', sdp });
    await drainIceQueue(remoteId);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ type: 'rtc_answer', to: remoteId, sdp: answer.sdp });
  }

  async function handleAnswer(remoteId, sdp) {
    const pc = peers.get(remoteId);
    if (!pc) return;
    await pc.setRemoteDescription({ type: 'answer', sdp });
    await drainIceQueue(remoteId);
  }

  async function handleIce(remoteId, candidate) {
    const pc = peers.get(remoteId);
    if (!pc || !pc.remoteDescription) {
      (iceQueues.get(remoteId) || []).push(candidate);
      return;
    }
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
  }

  function dropPeer(id) {
    peers.get(id)?.close();
    peers.delete(id);
    iceQueues.delete(id);
    speakingSet.delete(id);
    const el = document.getElementById(`vc-audio-${id}`);
    if (el) el.remove();
  }

  // ── Signal handler (called from game.js ws.onmessage) ──────────────────────

  function handle(msg) {
    switch (msg.type) {
      case 'peer_joined':
        // Existing player: wait for joiner's offer (don't initiate)
        makePC(msg.id);
        break;
      case 'peer_left':
        dropPeer(msg.id);
        break;
      case 'rtc_offer':
        handleOffer(msg.from, msg.sdp).catch(console.warn);
        break;
      case 'rtc_answer':
        handleAnswer(msg.from, msg.sdp).catch(console.warn);
        break;
      case 'rtc_ice':
        if (msg.candidate) handleIce(msg.from, msg.candidate).catch(console.warn);
        break;
      case 'speaking':
        if (msg.speaking) speakingSet.add(msg.id);
        else speakingSet.delete(msg.id);
        break;
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async function init(ws, myId, initialPeers) {
    _ws   = ws;
    _myId = myId;

    // Request mic
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

      // Local VAD → broadcast speaking state
      startVAD(localStream, myId,
        () => { speakingSet.add(myId);    send({ type: 'speaking', speaking: true  }); },
        () => { speakingSet.delete(myId); send({ type: 'speaking', speaking: false }); }
      );

      updateMuteUI();
    } catch (e) {
      console.warn('[voice] Mic unavailable:', e.message);
      updateMuteUI(true);
    }

    // Offer to all players already in the game
    for (const id of initialPeers) initiateOffer(id).catch(console.warn);
  }

  function setMuted(val) {
    muted = val;
    if (localStream) localStream.getAudioTracks().forEach(t => { t.enabled = !muted; });
    updateMuteUI();
  }

  function updateMuteUI(noMic = false) {
    const btn = document.getElementById('mute-btn');
    if (!btn) return;
    if (noMic) {
      btn.textContent  = '🎤 No mic';
      btn.style.opacity = '0.4';
      btn.disabled     = true;
    } else {
      btn.textContent  = muted ? '🎤 Muted' : '🎤 Live';
      btn.style.background = muted ? '#922' : '#196319';
      btn.disabled     = false;
    }
  }

  return { init, handle, setMuted, getSpeakingSet: () => speakingSet };
})();
