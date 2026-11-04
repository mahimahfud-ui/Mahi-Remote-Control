# Legacy Real-Device Test Report — Superseded

**Do not treat this file's historical PASS entries as verified physical-device results for the current branch.**

The current `work/remote-access-hardening` branch has not been installed or tested on physical phones. No two-device, browser, mobile-data or TURN-relay verification was performed in this session.

The checked-in instrumented Android test only verifies application context. Robolectric tests verify local components, not two physical Android devices. The current Android screen-capture service reports that a WebRTC sender is missing and does not claim to stream a screen.

Use [docs/IMPLEMENTATION-STATUS.md](../docs/IMPLEMENTATION-STATUS.md) as the current source of truth. Physical verification must be recorded only after tests are run on actual devices with dates, Android versions, network types and results.
