# Mahi Remote Control — Branch Implementation Status

**Assessment date:** 2026-11-04  
**Working branch:** `work/remote-access-hardening`  
**Base branch:** `main`  
**Base commit:** `41d6bab20a822b1f5f87c4a88bdc32769377516d`

## Executive status

This branch is a security and UI hardening pass over the GitHub snapshot. It is **not a completed remote-control release**. It does not merge into or modify `main`.

The current Google AI Studio Remix workspace was not available during this work. The branch therefore cannot claim to contain, preserve, or integrate newer workspace-only WebRTC work. Before merging anything, compare this branch against the current Remix workspace and resolve the differences.

## Implemented in this branch (source changes; not yet built or executed)

| Area | Change | Status |
|---|---|---|
| Android home UI | Replaced crowded seven-item primary navigation with “Control another device” and “Share this phone”; moved advanced receiver destinations into More | IMPLEMENTED_NOT_TESTED |
| Android pairing QR | Replaced decorative QR-like pattern with a standards-compliant ZXing QR encoder | IMPLEMENTED_NOT_TESTED |
| Android QR scanner | Uses Google Play Services Code Scanner instead of a manual fake scanner dialog | IMPLEMENTED_NOT_TESTED |
| Pairing screen | Removed seeded demo operator and added a real-backend-configured browser URL display | IMPLEMENTED_NOT_TESTED |
| Browser demo data | Removed hardcoded Samsung device, static telemetry and synthetic remote screen canvas | IMPLEMENTED_NOT_TESTED |
| Browser pairing | Sends `PAIR_BY_CODE`, waits for receiver approval, and accepts server-issued session credentials | IMPLEMENTED_NOT_TESTED |
| Browser WebRTC client | Creates a receive-only video transceiver and sends an SDP offer; displays LIVE only after a real video frame callback | PARTIAL — no Android video sender exists yet |
| Backend approval | Pair code remains pending until explicit receiver approval; rejection does not create a session; code is consumed after approval | IMPLEMENTED_NOT_TESTED |
| Pairing lifecycle | One active code per receiver, 5-minute maximum code lifetime, 2-minute pending request lifetime, one pending request per receiver | IMPLEMENTED_NOT_TESTED |
| Session authorization | 30-minute signed session JWTs, issuer/audience/session ID checks, per-participant authorization on signaling relay | IMPLEMENTED_NOT_TESTED |
| Rate limits | Pairing attempts limited by source IP and controller fingerprint; code regeneration limited by receiver ID | IMPLEMENTED_NOT_TESTED |
| Emergency stop | Authenticated session is revoked server-side even if the other peer is offline | IMPLEMENTED_NOT_TESTED |
| TURN secrets | Hardcoded TURN/JWT/database credentials removed from source and Compose configuration | IMPLEMENTED_NOT_TESTED |
| Runtime configuration | Backend exposes HTTPS/WSS URL and short-lived TURN REST credentials from server environment | IMPLEMENTED_NOT_TESTED |
| Android server config | Android reads the public backend URL at build time and gets WSS/ICE data from the runtime config endpoint | IMPLEMENTED_NOT_TESTED |
| Screen capture truthfulness | Fake FPS/bitrate/frame counters were removed; the app now reports that video transport is not implemented rather than claiming LIVE | BLOCKED — actual WebRTC sender required |

## Release blockers

### 1. Android WebRTC media pipeline — NOT IMPLEMENTED

The Android code does not yet create a `PeerConnectionFactory`, capture a `MediaProjection` stream into a WebRTC video source, encode frames, add a video track, exchange SDP/ICE, or deliver remote frames to the Android viewer. The screen-capture service deliberately stops after reporting this gap, instead of fabricating telemetry.

The browser client can now make a receive-only SDP offer, but it cannot show an Android screen until the Android receiver has a working WebRTC answerer and video sender. Android-to-Android remote viewing is also blocked by this missing media implementation.

### 2. Google AI Studio workspace — NOT REVIEWED

The user identified the current Remix workspace as the source of truth and said it may contain newer WebRTC work. It was not available in this session. This branch is based only on the public GitHub `main` snapshot. Do not overwrite the AI Studio workspace with this branch without a source comparison.

### 3. Public infrastructure — NOT CONFIGURED

A real deployment still needs:
- A public HTTPS origin in `PUBLIC_BASE_URL`.
- Valid TLS for HTTPS and WSS.
- A reachable Coturn host, a random private `TURN_SHARED_SECRET`, and matching Coturn configuration.
- Firewall access to the TURN listener and relay UDP port range.
- A deployed backend serving both `/connect` and `/ws`.

The runtime config intentionally reports browser access as unavailable when `PUBLIC_BASE_URL` is missing or not HTTPS. A private phone IP is not a public endpoint. Cloudflare Tunnel can expose HTTP/WSS but does not replace TURN media relay.

### 4. Backend persistence — NOT IMPLEMENTED

`DeviceService` currently stores devices, pairing codes and sessions in process-local Maps. The PostgreSQL schema and Compose service exist, but the service code does not persist or load these records from PostgreSQL. A restart loses state, and multiple backend replicas will not share pairing/session state. Do not treat this as production-ready or horizontally scalable.

### 5. Device identity proof — INCOMPLETE

Session tokens are signed and checked against the claimed connection ID and fingerprint, but the current WebSocket registration trusts the device ID and fingerprint supplied in client headers. A cryptographic challenge/response proving possession of the Android Keystore private key has not yet been integrated into this branch. The current fingerprint field is therefore not a complete mutual-authentication proof.

### 6. Windows client compatibility — NOT VERIFIED

The legacy Windows client has not been migrated to the new approval and session-token protocol. Do not assume the existing Windows executable still connects successfully to this hardened signaling protocol.

## Verification state

| Verification | Status |
|---|---|
| Source review against GitHub snapshot | COMPLETED |
| Feature branch created; `main` untouched | COMPLETED |
| Backend TypeScript build | NOT RUN |
| Backend integration tests | NOT RUN |
| GitHub Actions backend workflow | Added; no run/check result available at report time |
| Android debug build | NOT RUN |
| Android release build | NOT RUN |
| Android unit/Robolectric tests | NOT RUN |
| Browser tests | NOT RUN |
| Real Android-to-Android test | NOT RUN |
| Real browser-to-Android test | NOT RUN |
| Same-Wi-Fi test | NOT RUN |
| Different-network/TURN relay test | NOT RUN |
| Windows controller test | NOT RUN |

The old `dist/REAL-DEVICE-TEST-REPORT.md` and older “VERIFIED” feature tables must not be treated as evidence of physical-device tests. The checked-in instrumented test is only a basic app-context assertion, and the Robolectric tests exercise local components rather than two physical phones.

## Safe next steps

1. Compare this branch to the current Google AI Studio Remix workspace.
2. Implement the actual Android WebRTC media sender/answerer and Android controller video renderer using the workspace's current architecture.
3. Integrate database-backed atomic pairing/session state and cryptographic device challenge/response.
4. Deploy HTTPS/WSS and Coturn using strong environment secrets.
5. Run the backend workflow and both Android build variants.
6. Test with at least two physical Android devices, then separately test browser-to-Android on another network with TURN forced.
7. Only then mark each scenario VERIFIED.
