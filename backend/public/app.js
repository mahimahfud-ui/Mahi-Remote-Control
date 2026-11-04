// Mahi Remote Control — Browser Controller Client
(function () {
  'use strict';

  // State Management
  const state = {
    ws: null,
    peerConnection: null,
    operatorFingerprint: 'OP-WEB-' + Array.from(crypto.getRandomValues(new Uint8Array(16))).map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase(),
    operatorName: 'Browser Controller',
    activeDeviceId: null,
    pairedDevices: [],
    pairingRequestId: null,
    sessionId: null,
    sessionToken: null,
    runtimeConfig: null,
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
    startCanvasRenderLoop();
    logAudit('INIT', `Browser Controller ready. Fingerprint: ${state.operatorFingerprint}`, 'security');
    loadRuntimeConfig().finally(connectSignaling);
  }

  async function loadRuntimeConfig() {
    try {
      const response = await fetch('/api/v1/config', { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new Error('Configuration endpoint returned HTTP ' + response.status);
      const config = await response.json();
      state.runtimeConfig = config;
      if (!config.browserAccessConfigured || !config.signalingUrl) {
        logAudit('CONFIG', 'Public HTTPS access is not configured on the backend.', 'critical');
      } else {
        logAudit('CONFIG', 'Public browser URL and WSS endpoint loaded from backend.', 'security');
      }
      if (!config.turnConfigured) {
        logAudit('NETWORK', 'TURN relay is not configured. Cross-network connectivity may fail behind restrictive NAT/CGNAT.', 'critical');
      } else {
        logAudit('NETWORK', 'TURN relay is configured. Short-lived credentials will be issued only after receiver approval.', 'security');
      }
    } catch (error) {
      state.runtimeConfig = null;
      logAudit('CONFIG', 'Unable to load runtime configuration: ' + error.message, 'critical');
    }
  }

  // WebSocket Signaling Connection (Dynamically works with ANY IP or Cloudflare tunnel!)
  function connectSignaling() {
    const configuredUrl = state.runtimeConfig && state.runtimeConfig.signalingUrl;
    if (!configuredUrl || !configuredUrl.startsWith('wss://')) {
      el.badge.textContent = 'PUBLIC ACCESS NOT CONFIGURED';
      el.badge.className = 'badge badge-danger';
      logAudit('CONFIG', 'A real HTTPS PUBLIC_BASE_URL and WSS endpoint must be configured on the backend before browser access can work.', 'critical');
      return;
    }
    const wsUrl = configuredUrl;

    logAudit('SIGNALING', `Connecting to configured WSS endpoint ${wsUrl}...`);
    el.badge.textContent = 'CONNECTING';
    el.badge.className = 'badge badge-warning';

    try {
      state.ws = new WebSocket(wsUrl);

      state.ws.onopen = () => {
        el.badge.textContent = 'ONLINE / READY';
        el.badge.className = 'badge badge-success';
        logAudit('SIGNALING', `Connected to signaling hub. Authenticated as ${state.operatorFingerprint}`, 'security');
        
        // Initial ping for latency
        sendPing();
        setInterval(sendPing, 15000);
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
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
    const message = { ...data };
    if (state.sessionToken && !['PING', 'PAIR_BY_CODE', 'PAIR_CODE_CONNECT'].includes(message.type)) {
      message.sessionToken = state.sessionToken;
    }
    state.ws.send(JSON.stringify(message));
    return true;
  }

  let lastPingTimestamp = 0;
  function sendPing() {
    lastPingTimestamp = Date.now();
    sendWs({ type: 'PING', timestamp: lastPingTimestamp });
  }

  // Handle incoming messages
  function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'PONG': {
        const rtt = Date.now() - lastPingTimestamp;
        el.latency.textContent = `${rtt} ms RTT`;
        break;
      }
      case 'COMMAND_ACK': {
        logAudit('ACK', `Command #${msg.sequence} acknowledged by the remote device.`);
        break;
      }
      case 'APP_LIST_RESPONSE': {
        renderAppList(JSON.parse(msg.payload || '[]'));
        break;
      }
      case 'FILE_LIST_RESPONSE': {
        renderFileList(JSON.parse(msg.payload || '[]'));
        break;
      }
      case 'DIAGNOSTICS_RESULT': {
        try {
          const diag = JSON.parse(msg.payload);
          if (diag.battery) el.diagBattery.textContent = `${diag.battery}% (Nominal)`;
          if (diag.temp) el.diagTemp.textContent = `${diag.temp}°C`;
          if (diag.storage) el.diagStorage.textContent = `${diag.storage} free`;
          logAudit('DIAGNOSTICS', `Diagnostics telemetry update: Battery ${diag.battery}%, Temp ${diag.temp}°C`, 'security');
        } catch (e) {}
        break;
      }
      case 'PAIR_PENDING': {
        state.pairingRequestId = msg.requestId || null;
        el.badge.textContent = 'WAITING FOR APPROVAL';
        el.badge.className = 'badge badge-warning';
        logAudit('PAIRING', 'Pairing request delivered. Waiting for receiver approval.');
        break;
      }
      case 'PAIR_ACCEPT': {
        if (!msg.sessionToken || !msg.sessionId || !msg.sender) {
          logAudit('SECURITY', 'Server approval did not include valid session credentials.', 'critical');
          break;
        }
        state.sessionToken = msg.sessionToken;
        state.sessionId = msg.sessionId;
        state.activeDeviceId = msg.sender;
        state.pairedDevices = [{ deviceId: msg.sender, deviceName: msg.receiverName || 'Android Receiver' }];
        renderDevices();
        el.badge.textContent = 'APPROVED · CONNECTING';
        el.badge.className = 'badge badge-warning';
        logAudit('SECURITY', 'Receiver owner approved this session. Establishing media connection.', 'security');
        startControllerOffer().catch(error => {
          logAudit('WEBRTC', 'Unable to create WebRTC offer: ' + error.message, 'critical');
        });
        break;
      }
      case 'PAIR_REJECT': {
        state.pairingRequestId = null;
        el.badge.textContent = 'REJECTED';
        el.badge.className = 'badge badge-danger';
        logAudit('PAIRING', 'Receiver owner rejected the connection request.', 'critical');
        break;
      }
      case 'PAIR_ERROR':
      case 'SESSION_ERROR': {
        state.pairingRequestId = null;
        el.badge.textContent = 'CONNECTION ERROR';
        el.badge.className = 'badge badge-danger';
        logAudit('SECURITY', msg.error || 'Connection or session authorization failed.', 'critical');
        break;
      }
      case 'SESSION_ENDED': {
        stopBrowserSession('Remote session ended.');
        break;
      }
      case 'SDP_ANSWER': {
        const answer = msg.payload && msg.payload.sdp ? msg.payload.sdp : msg.sdp;
        if (answer) handleSdpAnswer(answer);
        break;
      }
    }
  }

  async function loadSessionIceServers() {
    const fallback = state.runtimeConfig && Array.isArray(state.runtimeConfig.iceServers)
      ? state.runtimeConfig.iceServers
      : [{ urls: 'stun:stun.l.google.com:19302' }];

    if (!state.sessionToken || !state.runtimeConfig || !state.runtimeConfig.turnConfigured) {
      return fallback;
    }

    try {
      const response = await fetch('/api/v1/turn-credentials', {
        method: 'GET',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Authorization: 'Bearer ' + state.sessionToken }
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const result = await response.json();
      if (!Array.isArray(result.iceServers) || result.iceServers.length < 2) {
        throw new Error('TURN server returned no ICE relay configuration.');
      }
      logAudit('NETWORK', 'Session-scoped, short-lived TURN credentials received.', 'security');
      return result.iceServers;
    } catch (error) {
      logAudit('NETWORK', 'TURN credentials could not be loaded: ' + error.message + '. Direct ICE may still work; restrictive NAT may block this session.', 'critical');
      return fallback;
    }
  }

  // WebRTC Setup
  async function initWebRTC(iceServers) {
    // TURN credentials are fetched only after the owner-approved session exists.
    // The shared TURN secret never enters this browser.
    state.peerConnection = new RTCPeerConnection({ iceServers });

    state.peerConnection.addTransceiver('video', { direction: 'recvonly' });
    state.peerConnection.ontrack = (event) => {
      const stream = event.streams && event.streams[0];
      if (!stream) return;
      el.video.srcObject = stream;
      el.video.play().catch(() => {});
      el.placeholder.style.display = 'block';
      el.placeholder.textContent = 'Connecting video…';
      const markFrameReceived = () => {
        el.placeholder.style.display = 'none';
        el.badge.textContent = 'LIVE';
        el.badge.className = 'badge badge-success';
        logAudit('WEBRTC', 'First actual remote video frame received.', 'security');
      };
      if (typeof el.video.requestVideoFrameCallback === 'function') {
        el.video.requestVideoFrameCallback(markFrameReceived);
      } else {
        el.video.addEventListener('loadeddata', markFrameReceived, { once: true });
      }
    };

    state.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        sendWs({
          type: 'ICE_CANDIDATE',
          targetDeviceId: state.activeDeviceId,
          payload: {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex
          }
        });
      }
    };
    state.peerConnection.onconnectionstatechange = () => {
      const status = state.peerConnection.connectionState;
      if (status === 'failed' || status === 'disconnected' || status === 'closed') {
        el.badge.textContent = 'MEDIA ' + status.toUpperCase();
        el.badge.className = 'badge badge-danger';
      }
    };
  }

  async function startControllerOffer() {
    if (!state.activeDeviceId || !state.sessionToken) throw new Error('No approved session.');
    const iceServers = await loadSessionIceServers();
    await initWebRTC(iceServers);
    const offer = await state.peerConnection.createOffer();
    await state.peerConnection.setLocalDescription(offer);
    sendWs({
      type: 'SDP_OFFER',
      targetDeviceId: state.activeDeviceId,
      payload: { sdp: state.peerConnection.localDescription.sdp }
    });
  }

  function stopBrowserSession(reason) {
    if (state.peerConnection) {
      state.peerConnection.close();
      state.peerConnection = null;
    }
    state.video.srcObject = null;
    state.sessionToken = null;
    state.sessionId = null;
    state.activeDeviceId = null;
    state.pairedDevices = [];
    el.placeholder.style.display = 'block';
    el.placeholder.textContent = 'No active remote session.';
    el.badge.textContent = 'DISCONNECTED';
    el.badge.className = 'badge badge-danger';
    renderDevices();
    logAudit('SESSION', reason, 'critical');
  }

  async function handleSdpAnswer(sdp) {
    if (!state.peerConnection) await initWebRTC();
    await state.peerConnection.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
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
    sendWs(payload);
  }

  // Canvas Render Loop
  function startCanvasRenderLoop() {
    function render() {
      if (el.video.srcObject && el.video.readyState >= 2 && el.video.videoWidth > 0) {
        ctx.drawImage(el.video, 0, 0, el.canvas.width, el.canvas.height);
      } else {
        // Do not synthesize a phone screen. The empty viewer remains visibly empty
        // until actual remote video frames arrive.
        ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);
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

    // Quality selection is disabled in the UI until a real Android sender can apply it.

    el.btnEmergencyKill.onclick = () => {
      if (!state.sessionToken || !state.activeDeviceId) {
        logAudit('SECURITY', 'No approved session is active. No disconnect command was sent.', 'warning');
        return;
      }
      if (confirm('Sever this approved remote session immediately?')) {
        const sent = sendWs({ type: 'EMERGENCY_DISCONNECT', targetDeviceId: state.activeDeviceId });
        if (!sent) {
          el.badge.textContent = 'STOP NOT SENT';
          el.badge.className = 'badge badge-danger';
          logAudit('SECURITY', 'Emergency disconnect could not be sent. The remote session may still be active.', 'critical');
          return;
        }
        el.badge.textContent = 'DISCONNECTING';
        el.badge.className = 'badge badge-warning';
        logAudit('SECURITY', 'Emergency disconnect request sent; waiting for server revocation confirmation.', 'critical');
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

        el.progressText.textContent = `Chunks sent: ${file.name} (receiver confirmation not available)`;
        logAudit('FILES', `Sent ${totalBytes} bytes of ${file.name} to the signaling channel. End-to-end file-write confirmation has not been implemented.`, 'warning');
        setTimeout(() => { el.fileUploadProgress.style.display = 'none'; }, 4000);
      };

      reader.readAsArrayBuffer(file);
    };
  }

  // Pairing Modal
  function setupModal() {
    const queryCode = new URL(window.location.href).searchParams.get('code');
    if (queryCode && /^\\d{6}$/.test(queryCode.replace(/[^0-9]/g, ''))) {
      el.inputPairCode.value = queryCode.replace(/[^0-9]/g, '');
      el.pairModal.style.display = 'flex';
      logAudit('PAIRING', 'Temporary code was prefilled from the receiver QR link.');
    }

    el.btnPair.onclick = () => {
      el.pairModal.style.display = 'flex';
      el.inputPairCode.focus();
    };

    el.btnCloseModal.onclick = () => { el.pairModal.style.display = 'none'; };

    el.btnSubmitPair.onclick = () => {
      const code = el.inputPairCode.value.trim().replace(/[^0-9]/g, '');
      if (!/^\\d{6}$/.test(code)) {
        logAudit('PAIRING', 'Enter a valid six-digit pairing code.', 'critical');
        return;
      }
      state.sessionToken = null;
      state.sessionId = null;
      state.activeDeviceId = null;
      const sent = sendWs({
        type: 'PAIR_BY_CODE',
        code,
        fingerprint: state.operatorFingerprint,
        operatorName: state.operatorName,
        requestedScopes: ['Screen Mirroring', 'Remote Interaction', 'File Transfer']
      });
      if (!sent) {
        el.badge.textContent = 'SIGNALING OFFLINE';
        el.badge.className = 'badge badge-danger';
        logAudit('PAIRING', 'Pairing request was not sent because the WSS connection is offline.', 'critical');
        return;
      }
      el.pairModal.style.display = 'none';
      logAudit('PAIRING', 'Pairing request sent. Waiting for receiver approval.', 'security');
      el.badge.textContent = 'REQUEST SENT';
      el.badge.className = 'badge badge-warning';
    };
  }

  window.addEventListener('pagehide', () => {
    if (state.sessionToken && state.activeDeviceId && state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({
        type: 'EMERGENCY_DISCONNECT',
        targetDeviceId: state.activeDeviceId,
        sessionToken: state.sessionToken,
        payload: { reason: 'Browser controller page closed' }
      }));
    }
  });

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
      empty.className = 'device-card';
      empty.textContent = 'No approved devices in this session. Enter a temporary pairing code to connect.';
      el.deviceList.appendChild(empty);
      return;
    }
    state.pairedDevices.forEach(d => {
      const card = document.createElement('div');
      card.className = 'device-card active';
      const title = document.createElement('div');
      title.className = 'device-card-title';
      title.textContent = d.deviceName;
      const id = document.createElement('div');
      id.className = 'device-card-id';
      id.textContent = d.deviceId;
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
