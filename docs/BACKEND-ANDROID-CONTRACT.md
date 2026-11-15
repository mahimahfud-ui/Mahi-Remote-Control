# Mahi Remote Control — Android / Backend Contract

**Status:** Protocol v1 proposal published for coordinated implementation  
**Applies to:** Android receiver, browser controller, backend REST API, WebSocket signaling  
**Target integration baseline:** PR #3 head `32260cb511fe21e76028f3d0efd9e4cd94da1840`  
**Compatibility rule:** v1 is fail-closed. A receiver that cannot prove possession of its Android Keystore private key must not register, publish pairing codes, approve a pairing, or start screen sharing.

This contract is the shared implementation interface. Agent 1 should implement the Android calls and messages exactly as specified. Backend implementation must preserve these names and schemas unless a breaking change is first coordinated in the PR #3 conversation.

## 1. Protocol and transport

- Protocol version: `1`.
- REST base: `/api/v1`.
- WebSocket path: `/ws`.
- Production REST transport: HTTPS only.
- Production signaling transport: WSS only.
- Requests should send `X-Mahi-Protocol-Version: 1`. Responses include `X-Mahi-Protocol-Version: 1`.
- JSON uses UTF-8. Timestamps named `expiresAtMs` or `tokenExpiresAtMs` are Unix epoch milliseconds. Timestamps named `expiresInSeconds` are durations.
- Do not silently downgrade to client-supplied IDs/fingerprints or unauthenticated receiver registration. Unsupported versions return HTTP 426 or close the WebSocket with code 1002.

## 2. Device identity and key format

The receiver creates one ECDSA key pair in Android Keystore:

| Property | Required value |
|---|---|
| Curve | NIST P-256 / `secp256r1` |
| Signature | `SHA256withECDSA` |
| Public-key encoding | X.509 SubjectPublicKeyInfo DER, standard Base64 |
| Signature encoding | ASN.1 DER ECDSA signature, standard Base64 |
| Private-key storage | Android Keystore only; never serialized or uploaded |
| Fingerprint | `sha256:<64 lowercase hex characters>`, SHA-256 of the decoded DER public-key bytes |

The backend validates that the supplied public key is an EC key on P-256. It independently calculates the fingerprint. A client-supplied fingerprint is display metadata only and is never proof of identity.

The Android client must fail closed if Android Keystore key creation or signing fails. It must not replace the public key with a hash, random string, or JVM-test fallback. The public key may be re-sent when requesting an enrollment challenge; the server stores only the validated public key and its derived fingerprint.

## 3. Challenge proof format

Challenges contain 32 cryptographically random bytes encoded as unpadded Base64URL. They are single-use and expire 120 seconds after issuance. Each challenge is bound server-side to its purpose, device ID, public-key fingerprint, nonce, and expiry.

The client signs this exact UTF-8 message (LF line endings, no trailing newline):

```text
MAHI-REMOTE-DEVICE-PROOF
1
{purpose}
{challengeId}
{deviceId}
{fingerprint}
{nonce}
{expiresAtMs}
```

- `purpose` is exactly `ENROLL`, `AUTHENTICATE`, or `ROTATE`.
- `challengeId` is the server-issued UUID.
- `fingerprint` is the server-derived fingerprint returned in the challenge response.
- `expiresAtMs` is the exact integer returned by the server.
- The signature is ECDSA P-256 / SHA-256 over the UTF-8 bytes of the complete message above.
- Verify signatures against the server-stored or challenge-bound public key. Reject malformed keys, signatures, expired challenges, consumed challenges, mismatched fields and replay attempts.

## 4. REST endpoints

All request bodies below are JSON. Error responses use the common error schema in section 5.

### 4.1 Runtime configuration

**GET** `/api/v1/config` — public, no authentication.

Response:

```json
{
  "protocolVersion": 1,
  "browserAccessConfigured": true,
  "publicBaseUrl": "https://remote.example.com",
  "browserAccessUrl": "https://remote.example.com/connect",
  "signalingUrl": "wss://remote.example.com/ws",
  "turnConfigured": true,
  "iceServers": [{ "urls": "stun:stun.example.net:3478" }],
  "sessionTtlSeconds": 1800,
  "deviceChallengeTtlSeconds": 120
}
```

Never include `JWT_SECRET`, `TURN_SHARED_SECRET`, database credentials, TURN REST credentials, internal hostnames, or private infrastructure details in this response.

### 4.2 Initial device enrollment challenge

