# Mahi Remote Control

> **Development status — integration and device verification still required.** The repository now contains an Android WebRTC screen-capture/peer-connection implementation and a browser WebRTC receiver. Automated build status is tracked in GitHub Actions; physical-device interoperability, durable backend state and production TURN are not yet verified.

Mahi Remote Control is intended to provide one Android application that can act as either a **Controller** or **Receiver**, plus a browser controller. A controller requests access using a short-lived pairing code. The receiving device owner must explicitly approve the request and grant Android's screen-capture permission before any screen is shared.

## Current implementation branch

The current hardening work is on `work/remote-access-hardening` and PR #2. It includes:

- Two-action Android home screen: **Control another device** and **Share this phone**.
- QR generation and Google Play Services QR scanning.
- Receiver-approved pairing, short-lived session JWTs and session-scoped WebSocket relay.
- Android WebRTC PeerConnection, MediaProjection screen video source, SDP offer/answer and ICE candidate handling.
- Android remote-video rendering through `SurfaceViewRenderer`.
- Browser WebRTC receive-only controller that waits for a real decoded video frame before showing LIVE.
- Browser pairing flow, runtime HTTPS/WSS configuration and a server-side TURN credential endpoint.
- Owner-visible Android foreground screen-sharing notification and an explicit stop action.
- Removal of seeded demo devices and fabricated remote-screen/telemetry claims.

These are source-level features, not proof of end-to-end operation. See [Implementation Status](docs/IMPLEMENTATION-STATUS.md) for the current checks and limitations.

## Known release blockers

- Device, pairing-code and active-session state in `DeviceService` is still held in process-local Maps. The PostgreSQL package, schema and Compose service exist, but the service has not yet been wired to durable, atomic persistence.
- Device registration currently trusts client-supplied device IDs/fingerprints. A challenge/response proving possession of a private key held in Android Keystore is still required.
- A real public HTTPS/WSS host, Coturn deployment, firewall rules and private production secrets must be configured and tested. STUN-only operation is not reliable on every carrier/NAT.
- The latest Android CI run after the Kotlin compile fixes must pass. Earlier Android CI exposed two Kotlin compile errors; fixes have been pushed to PR #2 and verification is running.
- No real two-phone, browser-to-Android, cross-network/forced-TURN or physical remote-input test is claimed.
- The legacy Windows WPF controller has not been migrated and validated against the new approval/session-token protocol.
- PR #2 is based on an earlier `main` snapshot and is two commits behind the current default branch. Preserve the newer restored web UI when reconciling it.
- The current Google AI Studio Remix workspace has not been compared with the repository.

Do not distribute or describe this build as production-ready until the automated checks pass, the remaining backend/security/deployment work is complete, and the physical-device matrix succeeds.

## Architecture & repository structure

```
mahi-remote-control/
├── app/                        # Android APK (Kotlin / Jetpack Compose)
├── backend/                    # Node.js / TypeScript REST + WebSocket signaling
│   └── public/                  # Browser controller (HTML/CSS/JS + WebRTC)
├── windows-controller/          # Legacy Windows WPF controller; migration required
├── infrastructure/              # PostgreSQL schema, Docker Compose and Coturn config
├── docs/                        # Architecture, setup and verification reports
├── scripts/                     # Build and deployment scripts
└── dist/                        # Historical reports; not evidence of current tests
```

## Build and configuration

See [Build Guide](BUILD.md) and [Remote Access Deployment](docs/REMOTE-ACCESS-DEPLOYMENT.md). The root `.env.example` contains only the public Android build URL. Private backend secrets belong in the backend/deployment environment and must never be placed in the APK or browser JavaScript.

## Current development runbook

### Backend

1. Configure the variables in `backend/.env.example` in the deployment environment.
2. Set a real HTTPS `PUBLIC_BASE_URL`, a WSS reverse proxy and public Coturn endpoint.
3. Open the TURN listening and relay ports in the host firewall.
4. From `backend/`, run `npm ci`, `npm run build` and `npm test`.
5. Implement PostgreSQL persistence before using this service for durable or multi-instance production sessions.

### Android

1. Set only the public `PUBLIC_BASE_URL` in the Gradle property or root `.env`.
2. Build with a compatible JDK, Android SDK and Gradle installation.
3. Install the same debug/test build on two physical phones.
4. Pair from one phone, approve on the receiver, grant Android's screen-capture prompt and verify actual decoded video before sending remote input.
5. Verify Stop, permission revocation, app backgrounding, network changes and reconnection.

### Browser

The browser page is served from the backend's public HTTPS origin. It loads runtime WSS/ICE configuration from `/api/v1/config`, requests pairing using the temporary code, and waits for receiver approval. It obtains approved-session TURN credentials from the authenticated endpoint. A configured environment variable alone does not prove TURN reachability; force-relay testing is required.

## Platform/security boundaries

- Receiver approval is required before the backend creates a session.
- Android's native MediaProjection prompt and visible foreground service are mandatory for screen sharing.
- AccessibilityService must be manually enabled by the device owner for supported remote input.
- Protected `FLAG_SECURE` surfaces remain protected.
- A standard Android app cannot bypass system permission dialogs, silently unlock protected screens, or silently install/uninstall apps.
- Database persistence, cryptographic device challenge/response, public TURN and physical end-to-end testing remain release blockers.

See [Implementation Status](docs/IMPLEMENTATION-STATUS.md), [Remaining Blockers](docs/REMAINING_BLOCKERS.md), [Remote Access Deployment](docs/REMOTE-ACCESS-DEPLOYMENT.md), and [Android API Limitations](docs/ANDROID_API_LIMITATIONS.md).
