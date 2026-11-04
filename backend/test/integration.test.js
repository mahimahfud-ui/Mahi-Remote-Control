const http = require('http');
const express = require('express');
const { WebSocket, WebSocketServer } = require('ws');
const assert = require('assert');

process.env.JWT_SECRET = 'integration-test-secret-32-bytes-minimum-length';
process.env.TURN_SECRET = 'integration-test-turn-secret-32-bytes-minimum';
process.env.TURN_URL = 'turn:127.0.0.1:3478';
process.env.STUN_URL = 'stun:stun.l.google.com:19302';

const { apiRouter } = require('../dist/api/routes');
const { SignalingHub } = require('../dist/signaling/SignalingHub');
const { DeviceService } = require('../dist/device-management/DeviceService');
const { AuthService } = require('../dist/authentication/AuthService');

const PORT = 8099;
const BASE = 'http://127.0.0.1:' + PORT;

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), 4000);
    socket.once('open', () => { clearTimeout(timer); resolve(); });
    socket.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

function waitForMessage(socket, type, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', listener);
      reject(new Error('Timed out waiting for ' + type));
    }, timeoutMs);
    const listener = raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.type !== type) return;
      clearTimeout(timer);
      socket.off('message', listener);
      resolve(message);
    };
    socket.on('message', listener);
  });
}

function connectAndroid(id, role, fingerprint) {
  return new WebSocket('ws://127.0.0.1:' + PORT + '/ws', {
    headers: {
      'x-device-id': id,
      'x-device-fingerprint': fingerprint,
      'x-device-name': id,
      'x-client-role': role,
    },
  });
}

