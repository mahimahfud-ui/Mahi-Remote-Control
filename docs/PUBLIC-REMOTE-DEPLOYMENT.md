# Public Remote Access and Deployment

## No same-Wi-Fi requirement

The intended architecture does not require both devices to share a LAN. Each endpoint uses its own Internet connection. The public HTTPS/WSS service coordinates pairing and session authorization. WebRTC attempts direct ICE connectivity; when direct connectivity fails because of NAT/firewall restrictions, the endpoints need a reachable TURN relay.

A Cloudflare HTTP tunnel may expose the website and WebSocket signaling, but it does not relay WebRTC media by itself. Configure either a reachable Coturn host or Cloudflare Realtime managed TURN for difficult NAT/firewall paths.

## Deployment prerequisites

1. A public DNS name and an HTTPS reverse proxy for the backend.
2. A TURN relay: either a publicly reachable Coturn host with UDP/TCP port 3478 and a permitted UDP relay range, or Cloudflare Realtime managed TURN credentials generated server-side.
3. A reverse proxy which forwards `/ws` as WebSocket and `/api/v1/*` and static browser assets to backend port 8080.
4. A valid `PUBLIC_BASE_URL` which is the public HTTPS origin, with no path suffix.
5. A strong, random `JWT_SECRET`; plus either Coturn's `TURN_SECRET` or Cloudflare's `CLOUDFLARE_TURN_KEY_ID` and `CLOUDFLARE_TURN_API_TOKEN`.

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
| `TURN_URL` | Coturn public TURN URI(s), e.g. `turn:turn.example.com:3478`; leave blank when using managed TURN |
| `TURN_REALM` | Coturn realm, normally the TURN hostname |
| `TURN_SECRET` | Coturn shared HMAC secret; leave blank when using managed TURN |
| `CLOUDFLARE_TURN_KEY_ID` | Cloudflare Realtime TURN key ID (server-side only; alternative to Coturn) |
| `CLOUDFLARE_TURN_API_TOKEN` | Cloudflare API token allowed to generate credentials for that TURN key (server-side only) |
| `POSTGRES_PASSWORD` | Database password for the included Compose database; current live backend registries are still in-memory |
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

TURN media is separate from HTTPS/WSS signaling. For Coturn, publish UDP/TCP 3478 and the configured UDP relay range; start the optional Coturn Compose service with `docker compose --profile coturn up -d`. Cloudflare Realtime managed TURN requires no Coturn host or relay-port firewall configuration; the backend calls Cloudflare to mint short-lived client credentials. Keep the Cloudflare key ID and API token in the hosting provider's secret store, never in app/browser code.

## Verification commands

```sh
curl -fsS https://remote.example.com/api/v1/health
curl -fsS https://remote.example.com/api/v1/config
```

Expected config response must contain `publicAccessConfigured: true`, the actual `/connect` URL, and actual `wss://` endpoint. `turnConfigured: true` only confirms environment variables exist; it does not prove Coturn is reachable.

## What this does not prove

Successful HTTP health checks, WebSocket connection and credential generation do not prove WebRTC media works. Real ICE candidate selection and decoded video frames must be verified from actual endpoints. The Android branch now includes a native WebRTC screen publisher/receiver and real SurfaceViewRenderer, but it still requires a successful Android build and two-device physical verification before release.

