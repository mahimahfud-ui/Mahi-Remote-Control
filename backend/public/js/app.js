(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const toast = m => {
    const t = $('#toast');
    if (!t) return;
    t.textContent = m;
    t.classList.add('show');
    clearTimeout(t._t);
    t._t = setTimeout(() => t.classList.remove('show'), 2200);
  };

  // State Management. A session is active only after receiver approval and a real video frame.
  const state = {
    ws: null,
    peerConnection: null,
    targetDeviceId: null,
    targetDeviceName: 'Android phone',
    sessionId: null,
    sessionToken: null,
    pairingRequestId: null,
    runtimeConfig: null,
    operatorFingerprint: 'WEB-' + Array.from(crypto.getRandomValues(new Uint8Array(16))).map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase(),
    pendingIceCandidates: [],
    isStreaming: false,
    dragStart: null,
    dragStartTime: 0,
    commandSequence: 1,
    targetDisplay: { width: 1080, height: 2400, rotation: 0 }
  };

  /* -------------------------------------------------------------
   * 1. 6-Digit Pairing Inputs & Interaction
   * ------------------------------------------------------------- */
  const boxes = $$('.code input');
  const codeEl = $('.code');
  const status = $('#pair-status');
  const go = $('#connect');

  const getCodeVal = () => boxes.map(b => b.value).join('');
  const setStatus = (msg, cls = '') => {
    if (!status) return;
    status.className = 'status ' + cls;
    status.textContent = msg;
  };

  boxes.forEach((b, i) => {
    b.addEventListener('input', () => {
      b.value = b.value.replace(/\D/g, '').slice(-1);
      codeEl.classList.remove('error');
      setStatus('');
      if (b.value && boxes[i + 1]) boxes[i + 1].focus();
      if (go) go.disabled = getCodeVal().length < 6;
    });

    b.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !b.value && boxes[i - 1]) boxes[i - 1].focus();
      if (e.key === 'Enter' && getCodeVal().length === 6) pair();
    });

    b.addEventListener('paste', e => {
      const d = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
      if (!d) return;
      e.preventDefault();
      boxes.forEach((x, j) => x.value = d[j] || '');
      boxes[Math.min(d.length, 5)].focus();
      if (go) go.disabled = d.length < 6;
    });
  });

  if (go) {
    go.disabled = true;
    go.addEventListener('click', pair);
  }

  // Load the public WSS endpoint from the backend. Never guess a hostname.
  async function loadRuntimeConfig() {
    try {
      const response = await fetch('/api/v1/config', { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error('Configuration endpoint returned HTTP ' + response.status);
      const config = await response.json();
      if (!config.browserAccessConfigured || !config.signalingUrl || !config.signalingUrl.startsWith('wss://')) {
        throw new Error('Public HTTPS/WSS access is not configured.');
      }
      state.runtimeConfig = config;
      if (!config.turnConfigured) {
        toast('TURN is not configured; some mobile networks may not connect.');
      }
      return config;
    } catch (error) {
      state.runtimeConfig = null;
      setStatus(error.message, 'error');
      const stage = $('.stage');
      if (stage) stage.dataset.state = 'error';
      throw error;
    }
  }

  // Connect the browser as a stable session participant.
  function connectSignaling() {
    const configuredUrl = state.runtimeConfig?.signalingUrl;
    if (!configuredUrl || !configuredUrl.startsWith('wss://')) return;
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;

    const wsUrl = new URL(configuredUrl);
    wsUrl.searchParams.set('controllerFingerprint', state.operatorFingerprint);
    try {
      state.ws = new WebSocket(wsUrl.toString());
      state.ws.onopen = () => {
        console.info('[Signaling] Connected to configured WSS endpoint.');
      };
      state.ws.onmessage = event => {
        try { handleSignalingMessage(JSON.parse(event.data)); }
        catch (error) { console.warn('[Signaling] Invalid server message', error); }
      };
      state.ws.onclose = () => {
        if (state.sessionToken) {
          setState('error');
          toast('Signaling disconnected. Reconnecting…');
        }
        setTimeout(connectSignaling, 5000);
      };
      state.ws.onerror = () => {
        if (!state.sessionToken) setStatus('Could not connect to the signaling service.', 'error');
      };
    } catch (error) {
      setStatus('Could not open signaling connection: ' + error.message, 'error');
    }
  }

  function sendWs(data) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
    const message = { ...data };
    if (state.sessionToken && !['PING', 'PAIR_BY_CODE', 'PAIR_CODE_CONNECT'].includes(message.type)) {
      message.sessionToken = state.sessionToken;
    }
    state.ws.send(JSON.stringify(message));
    return true;
  }

  function parsePayload(payload) {
    if (payload && typeof payload === 'object') return payload;
    if (typeof payload === 'string') {
      try { return JSON.parse(payload); } catch { return {}; }
    }
    return {};
  }

  function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'PAIR_PENDING':
        state.pairingRequestId = msg.requestId || null;
        setStatus('Request sent. Waiting for the phone owner to approve…');
        if (go) go.disabled = true;
        break;
      case 'PAIR_ACCEPT':
        onPairSuccess(msg);
        break;
      case 'PAIR_REJECT':
      case 'PAIR_ERROR':
        state.pairingRequestId = null;
        setStatus(msg.error || msg.reason || 'The phone owner rejected the request.', 'error');
        if (go) go.disabled = false;
        codeEl.classList.add('error');
        break;
      case 'SESSION_ERROR':
        logSecurityError(msg.error || 'Session authorization failed.');
        stopBrowserSession(msg.error || 'Session authorization failed.');
        break;
      case 'SESSION_ENDED':
        stopBrowserSession(msg.reason || 'The remote session ended.');
        break;
      case 'SDP_ANSWER': {
        if (!state.peerConnection || msg.sessionId !== state.sessionId) break;
        const payload = parsePayload(msg.payload);
        const sdp = payload.sdp || msg.sdp;
        if (sdp) handleSdpAnswer(sdp).catch(error => {
          logSecurityError('Could not apply remote SDP answer: ' + error.message);
        });
        break;
      }
      case 'ICE_CANDIDATE': {
        if (msg.sessionId !== state.sessionId) break;
        const payload = parsePayload(msg.payload);
        if (!payload.candidate) break;
        const candidate = new RTCIceCandidate({
          candidate: payload.candidate,
          sdpMid: payload.sdpMid || null,
          sdpMLineIndex: Number.isInteger(payload.sdpMLineIndex) ? payload.sdpMLineIndex : 0
        });
        if (!state.peerConnection || !state.peerConnection.remoteDescription) {
          state.pendingIceCandidates.push(candidate);
        } else {
          state.peerConnection.addIceCandidate(candidate).catch(error => {
            logSecurityError('Could not add remote ICE candidate: ' + error.message);
          });
        }
        break;
      }
      case 'DISPLAY_INFO': {
        const info = parsePayload(msg.payload);
        if (info.width > 0 && info.height > 0) {
          state.targetDisplay.width = info.width;
          state.targetDisplay.height = info.height;
          state.targetDisplay.rotation = info.rotation || 0;
        }
        break;
      }
      case 'APP_LIST_RESPONSE':
        renderAppList(parsePayload(msg.payload).apps || parsePayload(msg.payload));
        break;
      case 'FILE_LIST_RESPONSE': {
        const payload = parsePayload(msg.payload);
        renderFileList(Array.isArray(payload) ? payload : (payload.files || []));
        break;
      }
      case 'DIAGNOSTICS_RESULT': {
        const d = parsePayload(msg.payload);
        const battery = $('#diag-battery');
        const temp = $('#diag-temp');
        const storage = $('#diag-storage');
        if (battery && Number.isFinite(Number(d.battery))) battery.textContent = Number(d.battery) + '%';
        if (temp && Number.isFinite(Number(d.temp))) temp.textContent = Number(d.temp) + ' °C';
        if (storage && d.storage) storage.textContent = d.storage + ' free';
        break;
      }
    }
  }

  function logSecurityError(message) {
    console.error('[Remote session]', message);
    setStatus(message, 'error');
    setState('error');
  }

  /* -------------------------------------------------------------
   * 2. Pairing Trigger  /* -------------------------------------------------------------
   * 2. Pairing Trigger (REST + WebSocket)
   * ------------------------------------------------------------- */
  async function pair() {
    const code = getCodeVal();
    if (code.length !== 6) return;
    if (!state.runtimeConfig || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
      setStatus('Secure signaling is unavailable. Check the server connection.', 'error');
      if (go) go.disabled = false;
      return;
    }

    if (go) go.disabled = true;
    codeEl.classList.remove('error');
    setStatus('Sending pairing request to your phone…');
    state.pairingRequestId = null;

    const formattedCode = code.slice(0, 3) + '-' + code.slice(3);
    const sent = sendWs({
      type: 'PAIR_BY_CODE',
      code: formattedCode,
      operatorName: 'Mahi Browser Controller',
      operatorLocation: 'Browser',
      fingerprint: state.operatorFingerprint,
      requestedScopes: ['Screen Mirroring', 'Remote Interaction', 'File Transfer', 'Diagnostics']
    });
    if (!sent) {
      setStatus('Could not send the pairing request. Reconnect and try again.', 'error');
      if (go) go.disabled = false;
    }
  }

  function onPairSuccess()  function onPairSuccess(msg) {
    if (!msg || !msg.sessionId || !msg.sessionToken || !msg.sender) {
      setStatus('The server did not issue a valid owner-approved session.', 'error');
      if (go) go.disabled = false;
      return;
    }

    state.sessionId = msg.sessionId;
    state.sessionToken = msg.sessionToken;
    state.targetDeviceId = msg.sender;
    state.targetDeviceName = msg.receiverName || 'Android phone';
    state.isStreaming = false;
    state.pairingRequestId = null;
    const name = $('#device-model-text');
    if (name) name.textContent = state.targetDeviceName;

    $('#pair').hidden = true;
    $('#app').hidden = false;
    const remoteVideo = $('#remote-video');
    if (remoteVideo) {
      remoteVideo.srcObject = null;
      remoteVideo.style.display = 'none';
    }
    setState('loading');
    drawScreen();
    startSession();
    toast('Phone owner approved. Connecting secure video…');
    initializeWebRtc().catch(error => {
      logSecurityError('Could not establish WebRTC video: ' + error.message);
    });
  }

  /* -------------------------------------------------------------
   * 2b. Authenticated WebRTC receive pipeline
   * ------------------------------------------------------------- */
  async function initializeWebRtc() {
    if (!state.sessionId || !state.sessionToken || !state.targetDeviceId) {
      throw new Error('A receiver-approved session is required.');
    }
    if (state.peerConnection) {
      state.peerConnection.close();
      state.peerConnection = null;
    }
    state.pendingIceCandidates = [];

    let iceServers = state.runtimeConfig?.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];
    try {
      const response = await fetch('/api/v1/turn-credentials', {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Authorization: 'Bearer ' + state.sessionToken }
      });
      if (!response.ok) throw new Error('TURN endpoint returned HTTP ' + response.status);
      const config = await response.json();
      if (Array.isArray(config.iceServers) && config.iceServers.length) iceServers = config.iceServers;
    } catch (error) {
      console.warn('[WebRTC] Session TURN credentials unavailable; attempting configured STUN only:', error);
    }

    const peer = new RTCPeerConnection({ iceServers });
    state.peerConnection = peer;
    peer.addTransceiver('video', { direction: 'recvonly' });

    peer.ontrack = event => {
      const video = $('#remote-video');
      if (!video) return;
      const stream = event.streams?.[0] || new MediaStream([event.track]);
      video.srcObject = stream;
      video.style.display = 'block';
      video.style.position = 'absolute';
      video.style.inset = '0';
      video.style.width = '100%';
      video.style.height = '100%';
      video.style.objectFit = 'contain';
      video.style.zIndex = '1';
      video.play().catch(() => {});
      const markLive = () => {
        if (state.peerConnection !== peer || !state.sessionToken) return;
        state.isStreaming = true;
        setState('live');
        toast('Live video connected');
      };
      if (typeof video.requestVideoFrameCallback === 'function') {
        video.requestVideoFrameCallback(markLive);
      } else {
        video.addEventListener('loadeddata', markLive, { once: true });
      }
    };

    peer.onicecandidate = event => {
      if (!event.candidate) return;
      sendWs({
        type: 'ICE_CANDIDATE',
        targetDeviceId: state.targetDeviceId,
        payload: {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex
        }
      });
    };

    peer.onconnectionstatechange = () => {
      if (state.peerConnection !== peer) return;
      if (peer.connectionState === 'failed') {
        state.isStreaming = false;
        setState('error');
      } else if (peer.connectionState === 'disconnected') {
        state.isStreaming = false;
        setState('error');
      }
    };

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    if (!sendWs({
      type: 'SDP_OFFER',
      targetDeviceId: state.targetDeviceId,
      payload: { sdp: peer.localDescription?.sdp || offer.sdp }
    })) {
      throw new Error('Could not send the WebRTC offer to the approved receiver.');
    }
  }

  async function handleSdpAnswer(sdp) {
    if (!state.peerConnection) throw new Error('The WebRTC connection is not initialized.');
    await state.peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
    const queued = state.pendingIceCandidates.splice(0);
    for (const candidate of queued) {
      await state.peerConnection.addIceCandidate(candidate);
    }
  }

  function stopBrowserSession(reason) {
    if (state.peerConnection) {
      state.peerConnection.close();
      state.peerConnection = null;
    }
    clearInterval(timer);
    const video = $('#remote-video');
    if (video) {
      video.pause();
      video.srcObject = null;
      video.style.display = 'none';
    }
    state.sessionToken = null;
    state.sessionId = null;
    state.pendingIceCandidates = [];
    state.targetDeviceId = null;
    state.isStreaming = false;
    state.pairingRequestId = null;
    state.dragStart = null;
    if (go) go.disabled = true;
    boxes.forEach(box => box.value = '');
    $('#app').hidden = true;
    $('#pair').hidden = false;
    setStatus(reason || 'Session ended. Enter a new code when the phone is ready.');
    setState('empty');
    drawScreen();
    boxes[0]?.focus();
  }

  /* -------------------------------------------------------------
   * 3. Active Session  /* -------------------------------------------------------------
   * 3. Active Session & Live Timer
   * ------------------------------------------------------------- */
  let timer, t0;
  function startSession() {
    t0 = Date.now();
    clearInterval(timer);
    timer = setInterval(() => {
      const s = ((Date.now() - t0) / 1000) | 0;
      const duration = $('#dur');
      if (duration) duration.textContent = [s / 3600 | 0, (s / 60) % 60 | 0, s % 60]
        .map(n => String(n).padStart(2, '0'))
        .join(':');
    }, 1000);
    setState('loading');
  }

  function setState(s)  function setState(s) {
    $('.stage').dataset.state = s;
    const select = $('#state-select');
    if (select) select.value = s;
  }

  const stateSelect = $('#state-select');
  if (stateSelect) {
    stateSelect.disabled = true;
    stateSelect.title = 'Session state is driven by the real connection; preview override is disabled.';
  }

  const retryBtn = $('#retry');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      if (!state.sessionToken) {
        setStatus('The session has ended. Enter a new pairing code.', 'error');
        return;
      }
      setState('loading');
      initializeWebRtc().catch(error => logSecurityError('Reconnect failed: ' + error.message));
    });
  }

  /* -------------------------------------------------------------
   * 4. Interactive Canvas, Mouse-to-Touch Scaling & Ripples
   * ------------------------------------------------------------- */
  const cv = $('#screen');
  const ctx = cv.getContext('2d');

  function drawScreen() {
    // The browser never draws a simulated phone. Until WebRTC delivers a real
    // decoded frame, the receiver viewport remains blank with a loading state.
    const r = cv.getBoundingClientRect();
    const d = devicePixelRatio || 1;
    if (!r.width) return;
    cv.width = Math.max(1, Math.round(r.width * d));
    cv.height = Math.max(1, Math.round(r.height * d));
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
  }

  addEventListener('resize'  addEventListener('resize', () => {
    if (!$('#app').hidden) drawScreen();
  });

  const coords = $('#coords');
  const norm = e => {
    const r = cv.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width,
      y: (e.clientY - r.top) / r.height,
      px: e.clientX - r.left,
      py: e.clientY - r.top
    };
  };

  cv.addEventListener('pointermove', e => {
    const p = norm(e);
    if (coords) coords.textContent = `x ${p.x.toFixed(3)}  y ${p.y.toFixed(3)}`;
  });

  cv.addEventListener('pointerdown', e => {
    if (!state.sessionToken || !state.targetDeviceId || !state.isStreaming) return;
    const p = norm(e);
    state.dragStart = p;
    state.dragStartTime = Date.now();

    // Visual ripple effect
    const ripplesEnabled = $('#switch-ripples')?.checked ?? true;
    if (ripplesEnabled) {
      const r = document.createElement('i');
      r.className = 'ripple';
      r.style.left = p.px + 'px';
      r.style.top = p.py + 'px';
      cv.parentNode.appendChild(r);
      setTimeout(() => r.remove(), 500);
    }
  });

  cv.addEventListener('pointerup', e => {
    if (!state.dragStart || !state.sessionToken || !state.isStreaming) return;
    const endP = norm(e);
    const duration = Date.now() - state.dragStartTime;
    const dx = endP.x - state.dragStart.x;
    const dy = endP.y - state.dragStart.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Scale to receiver's dynamic display resolution
    const dispW = state.targetDisplay.width || 1080;
    const dispH = state.targetDisplay.height || 2400;
    const startX = Math.round(state.dragStart.x * dispW);
    const startY = Math.round(state.dragStart.y * dispH);
    const endX = Math.round(endP.x * dispW);
    const endY = Math.round(endP.y * dispH);

    if (dist < 0.02) {
      // Tap or Long press
      if (duration > 500) {
        sendCommand('Tap', { x: startX, y: startY, action: 'LONG_PRESS', durationMs: duration });
      } else {
        sendCommand('Tap', { x: startX, y: startY, action: 'TAP' });
      }
    } else {
      // Swipe or Drag
      sendCommand('Swipe', {
        x: startX,
        y: startY,
        x2: endX,
        y2: endY,
        durationMs: Math.max(120, duration),
        action: duration > 500 ? 'DRAG' : 'SWIPE'
      });
    }

    state.dragStart = null;
  });

  function sendCommand(type, params) {
    const seq = state.commandSequence++;
    if (!state.sessionToken || !state.targetDeviceId || !state.isStreaming) return;
    const commandType = String(params.action || type).replace(/[- ]/g, '_').toUpperCase();
    const payload = JSON.stringify({
      type: 'INPUT_EVENT',
      sequence: seq,
      targetDeviceId: state.targetDeviceId,
      command: {
        ...params,
        type: commandType,
        timestamp: Date.now()
      }
    });

    // Prefer WebRTC DataChannel for minimum round-trip latency
    if (state.dataChannel && state.dataChannel.readyState === 'open') {
      try {
        state.dataChannel.send(payload);
        return;
      } catch (e) {
        console.warn('[WebRTC] DataChannel send failed, using WebSocket fallback:', e);
      }
    }

    sendWs(JSON.parse(payload));
  }

  /* -------------------------------------------------------------
   * 5. True Fullscreen API Support
   * ------------------------------------------------------------- */
  const btnFullscreen = $('#btn-fullscreen');
  if (btnFullscreen) {
    btnFullscreen.addEventListener('click', () => {
      const stage = $('.stage') || document.documentElement;
      if (!document.fullscreenElement) {
        stage.requestFullscreen?.().catch(err => {
          console.warn('Fullscreen request denied:', err);
        });
      } else {
        document.exitFullscreen?.();
      }
    });
  }

  /* -------------------------------------------------------------
   * 6. Drawer Panels, Tabs & Real Data Fetching
   * ------------------------------------------------------------- */
  const drawer = $('#drawer');
  const tabs = $$('.tab');
  const panels = $$('.panel');

  function openPanel(name) {
    if (!drawer) return;
    drawer.classList.add('open');
    drawer.inert = false;
    tabs.forEach(t => t.setAttribute('aria-selected', t.dataset.panel === name));
    panels.forEach(p => p.hidden = p.id !== 'p-' + name);
    $$('[data-open]').forEach(b => b.setAttribute('aria-pressed', b.dataset.open === name));

    // Send data queries to device
    if (name === 'diag') {
      sendWs({ type: 'DIAGNOSTICS_RUN', targetDeviceId: state.targetDeviceId });
    } else if (name === 'apps') {
      sendWs({ type: 'APP_COMMAND', action: 'LIST', targetDeviceId: state.targetDeviceId });
    } else if (name === 'files') {
      sendWs({ type: 'FILE_COMMAND', action: 'LIST', path: '/storage/emulated/0/Documents', targetDeviceId: state.targetDeviceId });
    }

    setTimeout(drawScreen, 320);
  }

  function closeDrawer() {
    if (!drawer) return;
    drawer.classList.remove('open');
    drawer.inert = true;
    $$('[data-open]').forEach(b => b.setAttribute('aria-pressed', false));
    setTimeout(drawScreen, 320);
  }

  if (drawer) drawer.inert = true;

  $$('[data-open]').forEach(b => {
    b.addEventListener('click', () => {
      (b.getAttribute('aria-pressed') === 'true') ? closeDrawer() : openPanel(b.dataset.open);
    });
  });

  tabs.forEach(t => t.addEventListener('click', () => openPanel(t.dataset.panel)));

  const closeDrawerBtn = $('#close-drawer');
  if (closeDrawerBtn) closeDrawerBtn.addEventListener('click', closeDrawer);

  window.sendAppLaunch = (pkg) => {
    sendWs({ type: 'APP_COMMAND', action: 'LAUNCH', packageName: pkg, targetDeviceId: state.targetDeviceId });
    toast(`Opening ${pkg} on phone`);
  };

  function renderAppList(apps) {
    const list = $('#app-list');
    if (!list) return;
    list.innerHTML = '';
    if (!apps || apps.length === 0) {
      list.innerHTML = '<li class="row"><div class="meta"><b>No apps returned</b></div></li>';
      return;
    }
    apps.forEach(app => {
      const li = document.createElement('li');
      li.className = 'row';
      li.innerHTML = `
        <div class="ico">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18h2"/></svg>
        </div>
        <div class="meta"><b>${app.name || app.appName}</b><span>${app.pkg || app.packageName}</span></div>
        <button class="btn" onclick="window.sendAppLaunch('${app.pkg || app.packageName}')">Open</button>
      `;
      list.appendChild(li);
    });
  }

  function renderFileList(files) {
    const list = $('#file-list');
    if (!list) return;
    list.innerHTML = '';
    if (!files || files.length === 0) {
      list.innerHTML = '<li class="row"><div class="meta"><b>Folder is empty</b></div></li>';
      return;
    }
    files.forEach(f => {
      const li = document.createElement('li');
      li.className = 'row';
      li.innerHTML = `
        <div class="ico">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h7l4 4v14H7z"/></svg>
        </div>
        <div class="meta"><b>${f.name}</b><span>${f.isDirectory ? 'Directory' : Math.round(f.sizeBytes / 1024) + ' KB'}</span></div>
        <button class="icon-btn" aria-label="Download" onclick="window.toast('Downloading: ${f.name}')">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V5M7 10l5-5 5 5M5 20h14"/></svg>
        </button>
      `;
      list.appendChild(li);
    });
  }

  /* -------------------------------------------------------------
   * 7. Emergency Stop Modal & Keyboard Shortcuts
   * ------------------------------------------------------------- */
  const modal = $('#modal');
  const askStop = () => {
    if (!modal) return;
    modal.hidden = false;
    $('#cancel')?.focus();
  };

  $$('[data-stop]').forEach(b => b.addEventListener('click', askStop));

  $('#cancel')?.addEventListener('click', () => {
    if (modal) modal.hidden = true;
  });

  $('#confirm')?.addEventListener('click', () => {
    if (modal) modal.hidden = true;
    closeDrawer();
    sendWs({ type: 'EMERGENCY_DISCONNECT', targetDeviceId: state.targetDeviceId });
    stopBrowserSession('Session ended. Remote control stopped.');
    toast('Session terminated');
  });

  addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (modal && !modal.hidden) modal.hidden = true;
      else closeDrawer();
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'x' && !$('#app').hidden) {
      askStop();
    }
  });

  $$('[data-toast]').forEach(b => b.addEventListener('click', () => toast(b.dataset.toast)));

  const searchInput = $('#search');
  if (searchInput) {
    searchInput.addEventListener('input', e => {
      const query = e.target.value.toLowerCase();
      $$('#app-list .row').forEach(r => {
        r.hidden = !r.textContent.toLowerCase().includes(query);
      });
    });
  }

  // Do not enable pairing until real HTTPS/WSS runtime configuration is loaded.
  loadRuntimeConfig().then(connectSignaling).catch(() => {});
})();
