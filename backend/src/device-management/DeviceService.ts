import crypto from 'crypto';

export interface RegisteredDevice {
  deviceId: string;
  deviceName: string;
  fingerprint: string;
  isOnline: boolean;
  lastSeen: number;
}

export interface PairingCodeRecord {
  codeHash: string;
  deviceId: string;
  expiresAt: number;
}

export interface PendingPairingRequest {
  requestId: string;
  receiverId: string;
  controllerId: string;
  controllerName: string;
  controllerFingerprint: string;
  requestedScopes: string[];
  createdAt: number;
  expiresAt: number;
}

export interface ActiveRemoteSession {
  sessionId: string;
  receiverId: string;
  controllerId: string;
  receiverFingerprint: string;
  controllerFingerprint: string;
  grantedScopes: string[];
  startedAt: number;
  expiresAt: number;
}

const hashCode = (code: string) =>
  crypto.createHash('sha256').update(code.replace(/\D/g, '')).digest('hex');

export class DeviceService {
  private static devices = new Map<string, RegisteredDevice>();
  private static pairingCodes = new Map<string, PairingCodeRecord>();
  private static pendingByReceiver = new Map<string, PendingPairingRequest>();
  private static activeSessions = new Map<string, ActiveRemoteSession>();
  private static readonly CODE_TTL_MAX_MS = 5 * 60 * 1000;
  private static readonly REQUEST_TTL_MS = 90 * 1000;
  private static readonly SESSION_TTL_MS = 30 * 60 * 1000;

  private static normalizeGrantedScopes(scopes: string[]): string[] {
    const aliases: Record<string, string> = {
      SCREEN: 'SCREEN_VIEW',
      SCREEN_VIEW: 'SCREEN_VIEW',
      SCREEN_MIRRORING: 'SCREEN_VIEW',
      REMOTE_SCREEN: 'SCREEN_VIEW',
      VIDEO: 'SCREEN_VIEW',
      INPUT: 'REMOTE_INPUT',
      REMOTE_INPUT: 'REMOTE_INPUT',
      REMOTE_INTERACTION: 'REMOTE_INPUT',
      REMOTE_CONTROL: 'REMOTE_INPUT',
      FILES: 'FILE_TRANSFER',
      FILE_TRANSFER: 'FILE_TRANSFER',
      FILE_ACCESS: 'FILE_TRANSFER',
      APP: 'APP_MANAGEMENT',
      APPS: 'APP_MANAGEMENT',
      APP_CONTROL: 'APP_MANAGEMENT',
      APP_MANAGEMENT: 'APP_MANAGEMENT',
      APPLICATION_MANAGEMENT: 'APP_MANAGEMENT',
      DIAGNOSTICS: 'DIAGNOSTICS',
      DEVICE_DIAGNOSTICS: 'DIAGNOSTICS',
    };

    const granted = new Set<string>();
    for (const scope of scopes) {
      if (typeof scope !== 'string' || scope.length > 64) continue;
      const normalized = scope.trim().toUpperCase().replace(/[\\s-]+/g, '_');
      const canonical = aliases[normalized];
      if (canonical) granted.add(canonical);
    }
    return Array.from(granted);
  }

  public static registerDevice(deviceId: string, deviceName: string, fingerprint: string): RegisteredDevice {
    const dev: RegisteredDevice = {
      deviceId,
      deviceName: (deviceName || 'Android device').slice(0, 80),
      fingerprint,
      isOnline: true,
      lastSeen: Date.now(),
    };
    this.devices.set(deviceId, dev);
    return dev;
  }

  public static markOffline(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (device) this.devices.set(deviceId, { ...device, isOnline: false, lastSeen: Date.now() });
  }

  public static storePairingCode(deviceId: string, code: string, expiresAt: number): void {
    const digits = String(code || '').replace(/\D/g, '');
    if (!/^\d{6}$/.test(digits)) throw new Error('Pairing code must contain exactly six digits.');
    const now = Date.now();
    const boundedExpiry = Math.min(Number(expiresAt) || now + this.CODE_TTL_MAX_MS, now + this.CODE_TTL_MAX_MS);
    if (boundedExpiry <= now) throw new Error('Pairing code expiry must be in the future.');

    // One active code per receiver. Store only a one-way hash, never the raw code.
    for (const [key, record] of this.pairingCodes) {
      if (record.deviceId === deviceId) this.pairingCodes.delete(key);
    }
    const codeHash = hashCode(digits);
    this.pairingCodes.set(codeHash, { codeHash, deviceId, expiresAt: boundedExpiry });
  }

