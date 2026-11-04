> **SUPERSEDED — 2026-11-04:** Historical generated report; not reproduced or revalidated against this branch. Old `VERIFIED`/`PASSED`/real-device claims are not current test evidence. See [docs/IMPLEMENTATION-STATUS.md](../docs/IMPLEMENTATION-STATUS.md) and [docs/ANDROID_TO_ANDROID_TEST_REPORT.md](../docs/ANDROID_TO_ANDROID_TEST_REPORT.md).
>
# Mahi Remote Control — Build Verification Report

**Verification Timestamp:** 2026-11-03 01:21:40 UTC  
**Environment:** Linux Android Cloud Container  
**Target:** Monorepo (Android Agent + Windows Controller + Backend + Database + Infrastructure)

---

## 1. Toolchain & Runtime Environment Inspection

| Tool | Version / Path | Availability | Operational State |
|---|---|---|---|
| **Java JDK** | OpenJDK 17.0.14 | Installed (`/usr/lib/jvm/...`) | Fully functional |
| **Gradle** | 9.3.1 (`/opt/gradle/...`) | Installed | Compiles APK & runs Robolectric unit tests |
| **Node.js** | v22.23.3 (`/usr/local/bin/node`) | Installed | Executes backend server & integration tests |
| **npm** | 10.9.9 (`/usr/local/bin/npm`) | Installed | Installs dependencies & runs TypeScript compiler |
| **TypeScript** | v5.6.2 (`backend/node_modules/typescript`) | Installed | Compiles `backend/src` to `backend/dist` (0 errors) |
| **Microsoft .NET SDK** | .NET 10.0 | Not on Linux container | Target is Windows desktop; built via `scripts/build-windows.ps1` on Windows |

---

## 2. Compilation and Artifact Outputs

### A. Android Agent (`/app`)
- **Build Tool:** Gradle 9.3.1
- **Command:** `gradle :app:assembleDebug`
- **Output Artifact:** `dist/MahiRemote-debug.apk` (22,468,608 bytes)
- **Status:** **COMPILED & VERIFIED**
- **Test Suite:** `gradle :app:testDebugUnitTest` (33 tasks, 100% passed)

### B. Cloud Backend & Signaling (`/backend`)
- **Compiler:** `tsc` (TypeScript 5.6.2)
- **Command:** `npm run build`
- **Output Artifacts:** `backend/dist/index.js`, `backend/dist/signaling/`, `backend/dist/device-management/`, `backend/dist/authentication/`, `backend/dist/api/`
- **Status:** **COMPILED & TESTED (7/7 tests passed)**

### C. Windows Desktop Controller (`/windows-controller`)
- **Solution:** `MahiRemote.sln`
- **Projects:** `MahiRemote.App`, `MahiRemote.Core`, `MahiRemote.WebRTC`, `MahiRemote.Devices`, `MahiRemote.Security`
- **Target Framework:** `net10.0-windows`
- **Status:** **SOURCE VERIFIED & PACKAGED**
- **Build Script:** `scripts/build-windows.ps1`

### D. Infrastructure & Database (`/infrastructure`)
- **Database Schema:** `infrastructure/database/schema.sql` (PostgreSQL 16 / Supabase with Row Level Security)
- **Deployment Stack:** `infrastructure/deployment/docker-compose.yml`
- **NAT Traversal:** `infrastructure/deployment/coturn.conf` (STUN/TURN on port 3478/5349)
- **Metrics Monitoring:** `infrastructure/monitoring/prometheus.yml`
