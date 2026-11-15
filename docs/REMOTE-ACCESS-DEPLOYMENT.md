# Mahi Remote Control — Remote Access Deployment

The backend deployment architecture and current acceptance status are maintained in [BACKEND-PRODUCTION-REPORT.md](BACKEND-PRODUCTION-REPORT.md). The shared Android/backend protocol is specified in [BACKEND-ANDROID-CONTRACT.md](BACKEND-ANDROID-CONTRACT.md).

## Public endpoint model

Deploy one public HTTPS origin for browser UI, REST API and signaling:
- Browser controller: `https://<DOMAIN>/connect`
- Runtime configuration: `https://<DOMAIN>/api/v1/config`
- Liveness: `https://<DOMAIN>/api/v1/health`
- Readiness: `https://<DOMAIN>/api/v1/ready`
- Signaling: `wss://<DOMAIN>/ws?protocolVersion=1`

Android must use the configured origin and WSS URL supplied by the server. It must enroll/authenticate with a P-256 Android Keystore key before establishing a receiver WebSocket. Do not embed JWT, pairing pepper, database or TURN shared secrets in Android or browser code.

## Deployment files

- `infrastructure/deployment/docker-compose.yml`: PostgreSQL 16, signaling backend, Caddy HTTPS proxy and Coturn.
- `infrastructure/deployment/Caddyfile`: public HTTPS and WebSocket reverse proxy.
- `infrastructure/deployment/.env.example`: private root deployment environment template.
- `infrastructure/deployment/coturn.conf`: authenticated TURN and relay port configuration.
- `backend/migrations/*.sql`: authoritative PostgreSQL schema and migration history.
- `backend/.env.example`: reference backend runtime environment.

The old `infrastructure/database/schema.sql` is deprecated. Back up any existing database before applying the v1 migration: incompatible legacy tables are renamed to `legacy_*_v1` and are not treated as securely enrolled v1 identities.

## Required network access

Configure DNS records for both the HTTPS domain and the TURN hostname. Permit:

| Port | Protocol | Purpose |
|---|---|---|
| 80 | TCP | Caddy ACME HTTP challenge and redirect |
| 443 | TCP | HTTPS and WSS browser/API access |
| 443 | UDP | Optional HTTP/3 |
| 3478 | UDP and TCP | Coturn STUN/TURN listener |
| 49152–65535 | UDP | Coturn media relay allocation |

Do not expose PostgreSQL port 5432 publicly. Coturn TURN/TLS on 5349 is not enabled until real certificate/key files are provisioned.

## Start and verify

From the repository root, copy the deployment environment template to a private `.env`, set a real domain/URLs and independent random secrets, then run:

```bash
cp infrastructure/deployment/.env.example .env
# Generate separate values with: openssl rand -hex 32
docker compose --env-file .env -f infrastructure/deployment/docker-compose.yml config
docker compose --env-file .env -f infrastructure/deployment/docker-compose.yml up -d --build
docker compose --env-file .env -f infrastructure/deployment/docker-compose.yml ps
```

From an external network, verify:

```bash
curl -fsS https://<DOMAIN>/api/v1/health
curl -fsS https://<DOMAIN>/api/v1/ready
curl -fsS https://<DOMAIN>/api/v1/config
```

A green local container build is not evidence of a live deployment. Production acceptance also requires authenticated Android enrollment, approved browser pairing, real WSS, external TURN relay and cross-network video/control tests.

## Build

The public origin is safe to include in the Android build configuration. Backend secrets are not.

```bash
gradle :app:assembleDebug -PPUBLIC_BASE_URL=https://<DOMAIN>
gradle :app:assembleRelease -PPUBLIC_BASE_URL=https://<DOMAIN>

cd backend
npm ci
npm run build
npm test
```

The backend integration test suite requires a disposable PostgreSQL instance via `DATABASE_URL`. Release signing still requires the owner's private Android signing key and must remain outside source control.