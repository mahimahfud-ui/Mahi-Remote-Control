# Mahi Remote Control — Backend Production Report

**Implementation branch:** agent-backend/persistence-deployment  
**Starting integration baseline:** PR #3 head 32260cb511fe21e76028f3d0efd9e4cd94da1840  
**Shared protocol:** v1 — see BACKEND-ANDROID-CONTRACT.md

## 1. Delivered in this branch

### Durable PostgreSQL state

The backend no longer relies on static in-process Maps for device/pairing/session records. The v1 migration creates durable records for:

- Enrolled device public keys, server-calculated fingerprints, key versions, revocation and last-seen/presence data.
- One-time device challenges, including purpose, public-key binding, expiry and consumption.
- HMAC-SHA-256 pairing-code hashes, expiry and consumption state. Raw six-digit codes are not stored.
- Pairing requests, requested scopes, owner decision and expiry.
- Sessions, participant identities, authorization scopes, expiry, termination and revocation.
- Rate-limit counters, audit events, replica connection leases and a signaling outbox.

Database access uses parameterized queries, a pooled PostgreSQL connection, migrations, startup validation, transaction helpers, advisory migration locking and graceful pool shutdown. Pairing-code consumption, owner approval, and session/participant creation occur in a single transaction while locking the receiver row. Only one pending request and one active session are accepted for a receiver. Expiry checks use database timestamps, not only Node timers.

The earlier infrastructure/database/schema.sql is explicitly deprecated. The v1 migration preserves the prior incompatible tables under legacy_*_v1 names; they are not trusted as newly cryptographically enrolled identities or active v1 sessions. Back up any existing database before applying migrations.

### Device identity and authorization

Device enrollment/authentication uses P-256 ECDSA challenge-response:

- SPKI DER Base64 public key, SHA-256 server-derived fingerprint.
- 32-byte cryptographically random Base64URL nonce.
- 120-second, single-use challenges.
- Canonical signed payload as specified in the protocol contract.
- Real ECDSA signature verification; no client-fingerprint or signature-format fallback.
- Separate short-lived device and session JWT audiences/claims.
- Two-signature key rotation (old and new private keys).
- Authenticated device self-revocation, which invalidates the key version, active pairing credentials, presence and sessions.
- Shared PostgreSQL rate limiting for challenge, pairing, code registration and revocation endpoints.

Self-revocation is not an admin remote-revoke feature. Revoking a different device requires a separately authenticated owner/admin control plane and is deliberately not exposed as a public endpoint.

### Signaling, sessions and browser integration

Receiver WebSockets require a currently valid device bearer token. Legacy X-Device-Id or client fingerprint headers are not authentication. Browser controllers use an ephemeral controller identity until an approved session is issued. Every SDP, ICE, input, app, file and diagnostics message requires a valid session JWT, current database participant membership and the required participant scope. The sender's bearer token is removed before relaying a message to the peer.

The backend serves the browser controller from the same HTTPS origin and maintains these flows:

- Runtime config from /api/v1/config.
- Browser pairing-code request and receiver owner approval/rejection.
- Two separate session tokens after approval.
- Authenticated WSS signaling and SDP/ICE exchange.
- Session-scoped remote input, app, file and diagnostics operations.
- TURN REST credentials only for an active participant session.
- Explicit session termination and expiration notification.

WebSocket payloads are limited to 1 MiB; file path and chunk validation imposes a 64 KiB per-chunk bound. File/app/diagnostics messages are relayed only after their corresponding authorization scope is verified.

### Multiple backend replicas

Connected sockets remain local to a process, while durable participant/session state is shared. A PostgreSQL outbox plus LISTEN/NOTIFY and a polling retry path routes messages to the replica that owns the participant's unique connection lease. Leases expire and are renewed by heartbeats. This is designed for multiple backend replicas behind a reverse proxy; production behavior must still be confirmed with the Actions integration suite and an externally deployed environment.

### Infrastructure and CI

- Node 22 multi-stage, non-root backend image including SQL migrations.
- PostgreSQL 16 with a persistent named volume, readiness check and no public database port.
- Caddy reverse proxy for automatic HTTPS and WebSocket proxying.
- Coturn with time-limited shared-secret credentials and a configured UDP relay range.
- Docker Compose health dependencies, restart policy, read-only backend filesystem, dropped Linux capabilities and no-new-privileges.
- Backend Actions workflow provisions a disposable PostgreSQL service, runs the real database integration suite, builds the backend image, syntax-checks the browser client and validates the Compose configuration.

## 2. Protocol and environment

The Android/backend contract is the source of truth for protocol v1. Android must:

1. Generate and retain the P-256 private key only in Android Keystore.
2. Enroll/authenticate with the challenge endpoints before connecting as a receiver.
3. Send the device bearer token in the WebSocket Authorization header.
4. Send protocolVersion: 1 in every WebSocket message and protocolVersion=1 in the WSS query string (or the supported version header).
5. Use the complete server-derived SHA-256 fingerprint; it must not fall back to a placeholder or weak fingerprint when Keystore fails.
6. Obtain TURN credentials only after the owner-approved session is authorized.
7. Use the event names and payload contract in the shared document.

