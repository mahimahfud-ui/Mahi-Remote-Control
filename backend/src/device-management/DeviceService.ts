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
  private static activeSessions = new Map<string, { deviceId: string; operatorFingerprint: string; startedAt: number }>();

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

  public static validateAndConsumePairingCode(code: string): string | null {
    const record = this.pairingCodes.get(code);
    if (!record) return null;
    if (Date.now() > record.expiresAt) {
      this.pairingCodes.delete(code);
      return null;
    }
    this.pairingCodes.delete(code);
    return record.deviceId;
  }

  public static getDevice(deviceId: string): RegisteredDevice | undefined {
    return this.devices.get(deviceId);
  }

  public static listDevices(): RegisteredDevice[] {
    return Array.from(this.devices.values());
  }

  public static startSession(sessionId: string, deviceId: string, operatorFingerprint: string): void {
    this.activeSessions.set(sessionId, { deviceId, operatorFingerprint, startedAt: Date.now() });
  }

  public static endSession(sessionId: string): boolean {
    return this.activeSessions.delete(sessionId);
  }
}
