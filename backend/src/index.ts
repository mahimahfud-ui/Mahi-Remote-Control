import 'dotenv/config';
import http from 'http';
import path from 'path';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { apiRouter } from './api/routes';
import { SignalingHub } from './signaling/SignalingHub';

const app = express();
const port = Number.parseInt(process.env.PORT || '8080', 10);
const host = process.env.HOST || '0.0.0.0';

function allowedOrigins(): Set<string> {
  const values = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const publicBase = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (publicBase) values.push(publicBase);
  if (process.env.NODE_ENV !== 'production') {
    values.push('http://localhost:8080', 'http://127.0.0.1:8080');
  }
  return new Set(values);
}

const origins = allowedOrigins();
app.disable('x-powered-by');
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || origins.has(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by Mahi Remote Control.'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 'Authorization', 'X-Device-Id',
    'X-Device-Fingerprint', 'X-Device-Name', 'X-Client-Role',
    'X-Operator-Fingerprint',
  ],
  maxAge: 600,
}));
app.use(express.json({ limit: '1mb', strict: true }));

app.use('/api/v1', apiRouter);

const publicDir = path.join(__dirname, '../public');
app.use(express.static(publicDir, {
  etag: true,
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
}));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
  res.sendFile(path.join(publicDir, 'index.html'));
});

const server = http.createServer(app);
server.headersTimeout = 15000;
server.requestTimeout = 30000;

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 1024 * 1024,
  perMessageDeflate: false,
  verifyClient: (info, callback) => {
    const origin = info.origin;
    if (!origin || origins.has(origin)) callback(true);
    else callback(false, 403, 'Origin is not allowed.');
  },
});
new SignalingHub(wss);

server.listen(port, host, () => {
  const publicBase = process.env.PUBLIC_BASE_URL || 'not configured';
  const coturnReady = !!(process.env.TURN_URL && process.env.TURN_SECRET && process.env.TURN_SECRET.length >= 32);
  const cloudflareTurnReady = !!(process.env.CLOUDFLARE_TURN_KEY_ID && process.env.CLOUDFLARE_TURN_API_TOKEN);
  const turnReady = coturnReady || cloudflareTurnReady;
  console.log('Mahi Remote Control signaling service started.');
  console.log('Local listener:', host + ':' + port);
  console.log('Public HTTPS origin:', publicBase);
  console.log('Browser access:', process.env.PUBLIC_BASE_URL ? process.env.PUBLIC_BASE_URL.replace(/\/+$/, '') + '/connect' : 'DISABLED');
  console.log('TURN relay:', turnReady ? 'configured' : 'NOT CONFIGURED');
  if (process.env.NODE_ENV === 'production') {
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
      console.error('FATAL: Set JWT_SECRET to at least 32 random characters.');
      process.exit(1);
    }
    if (!/^https:\/\//i.test(process.env.PUBLIC_BASE_URL || '')) {
      console.error('FATAL: Set PUBLIC_BASE_URL to the public HTTPS origin.');
      process.exit(1);
    }
    if (!turnReady) console.error('WARNING: TURN is missing; restrictive mobile networks may fail to connect.');
  }
});
