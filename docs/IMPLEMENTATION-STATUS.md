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

## Not complete — do not ship as a working remote-control release

### Critical Android/WebRTC gap

The repository snapshot did not include a native Android WebRTC PeerConnection implementation or WebRTC dependency. The Android service still does not create a real `VirtualDisplay`/MediaCodec/WebRTC video publisher. It deliberately reports an error after the Android consent prompt. Android does not yet handle SDP offers/answers and ICE candidates, attach a real video track, or render a received track in the Android controller viewer.

The browser can create a receive-only offer, but the Android receiver cannot currently answer it with a real video track. Browser-to-Android video and Android-to-Android video are therefore NOT IMPLEMENTED end-to-end in this branch.

### Other blockers

- Backend device, pending-pairing and active-session registries are in-memory Maps. They are lost on restart and are not backed by the included PostgreSQL schema yet.
- No real TURN server has been deployed or connectivity-checked. The compose files only describe how to configure one.
- `PUBLIC_BASE_URL`, DNS, TLS reverse proxy and TURN firewall/range configuration require deployment to a public host.
- Windows desktop controller has not been updated or built in this branch.
- Files/apps/diagnostics features have source code but are not yet proven over the new session protocol end-to-end.
- Session expiry cleanup is enforced in the backend process, but persistent session revocation across multiple backend instances is not implemented.
- Android-to-Android QR scanning UX, browser URL display and mobile browser responsive validation need further work.

## Verification truth table

| Check | Status | Evidence required next |
|---|---|---|
| Source changes pushed to working branch | Implemented | GitHub branch history |
| Backend TypeScript build | Not run in this environment | GitHub Actions backend job |
| Backend integration suite | Not run in this environment | GitHub Actions test output |
| Android debug build | Not run in this environment | GitHub Actions Android job |
| Android unit/Robolectric tests | Not run in this environment | GitHub Actions Android job |
| Android release APK | Not generated | Signing keystore and release build |
| Browser app syntax check | Not run in this environment | GitHub Actions backend job |
| Two physical Android devices | Not tested | Pair Phone A and Phone B using same APK |
| Browser Chrome/Edge/Safari to receiver | Not tested | Browser + Android receiver test |
| Real decoded WebRTC video frames | Not implemented | Native Android WebRTC publisher/receiver required first |
| Different mobile networks / CGNAT / TURN relay | Not tested | Deployed Coturn and two external networks |
| Windows controller | Not tested | Windows .NET 10 build and device test |

## Source-of-truth warning

Before merging any work, compare this branch with the current Google AI Studio Remix workspace and port changes into the newest workspace state. Do not overwrite newer workspace files with this branch.

