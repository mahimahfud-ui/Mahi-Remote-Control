# Mahi Remote Control

> **Development status — incomplete.** This repository is not currently a production-ready remote-control release. The checked-in Android source does not yet contain a working WebRTC screen sender/answerer, so real remote screen video is not available in this snapshot.

Mahi Remote Control is intended to be one Android application that can act as either a **Controller** or **Receiver**, plus a browser controller that can connect to a receiver over the public internet. The two devices do not need to share the same Wi-Fi network, but they do need working internet access, a public HTTPS/WSS backend, and a reachable STUN/TURN configuration.

## Current branch work

The security/UI hardening work is being developed on `work/remote-access-hardening`. It does not modify `main`.

- Two-action Android home screen: **Control another device** and **Share this phone**.
- QR generation and Google Play Services QR scanning.
- Approval-gated temporary pairing with server-issued session tokens.
- Browser pairing flow using the same temporary code and receiver approval.
- HTTPS/WSS and TURN runtime configuration from server environment variables.
- Fake Android demo device/telemetry/screen placeholders removed.
- Advanced receiver tools moved into a More menu.

These are source changes only; they have not yet been built or run through the test suite. See [Implementation Status](docs/IMPLEMENTATION-STATUS.md) for the exact verification state and blockers.

## Important limitations

- **Real WebRTC media is not implemented in the Android app yet.** The screen capture service currently reports this honestly instead of displaying fake FPS or claiming LIVE.
- Backend device, pairing and session state is still held in process-local memory, not PostgreSQL.
- Device identity registration still needs a cryptographic challenge/response proof.
- The current GitHub branch has not been compared with the user's newer Google AI Studio Remix workspace.
- No physical two-phone, browser, Windows, cross-network or TURN-relay test is claimed.

Do not distribute this snapshot as a working remote-control release until those blockers are resolved.

## Architecture & repository structure

```
mahi-remote-control/
├── app/                        # One Android APK (Kotlin / Jetpack Compose)
├── backend/                    # Node.js / TypeScript REST + WebSocket signaling
│   └── public/                 # Browser controller
├── windows-controller/         # Legacy Windows WPF controller (compatibility not verified)
├── infrastructure/             # PostgreSQL schema, Docker Compose and Coturn config
├── docs/                       # Architecture, setup and verification reports
├── scripts/                    # Build and deployment scripts
└── dist/                       # Historical reports (superseded where noted)
```

## Build and configuration

See [Build Guide](BUILD.md) and [Remote Access Deployment](docs/REMOTE-ACCESS-DEPLOYMENT.md). The root `.env.example` contains only the public Android build URL. Private backend secrets belong in the backend/deployment environment and must never be placed in the APK or browser JavaScript.

## Current development runbook

The branch UI and server protocol are being developed, but the missing Android WebRTC sender means this is not yet a working remote-screen session.

### Backend

1. Set the private runtime variables from `backend/.env.example` in your deployment environment.
2. Configure a real HTTPS `PUBLIC_BASE_URL`, WSS reverse proxy and public Coturn server.
3. Open the required TURN listening and relay ports in the VPS firewall.
4. From `backend/`, run `npm ci`, `npm run build` and `npm test`.

### Android

1. Set only the public `PUBLIC_BASE_URL` in the Android Gradle property or root `.env`.
2. Build with a compatible JDK, Android SDK and Gradle installation.
3. Install the same APK on both phones.
4. The intended UI has “Control another device” and “Share this phone”; pairing approval requires interaction on the receiver.
5. Do not expect live video until the Android WebRTC media pipeline is implemented.

### Browser

The browser page is served from the backend's public HTTPS origin. It loads its WSS/ICE configuration from `/api/v1/config`, submits the same temporary pairing code, and waits for receiver approval. TURN must be actually deployed; a configured environment variable by itself does not prove reachability.

## Platform/security boundaries

- Receiver approval is required before the backend creates a session.
- MediaProjection consent and the foreground screen-sharing notification are Android requirements; this branch currently does not stream video after consent because no WebRTC sender is present.
- AccessibilityService must be manually enabled by the device owner.
- Protected `FLAG_SECURE` surfaces remain protected.
- Standard Android apps cannot bypass system permission dialogs, unlock secure lock screens, or silently install/uninstall apps.
- Database persistence and cryptographic device challenge/response are still release blockers.

See [Implementation Status](docs/IMPLEMENTATION-STATUS.md), [Remote Access Deployment](docs/REMOTE-ACCESS-DEPLOYMENT.md), and [Android API Limitations](docs/ANDROID_API_LIMITATIONS.md).
