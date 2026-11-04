# Mahi Remote Control — Current Feature Matrix

Status key: `IMPLEMENTED_NOT_TESTED`, `PARTIAL`, `BLOCKED`, `NOT_IMPLEMENTED`, `NOT_RUN`.

| Feature | Current status | Notes |
|---|---|---|
| Same APK for Android controller/receiver | PARTIAL | Both roles exist in the same app; end-to-end pairing/video has not passed tests. |
| Simplified two-action Android home | IMPLEMENTED_NOT_TESTED | Home screen offers Control another device and Share this phone; advanced areas are in More. |
| Temporary six-digit pairing code | PARTIAL | Local code generation and backend hashed/expiring code registration are present; no integration run has been recorded. |
| QR pairing | PARTIAL | QR payload generation/input code exists; full camera scan workflow still needs validation. |
| Explicit receiver approval/rejection | IMPLEMENTED_NOT_TESTED | Backend creates active session only after receiver approval. Persistence and physical tests remain. |
| Browser pairing | PARTIAL | Browser sends `PAIR_BY_CODE` and waits for owner approval; browser WebSocket re-authentication path is implemented but not tested. |
| Runtime public URL configuration | IMPLEMENTED_NOT_TESTED | Android reads `/api/v1/config`; build requires `MAHI_PUBLIC_BASE_URL`. |
| Public HTTPS/WSS deployment | BLOCKED | Requires domain, TLS reverse proxy and public backend host. |
| Dynamic TURN credentials | IMPLEMENTED_NOT_TESTED | HMAC credentials are generated server-side when `TURN_SECRET` and `TURN_URL` exist. No live TURN relay test has been run. |
| Android MediaProjection consent | PARTIAL | Android consent launcher exists. The current service explicitly fails closed after consent. |
| Android native WebRTC video publisher | NOT_IMPLEMENTED | No native `PeerConnection`/video track pipeline was present in the source snapshot. |
| Android native WebRTC video receiver | NOT_IMPLEMENTED | No remote video renderer or PeerConnection negotiation path exists. |
| Browser WebRTC offer/receive UI | PARTIAL | Offer, answer, ICE and actual decoded-frame state are wired in browser code; no receiver video track exists yet. |
| Real browser video frames | BLOCKED | Android video publisher must be implemented before real frames can arrive. |
| Remote tap/swipe/navigation | PARTIAL | Accessibility service methods and protocol handlers exist; they are not end-to-end verified with an authenticated peer. |
| App management | PARTIAL | Android app manager and command handlers exist; remote command flow is untested. |
| File management | PARTIAL | Scoped file-manager source exists; browser upload/download and remote file flows are untested. |
| Persistent pairing/session database | NOT_IMPLEMENTED | Backend state remains in-memory Maps and is lost on process restart. |
| Emergency stop / session revocation | IMPLEMENTED_NOT_TESTED | Server session revoke handler and Android stop path exist; must be physically tested. |
| Windows desktop controller | NOT_RUN | Existing code retained; this branch did not build it. |
| Two-phone same-Wi-Fi test | NOT_RUN | Requires two physical Android devices. |
| Cross-network / mobile-data / CGNAT test | NOT_RUN | Requires public deployment and TURN relay. |

Do not use `VERIFIED` unless the feature has passed a reproducible physical-device test.
