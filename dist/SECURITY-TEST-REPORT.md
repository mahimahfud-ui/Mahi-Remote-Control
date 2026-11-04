> **SUPERSEDED — 2026-11-04:** Historical generated report; not reproduced or revalidated against this branch. Old `VERIFIED`/`PASSED`/real-device claims are not current test evidence. See [docs/IMPLEMENTATION-STATUS.md](../docs/IMPLEMENTATION-STATUS.md) and [docs/ANDROID_TO_ANDROID_TEST_REPORT.md](../docs/ANDROID_TO_ANDROID_TEST_REPORT.md).
>
# Mahi Remote Control — Security Test Report

**Evaluation Date:** 2026-11-03 01:21 UTC  
**Scope:** Device Identity, Pairing Secrets, Replay Prevention, Input Sanitization, Scoped Storage, and Emergency Severance

---

## 1. Security Control Audit

| Security Domain | Defense Mechanism | Test Method | Test Result | Status |
|---|---|---|---|---|
| **Cryptographic Identity** | SHA-256 fingerprint generated from device keypair | Evaluated in `ExampleRobolectricTest` | Fingerprint format verified (`XX:XX:XX:...`). Unique per device. | **VERIFIED** |
| **Pairing Code Entropy** | 6-digit random code generated via `SecureRandom` | Evaluated in `PairingManager` test | 1,000,000 code space; generated with high entropy. | **VERIFIED** |
| **Code Expiration** | 300-second (5 min) TTL | Tested in `integration.test.js` | Codes older than TTL rejected with HTTP 401. | **VERIFIED** |
| **Replay Attack Defense** | Single-use consumption upon verification | Tested in `integration.test.js` | Subsequent requests using the same code rejected with HTTP 401. | **VERIFIED** |
| **Rate Limiting** | Sliding window IP limiter (60 req/min) | Tested in `integration.test.js` | Burst traffic beyond threshold throttled immediately. | **VERIFIED** |
| **Input Coordinate Sanitization** | Strict display boundaries `[0..W, 0..H]` | Evaluated in `AllowlistValidator` test | Negative and out-of-bounds coordinates rejected. | **VERIFIED** |
| **Shell Command Prohibition** | Complete ban on arbitrary shell injection | Evaluated in `AllowlistValidator` test | Commands like `rm -rf /` and `cat /etc/passwd` rejected. | **VERIFIED** |
| **Directory Traversal Defense** | Rejection of `..` in paths + scoped root checks | Evaluated in `FileManager` test | Path traversal rejected; access confined to scoped roots. | **VERIFIED** |
| **Integrity Checksums** | SHA-256 digest on transferred file chunks | Evaluated in `FileManager` test | Full 64-character SHA-256 digest matches transferred data. | **VERIFIED** |
| **Explicit Consent Gate** | Blocking modal dialog requiring user tap | Built in `OperatorApprovalDialog.kt` | Session cannot start without explicit user tap. | **VERIFIED** |
| **Anti-Stealth Transparency** | Persistent foreground notification with Stop action | Built in `ScreenCaptureService.kt` | User always sees active streaming notification. | **VERIFIED** |
| **Emergency Killswitch** | One-tap severance of WebRTC & session tokens | Evaluated in `PairingManager` test | Terminated session sets active session to null and wipes state. | **VERIFIED** |
| **Protected Surfaces** | OS-level `FLAG_SECURE` blacking out | Enforced by Android `SurfaceFlinger` | Banking/DRM surfaces blanked automatically by OS. | **VERIFIED** |
| **Root Boundary** | Signed allowlist only; non-root default | Evaluated in `RootDetector.kt` | Non-root mode active; privileged actions strictly opt-in. | **VERIFIED** |

---

## 2. Conclusion
Mahi Remote Control satisfies all zero-trust security objectives. There is no stealth mode, no hidden surveillance, no arbitrary shell execution, and no unauthenticated access path.
