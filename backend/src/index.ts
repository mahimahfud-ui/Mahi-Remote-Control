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

// Browser access is same-origin on the configured HTTPS host. Native clients
// do not use browser CORS, so wildcard origins are unnecessary.
app.set('trust proxy', 1);
const configuredOrigin = (() => {
  try {
    const parsed = new URL(process.env.PUBLIC_BASE_URL || '');
    return parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
})();
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || (configuredOrigin && origin === configuredOrigin)) {
      callback(null, true);
      return;
    }
    callback(new Error('CORS origin is not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Id', 'X-Device-Fingerprint', 'X-Device-Name', 'X-Client-Role', 'X-Operator-Fingerprint']
}));

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
  console.log(`IP-Based Access:     http://${host === '0.0.0.0' ? '<YOUR_PUBLIC_IP>' : host}:${port}`);
  console.log(`WebSocket Signaling: ws://${host === '0.0.0.0' ? '<YOUR_PUBLIC_IP>' : host}:${port}/ws`);
  console.log(`=======================================================`);
});
