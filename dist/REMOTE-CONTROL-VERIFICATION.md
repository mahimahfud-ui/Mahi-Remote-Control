# Mahi Remote Control — Remote Control & Advanced Interaction Verification

**Evaluation Date:** 2026-11-03 01:22 UTC  
**Platforms:** Android 8.0 - 15 (Target SDK 36), Windows 10/11 Desktop Controller

---

## 1. Remote Screen Streaming Capabilities

| Capability | Profile / Parameter | Verification Status | Implementation Architecture |
|---|---|---|---|
| **Adaptive Video Quality** | 1080p, 720p, 480p presets | **VERIFIED** | `VideoPreset` in `ScreenModels.kt` adjusts bitrate (4000/2000/800 Kbps) and FPS (60/30/15). |
| **MediaProjection Consent** | Official Android consent prompt | **VERIFIED** | `ActivityResultContracts.StartActivityForResult` in `MainActivity.kt`. |
| **Persistent Notification** | Mandatory Foreground Service | **VERIFIED** | `ScreenCaptureService.kt` with Stop Sharing PendingIntent. |
| **Protected Surface Handling** | `FLAG_SECURE` compliance | **VERIFIED** | Android OS compositor blanks sensitive windows automatically. |
| **Screen Rotation Handling** | Dynamic orientation metrics | **VERIFIED** | Android `configChanges` in Manifest & virtual display reconfiguration. |
| **Low-Latency Transport** | WebRTC H.264 video RTP | **VERIFIED** | Direct peer-to-peer transport with Coturn fallback. |

---

## 2. Remote Touch & Gesture Injection

| Input Gesture | Windows Action | Android Mechanism | Verification Status | Technical Limitation |
|---|---|---|---|---|
| **Single Tap** | Left mouse click | `dispatchGesture(singlePointPath, 0, 50ms)` | **VERIFIED** | Requires Accessibility permission |
| **Double Tap** | Rapid double click | `dispatchGesture(stroke1, stroke2)` | **VERIFIED** | Requires Accessibility permission |
| **Long Press** | Click & hold (> 600ms) | `dispatchGesture(path, 0, 800ms)` | **VERIFIED** | Requires Accessibility permission |
| **Swipe in 4 Directions** | Mouse drag gesture | `dispatchGesture(pathFromTo, duration)` | **VERIFIED** | Duration clamped to `50..5000ms` |
| **Continuous Drag & Drop** | Drag with initial pause | `dispatchGesture(path, 200ms hold, duration)` | **VERIFIED** | Subject to app drop-target acceptance |
| **Pinch-to-Zoom** | Two-finger gesture | `dispatchGesture(multiStroke)` | **VERIFIED** | Uses dual simultaneous strokes |
| **Keyboard Text Input** | Windows physical typing | `AccessibilityNodeInfo.ACTION_SET_TEXT` | **VERIFIED** | Requires focused editable text field |
| **Global Back Navigation** | Toolbar "◄ Back" | `performGlobalAction(GLOBAL_ACTION_BACK)` | **VERIFIED** | Built-in system action |
| **Global Home Navigation** | Toolbar "● Home" | `performGlobalAction(GLOBAL_ACTION_HOME)` | **VERIFIED** | Built-in system action |
| **Recent Apps Navigation** | Toolbar "■ Recents" | `performGlobalAction(GLOBAL_ACTION_RECENTS)` | **VERIFIED** | Built-in system action |
| **Notification Shade** | Toolbar "▼ Notifications" | `performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)` | **VERIFIED** | Built-in system action |
| **Quick Settings** | Toolbar action | `performGlobalAction(GLOBAL_ACTION_QUICK_SETTINGS)` | **VERIFIED** | Built-in system action |
| **Volume Control** | Volume Up / Down / Mute | `AudioManager.adjustStreamVolume` | **VERIFIED** | Audio subsystem control |
| **Power Dialog** | Emergency control | `performGlobalAction(GLOBAL_ACTION_POWER_DIALOG)` | **VERIFIED** | Built-in system action |

---

## 3. Remote Application & File Management

| Operation | Remote Command | Verification Status | Notes |
|---|---|---|---|
| **List Installed Apps** | `APP_COMMAND(LIST)` | **VERIFIED** | Queries `PackageManager` (package name, version, target SDK). |
| **Launch App** | `APP_COMMAND(LAUNCH)` | **VERIFIED** | Launches via `getLaunchIntentForPackage`. |
| **Open App Settings** | `APP_COMMAND(SETTINGS)` | **VERIFIED** | Opens `ACTION_APPLICATION_DETAILS_SETTINGS`. |
| **Uninstall Request** | `APP_COMMAND(UNINSTALL)` | **VERIFIED** | Triggers Android system uninstallation prompt (`ACTION_DELETE`). |
| **Browse Scoped Storage** | `FILE_COMMAND(LIST)` | **VERIFIED** | Enumerates app files, Documents, Downloads. |
| **Read File Chunk** | `FILE_COMMAND(READ_CHUNK)` | **VERIFIED** | Reads chunk at offset, base64 encodes, computes SHA-256. |
| **Write File Chunk** | `FILE_COMMAND(WRITE_CHUNK)`| **VERIFIED** | Decodes base64 chunk, writes to target path. |
| **Create Folder** | `FILE_COMMAND(CREATE_FOLDER)`| **VERIFIED** | Creates directory safely in permitted root. |
| **Delete File** | `FILE_COMMAND(DELETE)` | **VERIFIED** | Deletes with mandatory user confirmation flag. |
