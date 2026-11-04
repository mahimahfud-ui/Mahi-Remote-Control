# Mahi Remote Control — Implementation Status

Status date: 2026-11-04

## Current working branch

- Branch: `work/anywhere-remote-control`
- Base: GitHub `main` commit `41d6bab20a822b1f5f87c4a88bdc32769377516d`.
- `main` has not been modified or merged.
- The Google AI Studio Remix workspace was not available during this work. This branch is based on the GitHub snapshot, not a confirmed copy of any newer AI Studio workspace.

## Implemented in this branch

- Removed the backend's default JWT signing secret. `JWT_SECRET` is required at runtime and must be at least 32 characters.
- Added server-issued, short-lived, session-bound JWT claims for receiver/controller pairs.
- Reworked pairing code storage to keep SHA-256 hashes, enforce six digits and a maximum five-minute lifetime, allow one pending request per receiver, and consume the code only after owner approval.
- Added receiver approval/rejection handling, one active approved session per receiver/controller, participant-only signaling relay and emergency session revocation.
- Restricted SDP, ICE, input, app and file signaling messages to the approved session peer; removed broadcast-style relaying.
- Disabled the legacy REST verify/register endpoints because they could create sessions without receiver consent.
- Added authenticated TURN credential retrieval and server-side HMAC credentials with short expiry.
- Added a public config endpoint which reports the browser HTTPS URL and WSS signaling URL only when `PUBLIC_BASE_URL` is valid.
- Restricted browser CORS/WebSocket origins, bounded JSON/WebSocket payload sizes and added production configuration checks.
- Removed committed database/JWT/TURN credentials from the Docker Compose deployment template; secrets now come from a local untracked `.env` file.
- Removed hardcoded browser demo phone details and synthetic phone canvas; the browser marks `LIVE` only after a decoded video frame.
- Added browser six-digit pairing, approval wait, TURN configuration retrieval, browser SDP offer, remote SDP answer and ICE candidate handling.
- Added Android runtime fetch of the public browser/WSS configuration using a build-time `MAHI_PUBLIC_BASE_URL` origin.
- Added a two-action Android home screen and moved advanced destinations into a More menu.
- Removed a hardcoded trusted controller, fake incoming-request button, demo receiver device and fabricated default telemetry.
- Changed the screen-capture service to fail closed rather than reporting simulated frame/bitrate metrics as a live stream.
- Added a backend integration test covering pending pairing, pre-approval blocking, owner approval, session-scoped command relay, TURN token authorization, expiry, rate limiting and emergency revocation.
- Added GitHub Actions workflow to run backend tests and Android debug build/unit tests/lint.

## Not release-verified

### Android/WebRTC implementation added; verification pending

The working branch now includes:

- A native io.github.webrtc-sdk:android dependency.
- A receiver-side ScreenCapturerAndroid MediaProjection publisher that starts only after pairing approval, Android screen-share consent, and the owner-visible foreground service being ready.
- A controller-side receive-only video offer, an Android receiver answer, SDP/ICE exchange, and a real SurfaceViewRenderer in the controller viewer.
- A persistent foreground notification with an explicit Stop action, server-revocation cleanup, and no remote-input execution until the receiver's stream is active and the controller has a real incoming video track.
- Touch-coordinate mapping from the controller's normalized portrait viewport to the receiver's actual display dimensions.
- Cloudflare Realtime managed TURN credential support using server-only key/API-token environment variables, in addition to self-hosted Coturn.
- Backend integration-test coverage for approved WebRTC offer, answer and ICE relay.

These are source-code changes, not proof of successful live streaming. Android CI, APK build, codec compatibility, decoded frames and control gestures still require verification on two physical phones.

### Remaining blockers

- Backend device, pending-pairing and active-session registries are in-memory Maps. They are lost on process restart and are not backed by the included PostgreSQL schema yet.
- TURN is not configured in the current Render service. STUN may connect directly, but restrictive mobile networks/CGNAT may require a configured relay. Cloudflare managed TURN is metered when used without its Realtime SFU; do not enable it without the account owner's billing approval.
- Windows desktop controller has not been updated or built in this branch.
- Browser-to-Android must be tested separately; existing browser offer code alone does not establish end-to-end interoperability.
- Files/apps/diagnostics features have source code but are not yet proven over the new session protocol end-to-end.
- Session revocation is not persistent across multiple backend instances; session/pairing Maps are in memory.
- Android-to-Android QR scanning UX and mobile network behavior need physical-device validation.
- Android Accessibility must be enabled manually by the receiving owner. OS-protected FLAG_SECURE content and some system-owned UI cannot be bypassed.

## Verification truth table

| Check | Status | Evidence required next |
|---|---|---|
| WebRTC Android publisher/receiver source | Implemented | Android CI compile and code review |
| Approved WebRTC SDP/ICE backend relay | Integration test added | Successful CI backend job |
| Backend TypeScript build/integration suite | Pending verification | Current GitHub Actions run |
| Android debug build/unit tests/lint | Pending verification | Current GitHub Actions Android job |
| Android release APK | Not generated | Build after CI and device fixes |
| Two physical Android devices | Not tested | Same APK on Phone A and Phone B |
| Real decoded video frames | Implemented in source, unverified | Live SurfaceViewRenderer frame on controller |
| Tap/swipe/navigation | Implemented in source, unverified | Confirm Accessibility enabled and actions execute |
| Cross-network relay | Not configured on Render | Coturn or Cloudflare TURN key/API token plus external-network test |
| Browser controller to Android | Unverified | Browser + receiver end-to-end test |
| Windows controller | Not tested | Windows .NET 10 build and device test |

## Source-of-truth warning

Before merging any work, compare this branch with the current Google AI Studio Remix workspace and port changes into the newest workspace state. Do not overwrite newer workspace files with this branch.

