# Mahi Remote Control — Remaining Blockers & Production Prerequisites

This document identifies all external prerequisites, missing configurations, credentials, and manual permissions required before deploying Mahi Remote Control to real-world end-user hardware.

---

## 1. External Deployment & Production Prerequisites

| Prerequisite | Category | Required Action | Status / Blocker Description |
|---|---|---|---|
| **Public Domain DNS** | Infrastructure | Configure DNS `A` records for `signaling.mahi-remote.cloud` and `turn.mahi-remote.cloud` | **BLOCKED BY EXTERNAL HOSTING** — Requires operator's cloud server public IP. |
| **TLS / SSL Certificate** | Security | Provision Let's Encrypt or corporate SSL certificate for `wss://` signaling and `turns://` TURN | **BLOCKED BY DOMAIN PREREQUISITE** — Self-signed or local certificates used for sandbox testing. |
| **Windows .NET 10 Build** | Workstation | Compile `MahiRemote.sln` on a Windows 10/11 workstation using `scripts/build-windows.ps1` | **PREREQUISITE FOR WINDOWS HOST** — The Linux container cannot execute Windows PE binaries. |
| **PostgreSQL Cloud Instance** | Database | Deploy `infrastructure/database/schema.sql` to Supabase or managed PostgreSQL 16 instance | **READY FOR DEPLOYMENT** — Schema and RLS policies are fully written and verified. |
| **Coturn Cloud Deployment** | Network Relay | Run `infrastructure/deployment/docker-compose.yml` on a cloud VM with a public IPv4/IPv6 address | **READY FOR DEPLOYMENT** — Coturn configuration tested; requires public IP for NAT traversal. |

---

## 2. Manual Android User Permissions (By Design)

The following permissions are required by the Android operating system and cannot (and must not) be granted silently:

1. **Accessibility Service Activation:**
   - Phone owner must navigate to `Settings > Accessibility > Downloaded Apps > Mahi Remote Input Service` and toggle **ON**.
2. **MediaProjection Screen Recording Consent:**
   - Phone owner must tap **"Start now"** on the Android system MediaProjection dialog when screen sharing begins.
3. **Notification Permission (Android 13+):**
   - Phone owner must allow notifications on first launch to ensure the persistent foreground service notification is visible.
4. **Scoped Storage Grant:**
   - Phone owner grants access to shared Documents/Downloads if browsing outside app internal sandbox.
5. **App Uninstallation Consent:**
   - Phone owner must confirm the system uninstall prompt when an operator requests package removal.

---

## 3. Resolution Plan

1. When deploying to production, point `wss://signaling.mahi-remote.cloud/ws` to the Docker signaling container IP.
2. Distribute `dist/MahiRemote-debug.apk` to the target Android phone in Noakhali.
3. Run `./scripts/build-windows.ps1` on the operator workstation in Sylhet to generate `MahiRemote-Windows-Setup.exe`.
4. Launch both applications and pair via 6-digit one-time code.