**POST** `/api/v1/devices/enrollment/challenges` — public, rate-limited.

Request:

```json
{
  "protocolVersion": 1,
  "deviceId": "MAHI-ABC-12345678",
  "deviceName": "Manufacturer Model",
  "publicKey": {
    "format": "spki-der-base64",
    "algorithm": "EC",
    "curve": "P-256",
    "value": "<base64 DER SubjectPublicKeyInfo>"
  }
}
```

Response (201):

```json
{
  "protocolVersion": 1,
  "challengeId": "4f3c8ed8-7ea6-4c3b-9f57-9f6e0a3f7ca1",
  "purpose": "ENROLL",
  "nonce": "<32 random bytes, base64url>",
  "fingerprint": "sha256:<64 lowercase hex characters>",
  "signatureAlgorithm": "SHA256withECDSA",
  "expiresAtMs": 1790000000000
}
```

The device ID must be syntactically valid and unique. A repeated enrollment for an existing ID must not silently replace its key; use the key-rotation flow.

### 4.3 Verify enrollment proof

**POST** `/api/v1/devices/enrollment/verify` — public, rate-limited.

Request:

```json
{
  "protocolVersion": 1,
  "challengeId": "4f3c8ed8-7ea6-4c3b-9f57-9f6e0a3f7ca1",
  "signature": "<base64 ASN.1 DER ECDSA signature>"
}
```

Response (201):

```json
{
  "protocolVersion": 1,
  "deviceId": "MAHI-ABC-12345678",
  "fingerprint": "sha256:<64 lowercase hex characters>",
  "deviceAccessToken": "<short-lived JWT>",
  "tokenType": "Bearer",
  "expiresInSeconds": 900
}
```

Enrollment proof consumption and device insertion must be one transaction. The server issues a short-lived device token only after successful proof verification. Replaying the same challenge must fail.

### 4.4 Authenticate an enrolled device

**POST** `/api/v1/devices/auth/challenges` — public, rate-limited.

Request:

```json
{ "protocolVersion": 1, "deviceId": "MAHI-ABC-12345678" }
```

Response: same challenge envelope as enrollment, with `purpose: "AUTHENTICATE"`; fingerprint and key are taken from the enrolled record.

**POST** `/api/v1/devices/auth/verify` — public, rate-limited.

Request: `{ "protocolVersion": 1, "challengeId": "<uuid>", "signature": "<base64 DER>" }`.

Response: same device-token envelope as enrollment. Authentication challenges are one-use. Device key revocation or rotation invalidates old device tokens immediately through a persisted key version/revocation check.

### 4.5 Rotate a device key

**POST** `/api/v1/devices/key-rotation/challenges` — requires the current device bearer token.

Request:

```json
{
  "protocolVersion": 1,
  "newPublicKey": {
    "format": "spki-der-base64",
    "algorithm": "EC",
    "curve": "P-256",
    "value": "<new key DER>"
  }
}
```

Response: challenge envelope with `purpose: "ROTATE"` and the new key's server-derived fingerprint. The challenge is bound to the authenticated device ID, old key version and new public key.

**POST** `/api/v1/devices/key-rotation/verify` — requires the current device bearer token.

Request:

```json
{
  "protocolVersion": 1,
  "challengeId": "<uuid>",
  "oldKeySignature": "<signature by currently enrolled private key>",
  "newKeySignature": "<signature by new private key>"
}
```

Both signatures cover the canonical ROTATE challenge message in section 3. The old signature authorizes rotation and the new signature proves possession of the replacement private key. Update the public key and key version atomically; revoke old device tokens and sessions according to the documented security policy. No private key is ever sent to the server.

### 4.6 Revoke this receiver identity

**POST** `/api/v1/devices/{deviceId}/revoke` — requires the current device bearer token and the path `deviceId` must match the authenticated token subject.

Request: `{ "protocolVersion": 1 }`.

Response:

```json
{
  "protocolVersion": 1,
  "success": true,
  "revokedDeviceId": "MAHI-ABC-12345678",
  "endedSessionCount": 1
}
```

The operation is atomic: mark the device identity revoked, increment its key version, consume active pairing codes owned by that device, cancel pending requests where the device is receiver or controller, remove presence/connection leases, revoke active sessions where it is either participant, and write an audit event. Other session participants are notified through the cross-instance signaling outbox. The old device token and WebSocket are rejected on the next authorization check. This endpoint only lets a device revoke itself; revoking a different device requires a separate owner/admin authorization system and is not exposed by this protocol.

### 4.7 TURN credentials

