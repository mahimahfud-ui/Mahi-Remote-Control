import crypto from 'crypto';
import { NextFunction, Router, Request, Response } from 'express';
import { DeviceIdentityService } from '../authentication/DeviceIdentityService';
import { AuthService, DeviceAuthContext } from '../authentication/AuthService';
import { DeviceService, DeviceServiceError } from '../device-management/DeviceService';
import { Database } from '../database/Database';

export const apiRouter = Router();

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

function asyncRoute(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function requestId(req: Request): string {
  const supplied = req.header('X-Request-Id') || '';
  return /^[A-Za-z0-9_-]{8,80}$/.test(supplied) ? supplied : crypto.randomUUID();
}

function errorResponse(res: Response, status: number, code: string, message: string, id: string, retryable = false) {
  return res.status(status).json({
    protocolVersion: 1,
    error: { code, message, retryable, requestId: id },
  });
}

function requireProtocolV1(req: Request, res: Response, id: string): boolean {
  const header = req.header('X-Mahi-Protocol-Version');
  const bodyVersion = req.body?.protocolVersion;
  if (header && header !== '1') {
    errorResponse(res, 426, 'INVALID_PROTOCOL_VERSION', 'This server requires protocol version 1.', id);
    return false;
  }
  if (bodyVersion !== 1) {
    errorResponse(res, 426, 'INVALID_PROTOCOL_VERSION', 'Request body must include protocolVersion: 1.', id);
    return false;
  }
  return true;
}

function bearerToken(req: Request): string {
  const value = req.header('Authorization') || '';
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

async function authenticatedDevice(req: Request): Promise<DeviceAuthContext | null> {
  const token = bearerToken(req);
  const auth = token ? AuthService.verifyDeviceToken(token) : null;
  if (!auth) return null;
  const device = await DeviceService.getDevice(auth.deviceId);
  if (
    !device ||
    device.isRevoked ||
    device.fingerprint !== auth.fingerprint ||
    device.keyVersion !== auth.keyVersion
  ) return null;
  return auth;
}

function publicConfig() {
  const configuredBase = process.env.PUBLIC_BASE_URL || '';
  let publicBaseUrl: string | null = null;
  let signalingUrl: string | null = null;
  let browserAccessUrl: string | null = null;

  try {
    const parsed = new URL(configuredBase);
    if (parsed.protocol === 'https:') {
      publicBaseUrl = parsed.origin;
      signalingUrl = `wss://${parsed.host}/ws`;
      browserAccessUrl = `${parsed.origin}/connect`;
    }
  } catch {
    // An invalid origin is intentionally reported as unconfigured.
  }

  return {
    protocolVersion: 1,
    browserAccessConfigured: Boolean(publicBaseUrl),
    publicBaseUrl,
    browserAccessUrl,
    signalingUrl,
    turnConfigured: Boolean(process.env.TURN_SERVER_URL && process.env.TURN_SHARED_SECRET),
    iceServers: [{ urls: process.env.STUN_SERVER_URL || 'stun:stun.l.google.com:19302' }],
    sessionTtlSeconds: 1800,
    deviceChallengeTtlSeconds: 120,
  };
}

function getTurnIceServer(): Record<string, unknown> | null {
  const turnUrl = process.env.TURN_SERVER_URL;
  const turnSecret = process.env.TURN_SHARED_SECRET;
  if (!turnUrl || !turnSecret) return null;
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const username = `${expiresAt}:mahi-remote`;
  const credential = crypto.createHmac('sha1', turnSecret).update(username).digest('base64');
  return { urls: turnUrl, username, credential };
}

apiRouter.use((req, res, next) => {
  res.setHeader('X-Mahi-Protocol-Version', '1');
  res.setHeader('X-Request-Id', requestId(req));
  next();
});

apiRouter.get('/config', (_req: Request, res: Response) => {
  return res.json(publicConfig());
});

apiRouter.post('/devices/enrollment/challenges', asyncRoute(async (req, res) => {
  const id = requestId(req);
  if (!requireProtocolV1(req, res, id)) return;
  if (!await AuthService.checkRateLimit(`enroll-ip:${req.ip}`, 10, 15 * 60_000)) {
    return errorResponse(res, 429, 'RATE_LIMITED', 'Too many device enrollment attempts. Try again later.', id, true);
  }
  const result = await DeviceIdentityService.issueEnrollmentChallenge({
    deviceId: req.body.deviceId,
    deviceName: req.body.deviceName,
    publicKey: req.body.publicKey,
  });
  return res.status(201).json(result);
}));

apiRouter.post('/devices/enrollment/verify', asyncRoute(async (req, res) => {
  const id = requestId(req);
  if (!requireProtocolV1(req, res, id)) return;
  if (!await AuthService.checkRateLimit(`enroll-proof-ip:${req.ip}`, 20, 15 * 60_000)) {
    return errorResponse(res, 429, 'RATE_LIMITED', 'Too many enrollment proof attempts. Try again later.', id, true);
  }
  const enrolled = await DeviceIdentityService.verifyEnrollment(req.body.challengeId, req.body.signature);
  const token = AuthService.generateDeviceToken({
    deviceId: enrolled.deviceId,
    fingerprint: enrolled.fingerprint,
    keyVersion: enrolled.keyVersion,
  });
  return res.status(201).json({
    protocolVersion: 1,
    deviceId: enrolled.deviceId,
    fingerprint: enrolled.fingerprint,
    deviceAccessToken: token,
    tokenType: 'Bearer',
    expiresInSeconds: 900,
  });
}));

apiRouter.post('/devices/auth/challenges', asyncRoute(async (req, res) => {
  const id = requestId(req);
  if (!requireProtocolV1(req, res, id)) return;
  if (!await AuthService.checkRateLimit(`device-auth-ip:${req.ip}`, 30, 15 * 60_000)) {
    return errorResponse(res, 429, 'RATE_LIMITED', 'Too many device authentication attempts. Try again later.', id, true);
  }
  const result = await DeviceIdentityService.issueAuthenticationChallenge(String(req.body.deviceId || ''));
  return res.status(201).json(result);
}));

apiRouter.post('/devices/auth/verify', asyncRoute(async (req, res) => {
  const id = requestId(req);
  if (!requireProtocolV1(req, res, id)) return;
  const challenge = await Database.query(
    'SELECT device_id FROM device_challenges WHERE challenge_id = $1 AND purpose = \'AUTHENTICATE\'',
    [req.body.challengeId]
  );
  const deviceId = challenge.rows[0]?.device_id;
  if (!deviceId || !await AuthService.checkRateLimit(`device-auth-proof:${deviceId}`, 20, 15 * 60_000)) {
    return errorResponse(res, 429, 'RATE_LIMITED', 'Too many device proof attempts. Try again later.', id, true);
  }
  const verified = await DeviceIdentityService.verifyAuthentication(req.body.challengeId, req.body.signature);
  const token = AuthService.generateDeviceToken({
    deviceId: verified.deviceId,
    fingerprint: verified.fingerprint,
    keyVersion: verified.keyVersion,
  });
  return res.json({
    protocolVersion: 1,
    deviceId: verified.deviceId,
    fingerprint: verified.fingerprint,
    deviceAccessToken: token,
    tokenType: 'Bearer',
    expiresInSeconds: 900,
  });
}));

apiRouter.post('/devices/key-rotation/challenges', asyncRoute(async (req, res) => {
  const id = requestId(req);
  if (!requireProtocolV1(req, res, id)) return;
  const device = await authenticatedDevice(req);
  if (!device) return errorResponse(res, 401, 'DEVICE_REVOKED', 'A current enrolled device token is required.', id);
  if (!await AuthService.checkRateLimit(`device-rotate:${device.deviceId}`, 5, 60 * 60_000)) {
    return errorResponse(res, 429, 'RATE_LIMITED', 'Device key rotation is temporarily rate limited.', id, true);
  }
  const challenge = await DeviceIdentityService.issueRotationChallenge(
    device.deviceId,
    device.fingerprint,
    device.keyVersion,
    req.body.newPublicKey
  );
  return res.status(201).json(challenge);
}));

apiRouter.post('/devices/key-rotation/verify', asyncRoute(async (req, res) => {
  const id = requestId(req);
  if (!requireProtocolV1(req, res, id)) return;
  const device = await authenticatedDevice(req);
  if (!device) return errorResponse(res, 401, 'DEVICE_REVOKED', 'A current enrolled device token is required.', id);
  const rotated = await DeviceIdentityService.verifyRotation(
    req.body.challengeId,
    req.body.oldKeySignature,
    req.body.newKeySignature,
    device.deviceId,
    device.fingerprint,
    device.keyVersion
  );
  const otherParticipants = rotated.revokedSessions.filter(
    (participant) => participant.participantId !== device.deviceId
  );
  await Promise.all(otherParticipants.map(async (participant) => {
    if (!await DeviceService.isEntityOnline(participant.participantId)) return;
    await Database.publishSignal(participant.participantId, {
      type: 'SESSION_ENDED',
      sessionId: participant.sessionId,
      reason: 'A session participant rotated its device identity.',
      protocolVersion: 1,
    });
  }));
  const token = AuthService.generateDeviceToken({
    deviceId: rotated.deviceId,
    fingerprint: rotated.fingerprint,
    keyVersion: rotated.keyVersion,
  });
  return res.json({
    protocolVersion: 1,
    deviceId: rotated.deviceId,
    fingerprint: rotated.fingerprint,
    deviceAccessToken: token,
    tokenType: 'Bearer',
    expiresInSeconds: 900,
  });
}));

apiRouter.post('/devices/:deviceId/revoke', asyncRoute(async (req, res) => {
  const id = requestId(req);
  if (!requireProtocolV1(req, res, id)) return;
  const device = await authenticatedDevice(req);
  if (!device || device.deviceId !== req.params.deviceId) {
    return errorResponse(res, 403, 'DEVICE_REVOKED', 'Only the currently authenticated device may revoke its own identity.', id);
  }
  if (!await AuthService.checkRateLimit(`device-self-revoke:${device.deviceId}`, 3, 60 * 60_000)) {
    return errorResponse(res, 429, 'RATE_LIMITED', 'Device revocation is temporarily rate limited.', id, true);
  }

  const notices = await DeviceService.revokeDevice(
    device.deviceId,
    device.fingerprint,
    device.keyVersion
  );
  const otherParticipants = notices.filter((item) => item.participantId !== device.deviceId);
  await Promise.all(otherParticipants.map(async (item) => {
    if (!await DeviceService.isEntityOnline(item.participantId)) return;
    await Database.publishSignal(item.participantId, {
      type: 'SESSION_ENDED',
      sessionId: item.sessionId,
      reason: 'The receiver revoked its device identity.',
      protocolVersion: 1,
    });
  }));

  return res.json({
    protocolVersion: 1,
    success: true,
    revokedDeviceId: device.deviceId,
    endedSessionCount: Array.from(new Set(notices.map((item) => item.sessionId))).length,
  });
}));

apiRouter.get('/turn-credentials', asyncRoute(async (req, res) => {
  const id = requestId(req);
  const token = bearerToken(req);
  const auth = token ? AuthService.verifySessionToken(token) : null;
  if (
    !auth?.sessionId ||
    !await DeviceService.isSessionParticipant(auth.sessionId, auth.entityId, auth.fingerprint, auth.entityType)
  ) {
    return errorResponse(res, 401, 'SESSION_REVOKED', 'An active approved session is required for TURN credentials.', id);
  }

  const turnServer = getTurnIceServer();
  const iceServers: Array<Record<string, unknown>> = [
    { urls: process.env.STUN_SERVER_URL || 'stun:stun.l.google.com:19302' },
  ];
  if (turnServer) iceServers.push(turnServer);

  return res.json({
    protocolVersion: 1,
    iceServers,
    turnConfigured: Boolean(turnServer),
    expiresInSeconds: turnServer ? 600 : 0,
  });
}));

apiRouter.get('/health', (_req: Request, res: Response) => {
  res.json({
    protocolVersion: 1,
    status: 'healthy',
    service: 'Mahi Remote Cloud Signaling & Auth',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
  });
});

apiRouter.get('/ready', asyncRoute(async (_req, res) => {
  const ready = await Database.isReady();
  if (!ready) return res.status(503).json({ protocolVersion: 1, status: 'not-ready' });
  return res.json({ protocolVersion: 1, status: 'ready' });
}));

apiRouter.get('/devices', (_req: Request, res: Response) => {
  return res.status(410).json({
    protocolVersion: 1,
    error: { code: 'PUBLIC_DEVICE_LIST_DISABLED', message: 'Public device enumeration is disabled.', retryable: false },
  });
});

apiRouter.post('/pair/register-code', (_req: Request, res: Response) => {
  return res.status(410).json({
    protocolVersion: 1,
    error: { code: 'ENDPOINT_RETIRED', message: 'Register pairing codes through an authenticated receiver WebSocket.', retryable: false },
  });
});

apiRouter.post('/pair/verify', (_req: Request, res: Response) => {
  return res.status(410).json({
    protocolVersion: 1,
    error: { code: 'ENDPOINT_RETIRED', message: 'Pairing requires a WebSocket request and explicit receiver approval.', retryable: false },
  });
});

apiRouter.post('/sessions/:id/terminate', asyncRoute(async (req, res) => {
  const id = requestId(req);
  const token = bearerToken(req);
  const auth = token ? AuthService.verifySessionToken(token) : null;
  if (
    !auth?.sessionId ||
    auth.sessionId !== req.params.id ||
    !await DeviceService.isSessionParticipant(req.params.id, auth.entityId, auth.fingerprint, auth.entityType)
  ) {
    return errorResponse(res, 401, 'NOT_SESSION_PARTICIPANT', 'A valid participant token for this session is required.', id);
  }
  const ended = await DeviceService.endSession(req.params.id, 'Participant requested termination');
  if (!ended) return errorResponse(res, 404, 'SESSION_EXPIRED', 'Session not found or already ended.', id);
  const participants = await DeviceService.getSessionParticipants(req.params.id);
  await Promise.all(participants.map((participant) =>
    Database.publishSignal(participant.participantId, {
      type: 'SESSION_ENDED',
      sessionId: req.params.id,
      reason: 'A participant terminated the session.',
      protocolVersion: 1,
    })
  ));
  return res.json({ protocolVersion: 1, success: true });
}));

apiRouter.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  const id = requestId(req);
  if (error instanceof DeviceServiceError) {
    const status = error.code.includes('EXPIRED') || error.code.includes('USED') ||
        error.code.includes('REPLAY') || error.code.includes('ALREADY_ENROLLED') ||
        error.code.includes('ACTIVE') || error.code.includes('PENDING') ||
        error.code.includes('CONFLICT') ? 409
      : error.code.includes('NOT_FOUND') ? 404
      : error.code.includes('REVOKED') ? 403
      : error.code.includes('INVALID') || error.code.includes('SIGNATURE') ? 400
      : 400;
    return errorResponse(res, status, error.code, error.message, id, status === 409);
  }
  console.error('[api] request failed', error);
  return errorResponse(res, 500, 'INTERNAL_ERROR', 'The request could not be completed.', id, true);
});
