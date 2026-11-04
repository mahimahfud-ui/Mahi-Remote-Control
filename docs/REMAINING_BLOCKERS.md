# Mahi Remote Control — Current Remaining Blockers

**This document supersedes earlier blocker lists that stated automated and physical-device tests had passed.**

The current branch is a source-code implementation pass, not a finished remote-control release. See [IMPLEMENTATION-STATUS.md](IMPLEMENTATION-STATUS.md) for the detailed feature matrix and verification state.

## Release blockers

1. **Google AI Studio source-of-truth workspace:** The current Remix workspace was not available for comparison. This branch is based on the GitHub `main` snapshot only.
2. **Android WebRTC media:** No Android PeerConnectionFactory, screen capture video source, encoder/RTP track, SDP answerer, ICE exchange or Android remote-video renderer is implemented. Live screen viewing is blocked.
3. **Real backend persistence:** Device, pairing and session data use process-local Maps. PostgreSQL is provisioned in Compose but is not connected to DeviceService.
4. **Device identity proof:** WebSocket device ID/fingerprint headers are client supplied. A cryptographic challenge/response proving possession of the Android Keystore key remains to be implemented.
5. **Public deployment:** Real HTTPS/WSS host, DNS/TLS, Coturn host, matching secrets and firewall ports need to be configured.
6. **Windows compatibility:** The legacy Windows WPF client has not been migrated to this branch's approval/session-token protocol.
7. **Build/test verification:** No current backend, Android or browser build/test has been run on this branch.
8. **Physical tests:** Two actual Android devices and a separate browser/network test environment are required; no physical-device test is claimed.

## User/environment tasks after source completion

- Export and compare the current Google AI Studio Remix workspace before adopting this branch.
- Configure private backend deployment secrets and real public URLs.
- Deploy Coturn on a public host and verify relay candidate selection.
- Build/install the same APK on two physical Android devices after the WebRTC media pipeline is completed.
- Test Android-to-Android, browser-to-Android, different carrier networks, forced TURN relay, gestures, files and emergency disconnect.

## Do not release

Do not distribute this branch as a working remote-control application until the Android WebRTC media blocker and physical-device tests are complete.
