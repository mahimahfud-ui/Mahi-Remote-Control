# Android QA Report

**Assessment date:** 2026-11-15  
**QA branch:** `agent-android/client-qa`  
**Source baseline:** `32260cb511fe21e76028f3d0efd9e4cd94da1840` (PR #3 head)  
**Integration target:** `fix/full-remote-workflow`  
**Status:** In progress; not production-ready.

## Scope

This branch contains Android client and Android CI changes only. No backend, infrastructure, deployment, Coturn, or backend workflow files are changed. No merge is performed.

## CI failure diagnosis

Previous Android workflow: [run 43737218111](https://github.com/mahimahfud-ui/Mahi-Remote-Control/actions/runs/43737218111)

- `:app:assembleDebug`: passed on the baseline commit.
- `:app:testDebugUnitTest`: failed.
- Console output: `ExampleRobolectricTest > classMethod FAILED`, `UnsupportedOperationException at DefaultSdkProvider.java:170`.
- The workflow installed Android API 36 and used JDK 17. Robolectric 4.16 supports API 36, which requires Java 21 for SDK 36 sandbox execution. The CI setup is therefore changed to JDK 21; Robolectric and its tests remain enabled.
- The Actions log did not include the HTML/XML test report or a method-level stack trace. The reported failing descriptor is `ExampleRobolectricTest > classMethod`; no individual test method can be honestly attributed from the available log.

## Android changes in this branch

1. **CI compatibility:** set up Temurin JDK 21 for API 36 Robolectric tests. Added the QA branch to push triggers so the branch can validate itself before its stacked PR is merged. Added `fix/full-remote-workflow` as a pull-request base filter.
2. **Signature verification:** malformed keys/signatures and verification exceptions now fail closed. A signature's length is never accepted as cryptographic proof.
3. **File path validation:** validation resolves canonical paths and uses path-component-aware containment. Sibling-prefix paths and traversal segments are rejected.
4. **Chunk limits:** file reads reject negative offsets and chunks outside 1..32 KiB; writes reject chunks larger than 32 KiB.
5. **Regression tests:** valid/tampered/malformed ECDSA signature handling; traversal and sibling-prefix file paths; oversized/negative file chunks; rejected pairing cannot later activate a session.

## Android workflow inspection

Source contains Android controller/receiver flows, six-digit pairing code and QR paths, explicit receiver approval, MediaProjection foreground-service capture, WebRTC PeerConnection and video rendering, AccessibilityService remote-input path, and app/file management.

These are source inspections only. They do not establish that the complete workflows work on physical devices. No decoded video frame, real remote input, file transfer between phones, reconnect, or TURN relay was physically verified in this task.

## Backend device-identity integration

Agent 2 published `docs/BACKEND-ANDROID-CONTRACT.md` on branch `agent-backend/persistence-deployment`, source head `7c2b1387be4166da8895446aa93a4da3d14b74b1`. Android client changes follow its protocol-v1 interface:

- ECDSA P-256 / `secp256r1`, `SHA256withECDSA`, X.509 SPKI DER public key and ASN.1 DER signature, standard Base64.
- Server-derived fingerprint format `sha256:<64 lowercase hex>`; private key remains exclusively in Android Keystore.
- Exact LF-delimited `MAHI-REMOTE-DEVICE-PROOF` canonical challenge message, purpose / expiry / nonce / fingerprint validation, and local one-use challenge guard.
- Enrollment/authentication REST calls use protocol-version headers and bodies. Receiver WSS uses the short-lived device bearer token; client-supplied device ID/fingerprint headers are no longer sent as proof. Android controller uses a random ephemeral `controllerFingerprint` query value.
- Device access tokens remain in memory and are not persisted.

The contract is published, but the Agent 2 backend source at the above revision does not yet contain the enrollment/authentication route handlers or authenticated receiver WSS handshake. Until those endpoints are implemented and deployed, the Android receiver intentionally fails closed rather than falling back to the legacy unverified registration flow. Key rotation is specified by the contract but is not implemented in this Android PR.

## Verification status

| Check | Result |
|---|---|
| Baseline APK compile (run 43737218111) | PASS |
| Baseline Robolectric/unit tests (run 43737218111) | FAIL — JDK 17 with API 36 |
| QA branch APK compile | PASS on commit `62eca274eff806e403eea93a00e101faba190e06`; protocol integration commit re-run pending |
| QA branch Robolectric/unit tests | PASS on commit `62eca274eff806e403eea93a00e101faba190e06`; protocol integration commit re-run pending |
| Protocol integration instrumentation-test compilation | Pending GitHub Actions |
| Physical execution of Android instrumentation tests | NOT RUN |
| Physical Android device matrix | NOT RUN |
| Android-to-Android owner approval / screen capture | NOT RUN |
| Actual WebRTC video / decoded frame | NOT RUN |
| Remote tap, swipe and text input | NOT RUN |
| File upload/download between devices | NOT RUN |
| Session expiry / network interruption / reconnection | NOT RUN |
| Cross-network forced TURN relay | NOT RUN |

## Physical-device checklist

- [ ] Phone A controls Phone B after the receiver explicitly approves.
- [ ] Receiver rejects a request and no session is activated.
- [ ] MediaProjection consent dialog is displayed by Android.
- [ ] Foreground notification is visible and its Stop action tears down capture.
- [ ] Viewer reports LIVE only after a real decoded video frame.
- [ ] Tap, swipe, text input and supported actions work with display rotation.
- [ ] File listing, chunked upload, chunk acknowledgement and download work.
- [ ] File deletion requires explicit confirmation.
- [ ] Emergency disconnect stops media and revokes the active session.
- [ ] Permission revocation and app background/foreground transitions clean up safely.
- [ ] Network interruption and reconnection do not reuse an expired session.
- [ ] Session expiry is enforced.
- [ ] A forced TURN relay succeeds across unrelated networks.

## Release assessment

**Not production-ready.** Successful compilation alone is insufficient. Backend contract integration, Android Keystore challenge-response, successful QA-branch Actions, and the physical-device checklist remain release gates.
