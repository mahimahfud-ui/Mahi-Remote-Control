# Mahi Remote Control

> Owner-approved remote support architecture for Android-to-Android and browser-to-Android connections. Same-Wi-Fi is not a design requirement; both endpoints need Internet access and a reachable public signaling service plus STUN/TURN for difficult NAT paths.

## Current implementation status

**This repository is not yet a complete or release-ready remote-control product.** The latest GitHub snapshot did not contain a native Android WebRTC publisher/receiver. The current working branch deliberately fails closed after MediaProjection consent instead of pretending simulated metrics are live video. The browser client now has a real pairing/offer path, but it cannot receive actual screen frames until the native Android WebRTC media pipeline is implemented.

All work described here is on `work/anywhere-remote-control`. GitHub `main` has not been changed. The Google AI Studio Remix workspace was not available in this implementation session; compare this branch against that workspace before merging so newer workspace work is not overwritten.

### Current branch improvements

- Receiver-approved pairing request lifecycle with hashed, short-lived codes.
- Session-bound tokens and peer-only signaling relay; no broadcast fallback for remote commands.
- Dynamic TURN credential endpoint and explicit public HTTPS/WSS configuration.
- Browser controller no longer uses a fake demo device or synthetic phone screen.
- Simplified Android home screen with two primary actions and a More menu.
- Demo devices, fake default telemetry and synthetic screen-stream metrics removed.
- Backend/Android CI workflow and honest implementation/deployment documentation added.

### Critical remaining work

- Implement Android native WebRTC PeerConnection, MediaProjection video capture/encoding, SDP/ICE handling and remote video rendering.
- Complete Android-to-Android and browser-to-Android end-to-end command/video paths.
- Persist pairing/session state in PostgreSQL or another shared durable store; current backend maps are process memory.
- Deploy and verify a public HTTPS/WSS backend and a real Coturn relay.
- Run the new CI workflow, generate a signed release APK, and test with physical devices and external networks.

See [implementation status](docs/IMPLEMENTATION-STATUS.md) and [public remote deployment](docs/PUBLIC-REMOTE-DEPLOYMENT.md) before using or distributing this branch.

## 📐 Architecture & Monorepo Structure

```
mahi-remote-control/
│
├── app/                        # Android Agent (Live Kotlin + Jetpack Compose App)
│   ├── src/main/java/com/example/
│   │   ├── security/           # DeviceIdentity, AuditLogger, AllowlistValidator
│   │   ├── pairing/            # 6-digit codes, QR generation, trusted controllers
│   │   ├── remotescreen/       # MediaProjection service, H.264 pipeline
│   │   ├── remoteinput/        # AccessibilityService gesture dispatch
│   │   ├── filetransfer/       # Scoped storage SAF file manager
│   │   ├── appmanager/         # Installed packages & launch/uninstall
│   │   ├── diagnostics/        # Hardware telemetry & automated repairs
│   │   ├── rootintegration/    # Magisk detection & signed allowlists
│   │   ├── signaling/          # WebSocket signaling client
│   │   └── ui/                 # Dark Charcoal/Cyan M3 Compose Screens
│
├── windows-controller/         # C# & .NET 10 WPF Desktop Application
│   ├── MahiRemote.sln
│   ├── MahiRemote.App/         # WPF Window, mouse-to-touch canvas, diagnostics
│   ├── MahiRemote.Core/        # Models, Command packets, session state
│   ├── MahiRemote.WebRTC/      # WebSocket signaling & video decoder
│   ├── MahiRemote.Devices/     # Paired device registry
│   └── MahiRemote.Security/    # Cryptographic signing & verification
│
├── backend/                    # Cloud Signaling & Device Management
│   ├── src/index.ts            # Express + WebSocket HTTP server
│   ├── src/signaling/          # Room router, SDP/ICE relay
│   ├── src/device-management/  # Device registry & pairing code consumption
│   └── src/authentication/     # JWT sessions, rate limiting, crypto verification
│
├── infrastructure/             # Database & Deployment
│   ├── database/schema.sql     # PostgreSQL / Supabase schema with RLS policies
│   ├── deployment/docker-compose.yml # Multi-container production stack
│   ├── deployment/coturn.conf  # STUN/TURN server for NAT traversal
│   └── monitoring/prometheus.yml # Telemetry scraping
│
├── docs/                       # Architecture, Protocol & Security Specifications
├── scripts/                    # Automated PowerShell build & test scripts
├── SECURITY.md                 # Security policies & threat model
└── BUILD.md                    # Build and compilation instructions
```

---

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
