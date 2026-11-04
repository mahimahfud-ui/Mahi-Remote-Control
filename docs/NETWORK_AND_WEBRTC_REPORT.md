# Network and WebRTC — Current Status

## Intended topology

Different Internet connections are supported by design. Both endpoints connect to a public HTTPS/WSS signaling origin. WebRTC ICE attempts direct host/server-reflexive connectivity and uses TURN relay when direct connectivity is blocked. A shared Wi-Fi network is not required.

## Current code status

- The backend can create short-lived, HMAC-based TURN credentials after verifying an owner-approved session token.
- `/api/v1/config` returns a browser HTTPS URL and WSS signaling URL only when `PUBLIC_BASE_URL` is configured.
- Browser code has SDP offer creation, answer handling, ICE candidate exchange and receive-only video negotiation.
- The signaling server restricts sensitive session messages to the two approved session participants.
- Docker/Coturn configuration takes the TURN shared secret from runtime environment variables rather than tracked source.

## Critical implementation gap

The Android receiver currently does not publish a WebRTC video track. `ScreenCaptureService` deliberately fails closed after the system MediaProjection consent result and does not create a fake `LIVE` state. There is no native Android PeerConnection manager that handles SDP/ICE and adds the captured screen track. Therefore the browser offer cannot yet receive actual video, and Android-to-Android WebRTC media is not complete.

## Network limitations

- Public HTTPS/WSS hosting, DNS, TLS and firewall configuration are still deployment tasks.
- Coturn must be deployed on a publicly reachable host. Open UDP/TCP 3478 and the configured UDP relay range 49152–65535.
- The sample does not configure a TURN TLS certificate; do not advertise `turns:` until certificates are configured.
- Cloudflare HTTP tunnel can proxy the browser and WebSocket signaling route but does not relay raw WebRTC UDP media.
- Backend pairing/session/device data is currently process memory. Multiple backend replicas or restarts require durable shared storage before production.

## Verification

No real same-Wi-Fi, cross-Wi-Fi, mobile-data, CGNAT, or TURN relay test has been run for this branch. The existence of a Coturn configuration or the `turnConfigured` boolean is not proof of network reachability. Test actual selected ICE candidate type and decoded video frames on physical devices.
