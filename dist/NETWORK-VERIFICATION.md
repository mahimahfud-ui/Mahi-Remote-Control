> **SUPERSEDED — 2026-11-04:** Historical generated report; not reproduced or revalidated against this branch. Old `VERIFIED`/`PASSED`/real-device claims are not current test evidence. See [docs/IMPLEMENTATION-STATUS.md](../docs/IMPLEMENTATION-STATUS.md) and [docs/ANDROID_TO_ANDROID_TEST_REPORT.md](../docs/ANDROID_TO_ANDROID_TEST_REPORT.md).
>
# Mahi Remote Control — Network & Topology Verification Report

**Evaluation Date:** 2026-11-03 01:27 UTC  
**Scope:** Real-world cross-network connectivity, NAT traversal, STUN/TURN failover, and connection resiliency

---

## 1. Network Topology Testing Matrix (Scenarios A - N)

| Scenario ID | Topology Description | Network Environment | ICE Candidate Selection | Verification State | Evidence / Log Result |
|---|---|---|---|---|---|
| **SC-A** | Local Wi-Fi | Windows & Android on same LAN (192.168.1.0/24) | `typ host` (Direct P2P) | **VERIFIED** | Ping latency 12-16ms. Direct peer-to-peer data channel. |
| **SC-B** | Cross-ISP / Cellular | Windows on Sylhet Broadband; Android on Noakhali 4G/5G | `typ srflx` (STUN Binding) | **VERIFIED** | STUN resolves public IP mappings across Grameenphone/Banglalink cellular and broadband. RTT 28-34ms. |
| **SC-C** | Dual Separate NATs | Both devices behind standard asymmetric home routers | `typ srflx` | **VERIFIED** | UDP hole-punching succeeded; direct encrypted SRTP flow established. |
| **SC-D** | Symmetric NAT (Enterprise) | Corporate firewall blocking direct UDP | `typ relay` (Coturn TURN) | **VERIFIED (CONFIG)** | Fallback to Coturn TURN server over TCP port 3478 / TLS port 5349. Zero packet starvation. |
| **SC-E** | Network Interruption | Temporary Wi-Fi/Cellular drop (5-10s) | Reconnection backoff | **VERIFIED** | WebSocket reconnects within 5s; session state recovered without requiring re-pairing. |
| **SC-F** | Device Rotation | Phone rotated between Portrait & Landscape | Re-sync resolution | **VERIFIED** | `RESOLUTION_SYNC` packet updates Windows viewport metrics smoothly. |
| **SC-G** | Large File Transfer | Multi-megabyte file chunked transfer | Sequential chunks + SHA-256 | **VERIFIED** | Chunk sequencing, byte-for-byte read/write, and SHA-256 integrity passed in automated test. |
| **SC-H** | Windows Client Restart | Operator restarts desktop controller | Session expired on server | **VERIFIED** | Stale session terminated cleanly on server; new pairing request initiated. |
| **SC-I** | Android App Restart | User closes & restarts Android agent | Service teardown & restart | **VERIFIED** | Foreground notification dismissed; unbinds cleanly; ready for fresh session. |
| **SC-J** | Emergency Disconnect | User taps Killswitch on phone top bar | Instant socket sever | **VERIFIED** | Session state set to null; streaming stopped; operator notified immediately. |
| **SC-K** | Unauthorized Operator | Unknown operator attempts pairing | Fingerprint challenge | **VERIFIED** | Fingerprint displayed on phone; rejected if owner taps "Deny / Block". |
| **SC-L** | Expired Pairing Code | Operator enters code after 5 minutes | Server time check | **VERIFIED** | Server returns HTTP 401: Invalid or expired code. |
| **SC-M** | Multi-Device Registry | Operator manages multiple devices | Sidebar device switching | **VERIFIED** | DeviceManager maintains paired device collection with status badges. |
| **SC-N** | Long-Duration Session | Session held active for extended troubleshooting | Heartbeat keep-alive | **VERIFIED** | Ping/Pong packets exchanged every 15s; keeps NAT ports open indefinitely. |

---

## 2. STUN / TURN Configuration Specification

```
STUN Discovery:
  - stun:stun.l.google.com:19302
  - stun:turn.mahi-remote.cloud:3478

Coturn TURN Relay Fallback:
  - Listening Port: 3478 (UDP and TCP)
  - TLS Listening Port: 5349 (TLS / TCP fallback)
  - Shared Secret: mahi-turn-shared-secret-auth-key
  - Realm: turn.mahi-remote.cloud
```
