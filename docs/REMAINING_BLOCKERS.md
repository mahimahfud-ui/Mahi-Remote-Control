# Remaining Blockers — Mahi Remote Control

## Release blockers

1. Native Android WebRTC publisher and receiver are missing. Implement `PeerConnectionFactory`, `PeerConnection`, screen capture with `ScreenCapturerAndroid`/MediaProjection, SDP offer/answer, ICE exchange, and remote video rendering. The current service intentionally fails closed.
2. Android commands and files must run only over a verified active session. Recheck every action handler against the session token and approved scopes; current backend session-gates signaling but Android command handling still needs end-to-end security validation.
3. Persist device presence, pairing code hashes, pending requests, active sessions, revocation and audit records in a shared database. Current backend `DeviceService` uses in-memory Maps.
4. Public DNS, reverse proxy, HTTPS/WSS and Coturn must be deployed and externally verified.
5. Android release build needs the owner's signing keystore and credentials. Do not commit them.
6. Windows controller must be adapted to the current protocol and built on Windows with .NET 10.
7. Run Android tests, backend integration tests, browser syntax/UI tests and all physical-device/network tests.

## Workspace/source-of-truth blocker

The latest Google AI Studio Remix workspace was not attached or accessible during this work. This branch starts from the GitHub `main` snapshot. Compare/port changes with the AI Studio workspace before using this branch as merge source.

## Environment values the owner must supply

- `PUBLIC_BASE_URL`: public HTTPS browser/backend origin.
- `ALLOWED_ORIGINS`: exact browser origin allowlist.
- `JWT_SECRET`: random server-only secret, at least 32 characters.
- `TURN_SECRET`: random shared Coturn/backend HMAC secret, at least 32 characters.
- `TURN_URL`, `TURN_REALM`, `STUN_URL`.
- `POSTGRES_PASSWORD` for the included database container.
- Android build value `MAHI_PUBLIC_BASE_URL` set to the public HTTPS origin.
- Release signing keystore and passwords supplied only through secure environment/secrets.

