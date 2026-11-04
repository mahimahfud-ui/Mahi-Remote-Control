import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || Buffer.byteLength(JWT_SECRET, 'utf8') < 32) {
  throw new Error('JWT_SECRET must be configured with at least 32 bytes. Refusing to start with an insecure fallback secret.');
}

export interface AuthContext {
  entityId: string;
  entityType: 'DEVICE' | 'OPERATOR';
  fingerprint: string;
  sessionId?: string;
}

export class AuthService {
  private static rateLimitMap = new Map<string, { count: number; resetAt: number }>();

  public static generateSessionToken(ctx: AuthContext, expiresIn = '30m'): string {
    if (!ctx.sessionId) {
      throw new Error('A backend-issued sessionId is required before issuing a session token.');
    }
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

  public static checkRateLimit(ipOrId: string, maxRequests = 60, windowMs = 60000): boolean {
    const now = Date.now();
    const entry = this.rateLimitMap.get(ipOrId);

    if (!entry || now > entry.resetAt) {
      this.rateLimitMap.set(ipOrId, { count: 1, resetAt: now + windowMs });
      return true;
    }

    if (entry.count >= maxRequests) {
      return false;
    }

    entry.count++;
    return true;
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
