// PostgreSQL-backed backend integration suite. Requires a disposable PostgreSQL database.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'integration-only-jwt-secret-at-least-32-bytes';
process.env.PAIRING_CODE_PEPPER = process.env.PAIRING_CODE_PEPPER || 'integration-only-pairing-pepper-32-bytes';
process.env.TURN_SERVER_URL = process.env.TURN_SERVER_URL || 'turn:turn.integration.invalid:3478';
process.env.TURN_REALM = process.env.TURN_REALM || 'turn.integration.invalid';
process.env.TURN_SHARED_SECRET = process.env.TURN_SHARED_SECRET || 'integration-only-turn-secret-not-for-production';
process.env.STUN_SERVER_URL = process.env.STUN_SERVER_URL || 'stun:stun.integration.invalid:3478';
process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || 'https://remote.integration.test';
process.env.INSTANCE_ID = 'integration-primary';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');
const cors = require('cors');
const { WebSocket, WebSocketServer } = require('ws');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must point to a disposable PostgreSQL database before running npm test.');
}

const { Database } = require('../dist/database/Database');
const { apiRouter } = require('../dist/api/routes');
const { SignalingHub } = require('../dist/signaling/SignalingHub');
const { DeviceService } = require('../dist/device-management/DeviceService');
const { AuthService } = require('../dist/authentication/AuthService');

const PROTOCOL_HEADERS = {
  'Content-Type': 'application/json',
  'X-Mahi-Protocol-Version': '1',
};

async function postJson(baseUrl, route, body, headers = {}) {
  const response = await fetch(baseUrl + route, {
    method: 'POST',
    headers: { ...PROTOCOL_HEADERS, ...headers },
    body: JSON.stringify({ protocolVersion: 1, ...body }),
  });
  const json = await response.json();
  return { response, json };
}

function canonicalProof(challenge) {
  return [
    'MAHI-REMOTE-DEVICE-PROOF',
    '1',
    challenge.purpose,
    challenge.challengeId,
    challenge.deviceId,
    challenge.fingerprint,
    challenge.nonce,
    String(challenge.expiresAtMs),
  ].join('\n');
}

function signProof(challenge, privateKey) {
  return crypto.sign('sha256', Buffer.from(canonicalProof(challenge), 'utf8'), privateKey).toString('base64');
}

function waitForMessage(ws, predicate, description, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('Timed out waiting for ' + description));
    }, timeoutMs);

    const onMessage = (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(message);
    };
    ws.on('message', onMessage);
  });
}

function waitForOpen(ws, description) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out opening ' + description)), 6000);
    ws.once('open', () => { clearTimeout(timer); resolve(); });
    ws.once('error', (error) => { clearTimeout(timer); reject(error); });
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      reject(new Error(description + ' closed during handshake: ' + code + ' ' + reason.toString()));
    });
  });
}

function closeWebSocket(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* already closed */ }
      resolve();
    }, 1500);
    ws.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    try { ws.close(1000, 'Integration test complete'); } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function findFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHttp(url, child, output, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error('Secondary backend exited before readiness:\n' + output.join(''));
    }
    try {
      const response = await fetch(url + '/api/v1/ready');
      if (response.ok) return;
    } catch {
      // The child is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Secondary backend did not become ready:\n' + output.join(''));
}

