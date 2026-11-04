import { Router, Request, Response } from 'express';
import { DeviceService } from '../device-management/DeviceService';
import { AuthService } from '../authentication/AuthService';

export const apiRouter = Router();

function bearerToken(req: Request): string {
  const value = String(req.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7) : '';
}

function activeSessionContext(req: Request) {
  const auth = AuthService.verifySessionToken(bearerToken(req));
  if (!auth?.sessionId || !auth.peerId) return null;
  if (!DeviceService.isSessionParticipant(auth.sessionId, auth.entityId, auth.peerId)) return null;
  return auth;
}

apiRouter.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    service: 'Mahi Remote Cloud Signaling & Auth',
    version: '1.1.0',
    publicAccessConfigured: /^https:\/\//i.test(process.env.PUBLIC_BASE_URL || ''),
    turnConfigured: !!(process.env.TURN_URL && process.env.TURN_SECRET),
    timestamp: new Date().toISOString(),
  });
});

apiRouter.get('/config', (_req: Request, res: Response) => {
  const base = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  const validPublicBase = /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(base);
  if (!validPublicBase) {
    return res.json({
      publicAccessConfigured: false,
      browserUrl: null,
      signalingUrl: null,
      message: 'Set PUBLIC_BASE_URL to the deployed HTTPS origin to enable browser access.',
    });
  }
  return res.json({
    publicAccessConfigured: true,
    browserUrl: base + '/connect',
    signalingUrl: base.replace(/^https:/i, 'wss:') + '/ws',
    turnConfigured: !!(process.env.TURN_URL && process.env.TURN_SECRET),
  });
});

apiRouter.get('/devices', (_req: Request, res: Response) => {
  // Device inventory contains private presence information; it is not a public endpoint.
  return res.status(401).json({ error: 'Device inventory is not publicly accessible.' });
});

apiRouter.post('/pair/register-code', (_req: Request, res: Response) => {
  return res.status(410).json({
    error: 'This legacy endpoint is disabled. Register receiver pairing codes over the authenticated WebSocket connection.',
  });
});

apiRouter.post('/pair/verify', (_req: Request, res: Response) => {
  return res.status(410).json({
    error: 'Pairing verification without receiver approval is disabled. Use the WebSocket pairing and owner-approval flow.',
  });
});

apiRouter.post('/turn/credentials', async (req: Request, res: Response) => {
  const auth = activeSessionContext(req);
  if (!auth) return res.status(401).json({ error: 'A valid owner-approved session token is required.' });

  // Prefer Cloudflare's managed TURN service when a server-side key is configured.
  // The long-lived key and API token are never returned to the app or browser.
  const cloudflareKeyId = String(process.env.CLOUDFLARE_TURN_KEY_ID || '').trim();
  const cloudflareApiToken = String(process.env.CLOUDFLARE_TURN_API_TOKEN || '').trim();
  if (cloudflareKeyId && cloudflareApiToken) {
    try {
      const upstream = await fetch(
        'https://rtc.live.cloudflare.com/v1/turn/keys/' +
          encodeURIComponent(cloudflareKeyId) +
          '/credentials/generate-ice-servers',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + cloudflareApiToken,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ ttl: 3600 }),
        }
      );
      if (!upstream.ok) {
        return res.status(503).json({ error: 'Managed TURN credentials could not be issued. Check the server-side TURN key configuration.' });
      }
      const payload = await upstream.json() as { iceServers?: unknown };
      if (!Array.isArray(payload.iceServers) || payload.iceServers.length === 0) {
        return res.status(503).json({ error: 'Managed TURN returned no ICE servers.' });
      }
      return res.json(payload);
    } catch {
      return res.status(503).json({ error: 'Managed TURN is temporarily unavailable.' });
    }
  }

  const urls = String(process.env.TURN_URL || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!urls.length || !process.env.TURN_SECRET) {
    return res.status(503).json({ error: 'TURN relay is not configured. Direct STUN connectivity may fail on restrictive networks.' });
  }

  try {
    const credentials = AuthService.createTurnCredentials(auth.sessionId || auth.entityId, 3600);
    const iceServers: Record<string, any>[] = [];
    if (process.env.STUN_URL) {
      iceServers.push({ urls: process.env.STUN_URL.split(',').map(value => value.trim()).filter(Boolean) });
    }
    iceServers.push({
      urls,
      username: credentials.username,
      credential: credentials.credential,
      credentialType: 'password',
    });
    return res.json({ iceServers, expiresAt: credentials.expiresAt });
  } catch {
    return res.status(503).json({ error: 'TURN credentials are temporarily unavailable.' });
  }
});

apiRouter.post('/sessions/:id/terminate', (req: Request, res: Response) => {
  const auth = activeSessionContext(req);
  if (!auth || auth.sessionId !== req.params.id) {
    return res.status(401).json({ error: 'A valid token for this session is required.' });
  }
  DeviceService.endSession(req.params.id);
  return res.json({ success: true, message: 'Session revoked. Reconnect requires a new pairing approval.' });
});
