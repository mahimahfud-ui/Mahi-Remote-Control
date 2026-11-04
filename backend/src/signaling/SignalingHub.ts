import { WebSocket, WebSocketServer } from 'ws';
import { AuthService } from '../authentication/AuthService';
import { DeviceService } from '../device-management/DeviceService';

type ClientType = 'ANDROID' | 'BROWSER' | 'CONTROLLER' | 'RECEIVER';

interface ClientConnection {
  ws: WebSocket;
  id: string;
  type: ClientType;
  fingerprint: string;
  deviceName: string;
  sessionId?: string;
  peerId?: string;
}

const ALLOWED_SESSION_MESSAGES = new Set([
  'SDP_OFFER', 'SDP_ANSWER', 'ICE_CANDIDATE',
  'INPUT_EVENT', 'APP_COMMAND', 'FILE_COMMAND', 'DIAGNOSTICS_RUN',
  'DIAGNOSTICS_RESULT', 'APP_LIST_RESPONSE', 'FILE_LIST_RESPONSE',
  'FILE_CHUNK_RESPONSE', 'COMMAND_ACK', 'STREAM_STATUS',
]);

function payloadObject(message: any): Record<string, any> {
  if (message?.payload && typeof message.payload === 'object') return message.payload;
  if (typeof message?.payload === 'string') {
    try { return JSON.parse(message.payload); } catch { return { value: message.payload }; }
  }
  return {};
}

function sendJson(client: ClientConnection | undefined, message: Record<string, any>): void {
  if (client?.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(message));
}

export class SignalingHub {
  private clients = new Map<string, ClientConnection>();

  constructor(private wss: WebSocketServer) {
    this.init();
  }

  private init(): void {
    this.wss.on('connection', (ws: WebSocket, req) => {
      const deviceId = String(req.headers['x-device-id'] || '');
      const role = String(req.headers['x-client-role'] || '').toUpperCase();
      const fingerprint = String(req.headers['x-device-fingerprint'] || '');
      const operatorFingerprint = String(req.headers['x-operator-fingerprint'] || '');
      const isBrowser = !deviceId;
      const clientId = deviceId || ('web_' + cryptoRandomId());
      const client: ClientConnection = {
        ws,
        id: clientId,
        type: isBrowser ? 'BROWSER' : (role === 'CONTROLLER' ? 'CONTROLLER' : 'RECEIVER'),
        fingerprint: fingerprint || operatorFingerprint,
        deviceName: String(req.headers['x-device-name'] || (isBrowser ? 'Browser controller' : 'Android device')).slice(0, 80),
      };

      const authHeader = String(req.headers.authorization || '');
      const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (headerToken && !this.attachSession(client, headerToken)) {
        ws.close(4401, 'Invalid or expired remote session');
        return;
      }

      const previous = this.clients.get(clientId);
      if (previous && previous.ws !== ws) previous.ws.close(4001, 'Replaced by a newer connection');
      this.clients.set(clientId, client);
      if (deviceId) {
        DeviceService.registerDevice(deviceId, client.deviceName, client.fingerprint || 'UNKNOWN');
      }

      ws.on('message', (raw: Buffer) => {
        try {
          const message = JSON.parse(raw.toString());
          this.handleMessage(client, message);
        } catch {
          sendJson(client, { type: 'ERROR', error: 'Invalid JSON message.' });
        }
      });

      ws.on('close', () => {
        if (this.clients.get(client.id) === client) {
          this.clients.delete(client.id);
          if (deviceId) DeviceService.markOffline(deviceId);
        }
      });
      ws.on('error', () => { /* close handler owns cleanup */ });

      if (client.sessionId) sendJson(client, { type: 'AUTHENTICATED', sessionId: client.sessionId, peerId: client.peerId });
      else sendJson(client, { type: 'CONNECTED', authenticated: false, clientId });
    });
  }

