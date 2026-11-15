-- Mahi Remote Control backend protocol v1.
-- Applied by backend/src/database/Database.ts; never run by the API client role.

CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  device_name VARCHAR(128) NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint VARCHAR(72) NOT NULL UNIQUE,
  key_version INTEGER NOT NULL DEFAULT 1 CHECK (key_version > 0),
  is_online BOOLEAN NOT NULL DEFAULT FALSE,
  is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_devices_online ON devices(is_online, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS device_challenges (
  challenge_id UUID PRIMARY KEY,
  purpose VARCHAR(16) NOT NULL CHECK (purpose IN ('ENROLL', 'AUTHENTICATE', 'ROTATE')),
  device_id TEXT NOT NULL,
  fingerprint VARCHAR(72) NOT NULL,
  public_key TEXT NOT NULL,
  old_fingerprint VARCHAR(72),
  old_key_version INTEGER,
  nonce VARCHAR(64) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_device_challenges_expiry
  ON device_challenges(expires_at) WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_device_challenges_device
  ON device_challenges(device_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pairing_codes (
  id UUID PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  code_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pairing_codes_device_expiry
  ON pairing_codes(device_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_pairing_codes_expiry
  ON pairing_codes(expires_at) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS pairing_requests (
  request_id UUID PRIMARY KEY,
  code_id UUID NOT NULL REFERENCES pairing_codes(id) ON DELETE CASCADE,
  receiver_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  controller_id TEXT NOT NULL,
  controller_fingerprint VARCHAR(256) NOT NULL,
  controller_name VARCHAR(80) NOT NULL,
  requested_scopes TEXT[] NOT NULL DEFAULT '{}',
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED')),
  expires_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pairing_one_pending_per_receiver
  ON pairing_requests(receiver_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_pairing_requests_expiry
  ON pairing_requests(expires_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_pairing_requests_controller
  ON pairing_requests(controller_id, created_at DESC);

CREATE TABLE IF NOT EXISTS support_sessions (
  session_id UUID PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  controller_id TEXT NOT NULL,
  controller_fingerprint VARCHAR(256) NOT NULL,
  receiver_fingerprint VARCHAR(72) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'ENDED', 'REVOKED', 'EXPIRED')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  end_reason VARCHAR(160)
);

CREATE INDEX IF NOT EXISTS idx_sessions_device_active
  ON support_sessions(device_id, expires_at DESC) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_sessions_expiry
  ON support_sessions(expires_at) WHERE status = 'ACTIVE';

CREATE TABLE IF NOT EXISTS session_participants (
  session_id UUID NOT NULL REFERENCES support_sessions(session_id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL,
  participant_type VARCHAR(16) NOT NULL CHECK (participant_type IN ('DEVICE', 'OPERATOR')),
  fingerprint VARCHAR(256) NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(session_id, participant_id)
);

CREATE INDEX IF NOT EXISTS idx_session_participants_entity
  ON session_participants(participant_id, session_id);

CREATE TABLE IF NOT EXISTS rate_limit_counters (
  bucket_key VARCHAR(512) PRIMARY KEY,
  window_started_at TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS signaling_outbox (
  event_id UUID PRIMARY KEY,
  target_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signaling_outbox_created ON signaling_outbox(created_at);