Required production variables:

| Variable | Purpose |
|---|---|
| DOMAIN | Public HTTPS browser/API hostname for Caddy |
| PUBLIC_BASE_URL | Exact public HTTPS origin, e.g. https://remote.example.com |
| ACME_EMAIL | Contact email for Caddy-managed certificates |
| POSTGRES_PASSWORD | Private PostgreSQL password |
| DATABASE_URL | Private PostgreSQL connection URL |
| JWT_SECRET | Independent random JWT signing secret, at least 32 bytes |
| PAIRING_CODE_PEPPER | Independent random pairing-code HMAC secret, at least 32 bytes |
| TURN_SHARED_SECRET | Independent random Coturn shared secret, at least 32 bytes |
| TURN_SERVER_URL | Public Coturn URL, e.g. turn:turn.example.com:3478 |
| TURN_REALM | Coturn realm; use the TURN hostname |
| STUN_SERVER_URL | Public STUN URL |
| PG_POOL_MAX | Per-replica PostgreSQL pool limit; default 10 |
| INSTANCE_ID | Optional unique replica ID; omit to generate one per process |

Generate independent hex secrets on the Linux server with openssl rand -hex 32. Do not reuse a secret for more than one purpose.

## 3. Deployment runbook

1. Provision a Linux host with Docker Engine and the Docker Compose plugin. Assign public DNS A/AAAA records for DOMAIN and the TURN hostname to the host.
2. Allow inbound TCP 80/443, optional UDP 443 for HTTP/3, TCP+UDP 3478 for TURN, and UDP 49152–65535 for TURN relay allocations. PostgreSQL port 5432 must remain private.
3. Create a private root .env from the template and replace all placeholders:
   ~~~bash
   cp infrastructure/deployment/.env.example .env
   openssl rand -hex 32
   ~~~
   Use separate generated values for the database, JWT, pairing pepper and TURN secrets. Set DOMAIN, PUBLIC_BASE_URL, TURN_SERVER_URL, TURN_REALM and ACME_EMAIL to real values.
4. Validate and start:
   ~~~bash
   docker compose --env-file .env -f infrastructure/deployment/docker-compose.yml config
   docker compose --env-file .env -f infrastructure/deployment/docker-compose.yml up -d --build
   docker compose --env-file .env -f infrastructure/deployment/docker-compose.yml ps
   ~~~
5. Verify from a machine outside the server:
   ~~~bash
   curl -fsS https://$DOMAIN/api/v1/health
   curl -fsS https://$DOMAIN/api/v1/ready
   curl -fsS https://$DOMAIN/api/v1/config
   ~~~
   Confirm that the WSS URL is wss://$DOMAIN/ws, then test authenticated receiver enrollment, owner-approved pairing, browser video, and TURN relay from an external network.
6. Back up PostgreSQL before migrations/upgrades:
   ~~~bash
   docker compose --env-file .env -f infrastructure/deployment/docker-compose.yml exec -T postgres-db \
     pg_dump -U mahi_admin -d mahi_remote > mahi-remote-backup.sql
   ~~~

Caddy automatically requests/renews the HTTPS certificate after DNS and public TCP 80/443 are correct. Coturn's current configuration exposes UDP/TCP 3478 with authenticated REST credentials and UDP relay ports. TURN/TLS on 5349 is intentionally disabled until a real Coturn certificate/key pair is provisioned and mounted; do not advertise a turns: URL before that is configured.

To scale the Node signaling backend, leave INSTANCE_ID unset so each process generates its own unique lease ID, then scale the backend service behind Caddy. PostgreSQL must be sized for replica count × PG_POOL_MAX plus listener/administrative connections.

## 4. Verification status and remaining owner actions

This report describes source/configuration committed to the implementation branch. It does not claim that a live backend, DNS name, HTTPS certificate, TURN relay, or Android-to-Android media session has been deployed or externally verified.

- Repository source and configuration edits: committed on the isolated backend branch.
- Backend verification run #85: **PASS** at backend code SHA `dfb157f331f0ce1417798c2993cd9e90f7d2bf89`. TypeScript build, browser syntax checks, PostgreSQL 16-backed integration tests (including two backend processes and cross-instance signaling), migration-context check, production Docker image build, and Docker Compose validation all passed. [GitHub Actions run #85](https://github.com/mahimahfud-ui/Mahi-Remote-Control/actions/runs/43744038565).
- Live server: NOT DEPLOYED. A real host, DNS, firewall access and owner-provided secrets/hosting access have not been supplied.
- TURN relay: configuration is prepared; an external UDP relay test still needs a reachable Coturn host and network.
- Android integration: Agent 1 must implement the published contract in Android source; that source is outside this agent's file ownership.
- End-to-end video: still requires the Android WebRTC capture/encode pipeline and real device/network testing. A signaling/SDP test is not proof of video frames or a working relay.

Do not mark the backend production-ready until the Actions suite passes, Android has integrated protocol v1, a real deployment passes readiness and WSS checks, Coturn relay is tested externally, and physical cross-network video/control tests succeed.
