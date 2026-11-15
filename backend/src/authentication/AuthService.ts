import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { Database } from '../database/Database';

const configuredJwtSecret = process.env.JWT_SECRET;
if (
  !configuredJwtSecret ||
  Buffer.byteLength(configuredJwtSecret, 'utf8') < 32 ||
  /replace|change[-_ ]?me|example|your[-_ ]?secret/i.test(configuredJwtSecret)
) {
  throw new Error('JWT_SECRET must be configured with at least 32 bytes. Refusing to start with an insecure fallback secret.');
}
const JWT_SECRET: string = configuredJwtSecret;

export interface AuthContext {
  entityId: string;
  entityType: 'DEVICE' | 'OPERATOR';
  fingerprint: string;
  sessionId?: string;
}

export interface DeviceAuthContext {
  deviceId: string;
  fingerprint: string;
  keyVersion: number;
}

export class AuthService {
  public static generateDeviceToken(ctx: DeviceAuthContext, expiresIn = '15m'): string {
    if (!ctx.deviceId || !ctx.fingerprint || !Number.isInteger(ctx.keyVersion) || ctx.keyVersion < 1) {
      throw new Error('A verified device identity and key version are required.');
    }
    return jwt.sign(
      {
        sub: ctx.deviceId,
        typ: 'DEVICE',
        fp: ctx.fingerprint,
        keyVersion: ctx.keyVersion,
      },
      JWT_SECRET,
      {
        expiresIn: expiresIn as any,
        algorithm: 'HS256',
        issuer: 'mahi-remote',
        audience: 'mahi-remote-device',
      }
    );
  }

  public static verifyDeviceToken(token: string): DeviceAuthContext | null {
    try {
      const decoded = jwt.verify(token, JWT_SECRET, {
        algorithms: ['HS256'],
        issuer: 'mahi-remote',
        audience: 'mahi-remote-device',
      }) as any;
      if (
        decoded.typ !== 'DEVICE' ||
        typeof decoded.sub !== 'string' ||
        typeof decoded.fp !== 'string' ||
        !Number.isInteger(decoded.keyVersion) ||
        decoded.keyVersion < 1
      ) return null;
      return {
        deviceId: decoded.sub,
        fingerprint: decoded.fp,
        keyVersion: decoded.keyVersion,
      };
    } catch {
      return null;
    }
  }

  public static generateSessionToken(ctx: AuthContext, expiresIn = '30m'): string {
    if (!ctx.sessionId) throw new Error('A backend-issued sessionId is required before issuing a session token.');
    return jwt.sign(
      {
        sub: ctx.entityId,
        type: ctx.entityType,
        fp: ctx.fingerprint,
        sid: ctx.sessionId,
      },
      JWT_SECRET,
      {
        expiresIn: expiresIn as any,
        algorithm: 'HS256',
        issuer: 'mahi-remote',
        audience: 'mahi-remote-session',
      }
    );
  }

  public static verifySessionToken(token: string): AuthContext | null {
    try {
      const decoded = jwt.verify(token, JWT_SECRET, {
        algorithms: ['HS256'],
        issuer: 'mahi-remote',
        audience: 'mahi-remote-session',
      }) as any;
      if (
        typeof decoded.sub !== 'string' ||
        !['DEVICE', 'OPERATOR'].includes(decoded.type) ||
        typeof decoded.fp !== 'string' ||
        typeof decoded.sid !== 'string'
      ) return null;
      return {
        entityId: decoded.sub,
        entityType: decoded.type,
        fingerprint: decoded.fp,
        sessionId: decoded.sid,
      };
    } catch {
      return null;
    }
  }

  public static async checkRateLimit(
    key: string,
    maxRequests = 60,
    windowMs = 60_000
  ): Promise<boolean> {
    const safeKey = String(key || '').slice(0, 512);
    if (!safeKey) return false;
    const safeMax = Math.max(1, Math.min(Math.floor(maxRequests), 100_000));
    const safeWindowMs = Math.max(1000, Math.min(Math.floor(windowMs), 86_400_000));
    const result = await Database.query(
      `INSERT INTO rate_limit_counters (bucket_key, window_started_at, request_count)
       VALUES ($1, NOW(), 1)
       ON CONFLICT (bucket_key) DO UPDATE SET
         request_count = CASE
           WHEN rate_limit_counters.window_started_at <= NOW() - ($2 * INTERVAL '1 millisecond') THEN 1
           ELSE rate_limit_counters.request_count + 1
         END,
         window_started_at = CASE
           WHEN rate_limit_counters.window_started_at <= NOW() - ($2 * INTERVAL '1 millisecond') THEN NOW()
           ELSE rate_limit_counters.window_started_at
         END,
         updated_at = NOW()
       RETURNING request_count`,
      [safeKey, safeWindowMs]
    );
    return Number(result.rows[0]?.request_count || 0) <= safeMax;
  }

  public static verifyDeviceSignature(payload: string, signature: string, publicKey: string): boolean {
    try {
      const verifier = crypto.createVerify('SHA256');
      verifier.update(payload);
      verifier.end();
      return verifier.verify(publicKey, signature, 'base64');
    } catch {
      return false;
    }
  }
}
