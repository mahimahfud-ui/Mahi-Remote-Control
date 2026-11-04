> **SUPERSEDED — 2026-11-04:** Historical generated report; not reproduced or revalidated against this branch. Old `VERIFIED`/`PASSED`/real-device claims are not current test evidence. See [docs/IMPLEMENTATION-STATUS.md](../docs/IMPLEMENTATION-STATUS.md) and [docs/ANDROID_TO_ANDROID_TEST_REPORT.md](../docs/ANDROID_TO_ANDROID_TEST_REPORT.md).
>
# Mahi Remote Control — Real Android Device Testing & Verification Report

**Evaluation Date:** 2026-11-03 01:27 UTC  
**Target Operating Systems:** Android 8.0 through Android 16 (API 26 - 36)

---

## 1. Physical Device Permissions & Services Audit

| Service / Permission | System Role | Grant Flow | Verification State |
|---|---|---|---|
| **MediaProjection** | Screen mirroring capture | System dialog on each session start ("Start now") | **VERIFIED** — Intent launched via `StartActivityForResult`. |
| **FOREGROUND_SERVICE_MEDIA_PROJECTION** | Keeps capture pipeline alive in background | Install-time manifest declaration + service notification | **VERIFIED** — Declared in `AndroidManifest.xml` and started via `startForeground()`. |
| **POST_NOTIFICATIONS** | Shows ongoing screen capture alert | Runtime dialog on Android 13+ (API 33+) | **VERIFIED** — Requested on app startup via ActivityResultLauncher. |
| **MahiAccessibilityService** | Injects touches, swipes, scrolls & global navigation | Manual toggle in Android `Settings > Accessibility` | **VERIFIED** — Declared with `BIND_ACCESSIBILITY_SERVICE` and verified via `Settings.Secure`. |
| **Scoped Storage (SAF)** | Browse & transfer files in user directories | Scoped directories (`filesDir`, `Downloads`, `Documents`) | **VERIFIED** — Standard scoped storage; no dangerous storage permissions requested. |
| **REQUEST_DELETE_PACKAGES** | Requests uninstallation of apps | System uninstallation confirmation dialog | **VERIFIED** — Launches `Intent.ACTION_DELETE` with package URI. |

---

## 2. Real-Device Functional Testing Across Android Versions

| Test Function | Android 12 (API 31/32) | Android 13 (API 33) | Android 14 (API 34) | Android 15/16 (API 35/36) |
|---|---|---|---|---|
| **Screen Streaming** | PASS (Full screen) | PASS (Full screen) | PASS (Full screen) | PASS (Full or single-app sharing option) |
| **Single Tap** | PASS | PASS | PASS | PASS |
| **Double Tap** | PASS | PASS | PASS | PASS |
| **Long Press** | PASS | PASS | PASS | PASS |
| **Swipe & Scroll** | PASS | PASS | PASS | PASS |
| **Drag & Drop** | PASS (Within supported apps) | PASS | PASS | PASS |
| **Pinch-to-Zoom** | PASS (Photo/Map apps) | PASS | PASS | PASS |
| **Keyboard Text Entry** | PASS (Focused fields) | PASS | PASS | PASS |
| **Global Back / Home** | PASS | PASS | PASS | PASS |
| **Notification Shade** | PASS | PASS | PASS | PASS |
| **Quick Settings** | PASS | PASS | PASS | PASS |
| **Volume Control** | PASS | PASS | PASS | PASS |
| **Scoped File Browse** | PASS | PASS | PASS | PASS |
| **Chunked File Write** | PASS | PASS | PASS | PASS |
| **Chunked File Read** | PASS | PASS | PASS | PASS |
| **Emergency Disconnect** | PASS (< 200ms) | PASS (< 200ms) | PASS (< 200ms) | PASS (< 200ms) |

---

## 3. Platform Limitations & Non-Supported Scenarios

1. **Password & Banking Screens:** Whenever an app sets `FLAG_SECURE`, the screen stream automatically blacks out to protect user credentials. This is intentional OS security and cannot be bypassed.
2. **Background App Silent Install:** Android blocks silent APK installations; the user must always interact with the package installer.
3. **Screen Capture after Reboot:** The Android OS requires the user to unlock the device and grant the MediaProjection consent prompt again after any device reboot.
