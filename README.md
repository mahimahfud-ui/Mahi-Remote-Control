# Mahi Remote Control

> **Development status — production infrastructure is prepared in the backend integration branch; Android protocol integration and physical interoperability tests remain required.** This is not yet a verified public remote-control service.

Mahi Remote Control is intended to provide one Android application that can act as either a **Controller** or **Receiver**, plus a browser controller. A controller requests access using a short-lived pairing code. The receiving device owner must explicitly approve the request and grant Android's screen-capture permission before any screen is shared.

## Backend architecture

The backend implementation is being integrated through the stacked branch `agent-backend/persistence-deployment`, based on PR #3's `fix/full-remote-workflow` head.

- PostgreSQL migrations and pooled parameterized access replace process-local device, pairing-code and session Maps.
- Android device enrollment/authentication uses a server challenge and ECDSA P-256 proof backed by the Android Keystore private key.
- Pairing codes are HMAC-hashed, short-lived and single-use; owner approval consumes the code and creates the session in one database transaction.
- Session JWTs are issued separately to each participant. Every signaling/control operation checks persisted membership, expiry, revocation and scope.
- Cross-instance WebSocket delivery uses a PostgreSQL outbox with `LISTEN/NOTIFY` and a retry poller. Live sockets remain ephemeral and are tracked with database leases.
- Public runtime configuration never returns TURN credentials. Approved participants obtain time-limited TURN REST credentials from the authenticated endpoint.
- Docker Compose provisions private PostgreSQL, Node.js, Caddy HTTPS/WSS reverse proxy and Coturn.

Read [Backend–Android Contract](docs/BACKEND-ANDROID-CONTRACT.md) before changing the client or server protocol. Read [Backend Production Report](docs/BACKEND-PRODUCTION-REPORT.md) for environment variables, deployment commands, endpoint checks and outstanding release gates.

## Repository structure

```
mahi-remote-control/
├── app/                         # Android APK (Kotlin / Jetpack Compose)
├── backend/                     # Node.js / TypeScript REST + WebSocket signaling
│   ├── migrations/               # Versioned PostgreSQL migrations
│   └── public/                   # Browser controller (HTML/CSS/JS + WebRTC)
├── windows-controller/          # Legacy Windows WPF controller; migration required
├── infrastructure/              # Docker Compose, Caddy and Coturn configuration
├── docs/                         # API contract, deployment and verification docs
└── scripts/                      # Build and deployment helpers
```

## Backend local checks

The backend verification workflow runs a disposable PostgreSQL 16 service, applies migrations, compiles TypeScript, checks browser JavaScript syntax and runs database-backed integration tests.

For a local backend run, use the deployment environment described in [Backend Production Report](docs/BACKEND-PRODUCTION-REPORT.md). Required commands:

```bash
cd backend
npm ci
npm run build
npm test
```

## Android and browser verification

The current Agent 1 Android client must implement the protocol in [docs/BACKEND-ANDROID-CONTRACT.md](docs/BACKEND-ANDROID-CONTRACT.md): device enrollment/authentication, Android Keystore signing, device bearer token WebSocket authentication, protocol version 1, and the defined pairing/session event fields. Existing client-supplied device IDs/fingerprints are not authentication.

No physical two-phone, browser-to-Android, cross-network/forced-TURN or Windows interoperability test is claimed. Release signing requires a private keystore outside source control. Do not distribute or describe this product as production-ready until Android and backend CI pass together, the real host/DNS/TLS/TURN deployment is verified, and the physical-device matrix succeeds.

## Security boundaries

- Receiver approval is mandatory before a remote session starts.
- Android's native MediaProjection consent and visible foreground service remain mandatory.
- Device identity private keys stay in Android Keystore; server JWT, pairing pepper, database and TURN secrets stay server-side.
- No public device enumeration, fake devices, fake video, fabricated file listings or fabricated telemetry.
- Protected `FLAG_SECURE` content remains protected.
- AccessibilityService must be explicitly enabled by the device owner for supported remote input.
- Standard Android permission dialogs and operating-system security boundaries are not bypassed.
