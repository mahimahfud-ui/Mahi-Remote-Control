# Mahi Remote Control — Current Remaining Blockers

This document supersedes older reports that either claimed tests passed without evidence or incorrectly stated that Android WebRTC media code did not exist. The current `repair/remote-control-hardening` branch contains the Android media pipeline and browser receive path in source, but end-to-end operation is not yet proven. See [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md).

## Release blockers

1. **Android CI:** The latest recorded hardening-branch run compiled the debug APK but failed two Robolectric assertions because the tests expected `approveRequest()` to create a session before backend authorization. Repair-branch tests now assert no session exists until `markSessionAuthorized()` succeeds. The new Android workflow must pass both APK compilation and all Robolectric/unit tests.
2. **Durable backend:** `DeviceService` stores device, code and session state in process-local Maps. `AuthService` rate limiting and pending WebSocket pairing requests are also process-local. Wire the backend to PostgreSQL using migrations and atomic transactions; the existing `pg` dependency and schema are not connected storage.
3. **Cryptographic device proof:** Implement device-key enrollment plus nonce-based challenge/response proving possession of a private key held by Android Keystore. Client-supplied device IDs/fingerprints are not sufficient proof.
4. **Production infrastructure:** Configure a real HTTPS/WSS origin, DNS/TLS, Coturn, private TURN shared secret, firewall/relay ports, and production environment variables. Validate actual relay candidates from outside the hosting network.
5. **Physical Android validation:** Test two phones end-to-end: pairing, explicit approval, Android screen-capture consent, real decoded frames, coordinate scaling, Accessibility-based input, Stop/revoke, network interruption and session expiry.
6. **Browser validation:** Verify Chrome and Edge browser-to-Android sessions, SDP/ICE, actual video rendering, forced TURN, control commands, file/app tools and reconnect. The browser client source alone does not establish interoperability.
7. **Windows compatibility:** Migrate the legacy WPF controller to the current participant-token and pairing protocol, including a real native WebRTC video renderer, or exclude Windows from the first supported release. Do not fake a screen stream.
8. **Branch/workspace reconciliation:** The new repair branch is based directly on current `main` and preserves the active browser UI. PR #1 and the older PR #2 remain overlapping proposals and should not be merged wholesale. Compare the current Google AI Studio Remix workspace before replacing any deployed project.

## Verification rules

- The previous hardening branch's backend build/integration workflow passed; the repair branch changes CORS, security headers and the active browser JS, so its workflow must be rerun.
- The latest recorded Android workflow compiled the APK but failed two pairing lifecycle tests. Repair-branch assertions have been updated; confirm the new Actions result before claiming Android CI passes.
- No real two-phone, browser-to-phone, different-network/TURN, or Windows integration test is claimed.
- Existing files under `dist/` are historical reports, not proof of the current build or physical test state.

## Do not release

Do not publish or describe this as a production-ready remote-control product until Android CI passes, PostgreSQL persistence and device identity proof are implemented, HTTPS/WSS and TURN are configured, and the physical Android/browser test matrix is green.
