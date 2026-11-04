> **SUPERSEDED — 2026-11-04:** Historical generated report; not reproduced or revalidated against this branch. Old `VERIFIED`/`PASSED`/real-device claims are not current test evidence. See [docs/IMPLEMENTATION-STATUS.md](../docs/IMPLEMENTATION-STATUS.md) and [docs/ANDROID_TO_ANDROID_TEST_REPORT.md](../docs/ANDROID_TO_ANDROID_TEST_REPORT.md).
>
# Mahi Remote Control — Production Readiness & Deployment Guide

This document provides step-by-step instructions for deploying Mahi Remote Control into production cloud and workstation environments.

---

## 1. Environment Variable Template (`.env.production`)

```env
# Mahi Remote Production Configuration
PORT=8080
NODE_ENV=production

# PostgreSQL / Supabase Connection
DATABASE_URL=postgres://mahi_admin:STRONG_GENERATED_PASSWORD@postgres-host:5432/mahi_remote

# JWT Cryptographic Secret (Minimum 32 random characters)
JWT_SECRET=GENERATED_64_CHAR_HEX_SECRET_KEY_FOR_MAHI_REMOTE_JWT

# Public Domain & Signaling
PUBLIC_DOMAIN=mahi-remote.cloud
SIGNALING_PUBLIC_URL=wss://signaling.mahi-remote.cloud/ws

# Coturn STUN / TURN Relay
TURN_SERVER_URL=turn:turn.mahi-remote.cloud:3478
TURN_TLS_URL=turns:turn.mahi-remote.cloud:5349
TURN_SECRET=GENERATED_STATIC_AUTH_SECRET_FOR_COTURN_RELAY
```

---

## 2. PostgreSQL / Supabase Schema Migration

To initialize a production PostgreSQL database:
```bash
# 1. Connect using psql or Supabase SQL Editor
psql -h <POSTGRES_HOST> -U mahi_admin -d mahi_remote -f infrastructure/database/schema.sql

# 2. Verify Row-Level Security (RLS) is enabled
psql -h <POSTGRES_HOST> -U mahi_admin -d mahi_remote -c "SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public';"
```

---

## 3. Production Docker Deployment

Deploy the backend, Coturn TURN server, and monitoring via Docker Compose:
```bash
cd infrastructure/deployment

# 1. Inspect environment configuration
cp ../../.env.production .env

# 2. Launch multi-container stack
docker compose up -d --build

# 3. Verify services health
docker compose ps
curl -s http://localhost:8080/api/v1/health | jq
```

---

## 4. Production TLS / SSL Setup (Let's Encrypt / Certbot)

For production HTTPS and WSS:
```bash
# Obtain Let's Encrypt certificates for the public signaling and TURN domains
sudo certbot certonly --standalone -d signaling.mahi-remote.cloud -d turn.mahi-remote.cloud

# Mount certificates into Coturn and NGINX reverse proxy:
# /etc/letsencrypt/live/signaling.mahi-remote.cloud/fullchain.pem
# /etc/letsencrypt/live/signaling.mahi-remote.cloud/privkey.pem
```

---

## 5. Signed Android Release APK Build

To generate an officially signed Release APK for distribution:
```bash
# 1. Provide keystore credentials via environment variables
export KEYSTORE_PATH="/path/to/your/upload-keystore.jks"
export STORE_PASSWORD="your-keystore-password"
export KEY_PASSWORD="your-key-password"

# 2. Compile Release APK
gradle :app:assembleRelease

# 3. Output is produced at:
# app/build/outputs/apk/release/app-release.apk
```

---

## 6. Windows Controller Compilation & Packaging

On a Windows 10/11 development workstation:
```powershell
# 1. Open PowerShell and navigate to repository root
cd mahi-remote-control

# 2. Compile standalone single-file binary with self-contained runtime
./scripts/build-windows.ps1 -Configuration Release

# 3. Output executable:
# dist/MahiRemote-Windows-Setup.exe
```
