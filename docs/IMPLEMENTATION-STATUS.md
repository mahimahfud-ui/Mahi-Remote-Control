# Mahi Remote Control — Implementation and Verification Status

**Assessment date:** 2026-11-15  
**Branch:** `repair/remote-control-hardening`  
**PR:** Repair branch created from the current default branch; PR creation follows verification.  
**Base commit at assessment:** `3029c010ced80dbd43b94cff0aed0d47d7521bb0`  
**Current default branch at assessment:** `main` (`3029c010ced80dbd43b94cff0aed0d47d7521bb0`)

## Executive status

This repair branch was created directly from the current `main` commit, preserving the restored browser UI. It carries the Android WebRTC/owner-approval implementation plus a corrected browser session-token/TURN flow and test/security fixes. It is not yet a verified end-to-end remote-control release. The latest recorded Android run on the earlier hardening branch compiled the debug APK successfully but failed two Robolectric pairing-lifecycle assertions; those tests are updated on this repair branch and must pass in the new Actions run. The backend changes also require a fresh CI run.

The repair branch starts at the current `main` commit; it does not need the old PR #2 branch merged into it. PR #1 and PR #2 remain separate overlapping proposals and should be reviewed/closed or superseded only after this repair PR is evaluated. Do not merge them wholesale.

## Source implementation

| Area | Current source state | What remains unverified |
|---|---|---|
| Android app roles | Controller and receiver flows in one APK | Full device lifecycle and role-switch testing |
| Pairing UI | Six-digit code and QR generation/scanning | Real-device camera/QR pairing |
| Owner approval | Receiver approval required before session issuance | Abuse/race testing under concurrent requests |
| Session authorization | Signed participant session JWTs; session-scoped relay checks | Durable revocation and device-key proof |
| Android screen capture | MediaProjection foreground service and visible Stop notification | Physical permission/revocation/background tests |
| Android WebRTC | PeerConnectionFactory, ScreenCapturerAndroid, video source/track, SDP offer/answer, ICE buffering/relay | Actual frames between two devices and different networks |
| Android viewer | SurfaceViewRenderer attaches to received video track; waits for real decoded frame before enabling live state | Physical frame/render and touch-coordinate testing |
| Browser controller | Receive-only RTCPeerConnection, real video element/frame-driven LIVE state | Browser-to-Android validation on Chrome/Edge and mobile browsers |
| Remote input | Session-authorized command relay and Android input dispatch path | Accessibility opt-in and gesture/system-action compatibility matrix |
| Files/apps/diagnostics | Android and browser UI/action paths exist | Storage permission, file limits, supported Android versions and failure handling |
| Runtime configuration | HTTPS/WSS origin and approved-session TURN credential endpoint | Real DNS/TLS/Coturn/relay validation |
| Windows controller | Legacy project remains in repository | Migration to current pairing and participant-token protocol |
| Backend persistence | PostgreSQL package/schema/Compose service exist, but DeviceService is still process-local | PostgreSQL repository, migrations and atomic transactions |
| Device identity | Fingerprint participates in authorization | Challenge/response using Android Keystore-held private key |

## Automated verification

| Check | Latest known result |
|---|---|
| Earlier backend TypeScript build/integration tests | PASS on the previous hardening branch (run [41815424617](https://github.com/mahimahfud-ui/Mahi-Remote-Control/actions/runs/41815424617)); repair-branch CORS/static-controller changes need a fresh run |
| Earlier Android run | A previous CI attempt had compile issues; after those source fixes, the latest run compiled the APK but failed two test assertions as listed above |
| Latest recorded Android run | APK compilation passed; 2 of 7 Robolectric tests failed because old assertions expected a session before backend authorization (run [41815424619](https://github.com/mahimahfud-ui/Mahi-Remote-Control/actions/runs/41815424619)) |
| Backend integration tests | PASS in the successful backend workflow above |
| Browser JS syntax check | Included in backend workflow; check full workflow output for the specific step |
| Repair-branch Android unit/Robolectric tests | Pending the new workflow; pairing lifecycle expectations now wait for `markSessionAuthorized` |
| Real two-Android-device test | NOT RUN |
| Browser-to-Android test | NOT RUN |
| Cross-network / forced TURN test | NOT RUN |
| Windows-to-Android test | NOT RUN |

The KSP IntelliJ Application null-pointer message appeared as an AWT event-thread exception in an earlier run. In the latest recorded run, APK compilation completed and the failing task was the Robolectric test task. Continue monitoring KSP output; investigate if it becomes a failing task.

## Release blockers

### 1. Durable backend state

`backend/src/device-management/DeviceService.ts` stores devices, pairing codes and active sessions in static in-memory Maps. `AuthService` also stores rate limits in process memory, and `SignalingHub` stores connected clients and pending approval requests in memory. The presence of `pg`, `DATABASE_URL`, a PostgreSQL schema and a Compose service does not mean the application currently persists to PostgreSQL. Implement a database-backed repository and atomic one-time code consumption/session creation; define the intended behavior for ephemeral WebSocket connections and reconnect after restart.

### 2. Cryptographic device identity

Registration currently accepts a device ID and fingerprint supplied by the connecting client. Add a device-key enrollment and challenge/response flow using Android Keystore, signed nonces, server-side public-key storage, key rotation/recovery and replay protection. Never treat a client-submitted fingerprint as cryptographic proof.

### 3. Production TURN and public origin

Configure public HTTPS/WSS, DNS/TLS, Coturn, matching private shared secrets, relay port ranges and firewall access. Test a forced-relay session on unrelated networks. A successful backend health check or a non-empty TURN URL is not proof that media can traverse TURN.

### 4. Android end-to-end verification

Run the current build on at least two physical Android devices. Confirm owner approval, Android MediaProjection permission, actual first decoded frame, stable video, coordinate scaling, remote input, disconnect, Stop notification, permission revocation, app restart, network loss and session expiry. Respect protected `FLAG_SECURE` content and Android OS permission boundaries.

### 5. Browser interoperability

Test the production browser controller against the Android sender in current Chrome and Edge. Confirm SDP/ICE exchange, TURN relay, real video decode, browser cleanup, reconnect, file/app operations and authorization on every control message. Test browser page reload and stale-session handling.

### 6. Windows client

The Windows WPF code has not been proven compatible with the new protocol. Either port it to the approved-session lifecycle and the current signaling schema with a real native WebRTC renderer, or explicitly scope Windows out of the first release. Do not show a fake or static stream.

### 7. Branch and workspace reconciliation

The repair branch is based on the current `main` head and preserves its active browser UI. PR #1 and PR #2 still contain overlapping older implementations; do not merge them wholesale. The current Google AI Studio Remix workspace has not been compared with this repository, so reconcile it before replacing the deployed project.

## Safety / product requirements

- Every session starts with receiver-initiated approval.
- Android's native screen-capture consent remains mandatory and visible.
- The receiver can stop sharing immediately; stop/revoke must tear down the media peer and invalidate the backend session.
- No hidden persistence, stealth capture, permission bypass, fabricated telemetry or placeholder screen may be represented as live.
- Keep Android, browser and Windows user interfaces explicit about connection, approval, capture, media and authorization states.
