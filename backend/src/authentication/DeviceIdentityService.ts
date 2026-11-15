import crypto from 'crypto';
import { Database } from '../database/Database';
import { DeviceService, DeviceServiceError } from '../device-management/DeviceService';

export type DeviceChallengePurpose = 'ENROLL' | 'AUTHENTICATE' | 'ROTATE';

export interface DeviceChallengeResponse {
  protocolVersion: 1;
  challengeId: string;
  purpose: DeviceChallengePurpose;
  nonce: string;
  fingerprint: string;
  signatureAlgorithm: 'SHA256withECDSA';
  expiresAtMs: number;
}

interface PublicKeyMaterial {
  format: 'spki-der-base64';
  algorithm: 'EC';
  curve: 'P-256';
  value: string;
}

interface ChallengeRow {
  challenge_id: string;
  purpose: DeviceChallengePurpose;
  device_id: string;
  device_name: string;
  fingerprint: string;
  public_key: string;
  old_fingerprint: string | null;
  old_key_version: number | null;
  nonce: string;
  expires_at_ms: string | number;
  consumed_at: Date | null;
}

const CHALLENGE_TTL_MS = 120_000;

export class DeviceIdentityService {
  private static validatePublicKey(material: PublicKeyMaterial): { value: string; fingerprint: string } {
    if (
      !material ||
      material.format !== 'spki-der-base64' ||
      material.algorithm !== 'EC' ||
      material.curve !== 'P-256' ||
      typeof material.value !== 'string' ||
      material.value.length > 2048
    ) {
      throw new DeviceServiceError('INVALID_PUBLIC_KEY', 'A P-256 X.509 SPKI public key is required.');
    }

    let der: Buffer;
    try {
      der = Buffer.from(material.value, 'base64');
      if (!der.length || der.toString('base64').replace(/=+$/g, '') !== material.value.replace(/=+$/g, '')) {
        throw new Error('Invalid Base64');
      }
    } catch {
      throw new DeviceServiceError('INVALID_PUBLIC_KEY', 'The public key is not valid Base64 DER.');
    }

    try {
      const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
      const curve = key.asymmetricKeyDetails?.namedCurve;
      if (key.asymmetricKeyType !== 'ec' || (curve && !['prime256v1', 'P-256'].includes(curve))) {
        throw new Error('Unsupported public-key type or curve');
      }
      if (!curve) throw new Error('Could not confirm the EC curve');
    } catch {
      throw new DeviceServiceError('INVALID_PUBLIC_KEY', 'Public key must be an ECDSA P-256 key in SPKI DER format.');
    }

    const fingerprint = `sha256:${crypto.createHash('sha256').update(der).digest('hex')}`;
    return { value: material.value, fingerprint };
  }

