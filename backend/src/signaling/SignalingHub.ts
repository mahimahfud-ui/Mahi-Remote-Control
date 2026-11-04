import crypto from 'crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { AuthService } from '../authentication/AuthService';
import { DeviceService } from '../device-management/DeviceService';

type ClientType = 'ANDROID' | 'WINDOWS' | 'CONTROLLER' | 'RECEIVER' | 'BROWSER';

interface ClientConnection {
  ws: WebSocket;
  id: string;
  type: ClientType;
  fingerprint: string;
  remoteAddress: string;
}

interface PendingPairingRequest {
  requestId: string;
  code: string;
  controllerId: string;
  receiverId: string;
  controllerFingerprint: string;
  controllerName: string;
  requestedScopes: string[];
  expiresAt: number;
}

const PAIRING_REQUEST_TTL_MS = 2 * 60 * 1000;
const SESSION_TTL_MS = 30 * 60 * 1000;
const PUBLIC_MESSAGE_TYPES = new Set([
  'PING',
  'REGISTER',
  'REGISTER_PAIRING_CODE',
  'PAIR_BY_CODE',
  'PAIR_CODE_CONNECT',
  'PAIR_ACCEPT',
  'PAIR_REJECT',
]);

export class SignalingHub {
  private clients = new Map<string, ClientConnection>();
  private pendingRequests = new Map<string, PendingPairingRequest>();
  private pendingByReceiver = new Map<string, string>();

  constructor(private wss: WebSocketServer) {
    this.init();
  }

  private init(): void {
    this.wss.on('connection', (ws: WebSocket, req) => {
      const deviceId = req.headers['x-device-id'] as string | undefined;
      const operatorFp = req.headers['x-operator-fingerprint'] as string | undefined;
      const clientRole = (req.headers['x-client-role'] as string | undefined)?.toUpperCase();

      let clientId: string;
      let clientType: ClientType;
      if (deviceId) {
        clientId = deviceId;
        clientType = clientRole === 'CONTROLLER' ? 'CONTROLLER' : 'RECEIVER';
        DeviceService.registerDevice(
          deviceId,
          (req.headers['x-device-name'] as string) || 'Android Phone',
          (req.headers['x-device-fingerprint'] as string) || 'UNKNOWN'
        );
      } else if (operatorFp) {
        clientId = `operator_${crypto.randomUUID()}`;
        clientType = 'WINDOWS';
      } else {
        // Browser identity is completed by its first PAIR_BY_CODE message.
        clientId = `browser_${crypto.randomUUID()}`;
        clientType = 'BROWSER';
      }

      const client: ClientConnection = {
        ws,
        id: clientId,
        type: clientType,
        fingerprint: (req.headers['x-device-fingerprint'] || operatorFp || '') as string,
        remoteAddress: req.socket.remoteAddress || 'unknown',
      };
      this.clients.set(clientId, client);

      ws.on('message', (data: string) => {
        try {
          const parsed = JSON.parse(data.toString());
          this.handleMessage(client, parsed);
        } catch {
          this.send(client, { type: 'SIGNALING_ERROR', error: 'Invalid JSON message.' });
        }
      });

      ws.on('close', () => {
        this.clients.delete(clientId);
        for (const [requestId, pending] of this.pendingRequests.entries()) {
          if (pending.controllerId === clientId || pending.receiverId === clientId) {
            this.clearPending(requestId);
            const otherId = pending.controllerId === clientId ? pending.receiverId : pending.controllerId;
            const other = this.clients.get(otherId);
            if (other) this.send(other, { type: 'PAIR_ERROR', error: 'The other device disconnected before approval.' });
          }
        }
      });
    });
  }