  public static beginPairing(
    code: string,
    controllerId: string,
    controllerName: string,
    controllerFingerprint: string,
    requestedScopes: string[] = ['SCREEN_VIEW', 'REMOTE_INPUT']
  ): PendingPairingRequest | null {
    this.cleanupExpired();
    const digits = String(code || '').replace(/\D/g, '');
    if (!/^\d{6}$/.test(digits)) return null;
    const record = this.pairingCodes.get(hashCode(digits));
    if (!record || record.expiresAt <= Date.now()) return null;
    if (this.pendingByReceiver.has(record.deviceId)) return null;
    if ([...this.activeSessions.values()].some(s =>
      s.receiverId === record.deviceId || s.controllerId === controllerId
    )) return null;

    const request: PendingPairingRequest = {
      requestId: crypto.randomUUID(),
      receiverId: record.deviceId,
      controllerId,
      controllerName: (controllerName || 'Remote controller').slice(0, 80),
      controllerFingerprint,
      requestedScopes: requestedScopes
        .filter(s => typeof s === 'string')
        .map(s => s.trim().slice(0, 64))
        .filter(Boolean)
        .slice(0, 12),
      createdAt: Date.now(),
      expiresAt: Math.min(Date.now() + this.REQUEST_TTL_MS, record.expiresAt),
    };
    this.pendingByReceiver.set(record.deviceId, request);
    return request;
  }

  public static approvePairing(receiverId: string, controllerId: string): ActiveRemoteSession | null {
    this.cleanupExpired();
    const request = this.pendingByReceiver.get(receiverId);
    if (!request || request.controllerId !== controllerId || request.expiresAt <= Date.now()) return null;

    const codeEntry = [...this.pairingCodes.entries()].find(([, value]) => value.deviceId === receiverId);
    if (!codeEntry) {
      this.pendingByReceiver.delete(receiverId);
      return null;
    }

    this.pairingCodes.delete(codeEntry[0]);
    this.pendingByReceiver.delete(receiverId);
    const receiver = this.devices.get(receiverId);
    const session: ActiveRemoteSession = {
      sessionId: crypto.randomUUID(),
      receiverId,
      controllerId,
      receiverFingerprint: receiver?.fingerprint || '',
      controllerFingerprint: request.controllerFingerprint,
      grantedScopes: this.normalizeGrantedScopes(request.requestedScopes),
      startedAt: Date.now(),
      expiresAt: Date.now() + this.SESSION_TTL_MS,
    };
    this.activeSessions.set(session.sessionId, session);
    return session;
  }

  public static rejectPairing(receiverId: string, controllerId: string): boolean {
    const request = this.pendingByReceiver.get(receiverId);
    if (!request || request.controllerId !== controllerId) return false;
    this.pendingByReceiver.delete(receiverId);
    return true;
  }

  public static getPendingPairing(receiverId: string): PendingPairingRequest | undefined {
    this.cleanupExpired();
    return this.pendingByReceiver.get(receiverId);
  }

  // Kept for the legacy REST integration test. New clients must use beginPairing()
  // and explicit receiver approval before any session token is created.
  public static validateAndConsumePairingCode(code: string): string | null {
    const digits = String(code || '').replace(/\D/g, '');
    if (!/^\d{6}$/.test(digits)) return null;
    const key = hashCode(digits);
    const record = this.pairingCodes.get(key);
    if (!record || record.expiresAt <= Date.now()) {
      this.pairingCodes.delete(key);
      return null;
    }
    this.pairingCodes.delete(key);
    return record.deviceId;
  }

  public static getDevice(deviceId: string): RegisteredDevice | undefined {
    return this.devices.get(deviceId);
  }

  public static listDevices(): RegisteredDevice[] {
    return Array.from(this.devices.values());
  }

  public static getSession(sessionId: string): ActiveRemoteSession | undefined {
    this.cleanupExpired();
    return this.activeSessions.get(sessionId);
  }

  public static isSessionParticipant(sessionId: string, entityId: string, peerId: string): boolean {
    const session = this.getSession(sessionId);
    return !!session && (
      (session.receiverId === entityId && session.controllerId === peerId) ||
      (session.controllerId === entityId && session.receiverId === peerId)
    );
  }

  public static endSession(sessionId: string): boolean {
    return this.activeSessions.delete(sessionId);
  }

  private static cleanupExpired(): void {
    const now = Date.now();
    for (const [key, value] of this.pairingCodes) {
      if (value.expiresAt <= now) this.pairingCodes.delete(key);
    }
    for (const [key, value] of this.pendingByReceiver) {
      if (value.expiresAt <= now) this.pendingByReceiver.delete(key);
    }
    for (const [key, value] of this.activeSessions) {
      if (value.expiresAt <= now) this.activeSessions.delete(key);
    }
  }
}