async function runTests() {
  console.log('=== MAHI REMOTE POSTGRESQL INTEGRATION TESTS ===');

  let server;
  let wss;
  let hub;
  let child;
  let childStdout = '';
  let childStderr = '';
  const sockets = [];
  let deviceId;
  let persistedDeviceId;

  try {
    await Database.initialize();
    await Database.startSignalListener();

    const app = express();
    app.use(cors());
    app.use(express.json({ limit: '256kb' }));
    app.use('/api/v1', apiRouter);
    server = http.createServer(app);
    wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1_048_576, perMessageDeflate: false });
    hub = new SignalingHub(wss);

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const baseUrl = 'http://127.0.0.1:' + server.address().port;

    // Health/readiness and public configuration must never expose shared secrets.
    const health = await fetch(baseUrl + '/api/v1/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'healthy');

    const ready = await fetch(baseUrl + '/api/v1/ready');
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).status, 'ready');

    const config = await (await fetch(baseUrl + '/api/v1/config')).json();
    assert.equal(config.protocolVersion, 1);
    assert.equal(config.signalingUrl, 'wss://remote.integration.test/ws');
    assert.equal(config.turnConfigured, true);
    assert(!JSON.stringify(config).includes(process.env.TURN_SHARED_SECRET));
    assert(!JSON.stringify(config).toLowerCase().includes('credential'));

    const noTurnAuth = await fetch(baseUrl + '/api/v1/turn-credentials');
    assert.equal(noTurnAuth.status, 401);
    assert.equal((await noTurnAuth.json()).error.code, 'SESSION_REVOKED');
    assert.equal((await fetch(baseUrl + '/api/v1/devices')).status, 410);
    assert.equal((await fetch(baseUrl + '/api/v1/pair/verify', { method: 'POST' })).status, 410);
    console.log('✓ Health/readiness, public config and disabled legacy authorization endpoints');

    // Rate limits are shared in PostgreSQL rather than held in process memory.
    const rateKey = 'integration:' + crypto.randomUUID();
    let limited = false;
    for (let i = 0; i < 5; i++) {
      const allowed = await AuthService.checkRateLimit(rateKey, 3, 10_000);
      if (!allowed) limited = true;
    }
    assert.equal(limited, true);
    console.log('✓ PostgreSQL-backed shared rate limiting');

    // Enrollment uses a real P-256 public key and a server-side challenge signature.
    const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    deviceId = 'MAHI-TEST-' + crypto.randomUUID().slice(0, 8).toUpperCase();
    persistedDeviceId = deviceId;
    const publicKeyBody = {
      format: 'spki-der-base64',
      algorithm: 'EC',
      curve: 'P-256',
      value: publicKey,
    };

    const invalidCurve = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    const invalidKeyResult = await postJson(baseUrl, '/api/v1/devices/enrollment/challenges', {
      deviceId: 'MAHI-INVALID-' + crypto.randomUUID().slice(0, 8),
      deviceName: 'Invalid Curve Device',
      publicKey: {
        ...publicKeyBody,
        value: invalidCurve.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      },
    });
    assert.equal(invalidKeyResult.response.status, 400);
    assert.equal(invalidKeyResult.json.error.code, 'INVALID_PUBLIC_KEY');

    const enrollment = await postJson(baseUrl, '/api/v1/devices/enrollment/challenges', {
      deviceId,
      deviceName: 'Integration Receiver',
      publicKey: publicKeyBody,
    });
    assert.equal(enrollment.response.status, 201);
    assert.equal(enrollment.json.purpose, 'ENROLL');
    assert.match(enrollment.json.fingerprint, /^sha256:[a-f0-9]{64}$/);

    const invalidProof = await postJson(baseUrl, '/api/v1/devices/enrollment/verify', {
      challengeId: enrollment.json.challengeId,
      signature: Buffer.from('not-a-real-signature').toString('base64'),
    });
    assert.equal(invalidProof.response.status, 400);
    assert.equal(invalidProof.json.error.code, 'INVALID_SIGNATURE');

    const enrollmentProof = await postJson(baseUrl, '/api/v1/devices/enrollment/verify', {
      challengeId: enrollment.json.challengeId,
      signature: signProof(enrollment.json, keys.privateKey),
    });
    assert.equal(enrollmentProof.response.status, 201);
    assert.equal(enrollmentProof.json.deviceId, deviceId);
    assert.equal(enrollmentProof.json.tokenType, 'Bearer');
    assert.ok(enrollmentProof.json.deviceAccessToken);

    const replay = await postJson(baseUrl, '/api/v1/devices/enrollment/verify', {
      challengeId: enrollment.json.challengeId,
      signature: signProof(enrollment.json, keys.privateKey),
    });
    assert.equal(replay.response.status, 409);
    assert.equal(replay.json.error.code, 'CHALLENGE_REPLAYED');

    const expiredEnrollment = await postJson(baseUrl, '/api/v1/devices/enrollment/challenges', {
      deviceId: 'MAHI-EXPIRED-' + crypto.randomUUID().slice(0, 8),
      deviceName: 'Expired Challenge Device',
      publicKey: publicKeyBody,
    });
    await Database.query(
      'UPDATE device_challenges SET expires_at = NOW() - INTERVAL \'1 second\' WHERE challenge_id = $1',
      [expiredEnrollment.json.challengeId]
    );
    const expiredProof = await postJson(baseUrl, '/api/v1/devices/enrollment/verify', {
      challengeId: expiredEnrollment.json.challengeId,
      signature: signProof(expiredEnrollment.json, keys.privateKey),
    });
    assert.equal(expiredProof.response.status, 409);
    assert.equal(expiredProof.json.error.code, 'CHALLENGE_EXPIRED');

    // Device authentication produces a distinct short-lived device bearer token.
    const authChallenge = await postJson(baseUrl, '/api/v1/devices/auth/challenges', { deviceId });
    assert.equal(authChallenge.response.status, 201);
    assert.equal(authChallenge.json.purpose, 'AUTHENTICATE');
    const deviceLogin = await postJson(baseUrl, '/api/v1/devices/auth/verify', {
      challengeId: authChallenge.json.challengeId,
      signature: signProof(authChallenge.json, keys.privateKey),
    });
    assert.equal(deviceLogin.response.status, 200);
    assert.ok(deviceLogin.json.deviceAccessToken);
    const deviceToken = deviceLogin.json.deviceAccessToken;
    console.log('✓ P-256 enrollment, invalid proof rejection, challenge expiry/replay and device authentication');

    // A device with a valid token must establish presence before it can publish a pairing code.
    const receiverUrl = 'ws://127.0.0.1:' + server.address().port + '/ws?protocolVersion=1';
    const receiver = new WebSocket(receiverUrl, {
      headers: {
        Authorization: 'Bearer ' + deviceToken,
        'X-Device-Id': deviceId,
        'X-Mahi-Protocol-Version': '1',
        Origin: process.env.PUBLIC_BASE_URL,
      },
    });
    sockets.push(receiver);
    const receiverAck = waitForMessage(receiver, (m) => m.type === 'REGISTER_ACK', 'receiver registration acknowledgement');
    await waitForOpen(receiver, 'authenticated receiver WebSocket');
    await receiverAck;

    // Verify pairing requests cannot be created twice concurrently for the same receiver.
    let concurrencyCode = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    await DeviceService.storePairingCode(deviceId, concurrencyCode, Date.now() + 300_000);
    const attempts = await Promise.allSettled([
      DeviceService.createPairingRequest({
        requestId: crypto.randomUUID(),
        code: concurrencyCode,
        controllerId: 'browser-race-controller-a',
        controllerFingerprint: 'RACE-FINGERPRINT-A',
        controllerName: 'Race Controller A',
        requestedScopes: ['SCREEN_VIEW'],
      }),
      DeviceService.createPairingRequest({
        requestId: crypto.randomUUID(),
        code: concurrencyCode,
        controllerId: 'browser-race-controller-b',
        controllerFingerprint: 'RACE-FINGERPRINT-B',
        controllerName: 'Race Controller B',
        requestedScopes: ['SCREEN_VIEW'],
      }),
    ]);
    const winners = attempts.filter((item) => item.status === 'fulfilled');
    assert.equal(winners.length, 1, 'Exactly one concurrent pairing request may be pending for a receiver');
    const raceRequest = winners[0].value;
    const rejectedRace = await DeviceService.rejectPairingRequest(raceRequest.requestId, deviceId);
    assert.ok(rejectedRace);
    console.log('✓ Concurrent pairing request race allows only one pending owner approval');

    // Start a second independent backend process so the test exercises real DB pub/sub
    // delivery between different local WebSocket registries.
    const secondaryPort = await findFreePort();
    const secondary = spawn(process.execPath, [path.resolve(__dirname, '../dist/index.js')], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(secondaryPort),
        HOST: '127.0.0.1',
        INSTANCE_ID: 'integration-secondary',
        PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL,
        DATABASE_URL: process.env.DATABASE_URL,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = secondary;
    child.stdout.on('data', (chunk) => { childStdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { childStderr += chunk.toString(); });
    await waitForHttp('http://127.0.0.1:' + secondaryPort, child, [childStdout, childStderr]);

    const controllerFingerprint = 'WEB-TEST-' + crypto.randomBytes(12).toString('hex').toUpperCase();
    const controllerUrl = 'ws://127.0.0.1:' + secondaryPort +
      '/ws?controllerFingerprint=' + encodeURIComponent(controllerFingerprint) + '&protocolVersion=1';
    const controller = new WebSocket(controllerUrl, {
      headers: { Origin: process.env.PUBLIC_BASE_URL },
    });
    sockets.push(controller);
    const controllerAck = waitForMessage(controller, (m) => m.type === 'REGISTER_ACK', 'controller registration acknowledgement');
    await waitForOpen(controller, 'browser controller WebSocket on secondary backend');
    await controllerAck;

    const pairingCode = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const codeAck = waitForMessage(receiver, (m) => m.type === 'CODE_REGISTERED_ACK', 'pairing-code registration acknowledgement');
    receiver.send(JSON.stringify({
      type: 'REGISTER_PAIRING_CODE',
      code: pairingCode,
      expiresAtMs: Date.now() + 300_000,
      protocolVersion: 1,
    }));
    await codeAck;

    const receiverPrompt = waitForMessage(receiver, (m) => m.type === 'PAIR_REQUEST', 'receiver owner approval request');
    const controllerPending = waitForMessage(controller, (m) => m.type === 'PAIR_PENDING', 'controller pairing pending acknowledgement');
    controller.send(JSON.stringify({
      type: 'PAIR_BY_CODE',
      code: pairingCode,
      operatorName: 'Cross-instance browser controller',
      requestedScopes: ['Screen Mirroring', 'Remote Interaction', 'File Transfer', 'Diagnostics'],
      protocolVersion: 1,
    }));
    const [incomingRequest, pending] = await Promise.all([receiverPrompt, controllerPending]);
    assert.equal(incomingRequest.requestId, pending.requestId);
    assert.equal(incomingRequest.controllerId, 'browser_' + controllerFingerprint);

    // Race duplicate approvals. The database locks the receiver and consumes the code once.
    const receiverAuthorized = waitForMessage(receiver, (m) => m.type === 'PAIR_SESSION_AUTHORIZED', 'receiver session authorization');
    const controllerAuthorized = waitForMessage(controller, (m) => m.type === 'PAIR_ACCEPT', 'controller session authorization');
    const duplicateDecision = waitForMessage(receiver, (m) =>
      m.type === 'PAIR_ERROR' || m.type === 'SIGNALING_ERROR',
      'duplicate approval rejection'
    );
    const approveMessage = JSON.stringify({
      type: 'PAIR_ACCEPT',
      requestId: incomingRequest.requestId,
      payload: { requestId: incomingRequest.requestId, status: 'APPROVED' },
      protocolVersion: 1,
    });
    receiver.send(approveMessage);
    receiver.send(approveMessage);

    const [receiverSession, controllerSession] = await Promise.all([receiverAuthorized, controllerAuthorized]);
    await duplicateDecision;
    assert.equal(receiverSession.sessionId, controllerSession.sessionId);
    assert.ok(receiverSession.sessionToken);
    assert.ok(controllerSession.sessionToken);
    assert.notEqual(receiverSession.sessionToken, controllerSession.sessionToken);

    const sessionResult = await Database.query(
      'SELECT COUNT(*)::int AS count FROM support_sessions WHERE session_id = $1 AND status = \'ACTIVE\'',
      [receiverSession.sessionId]
    );
    assert.equal(sessionResult.rows[0].count, 1);

    const consumedCode = await Database.query(
      'SELECT consumed_at FROM pairing_codes WHERE device_id = $1 AND code_hash = $2',
      [deviceId, crypto.createHmac('sha256', process.env.PAIRING_CODE_PEPPER).update('mahi-remote:v1:' + pairingCode).digest('hex')]
    );
    assert.equal(consumedCode.rows.length, 1);
    assert.ok(consumedCode.rows[0].consumed_at);

    const turnResponse = await fetch('http://127.0.0.1:' + server.address().port + '/api/v1/turn-credentials', {
      headers: { Authorization: 'Bearer ' + controllerSession.sessionToken },
    });
    assert.equal(turnResponse.status, 200);
    const turn = await turnResponse.json();
    assert.equal(turn.turnConfigured, true);
    assert.equal(turn.expiresInSeconds, 600);
    const turnEntry = turn.iceServers.find((entry) => entry.urls === process.env.TURN_SERVER_URL);
    assert.ok(turnEntry);
    assert.ok(turnEntry.credential);
    assert(!JSON.stringify(turn).includes(process.env.TURN_SHARED_SECRET));
    console.log('✓ Owner approval creates one durable session, consumes the code once and issues time-limited TURN credentials');

    // Cross-instance WebRTC and remote-operation signaling must be authorized and delivered.
    const offerPromise = waitForMessage(receiver, (m) => m.type === 'SDP_OFFER', 'cross-instance SDP offer');
    controller.send(JSON.stringify({
      type: 'SDP_OFFER',
      sessionToken: controllerSession.sessionToken,
      targetDeviceId: deviceId,
      payload: { sdp: 'v=0\\r\\no=- integration-offer' },
      protocolVersion: 1,
    }));
    const offer = await offerPromise;
    assert.equal(offer.sessionId, receiverSession.sessionId);
    assert.equal(offer.payload.sdp, 'v=0\\r\\no=- integration-offer');

    const inputPromise = waitForMessage(receiver, (m) => m.type === 'INPUT_EVENT', 'authorized remote input event');
    controller.send(JSON.stringify({
      type: 'INPUT_EVENT',
      sessionToken: controllerSession.sessionToken,
      targetDeviceId: deviceId,
      payload: { command: { type: 'TAP', x: 100, y: 200 } },
      protocolVersion: 1,
    }));
    await inputPromise;

    const appPromise = waitForMessage(receiver, (m) => m.type === 'APP_COMMAND', 'authorized app operation');
    controller.send(JSON.stringify({
      type: 'APP_COMMAND',
      action: 'LIST',
      sessionToken: controllerSession.sessionToken,
      targetDeviceId: deviceId,
      protocolVersion: 1,
    }));
    await appPromise;

    const filePromise = waitForMessage(receiver, (m) => m.type === 'FILE_COMMAND', 'authorized file operation');
    controller.send(JSON.stringify({
      type: 'FILE_COMMAND',
      action: 'LIST',
      path: '/storage/emulated/0/Documents',
      sessionToken: controllerSession.sessionToken,
      targetDeviceId: deviceId,
      protocolVersion: 1,
    }));
    await filePromise;

    const diagnosticsPromise = waitForMessage(receiver, (m) => m.type === 'DIAGNOSTICS_RUN', 'authorized diagnostics operation');
    controller.send(JSON.stringify({
      type: 'DIAGNOSTICS_RUN',
      sessionToken: controllerSession.sessionToken,
      targetDeviceId: deviceId,
      protocolVersion: 1,
    }));
    await diagnosticsPromise;

    const invalidChunkError = waitForMessage(controller, (m) => m.type === 'SESSION_ERROR' && m.errorCode === 'INVALID_REQUEST', 'oversized file chunk rejection');
    controller.send(JSON.stringify({
      type: 'FILE_COMMAND',
      action: 'WRITE_CHUNK',
      path: '/storage/emulated/0/Documents/test.bin',
      data: Buffer.alloc(65_537, 1).toString('base64'),
      sessionToken: controllerSession.sessionToken,
      targetDeviceId: deviceId,
      protocolVersion: 1,
    }));
    await invalidChunkError;

    // A valid JWT without the correct session or target does not authorize forwarding.
    const unauthorizedError = waitForMessage(controller, (m) => m.type === 'SESSION_ERROR', 'missing session token rejection');
    controller.send(JSON.stringify({
      type: 'INPUT_EVENT',
      targetDeviceId: deviceId,
      payload: { command: { type: 'TAP', x: 5, y: 5 } },
      protocolVersion: 1,
    }));
    await unauthorizedError;

    const answerPromise = waitForMessage(controller, (m) => m.type === 'SDP_ANSWER', 'cross-instance SDP answer');
    receiver.send(JSON.stringify({
      type: 'SDP_ANSWER',
      sessionToken: receiverSession.sessionToken,
      recipient: 'browser_' + controllerFingerprint,
      payload: { sdp: 'v=0\\r\\no=- integration-answer' },
      protocolVersion: 1,
    }));
    await answerPromise;
    console.log('✓ Cross-replica SDP, input, app, file and diagnostics relays; missing auth and oversized chunks rejected');

    // Session revocation reaches both participants over the outbox and is durable.
    const endedReceiver = waitForMessage(receiver, (m) => m.type === 'SESSION_ENDED', 'receiver session termination');
    const endedController = waitForMessage(controller, (m) => m.type === 'SESSION_ENDED', 'controller session termination');
    controller.send(JSON.stringify({
      type: 'EMERGENCY_DISCONNECT',
      sessionToken: controllerSession.sessionToken,
      targetDeviceId: deviceId,
      protocolVersion: 1,
    }));
    await Promise.all([endedReceiver, endedController]);
    assert.equal(await DeviceService.isSessionParticipant(receiverSession.sessionId, deviceId, enrollment.json.fingerprint), false);

    // Validate durable device identity survives closing and reopening the pool.
    await closeWebSocket(controller);
    await closeWebSocket(receiver);
    console.log('✓ Session termination and revocation enforced');

    await hub.close();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    server = null;
    wss = null;
    hub = null;

    child.kill('SIGTERM');
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => {
        if (child && child.exitCode === null) child.kill('SIGKILL');
        resolve();
      }, 5000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    child = null;

    await Database.close();
    await Database.initialize();
    const persisted = await DeviceService.getDevice(persistedDeviceId);
    assert.ok(persisted);
    assert.equal(persisted.deviceId, persistedDeviceId);
    assert.equal(persisted.fingerprint, enrollment.json.fingerprint);
    await Database.close();
    console.log('✓ Device identity persists across backend database-pool restart');

    console.log('=== ALL POSTGRESQL BACKEND INTEGRATION TESTS PASSED ===');
  } finally {
    await Promise.all(sockets.map(closeWebSocket));
    if (hub) await hub.close().catch(() => undefined);
    if (wss) {
      await new Promise((resolve) => wss.close(resolve));
    }
    if (server && server.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (child && child.exitCode === null) child.kill('SIGKILL');
          resolve();
        }, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    await Database.close().catch(() => undefined);
  }
}

runTests().catch((error) => {
  console.error('BACKEND INTEGRATION TEST FAILURE:', error);
  process.exitCode = 1;
});