  private attachSession(client: ClientConnection, token: string): boolean {
    const auth = AuthService.verifySessionToken(token);
    if (!auth?.sessionId || !auth.peerId || auth.entityId !== client.id) return false;
    if (!DeviceService.isSessionParticipant(auth.sessionId, auth.entityId, auth.peerId)) return false;
    const session = DeviceService.getSession(auth.sessionId);
    if (!session) return false;
    const expectedFingerprint = auth.entityId === session.receiverId
      ? session.receiverFingerprint : session.controllerFingerprint;
    if (!expectedFingerprint || auth.fingerprint !== expectedFingerprint) return false;
    client.fingerprint = auth.fingerprint;
    client.sessionId = auth.sessionId;
    client.peerId = auth.peerId;
    return true;
  }

  private handleMessage(sender: ClientConnection, msg: any): void {
    const type = String(msg?.type || '').toUpperCase();
    const payload = payloadObject(msg);

    if (type === 'PING') {
      sendJson(sender, { type: 'PONG', timestamp: Date.now() });
      return;
    }
    if (type === 'REGISTER') {
      sendJson(sender, { type: 'REGISTER_ACK', status: 'OK', deviceId: sender.id });
      return;
    }
    if (type === 'AUTHENTICATE') {
      if (sender.sessionId) return;
      const token = String(msg.sessionToken || payload.sessionToken || '');
      const preview = AuthService.verifySessionToken(token);
      // Browser WebSocket clients cannot set custom HTTP headers. Rebind their transient
      // connection ID to the signed controller ID after validating the server-issued token.
      if (sender.type === 'BROWSER' && preview?.entityType === 'OPERATOR' && preview.entityId && preview.fingerprint) {
        if (this.clients.get(sender.id) === sender) this.clients.delete(sender.id);
        const existing = this.clients.get(preview.entityId);
        if (existing && existing !== sender) existing.ws.close(4001, 'Replaced by reauthenticated browser controller');
        sender.id = preview.entityId;
        sender.fingerprint = preview.fingerprint;
        this.clients.set(sender.id, sender);
      }
      if (!this.attachSession(sender, token)) {
        sendJson(sender, { type: 'AUTHENTICATION_FAILED', error: 'Invalid, expired, or revoked session.' });
        return;
      }
      sendJson(sender, { type: 'AUTHENTICATED', sessionId: sender.sessionId, peerId: sender.peerId });
      return;
    }

    if (type === 'REGISTER_PAIRING_CODE') {
      if (sender.type !== 'RECEIVER') {
        sendJson(sender, { type: 'PAIR_ERROR', error: 'Only a receiver Android device can register a pairing code.' });
        return;
      }
      if (!AuthService.checkRateLimit('code:' + sender.id, 10, 60000)) {
        sendJson(sender, { type: 'PAIR_ERROR', error: 'Too many pairing-code updates. Try again shortly.' });
        return;
      }
      const code = String(msg.code || payload.code || payload.value || '');
      const expiresAt = Number(msg.expiresAt || payload.expiresAt || Date.now() + 5 * 60 * 1000);
      try {
        DeviceService.storePairingCode(sender.id, code, expiresAt);
        sendJson(sender, { type: 'CODE_REGISTERED_ACK', expiresAt: Math.min(expiresAt, Date.now() + 5 * 60 * 1000) });
      } catch (error: any) {
        sendJson(sender, { type: 'PAIR_ERROR', error: error?.message || 'Pairing code could not be registered.' });
      }
      return;
    }

    if (type === 'PAIR_BY_CODE' || type === 'PAIR_CODE_CONNECT' || type === 'PAIR_REQUEST') {
      if (sender.sessionId) {
        sendJson(sender, { type: 'PAIR_ERROR', error: 'This connection already has an active session.' });
        return;
      }
      const code = String(msg.code || msg.pairingCode || payload.code || payload.pairingCode || '');
      const fingerprint = String(payload.fingerprint || msg.fingerprint || sender.fingerprint || '');
      if (!fingerprint || !AuthService.checkRateLimit('pair:' + fingerprint, 5, 60000)) {
        sendJson(sender, { type: 'PAIR_ERROR', error: 'Pairing rate limit reached or controller identity missing.' });
        return;
      }
      sender.fingerprint = fingerprint;
      const controllerName = String(msg.controllerName || msg.operatorName || payload.controllerName || payload.operatorName || sender.deviceName);
      const scopes = Array.isArray(msg.requestedScopes) ? msg.requestedScopes :
        Array.isArray(payload.requestedScopes) ? payload.requestedScopes : ['SCREEN_VIEW', 'REMOTE_INPUT'];

      const request = DeviceService.beginPairing(code, sender.id, controllerName, fingerprint, scopes);
      if (!request) {
        sendJson(sender, { type: 'PAIR_ERROR', error: 'Invalid, expired, already pending, or unavailable pairing code.' });
        return;
      }

      const receiver = this.clients.get(request.receiverId);
      if (!receiver || receiver.ws.readyState !== WebSocket.OPEN) {
        DeviceService.rejectPairing(request.receiverId, sender.id);
        sendJson(sender, { type: 'PAIR_ERROR', error: 'Receiver is currently offline.' });
        return;
      }

      sendJson(receiver, {
        type: 'PAIR_REQUEST',
        sender: sender.id,
        controllerId: sender.id,
        operatorName: request.controllerName,
        controllerName: request.controllerName,
        operatorLocation: 'Remote controller',
        fingerprint,
        requestedScopes: request.requestedScopes,
        pendingRequestId: request.requestId,
        expiresAt: request.expiresAt,
        timestamp: Date.now(),
      });
      sendJson(sender, {
        type: 'PAIR_PENDING',
        receiverId: request.receiverId,
        expiresAt: request.expiresAt,
        message: 'Waiting for the receiver owner to approve the request.',
      });
      return;
    }

    if (type === 'PAIR_ACCEPT' || type === 'PAIR_REJECT') {
      if (sender.type === 'BROWSER' || sender.type === 'CONTROLLER') {
        sendJson(sender, { type: 'PAIR_ERROR', error: 'Only the receiver owner can approve or reject a pairing request.' });
        return;
      }
      const controllerId = String(msg.recipient || msg.targetDeviceId || payload.controllerId || '');
      if (!controllerId) {
        sendJson(sender, { type: 'PAIR_ERROR', error: 'Pairing request identity is missing.' });
        return;
      }
      if (type === 'PAIR_REJECT') {
        const rejected = DeviceService.rejectPairing(sender.id, controllerId);
        const controller = this.clients.get(controllerId);
        if (rejected) sendJson(controller, { type: 'PAIR_REJECT', sender: sender.id, reason: 'Rejected by receiver owner.' });
        else sendJson(sender, { type: 'PAIR_ERROR', error: 'No matching pending request to reject.' });
        return;
      }

      const controller = this.clients.get(controllerId);
      if (!controller || controller.ws.readyState !== WebSocket.OPEN) {
        DeviceService.rejectPairing(sender.id, controllerId);
        sendJson(sender, { type: 'PAIR_ERROR', error: 'Controller disconnected before approval.' });
        return;
      }

      const session = DeviceService.approvePairing(sender.id, controllerId);
      if (!session) {
        sendJson(sender, { type: 'PAIR_ERROR', error: 'Request expired or no longer pending. Generate a new code.' });
        return;
      }

      const receiverToken = AuthService.generateSessionToken({
        entityId: session.receiverId, entityType: 'DEVICE',
        fingerprint: session.receiverFingerprint, sessionId: session.sessionId,
        peerId: session.controllerId,
      });
      const controllerToken = AuthService.generateSessionToken({
        entityId: session.controllerId, entityType: 'OPERATOR',
        fingerprint: session.controllerFingerprint, sessionId: session.sessionId,
        peerId: session.receiverId,
      });

      sender.sessionId = session.sessionId;
      sender.peerId = controllerId;
      controller.sessionId = session.sessionId;
      controller.peerId = sender.id;

      sendJson(controller, {
        type: 'PAIR_ACCEPT',
        sender: sender.id,
        recipient: controllerId,
        payload: {
          sessionId: session.sessionId,
          receiverName: sender.deviceName,
          fingerprint: session.receiverFingerprint,
          status: 'APPROVED',
        },
      });
      sendJson(sender, {
        type: 'SESSION_AUTHORIZED', sessionId: session.sessionId,
        peerId: controllerId, sessionToken: receiverToken, expiresAt: session.expiresAt,
      });
      sendJson(controller, {
        type: 'SESSION_AUTHORIZED', sessionId: session.sessionId,
        peerId: sender.id, sessionToken: controllerToken, expiresAt: session.expiresAt,
      });
      return;
    }

    if (type === 'EMERGENCY_DISCONNECT') {
      this.terminateSession(sender, String(payload.reason || 'Disconnected by participant'));
      return;
    }

    if (!ALLOWED_SESSION_MESSAGES.has(type)) {
      sendJson(sender, { type: 'ERROR', error: 'Unsupported signaling message.' });
      return;
    }
    const activeSession = sender.sessionId ? DeviceService.getSession(sender.sessionId) : undefined;
    if (!sender.sessionId || !sender.peerId || !activeSession ||
        !DeviceService.isSessionParticipant(sender.sessionId, sender.id, sender.peerId)) {
      sendJson(sender, { type: 'SESSION_REQUIRED', error: 'An owner-approved active session is required.' });
      return;
    }

    const requiredScopeByMessage: Record<string, string> = {
      SDP_OFFER: 'SCREEN_VIEW',
      SDP_ANSWER: 'SCREEN_VIEW',
      ICE_CANDIDATE: 'SCREEN_VIEW',
      STREAM_STATUS: 'SCREEN_VIEW',
      INPUT_EVENT: 'REMOTE_INPUT',
      FILE_COMMAND: 'FILE_TRANSFER',
      FILE_LIST_RESPONSE: 'FILE_TRANSFER',
      FILE_CHUNK_RESPONSE: 'FILE_TRANSFER',
      APP_COMMAND: 'APP_MANAGEMENT',
      APP_LIST_RESPONSE: 'APP_MANAGEMENT',
      DIAGNOSTICS_RUN: 'DIAGNOSTICS',
      DIAGNOSTICS_RESULT: 'DIAGNOSTICS',
    };
    let requiredScope = requiredScopeByMessage[type];
    // Desktop/browser messages place action at the top level; Android wraps it in payload.
    const commandAction = String(payload.action || msg.action || '').toUpperCase();
    if (type === 'FILE_COMMAND' && commandAction === 'DELETE') {
      requiredScope = 'FILE_DELETE';
    }
    if (type === 'APP_COMMAND' && commandAction === 'UNINSTALL') {
      requiredScope = 'APP_UNINSTALL';
    }
    if (requiredScope && !activeSession.grantedScopes.includes(requiredScope)) {
      sendJson(sender, {
        type: 'SCOPE_REQUIRED',
        requiredScope,
        error: 'This operation was not included in the receiver-approved permission request.',
      });
      return;
    }

    const target = this.clients.get(sender.peerId);
    if (!target || target.sessionId !== sender.sessionId || target.peerId !== sender.id) {
      sendJson(sender, { type: 'PEER_OFFLINE', error: 'The approved peer is currently disconnected.' });
      return;
    }
    sendJson(target, {
      ...msg,
      sender: sender.id,
      senderId: sender.id,
      recipient: target.id,
      sessionId: sender.sessionId,
    });
  }

  private terminateSession(sender: ClientConnection, reason: string): void {
    if (!sender.sessionId) {
      sendJson(sender, { type: 'DISCONNECTED', message: 'No active session.' });
      return;
    }
    const sessionId = sender.sessionId;
    const peer = sender.peerId ? this.clients.get(sender.peerId) : undefined;
    DeviceService.endSession(sessionId);
    sendJson(peer, { type: 'SESSION_REVOKED', sessionId, reason });
    sendJson(sender, { type: 'DISCONNECTED', sessionId, reason });
    for (const client of [sender, peer]) {
      if (client?.sessionId === sessionId) {
        client.sessionId = undefined;
        client.peerId = undefined;
      }
    }
  }
}

function cryptoRandomId(): string {
  return require('crypto').randomUUID();
}
