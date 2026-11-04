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

## 🚀 Quick Start Guide

### 1. Android Agent
1. Open the Mahi Remote app on the Android phone.
2. The dashboard shows device telemetry and a 6-digit pairing code (e.g. `729-415`).
3. Tap **Share Screen** to launch the Android MediaProjection consent prompt.
4. Ensure the **Mahi Remote Input Service** is enabled in Android Settings > Accessibility.

### 2. Windows Controller Options

#### Option A: Zero-Install Web Browser Controller (Recommended)
You can control the Android phone directly from **any Windows web browser** (Google Chrome, Microsoft Edge, Firefox, Brave) without installing any client software:
- **Public IP Deployment:** Access via `http://<PUBLIC_IP>:8080` (see [IP Deployment Guide](docs/IP-DEPLOYMENT.md)).
- **Cloudflare Quick Tunnel:** Access via automatically generated `https://<random>.trycloudflare.com` without purchasing a domain (see [Tunnel Deployment Guide](docs/TUNNEL-DEPLOYMENT.md)).
- **Launch with one click:**
  ```powershell
  # For direct Public IPv4 deployment:
  .\scripts\start-public-access.ps1 -Port 8080

  # For zero-domain Cloudflare Tunnel:
  .\scripts\start-cloudflare-tunnel.ps1 -Port 8080
  ```

#### Option B: Native Windows WPF Application
1. Launch `MahiRemote.App.exe` on Windows.
2. Click **+ Pair Device** and enter the 6-digit code shown on the phone.
3. The Android phone displays an authorization dialog with the operator name, location (e.g. *Sylhet NOC*), and requested scopes.
4. Once the phone owner taps **Authorize Session**, the screen mirrors in real-time.
5. Interact with the phone using mouse clicks (taps) and drags (swipes).

---

## 🔒 Security Principles

1. **Explicit Consent Only:** No remote session can start without device-owner approval on the phone.
2. **Visible Notification:** A persistent, non-dismissible foreground notification with a bright red **Stop Sharing** action is displayed during the entire streaming duration.
3. **Emergency Killswitch:** Either party can immediately sever the connection and revoke tokens at any time.
4. **Zero Arbitrary Shell:** Mahi Remote strictly forbids and blocks arbitrary network shell commands. All operations pass through a compiled allowlist validator.
5. **Privacy Preserved:** Sensitive screens flagged with `FLAG_SECURE` (e.g., banking apps, password fields) are automatically blanked by the Android OS.
