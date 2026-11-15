import crypto from 'crypto';
import { IncomingMessage } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import { AuthService, DeviceAuthContext } from '../authentication/AuthService';
import { Database } from '../database/Database';
import { DeviceService, DeviceServiceError, PairingRequestRecord } from '../device-management/DeviceService';

type ClientType = 'ANDROID' | 'WINDOWS' | 'CONTROLLER' | 'RECEIVER' | 'BROWSER';

interface ClientConnection {
  ws: WebSocket;
  id: string;
  type: ClientType;
  fingerprint: string;
  remoteAddress: string;
  instanceId: string;
  deviceAuth?: DeviceAuthContext;
  isAlive: boolean;
}

const PAIRING_REQUEST_TTL_MS = 2 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;
const HEARTBEAT_MS = 20_000;
const MAX_MESSAGE_BYTES = 1_048_576;
const DEFAULT_SCOPES = ['SCREEN_VIEW', 'REMOTE_INPUT', 'FILES', 'DIAGNOSTICS'];

const EVENT_SCOPE: Record<string, string | null> = {
  SDP_OFFER: 'SCREEN_VIEW',
  SDP_ANSWER: 'SCREEN_VIEW',
  ICE_CANDIDATE: 'SCREEN_VIEW',
  INPUT_EVENT: 'REMOTE_INPUT',
  APP_LIST_REQUEST: 'FILES',
  APP_LIST_RESPONSE: 'FILES',
  APP_LAUNCH: 'FILES',
  APP_STOP: 'FILES',
  FILE_LIST_REQUEST: 'FILES',
  FILE_LIST_RESPONSE: 'FILES',
  FILE_READ_REQUEST: 'FILES',
  FILE_TRANSFER: 'FILES',
  FILE_UPLOAD_START: 'FILES',
  FILE_UPLOAD_CHUNK: 'FILES',
  FILE_UPLOAD_ACK: 'FILES',
  FILE_UPLOAD_COMPLETE: 'FILES',
  FILE_DELETE_REQUEST: 'FILES',
  DIAGNOSTICS_REQUEST: 'DIAGNOSTICS',
  DIAGNOSTICS_RESPONSE: 'DIAGNOSTICS',
  EMERGENCY_DISCONNECT: null,
};

const PUBLIC_EVENTS = new Set([
  'PING',
  'REGISTER',
  'REGISTER_PAIRING_CODE',
  'PAIR_BY_CODE',
  'PAIR_CODE_CONNECT',
  'PAIR_ACCEPT',
  'PAIR_REJECT',
]);

export class SignalingHub {
  private readonly clients = new Map<string, ClientConnection>();
  private readonly instanceId = process.env.INSTANCE_ID || crypto.randomUUID();
  private readonly heartbeatTimer: NodeJS.Timeout;
  private readonly maintenanceTimer: NodeJS.Timeout;

