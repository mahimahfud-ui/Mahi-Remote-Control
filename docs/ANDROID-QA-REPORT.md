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
5. **Regression tests:** valid/tampered/malformed ECDSA signatures; P-256 fingerprint format; challenge canonicalization, expiry, invalid nonce/purpose and replay; request-ID-bound owner approval/rejection; invalid tap/swipe coordinates; unauthorized global actions and oversized text; traversal/sibling-prefix paths; oversized/negative file chunks.
6. **Receiver-side file safety:** canonical path validation and 32 KiB chunk limits; READ_CHUNK and WRITE_CHUNK handlers return per-chunk responses/acknowledgements.
7. **Controller-side deletion:** the remote file list requires an explicit confirmation dialog before deleting and hides delete actions for directories.
8. **Receiver registration:** use the server-issued REGISTER_ACK once; do not send a redundant REGISTER that triggers a second pairing-code registration.

## Android workflow inspection

Source contains Android controller/receiver flows, six-digit pairing code and QR paths, explicit receiver approval, MediaProjection foreground-service capture, WebRTC PeerConnection and video rendering, AccessibilityService remote-input path, and app/file management.

These are source inspections only. They do not establish that the complete workflows work on physical devices. The receiver implements bounded READ_CHUNK/WRITE_CHUNK handlers and acknowledgements, but the Android controller screen currently has no end-to-end file upload/download picker and transfer orchestration, and remote folder navigation is not yet wired in that screen. No decoded video frame, real remote input, file transfer between phones, reconnect, or TURN relay was physically verified in this task.

## Backend device-identity integration

Agent 2 published `docs/BACKEND-ANDROID-CONTRACT.md` on branch `agent-backend/persistence-deployment`, latest inspected backend source head `d03d92c0b49b20c34204611f424bf5d3846883e7`. Android client changes follow its protocol-v1 interface:

- ECDSA P-256 / `secp256r1`, `SHA256withECDSA`, X.509 SPKI DER public key and ASN.1 DER signature, standard Base64.
- Server-derived fingerprint format `sha256:<64 lowercase hex>`; private key remains exclusively in Android Keystore.
- Exact LF-delimited `MAHI-REMOTE-DEVICE-PROOF` canonical challenge message, purpose / expiry / nonce / fingerprint validation, and local one-use challenge guard.
- Enrollment/authentication REST calls use protocol-version headers and bodies. Receiver WSS uses the short-lived device bearer token; client-supplied device ID/fingerprint headers are no longer sent as proof. Android controller uses a random ephemeral `controllerFingerprint` query value.
- Device access tokens remain in memory and are not persisted.

The latest inspected Agent 2 backend source contains the v1 enrollment/authentication REST route handlers, verifies device bearer tokens during the receiver WSS handshake, requires protocol-v1 messages, and creates separate participant session tokens after receiver approval. The Android client is aligned to those source-level routes and event schemas and fails closed on any missing/invalid protocol confirmation. This does not prove that the backend PR has been merged or deployed; production integration remains dependent on Agent 2's reviewed, merged and deployed backend. The current Agent 2 WSS handshake has one server-side hardening gap: a non-empty but invalid Authorization header with no X-Device-Id can miss the device-token branch and fall through to anonymous browser identity. Android now closes if a receiver's REGISTER_ACK.deviceId does not exactly match the enrolled device ID, but Agent 2 should reject every supplied invalid Authorization header before browser fallback. This is recorded on PR #3 in comment 6898630538. Key rotation is specified by the contract but is not implemented in this Android PR.

## Verification status

| Check | Result |
|---|---|
| Baseline APK compile (run 43737218111) | PASS |
| Baseline Robolectric/unit tests (run 43737218111) | FAIL — JDK 17 with API 36 |
| QA branch APK compile | PASS on commit `4c3e89f160861090622f59094207a34ee75603da`; later refinements need the latest run |
| QA branch Robolectric/unit tests | PASS on commit `4c3e89f160861090622f59094207a34ee75603da`; later refinements need the latest run |
| Protocol integration APK / instrumentation compile / unit & Robolectric checks | PASS on commit `4c3e89f160861090622f59094207a34ee75603da`; later refinements need the latest run |
| Latest Android source refinements (remote-delete confirmation, single ACK registration, receiver identity ACK guard) | IN PROGRESS on `e9326b85fac9729e2b456f2e53898d4ffd96dac2`; runs [43742823755](https://github.com/mahimahfud-ui/Mahi-Remote-Control/actions/runs/43742823755) / [43742819508](https://github.com/mahimahfud-ui/Mahi-Remote-Control/actions/runs/43742819508) |
| Physical execution of Android instrumentation tests | NOT RUN |
| Physical Android device matrix | NOT RUN |
| Android-to-Android owner approval / screen capture | NOT RUN |
| Actual WebRTC video / decoded frame | NOT RUN |
| Remote tap, swipe and text input | NOT RUN |
| Controller-side file upload/download workflow | NOT YET IMPLEMENTED end-to-end in the Android viewer; receiver chunk handlers exist |
| Physical file upload/download between devices | NOT RUN |
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

**Not production-ready.** A prior complete Android CI run passed, but the latest source refinements are still running through GitHub Actions. Agent 2's current backend branch contains the corresponding v1 endpoints and WSS authorization, but remains separate from the Android PR and has not been proven deployed. Merge/review/deployment coordination and the physical-device checklist remain release gates.
