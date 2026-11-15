# Mahi Remote Control — Current Remaining Blockers

This document supersedes older reports that either claimed tests passed without evidence or incorrectly stated that Android WebRTC media code did not exist. The current `work/remote-access-hardening` branch contains the Android media pipeline and browser receive path in source, but end-to-end operation is not yet proven. See [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md).

## Release blockers

1. **Android CI:** Two Kotlin compile issues were fixed on PR #2: the viewer header now observes `remoteVideoHasFrames`, and `PairingScreen` snapshots the delegated active-session value before null-checking it. The new Android workflow must complete successfully, including debug APK build and Robolectric/unit tests.
2. **Durable backend:** `DeviceService` stores device, code and session state in process-local Maps. `AuthService` rate limiting and pending WebSocket pairing requests are also process-local. Wire the backend to PostgreSQL using migrations and atomic transactions; the existing `pg` dependency and schema are not connected storage.
3. **Cryptographic device proof:** Implement device-key enrollment plus nonce-based challenge/response proving possession of a private key held by Android Keystore. Client-supplied device IDs/fingerprints are not sufficient proof.
4. **Production infrastructure:** Configure a real HTTPS/WSS origin, DNS/TLS, Coturn, private TURN shared secret, firewall/relay ports, and production environment variables. Validate actual relay candidates from outside the hosting network.
5. **Physical Android validation:** Test two phones end-to-end: pairing, explicit approval, Android screen-capture consent, real decoded frames, coordinate scaling, Accessibility-based input, Stop/revoke, network interruption and session expiry.
6. **Browser validation:** Verify Chrome and Edge browser-to-Android sessions, SDP/ICE, actual video rendering, forced TURN, control commands, file/app tools and reconnect. The browser client source alone does not establish interoperability.
7. **Windows compatibility:** Migrate the legacy WPF controller to the current participant-token and pairing protocol, including a real native WebRTC video renderer, or exclude Windows from the first supported release. Do not fake a screen stream.
8. **Branch reconciliation:** PR #2 is two commits behind current `main`; preserve the latest restored browser UI. PR #1 and PR #2 contain overlapping changes from the same initial base and must not be merged wholesale together. Compare both branches and the current Google AI Studio Remix workspace before choosing a canonical implementation.

## Verification rules

- Backend build/integration workflow passed on the latest recorded source commit `ea75c9e544a5f917eb19ab7f7cbf3bf58505acfe`.
- Android workflow after the Kotlin source fixes was still running at the last status check. Confirm the latest Actions result before claiming it passed.
- No real two-phone, browser-to-phone, different-network/TURN, or Windows integration test is claimed.
- Existing files under `dist/` are historical reports, not proof of the current build or physical test state.

## Do not release

Do not publish or describe this as a production-ready remote-control product until Android CI passes, PostgreSQL persistence and device identity proof are implemented, HTTPS/WSS and TURN are configured, and the physical Android/browser test matrix is green.