  constructor(private readonly wss: WebSocketServer) {
    Database.setSignalHandler((targetId, payload) => this.sendLocal(targetId, payload));
    void Database.startSignalListener().catch((error) => {
      console.error('[signaling] could not start cross-instance listener', error);
    });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      void this.acceptConnection(ws, req);
    });

    this.heartbeatTimer = setInterval(() => {
      void this.heartbeatClients();
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();

    this.maintenanceTimer = setInterval(() => {
      void this.runMaintenance();
    }, 15_000);
    this.maintenanceTimer.unref?.();
  }

  private async acceptConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const requestUrl = new URL(req.url || '/ws', 'http://localhost');
    const suppliedVersion = String(req.headers['x-mahi-protocol-version'] || requestUrl.searchParams.get('protocolVersion') || '');
    if (suppliedVersion && suppliedVersion !== '1') {
      ws.close(1002, 'Unsupported Mahi protocol version');
      return;
    }

    const origin = req.headers.origin;
    if (origin) {
      let allowedOrigin: string | null = null;
      try {
        const configured = process.env.PUBLIC_BASE_URL || '';
        allowedOrigin = configured ? new URL(configured).origin : null;
      } catch {
        allowedOrigin = null;
      }
      if (!allowedOrigin || origin !== allowedOrigin) {
        ws.close(1008, 'Origin is not allowed');
        return;
      }
    }

    const authorization = String(req.headers.authorization || '');
    const accessToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    const deviceAuth = accessToken ? AuthService.verifyDeviceToken(accessToken) : null;
    const deviceIdHeader = String(req.headers['x-device-id'] || '');
    const operatorFpHeader = String(req.headers['x-operator-fingerprint'] || '');
    const clientRole = String(req.headers['x-client-role'] || '').toUpperCase();
    const browserFingerprint = String(requestUrl.searchParams.get('controllerFingerprint') || '');

    let clientId = '';
    let clientType: ClientType = 'BROWSER';
    let fingerprint = '';
    if (deviceIdHeader || deviceAuth) {
      if (!deviceAuth || (deviceIdHeader && deviceIdHeader !== deviceAuth.deviceId)) {
        ws.close(1008, 'A valid enrolled device bearer token is required');
        return;
      }
      const device = await DeviceService.getDevice(deviceAuth.deviceId).catch(() => null);
      if (
        !device ||
        device.isRevoked ||
        device.fingerprint !== deviceAuth.fingerprint ||
        device.keyVersion !== deviceAuth.keyVersion
      ) {
        ws.close(1008, 'Device authorization is expired or revoked');
        return;
      }
      clientId = deviceAuth.deviceId;
      clientType = clientRole === 'CONTROLLER' ? 'CONTROLLER' : 'RECEIVER';
      fingerprint = deviceAuth.fingerprint;
    } else if (operatorFpHeader) {
      if (!/^[A-Za-z0-9:_-]{8,256}$/.test(operatorFpHeader)) {
        ws.close(1008, 'Invalid controller identity');
        return;
      }
      clientId = `operator_${operatorFpHeader}`;
      clientType = 'WINDOWS';
      fingerprint = operatorFpHeader;
    } else if (browserFingerprint) {
      if (!/^[A-Za-z0-9:_-]{8,256}$/.test(browserFingerprint)) {
        ws.close(1008, 'Invalid controller identity');
        return;
      }
      clientId = `browser_${browserFingerprint}`;
      clientType = 'BROWSER';
      fingerprint = browserFingerprint;
    } else {
      // A generated anonymous identity may browse the page but cannot pair until
      // the browser sends a stable, validated controllerFingerprint.
      clientId = `browser_${crypto.randomUUID()}`;
      clientType = 'BROWSER';
      fingerprint = clientId;
    }

    const client: ClientConnection = {
      ws,
      id: clientId,
      type: clientType,
      fingerprint,
      remoteAddress: req.socket.remoteAddress || 'unknown',
      instanceId: this.instanceId,
      deviceAuth: deviceAuth || undefined,
      isAlive: true,
    };

    const previous = this.clients.get(client.id);
    this.clients.set(client.id, client);
    if (previous && previous.ws !== ws) {
      previous.ws.close(4001, 'Replaced by a newer connection');
    }

    try {
      await DeviceService.setConnectionOnline(
        client.id,
        client.instanceId,
        client.type === 'RECEIVER' || client.type === 'ANDROID' ? 'DEVICE' : 'OPERATOR',
        client.fingerprint
      );
      if (client.deviceAuth && (client.type === 'RECEIVER' || client.type === 'ANDROID')) {
        await DeviceService.setDeviceOnline(client.id, client.instanceId);
      }
    } catch (error) {
      this.clients.delete(client.id);
      ws.close(1011, 'Could not establish durable device presence');
      console.error('[signaling] presence registration failed', error);
      return;
    }

    ws.on('pong', () => { client.isAlive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary || Buffer.byteLength(data as Buffer) > MAX_MESSAGE_BYTES) {
        ws.close(1009, 'Message exceeds the allowed size');
        return;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        this.send(client, { type: 'SIGNALING_ERROR', errorCode: 'INVALID_REQUEST', error: 'Invalid JSON message.', protocolVersion: 1 });
        return;
      }
      void this.handleMessage(client, parsed).catch((error) => {
        const code = error instanceof DeviceServiceError ? error.code : 'INTERNAL_ERROR';
        this.send(client, {
          type: 'SIGNALING_ERROR',
          errorCode: code,
          error: error instanceof Error ? error.message : 'Signaling request failed.',
          protocolVersion: 1,
        });
        if (!(error instanceof DeviceServiceError)) console.error('[signaling] message handler error', error);
      });
    });

    ws.on('close', () => {
      void this.handleDisconnect(client);
    });
    ws.on('error', (error) => {
      console.warn('[signaling] websocket error', client.id, error.message);
    });

    this.send(client, {
      type: 'REGISTER_ACK',
      status: 'OK',
      deviceId: client.id,
      protocolVersion: 1,
    });
  }

  private send(client: ClientConnection, payload: Record<string, unknown>): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(payload));
    }
  }

  private sendLocal(targetId: string, payload: Record<string, unknown>): void {
    const client = this.clients.get(targetId);
    if (client) this.send(client, payload);
  }

  private async sendToEntity(targetId: string, payload: Record<string, unknown>): Promise<void> {
    const local = this.clients.get(targetId);
    if (local && local.ws.readyState === WebSocket.OPEN) {
      this.send(local, payload);
      return;
    }
    await Database.publishSignal(targetId, payload);
  }

  private async handleDisconnect(client: ClientConnection): Promise<void> {
    // Ignore the close event from a superseded socket.
    if (this.clients.get(client.id) !== client) return;
    this.clients.delete(client.id);

    try {
      await DeviceService.setConnectionOffline(client.id, client.instanceId);
      if (client.deviceAuth && (client.type === 'RECEIVER' || client.type === 'ANDROID')) {
        await DeviceService.setDeviceOffline(client.id, client.instanceId);
      }

      if (!await DeviceService.isEntityOnline(client.id)) {
        if (client.type === 'RECEIVER' || client.type === 'ANDROID') {
          const pending = await DeviceService.cancelPendingRequestsByReceiver(client.id);
          for (const request of pending) {
            await this.sendToEntity(request.controllerId, {
              type: 'PAIR_ERROR',
              requestId: request.requestId,
              errorCode: 'RECEIVER_OFFLINE',
              error: 'The receiver disconnected before approval.',
              protocolVersion: 1,
            });
          }
        } else {
          const pending = await DeviceService.cancelPendingRequestsByController(client.id);
          for (const request of pending) {
            await this.sendToEntity(request.receiverId, {
              type: 'PAIR_ERROR',
              requestId: request.requestId,
              errorCode: 'CONTROLLER_DISCONNECTED',
              error: 'The controller disconnected before approval.',
              protocolVersion: 1,
            });
          }
        }
      }
    } catch (error) {
      console.error('[signaling] cleanup after disconnect failed', error);
    }
  }

  private async heartbeatClients(): Promise<void> {
    const current = Array.from(this.clients.values());
    for (const client of current) {
      if (!client.isAlive) {
        client.ws.terminate();
        continue;
      }
      client.isAlive = false;
      try {
        client.ws.ping();
        await DeviceService.heartbeatConnection(client.id, client.instanceId);
        if (client.deviceAuth && (client.type === 'RECEIVER' || client.type === 'ANDROID')) {
          await DeviceService.heartbeatDevice(client.id, client.instanceId);
        }
      } catch {
        client.ws.terminate();
      }
    }
  }

  private async runMaintenance(): Promise<void> {
    try {
      const expired = await DeviceService.expireDueSessions();
      for (const item of expired) {
        await this.sendToEntity(item.participantId, {
          type: 'SESSION_ENDED',
          sessionId: item.sessionId,
          reason: 'The approved 30-minute session expired.',
          protocolVersion: 1,
        });
      }
      await DeviceService.markExpiredPresenceOffline();
      await Database.cleanupEphemeralRecords();
    } catch (error) {
      console.error('[signaling] scheduled maintenance failed', error);
    }
  }

  private payloadObject(message: any): Record<string, any> {
    return message?.payload && typeof message.payload === 'object' && !Array.isArray(message.payload)
      ? message.payload
      : {};
  }

  private requestedScopes(message: any, payload: Record<string, any>): string[] {
    const candidate = message.requestedScopes || payload.requestedScopes;
    if (!Array.isArray(candidate)) return DEFAULT_SCOPES;
    const normalized = candidate.map((scope: unknown) => {
      const value = String(scope || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
      if (value.includes('SCREEN') || value.includes('VIDEO')) return 'SCREEN_VIEW';
      if (value.includes('REMOTE') || value.includes('INPUT') || value.includes('CONTROL')) return 'REMOTE_INPUT';
      if (value.includes('FILE') || value.includes('APP')) return 'FILES';
      if (value.includes('DIAG')) return 'DIAGNOSTICS';
      return '';
    }).filter(Boolean);
    return Array.from(new Set(normalized)).slice(0, 4);
  }

  private async handlePairByCode(sender: ClientConnection, message: any, payload: Record<string, any>): Promise<void> {
    if (!['CONTROLLER', 'WINDOWS', 'BROWSER'].includes(sender.type)) {
      this.send(sender, { type: 'PAIR_ERROR', errorCode: 'INVALID_REQUEST', error: 'Only a controller can submit a pairing code.', protocolVersion: 1 });
      return;
    }

    const rawCode = message.code || message.pairingCode || payload.code || payload.pairingCode;
    const code = String(rawCode || '').replace(/[^0-9]/g, '');
    const fingerprint = sender.fingerprint;
    const name = String(message.operatorName || message.controllerName || payload.operatorName || payload.controllerName || 'Remote Controller').slice(0, 80);
    if (!/^\d{6}$/.test(code) || fingerprint.length < 8 || fingerprint.length > 256) {
      this.send(sender, { type: 'PAIR_ERROR', errorCode: 'INVALID_REQUEST', error: 'A valid six-digit code and controller identity are required.', protocolVersion: 1 });
      return;
    }

    if (
      !await AuthService.checkRateLimit(`pair-ip:${sender.remoteAddress}`, 12, 60_000) ||
      !await AuthService.checkRateLimit(`pair-fp:${fingerprint}`, 5, 60_000)
    ) {
      this.send(sender, { type: 'PAIR_ERROR', errorCode: 'RATE_LIMITED', error: 'Too many pairing attempts. Try again later.', protocolVersion: 1 });
      return;
    }

    const requestId = crypto.randomUUID();
    const pending = await DeviceService.createPairingRequest({
      requestId,
      code,
      controllerId: sender.id,
      controllerFingerprint: fingerprint,
      controllerName: name,
      requestedScopes: this.requestedScopes(message, payload),
    });

    await this.sendToEntity(pending.receiverId, {
      type: 'PAIR_REQUEST',
      requestId: pending.requestId,
      sender: sender.id,
      senderId: sender.id,
      controllerId: sender.id,
      operatorName: pending.controllerName,
      operatorLocation: 'Remote device',
      fingerprint,
      requestedScopes: pending.requestedScopes,
      timestamp: Date.now(),
      expiresAt: pending.expiresAt,
      protocolVersion: 1,
    });
    this.send(sender, {
      type: 'PAIR_PENDING',
      requestId: pending.requestId,
      targetDeviceId: pending.receiverId,
      expiresAt: pending.expiresAt,
      status: 'WAITING_FOR_OWNER_APPROVAL',
      protocolVersion: 1,
    });
  }

  private async handlePairDecision(sender: ClientConnection, message: any, payload: Record<string, any>): Promise<void> {
    if (sender.type !== 'RECEIVER' && sender.type !== 'ANDROID') {
      this.send(sender, { type: 'PAIR_ERROR', errorCode: 'NOT_SESSION_PARTICIPANT', error: 'Only the authenticated receiver may approve or reject pairing.', protocolVersion: 1 });
      return;
    }

    const requestId = String(message.requestId || payload.requestId || '');
    const request = await DeviceService.getPairingRequest(requestId);
    if (!request || request.receiverId !== sender.id || request.expiresAt <= Date.now()) {
      this.send(sender, { type: 'PAIR_ERROR', errorCode: 'PAIRING_REQUEST_EXPIRED', error: 'Pairing request is invalid or expired.', protocolVersion: 1 });
      return;
    }
    if (!await DeviceService.isEntityOnline(request.controllerId)) {
      this.send(sender, { type: 'PAIR_ERROR', errorCode: 'CONTROLLER_DISCONNECTED', error: 'Controller disconnected before approval.', protocolVersion: 1 });
      return;
    }

    if (message.type === 'PAIR_REJECT') {
      const rejected = await DeviceService.rejectPairingRequest(requestId, sender.id);
      if (!rejected) {
        this.send(sender, { type: 'PAIR_ERROR', errorCode: 'PAIRING_REQUEST_EXPIRED', error: 'Pairing request has already been decided.', protocolVersion: 1 });
        return;
      }
      await this.sendToEntity(request.controllerId, {
        type: 'PAIR_REJECT',
        requestId,
        sender: sender.id,
        reason: 'The receiver owner rejected the request.',
        protocolVersion: 1,
      });
      return;
    }

    const sessionId = crypto.randomUUID();
    const result = await DeviceService.approvePairingRequest(requestId, sender.id, sessionId);
    const controllerToken = AuthService.generateSessionToken({
      entityId: result.session.controllerId,
      entityType: 'OPERATOR',
      fingerprint: result.session.operatorFingerprint,
      sessionId,
    }, '30m');
    const receiverToken = AuthService.generateSessionToken({
      entityId: sender.id,
      entityType: 'DEVICE',
      fingerprint: result.session.receiverFingerprint,
      sessionId,
    }, '30m');

    await this.sendToEntity(result.request.controllerId, {
      type: 'PAIR_ACCEPT',
      requestId,
      sender: sender.id,
      sessionId,
      sessionToken: controllerToken,
      tokenExpiresAt: result.session.expiresAt,
      receiverName: result.request.receiverName,
      fingerprint: result.session.receiverFingerprint,
      status: 'APPROVED',
      protocolVersion: 1,
    });
    this.send(sender, {
      type: 'PAIR_SESSION_AUTHORIZED',
      requestId,
      sender: result.request.controllerId,
      sessionId,
      sessionToken: receiverToken,
      tokenExpiresAt: result.session.expiresAt,
      controllerName: result.request.controllerName,
      controllerFingerprint: result.request.controllerFingerprint,
      status: 'APPROVED',
      protocolVersion: 1,
    });
  }

  private async authorizeSessionMessage(
    sender: ClientConnection,
    message: any
  ): Promise<{ sessionId: string; peerId: string; entityId: string } | null> {
    const token = typeof message.sessionToken === 'string' ? message.sessionToken : '';
    const auth = token ? AuthService.verifySessionToken(token) : null;
    if (
      !auth?.sessionId ||
      auth.entityId !== sender.id ||
      auth.fingerprint !== sender.fingerprint
    ) {
      this.send(sender, { type: 'SESSION_ERROR', errorCode: 'NOT_SESSION_PARTICIPANT', error: 'Missing or invalid session authorization.', protocolVersion: 1 });
      return null;
    }

    if (!await DeviceService.isSessionParticipant(auth.sessionId, sender.id, sender.fingerprint)) {
      this.send(sender, { type: 'SESSION_ERROR', errorCode: 'SESSION_REVOKED', error: 'Session is expired or has been revoked.', protocolVersion: 1 });
      return null;
    }

    const peerId = await DeviceService.getSessionPeer(auth.sessionId, sender.id);
    if (!peerId) {
      this.send(sender, { type: 'SESSION_ERROR', errorCode: 'NOT_SESSION_PARTICIPANT', error: 'Sender is not part of this session.', protocolVersion: 1 });
      return null;
    }

    const requestedTarget = message.recipient || message.targetDeviceId || this.payloadObject(message).targetDeviceId;
    if (requestedTarget && requestedTarget !== peerId) {
      this.send(sender, { type: 'SESSION_ERROR', errorCode: 'NOT_SESSION_PARTICIPANT', error: 'Message target is not part of this session.', protocolVersion: 1 });
      return null;
    }

    const type = String(message.type || '');
    const scope = EVENT_SCOPE[type];
    if (scope === undefined) {
      this.send(sender, { type: 'SESSION_ERROR', errorCode: 'INVALID_REQUEST', error: 'Unsupported signaling event.', protocolVersion: 1 });
      return null;
    }
    if (scope && !await DeviceService.hasSessionScope(auth.sessionId, sender.id, scope)) {
      this.send(sender, { type: 'SESSION_ERROR', errorCode: 'SCOPE_DENIED', error: 'The session does not grant this operation.', protocolVersion: 1 });
      return null;
    }
    return { sessionId: auth.sessionId, peerId, entityId: sender.id };
  }

  private async handleMessage(sender: ClientConnection, message: any): Promise<void> {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.send(sender, { type: 'SIGNALING_ERROR', errorCode: 'INVALID_REQUEST', error: 'Message must be a JSON object.', protocolVersion: 1 });
      return;
    }
    if (message.protocolVersion !== undefined && message.protocolVersion !== 1) {
      sender.ws.close(1002, 'Unsupported Mahi protocol version');
      return;
    }

    const type = String(message.type || '');
    const payload = this.payloadObject(message);

    if (type === 'PING') {
      if (sender.deviceAuth && !await DeviceService.isSessionParticipant('', sender.id, sender.fingerprint)) {
        // Device presence remains independent of an active remote session.
        await DeviceService.heartbeatDevice(sender.id, sender.instanceId);
      }
      this.send(sender, { type: 'PONG', timestamp: Date.now(), protocolVersion: 1 });
      return;
    }

    if (type === 'REGISTER') {
      if (sender.type === 'RECEIVER' || sender.type === 'ANDROID') {
        if (!sender.deviceAuth) {
          this.send(sender, { type: 'SESSION_ERROR', errorCode: 'DEVICE_REVOKED', error: 'Device authentication is required.', protocolVersion: 1 });
          return;
        }
        await DeviceService.heartbeatDevice(sender.id, sender.instanceId);
      }
      this.send(sender, { type: 'REGISTER_ACK', status: 'OK', deviceId: sender.id, protocolVersion: 1 });
      return;
    }

    if (type === 'REGISTER_PAIRING_CODE') {
      if (!sender.deviceAuth || (sender.type !== 'RECEIVER' && sender.type !== 'ANDROID')) {
        this.send(sender, { type: 'PAIR_ERROR', errorCode: 'DEVICE_REVOKED', error: 'Only an authenticated receiver can register a pairing code.', protocolVersion: 1 });
        return;
      }
      const code = String(message.code || message.pairingCode || payload.code || '').replace(/[^0-9]/g, '');
      const expiresAt = Number(message.expiresAtMs || message.expiresAt || payload.expiresAtMs || payload.expiresAt || (Date.now() + 5 * 60 * 1000));
      if (!/^\d{6}$/.test(code) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        this.send(sender, { type: 'PAIR_ERROR', errorCode: 'INVALID_REQUEST', error: 'Invalid pairing-code registration.', protocolVersion: 1 });
        return;
      }
      if (!await AuthService.checkRateLimit(`code-register:${sender.id}`, 12, 60_000)) {
        this.send(sender, { type: 'PAIR_ERROR', errorCode: 'RATE_LIMITED', error: 'Pairing code regeneration is temporarily rate limited.', protocolVersion: 1 });
        return;
      }
      await DeviceService.storePairingCode(sender.id, code, expiresAt);
      this.send(sender, {
        type: 'CODE_REGISTERED_ACK',
        status: 'OK',
        expiresAtMs: Math.min(expiresAt, Date.now() + 5 * 60 * 1000),
        protocolVersion: 1,
      });
      return;
    }

    if (type === 'PAIR_BY_CODE' || type === 'PAIR_CODE_CONNECT') {
      await this.handlePairByCode(sender, message, payload);
      return;
    }

    if (type === 'PAIR_ACCEPT' || type === 'PAIR_REJECT') {
      await this.handlePairDecision(sender, message, payload);
      return;
    }

    if (PUBLIC_EVENTS.has(type)) return;

    const authorization = await this.authorizeSessionMessage(sender, message);
    if (!authorization) return;

    if (type === 'EMERGENCY_DISCONNECT') {
      const ended = await DeviceService.endSession(authorization.sessionId, 'Emergency disconnect');
      const participants = await DeviceService.getSessionParticipants(authorization.sessionId);
      if (ended) {
        await Promise.all(participants.map((participant) => this.sendToEntity(participant.participantId, {
          type: 'SESSION_ENDED',
          sessionId: authorization.sessionId,
          reason: 'A session participant stopped the remote session.',
          protocolVersion: 1,
        })));
      }
      return;
    }

    await this.sendToEntity(authorization.peerId, {
      ...message,
      sender: sender.id,
      senderId: sender.id,
      sessionId: authorization.sessionId,
      protocolVersion: 1,
    });
  }

  public async close(): Promise<void> {
    clearInterval(this.heartbeatTimer);
    clearInterval(this.maintenanceTimer);
    const clients = Array.from(this.clients.values());
    this.clients.clear();
    await Promise.all(clients.map(async (client) => {
      try {
        client.ws.close(1001, 'Server shutting down');
        await DeviceService.setConnectionOffline(client.id, client.instanceId);
        if (client.deviceAuth && (client.type === 'RECEIVER' || client.type === 'ANDROID')) {
          await DeviceService.setDeviceOffline(client.id, client.instanceId);
        }
      } catch {
        client.ws.terminate();
      }
    }));
  }
}
