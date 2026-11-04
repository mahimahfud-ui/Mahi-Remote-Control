# Public Remote Access and Deployment

## No same-Wi-Fi requirement

The intended architecture does not require both devices to share a LAN. Each endpoint uses its own Internet connection. The public HTTPS/WSS service coordinates pairing and session authorization. WebRTC attempts direct ICE connectivity; when direct connectivity fails because of NAT/firewall restrictions, the endpoints need a reachable TURN relay.

A Cloudflare HTTP tunnel may expose the website and WebSocket signaling, but it does not relay arbitrary WebRTC UDP media. A separately deployed TURN server and open relay port range are still required.

## Deployment prerequisites

1. A public DNS name and an HTTPS reverse proxy for the backend.
2. A publicly reachable Coturn host with UDP/TCP port 3478 and UDP relay ports 49152–65535 permitted by the host/network firewall.
3. A reverse proxy which forwards `/ws` as WebSocket and `/api/v1/*` and static browser assets to backend port 8080.
4. A valid `PUBLIC_BASE_URL` which is the public HTTPS origin, with no path suffix.
5. Strong, random `JWT_SECRET`, `TURN_SECRET` and `POSTGRES_PASSWORD` values.

## Configure environment

From this directory:

```sh
cp .env.example .env
# Edit .env and replace every REPLACE_* value with a unique random secret.
docker compose config
docker compose up -d --build
```

Do not commit `.env`. Do not put JWT/TURN secrets into the Android APK or browser JavaScript.

Required variables:

| Variable | Purpose |
|---|---|
| `PUBLIC_BASE_URL` | Public HTTPS browser origin, e.g. `https://remote.example.com` |
| `ALLOWED_ORIGINS` | Exact browser origins allowed by HTTP/WebSocket origin checks |
| `JWT_SECRET` | Server-only session token signing key, at least 32 characters |
| `TURN_URL` | Public TURN URI, e.g. `turn:turn.example.com:3478` |
| `TURN_REALM` | Coturn realm, normally the TURN hostname |
| `TURN_SECRET` | Shared HMAC secret used by backend credential generation and Coturn |
| `POSTGRES_PASSWORD` | Database password; database integration is not yet implemented in the current backend |
| `STUN_URL` | STUN URI(s); optional with Google STUN default in the template |

The backend's `/api/v1/config` endpoint returns `browserUrl` (`PUBLIC_BASE_URL/connect`) and `signalingUrl` (`wss://.../ws`) only when the HTTPS origin is configured.

## Build Android with public backend origin

Set the public origin at build time. It is an endpoint, not a secret:

```sh
MAHI_PUBLIC_BASE_URL=https://remote.example.com gradle :app:assembleDebug
```

On PowerShell:

```powershell
$env:MAHI_PUBLIC_BASE_URL = "https://remote.example.com"
gradle :app:assembleDebug
```

The Android app then retrieves `/api/v1/config` and uses the returned WSS URL. If this value is empty, public access is reported as not configured and the app does not connect to a placeholder hostname.

## TLS and reverse proxy

Terminate HTTPS at Caddy, Nginx, Traefik or another production reverse proxy. Forward WebSocket Upgrade/Connection headers to backend port 8080. Only expose ports 80/443 publicly for the HTTP service; keep the database private.

TURN media is separate: publish Coturn UDP/TCP 3478 and UDP relay range 49152–65535. The current sample Coturn config does not provision TLS certificates for `turns:`. Do not advertise or configure `turns:` until valid certificates and listener configuration have been installed.

## Verification commands

```sh
curl -fsS https://remote.example.com/api/v1/health
curl -fsS https://remote.example.com/api/v1/config
```

Expected config response must contain `publicAccessConfigured: true`, the actual `/connect` URL, and actual `wss://` endpoint. `turnConfigured: true` only confirms environment variables exist; it does not prove Coturn is reachable.

## What this does not prove

Successful HTTP health checks, WebSocket connection and credential generation do not prove WebRTC media works. Real ICE candidate selection and decoded video frames must be verified from actual endpoints. The current Android snapshot still lacks its native WebRTC media pipeline, so full remote video cannot yet pass.

