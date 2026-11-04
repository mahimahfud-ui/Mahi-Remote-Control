# Mahi Remote Control — Remote Access Deployment Configuration

This document covers configuration for access across different Wi-Fi/mobile networks. It does not mean remote video control is complete; the Android WebRTC media pipeline is still a release blocker.

## Public URL model

The browser controller and backend must be hosted on a public HTTPS origin. The backend serves:
- Browser controller: `https://<public-host>/connect`
- Runtime config: `https://<public-host>/api/v1/config`
- Signaling: `wss://<public-host>/ws`

The Android app receives the public origin through the non-secret `PUBLIC_BASE_URL` build property or the root `.env` file. Android fetches the WSS endpoint and ICE server configuration from `/api/v1/config`. Do not put JWT or TURN secrets in the Android project.

## Backend environment

Copy `backend/.env.example` to the backend runtime's private environment file and replace every placeholder. For Docker Compose, make the required variables available to Compose from its deployment environment or its ignored `.env` file:

- `PUBLIC_BASE_URL`: the real HTTPS origin, e.g. `https://remote.example.com`.
- `JWT_SECRET`: random secret, at least 32 bytes; never commit it.
- `TURN_SERVER_URL`: actual public Coturn endpoint, e.g. `turn:turn.example.com:3478`.
- `TURN_REALM`: actual TURN server realm/host.
- `TURN_SHARED_SECRET`: a different random secret shared only by the backend and Coturn.
- `POSTGRES_PASSWORD`: database password.
- `STUN_SERVER_URL`: STUN URL.

The Compose configuration fails closed if required secrets/URLs are not supplied. The root `.env.example` is intentionally limited to the public Android build URL so private secrets cannot be copied into the APK by the Android Secrets Gradle plugin.

## TURN/NAT traversal

The backend creates expiring TURN REST credentials using the shared secret. The username contains an expiry timestamp and the credential is an HMAC-SHA1 digest encoded as Base64, matching Coturn's REST authentication scheme. See the [Coturn server documentation](https://github.com/coturn/coturn/wiki/turnserver).

The TURN server must have a public address and firewall access to its listening port and allocated relay UDP port range. A Cloudflare Tunnel can proxy the HTTPS browser UI and WSS signaling endpoint; it does not relay WebRTC UDP media. TURN is required when direct ICE connectivity fails because of NAT/firewall restrictions.

## Build configuration

From a checkout with JDK, Android SDK and a compatible Gradle installation:

```bash
# Public URL is safe to embed in the Android APK.
gradle :app:assembleDebug -PPUBLIC_BASE_URL=https://remote.example.com
gradle :app:assembleRelease -PPUBLIC_BASE_URL=https://remote.example.com

# Backend build and tests.
cd backend
npm ci
npm run build
npm test
```

Release signing still requires a private keystore configured outside source control. Do not upload the keystore to GitHub or include it in a source archive.

## Current backend limitation

Although Compose provisions PostgreSQL, the current pairing/device/session service still uses in-memory Maps. Database persistence, migrations and cross-replica coordination must be implemented before a production deployment can reliably run more than one backend instance or survive restarts.

## Network test matrix still required

| Controller | Receiver | Expected path |
|---|---|---|
| Android Wi-Fi | Android same Wi-Fi | Direct ICE where possible |
| Android mobile data | Android Wi-Fi | Direct ICE or TURN |
| Android carrier A | Android carrier B | Direct ICE where possible; TURN fallback required |
| Windows browser | Android mobile data | WSS signaling + WebRTC direct/TURN |
| iPhone/iPad browser | Android Wi-Fi/mobile | Safari WebRTC support + WSS/TURN |

These are required tests, not verified results.
