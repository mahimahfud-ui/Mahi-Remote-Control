# Mahi Remote Control

> Owner-approved remote support architecture for Android-to-Android and browser-to-Android connections. Same-Wi-Fi is not a design requirement; both endpoints need Internet access and a reachable public signaling service plus STUN/TURN for difficult NAT paths.

## Current implementation status

**Native Android-to-Android WebRTC screen transport is now implemented in source on this working branch, but the branch is not yet verified as a release-ready product.** It includes a receiver-side MediaProjection publisher, a controller-side video receiver, SDP/ICE signaling, a real Android video renderer, owner-visible foreground sharing, and session-authorized remote input. Android CI/build results and two-physical-device end-to-end tests are still required before calling the feature complete.

All work described here is on `work/anywhere-remote-control`. GitHub `main` has not been changed. The Google AI Studio Remix workspace was not available in this implementation session; compare this branch against that workspace before merging so newer workspace work is not overwritten.

### Current branch improvements

- Receiver-approved pairing request lifecycle with hashed, short-lived codes.
- Session-bound tokens and peer-only signaling relay; no broadcast fallback for remote commands.
- Dynamic TURN credential endpoint and explicit public HTTPS/WSS configuration.
- Browser controller no longer uses a fake demo device or synthetic phone screen.
- Simplified Android home screen with two primary actions and a More menu.
- Demo devices, fake default telemetry and synthetic screen-stream metrics removed.
- Backend/Android CI workflow and honest implementation/deployment documentation added.

### Remaining release blockers

- Verify GitHub Actions Android build/unit tests/lint; fix any compile or runtime issues found there.
- Install the same APK on two physical Android phones and verify owner-approved pairing, real decoded video, tap/swipe/navigation, Stop/Disconnect, and reconnect.
- Configure a reachable TURN relay (Coturn or Cloudflare Realtime managed TURN) for networks where direct STUN cannot connect.
- Persist device, pending-pairing and active-session state; current backend registries are in-memory Maps and reset on process restart.
- Verify browser-to-Android separately; the Windows desktop controller has not been completed or tested on this branch.
- Generate a signed release APK after the physical-device tests pass.

**Android consent and platform limits:** The receiving owner must approve pairing, accept Android's screen-sharing prompt, and manually enable Mahi Remote Input in Accessibility settings. Android protected screens (FLAG_SECURE), some system-owned dialogs, and OS restrictions cannot be bypassed. This is owner-approved remote support, not stealth or unrestricted system-level control.

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
