import crypto from 'crypto';
import jwt, { JwtPayload } from 'jsonwebtoken';

export type SessionRole = 'DEVICE' | 'OPERATOR';

export interface AuthContext {
  entityId: string;
  entityType: SessionRole;
  fingerprint: string;
  sessionId?: string;
  peerId?: string;
}

function jwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET is required and must contain at least 32 characters.');
  }
  return secret;
}

export class AuthService {
  private static rateLimitMap = new Map<string, { count: number; resetAt: number }>();

  public static generateSessionToken(ctx: AuthContext, expiresIn: string | number = '30m'): string {
    if (!ctx.sessionId || !ctx.peerId || !ctx.entityId || !ctx.fingerprint) {
      throw new Error('Session-bound token claims are required.');
    }
    return jwt.sign(
      {
        sub: ctx.entityId,
        type: ctx.entityType,
        fp: ctx.fingerprint,
        sid: ctx.sessionId,
        peer: ctx.peerId,
      },
      jwtSecret(),
      { algorithm: 'HS256', expiresIn: expiresIn as any }
    );
  }

  public static verifySessionToken(token: string): AuthContext | null {
    try {
      const decoded = jwt.verify(token, jwtSecret(), { algorithms: ['HS256'] }) as JwtPayload;
      if (
        typeof decoded.sub !== 'string' ||
        typeof decoded.fp !== 'string' ||
        typeof decoded.sid !== 'string' ||
        typeof decoded.peer !== 'string' ||
        (decoded.type !== 'DEVICE' && decoded.type !== 'OPERATOR')
      ) return null;

      return {
        entityId: decoded.sub,
        entityType: decoded.type,
        fingerprint: decoded.fp,
        sessionId: decoded.sid,
        peerId: decoded.peer,
      };
    } catch {
      return null;
    }
  }

  public static createTurnCredentials(identity: string, ttlSeconds = 3600): {
    username: string;
    credential: string;
    expiresAt: number;
  } {
    const secret = process.env.TURN_SECRET;
    if (!secret || secret.length < 32) {
      throw new Error('TURN_SECRET is not configured with a sufficiently strong secret.');
    }
    const expiresAt = Math.floor(Date.now() / 1000) + Math.min(Math.max(ttlSeconds, 60), 3600);
    const username = \${expiresAt}:\${identity};
    const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
    return { username, credential, expiresAt };
  }

  public static checkRateLimit(key: string, maxRequests = 5, windowMs = 60000): boolean {
    const now = Date.now();
    const entry = this.rateLimitMap.get(key);
    if (!entry || now >= entry.resetAt) {
      this.rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (entry.count >= maxRequests) return false;
    entry.count += 1;
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