  private send(client: ClientConnection, payload: Record<string, unknown>): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(payload));
    }
  }

  private clearPending(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return;
    this.pendingRequests.delete(requestId);
    if (this.pendingByReceiver.get(pending.receiverId) === requestId) {
      this.pendingByReceiver.delete(pending.receiverId);
    }
  }

  private payloadObject(msg: any): Record<string, any> {
    return msg.payload && typeof msg.payload === 'object' && !Array.isArray(msg.payload)
      ? msg.payload
      : {};
  }

  private handlePairByCode(sender: ClientConnection, msg: any, payload: Record<string, any>): void {
    if (!['CONTROLLER', 'WINDOWS', 'BROWSER'].includes(sender.type)) {
      this.send(sender, { type: 'PAIR_ERROR', error: 'Only a controller can submit a pairing code.' });
      return;
    }
    const rawCode = msg.code || msg.pairingCode || payload.code || payload.pairingCode;
    const code = String(rawCode || '').replace(/[^0-9]/g, '');
    const fingerprint = String(sender.fingerprint || msg.fingerprint || payload.fingerprint || '');
    const name = String(msg.operatorName || msg.controllerName || payload.operatorName || payload.controllerName || 'Remote Controller');

    if (!/^\d{6}$/.test(code) || fingerprint.length < 8 || fingerprint.length > 256) {
      this.send(sender, { type: 'PAIR_ERROR', error: 'A valid six-digit code and controller fingerprint are required.' });
      return;
    }
    if (
      !AuthService.checkRateLimit(`pair-ip:${sender.remoteAddress}`, 12, 60_000) ||
      !AuthService.checkRateLimit(`pair-fp:${fingerprint}`, 5, 60_000)
    ) {
      this.send(sender, { type: 'PAIR_ERROR', error: 'Too many pairing attempts. Try again later.' });
      return;
    }
    sender.fingerprint = fingerprint;

    const record = DeviceService.getPairingCode(code);
    if (!record) {
      this.send(sender, { type: 'PAIR_ERROR', error: 'Invalid or expired pairing code.' });
      return;
    }
    const receiver = this.clients.get(record.deviceId);
    if (!receiver || (receiver.type !== 'RECEIVER' && receiver.type !== 'ANDROID')) {
      this.send(sender, { type: 'PAIR_ERROR', error: 'Receiver is offline or unavailable.' });
      return;
    }

    const oldRequestId = this.pendingByReceiver.get(receiver.id);
    if (oldRequestId) {
      const old = this.pendingRequests.get(oldRequestId);
      if (old && old.expiresAt > Date.now()) {
        this.send(sender, { type: 'PAIR_ERROR', error: 'This receiver already has a pending connection request.' });
        return;
      }
      this.clearPending(oldRequestId);
    }

    const requestId = crypto.randomUUID();
    const pending: PendingPairingRequest = {
      requestId,
      code,
      controllerId: sender.id,
      receiverId: receiver.id,
      controllerFingerprint: fingerprint,
      controllerName: name.slice(0, 80),
      requestedScopes: Array.isArray(msg.requestedScopes || payload.requestedScopes)
        ? (msg.requestedScopes || payload.requestedScopes).filter((scope: unknown) => typeof scope === 'string').slice(0, 12)
        : ['Screen Mirroring', 'Remote Interaction'],
      expiresAt: Math.min(record.expiresAt, Date.now() + PAIRING_REQUEST_TTL_MS),
    };
    this.pendingRequests.set(requestId, pending);
    this.pendingByReceiver.set(receiver.id, requestId);

    this.send(receiver, {
      type: 'PAIR_REQUEST',
      requestId,
      sender: sender.id,
      senderId: sender.id,
      controllerId: sender.id,
      operatorName: pending.controllerName,
      operatorLocation: 'Remote device',
      fingerprint,
      requestedScopes: pending.requestedScopes,
      timestamp: Date.now(),
      expiresAt: pending.expiresAt,
    });
    this.send(sender, {
      type: 'PAIR_PENDING',
      requestId,
      targetDeviceId: receiver.id,
      expiresAt: pending.expiresAt,
      status: 'WAITING_FOR_OWNER_APPROVAL',
    });
  }

  private handlePairDecision(sender: ClientConnection, msg: any, payload: Record<string, any>): void {
    const requestId = String(msg.requestId || payload.requestId || '');
    const pending = this.pendingRequests.get(requestId);
    if (!pending || pending.receiverId !== sender.id || pending.expiresAt <= Date.now()) {
      if (pending) this.clearPending(requestId);
      this.send(sender, { type: 'PAIR_ERROR', error: 'Pairing request is invalid or expired.' });
      return;
    }

    const controller = this.clients.get(pending.controllerId);
    if (!controller) {
      this.clearPending(requestId);
      this.send(sender, { type: 'PAIR_ERROR', error: 'Controller disconnected before approval.' });
      return;
    }

    if (msg.type === 'PAIR_REJECT') {
      this.clearPending(requestId);
      this.send(controller, {
        type: 'PAIR_REJECT',
        requestId,
        sender: sender.id,
        reason: 'The receiver owner rejected the request.',
      });
      return;
    }

    // Consume the one-time code only after the receiver has explicitly approved.
    const consumedDeviceId = DeviceService.validateAndConsumePairingCode(pending.code);
    if (consumedDeviceId !== sender.id) {
      this.clearPending(requestId);
      this.send(controller, { type: 'PAIR_ERROR', error: 'Pairing code expired or was consumed.' });
      this.send(sender, { type: 'PAIR_ERROR', error: 'Pairing code expired or was consumed.' });
      return;
    }

    const sessionId = crypto.randomUUID();
    const controllerToken = AuthService.generateSessionToken({
      entityId: controller.id,
      entityType: controller.type === 'WINDOWS' ? 'OPERATOR' : 'DEVICE',
      fingerprint: pending.controllerFingerprint,
      sessionId,
    }, '30m');
    const receiverToken = AuthService.generateSessionToken({
      entityId: sender.id,
      entityType: 'DEVICE',
      fingerprint: sender.fingerprint,
      sessionId,
    }, '30m');

    DeviceService.startSession(
      sessionId,
      sender.id,
      pending.controllerFingerprint,
      controller.id,
      sender.fingerprint
    );
    this.clearPending(requestId);

    const receiverInfo = DeviceService.getDevice(sender.id);
    this.send(controller, {
      type: 'PAIR_ACCEPT',
      requestId,
      sender: sender.id,
      sessionId,
      sessionToken: controllerToken,
      tokenExpiresAt: Date.now() + SESSION_TTL_MS,
      receiverName: receiverInfo?.deviceName || 'Android Receiver',
      fingerprint: sender.fingerprint,
      status: 'APPROVED',
    });
    this.send(sender, {
      type: 'PAIR_SESSION_AUTHORIZED',
      requestId,
      sender: controller.id,
      sessionId,
      sessionToken: receiverToken,
      tokenExpiresAt: Date.now() + SESSION_TTL_MS,
      controllerName: pending.controllerName,
      controllerFingerprint: pending.controllerFingerprint,
      status: 'APPROVED',
    });
  }

  private authorizeSessionMessage(sender: ClientConnection, msg: any): { sessionId: string; peerId: string } | null {
    const token = typeof msg.sessionToken === 'string' ? msg.sessionToken : '';
    const auth = token ? AuthService.verifySessionToken(token) : null;
    if (!auth?.sessionId || auth.entityId !== sender.id || auth.fingerprint !== sender.fingerprint) {
      this.send(sender, { type: 'SESSION_ERROR', error: 'Missing or invalid session authorization.' });
      return null;
    }
    if (!DeviceService.isSessionParticipant(auth.sessionId, sender.id, sender.fingerprint)) {
      this.send(sender, { type: 'SESSION_ERROR', error: 'Session is expired or has been revoked.' });
      return null;
    }
    const peerId = DeviceService.getSessionPeer(auth.sessionId, sender.id);
    if (!peerId) {
      this.send(sender, { type: 'SESSION_ERROR', error: 'Sender is not part of this session.' });
      return null;
    }
    const requestedTarget = msg.recipient || msg.targetDeviceId || this.payloadObject(msg).targetDeviceId;
    if (requestedTarget && requestedTarget !== peerId) {
      this.send(sender, { type: 'SESSION_ERROR', error: 'Message target is not part of this session.' });
      return null;
    }
    return { sessionId: auth.sessionId, peerId };
  }

  private handleMessage(sender: ClientConnection, msg: any): void {
    const type = String(msg.type || '');
    const payload = this.payloadObject(msg);

    if (type === 'PING') {
      this.send(sender, { type: 'PONG', timestamp: Date.now() });
      return;
    }
    if (type === 'REGISTER') {
      this.send(sender, { type: 'REGISTER_ACK', status: 'OK', deviceId: sender.id });
      return;
    }
    if (type === 'REGISTER_PAIRING_CODE') {
      if (!['RECEIVER', 'ANDROID'].includes(sender.type)) {
        this.send(sender, { type: 'PAIR_ERROR', error: 'Only a receiver can register a pairing code.' });
        return;
      }
      const code = String(msg.code || msg.pairingCode || payload.code || '').replace(/[^0-9]/g, '');
      const expiresAt = Number(msg.expiresAt || payload.expiresAt || (Date.now() + 5 * 60 * 1000));
      if (!/^\d{6}$/.test(code) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        this.send(sender, { type: 'PAIR_ERROR', error: 'Invalid pairing-code registration.' });
        return;
      }
      if (!AuthService.checkRateLimit(`code-register:${sender.id}`, 12, 60_000)) {
        this.send(sender, { type: 'PAIR_ERROR', error: 'Pairing code regeneration is temporarily rate limited.' });
        return;
      }
      DeviceService.storePairingCode(sender.id, code, Math.min(expiresAt, Date.now() + 5 * 60 * 1000));
      this.send(sender, { type: 'CODE_REGISTERED_ACK', code });
      return;
    }
    if (type === 'PAIR_BY_CODE' || type === 'PAIR_CODE_CONNECT') {
      this.handlePairByCode(sender, msg, payload);
      return;
    }
    if (type === 'PAIR_ACCEPT' || type === 'PAIR_REJECT') {
      this.handlePairDecision(sender, msg, payload);
      return;
    }
    if (PUBLIC_MESSAGE_TYPES.has(type)) return;

    const authorization = this.authorizeSessionMessage(sender, msg);
    if (!authorization) return;
    const target = this.clients.get(authorization.peerId);

    if (type === 'EMERGENCY_DISCONNECT') {
      if (target) {
        this.send(target, { type: 'EMERGENCY_DISCONNECT', sender: sender.id, sessionId: authorization.sessionId });
        this.send(target, { type: 'SESSION_ENDED', sessionId: authorization.sessionId });
      }
      this.send(sender, { type: 'SESSION_ENDED', sessionId: authorization.sessionId });
      DeviceService.endSession(authorization.sessionId);
      return;
    }

    if (!target) {
      this.send(sender, { type: 'SESSION_ERROR', error: 'The other session participant is offline.' });
      return;
    }

    this.send(target, { ...msg, sender: sender.id, senderId: sender.id });
  }
}
