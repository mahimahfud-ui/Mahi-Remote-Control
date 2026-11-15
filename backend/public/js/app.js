(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const state = {
    ws: null,
    wsConnecting: false,
    reconnectTimer: null,
    pingTimer: null,
    lastPingAt: 0,
    runtimeConfig: null,
    controllerFingerprint: null,
    sessionId: null,
    sessionToken: null,
    targetDeviceId: null,
    targetDeviceName: 'Android device',
    pairingRequestId: null,
    peerConnection: null,
    pendingIceCandidates: [],
    hasFirstFrame: false,
    sessionStartedAt: 0,
    durationTimer: null,
    commandSequence: 1,
    pointerStart: null,
    targetWidth: 1080,
    targetHeight: 1920,
    currentPath: '',
    apps: [],
    files: []
  };

  const el = {
    pair: $('#pair'),
    app: $('#app'),
    codeBoxes: $$('.code input'),
    pairStatus: $('#pair-status'),
    connect: $('#connect'),
    deviceName: $('#device-model-text'),
    deviceStatus: $('#device-status-text'),
    latency: $('#latency-text'),
    duration: $('#dur'),
    stage: $('.stage'),
    canvas: $('#screen'),
    video: $('#remote-video'),
    coords: $('#coords'),
    drawer: $('#drawer'),
    closeDrawer: $('#close-drawer'),
    apps: $('#app-list'),
    files: $('#file-list'),
    search: $('#search'),
    crumbs: $('#crumbs'),
    battery: $('#diag-battery'),
    batteryBar: $('#diag-battery-bar'),
    storage: $('#diag-storage'),
    memory: $('#diag-memory'),
    temperature: $('#diag-temp'),
    diagLatency: $('#diag-latency'),
    fps: $('#diag-fps'),
    bitrate: $('#diag-bitrate'),
    modal: $('#modal'),
    cancel: $('#cancel'),
    confirm: $('#confirm'),
    retry: $('#retry'),
    toast: $('#toast')
  };

  const canvasContext = el.canvas ? el.canvas.getContext('2d') : null;

  function toast(message) {
    if (!el.toast) return;
    el.toast.textContent = message;
    el.toast.classList.add('show');
    clearTimeout(el.toastTimer);
    el.toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2600);
  }

  function audit(message, severity) {
    const prefix = severity ? '[' + severity.toUpperCase() + '] ' : '';
    console.info('[Mahi Remote] ' + prefix + message);
  }

  function setPairStatus(message, error) {
    if (!el.pairStatus) return;
    el.pairStatus.textContent = message || '';
    el.pairStatus.className = 'status' + (error ? ' error' : '');
    if (el.pairStatus.querySelector('.spinner')) el.pairStatus.querySelector('.spinner').remove();
  }

  function setStage(mode) {
    if (el.stage) el.stage.dataset.state = mode;
  }

  function setDeviceStatus(message) {
    if (el.deviceStatus) el.deviceStatus.textContent = message;
  }

  function setCodeValue(code) {
    const digits = String(code || '').replace(/\D/g, '').slice(0, 6);
    el.codeBoxes.forEach((box, index) => { box.value = digits[index] || ''; });
    if (el.connect) el.connect.disabled = digits.length !== 6;
  }

  function getCodeValue() {
    return el.codeBoxes.map(box => box.value).join('');
  }

  function getControllerFingerprint() {
    const storageKey = 'mahi.remote.controllerFingerprint.v1';
    let value = '';
    try {
      value = sessionStorage.getItem(storageKey) || '';
      if (!/^WEB-[A-F0-9]{32}$/.test(value)) {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        value = 'WEB-' + Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
        sessionStorage.setItem(storageKey, value);
      }
    } catch (error) {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      value = 'WEB-' + Array.from(bytes).map(byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
    }
    return value;
  }

  function parsePayload(value) {
    if (typeof value === 'string') {
      try { return JSON.parse(value); } catch (_) { return {}; }
    }
    return value || {};
  }

  function setConnectedUi() {
    el.pair.hidden = true;
    el.app.hidden = false;
    if (el.deviceName) el.deviceName.textContent = state.targetDeviceName;
    setDeviceStatus('Approved · establishing encrypted media path');
    if (el.latency) el.latency.textContent = 'Negotiating video';
    setStage('loading');
    if (el.drawer) el.drawer.inert = true;
  }

  function startDurationTimer() {
    state.sessionStartedAt = Date.now();
    clearInterval(state.durationTimer);
    state.durationTimer = setInterval(() => {
      const seconds = Math.max(0, Math.floor((Date.now() - state.sessionStartedAt) / 1000));
      const values = [
        String(Math.floor(seconds / 3600)).padStart(2, '0'),
        String(Math.floor((seconds % 3600) / 60)).padStart(2, '0'),
        String(seconds % 60).padStart(2, '0')
      ];
      if (el.duration) el.duration.textContent = values.join(':');
    }, 1000);
  }

  async function loadRuntimeConfig() {
    const response = await fetch('/api/v1/config', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin'
    });
    if (!response.ok) throw new Error('Configuration endpoint returned HTTP ' + response.status);
    const config = await response.json();
    if (!config.browserAccessConfigured || !config.signalingUrl || !String(config.signalingUrl).startsWith('wss://')) {
      throw new Error('Public HTTPS/WSS access is not configured on the backend.');
    }
    state.runtimeConfig = config;
    if (!config.turnConfigured) {
      audit('TURN is not configured. Direct ICE may work, but some mobile carrier networks will require a deployed TURN relay.', 'warning');
    }
  }

  function connectSignaling() {
    if (state.wsConnecting || (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING))) return;
    const configured = state.runtimeConfig && state.runtimeConfig.signalingUrl;
    if (!configured) {
      setPairStatus('Secure signaling is not configured. Ask the administrator to configure PUBLIC_BASE_URL.', true);
      return;
    }

    state.wsConnecting = true;
    const wsUrl = new URL(configured);
    wsUrl.searchParams.set('controllerFingerprint', state.controllerFingerprint);
    try {
      const socket = new WebSocket(wsUrl.toString());
      state.ws = socket;

      socket.onopen = () => {
        state.wsConnecting = false;
        audit('Secure WSS signaling connected.');
        clearInterval(state.pingTimer);
        sendWs({ type: 'PING' });
        state.pingTimer = setInterval(() => sendWs({ type: 'PING' }), 15000);
        if (state.sessionToken && state.targetDeviceId) {
          startControllerOffer().catch(error => {
            audit('Media reconnect failed: ' + error.message, 'error');
            setStage('error');
          });
        } else {
          setPairStatus('Secure connection ready. Enter the code shown on the phone.');
        }
      };

      socket.onmessage = event => {
        try {
          handleSignalingMessage(JSON.parse(event.data));
        } catch (error) {
          audit('Invalid signaling message: ' + error.message, 'error');
        }
      };

      socket.onerror = () => {
        audit('WSS transport reported an error.', 'error');
      };

      socket.onclose = () => {
        if (state.ws === socket) state.ws = null;
        state.wsConnecting = false;
        clearInterval(state.pingTimer);
        state.pingTimer = null;
        if (!state.sessionToken) setPairStatus('Signaling disconnected. Reconnecting…', true);
        setDeviceStatus(state.sessionToken ? 'Signaling reconnecting · session retained' : 'Not connected');
        if (!state.reconnectTimer) {
          state.reconnectTimer = setTimeout(() => {
            state.reconnectTimer = null;
            connectSignaling();
          }, 3000);
        }
      };
    } catch (error) {
      state.wsConnecting = false;
      setPairStatus('Could not connect to the secure signaling service: ' + error.message, true);
      if (!state.reconnectTimer) {
        state.reconnectTimer = setTimeout(() => {
          state.reconnectTimer = null;
          connectSignaling();
        }, 5000);
      }
    }
  }

  function sendWs(data) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
    const message = Object.assign({}, data);
    if (message.type === 'PING') state.lastPingAt = Date.now();
    const publicTypes = new Set(['PING', 'REGISTER', 'REGISTER_PAIRING_CODE', 'PAIR_BY_CODE', 'PAIR_CODE_CONNECT', 'PAIR_ACCEPT', 'PAIR_REJECT']);
    if (state.sessionToken && !publicTypes.has(message.type)) {
      message.sessionToken = state.sessionToken;
    }
    state.ws.send(JSON.stringify(message));
    return true;
  }

  function handleSignalingMessage(message) {
    switch (message.type) {
      case 'PONG': {
        const rtt = state.lastPingAt ? Date.now() - state.lastPingAt : null;
        if (rtt !== null && el.latency && !state.hasFirstFrame) el.latency.textContent = rtt + ' ms RTT · waiting for video';
        break;
      }
      case 'PAIR_PENDING':
        state.pairingRequestId = message.requestId || null;
        setPairStatus('Request sent. Waiting for the phone owner to approve.');
        toast('Waiting for phone owner approval');
        break;
      case 'PAIR_ACCEPT':
        if (!message.sessionToken || !message.sessionId || !message.sender) {
          setPairStatus('The server did not return valid session authorization.', true);
          return;
        }
        state.sessionToken = message.sessionToken;
        state.sessionId = message.sessionId;
        state.targetDeviceId = message.sender;
        state.targetDeviceName = message.receiverName || 'Android device';
        state.pairingRequestId = null;
        state.hasFirstFrame = false;
        state.pendingIceCandidates = [];
        setConnectedUi();
        startDurationTimer();
        audit('Owner approval received. Session token is active; requesting session-scoped ICE credentials.');
        startControllerOffer().catch(error => {
          audit('Unable to start WebRTC: ' + error.message, 'error');
          setStage('error');
          setDeviceStatus('Approved · media connection failed');
        });
        break;
      case 'PAIR_REJECT':
        state.pairingRequestId = null;
        if (el.connect) el.connect.disabled = getCodeValue().length !== 6;
        setPairStatus('The phone owner declined this connection request.', true);
        toast('Connection request declined');
        break;
      case 'PAIR_ERROR':
        state.pairingRequestId = null;
        if (el.connect) el.connect.disabled = getCodeValue().length !== 6;
        setPairStatus(message.error || 'Pairing failed. Check the code and try again.', true);
        break;
      case 'SESSION_ERROR':
        audit(message.error || 'Session authorization failed.', 'error');
        setDeviceStatus('Session authorization error');
        break;
      case 'SESSION_ENDED':
      case 'EMERGENCY_DISCONNECT':
        finishSession(message.reason || 'The approved session has ended.');
        break;
      case 'SDP_ANSWER': {
        if (!state.sessionId || message.sessionId !== state.sessionId) return;
        const payload = parsePayload(message.payload);
        const sdp = payload.sdp || message.sdp;
        if (sdp) applyRemoteAnswer(sdp).catch(error => audit('Could not apply SDP answer: ' + error.message, 'error'));
        break;
      }
      case 'ICE_CANDIDATE': {
        if (!state.sessionId || message.sessionId !== state.sessionId) return;
        const candidateData = parsePayload(message.payload);
        if (candidateData.candidate) addRemoteIceCandidate(candidateData).catch(error => audit('Could not add ICE candidate: ' + error.message, 'error'));
        break;
      }
      case 'APP_LIST_RESPONSE':
        renderApps(parsePayload(message.payload));
        break;
      case 'FILE_LIST_RESPONSE':
        renderFiles(parsePayload(message.payload));
        break;
      case 'DIAGNOSTICS_RESULT':
        renderDiagnostics(parsePayload(message.payload));
        break;
      case 'DISPLAY_INFO': {
        const display = parsePayload(message.payload);
        if (display.width > 0 && display.height > 0) {
          state.targetWidth = display.width;
          state.targetHeight = display.height;
        }
        break;
      }
      case 'COMMAND_ACK':
        audit('Remote command acknowledged.');
        break;
    }
  }

  async function loadSessionIceServers() {
    if (!state.sessionToken) throw new Error('A receiver-approved session token is required for ICE configuration.');
    const response = await fetch('/api/v1/turn-credentials', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Authorization: 'Bearer ' + state.sessionToken }
    });
    if (!response.ok) throw new Error('Approved-session ICE endpoint returned HTTP ' + response.status);
    const result = await response.json();
    if (!Array.isArray(result.iceServers) || result.iceServers.length === 0) {
      throw new Error('The backend returned no ICE servers.');
    }
    if (!result.turnConfigured) {
      audit('No TURN relay is configured. Some carrier-grade NAT paths may not connect.', 'warning');
    } else {
      audit('Received short-lived TURN credentials for this approved session.');
    }
    return result.iceServers;
  }

  async function startControllerOffer() {
    if (!state.sessionToken || !state.sessionId || !state.targetDeviceId) {
      throw new Error('No receiver-approved session is active.');
    }
    const sessionId = state.sessionId;
    const iceServers = await loadSessionIceServers();
    if (state.sessionId !== sessionId || !state.sessionToken) return;

    if (state.peerConnection) {
      state.peerConnection.ontrack = null;
      state.peerConnection.close();
      state.peerConnection = null;
    }
    state.pendingIceCandidates = [];
    state.hasFirstFrame = false;
    setStage('loading');
    if (el.latency) el.latency.textContent = 'Negotiating media';

    const peer = new RTCPeerConnection({ iceServers });
    state.peerConnection = peer;
    peer.addTransceiver('video', { direction: 'recvonly' });

    peer.ontrack = event => {
      const stream = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
      if (!el.video) return;
      el.video.srcObject = stream;
      // Keep the decoder surface in the rendering tree (visually hidden) so
      // requestVideoFrameCallback can observe actual presented frames.
      el.video.style.display = 'block';
      el.video.style.position = 'absolute';
      el.video.style.width = '1px';
      el.video.style.height = '1px';
      el.video.style.opacity = '0';
      el.video.style.pointerEvents = 'none';
      el.video.play().catch(error => audit('Browser autoplay requires a user gesture: ' + error.message, 'warning'));
      setStage('loading');
      watchForRealVideoFrames(peer);
    };

    peer.onicecandidate = event => {
      if (!event.candidate || state.peerConnection !== peer || state.sessionId !== sessionId) return;
      const candidate = event.candidate;
      const sent = sendWs({
        type: 'ICE_CANDIDATE',
        targetDeviceId: state.targetDeviceId,
        payload: {
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex
        }
      });
      if (!sent) audit('Could not send a local ICE candidate because signaling is offline.', 'warning');
    };

    peer.onconnectionstatechange = () => {
      if (state.peerConnection !== peer) return;
      const status = peer.connectionState;
      if (status === 'connected') {
        setDeviceStatus('Media transport connected · waiting for first video frame');
      } else if (status === 'failed') {
        setStage('error');
        setDeviceStatus('Media connection failed · check TURN and network access');
      } else if (status === 'disconnected') {
        setStage('loading');
        setDeviceStatus('Media connection interrupted');
      }
    };

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    if (state.peerConnection !== peer || state.sessionId !== sessionId) return;
    const sent = sendWs({
      type: 'SDP_OFFER',
      targetDeviceId: state.targetDeviceId,
      payload: { sdp: peer.localDescription.sdp }
    });
    if (!sent) throw new Error('Could not send the WebRTC offer over the secure signaling channel.');
    audit('WebRTC receive-only offer sent to the approved Android receiver.');
  }

  function watchForRealVideoFrames(peer) {
    if (!el.video || state.peerConnection !== peer) return;
    const markFirstFrame = () => {
      if (state.peerConnection !== peer || state.hasFirstFrame) return;
      state.hasFirstFrame = true;
      if (el.canvas && el.video.videoWidth > 0 && el.video.videoHeight > 0) {
        el.canvas.width = el.video.videoWidth;
        el.canvas.height = el.video.videoHeight;
      }
      setStage('live');
      setDeviceStatus('Live · real video frames received');
      if (el.latency && state.lastPingAt) el.latency.textContent = 'Video active';
      audit('First decoded remote video frame received. Live status enabled.');
    };

    if (typeof el.video.requestVideoFrameCallback === 'function') {
      const onFrame = () => {
        markFirstFrame();
        if (state.peerConnection === peer && !state.hasFirstFrame) {
          el.video.requestVideoFrameCallback(onFrame);
        }
      };
      el.video.requestVideoFrameCallback(onFrame);
    } else {
      const check = setInterval(() => {
        if (state.peerConnection !== peer) {
          clearInterval(check);
          return;
        }
        if (el.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
            el.video.videoWidth > 0 && el.video.currentTime > 0) {
          markFirstFrame();
          clearInterval(check);
        }
      }, 180);
    }
  }

  async function applyRemoteAnswer(sdp) {
    const peer = state.peerConnection;
    if (!peer) throw new Error('WebRTC PeerConnection is not initialized.');
    await peer.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: sdp }));
    const candidates = state.pendingIceCandidates.splice(0);
    for (const candidate of candidates) await peer.addIceCandidate(candidate);
  }

  async function addRemoteIceCandidate(data) {
    const candidate = new RTCIceCandidate({
      candidate: data.candidate,
      sdpMid: data.sdpMid || null,
      sdpMLineIndex: Number.isInteger(data.sdpMLineIndex) ? data.sdpMLineIndex : 0
    });
    const peer = state.peerConnection;
    if (!peer || !peer.remoteDescription) {
      state.pendingIceCandidates.push(candidate);
      return;
    }
    await peer.addIceCandidate(candidate);
  }

  function drawRealFrame() {
    if (!canvasContext || !el.canvas || !el.video) return;
    if (state.hasFirstFrame &&
        el.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        el.video.videoWidth > 0 && el.video.videoHeight > 0) {
      if (el.canvas.width !== el.video.videoWidth || el.canvas.height !== el.video.videoHeight) {
        el.canvas.width = el.video.videoWidth;
        el.canvas.height = el.video.videoHeight;
      }
      canvasContext.drawImage(el.video, 0, 0, el.canvas.width, el.canvas.height);
    } else {
      canvasContext.clearRect(0, 0, el.canvas.width, el.canvas.height);
      canvasContext.fillStyle = '#0b1117';
      canvasContext.fillRect(0, 0, el.canvas.width, el.canvas.height);
    }
    requestAnimationFrame(drawRealFrame);
  }

  function finishSession(reason) {
    if (state.peerConnection) {
      state.peerConnection.ontrack = null;
      state.peerConnection.close();
      state.peerConnection = null;
    }
    if (el.video) {
      el.video.srcObject = null;
      el.video.style.display = 'none';
      el.video.style.position = '';
      el.video.style.width = '';
      el.video.style.height = '';
      el.video.style.opacity = '';
      el.video.style.pointerEvents = '';
    }
    state.sessionId = null;
    state.sessionToken = null;
    state.targetDeviceId = null;
    state.pairingRequestId = null;
    state.pendingIceCandidates = [];
    state.hasFirstFrame = false;
    state.sessionStartedAt = 0;
    clearInterval(state.durationTimer);
    state.durationTimer = null;
    if (el.duration) el.duration.textContent = '00:00:00';
    if (el.app) el.app.hidden = true;
    if (el.pair) el.pair.hidden = false;
    if (el.deviceName) el.deviceName.textContent = 'Android device';
    setDeviceStatus('Not connected');
    if (el.latency) el.latency.textContent = 'Waiting for an approved session';
    setStage('empty');
    setPairStatus(reason || 'Session ended. Enter a new pairing code to connect again.');
    closeDrawer();
    toast('Remote session ended');
  }

  function pair() {
    const code = getCodeValue();
    if (!/^\d{6}$/.test(code)) {
      setPairStatus('Enter all six digits from the phone.', true);
      return;
    }
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      setPairStatus('Secure signaling is not connected yet. Please retry after it reconnects.', true);
      return;
    }
    if (el.connect) el.connect.disabled = true;
    setPairStatus('Sending request. The phone owner must approve before access is granted.');
    state.pairingRequestId = null;
    const sent = sendWs({
      type: 'PAIR_BY_CODE',
      code: code,
      fingerprint: state.controllerFingerprint,
      operatorName: 'Mahi Web Controller',
      requestedScopes: ['Screen Mirroring', 'Remote Interaction', 'File Transfer', 'Diagnostics']
    });
    if (!sent) {
      if (el.connect) el.connect.disabled = false;
      setPairStatus('Pairing request was not sent. Check your connection.', true);
      return;
    }
    audit('One-time pairing request sent. No access is available until the receiver owner approves.');
  }

  function sendCommand(command) {
    if (!state.sessionToken || !state.targetDeviceId || !state.hasFirstFrame) {
      toast('Remote controls are available after the live video stream starts.');
      return false;
    }
    return sendWs({
      type: 'INPUT_EVENT',
      targetDeviceId: state.targetDeviceId,
      sequence: state.commandSequence++,
      command: Object.assign({ timestamp: Date.now() }, command)
    });
  }

  function bindInputControls() {
    if (!el.canvas) return;
    el.canvas.addEventListener('pointerdown', event => {
      if (!state.hasFirstFrame) return;
      const rect = el.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      el.canvas.setPointerCapture(event.pointerId);
      state.pointerStart = {
        x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
        at: Date.now()
      };
      if ($('#switch-ripples') && $('#switch-ripples').checked) {
        const ripple = document.createElement('i');
        ripple.className = 'ripple';
        ripple.style.left = (event.clientX - rect.left) + 'px';
        ripple.style.top = (event.clientY - rect.top) + 'px';
        el.canvas.parentNode.appendChild(ripple);
        setTimeout(() => ripple.remove(), 550);
      }
    });

    el.canvas.addEventListener('pointerup', event => {
      if (!state.pointerStart || !state.hasFirstFrame) return;
      const rect = el.canvas.getBoundingClientRect();
      const start = state.pointerStart;
      state.pointerStart = null;
      const endX = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const endY = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
      const duration = Math.max(80, Date.now() - start.at);
      const dx = endX - start.x;
      const dy = endY - start.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const width = state.targetWidth || 1080;
      const height = state.targetHeight || 1920;
      const x = Math.round(start.x * width);
      const y = Math.round(start.y * height);

      if (distance < 0.02) {
        sendCommand({
          type: duration > 550 ? 'LONG_PRESS' : 'TAP',
          x: x,
          y: y,
          durationMs: duration
        });
      } else {
        sendCommand({
          type: duration > 550 ? 'DRAG' : 'SWIPE',
          x: x,
          y: y,
          x2: Math.round(endX * width),
          y2: Math.round(endY * height),
          durationMs: duration
        });
      }
    });

    el.canvas.addEventListener('pointercancel', () => { state.pointerStart = null; });
    el.canvas.addEventListener('wheel', event => {
      event.preventDefault();
      sendCommand({ type: 'SCROLL', action: event.deltaY < 0 ? 'UP' : 'DOWN' });
    }, { passive: false });

    window.addEventListener('keydown', event => {
      if (!el.app || el.app.hidden || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
      if (event.key === 'Backspace') {
        event.preventDefault();
        sendCommand({ type: 'GLOBAL_ACTION', action: 'BACK' });
      } else if (event.key === 'Home') {
        event.preventDefault();
        sendCommand({ type: 'GLOBAL_ACTION', action: 'HOME' });
      } else if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
        sendCommand({ type: 'TEXT_INPUT', text: event.key });
      }
    });
  }

  function requestPanelData(name) {
    if (!state.sessionToken || !state.targetDeviceId) {
      toast('Connect to an approved phone first.');
      return;
    }
    if (name === 'diag') sendWs({ type: 'DIAGNOSTICS_RUN', targetDeviceId: state.targetDeviceId });
    if (name === 'apps') sendWs({ type: 'APP_COMMAND', targetDeviceId: state.targetDeviceId, action: 'LIST' });
    if (name === 'files') sendWs({ type: 'FILE_COMMAND', targetDeviceId: state.targetDeviceId, action: 'LIST', path: state.currentPath });
  }

  function openPanel(name) {
    if (!el.drawer) return;
    el.drawer.classList.add('open');
    el.drawer.inert = false;
    $$('.tab').forEach(tab => tab.setAttribute('aria-selected', String(tab.dataset.panel === name)));
    $$('.panel').forEach(panel => { panel.hidden = panel.id !== 'p-' + name; });
    $$('[data-open]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.open === name)));
    requestPanelData(name);
  }

  function closeDrawer() {
    if (!el.drawer) return;
    el.drawer.classList.remove('open');
    el.drawer.inert = true;
    $$('[data-open]').forEach(button => button.setAttribute('aria-pressed', 'false'));
  }

  function renderApps(payload) {
    const rows = Array.isArray(payload) ? payload : (Array.isArray(payload.apps) ? payload.apps : []);
    state.apps = rows;
    if (!el.apps) return;
    el.apps.replaceChildren();
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'row';
      li.textContent = 'No app list was returned by the device.';
      el.apps.appendChild(li);
      return;
    }
    rows.forEach(app => {
      const name = String(app.name || app.appName || 'Unnamed application');
      const packageName = String(app.pkg || app.packageName || '');
      const li = document.createElement('li');
      li.className = 'row';
      const meta = document.createElement('div');
      meta.className = 'meta';
      const title = document.createElement('b');
      title.textContent = name;
      const detail = document.createElement('span');
      detail.textContent = packageName;
      const button = document.createElement('button');
      button.className = 'btn';
      button.type = 'button';
      button.textContent = 'Open';
      button.disabled = !packageName;
      button.addEventListener('click', () => {
        if (sendWs({ type: 'APP_COMMAND', targetDeviceId: state.targetDeviceId, action: 'LAUNCH', packageName: packageName })) {
          toast('Launch request sent for ' + name);
        }
      });
      meta.append(title, detail);
      li.append(meta, button);
      el.apps.appendChild(li);
    });
    filterApps();
  }

  function renderFiles(payload) {
    const rows = Array.isArray(payload) ? payload : (Array.isArray(payload.files) ? payload.files : []);
    state.files = rows;
    if (!el.files) return;
    el.files.replaceChildren();
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'row';
      li.textContent = 'No files or folders were returned for this location.';
      el.files.appendChild(li);
      return;
    }
    rows.forEach(file => {
      const name = String(file.name || 'Unnamed');
      const path = String(file.path || '');
      const isDirectory = Boolean(file.isDir || file.isDirectory);
      const size = Number(file.size ?? file.sizeBytes ?? 0);
      const li = document.createElement('li');
      li.className = 'row';
      const meta = document.createElement('div');
      meta.className = 'meta';
      const title = document.createElement('b');
      title.textContent = (isDirectory ? '📁 ' : '📄 ') + name;
      const detail = document.createElement('span');
      detail.textContent = isDirectory ? 'Folder' : (Number.isFinite(size) ? Math.round(size / 1024) + ' KB' : 'File');
      meta.append(title, detail);
      li.appendChild(meta);
      if (isDirectory && path) {
        const open = document.createElement('button');
        open.className = 'btn';
        open.type = 'button';
        open.textContent = 'Open';
        open.addEventListener('click', () => {
          state.currentPath = path;
          if (el.crumbs) el.crumbs.textContent = path;
          requestPanelData('files');
        });
        li.appendChild(open);
      }
      el.files.appendChild(li);
    });
    if (el.crumbs) el.crumbs.textContent = state.currentPath || 'Device files';
  }

  function renderDiagnostics(data) {
    if (el.battery && data.battery !== undefined) {
      el.battery.textContent = String(data.battery) + '%';
      if (el.batteryBar) el.batteryBar.style.width = Math.max(0, Math.min(100, Number(data.battery) || 0)) + '%';
    }
    if (el.temperature && data.temp !== undefined) el.temperature.textContent = String(data.temp) + ' °C';
    if (el.storage && data.storage !== undefined) el.storage.textContent = String(data.storage) + ' free';
    if (el.diagLatency && data.roundTripTimeMs !== undefined) el.diagLatency.textContent = String(data.roundTripTimeMs) + ' ms';
    if (el.memory && data.memory !== undefined) el.memory.textContent = String(data.memory);
    audit('Received device diagnostic data.');
  }

  function filterApps() {
    if (!el.apps || !el.search) return;
    const query = el.search.value.trim().toLowerCase();
    $$('.row', el.apps).forEach(row => { row.hidden = !row.textContent.toLowerCase().includes(query); });
  }

  function bindPanels() {
    $$('[data-open]').forEach(button => {
      button.addEventListener('click', () => {
        if (button.getAttribute('aria-pressed') === 'true') closeDrawer();
        else openPanel(button.dataset.open);
      });
    });
    $$('.tab').forEach(tab => tab.addEventListener('click', () => openPanel(tab.dataset.panel)));
    if (el.closeDrawer) el.closeDrawer.addEventListener('click', closeDrawer);
    if (el.search) el.search.addEventListener('input', filterApps);
    const fullscreen = $('#btn-fullscreen');
    if (fullscreen) {
      fullscreen.addEventListener('click', () => {
        const stage = $('.stage') || document.documentElement;
        if (!document.fullscreenElement) {
          if (stage.requestFullscreen) stage.requestFullscreen().catch(error => audit(error.message, 'warning'));
        } else if (document.exitFullscreen) {
          document.exitFullscreen();
        }
      });
    }
    if (el.retry) {
      el.retry.addEventListener('click', () => {
        if (!state.sessionToken) {
          connectSignaling();
          return;
        }
        startControllerOffer().catch(error => {
          audit('Media retry failed: ' + error.message, 'error');
          setStage('error');
        });
      });
    }

    const quality = $('#quality-select');
    if (quality) quality.disabled = true;
    ['switch-awake', 'switch-clip'].forEach(id => {
      const control = $('#' + id);
      if (control) control.disabled = true;
    });
    const preview = $('#state-select');
    if (preview) preview.disabled = true;
    const wake = $('#btn-wake');
    if (wake) {
      wake.removeAttribute('data-toast');
      wake.disabled = true;
      wake.title = 'Wake requests are not implemented by the Android receiver yet.';
    }
  }

  function bindStopModal() {
    const modal = el.modal;
    $$('[data-stop]').forEach(button => button.addEventListener('click', () => {
      if (modal) modal.hidden = false;
    }));
    if (el.cancel) el.cancel.addEventListener('click', () => { if (modal) modal.hidden = true; });
    if (el.confirm) el.confirm.addEventListener('click', () => {
      if (modal) modal.hidden = true;
      if (!state.sessionToken || !state.targetDeviceId) {
        finishSession('No approved session is active.');
        return;
      }
      const sent = sendWs({
        type: 'EMERGENCY_DISCONNECT',
        targetDeviceId: state.targetDeviceId,
        payload: { reason: 'Browser controller requested emergency disconnect.' }
      });
      if (!sent) {
        toast('Emergency stop was not delivered. Keep this page open and retry.');
        setDeviceStatus('Emergency stop not confirmed');
        return;
      }
      setDeviceStatus('Emergency disconnect requested · waiting for server confirmation');
      toast('Emergency disconnect request sent');
    });
    window.addEventListener('keydown', event => {
      if (event.key === 'Escape' && modal && !modal.hidden) modal.hidden = true;
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'x' && el.app && !el.app.hidden) {
        if (modal) modal.hidden = false;
      }
    });
  }

  function bindCodeInputs() {
    el.codeBoxes.forEach((box, index) => {
      box.addEventListener('input', () => {
        box.value = box.value.replace(/\D/g, '').slice(-1);
        if (box.value && el.codeBoxes[index + 1]) el.codeBoxes[index + 1].focus();
        if (el.connect) el.connect.disabled = getCodeValue().length !== 6;
        if (el.pairStatus) setPairStatus('');
      });
      box.addEventListener('keydown', event => {
        if (event.key === 'Backspace' && !box.value && el.codeBoxes[index - 1]) el.codeBoxes[index - 1].focus();
        if (event.key === 'Enter' && getCodeValue().length === 6) pair();
      });
      box.addEventListener('paste', event => {
        const digits = (event.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
        if (!digits) return;
        event.preventDefault();
        setCodeValue(digits);
        el.codeBoxes[Math.min(digits.length, 5)].focus();
      });
    });
    if (el.connect) el.connect.addEventListener('click', pair);
  }

  function clearDemoContent() {
    if (el.apps) {
      el.apps.replaceChildren();
      const li = document.createElement('li');
      li.className = 'row';
      li.textContent = 'Connect to an approved device to load its installed apps.';
      el.apps.appendChild(li);
    }
    if (el.files) {
      el.files.replaceChildren();
      const li = document.createElement('li');
      li.className = 'row';
      li.textContent = 'Connect to an approved device to browse its files.';
      el.files.appendChild(li);
    }
    const values = [
      ['#diag-battery', 'Not available'],
      ['#diag-storage', 'Not available'],
      ['#diag-memory', 'Not available'],
      ['#diag-temp', 'Not available'],
      ['#diag-latency', '—'],
      ['#diag-fps', '—'],
      ['#diag-bitrate', '—'],
      ['#device-model-text', 'Android device'],
      ['#device-status-text', 'Not connected'],
      ['#latency-text', 'Waiting for an approved session']
    ];
    values.forEach(([selector, value]) => {
      const node = $(selector);
      if (node) node.textContent = value;
    });
    if (el.batteryBar) el.batteryBar.style.width = '0%';
  }

  async function init() {
    state.controllerFingerprint = getControllerFingerprint();
    setCodeValue('');
    setStage('empty');
    clearDemoContent();
    bindCodeInputs();
    bindPanels();
    bindStopModal();
    bindInputControls();
    requestAnimationFrame(drawRealFrame);

    const params = new URL(window.location.href).searchParams;
    const initialCode = params.get('code');
    if (initialCode) setCodeValue(initialCode);

    try {
      setPairStatus('Loading secure connection settings…');
      await loadRuntimeConfig();
      connectSignaling();
    } catch (error) {
      setPairStatus(error.message, true);
      audit('Runtime configuration error: ' + error.message, 'error');
    }
  }

  window.addEventListener('pagehide', () => {
    if (state.sessionToken && state.targetDeviceId && state.ws && state.ws.readyState === WebSocket.OPEN) {
      try {
        state.ws.send(JSON.stringify({
          type: 'EMERGENCY_DISCONNECT',
          targetDeviceId: state.targetDeviceId,
          sessionToken: state.sessionToken,
          payload: { reason: 'Browser controller page closed.' }
        }));
      } catch (_) {
        // Best-effort notification only. Backend session expiry remains authoritative.
      }
    }
  });

  document.addEventListener('DOMContentLoaded', init);
})();