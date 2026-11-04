export interface RegisteredDevice {
  deviceId: string;
  deviceName: string;
  fingerprint: string;
  isOnline: boolean;
  lastSeen: number;
}

export interface PairingCodeRecord {
  code: string;
  deviceId: string;
  expiresAt: number;
}

export class DeviceService {
  private static devices = new Map<string, RegisteredDevice>();
  private static pairingCodes = new Map<string, PairingCodeRecord>();
  private static activeSessions = new Map<string, {
    deviceId: string;
    controllerId: string;
    operatorFingerprint: string;
    receiverFingerprint: string;
    startedAt: number;
  }>();

  public static registerDevice(deviceId: string, deviceName: string, fingerprint: string): RegisteredDevice {
    const dev: RegisteredDevice = {
      deviceId,
      deviceName,
      fingerprint,
      isOnline: true,
      lastSeen: Date.now(),
    };
    this.devices.set(deviceId, dev);
    return dev;
  }

  public static storePairingCode(deviceId: string, code: string, expiresAt: number): void {
    this.pairingCodes.set(code, { code, deviceId, expiresAt });
  }

  /**
   * Read a still-valid code without consuming it. Pairing requests must remain
   * pending until the receiver explicitly approves them.
   */
  public static getPairingCode(code: string): PairingCodeRecord | null {
    const normalized = String(code || '').replace(/[^0-9]/g, '');
    if (!/^\d{6}$/.test(normalized)) return null;
    const record = this.pairingCodes.get(normalized);
    if (!record) return null;
    if (Date.now() >= record.expiresAt) {
      this.pairingCodes.delete(normalized);
      return null;
    }
    return { ...record };
  }

  public static validateAndConsumePairingCode(code: string): string | null {
    const normalized = String(code || '').replace(/[^0-9]/g, '');
    const record = this.getPairingCode(normalized);
    if (!record) return null;
    this.pairingCodes.delete(normalized);
    return record.deviceId;
  }

  public static getDevice(deviceId: string): RegisteredDevice | undefined {
    return this.devices.get(deviceId);
  }

  public static listDevices(): RegisteredDevice[] {
    return Array.from(this.devices.values());
  }

  public static startSession(
    sessionId: string,
    deviceId: string,
    operatorFingerprint: string,
    controllerId: string,
    receiverFingerprint: string
  ): void {
    this.activeSessions.set(sessionId, {
      deviceId,
      controllerId,
      operatorFingerprint,
      receiverFingerprint,
      startedAt: Date.now(),
    });
  }

  public static getActiveSession(sessionId: string): {
    deviceId: string;
    controllerId: string;
    operatorFingerprint: string;
    receiverFingerprint: string;
    startedAt: number;
  } | undefined {
    return this.activeSessions.get(sessionId);
  }

  public static isSessionParticipant(sessionId: string, entityId: string, fingerprint: string): boolean {
    const session = this.activeSessions.get(sessionId);
    if (!session) return false;
    return (
      (entityId === session.deviceId && fingerprint === session.receiverFingerprint) ||
      (entityId === session.controllerId && fingerprint === session.operatorFingerprint)
    );
  }

  public static getSessionPeer(sessionId: string, entityId: string): string | null {
    const session = this.activeSessions.get(sessionId);
    if (!session) return null;
    if (entityId === session.deviceId) return session.controllerId;
    if (entityId === session.controllerId) return session.deviceId;
    return null;
  }

  public static endSession(sessionId: string): boolean {
    return this.activeSessions.delete(sessionId);
  }
}
