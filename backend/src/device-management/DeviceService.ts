import crypto from 'crypto';
import { PoolClient } from 'pg';
import { Database } from '../database/Database';

export interface RegisteredDevice {
  deviceId: string;
  deviceName: string;
  fingerprint: string;
  publicKey: string;
  keyVersion: number;
  isOnline: boolean;
  isRevoked: boolean;
  lastSeen: number | null;
}

export interface PairingCodeRecord {
  codeId: string;
  deviceId: string;
  expiresAt: number;
}

export interface PairingRequestRecord {
  requestId: string;
  codeId: string;
  receiverId: string;
  receiverName: string;
  controllerId: string;
  controllerFingerprint: string;
  controllerName: string;
  requestedScopes: string[];
  expiresAt: number;
}

export interface SessionParticipant {
  participantId: string;
  participantType: 'DEVICE' | 'OPERATOR';
  fingerprint: string;
  scopes: string[];
}

export interface ActiveSessionRecord {
  sessionId: string;
  deviceId: string;
  controllerId: string;
  operatorFingerprint: string;
  receiverFingerprint: string;
  startedAt: number;
  expiresAt: number;
}

export class DeviceServiceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'DeviceServiceError';
  }
}

export class DeviceService {
  private static readonly CODE_TTL_MS = 5 * 60 * 1000;
  private static readonly REQUEST_TTL_MS = 2 * 60 * 1000;
  private static readonly SESSION_TTL_MS = 30 * 60 * 1000;

  private static normalizePairingCode(code: string): string {
    return String(code || '').replace(/[^0-9]/g, '');
  }

  private static pairingCodeHash(deviceId: string, code: string): string {
    const pepper = process.env.PAIRING_CODE_PEPPER;
    if (!pepper || Buffer.byteLength(pepper, 'utf8') < 32 || /replace|example|change[-_ ]?me/i.test(pepper)) {
      throw new Error('PAIRING_CODE_PEPPER must be configured with at least 32 bytes.');
    }
    return crypto.createHmac('sha256', pepper).update(`mahi-remote:v1:${code}`).digest('hex');
  }

  public static async insertEnrolledDevice(
    deviceId: string,
    deviceName: string,
    publicKey: string,
    fingerprint: string
  ): Promise<void> {
    await Database.query(
      `INSERT INTO devices (device_id, device_name, public_key, fingerprint, key_version, is_online, is_revoked)
       VALUES ($1, $2, $3, $4, 1, FALSE, FALSE)`,
      [deviceId, deviceName.slice(0, 128), publicKey, fingerprint]
    );
    await this.audit(null, deviceId, 'DEVICE', 'ENROLLED', { fingerprint });
  }

  public static async updateDeviceKey(
    deviceId: string,
    publicKey: string,
    fingerprint: string,
    expectedKeyVersion: number
  ): Promise<number> {
    return Database.transaction(async (client) => {
      const result = await client.query(
        `UPDATE devices
         SET public_key = $2, fingerprint = $3, key_version = key_version + 1,
             updated_at = NOW(), is_revoked = FALSE
         WHERE device_id = $1 AND key_version = $4 AND is_revoked = FALSE
         RETURNING key_version`,
        [deviceId, publicKey, fingerprint, expectedKeyVersion]
      );
      if (!result.rowCount) throw new DeviceServiceError('DEVICE_KEY_CONFLICT', 'Device key changed or was revoked during rotation.');
      const version = Number(result.rows[0].key_version);
      await client.query(
        `UPDATE support_sessions SET status = 'REVOKED', ended_at = NOW(), end_reason = 'Device key rotated'
         WHERE device_id = $1 AND status = 'ACTIVE'`,
        [deviceId]
      );
      await client.query(
        `INSERT INTO audit_events (actor_id, device_id, category, action, details)
         VALUES ($1, $1, 'DEVICE', 'KEY_ROTATED', $2::jsonb)`,
        [deviceId, JSON.stringify({ fingerprint, keyVersion: version })]
      );
      return version;
    });
  }

