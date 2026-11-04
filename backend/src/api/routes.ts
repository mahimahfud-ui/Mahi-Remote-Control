import crypto from 'crypto';
import { Router, Request, Response } from 'express';
import { DeviceService } from '../device-management/DeviceService';
import { AuthService } from '../authentication/AuthService';

export const apiRouter = Router();

function getPublicConfig() {
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
    // A malformed or missing public URL is intentionally reported as unconfigured.
  }

  return {
    browserAccessConfigured: Boolean(publicBaseUrl),
    publicBaseUrl,
    browserAccessUrl,
    signalingUrl,
    turnConfigured: Boolean(process.env.TURN_SERVER_URL && process.env.TURN_SHARED_SECRET),
    iceServers: [{ urls: process.env.STUN_SERVER_URL || 'stun:stun.l.google.com:19302' }],
    sessionTtlSeconds: 1800,
  };
}

function getTurnIceServer(): Record<string, unknown> | null {
  const turnUrl = process.env.TURN_SERVER_URL;
  const turnSecret = process.env.TURN_SHARED_SECRET;
  if (!turnUrl || !turnSecret) return null;
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  const username = `${expiresAt}:mahi-remote`;
  const credential = crypto.createHmac('sha1', turnSecret).update(username).digest('base64');
  return { urls: turnUrl, username, credential };
}

apiRouter.get('/config', (_req: Request, res: Response) => {
  // Public endpoint: never expose TURN credentials before an approved session.
  return res.json(getPublicConfig());
});

apiRouter.get('/turn-credentials', (req: Request, res: Response) => {
  const bearer = req.header('Authorization') || '';
  const token = bearer.startsWith('Bearer ') ? bearer.slice(7) : '';
  const auth = token ? AuthService.verifySessionToken(token) : null;
  if (
    !auth?.sessionId ||
    !DeviceService.isSessionParticipant(auth.sessionId, auth.entityId, auth.fingerprint)
  ) {
    return res.status(401).json({ error: 'An active approved session is required for TURN credentials.' });
  }

  const turnServer = getTurnIceServer();
  if (!turnServer) {
    return res.status(503).json({ error: 'TURN relay is not configured on this backend.' });
  }

  return res.json({
    iceServers: [
      { urls: process.env.STUN_SERVER_URL || 'stun:stun.l.google.com:19302' },
      turnServer,
    ],
    expiresInSeconds: 3600,
  });
});

apiRouter.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    service: 'Mahi Remote Cloud Signaling & Auth',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

apiRouter.get('/devices', (req: Request, res: Response) => {
  const devices = DeviceService.listDevices();
  res.json({ devices });
});

// Pairing codes are registered over an identified WebSocket connection.
// This unauthenticated legacy endpoint is deliberately disabled.
apiRouter.post('/pair/register-code', (_req: Request, res: Response) => {
  return res.status(410).json({ error: 'Use the authenticated WebSocket pairing registration flow.' });
});

// Never issue a session token merely because a six-digit code is valid.
// The receiver must approve the pending WebSocket request first.
apiRouter.post('/pair/verify', (_req: Request, res: Response) => {
  return res.status(410).json({ error: 'Direct code verification is disabled. Request pairing over WebSocket and wait for receiver approval.' });
});

apiRouter.post('/sessions/:id/terminate', (req: Request, res: Response) => {
  const { id } = req.params;
  const bearer = req.header('Authorization') || '';
  const token = bearer.startsWith('Bearer ') ? bearer.slice(7) : '';
  const auth = token ? AuthService.verifySessionToken(token) : null;
  if (!auth?.sessionId || auth.sessionId !== id ||
      !DeviceService.isSessionParticipant(id, auth.entityId, auth.fingerprint)) {
    return res.status(401).json({ error: 'A valid participant session token is required.' });
  }
  const ended = DeviceService.endSession(id);
  if (!ended) return res.status(404).json({ error: 'Session not found or already ended.' });
  return res.json({ success: true, message: 'Session terminated' });
});
