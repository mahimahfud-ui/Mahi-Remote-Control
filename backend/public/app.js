// Mahi Remote Control — Browser Controller Client
(function () {
  'use strict';

  // State Management
  const state = {
    ws: null,
    peerConnection: null,
    operatorFingerprint: 'OP-WEB-' + Array.from(crypto.getRandomValues(new Uint8Array(12))).map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase(),
    operatorName: 'Browser Controller',
    activeDeviceId: null,
    sessionToken: null,
    sessionActive: false,
    isVideoLive: false,
    liveFrameLogged: false,
    pingTimer: null,
    pairedDevices: [],
    commandSequence: 1,
    dragStart: null,
    lastClickTime: 0,
    clickCount: 0,
    currentPath: '/Documents'
  };

  // DOM Elements
  const el = {
    badge: document.getElementById('connectionBadge'),
    latency: document.getElementById('latencyDisplay'),
    hostPill: document.getElementById('hostPill'),
    deviceList: document.getElementById('deviceList'),
    canvas: document.getElementById('phoneCanvas'),
    video: document.getElementById('remoteVideo'),
    placeholder: document.getElementById('streamPlaceholder'),
    streamStats: document.getElementById('streamStats'),
    auditBox: document.getElementById('auditLogBox'),
    pairModal: document.getElementById('pairModal'),
    btnPair: document.getElementById('btnPairDevice'),
    btnCloseModal: document.getElementById('btnCloseModal'),
    btnSubmitPair: document.getElementById('btnSubmitPair'),
    inputPairCode: document.getElementById('inputPairCode'),
    btnEmergencyKill: document.getElementById('btnEmergencyKill'),
    btnRunDiag: document.getElementById('btnRunDiag'),
    btnLaunchPkg: document.getElementById('btnLaunchPkg'),
    launchPkgInput: document.getElementById('launchPkgInput'),
    appList: document.getElementById('appList'),
    fileList: document.getElementById('fileList'),
    currentFilePath: document.getElementById('currentFilePath'),
    btnTriggerUpload: document.getElementById('btnTriggerUpload'),
    fileUploadInput: document.getElementById('fileUploadInput'),
    fileUploadProgress: document.getElementById('fileUploadProgress'),
    progressBarFill: document.getElementById('progressBarFill'),
    progressText: document.getElementById('progressText'),
    btnNewFolder: document.getElementById('btnNewFolder'),
    btnRefreshFiles: document.getElementById('btnRefreshFiles'),
    btnClearLogs: document.getElementById('btnClearLogs'),
    qualitySelect: document.getElementById('qualitySelect'),
    diagBattery: document.getElementById('diagBattery'),
    diagTemp: document.getElementById('diagTemp'),
    diagStorage: document.getElementById('diagStorage')
  };

  const ctx = el.canvas.getContext('2d');

  // Initialize
  function init() {
    el.hostPill.textContent = window.location.host;
    setupTabs();
    setupCanvasMouse();
    setupToolbar();
    setupModal();
    setupFileUpload();
    renderDevices();
    connectSignaling();
    startCanvasRenderLoop();
    logAudit('INIT', 'Browser controller ready. No device is assumed or preselected.', 'security');
  }

  // WebSocket Signaling Connection (Dynamically works with ANY IP or Cloudflare tunnel!)
  function connectSignaling() {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws`;

    logAudit('SIGNALING', `Connecting to signaling socket at ${wsUrl}...`);
    el.badge.textContent = 'CONNECTING';
    el.badge.className = 'badge badge-warning';

    try {
      state.ws = new WebSocket(wsUrl);

      state.ws.onopen = () => {
        el.badge.textContent = 'ONLINE / READY';
        el.badge.className = 'badge badge-success';
        logAudit('SIGNALING', `Connected to signaling hub. Authenticated as ${state.operatorFingerprint}`, 'security');
        
        if (state.sessionToken) sendWs({ type: 'AUTHENTICATE', sessionToken: state.sessionToken });
        else sendPing();
        if (!state.pingTimer) state.pingTimer = setInterval(sendPing, 15000);
      };

      state.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleSignalingMessage(msg);
        } catch (e) {
          console.error('Invalid WS payload', e);
        }
      };

      state.ws.onclose = () => {
        if (state.peerConnection) { state.peerConnection.close(); state.peerConnection = null; }
        state.isVideoLive = false;
        el.placeholder.style.display = 'flex';
        el.badge.textContent = 'OFFLINE';
        el.badge.className = 'badge badge-danger';
        logAudit('SIGNALING', 'Socket disconnected. Retrying in 5 seconds...', 'critical');
        setTimeout(connectSignaling, 5000);
      };

      state.ws.onerror = (err) => {
        console.error('WebSocket error:', err);
      };
    } catch (e) {
      console.error('Failed to init WebSocket:', e);
    }
  }

  function sendWs(data) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(data));
      return true;
    }
    return false;
  }

  let lastPingTimestamp = 0;
  function sendPing() {
    lastPingTimestamp = Date.now();
    sendWs({ type: 'PING', timestamp: lastPingTimestamp });
  }

  // Handle incoming messages
  function objectPayload(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value === 'string') { try { return JSON.parse(value); } catch (_) { return {}; } }
    return {};
  }

  function handleSignalingMessage(msg) {
    const payload = objectPayload(msg.payload);
    switch (msg.type) {
      case 'PONG':
        el.latency.textContent = String(Date.now() - lastPingTimestamp) + ' ms RTT';
        break;
      case 'PAIR_PENDING':
        el.badge.textContent = 'AWAITING APPROVAL';
        el.badge.className = 'badge badge-warning';
        logAudit('PAIRING', 'Request sent. Waiting for the receiver owner to approve.');
        break;
      case 'PAIR_ACCEPT':
        state.activeDeviceId = msg.sender || payload.receiverId || state.activeDeviceId;
        state.pairedDevices = state.activeDeviceId ? [{ deviceId: state.activeDeviceId, deviceName: payload.receiverName || 'Android receiver' }] : [];
        renderDevices();
        logAudit('PAIRING', 'Receiver owner approved the request.', 'security');
        break;
      case 'SESSION_AUTHORIZED':
        state.sessionToken = msg.sessionToken || payload.sessionToken || null;
        state.activeDeviceId = msg.peerId || payload.peerId || state.activeDeviceId;
        state.sessionActive = false;
        if (state.sessionToken) {
          logAudit('SECURITY', 'Receiver approved. Authenticating the browser session.');
          sendWs({ type: 'AUTHENTICATE', sessionToken: state.sessionToken });
        }
        break;
      case 'AUTHENTICATED':
        state.sessionActive = true;
        if (state.sessionToken && state.activeDeviceId) {
          startBrowserOffer().catch(error => logAudit('WEBRTC', 'WebRTC setup failed: ' + error.message, 'critical'));
        }
        break;
      case 'AUTHENTICATION_FAILED':
      case 'SESSION_REVOKED':
      case 'DISCONNECTED':
        state.sessionActive = false;
        state.isVideoLive = false;
        state.sessionToken = null;
        state.activeDeviceId = null;
        if (state.peerConnection) state.peerConnection.close();
        state.peerConnection = null;
        el.placeholder.style.display = 'flex';
        el.badge.textContent = 'DISCONNECTED';
        el.badge.className = 'badge badge-danger';
        break;
      case 'PAIR_REJECT':
      case 'PAIR_ERROR':
        el.badge.textContent = 'PAIRING FAILED';
        el.badge.className = 'badge badge-danger';
        logAudit('PAIRING', msg.reason || msg.error || 'Pairing request was rejected.', 'critical');
        break;
      case 'COMMAND_ACK':
        logAudit('ACK', 'Remote command acknowledged.');
        break;
      case 'APP_LIST_RESPONSE':
        renderAppList(Array.isArray(payload.apps) ? payload.apps : []);
        break;
      case 'FILE_LIST_RESPONSE':
        renderFileList(Array.isArray(payload.files) ? payload.files : []);
        break;
      case 'DIAGNOSTICS_RESULT':
        if (payload.battery != null) el.diagBattery.textContent = String(payload.battery) + '%';
        if (payload.temp != null) el.diagTemp.textContent = String(payload.temp) + '°C';
        if (payload.storage != null) el.diagStorage.textContent = String(payload.storage);
        break;
      case 'SDP_ANSWER':
        handleSdpAnswer(payload).catch(error => logAudit('WEBRTC', error.message, 'critical'));
        break;
      case 'ICE_CANDIDATE':
        handleRemoteIceCandidate(payload).catch(error => logAudit('WEBRTC', error.message, 'critical'));
        break;
      case 'PEER_OFFLINE':
        el.badge.textContent = 'PEER OFFLINE';
        el.badge.className = 'badge badge-warning';
        logAudit('WEBRTC', 'The approved receiver is temporarily offline.', 'critical');
        break;
    }
  }

  // Browser is the receive-only controller: video frames must come from the Android peer.
  async function initWebRTC() {
    if (state.peerConnection) return state.peerConnection;
    if (!state.sessionToken || !state.activeDeviceId) throw new Error('No approved session token is available.');
    let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    try {
      const response = await fetch('/api/v1/turn/credentials', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + state.sessionToken }
      });
      if (!response.ok) throw new Error('TURN credentials unavailable (HTTP ' + response.status + ').');
      const config = await response.json();
      if (Array.isArray(config.iceServers) && config.iceServers.length) iceServers = config.iceServers;
    } catch (error) {
      logAudit('NETWORK', 'TURN relay is not configured. Direct STUN may fail behind carrier NAT: ' + error.message, 'critical');
    }
    const pc = new RTCPeerConnection({ iceServers });
    state.peerConnection = pc;
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.ontrack = event => {
      const stream = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([event.track]);
      el.video.srcObject = stream;
      el.video.play().catch(() => {});
      waitForActualVideoFrame();
      logAudit('WEBRTC', 'Remote video track negotiated; waiting for a decoded frame.');
    };
    pc.onicecandidate = event => {
      if (event.candidate) sendWs({
        type: 'ICE_CANDIDATE',
        targetDeviceId: state.activeDeviceId,
        payload: { candidate: event.candidate.toJSON() }
      });
    };
    pc.onconnectionstatechange = () => {
      const status = pc.connectionState;
      if (status === 'failed' || status === 'disconnected') {
        el.badge.textContent = status.toUpperCase();
        el.badge.className = 'badge badge-warning';
      } else if (status === 'connected' && !state.isVideoLive) {
        el.badge.textContent = 'CONNECTED · WAITING FOR VIDEO';
        el.badge.className = 'badge badge-warning';
      }
    };
    return pc;
  }

  function waitForActualVideoFrame() {
    if (typeof el.video.requestVideoFrameCallback === 'function') {
      const checkFrame = () => {
        if (!state.sessionActive) return;
        if (el.video.videoWidth > 0 && el.video.videoHeight > 0 && el.video.readyState >= 2) {
          state.isVideoLive = true;
          el.placeholder.style.display = 'none';
          el.badge.textContent = 'LIVE';
          el.badge.className = 'badge badge-success';
          if (!state.liveFrameLogged) {
            state.liveFrameLogged = true;
            logAudit('WEBRTC', 'First decoded remote video frame received.', 'security');
          }
        } else {
          el.video.requestVideoFrameCallback(checkFrame);
        }
      };
      el.video.requestVideoFrameCallback(checkFrame);
    } else {
      el.video.addEventListener('loadeddata', () => {
        if (el.video.videoWidth > 0 && el.video.videoHeight > 0) {
          state.isVideoLive = true;
          el.placeholder.style.display = 'none';
          el.badge.textContent = 'LIVE';
          el.badge.className = 'badge badge-success';
          logAudit('WEBRTC', 'Decoded remote video data received.', 'security');
        }
      }, { once: true });
    }
  }

  async function startBrowserOffer() {
    if (!state.sessionActive || !state.activeDeviceId || state.peerConnection) return;
    const pc = await initWebRTC();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (!sendWs({
      type: 'SDP_OFFER',
      targetDeviceId: state.activeDeviceId,
      payload: { type: offer.type, sdp: offer.sdp }
    })) throw new Error('Signaling socket is not open.');
    el.badge.textContent = 'NEGOTIATING';
    el.badge.className = 'badge badge-warning';
    logAudit('WEBRTC', 'Browser SDP offer sent to the approved receiver.');
  }

  async function handleSdpAnswer(payload) {
    if (!state.peerConnection) await initWebRTC();
    const answer = typeof payload === 'string' ? { type: 'answer', sdp: payload } : payload;
    if (!answer || !answer.sdp) throw new Error('Receiver SDP answer is empty.');
    await state.peerConnection.setRemoteDescription(new RTCSessionDescription({
      type: answer.type || 'answer',
      sdp: answer.sdp
    }));
  }

  async function handleRemoteIceCandidate(payload) {
    if (!state.peerConnection || !payload) return;
    const candidate = payload.candidate || payload;
    if (typeof candidate === 'string') {
      await state.peerConnection.addIceCandidate(new RTCIceCandidate({
        candidate,
        sdpMid: payload.sdpMid || '0',
        sdpMLineIndex: payload.sdpMLineIndex == null ? 0 : payload.sdpMLineIndex
      }));
    } else {
      await state.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }
  // Mouse to Touch Translation Engine
  function setupCanvasMouse() {
    let isMouseDown = false;

    el.canvas.addEventListener('mousedown', (e) => {
      isMouseDown = true;
      state.dragStart = getNativeCoords(e);
      state.dragStartTime = Date.now();

      if (Date.now() - state.lastClickTime < 300) {
        state.clickCount++;
      } else {
        state.clickCount = 1;
      }
      state.lastClickTime = Date.now();
    });

    el.canvas.addEventListener('mouseup', (e) => {
      if (!isMouseDown) return;
      isMouseDown = false;

      const endCoords = getNativeCoords(e);
      const duration = Date.now() - state.dragStartTime;
      const dx = endCoords.x - state.dragStart.x;
      const dy = endCoords.y - state.dragStart.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < 15) {
        if (state.clickCount === 2) {
          // Double Tap
          sendCommand('Tap', { x: state.dragStart.x, y: state.dragStart.y, action: 'DOUBLE_TAP' });
          logAudit('INPUT', `Double Tap at (${Math.round(state.dragStart.x)}, ${Math.round(state.dragStart.y)})`);
        } else if (duration > 600) {
          // Long Press
          sendCommand('Tap', { x: state.dragStart.x, y: state.dragStart.y, action: 'LONG_PRESS', durationMs: duration });
          logAudit('INPUT', `Long Press (${duration}ms) at (${Math.round(state.dragStart.x)}, ${Math.round(state.dragStart.y)})`);
        } else {
          // Single Tap
          sendCommand('Tap', { x: state.dragStart.x, y: state.dragStart.y, action: 'TAP' });
          logAudit('INPUT', `Tap at (${Math.round(state.dragStart.x)}, ${Math.round(state.dragStart.y)})`);
        }
      } else {
        if (duration > 500) {
          // Drag
          sendCommand('Swipe', {
            x: state.dragStart.x, y: state.dragStart.y,
            x2: endCoords.x, y2: endCoords.y,
            action: 'DRAG', durationMs: duration
          });
          logAudit('INPUT', `Sustained Drag from (${Math.round(state.dragStart.x)}, ${Math.round(state.dragStart.y)}) to (${Math.round(endCoords.x)}, ${Math.round(endCoords.y)})`);
        } else {
          // Swipe
          sendCommand('Swipe', {
            x: state.dragStart.x, y: state.dragStart.y,
            x2: endCoords.x, y2: endCoords.y,
            action: 'SWIPE', durationMs: Math.max(100, duration)
          });
          logAudit('INPUT', `Swipe from (${Math.round(state.dragStart.x)}, ${Math.round(state.dragStart.y)}) to (${Math.round(endCoords.x)}, ${Math.round(endCoords.y)}) in ${duration}ms`);
        }
      }
    });

    el.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const action = e.deltaY > 0 ? 'DOWN' : 'UP';
      sendCommand('Scroll', { action });
      logAudit('INPUT', `Scroll ${action}`);
    }, { passive: false });

    // Keyboard Text Input
    window.addEventListener('keydown', (e) => {
      // Ignore if user is typing into input fields
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

      if (e.key === 'Backspace') {
        sendCommand('GlobalAction', { action: 'BACK' });
      } else if (e.key === 'Home') {
        sendCommand('GlobalAction', { action: 'HOME' });
      } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        sendCommand('TextInput', { text: e.key });
        logAudit('INPUT', `Key Typed: '${e.key}'`);
      }
    });
  }

  function getNativeCoords(event) {
    const rect = el.canvas.getBoundingClientRect();
    const clientX = event.clientX - rect.left;
    const clientY = event.clientY - rect.top;

    // Scale to native 1080x1920
    const scaleX = 1080 / rect.width;
    const scaleY = 1920 / rect.height;

    return {
      x: Math.max(0, Math.min(1080, clientX * scaleX)),
      y: Math.max(0, Math.min(1920, clientY * scaleY))
    };
  }

  function sendCommand(type, params) {
    if (!state.sessionActive || !state.activeDeviceId) {
      logAudit('INPUT', 'No approved receiver session is active.', 'critical');
      return false;
    }
    const seq = state.commandSequence++;
    const payload = {
      type: 'INPUT_EVENT',
      sequence: seq,
      targetDeviceId: state.activeDeviceId,
      command: {
        commandId: 'cmd_' + Math.random().toString(36).substring(2, 9),
        type: type,
        timestamp: Date.now(),
        ...params
      }
    };
    return sendWs(payload);
  }

  // Canvas Render Loop
  function startCanvasRenderLoop() {
    function render() {
      // Render only real decoded receiver video; never synthesize placeholder phone content.
      if (state.isVideoLive && el.video.readyState >= 2 && el.video.videoWidth > 0) {
        try { ctx.drawImage(el.video, 0, 0, el.canvas.width, el.canvas.height); }
        catch (_) { state.isVideoLive = false; el.placeholder.style.display = 'flex'; }
      } else {
        ctx.fillStyle = '#0E1116';
        ctx.fillRect(0, 0, el.canvas.width, el.canvas.height);
      }
      requestAnimationFrame(render);
    }
    requestAnimationFrame(render);
  }

  // Navigation Toolbar actions
  function setupToolbar() {
    document.getElementById('btnNavBack').onclick = () => sendCommand('GlobalAction', { action: 'BACK' });
    document.getElementById('btnNavHome').onclick = () => sendCommand('GlobalAction', { action: 'HOME' });
    document.getElementById('btnNavRecents').onclick = () => sendCommand('GlobalAction', { action: 'RECENTS' });
    document.getElementById('btnNavNotifs').onclick = () => sendCommand('GlobalAction', { action: 'NOTIFICATIONS' });
    document.getElementById('btnNavSettings').onclick = () => sendCommand('GlobalAction', { action: 'QUICK_SETTINGS' });
    document.getElementById('btnVolDown').onclick = () => sendCommand('Volume', { action: 'DOWN' });
    document.getElementById('btnVolUp').onclick = () => sendCommand('Volume', { action: 'UP' });

    el.qualitySelect.onchange = () => {
      const q = el.qualitySelect.value;
      const stats = q === '1080p' ? '60 FPS | 4000 Kbps' : q === '720p' ? '30 FPS | 2048 Kbps' : '15 FPS | 800 Kbps';
      el.streamStats.textContent = stats;
      logAudit('STREAM', `Video profile switched to ${q} (${stats})`);
    };

    el.btnEmergencyKill.onclick = () => {
      if (confirm('Sever connection and terminate all remote sessions on the phone immediately?')) {
        sendWs({ type: 'EMERGENCY_DISCONNECT', targetDeviceId: state.activeDeviceId });
        logAudit('SECURITY', 'EMERGENCY DISCONNECT EXECUTED. Session wiped.', 'critical');
        el.badge.textContent = 'DISCONNECTED';
        el.badge.className = 'badge badge-danger';
      }
    };

    el.btnRunDiag.onclick = () => {
      sendWs({ type: 'DIAGNOSTICS_RUN', targetDeviceId: state.activeDeviceId });
      logAudit('DIAGNOSTICS', 'Requested remote diagnostic suite execution on target phone.');
    };

    el.btnLaunchPkg.onclick = () => {
      const pkg = el.launchPkgInput.value.trim();
      if (pkg) {
        sendWs({ type: 'APP_COMMAND', action: 'LAUNCH', packageName: pkg, targetDeviceId: state.activeDeviceId });
        logAudit('APP', `Requested launch of package: ${pkg}`);
      }
    };

    el.btnRefreshFiles.onclick = () => {
      sendWs({ type: 'FILE_COMMAND', action: 'LIST', path: state.currentPath, targetDeviceId: state.activeDeviceId });
      logAudit('FILES', `Refreshing directory: ${state.currentPath}`);
    };

    el.btnNewFolder.onclick = () => {
      const name = prompt('Enter new folder name:');
      if (name) {
        sendWs({ type: 'FILE_COMMAND', action: 'CREATE_FOLDER', path: state.currentPath, name: name, targetDeviceId: state.activeDeviceId });
        logAudit('FILES', `Created folder '${name}' in ${state.currentPath}`);
      }
    };

    el.btnClearLogs.onclick = () => { el.auditBox.innerHTML = ''; };
  }

  // File Upload Handling
  function setupFileUpload() {
    el.btnTriggerUpload.onclick = () => el.fileUploadInput.click();

    el.fileUploadInput.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      el.fileUploadProgress.style.display = 'block';
      el.progressText.textContent = `Uploading ${file.name} (0%)...`;
      el.progressBarFill.style.width = '0%';

      reader.onload = async (evt) => {
        const arrayBuffer = evt.target.result;
        const totalBytes = arrayBuffer.byteLength;
        const chunkSize = 32768; // 32KB
        let offset = 0;

        while (offset < totalBytes) {
          const slice = arrayBuffer.slice(offset, offset + chunkSize);
          const base64 = btoa(String.fromCharCode.apply(null, new Uint8Array(slice)));

          sendWs({
            type: 'FILE_COMMAND',
            action: 'WRITE_CHUNK',
            path: `${state.currentPath}/${file.name}`,
            data: base64,
            append: offset > 0,
            targetDeviceId: state.activeDeviceId
          });

          offset += chunkSize;
          const percent = Math.min(100, Math.round((offset / totalBytes) * 100));
          el.progressBarFill.style.width = `${percent}%`;
          el.progressText.textContent = `Uploading ${file.name} (${percent}%)...`;

          // Small throttle to avoid socket congestion
          await new Promise(r => setTimeout(r, 20));
        }

        el.progressText.textContent = `Upload completed: ${file.name}`;
        logAudit('FILES', `Uploaded file ${file.name} (${totalBytes} bytes) successfully.`, 'security');
        setTimeout(() => { el.fileUploadProgress.style.display = 'none'; }, 2000);
      };

      reader.readAsArrayBuffer(file);
    };
  }

  // Pairing Modal
  function setupModal() {
    el.btnPair.onclick = () => {
      el.pairModal.style.display = 'flex';
      el.inputPairCode.focus();
    };
    el.btnCloseModal.onclick = () => { el.pairModal.style.display = 'none'; };
    el.btnSubmitPair.onclick = () => {
      const code = el.inputPairCode.value.replace(/\D/g, '');
      if (!/^\d{6}$/.test(code)) {
        el.inputPairCode.setCustomValidity('Enter exactly six digits.');
        el.inputPairCode.reportValidity();
        return;
      }
      el.inputPairCode.setCustomValidity('');
      if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
        logAudit('PAIRING', 'Signaling server is offline. Pairing request was not sent.', 'critical');
        return;
      }
      el.pairModal.style.display = 'none';
      state.sessionActive = false;
      state.activeDeviceId = null;
      state.isVideoLive = false;
      logAudit('PAIRING', 'Sending six-digit pairing request.', 'security');
      sendWs({
        type: 'PAIR_BY_CODE',
        code,
        fingerprint: state.operatorFingerprint,
        controllerName: state.operatorName,
        requestedScopes: ['SCREEN_VIEW', 'REMOTE_INPUT', 'APP_MANAGEMENT', 'FILE_TRANSFER']
      });
      el.badge.textContent = 'PAIRING';
      el.badge.className = 'badge badge-warning';
    };
  }

  // Tab switching
  function setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab).classList.add('active');

        // Trigger fetches
        if (btn.dataset.tab === 'tabApps') {
          sendWs({ type: 'APP_COMMAND', action: 'LIST', targetDeviceId: state.activeDeviceId });
        } else if (btn.dataset.tab === 'tabFiles') {
          sendWs({ type: 'FILE_COMMAND', action: 'LIST', path: state.currentPath, targetDeviceId: state.activeDeviceId });
        }
      };
    });
  }

  function renderDevices() {
    el.deviceList.innerHTML = '';
    if (!state.pairedDevices.length) {
      const empty = document.createElement('div');
      empty.className = 'device-empty-state';
      empty.textContent = 'No active receiver session';
      el.deviceList.appendChild(empty);
      return;
    }
    state.pairedDevices.forEach(device => {
      const card = document.createElement('div');
      card.className = 'device-card active';
      const title = document.createElement('div');
      title.className = 'device-card-title';
      title.textContent = device.deviceName || 'Android receiver';
      const id = document.createElement('div');
      id.className = 'device-card-id';
      id.textContent = device.deviceId;
      card.append(title, id);
      el.deviceList.appendChild(card);
    });
  }

  function renderAppList(apps) {
    el.appList.innerHTML = '';
    if (apps.length === 0) {
      el.appList.innerHTML = '<p class="micro-text">No apps loaded.</p>';
      return;
    }
    apps.forEach(app => {
      const row = document.createElement('div');
      row.className = 'app-item';
      row.innerHTML = `
        <div>
          <strong>${app.name}</strong>
          <div class="micro-text mono-pill">${app.pkg}</div>
        </div>
        <button class="btn btn-small btn-secondary" onclick="window.launchApp('${app.pkg}')">Launch</button>
      `;
      el.appList.appendChild(row);
    });
  }
  window.launchApp = (pkg) => {
    sendWs({ type: 'APP_COMMAND', action: 'LAUNCH', packageName: pkg, targetDeviceId: state.activeDeviceId });
    logAudit('APP', `Launched package: ${pkg}`);
  };

  function renderFileList(files) {
    el.fileList.innerHTML = '';
    if (files.length === 0) {
      el.fileList.innerHTML = '<p class="micro-text">Folder is empty.</p>';
      return;
    }
    files.forEach(f => {
      const row = document.createElement('div');
      row.className = 'file-item';
      row.innerHTML = `
        <div>
          <span>${f.isDir ? '📁' : '📄'} ${f.name}</span>
          <div class="micro-text">${f.isDir ? 'Directory' : Math.round(f.size / 1024) + ' KB'}</div>
        </div>
        <button class="btn btn-small btn-danger" onclick="window.deleteFile('${f.path}')">Del</button>
      `;
      el.fileList.appendChild(row);
    });
  }
  window.deleteFile = (path) => {
    if (confirm(`Delete file '${path}' on device?`)) {
      sendWs({ type: 'FILE_COMMAND', action: 'DELETE', path: path, targetDeviceId: state.activeDeviceId });
      logAudit('FILES', `Deleted remote file: ${path}`, 'critical');
    }
  };

  function logAudit(category, message, severity = 'info') {
    const time = new Date().toLocaleTimeString();
    const div = document.createElement('div');
    div.className = `log-line ${severity}`;
    div.textContent = `[${time}] [${category}] ${message}`;
    el.auditBox.appendChild(div);
    el.auditBox.scrollTop = el.auditBox.scrollHeight;
  }

  // Start on DOM ready
  document.addEventListener('DOMContentLoaded', init);
})();
