# Android-to-Android and Browser Test Report

**Execution status: NOT RUN in the current implementation environment.**

The branch now contains an integration test program and a GitHub Actions workflow. This document does not claim they have passed. Review the GitHub Actions run before treating backend/Android build checks as green.

## Tests added to the backend integration suite

- Backend health and public config response.
- Legacy pairing API refuses to mint sessions without receiver consent.
- Receiver registers a short-lived six-digit code.
- Controller receives a pending request without consuming the code.
- SDP offer is blocked before receiver approval.
- Owner approval creates session tokens for both participants.
- Approved input messages relay only to the paired receiver.
- TURN credential endpoint requires a session token.
- Emergency disconnect revokes the session and blocks later input.
- Rate limiter and expired code behavior.

## Required physical-device tests — not run

1. Install the exact same APK on two Android phones.
2. Pair with six-digit code and QR.
3. Approve and reject requests from receiver phone.
4. Verify actual screen frames on the controller.
5. Test tap, double tap, long press, swipe, drag, text input and navigation.
6. Test file upload/download and app actions within Android permissions.
7. Stop from both endpoints and verify the other side loses access immediately.
8. Test same Wi-Fi, different Wi-Fi, Wi-Fi to mobile data and mobile-to-mobile.
9. Verify TURN relay is selected when direct ICE fails.
10. Repeat browser pairing and control from desktop Chrome and mobile Safari/Chrome.

**Current blocker:** native Android WebRTC video publishing/receiving is not implemented. Physical media tests cannot pass until that work is completed.