  public static async getDevice(deviceId: string): Promise<RegisteredDevice | null> {
    const result = await Database.query(
      `SELECT device_id, device_name, public_key, fingerprint, key_version, is_online,
              is_revoked, last_seen_at
       FROM devices WHERE device_id = $1`,
      [deviceId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      deviceId: row.device_id,
      deviceName: row.device_name,
      publicKey: row.public_key,
      fingerprint: row.fingerprint,
      keyVersion: Number(row.key_version),
      isOnline: Boolean(row.is_online),
      isRevoked: Boolean(row.is_revoked),
      lastSeen: row.last_seen_at ? new Date(row.last_seen_at).getTime() : null,
    };
  }

  public static async setDeviceOnline(deviceId: string, instanceId: string): Promise<void> {
    await Database.transaction(async (client) => {
      const device = await client.query(
        'SELECT device_id FROM devices WHERE device_id = $1 AND is_revoked = FALSE FOR UPDATE',
        [deviceId]
      );
      if (!device.rowCount) throw new DeviceServiceError('DEVICE_REVOKED', 'Device is not enrolled or has been revoked.');
      await client.query(
        `INSERT INTO device_presence (device_id, instance_id, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '60 seconds')
         ON CONFLICT (device_id, instance_id)
         DO UPDATE SET last_seen_at = NOW(), expires_at = NOW() + INTERVAL '60 seconds'`,
        [deviceId, instanceId]
      );
      await client.query(
        'UPDATE devices SET is_online = TRUE, last_seen_at = NOW(), updated_at = NOW() WHERE device_id = $1',
        [deviceId]
      );
    });
  }

  public static async heartbeatDevice(deviceId: string, instanceId: string): Promise<boolean> {
    const result = await Database.query(
      `UPDATE device_presence SET last_seen_at = NOW(), expires_at = NOW() + INTERVAL '60 seconds'
       WHERE device_id = $1 AND instance_id = $2 AND expires_at > NOW()`,
      [deviceId, instanceId]
    );
    if (result.rowCount) {
      await Database.query(
        'UPDATE devices SET last_seen_at = NOW(), is_online = TRUE WHERE device_id = $1',
        [deviceId]
      );
      return true;
    }
    return false;
  }

  public static async setDeviceOffline(deviceId: string, instanceId: string): Promise<void> {
    await Database.transaction(async (client) => {
      await client.query(
        'DELETE FROM device_presence WHERE device_id = $1 AND instance_id = $2',
        [deviceId, instanceId]
      );
      const remaining = await client.query(
        'SELECT 1 FROM device_presence WHERE device_id = $1 AND expires_at > NOW() LIMIT 1',
        [deviceId]
      );
      if (!remaining.rowCount) {
        await client.query(
          'UPDATE devices SET is_online = FALSE, updated_at = NOW() WHERE device_id = $1',
          [deviceId]
        );
      }
    });
  }

  public static async storePairingCode(deviceId: string, rawCode: string, expiresAt: number): Promise<void> {
    const code = this.normalizePairingCode(rawCode);
    if (!deviceId || !/^\d{6}$/.test(code) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new DeviceServiceError('INVALID_PAIRING_CODE', 'Pairing code must contain six digits and have a future expiry.');
    }
    const safeExpiry = Math.min(expiresAt, Date.now() + this.CODE_TTL_MS);
    const device = await this.getDevice(deviceId);
    if (!device || device.isRevoked) throw new DeviceServiceError('DEVICE_REVOKED', 'The receiver device is not active.');
    const codeHash = this.pairingCodeHash(deviceId, code);

    await Database.transaction(async (client) => {
      await client.query('SELECT device_id FROM devices WHERE device_id = $1 FOR UPDATE', [deviceId]);
      await client.query(
        'DELETE FROM pairing_codes WHERE device_id = $1 AND consumed_at IS NULL',
        [deviceId]
      );
      await client.query(
        `INSERT INTO pairing_codes (id, device_id, code_hash, expires_at)
         VALUES ($1, $2, $3, TO_TIMESTAMP($4 / 1000.0))`,
        [crypto.randomUUID(), deviceId, codeHash, safeExpiry]
      );
    });
  }

  public static async getPairingCode(rawCode: string, deviceId?: string): Promise<PairingCodeRecord | null> {
    const code = this.normalizePairingCode(rawCode);
    if (!/^\d{6}$/.test(code)) return null;
    const targetDeviceId = deviceId || '';
    // The hash includes device_id, so the lookup uses the enrolled device set.
    const candidates = targetDeviceId
      ? [targetDeviceId]
      : (await Database.query<{ device_id: string }>(
          'SELECT device_id FROM pairing_codes WHERE consumed_at IS NULL AND expires_at > NOW()'
        )).rows.map((row) => row.device_id);

    for (const id of candidates) {
      const codeHash = this.pairingCodeHash(id, code);
      const result = await Database.query(
        `SELECT id::text AS code_id, device_id, (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint AS expires_at_ms
         FROM pairing_codes
         WHERE code_hash = $1 AND device_id = $2 AND consumed_at IS NULL AND expires_at > NOW()`,
        [codeHash, id]
      );
      const row = result.rows[0];
      if (row) return { codeId: row.code_id, deviceId: row.device_id, expiresAt: Number(row.expires_at_ms) };
    }
    return null;
  }

  public static async createPairingRequest(input: {
    requestId: string;
    code: string;
    controllerId: string;
    controllerFingerprint: string;
    controllerName: string;
    requestedScopes: string[];
  }): Promise<PairingRequestRecord> {
    const normalizedCode = this.normalizePairingCode(input.code);
    if (!/^\d{6}$/.test(normalizedCode)) {
      throw new DeviceServiceError('PAIRING_CODE_INVALID', 'Invalid or expired pairing code.');
    }

    return Database.transaction(async (client) => {
      // The peppered HMAC permits an indexed lookup without persisting or scanning plaintext codes.
      const codeHash = this.pairingCodeHash('', normalizedCode);
      const activeCodes = await client.query(
        `SELECT p.id::text AS code_id, p.code_hash, p.device_id, d.device_name,
                (EXTRACT(EPOCH FROM p.expires_at) * 1000)::bigint AS expires_at_ms
         FROM pairing_codes p
         JOIN devices d ON d.device_id = p.device_id
         WHERE p.code_hash = $1 AND p.consumed_at IS NULL
           AND p.expires_at > NOW() AND d.is_revoked = FALSE
         FOR UPDATE OF p, d`,
        [codeHash]
      );
      const matched = activeCodes.rows[0];
      if (!matched || !crypto.timingSafeEqual(Buffer.from(matched.code_hash), Buffer.from(codeHash))) {
        throw new DeviceServiceError('PAIRING_CODE_INVALID', 'Invalid or expired pairing code.');
      }

      const presence = await client.query(
        'SELECT 1 FROM device_presence WHERE device_id = $1 AND expires_at > NOW() LIMIT 1',
        [matched.device_id]
      );
      if (!presence.rowCount) throw new DeviceServiceError('RECEIVER_OFFLINE', 'Receiver is offline or unavailable.');

      const activeSession = await client.query(
        `SELECT 1 FROM support_sessions
         WHERE device_id = $1 AND status = 'ACTIVE' AND expires_at > NOW()
         LIMIT 1 FOR UPDATE`,
        [matched.device_id]
      );
      if (activeSession.rowCount) throw new DeviceServiceError('SESSION_ALREADY_ACTIVE', 'This receiver already has an active remote session.');

      const pending = await client.query(
        `SELECT 1 FROM pairing_requests
         WHERE receiver_id = $1 AND status = 'PENDING' AND expires_at > NOW()
         LIMIT 1 FOR UPDATE`,
        [matched.device_id]
      );
      if (pending.rowCount) throw new DeviceServiceError('PAIRING_ALREADY_PENDING', 'This receiver already has a pending connection request.');

      const expiresAt = Math.min(Number(matched.expires_at_ms), Date.now() + this.REQUEST_TTL_MS);
      const inserted = await client.query(
        `INSERT INTO pairing_requests
           (request_id, code_id, receiver_id, controller_id, controller_fingerprint, controller_name, requested_scopes, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, TO_TIMESTAMP($8 / 1000.0))
         RETURNING request_id::text, code_id::text, receiver_id, controller_id,
                   controller_fingerprint, controller_name, requested_scopes,
                   (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint AS expires_at_ms`,
        [
          input.requestId,
          matched.code_id,
          matched.device_id,
          input.controllerId,
          input.controllerFingerprint,
          input.controllerName.slice(0, 80),
          input.requestedScopes,
          expiresAt,
        ]
      );
      const row = inserted.rows[0];
      return {
        requestId: row.request_id,
        codeId: row.code_id,
        receiverId: row.receiver_id,
        receiverName: matched.device_name,
        controllerId: row.controller_id,
        controllerFingerprint: row.controller_fingerprint,
        controllerName: row.controller_name,
        requestedScopes: row.requested_scopes,
        expiresAt: Number(row.expires_at_ms),
      };
    });
  }

  public static async getPairingRequest(requestId: string): Promise<PairingRequestRecord | null> {
    const result = await Database.query(
      `SELECT pr.request_id::text, pr.code_id::text, pr.receiver_id, d.device_name AS receiver_name,
              pr.controller_id, pr.controller_fingerprint, pr.controller_name, pr.requested_scopes,
              (EXTRACT(EPOCH FROM pr.expires_at) * 1000)::bigint AS expires_at_ms
       FROM pairing_requests pr JOIN devices d ON d.device_id = pr.receiver_id
       WHERE pr.request_id = $1 AND pr.status = 'PENDING' AND pr.expires_at > NOW()`,
      [requestId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      requestId: row.request_id,
      codeId: row.code_id,
      receiverId: row.receiver_id,
      receiverName: row.receiver_name,
      controllerId: row.controller_id,
      controllerFingerprint: row.controller_fingerprint,
      controllerName: row.controller_name,
      requestedScopes: row.requested_scopes,
      expiresAt: Number(row.expires_at_ms),
    };
  }

  public static async rejectPairingRequest(requestId: string, receiverId: string): Promise<PairingRequestRecord | null> {
    return Database.transaction(async (client) => {
      const result = await client.query(
        `UPDATE pairing_requests
         SET status = 'REJECTED', decided_at = NOW()
         WHERE request_id = $1 AND receiver_id = $2 AND status = 'PENDING' AND expires_at > NOW()
         RETURNING request_id::text, code_id::text, receiver_id, controller_id,
                   controller_fingerprint, controller_name, requested_scopes,
                   (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint AS expires_at_ms`,
        [requestId, receiverId]
      );
      const row = result.rows[0];
      if (!row) return null;
      const device = await client.query('SELECT device_name FROM devices WHERE device_id = $1', [receiverId]);
      await client.query(
        `INSERT INTO audit_events (actor_id, device_id, category, action, details)
         VALUES ($1, $1, 'PAIRING', 'REJECTED', $2::jsonb)`,
        [receiverId, JSON.stringify({ requestId })]
      );
      return {
        requestId: row.request_id,
        codeId: row.code_id,
        receiverId: row.receiver_id,
        receiverName: device.rows[0]?.device_name || 'Receiver',
        controllerId: row.controller_id,
        controllerFingerprint: row.controller_fingerprint,
        controllerName: row.controller_name,
        requestedScopes: row.requested_scopes,
        expiresAt: Number(row.expires_at_ms),
      };
    });
  }

  public static async approvePairingRequest(
    requestId: string,
    receiverId: string,
    sessionId: string
  ): Promise<{ request: PairingRequestRecord; session: ActiveSessionRecord }> {
    return Database.transaction(async (client) => {
      // Lock the receiver before all competing approvals to serialize session creation.
      const deviceResult = await client.query(
        'SELECT device_id, device_name, fingerprint, is_revoked FROM devices WHERE device_id = $1 FOR UPDATE',
        [receiverId]
      );
      const device = deviceResult.rows[0];
      if (!device || device.is_revoked) throw new DeviceServiceError('DEVICE_REVOKED', 'Receiver device is not active.');

      const requestResult = await client.query(
        `SELECT request_id::text, code_id::text, receiver_id, controller_id, controller_fingerprint,
                controller_name, requested_scopes,
                (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint AS expires_at_ms
         FROM pairing_requests
         WHERE request_id = $1 AND receiver_id = $2 AND status = 'PENDING'
           AND expires_at > NOW()
         FOR UPDATE`,
        [requestId, receiverId]
      );
      const row = requestResult.rows[0];
      if (!row) throw new DeviceServiceError('PAIRING_REQUEST_EXPIRED', 'Pairing request is invalid or expired.');

      const codeResult = await client.query(
        `SELECT id FROM pairing_codes
         WHERE id = $1 AND device_id = $2 AND consumed_at IS NULL AND expires_at > NOW()
         FOR UPDATE`,
        [row.code_id, receiverId]
      );
      if (!codeResult.rowCount) throw new DeviceServiceError('PAIRING_CODE_USED', 'Pairing code expired or was already consumed.');

      const active = await client.query(
        `SELECT 1 FROM support_sessions
         WHERE device_id = $1 AND status = 'ACTIVE' AND expires_at > NOW()
         LIMIT 1 FOR UPDATE`,
        [receiverId]
      );
      if (active.rowCount) throw new DeviceServiceError('SESSION_ALREADY_ACTIVE', 'This receiver already has an active remote session.');

      const now = Date.now();
      const expiresAt = now + this.SESSION_TTL_MS;
      await client.query('UPDATE pairing_codes SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL', [row.code_id]);
      await client.query(
        `UPDATE pairing_requests SET status = 'APPROVED', decided_at = NOW()
         WHERE request_id = $1`,
        [requestId]
      );
      await client.query(
        `INSERT INTO support_sessions
           (session_id, device_id, controller_id, controller_fingerprint, receiver_fingerprint, status, started_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, 'ACTIVE', NOW(), TO_TIMESTAMP($6 / 1000.0))`,
        [sessionId, receiverId, row.controller_id, row.controller_fingerprint, device.fingerprint, expiresAt]
      );
      await client.query(
        `INSERT INTO session_participants (session_id, participant_id, participant_type, fingerprint, scopes)
         VALUES
           ($1, $2, 'DEVICE', $3, ARRAY['SCREEN_VIEW','REMOTE_INPUT','FILES','DIAGNOSTICS']),
           ($1, $4, 'OPERATOR', $5, $6)`,
        [sessionId, receiverId, device.fingerprint, row.controller_id, row.controller_fingerprint, row.requested_scopes]
      );
      await client.query(
        `INSERT INTO audit_events (actor_id, device_id, session_id, category, action, details)
         VALUES ($1, $1, $2, 'SESSION', 'CREATED', $3::jsonb)`,
        [receiverId, sessionId, JSON.stringify({ controllerId: row.controller_id, requestId })]
      );

      const request: PairingRequestRecord = {
        requestId: row.request_id,
        codeId: row.code_id,
        receiverId: row.receiver_id,
        receiverName: device.device_name,
        controllerId: row.controller_id,
        controllerFingerprint: row.controller_fingerprint,
        controllerName: row.controller_name,
        requestedScopes: row.requested_scopes,
        expiresAt: Number(row.expires_at_ms),
      };
      return {
        request,
        session: {
          sessionId,
          deviceId: receiverId,
          controllerId: row.controller_id,
          operatorFingerprint: row.controller_fingerprint,
          receiverFingerprint: device.fingerprint,
          startedAt: now,
          expiresAt,
        },
      };
    });
  }

  public static async hasActiveSessionForDevice(deviceId: string): Promise<boolean> {
    const result = await Database.query(
      `SELECT 1 FROM support_sessions
       WHERE device_id = $1 AND status = 'ACTIVE' AND expires_at > NOW() LIMIT 1`,
      [deviceId]
    );
    return Boolean(result.rowCount);
  }

  public static async getActiveSession(sessionId: string): Promise<ActiveSessionRecord | null> {
    const result = await Database.query(
      `SELECT session_id::text, device_id, controller_id, controller_fingerprint,
              receiver_fingerprint,
              (EXTRACT(EPOCH FROM started_at) * 1000)::bigint AS started_at_ms,
              (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint AS expires_at_ms
       FROM support_sessions
       WHERE session_id = $1 AND status = 'ACTIVE' AND expires_at > NOW()`,
      [sessionId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      sessionId: row.session_id,
      deviceId: row.device_id,
      controllerId: row.controller_id,
      operatorFingerprint: row.controller_fingerprint,
      receiverFingerprint: row.receiver_fingerprint,
      startedAt: Number(row.started_at_ms),
      expiresAt: Number(row.expires_at_ms),
    };
  }

  public static async isSessionParticipant(sessionId: string, entityId: string, fingerprint: string): Promise<boolean> {
    const result = await Database.query(
      `SELECT 1
       FROM support_sessions s
       JOIN session_participants p ON p.session_id = s.session_id
       LEFT JOIN devices d ON d.device_id = p.participant_id AND p.participant_type = 'DEVICE'
       WHERE s.session_id = $1 AND s.status = 'ACTIVE' AND s.expires_at > NOW()
         AND p.participant_id = $2 AND p.fingerprint = $3
         AND (p.participant_type <> 'DEVICE' OR (d.is_revoked = FALSE AND d.key_version IS NOT NULL))`,
      [sessionId, entityId, fingerprint]
    );
    return Boolean(result.rowCount);
  }

  public static async getSessionPeer(sessionId: string, entityId: string): Promise<string | null> {
    const result = await Database.query(
      `SELECT participant_id FROM session_participants
       WHERE session_id = $1 AND participant_id <> $2
       LIMIT 1`,
      [sessionId, entityId]
    );
    return result.rows[0]?.participant_id || null;
  }

  public static async hasSessionScope(
    sessionId: string,
    participantId: string,
    requiredScope: string
  ): Promise<boolean> {
    const result = await Database.query(
      `SELECT 1 FROM support_sessions s
       JOIN session_participants p ON p.session_id = s.session_id
       WHERE s.session_id = $1 AND s.status = 'ACTIVE' AND s.expires_at > NOW()
         AND p.participant_id = $2 AND $3 = ANY(p.scopes)`,
      [sessionId, participantId, requiredScope]
    );
    return Boolean(result.rowCount);
  }

  public static async getSessionParticipants(sessionId: string): Promise<SessionParticipant[]> {
    const result = await Database.query(
      `SELECT participant_id, participant_type, fingerprint, scopes
       FROM session_participants WHERE session_id = $1`,
      [sessionId]
    );
    return result.rows.map((row) => ({
      participantId: row.participant_id,
      participantType: row.participant_type,
      fingerprint: row.fingerprint,
      scopes: row.scopes,
    }));
  }

  public static async endSession(sessionId: string, reason = 'Session terminated'): Promise<boolean> {
    const result = await Database.query(
      `UPDATE support_sessions
       SET status = 'ENDED', ended_at = NOW(), end_reason = $2
       WHERE session_id = $1 AND status = 'ACTIVE'
       RETURNING session_id`,
      [sessionId, reason.slice(0, 160)]
    );
    if (result.rowCount) {
      await Database.query(
        `INSERT INTO audit_events (device_id, session_id, category, action, details)
         SELECT device_id, session_id, 'SESSION', 'ENDED', $2::jsonb
         FROM support_sessions WHERE session_id = $1`,
        [sessionId, JSON.stringify({ reason })]
      );
      return true;
    }
    return false;
  }

  public static async expireDueSessions(): Promise<Array<{ sessionId: string; participantId: string }>> {
    return Database.transaction(async (client) => {
      const expired = await client.query(
        `UPDATE support_sessions
         SET status = 'EXPIRED', ended_at = NOW(), end_reason = 'Session expired'
         WHERE session_id IN (
           SELECT session_id FROM support_sessions
           WHERE status = 'ACTIVE' AND expires_at <= NOW()
           ORDER BY expires_at FOR UPDATE SKIP LOCKED
         )
         RETURNING session_id::text`
      );
      if (!expired.rowCount) return [];
      const ids = expired.rows.map((row) => row.session_id);
      const participants = await client.query(
        'SELECT session_id::text, participant_id FROM session_participants WHERE session_id = ANY($1::uuid[])',
        [ids]
      );
      return participants.rows.map((row) => ({ sessionId: row.session_id, participantId: row.participant_id }));
    });
  }

  public static async markExpiredPresenceOffline(): Promise<void> {
    await Database.transaction(async (client: PoolClient) => {
      await client.query('DELETE FROM device_presence WHERE expires_at <= NOW()');
      await client.query('DELETE FROM signaling_connections WHERE expires_at <= NOW()');
      await client.query(
        `UPDATE devices d SET is_online = EXISTS (
           SELECT 1 FROM device_presence p
           WHERE p.device_id = d.device_id AND p.expires_at > NOW()
         )`
      );
    });
  }

  public static async setConnectionOnline(
    entityId: string,
    instanceId: string,
    entityType: 'DEVICE' | 'OPERATOR',
    fingerprint: string
  ): Promise<void> {
    await Database.query(
      `INSERT INTO signaling_connections
       (entity_id, instance_id, entity_type, fingerprint, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '60 seconds')
       ON CONFLICT (entity_id) DO UPDATE SET
         entity_type = EXCLUDED.entity_type,
         fingerprint = EXCLUDED.fingerprint,
         last_seen_at = NOW(),
         expires_at = NOW() + INTERVAL '60 seconds'`,
      [entityId, instanceId, entityType, fingerprint]
    );
  }

  public static async heartbeatConnection(entityId: string, instanceId: string): Promise<void> {
    await Database.query(
      `UPDATE signaling_connections
       SET last_seen_at = NOW(), expires_at = NOW() + INTERVAL '60 seconds'
       WHERE entity_id = $1 AND instance_id = $2`,
      [entityId, instanceId]
    );
  }

  public static async setConnectionOffline(entityId: string, instanceId: string): Promise<void> {
    await Database.query(
      'DELETE FROM signaling_connections WHERE entity_id = $1 AND instance_id = $2',
      [entityId, instanceId]
    );
  }

  public static async isConnectionOwnedByInstance(entityId: string, instanceId: string): Promise<boolean> {
    const result = await Database.query(
      `SELECT 1 FROM signaling_connections
       WHERE entity_id = $1 AND instance_id = $2 AND expires_at > NOW()`,
      [entityId, instanceId]
    );
    return Boolean(result.rowCount);
  }

  public static async isEntityOnline(entityId: string): Promise<boolean> {
    const result = await Database.query(
      `SELECT 1 FROM signaling_connections
       WHERE entity_id = $1 AND expires_at > NOW()
       UNION ALL
       SELECT 1 FROM device_presence
       WHERE device_id = $1 AND expires_at > NOW()
       LIMIT 1`,
      [entityId]
    );
    return Boolean(result.rowCount);
  }

  public static async cancelPendingRequestsByReceiver(receiverId: string): Promise<PairingRequestRecord[]> {
    return Database.transaction(async (client) => {
      const result = await client.query(
        `UPDATE pairing_requests SET status = 'CANCELLED', decided_at = NOW()
         WHERE receiver_id = $1 AND status = 'PENDING'
         RETURNING request_id::text, code_id::text, receiver_id, controller_id,
                   controller_fingerprint, controller_name, requested_scopes,
                   (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint AS expires_at_ms`,
        [receiverId]
      );
      const requests: PairingRequestRecord[] = [];
      const device = await client.query('SELECT device_name FROM devices WHERE device_id = $1', [receiverId]);
      for (const row of result.rows) {
        requests.push({
          requestId: row.request_id,
          codeId: row.code_id,
          receiverId: row.receiver_id,
          receiverName: device.rows[0]?.device_name || 'Receiver',
          controllerId: row.controller_id,
          controllerFingerprint: row.controller_fingerprint,
          controllerName: row.controller_name,
          requestedScopes: row.requested_scopes,
          expiresAt: Number(row.expires_at_ms),
        });
      }
      return requests;
    });
  }

  public static async cancelPendingRequestsByController(controllerId: string): Promise<PairingRequestRecord[]> {
    return Database.transaction(async (client) => {
      const result = await client.query(
        `UPDATE pairing_requests SET status = 'CANCELLED', decided_at = NOW()
         WHERE controller_id = $1 AND status = 'PENDING'
         RETURNING request_id::text, code_id::text, receiver_id, controller_id,
                   controller_fingerprint, controller_name, requested_scopes,
                   (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint AS expires_at_ms`,
        [controllerId]
      );
      const requests: PairingRequestRecord[] = [];
      for (const row of result.rows) {
        const device = await client.query('SELECT device_name FROM devices WHERE device_id = $1', [row.receiver_id]);
        requests.push({
          requestId: row.request_id,
          codeId: row.code_id,
          receiverId: row.receiver_id,
          receiverName: device.rows[0]?.device_name || 'Receiver',
          controllerId: row.controller_id,
          controllerFingerprint: row.controller_fingerprint,
          controllerName: row.controller_name,
          requestedScopes: row.requested_scopes,
          expiresAt: Number(row.expires_at_ms),
        });
      }
      return requests;
    });
  }

  public static async audit(
    actorId: string | null,
    deviceId: string | null,
    category: string,
    action: string,
    details: Record<string, unknown>
  ): Promise<void> {
    await Database.query(
      `INSERT INTO audit_events (actor_id, device_id, category, action, details)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [actorId, deviceId, category.slice(0, 32), action.slice(0, 64), JSON.stringify(details)]
    );
  }
}