async function runTests() {
  console.log('=== Mahi Remote Control secure pairing/signaling tests ===');
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1', apiRouter);

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 });
  new SignalingHub(wss);
  await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve));

  let receiver;
  let controller;
  try {
    const health = await fetch(BASE + '/api/v1/health');
    assert.strictEqual(health.status, 200);
    const config = await fetch(BASE + '/api/v1/config');
    const configJson = await config.json();
    assert.strictEqual(configJson.publicAccessConfigured, false);
    console.log('✓ health and explicit public URL configuration state');

    const legacyVerify = await fetch(BASE + '/api/v1/pair/verify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '123456', operatorFingerprint: 'web-test' }),
    });
    assert.strictEqual(legacyVerify.status, 410);
    console.log('✓ legacy pairing endpoint cannot mint a token before owner approval');

    receiver = connectAndroid('receiver-test', 'RECEIVER', 'RECEIVER-FINGERPRINT-0001');
    controller = connectAndroid('controller-test', 'CONTROLLER', 'CONTROLLER-FINGERPRINT-0001');
    await Promise.all([waitForOpen(receiver), waitForOpen(controller)]);

    const code = '482915';
    const codeAck = waitForMessage(receiver, 'CODE_REGISTERED_ACK');
    receiver.send(JSON.stringify({
      type: 'REGISTER_PAIRING_CODE',
      code,
      expiresAt: Date.now() + 5 * 60 * 1000,
    }));
    await codeAck;
    console.log('✓ receiver registers a short-lived six-digit code');

    const requestPromise = waitForMessage(receiver, 'PAIR_REQUEST');
    const pendingPromise = waitForMessage(controller, 'PAIR_PENDING');
    controller.send(JSON.stringify({
      type: 'PAIR_BY_CODE',
      code,
      fingerprint: 'CONTROLLER-FINGERPRINT-0001',
      controllerName: 'Integration test controller',
      requestedScopes: ['SCREEN_VIEW', 'REMOTE_INPUT'],
    }));
    const [request, pending] = await Promise.all([requestPromise, pendingPromise]);
    assert.strictEqual(request.controllerId, 'controller-test');
    assert.strictEqual(pending.receiverId, 'receiver-test');
    console.log('✓ shared Android pairing protocol creates a pending request without consuming the code');

    const blocked = waitForMessage(controller, 'SESSION_REQUIRED');
    controller.send(JSON.stringify({
      type: 'SDP_OFFER',
      targetDeviceId: 'receiver-test',
      payload: { type: 'offer', sdp: 'not-allowed-before-approval' },
    }));
    await blocked;
    console.log('✓ SDP signaling is blocked until explicit receiver approval');

    const pairAccepted = waitForMessage(controller, 'PAIR_ACCEPT');
    const receiverAuthorized = waitForMessage(receiver, 'SESSION_AUTHORIZED');
    const controllerAuthorized = waitForMessage(controller, 'SESSION_AUTHORIZED');
    receiver.send(JSON.stringify({
      type: 'PAIR_ACCEPT',
      recipient: 'controller-test',
      payload: { status: 'APPROVED' },
    }));
    const [, receiverAuth, controllerAuth] = await Promise.all([
      pairAccepted, receiverAuthorized, controllerAuthorized,
    ]);
    assert(receiverAuth.sessionToken);
    assert(controllerAuth.sessionToken);
    assert.strictEqual(receiverAuth.sessionId, controllerAuth.sessionId);
    console.log('✓ session tokens are issued only after receiver approval');

    const authorizedInput = waitForMessage(receiver, 'INPUT_EVENT');
    controller.send(JSON.stringify({
      type: 'INPUT_EVENT',
      targetDeviceId: 'receiver-test',
      payload: { command: { type: 'TAP', x: 10, y: 20 } },
    }));
    const relayed = await authorizedInput;
    assert.strictEqual(relayed.sender, 'controller-test');
    console.log('✓ approved peer-only command relay');

    const turn = await fetch(BASE + '/api/v1/turn/credentials', {
      method: 'POST', headers: { Authorization: 'Bearer ' + controllerAuth.sessionToken },
    });
    assert.strictEqual(turn.status, 200);
    const turnJson = await turn.json();
    assert(turnJson.iceServers.some(server => server.username && server.credential));
    console.log('✓ dynamic short-lived TURN credentials are generated server-side');

    const unauthorizedTurn = await fetch(BASE + '/api/v1/turn/credentials', { method: 'POST' });
    assert.strictEqual(unauthorizedTurn.status, 401);
    console.log('✓ TURN credentials are not public');

    const revoked = waitForMessage(receiver, 'SESSION_REVOKED');
    controller.send(JSON.stringify({
      type: 'EMERGENCY_DISCONNECT',
      payload: { reason: 'integration test emergency stop' },
    }));
    await revoked;
    const deniedAfterStop = waitForMessage(controller, 'SESSION_REQUIRED');
    controller.send(JSON.stringify({
      type: 'INPUT_EVENT',
      targetDeviceId: 'receiver-test',
      payload: { command: { type: 'TAP', x: 10, y: 20 } },
    }));
    await deniedAfterStop;
    console.log('✓ emergency disconnect revokes the session and blocks further commands');

    const rateKey = 'integration-rate-limit-' + Date.now();
    for (let i = 0; i < 5; i++) assert.strictEqual(AuthService.checkRateLimit(rateKey, 5, 60000), true);
    assert.strictEqual(AuthService.checkRateLimit(rateKey, 5, 60000), false);
    console.log('✓ pairing rate limiter enforces its configured threshold');

    const expiredCode = '739154';
    DeviceService.storePairingCode('receiver-test', expiredCode, Date.now() + 200);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.strictEqual(
      DeviceService.beginPairing(expiredCode, 'controller-test', 'Test', 'FP-TEST'),
      null
    );
    console.log('✓ expired pairing codes are rejected');

    console.log('=== ALL SECURE PAIRING/SIGNALING TESTS PASSED ===');
  } finally {
    receiver?.close();
    controller?.close();
    wss.close();
    await new Promise(resolve => server.close(resolve));
  }
}

runTests().catch(error => {
  console.error('TEST FAILURE:', error);
  process.exitCode = 1;
});