  private static validateDeviceId(deviceId: string): void {
    if (
      typeof deviceId !== 'string' ||
      deviceId.length < 8 ||
      deviceId.length > 64 ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]+$/.test(deviceId)
    ) {
      throw new DeviceServiceError('INVALID_REQUEST', 'Device ID must be 8–64 URL-safe characters.');
    }
  }

  private static async issueChallenge(
    purpose: DeviceChallengePurpose,
    deviceId: string,
    publicKey: string,
    fingerprint: string,
    deviceName: string,
    oldFingerprint: string | null = null,
    oldKeyVersion: number | null = null
  ): Promise<DeviceChallengeResponse> {
    const challengeId = crypto.randomUUID();
    const nonce = crypto.randomBytes(32).toString('base64url');
    const expiresAtMs = Date.now() + CHALLENGE_TTL_MS;
    await Database.query(
      `INSERT INTO device_challenges
       (challenge_id, purpose, device_id, fingerprint, public_key, old_fingerprint,
        old_key_version, nonce, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TO_TIMESTAMP($9 / 1000.0))`,
      [challengeId, purpose, deviceId, fingerprint, publicKey, oldFingerprint, oldKeyVersion, nonce, expiresAtMs]
    );
    return {
      protocolVersion: 1,
      challengeId,
      purpose,
      nonce,
      fingerprint,
      signatureAlgorithm: 'SHA256withECDSA',
      expiresAtMs,
    };
  }

  public static async issueEnrollmentChallenge(input: {
    deviceId: string;
    deviceName: string;
    publicKey: PublicKeyMaterial;
  }): Promise<DeviceChallengeResponse> {
    this.validateDeviceId(input.deviceId);
    const key = this.validatePublicKey(input.publicKey);
    const existing = await DeviceService.getDevice(input.deviceId);
    if (existing) throw new DeviceServiceError('DEVICE_ALREADY_ENROLLED', 'This device ID is already enrolled. Use authentication or key rotation.');
    const deviceName = String(input.deviceName || '').trim().slice(0, 128);
    if (!deviceName) throw new DeviceServiceError('INVALID_REQUEST', 'A device name is required.');

    return Database.transaction(async (client) => {
      const existingInTransaction = await client.query(
        'SELECT 1 FROM devices WHERE device_id = $1 FOR UPDATE',
        [input.deviceId]
      );
      if (existingInTransaction.rowCount) {
        throw new DeviceServiceError('DEVICE_ALREADY_ENROLLED', 'This device ID is already enrolled. Use authentication or key rotation.');
      }
      const challengeId = crypto.randomUUID();
      const nonce = crypto.randomBytes(32).toString('base64url');
      const expiresAtMs = Date.now() + CHALLENGE_TTL_MS;
      await client.query(
        `INSERT INTO device_challenges
         (challenge_id, purpose, device_id, fingerprint, public_key, nonce, expires_at)
         VALUES ($1, 'ENROLL', $2, $3, $4, $5, TO_TIMESTAMP($6 / 1000.0))`,
        [challengeId, input.deviceId, key.fingerprint, key.value, nonce, expiresAtMs]
      );
      return {
        protocolVersion: 1,
        challengeId,
        purpose: 'ENROLL',
        nonce,
        fingerprint: key.fingerprint,
        signatureAlgorithm: 'SHA256withECDSA',
        expiresAtMs,
      };
    });
  }

  public static async issueAuthenticationChallenge(deviceId: string): Promise<DeviceChallengeResponse> {
    this.validateDeviceId(deviceId);
    const device = await DeviceService.getDevice(deviceId);
    if (!device || device.isRevoked) {
      throw new DeviceServiceError('DEVICE_NOT_FOUND', 'No active enrolled device was found.');
    }
    return this.issueChallenge(
      'AUTHENTICATE',
      device.deviceId,
      device.publicKey,
      device.fingerprint,
      null,
      device.keyVersion
    );
  }

  public static async issueRotationChallenge(
    deviceId: string,
    currentFingerprint: string,
    currentKeyVersion: number,
    newPublicKey: PublicKeyMaterial
  ): Promise<DeviceChallengeResponse> {
    const device = await DeviceService.getDevice(deviceId);
    if (
      !device ||
      device.isRevoked ||
      device.fingerprint !== currentFingerprint ||
      device.keyVersion !== currentKeyVersion
    ) {
      throw new DeviceServiceError('DEVICE_REVOKED', 'Current device authorization is no longer valid.');
    }
    const key = this.validatePublicKey(newPublicKey);
    return this.issueChallenge(
      'ROTATE',
      deviceId,
      key.value,
      key.fingerprint,
      device.fingerprint,
      device.deviceName,
      device.keyVersion
    );
  }

  private static signatureMessage(row: ChallengeRow): Buffer {
    const expiresAtMs = Number(row.expires_at_ms);
    const canonical = [
      'MAHI-REMOTE-DEVICE-PROOF',
      '1',
      row.purpose,
      row.challenge_id,
      row.device_id,
      row.fingerprint,
      row.nonce,
      String(expiresAtMs),
    ].join('\n');
    return Buffer.from(canonical, 'utf8');
  }

  private static signatureIsValid(publicKeyDerBase64: string, message: Buffer, signatureBase64: string): boolean {
    if (typeof signatureBase64 !== 'string' || signatureBase64.length < 24 || signatureBase64.length > 256) return false;
    try {
      const signature = Buffer.from(signatureBase64, 'base64');
      if (!signature.length || signature.toString('base64').replace(/=+$/g, '') !== signatureBase64.replace(/=+$/g, '')) return false;
      const publicKey = crypto.createPublicKey({
        key: Buffer.from(publicKeyDerBase64, 'base64'),
        format: 'der',
        type: 'spki',
      });
      // No syntax-only or length-only fallback: invalid signatures always fail closed.
      return crypto.verify('sha256', message, publicKey, signature);
    } catch {
      return false;
    }
  }

  private static async loadChallenge(
    client: import('pg').PoolClient,
    challengeId: string,
    purpose: DeviceChallengePurpose
  ): Promise<ChallengeRow> {
    const result = await client.query(
      `SELECT challenge_id::text, purpose, device_id, device_name, fingerprint, public_key, old_fingerprint,
              old_key_version, nonce,
              (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint AS expires_at_ms,
              consumed_at
       FROM device_challenges WHERE challenge_id = $1 FOR UPDATE`,
      [challengeId]
    );
    const row = result.rows[0] as ChallengeRow | undefined;
    if (!row || row.purpose !== purpose) {
      throw new DeviceServiceError('CHALLENGE_NOT_FOUND', 'Challenge was not found for this operation.');
    }
    if (row.consumed_at) throw new DeviceServiceError('CHALLENGE_REPLAYED', 'Challenge has already been consumed.');
    if (Number(row.expires_at_ms) <= Date.now()) {
      throw new DeviceServiceError('CHALLENGE_EXPIRED', 'Challenge has expired. Request a new challenge.');
    }
    return row;
  }

  public static async verifyEnrollment(challengeId: string, signature: string): Promise<{
    deviceId: string; deviceName: string; fingerprint: string; keyVersion: number;
  }> {
    return Database.transaction(async (client) => {
      const row = await this.loadChallenge(client, challengeId, 'ENROLL');
      const message = this.signatureMessage(row);

      // The device name is stored as an optional suffix in the challenge's public_key column
      // only within this enrollment flow; split it back out without affecting key proof bytes.
      const [publicKey, deviceNameRaw] = row.public_key.split('\n');
      if (!this.signatureIsValid(publicKey, message, signature)) {
        throw new DeviceServiceError('INVALID_SIGNATURE', 'Device enrollment signature is invalid.');
      }
      const deviceName = String(row.device_name || 'Android device').slice(0, 128);
      await client.query(
        'UPDATE device_challenges SET consumed_at = NOW() WHERE challenge_id = $1 AND consumed_at IS NULL',
        [challengeId]
      );
      await client.query(
        `INSERT INTO devices (device_id, device_name, public_key, fingerprint, key_version, is_online, is_revoked)
         VALUES ($1, $2, $3, $4, 1, FALSE, FALSE)`,
        [row.device_id, deviceName, publicKey, row.fingerprint]
      );
      await client.query(
        `INSERT INTO audit_events (actor_id, device_id, category, action, details)
         VALUES ($1, $1, 'DEVICE', 'ENROLLED', $2::jsonb)`,
        [row.device_id, JSON.stringify({ fingerprint: row.fingerprint })]
      );
      return { deviceId: row.device_id, deviceName, fingerprint: row.fingerprint, keyVersion: 1 };
    });
  }

  public static async verifyAuthentication(challengeId: string, signature: string): Promise<{
    deviceId: string; deviceName: string; fingerprint: string; keyVersion: number;
  }> {
    return Database.transaction(async (client) => {
      const row = await this.loadChallenge(client, challengeId, 'AUTHENTICATE');
      const device = await client.query(
        'SELECT device_name, fingerprint, key_version, is_revoked FROM devices WHERE device_id = $1 FOR UPDATE',
        [row.device_id]
      );
      const current = device.rows[0];
      if (!current || current.is_revoked || current.fingerprint !== row.fingerprint ||
          Number(current.key_version) !== Number(row.old_key_version)) {
        throw new DeviceServiceError('DEVICE_REVOKED', 'Device key has changed or the device has been revoked.');
      }
      if (!this.signatureIsValid(row.public_key, this.signatureMessage(row), signature)) {
        throw new DeviceServiceError('INVALID_SIGNATURE', 'Device authentication signature is invalid.');
      }
      await client.query('UPDATE device_challenges SET consumed_at = NOW() WHERE challenge_id = $1', [challengeId]);
      await client.query(
        `INSERT INTO audit_events (actor_id, device_id, category, action, details)
         VALUES ($1, $1, 'DEVICE', 'AUTHENTICATED', '{}'::jsonb)`,
        [row.device_id]
      );
      return {
        deviceId: row.device_id,
        deviceName: current.device_name,
        fingerprint: row.fingerprint,
        keyVersion: Number(current.key_version),
      };
    });
  }

  public static async verifyRotation(
    challengeId: string,
    oldKeySignature: string,
    newKeySignature: string,
    authenticatedDeviceId: string,
    authenticatedFingerprint: string,
    authenticatedKeyVersion: number
  ): Promise<{ deviceId: string; fingerprint: string; keyVersion: number }> {
    return Database.transaction(async (client) => {
      const row = await this.loadChallenge(client, challengeId, 'ROTATE');
      if (row.device_id !== authenticatedDeviceId ||
          row.old_fingerprint !== authenticatedFingerprint ||
          Number(row.old_key_version) !== authenticatedKeyVersion) {
        throw new DeviceServiceError('DEVICE_REVOKED', 'Key-rotation challenge does not match the current device token.');
      }
      const current = await client.query(
        'SELECT public_key, fingerprint, key_version, is_revoked FROM devices WHERE device_id = $1 FOR UPDATE',
        [row.device_id]
      );
      const currentRow = current.rows[0];
      if (!currentRow || currentRow.is_revoked || currentRow.fingerprint !== row.old_fingerprint ||
          Number(currentRow.key_version) !== authenticatedKeyVersion) {
        throw new DeviceServiceError('DEVICE_REVOKED', 'Current device key is no longer active.');
      }

      const message = this.signatureMessage(row);
      if (!this.signatureIsValid(currentRow.public_key, message, oldKeySignature) ||
          !this.signatureIsValid(row.public_key, message, newKeySignature)) {
        throw new DeviceServiceError('INVALID_SIGNATURE', 'Both old and replacement device keys must sign the rotation challenge.');
      }

      await client.query('UPDATE device_challenges SET consumed_at = NOW() WHERE challenge_id = $1', [challengeId]);
      const updated = await client.query(
        `UPDATE devices SET public_key = $2, fingerprint = $3, key_version = key_version + 1,
             is_online = FALSE, updated_at = NOW()
         WHERE device_id = $1 AND key_version = $4
         RETURNING key_version`,
        [row.device_id, row.public_key, row.fingerprint, authenticatedKeyVersion]
      );
      if (!updated.rowCount) throw new DeviceServiceError('DEVICE_KEY_CONFLICT', 'Device key was concurrently changed.');
      await client.query(
        `UPDATE support_sessions SET status = 'REVOKED', ended_at = NOW(), end_reason = 'Device key rotated'
         WHERE device_id = $1 AND status = 'ACTIVE'`,
        [row.device_id]
      );
      await client.query(
        `INSERT INTO audit_events (actor_id, device_id, category, action, details)
         VALUES ($1, $1, 'DEVICE', 'KEY_ROTATED', $2::jsonb)`,
        [row.device_id, JSON.stringify({ fingerprint: row.fingerprint, keyVersion: Number(updated.rows[0].key_version) })]
      );
      return {
        deviceId: row.device_id,
        fingerprint: row.fingerprint,
        keyVersion: Number(updated.rows[0].key_version),
      };
    });
  }
}
