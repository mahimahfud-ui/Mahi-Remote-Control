import 'dotenv/config';
import http from 'http';
import path from 'path';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { apiRouter } from './api/routes';
import { SignalingHub } from './signaling/SignalingHub';

const app = express();
const port = parseInt(process.env.PORT || '8080', 10);
const host = process.env.HOST || '0.0.0.0';
const configuredPublicUrl = process.env.PUBLIC_BASE_URL || '';
const configuredOrigin = configuredPublicUrl ? new URL(configuredPublicUrl).origin : '';
if (process.env.NODE_ENV === 'production' &&
    (!configuredOrigin || new URL(configuredPublicUrl).protocol !== 'https:')) {
  throw new Error('Production requires PUBLIC_BASE_URL to be a valid HTTPS URL.');
}

app.disable('x-powered-by');

// Same-origin browser requests and native Android clients do not need a wildcard
// CORS policy. Cross-origin browser access is restricted to the configured HTTPS origin.
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (configuredOrigin && origin === configuredOrigin) return callback(null, true);
    if (process.env.NODE_ENV !== 'production') {
      try {
        const parsed = new URL(origin);
        if (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
          return callback(null, true);
        }
      } catch {
        // Reject malformed origins below.
      }
    }
    return callback(new Error('Origin is not allowed by this server.'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Id', 'X-Device-Fingerprint', 'X-Device-Name', 'X-Client-Role', 'X-Operator-Fingerprint']
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  );
  next();
});

app.use(express.json({ limit: '1mb' }));

// API Endpoints
app.use('/api/v1', apiRouter);

// Serve Web Browser Controller Static Files
const publicDir = path.join(__dirname, '../public');
app.use(express.static(publicDir));

// Fallback to index.html for SPA routing
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ws')) {
    return next();
  }
  res.sendFile(path.join(publicDir, 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

new SignalingHub(wss);

server.listen(port, host, () => {
  console.log(`=======================================================`);
  console.log(`  MAHI REMOTE CONTROL — BROWSER CONTROLLER ACTIVE     `);
  console.log(`=======================================================`);
  console.log(`Local Access:        http://localhost:${port}`);
  console.log(`Public HTTPS URL:    ${process.env.PUBLIC_BASE_URL || 'NOT CONFIGURED'}`);
  console.log(`WebSocket Signaling: ${process.env.PUBLIC_BASE_URL ? process.env.PUBLIC_BASE_URL.replace(/^https:/, 'wss:') + '/ws' : 'NOT CONFIGURED'}`);
  console.log(`=======================================================`);
});
