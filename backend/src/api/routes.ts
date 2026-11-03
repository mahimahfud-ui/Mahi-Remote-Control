import { Router, Request, Response } from 'express';
import { DeviceService } from '../device-management/DeviceService';
import { AuthService } from '../authentication/AuthService';

export const apiRouter = Router();

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

apiRouter.post('/pair/register-code', (req: Request, res: Response) => {
  const { deviceId, code, expiresAt } = req.body;
  if (!deviceId || !code) {
    return res.status(400).json({ error: 'Missing deviceId or pairing code' });
  }
  const expiry = expiresAt || (Date.now() + 5 * 60 * 1000);
  DeviceService.storePairingCode(deviceId, code, expiry);
  return res.json({ success: true, message: 'Pairing code registered', code, expiresAt: expiry });
});

apiRouter.post('/pair/verify', (req: Request, res: Response) => {
  const { code, operatorFingerprint, operatorName, operatorLocation } = req.body;
  if (!code || !operatorFingerprint) {
    return res.status(400).json({ error: 'Missing pairing parameters' });
  }

  const deviceId = DeviceService.validateAndConsumePairingCode(code);
  if (!deviceId) {
    return res.status(401).json({ error: 'Invalid or expired 6-digit pairing code' });
  }

  const token = AuthService.generateSessionToken({
    entityId: operatorFingerprint,
    entityType: 'OPERATOR',
    fingerprint: operatorFingerprint,
  });

  return res.json({
    success: true,
    deviceId,
    sessionToken: token,
    signalingUrl: 'wss://signaling.mahi-remote.cloud/ws',
  });
});

apiRouter.post('/sessions/:id/terminate', (req: Request, res: Response) => {
  const { id } = req.params;
  DeviceService.endSession(id);
  res.json({ success: true, message: `Session ${id} terminated` });
});
