# Mahi Remote Control — Device Compatibility Report

**Evaluation Date:** 2026-11-03 01:22 UTC  
**Target Operating Systems:** Android 8.0 (API 26) through Android 15/16 (API 36)

---

## 1. Android Version Compatibility Matrix

| Android Version | API Level | MediaProjection Screen Streaming | Accessibility Touch Gestures | Scoped Storage SAF File Operations | Magisk / Root Detection | Overall Compatibility |
|---|---|---|---|---|---|---|
| **Android 8.0 - 8.1 (Oreo)** | 26 - 27 | Fully Supported | Fully Supported | Supported (Legacy permissions) | Supported | **COMPATIBLE** |
| **Android 9.0 (Pie)** | 28 | Fully Supported | Fully Supported | Supported | Supported | **COMPATIBLE** |
| **Android 10 (Q)** | 29 | Foreground Service Type `mediaProjection` required | Fully Supported | Scoped Storage Introduced | Supported | **COMPATIBLE** |
| **Android 11 - 12 (R/S)** | 30 - 32 | Fully Supported | Fully Supported | Full Scoped Storage SAF | Supported | **COMPATIBLE** |
| **Android 13 - 14 (T/U)** | 33 - 34 | `POST_NOTIFICATIONS` runtime permission required | Fully Supported | Strict Scoped Storage | Supported | **COMPATIBLE** |
| **Android 15 - 16 (V/Baklava)** | 35 - 36 | Partial screen sharing option in OS dialog | Fully Supported | Strict Scoped Storage | Supported | **COMPATIBLE** |

---

## 2. Hardware Manufacturer & OEM Customization Notes

| Manufacturer | Known Customizations | Special Considerations | Supported Workaround |
|---|---|---|---|
| **Samsung (One UI)** | Aggressive background battery optimization | App may be put to sleep if backgrounded for extended periods. | Request battery optimization exemption (`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`) if needed. |
| **Xiaomi / Redmi (MIUI / HyperOS)** | Secondary permission "Display pop-up windows while running in background" | May suppress floating UI if not granted. | App guides user to MIUI permission manager. |
| **OnePlus / OPPO / Realme (ColorOS)** | Auto-start permission | May terminate background services after screen off. | Persistent Foreground Service with notification maintains process alive. |
| **Google Pixel (Stock Android)** | Standard AOSP behavior | Zero OEM interference. | Default reference implementation. |

---

## 3. Windows Desktop Controller Compatibility

- **Supported OS:** Windows 10 (1903+) and Windows 11 (all versions).
- **Architecture:** x64 and ARM64 (via .NET 10 cross-target compilation).
- **DirectShow / MediaFoundation:** Hardware H.264 decoding supported on Intel, AMD, and NVIDIA graphics.
- **DPI Scaling:** Automatic high-DPI scaling support in WPF.
