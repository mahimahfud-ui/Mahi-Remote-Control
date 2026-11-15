import 'dotenv/config';
import http from 'http';
import path from 'path';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { apiRouter } from './api/routes';
import { SignalingHub } from './signaling/SignalingHub';
import { Database } from './database/Database';

const app = express();
const port = Number.parseInt(process.env.PORT || '8080', 10);
const host = process.env.HOST || '0.0.0.0';

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be a valid TCP port.');
}

const configuredOrigin = (() => {
  try {
    const parsed = new URL(process.env.PUBLIC_BASE_URL || '');
    return parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
})();

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || (configuredOrigin && origin === configuredOrigin)) {
      callback(null, true);
      return;
    }
    callback(new Error('CORS origin is not allowed'));
  },
  credentials: false,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Mahi-Protocol-Version',
    'X-Request-Id',
    'X-Device-Id',
    'X-Device-Name',
    'X-Client-Role',
    'X-Operator-Fingerprint',
  ],
  exposedHeaders: ['X-Mahi-Protocol-Version', 'X-Request-Id'],
  maxAge: 600,
}));
app.use(express.json({ limit: '256kb', strict: true }));
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  next();
});

app.use('/api/v1', apiRouter);

// The browser controller is served from the same HTTPS origin as REST/WSS.
const publicDir = path.join(__dirname, '../public');
app.use(express.static(publicDir, { fallthrough: true, etag: true, maxAge: '5m' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
  res.sendFile(path.join(publicDir, 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 1_048_576,
  perMessageDeflate: false,
});

let signalingHub: SignalingHub | null = null;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] received ${signal}; starting graceful shutdown`);

  const timeout = setTimeout(() => {
    console.error('[server] graceful shutdown timed out');
    process.exit(1);
  }, 15_000);
  timeout.unref?.();

  try {
    if (signalingHub) await signalingHub.close();
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
      for (const socket of wss.clients) socket.close(1001, 'Server shutting down');
    });
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await Database.close();
    clearTimeout(timeout);
    console.log('[server] shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('[server] shutdown failed', error);
    process.exit(1);
  }
}

async function start(): Promise<void> {
  // Do not accept HTTP or WebSocket traffic until the durable store and migrations
  // are ready. This prevents an accidental in-memory or partially migrated mode.
  await Database.initialize();
  await Database.startSignalListener();

  signalingHub = new SignalingHub(wss);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  console.log('[server] Mahi Remote backend started');
  console.log(`[server] listening on ${host}:${port}`);
  console.log(`[server] public origin: ${configuredOrigin || 'NOT CONFIGURED'}`);
  console.log('[server] websocket path: /ws');
  console.log('[server] database and migrations: READY');

  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
}

start().catch(async (error) => {
  console.error('[server] startup failed; refusing to run without required dependencies', error);
  await Database.close().catch(() => undefined);
  process.exit(1);
});