**GET** `/api/v1/turn-credentials` — requires `Authorization: Bearer <sessionToken>`.

The backend must verify that the token belongs to a current, unexpired session participant and that the database session is still ACTIVE. Response:

```json
{
  "protocolVersion": 1,
  "iceServers": [
    { "urls": "stun:stun.example.net:3478" },
    {
      "urls": "turn:turn.example.net:3478",
      "username": "<expiry-epoch:opaque-user>",
      "credential": "<time-limited HMAC credential>"
    }
  ],
  "turnConfigured": true,
  "expiresInSeconds": 600
}
```

The expiry in the TURN username must be no more than 10 minutes ahead. TURN credentials are never returned by public runtime configuration or before an approved session.

### 4.8 Terminate a session

**POST** `/api/v1/sessions/{sessionId}/terminate` — requires the participant session token for that same session.

Response: `{ "protocolVersion": 1, "success": true }`. Termination is idempotent from the client perspective; an already-ended session returns 404 or 409 with a stable error code. The service must revoke both participants' authorization and publish a session-ended event to all backend replicas.

### 4.9 Health and readiness

**GET** `/api/v1/health` — liveness only; may succeed while the DB is unavailable.

**GET** `/api/v1/ready` — readiness; succeeds only when PostgreSQL is connected, migrations are current, and required signaling infrastructure is initialized. It must return 503 while dependencies are not ready.

## 5. Authentication and error contract

### Device bearer token

The device JWT is separate from a session JWT. Required claims: `iss=mahi-remote`, `aud=mahi-remote-device`, `sub=<deviceId>`, `fp=<server fingerprint>`, `keyVersion=<integer>`, `typ=DEVICE`, `iat`, `exp`. Suggested lifetime: 15 minutes. It authorizes only device-level operations such as an authenticated receiver WebSocket and key rotation; it does not authorize remote control by itself.

### Session bearer token

Each participant receives a separate session JWT after receiver approval. An enrolled Android device used as the controller receives `type=DEVICE`; a browser or legacy Windows controller receives `type=OPERATOR`. The persisted participant type must match the token type. Required claims: `iss=mahi-remote`, `aud=mahi-remote-session`, `sub=<participantId>`, `type=DEVICE|OPERATOR`, `fp=<participant fingerprint>`, `sid=<sessionId>`, `iat`, `exp`. Suggested lifetime: 30 minutes, never longer than the database session expiry. Every protected operation must also query/check current durable session status and participant membership; a valid JWT alone is insufficient after revocation.

### Common error body

```json
{
  "protocolVersion": 1,
  "error": {
    "code": "CHALLENGE_EXPIRED",
    "message": "The device challenge has expired.",
    "retryable": true,
    "requestId": "<correlation-id>"
  }
}
```

Stable codes include: `INVALID_PROTOCOL_VERSION`, `INVALID_REQUEST`, `INVALID_PUBLIC_KEY`, `DEVICE_ALREADY_ENROLLED`, `DEVICE_NOT_FOUND`, `CHALLENGE_NOT_FOUND`, `CHALLENGE_EXPIRED`, `CHALLENGE_REPLAYED`, `INVALID_SIGNATURE`, `DEVICE_REVOKED`, `RATE_LIMITED`, `PAIRING_CODE_INVALID`, `PAIRING_CODE_EXPIRED`, `PAIRING_CODE_USED`, `PAIRING_ALREADY_PENDING`, `RECEIVER_OFFLINE`, `SESSION_ALREADY_ACTIVE`, `SESSION_EXPIRED`, `SESSION_REVOKED`, `NOT_SESSION_PARTICIPANT`, `TURN_NOT_CONFIGURED`, and `INTERNAL_ERROR`.

HTTP status mapping: 400 malformed payload; 401 missing/invalid credentials or signature; 403 valid identity without permission; 404 unknown resource; 409 state/concurrency conflict; 410 retired endpoint; 413 oversized payload; 426 unsupported protocol version; 429 rate limit; 500 unexpected internal error; 503 dependency unavailable.

WebSocket errors retain the event envelope and carry `errorCode` plus a human-readable `error` string so existing UI can display failures without parsing server internals.

## 6. WebSocket handshake and events

Connect to `wss://<PUBLIC_BASE_URL-host>/ws`.

### Receiver

The Android receiver first completes enrollment/authentication. It connects with:

- `Authorization: Bearer <deviceAccessToken>`
- `X-Mahi-Protocol-Version: 1`
- Optional descriptive `X-Device-Name`; identity and fingerprint are loaded from the verified token/database, not trusted from headers.

The receiver must not connect as an authenticated device until the challenge proof succeeds. On reconnect, it obtains a fresh device token if needed, then reconnects. On invalid/expired/revoked token the server closes with policy code 1008; the Android client re-authenticates instead of falling back to unauthenticated registration.

### Browser controller

A browser controller may open a pre-session WebSocket without a device bearer token and identify its ephemeral controller instance with a generated random `controllerFingerprint` query parameter containing 8–256 URL-safe characters. This identifier is not treated as receiver-device proof. The browser receives a session JWT only after the receiver explicitly approves its pairing request. After approval, every signaling/control message includes that participant's `sessionToken`.

### Pairing and owner approval

Events (all client messages include `protocolVersion: 1`):

| Event | Direction | Required fields / behavior |
|---|---|---|
| `PING` | Either → server | Optional timestamp; returns PONG |
| `PONG` | Server → client | Server timestamp |
| `REGISTER` | Receiver → server | Informational only after device bearer auth; never enrolls a device |
| `REGISTER_ACK` | Server → receiver | Verified device ID and protocol version |
| `REGISTER_PAIRING_CODE` | Receiver → server | `code` (six digits), `expiresAtMs`; authenticated device only |
| `CODE_REGISTERED_ACK` | Server → receiver | Code expiry and registration status; do not echo the raw code |
| `PAIR_BY_CODE` / `PAIR_CODE_CONNECT` | Controller → server | `code`, `operatorName`, `requestedScopes[]`; fingerprint comes from controller connection identity |
| `PAIR_REQUEST` | Server → receiver | `requestId`, controller ID/name, requested scopes, timestamp and expiry |
| `PAIR_PENDING` | Server → controller | `requestId`, receiver ID, expiry, pending state |
| `PAIR_ACCEPT` | Receiver → server | `requestId`, explicit owner approval; receiver device bearer auth required |
| `PAIR_SESSION_AUTHORIZED` | Server → receiver | `sessionId`, receiver's own `sessionToken`, token expiry |
| `PAIR_ACCEPT` | Server → controller | `sessionId`, controller's own `sessionToken`, token expiry, receiver metadata |
| `PAIR_REJECT` | Receiver → server / server → controller | Explicit owner rejection; no session is created |
| `PAIR_ERROR` | Server → client | Pairing error code/message; no session is created |

Pairing requests expire after 2 minutes. A pairing code expires within 5 minutes, is single-use, and is consumed only inside the same database transaction that records owner approval and creates the session. Only one pending request and one active session are allowed per receiver. A browser cannot approve its own request or claim to be the receiver.

### Authorized session signaling

Every event below requires the participant's `sessionToken`; the server verifies current DB session state and participant membership before forwarding. The recipient is derived from the durable session participant row; a client-supplied target cannot select a different peer.

- WebRTC: `SDP_OFFER`, `SDP_ANSWER`, `ICE_CANDIDATE`; receiver display metadata: `DISPLAY_INFO`.
- Remote input: `INPUT_EVENT` with a bounded command object; the Android app remains responsible for applying its own action allowlist.
- Applications: the current browser sends `APP_COMMAND` with `action: "LIST" | "LAUNCH" | "STOP"` and `packageName` for package-specific actions. The receiver responds with `APP_LIST_RESPONSE` and its real app data. The server also accepts the legacy granular aliases `APP_LIST_REQUEST`, `APP_LAUNCH`, and `APP_STOP`.
- Files: the current browser sends `FILE_COMMAND` with `action: "LIST" | "DELETE" | "READ_CHUNK" | "WRITE_CHUNK"`. Common fields are `path`; reads also carry `offset` and `length`; writes carry Base64 `data` and `append`. The receiver responds with `FILE_CHUNK_RESPONSE`, `FILE_WRITE_ACK`, and/or `FILE_OPERATION_RESULT`. The server also accepts the legacy granular aliases `FILE_LIST_REQUEST`, `FILE_READ_REQUEST`, `FILE_TRANSFER`, `FILE_UPLOAD_START`, `FILE_UPLOAD_CHUNK`, `FILE_UPLOAD_ACK`, `FILE_UPLOAD_COMPLETE`, and `FILE_DELETE_REQUEST`.
- Diagnostics: the current browser sends `DIAGNOSTICS_RUN`; the receiver responds with `DIAGNOSTICS_RESULT`. The server also accepts `DIAGNOSTICS_REQUEST` and `DIAGNOSTICS_RESPONSE` aliases.
- Lifecycle: `EMERGENCY_DISCONNECT`, `SESSION_ENDED`, `SESSION_ERROR`, `SIGNALING_ERROR`.

All these messages are session-token authorized and routed only to the other participant recorded in PostgreSQL. The server verifies the current session, participant fingerprint and scope before forwarding. The browser's app/file/diagnostics messages are not privileged merely because they are browser messages.

File paths are limited to 1024 characters and traversal segments are rejected. Read offsets must be non-negative safe integers and each read length is 1–65536 bytes. Upload chunks must be valid Base64 and decode to at most 65536 bytes. The Android receiver must additionally validate canonical paths, file permissions, upload sequencing and per-session storage limits before performing filesystem operations. A server relay acknowledgement is not evidence that a device completed the operation.

For multiple backend replicas, connected sockets remain process-local, but session/pairing state is durable. Cross-instance delivery must use shared coordination (PostgreSQL notification/outbox or an equivalent pub/sub) and must be tested with clients connected to different replicas. A single process-local socket map is not a production multi-replica design.

## 7. Persistence and transaction invariants

At minimum, persist:

- Device ID, display name, public key DER, derived fingerprint, key version, revoked state, online state and last-seen time.
- Challenge purpose, nonce hash, fingerprint/key binding, device ID, expiry and consumption timestamp.
- Pairing code HMAC/hash, device, expiry, consumption timestamp and status. Never store plaintext codes.
- Pairing request, requested scopes, controller/receiver participants, status, owner approval/rejection and expiry.
- Session metadata, expiry, state, termination/revocation reason and both participant identities/fingerprints.
- Session participant authorization and scopes.
- Audit records for enroll, authenticate, key rotation, pair approve/reject, session create/end/revoke.

Use parameterized SQL, migrations, indexes and foreign keys. Use transactions with row locks or equivalent serialization for challenge consumption, pairing-code consumption, approval and session creation. Expiry must be checked in database queries, not only via Node timers. Timers are notifications/cleanup aids, not authorization controls. Connected WebSocket objects and short-lived in-flight socket state are ephemeral and should not be serialized to the database.

## 8. Security requirements

- Never trust device ID/fingerprint headers as authentication.
- Never store or transmit private keys.
- Compare signatures using Node's crypto implementation, not a length/syntax fallback.
- Rate-limit enrollment/authentication challenges, proof failures, code registration and pairing attempts by IP and device identifier. Use a shared limiter or DB-backed atomic counters for multiple replicas.
- Hash pairing codes with HMAC-SHA-256 using a private server-only pepper; do not store plaintext six-digit codes.
- Enforce JSON and WebSocket message size limits.
- Validate CORS and WebSocket Origin against the configured HTTPS origin.
- Keep JWT and TURN secrets on the backend only.
- Require HTTPS/WSS externally; PostgreSQL must not be public.
- Treat offline presence as advisory; session membership and revocation are authoritative.

## 9. Required server environment

- `NODE_ENV`, `PORT`, `HOST`
- `PUBLIC_BASE_URL` — real HTTPS browser/API origin
- `JWT_SECRET` — high-entropy random server-only secret, minimum 32 bytes
- `PAIRING_CODE_PEPPER` — separate high-entropy server-only secret
- `DATABASE_URL` — private PostgreSQL connection string
- `PG_POOL_MAX`, optional connection/pool timeouts
- `STUN_SERVER_URL`
- `TURN_SERVER_URL`, `TURN_REALM`, `TURN_SHARED_SECRET` — private Coturn shared secret
- `TRUST_PROXY` — only when deployed behind a known reverse proxy

Production must provide persistent PostgreSQL storage, TLS termination/reverse proxy, Coturn public UDP relay range and health/readiness checks. Never place database/JWT/TURN/pepper secrets in Android Gradle configuration or browser JavaScript.

## 10. Compatibility and rollout

- Protocol v1 has no insecure downgrade.
- Android must deploy the DeviceIdentity proof flow before the backend requires authenticated receiver WebSockets.
- Browser controller pairing remains owner-approved; it receives no remote-control authority until the server issues a session token.
- Old clients that only send `X-Device-Id` / `X-Device-Fingerprint` headers are rejected for receiver registration. They may not silently fall back.
- If an event payload must change, update this contract and coordinate with Agent 1 before merging the backend change.
- This document defines the contract; it does not claim that the listed endpoints, persistence, TURN or live deployment are already implemented.
