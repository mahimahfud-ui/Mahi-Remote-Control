// Integration tests use the same PostgreSQL persistence and signaling code as production.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'integration-test-only-jwt-secret-32-bytes-minimum';
process.env.PAIRING_CODE_PEPPER = process.env.PAIRING_CODE_PEPPER || 'integration-test-only-pairing-pepper-32-bytes';
process.env.TURN_SERVER_URL = 'turn:turn.integration.invalid:3478';
process.env.TURN_REALM = 'turn.integration.invalid';
process.env.TURN_SHARED_SECRET = 'integration-only-turn-secret-not-for-production';
process.env.STUN_SERVER_URL = 'stun:stun.integration.invalid:3478';
process.env.PUBLIC_BASE_URL = 'https://remote.integration.invalid';
process.env.INSTANCE_ID = 'integration-instance-1';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const { WebSocket, WebSocketServer } = require('ws');

const { Database } = require('../dist/database/Database');
const { apiRouter } = require('../dist/api/routes');
const { SignalingHub } = require('../dist/signaling/SignalingHub');
const { AuthService } = require('../dist/authentication/AuthService');

const BASE_URL = 'http://127.0.0.1:8099';
const WS_URL = 'ws://127.0.0.1:8099/ws';
const PROTOCOL_HEADERS = {
  'Content-Type': 'application/json',
  'X-Mahi-Protocol-Version': '1'
};

function signedMessage(challenge) {
  return [
    'MAHI-REMOTE-DEVICE-PROOF',
    '1',
    challenge.purpose,
    challenge.challengeId,
    challenge.deviceId || 'MAHI-INTEGRATION-DEVICE',
    challenge.fingerprint,
    challenge.nonce,
    String(challenge.expiresAtMs)
  ].join('\n');
}

function signChallenge(challenge, privateKey, deviceId = 'MAHI-INTEGRATION-DEVICE') {
  const message = [
    'MAHI-REMOTE-DEVICE-PROOF',
    '1',
    challenge.purpose,
    challenge.challengeId,
    deviceId,
    challenge.fingerprint,
    challenge.nonce,
    String(challenge.expiresAtMs)
  ].join('\n');
  return crypto.sign('sha256', Buffer.from(message, 'utf8'), privateKey).toString('base64');
}

async function post(path, body, token) {
  const headers = { ...PROTOCOL_HEADERS };
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(BASE_URL + path, {
    method: 'POST',
    headers,
    body: JSON.stringify({ protocolVersion: 1, ...body })
  });
  let payload = {};
  try { payload = await response.json(); } catch { /* empty response */ }
  return { response, payload };
}

function makeSocket(url, options = {}) {
  const ws = new WebSocket(url, options);
  const queue = [];
  const waiters = [];
  ws.on('message', raw => {
    let message;
    try { message = JSON.parse(raw.toString()); }
    catch { message = { type: 'INVALID_JSON' }; }
    const index = waiters.findIndex(waiter => waiter.predicate(message));
    if (index >= 0) {
      const waiter = waiters.splice(index, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      queue.push(message);
    }
  });
  ws.next = (type, timeoutMs = 4000) => {
    const acceptedTypes = Array.isArray(type) ? type : [type];
    const matches = message => acceptedTypes.includes(message.type);
    const index = queue.findIndex(matches);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate: matches,
        resolve,
        timer: setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
          reject(new Error('Timed out waiting for WebSocket event ' + type));
        }, timeoutMs)
      };
      waiters.push(waiter);
    });
  };
  ws.sendJson = message => ws.send(JSON.stringify({ protocolVersion: 1, ...message }));
  return ws;
}

async function waitOpen(ws) {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

async function closeSocket(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* no-op */ }
      resolve();
    }, 1000);
    ws.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    try { ws.close(); } catch { clearTimeout(timer); resolve(); }
  });
}

async function runTests() {
  let server;
  let wss;
  let hub;
  let receiver;
  let controller;
  let controller2;

  try {
    await Database.initialize();
    await Database.query(`
      TRUNCATE TABLE
        signaling_outbox,
        signaling_connections,
        device_presence,
        session_participants,
        support_sessions,
        pairing_requests,
        pairing_codes,
        device_challenges,
        audit_events,
        devices,
        rate_limit_counters
      RESTART IDENTITY CASCADE
    `);

    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '256kb' }));
    app.use('/api/v1', apiRouter);
    server = http.createServer(app);
    wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 });
    hub = new SignalingHub(wss);

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(8099, '127.0.0.1', resolve);
    });

    console.log('[TEST] PostgreSQL readiness and protocol contract');
    const health = await fetch(BASE_URL + '/api/v1/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).protocolVersion, 1);
    const ready = await fetch(BASE_URL + '/api/v1/ready');
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).status, 'ready');

    const configRes = await fetch(BASE_URL + '/api/v1/config');
    const config = await configRes.json();
    assert.equal(config.protocolVersion, 1);
    assert.equal(config.signalingUrl, 'wss://remote.integration.invalid/ws');
    assert.equal(config.turnConfigured, true);
    assert(!JSON.stringify(config).includes('credential'));
    assert(!JSON.stringify(config).includes(process.env.TURN_SHARED_SECRET));

    const noTurn = await fetch(BASE_URL + '/api/v1/turn-credentials');
    assert.equal(noTurn.status, 401);
    const publicDevices = await fetch(BASE_URL + '/api/v1/devices');
    assert.equal(publicDevices.status, 410);

    const missingVersion = await fetch(BASE_URL + '/api/v1/devices/enrollment/challenges', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'MAHI-INTEGRATION-DEVICE' })
    });
    assert.equal(missingVersion.status, 426);

    console.log('[TEST] ECDSA P-256 enrollment, server-derived fingerprint and single-use proof');
    const deviceId = 'MAHI-INTEGRATION-DEVICE';
    const firstPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const publicKey = firstPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

    const challengeResult = await post('/api/v1/devices/enrollment/challenges', {
      deviceId,
      deviceName: 'Integration Android',
      publicKey: {
        format: 'spki-der-base64',
        algorithm: 'EC',
        curve: 'P-256',
        value: publicKey
      }
    });
    assert.equal(challengeResult.response.status, 201);
    const challenge = challengeResult.payload;
    assert.equal(challenge.purpose, 'ENROLL');
    assert.equal(challenge.signatureAlgorithm, 'SHA256withECDSA');
    assert.equal(challenge.fingerprint, 'sha256:' + crypto.createHash('sha256')
      .update(Buffer.from(publicKey, 'base64')).digest('hex'));

    const signature = signChallenge(challenge, firstPair.privateKey, deviceId);
    const enrolled = await post('/api/v1/devices/enrollment/verify', {
      challengeId: challenge.challengeId,
      signature
    });
    assert.equal(enrolled.response.status, 201);
    assert.equal(enrolled.payload.fingerprint, challenge.fingerprint);
    assert.equal(enrolled.payload.tokenType, 'Bearer');
    assert.ok(enrolled.payload.deviceAccessToken);

    const replay = await post('/api/v1/devices/enrollment/verify', {
      challengeId: challenge.challengeId,
      signature
    });
    assert.equal(replay.response.status, 409);
    assert.equal(replay.payload.error.code, 'CHALLENGE_REPLAYED');

    console.log('[TEST] Invalid ECDSA signature and expired challenge rejection');
    const wrongPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const wrongPublicKey = wrongPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const wrongChallenge = await post('/api/v1/devices/enrollment/challenges', {
      deviceId: 'MAHI-WRONG-SIGNATURE',
      deviceName: 'Invalid proof test',
      publicKey: {
        format: 'spki-der-base64',
        algorithm: 'EC',
        curve: 'P-256',
        value: wrongPublicKey
      }
    });
    assert.equal(wrongChallenge.response.status, 201);
    const badProof = await post('/api/v1/devices/enrollment/verify', {
      challengeId: wrongChallenge.payload.challengeId,
      signature: signChallenge(wrongChallenge.payload, firstPair.privateKey, 'MAHI-WRONG-SIGNATURE')
    });
    assert.equal(badProof.response.status, 400);
    assert.equal(badProof.payload.error.code, 'INVALID_SIGNATURE');
    const goodProof = await post('/api/v1/devices/enrollment/verify', {
      challengeId: wrongChallenge.payload.challengeId,
      signature: signChallenge(wrongChallenge.payload, wrongPair.privateKey, 'MAHI-WRONG-SIGNATURE')
    });
    assert.equal(goodProof.response.status, 201);

    const expiredChallenge = await post('/api/v1/devices/enrollment/challenges', {
      deviceId: 'MAHI-EXPIRED-CHALLENGE',
      deviceName: 'Expired challenge test',
      publicKey: {
        format: 'spki-der-base64',
        algorithm: 'EC',
        curve: 'P-256',
        value: wrongPublicKey
      }
    });
    assert.equal(expiredChallenge.response.status, 201);
    await Database.query(
      'UPDATE device_challenges SET expires_at = NOW() - INTERVAL \'1 second\' WHERE challenge_id = $1',
      [expiredChallenge.payload.challengeId]
    );
    const expiredProof = await post('/api/v1/devices/enrollment/verify', {
      challengeId: expiredChallenge.payload.challengeId,
      signature: signChallenge(expiredChallenge.payload, wrongPair.privateKey, 'MAHI-EXPIRED-CHALLENGE')
    });
    assert.equal(expiredProof.response.status, 409);
    assert.equal(expiredProof.payload.error.code, 'CHALLENGE_EXPIRED');

    const authChallenge = await post('/api/v1/devices/auth/challenges', { deviceId });
    assert.equal(authChallenge.response.status, 201);
    const deviceAuth = await post('/api/v1/devices/auth/verify', {
      challengeId: authChallenge.payload.challengeId,
      signature: signChallenge(authChallenge.payload, firstPair.privateKey, deviceId)
    });
    assert.equal(deviceAuth.response.status, 200);
    assert.equal(deviceAuth.payload.fingerprint, challenge.fingerprint);
    assert.ok(deviceAuth.payload.deviceAccessToken);

    const invalidPublicKey = await post('/api/v1/devices/enrollment/challenges', {
      deviceId: 'MAHI-BAD-KEY-DEVICE',
      deviceName: 'Invalid',
      publicKey: {
        format: 'spki-der-base64',
        algorithm: 'EC',
        curve: 'P-256',
        value: Buffer.from('not-a-key').toString('base64')
      }
    });
    assert.equal(invalidPublicKey.response.status, 400);

    console.log('[TEST] Database-backed distributed rate limits');
    const limitKey = 'test-rate-' + crypto.randomUUID();
    let rateLimited = false;
    for (let i = 0; i < 8; i++) {
      const allowed = await AuthService.checkRateLimit(limitKey, 5, 10_000);
      if (!allowed) rateLimited = true;
    }
    assert.equal(rateLimited, true);

    console.log('[TEST] Authenticated receiver WebSocket and rejected unauthenticated device identity');
    const forgedReceiver = makeSocket(WS_URL + '?protocolVersion=1', {
      headers: {
        'X-Mahi-Protocol-Version': '1',
        'X-Device-Id': deviceId,
        'X-Device-Fingerprint': challenge.fingerprint,
        'X-Client-Role': 'RECEIVER'
      }
    });
    const forgedClose = new Promise(resolve => forgedReceiver.once('close', (code) => resolve(code)));
    await waitOpen(forgedReceiver).catch(() => undefined);
    const forgedCode = await forgedClose;
    assert.equal(forgedCode, 1008);

    receiver = makeSocket(WS_URL + '?protocolVersion=1', {
      headers: {
        'Authorization': 'Bearer ' + enrolled.payload.deviceAccessToken,
        'X-Mahi-Protocol-Version': '1',
        'X-Client-Role': 'RECEIVER',
        'X-Device-Name': 'Integration Android'
      }
    });
    await waitOpen(receiver);
    const registered = await receiver.next('REGISTER_ACK');
    assert.equal(registered.deviceId, deviceId);

    const pairingCode = '654321';
    receiver.sendJson({
      type: 'REGISTER_PAIRING_CODE',
      code: pairingCode,
      expiresAtMs: Date.now() + 5 * 60 * 1000
    });
    const codeAck = await receiver.next('CODE_REGISTERED_ACK');
    assert.equal(codeAck.status, 'OK');

    console.log('[TEST] Concurrent browser pairing requests and single owner approval');
    const controllerFingerprintA = 'WEB-' + crypto.randomBytes(16).toString('hex').toUpperCase();
    const controllerFingerprintB = 'WEB-' + crypto.randomBytes(16).toString('hex').toUpperCase();
    controller = makeSocket(
      WS_URL + '?protocolVersion=1&controllerFingerprint=' + encodeURIComponent(controllerFingerprintA)
    );
    controller2 = makeSocket(
      WS_URL + '?protocolVersion=1&controllerFingerprint=' + encodeURIComponent(controllerFingerprintB)
    );
    await Promise.all([waitOpen(controller), waitOpen(controller2)]);
    await Promise.all([controller.next('REGISTER_ACK'), controller2.next('REGISTER_ACK')]);

    controller.sendJson({
      type: 'PAIR_BY_CODE',
      code: pairingCode,
      operatorName: 'Integration Browser A',
      requestedScopes: ['SCREEN_VIEW', 'REMOTE_INPUT', 'FILES', 'DIAGNOSTICS']
    });
    controller2.sendJson({
      type: 'PAIR_BY_CODE',
      code: pairingCode,
      operatorName: 'Integration Browser B',
      requestedScopes: ['SCREEN_VIEW', 'REMOTE_INPUT', 'FILES', 'DIAGNOSTICS']
    });

    const [attemptA, attemptB] = await Promise.all([
      controller.next(['PAIR_PENDING', 'PAIR_ERROR']),
      controller2.next(['PAIR_PENDING', 'PAIR_ERROR'])
    ]);
    assert.equal([attemptA, attemptB].filter(item => item.type === 'PAIR_PENDING').length, 1);
    assert.equal([attemptA, attemptB].filter(item => item.type === 'PAIR_ERROR').length, 1);
    const pendingController = attemptA.type === 'PAIR_PENDING' ? controller : controller2;
    const losingController = attemptA.type === 'PAIR_ERROR' ? controller : controller2;
    const pending = attemptA.type === 'PAIR_PENDING' ? attemptA : attemptB;
    assert.equal((attemptA.type === 'PAIR_ERROR' ? attemptA : attemptB).errorCode, 'PAIRING_ALREADY_PENDING');

    const incoming = await receiver.next('PAIR_REQUEST');
    assert.equal(incoming.requestId, pending.requestId);
    assert.equal(incoming.expiresAt > Date.now(), true);

    console.log('[TEST] Approval is atomic; a duplicate simultaneous approval cannot create a second session');
    receiver.sendJson({ type: 'PAIR_ACCEPT', requestId: incoming.requestId });
    receiver.sendJson({ type: 'PAIR_ACCEPT', requestId: incoming.requestId });
    const [browserApproval, receiverApproval, duplicateApprovalError] = await Promise.all([
      pendingController.next('PAIR_ACCEPT'),
      receiver.next('PAIR_SESSION_AUTHORIZED'),
      receiver.next('PAIR_ERROR')
    ]);
    assert.equal(browserApproval.sessionId, receiverApproval.sessionId);
    assert.ok(browserApproval.sessionToken);
    assert.ok(receiverApproval.sessionToken);
    assert.equal(duplicateApprovalError.errorCode, 'PAIRING_REQUEST_EXPIRED');
    assert.equal(
      await Database.query('SELECT 1 FROM support_sessions WHERE session_id = $1 AND status = \'ACTIVE\'', [browserApproval.sessionId])
        .then(result => Boolean(result.rowCount)),
      true
    );
    assert.equal(
      await Database.query('SELECT COUNT(*)::int AS count FROM support_sessions WHERE device_id = $1 AND status = \'ACTIVE\'', [deviceId])
        .then(result => result.rows[0].count),
      1
    );

    // Use the winning browser connection for the remaining authorized-session tests.
    controller = pendingController;
    controller2 = losingController;

    console.log('[TEST] TURN credentials are session-scoped and short-lived');
    const turnResponse = await fetch(BASE_URL + '/api/v1/turn-credentials', {
      headers: { Authorization: 'Bearer ' + browserApproval.sessionToken }
    });
    assert.equal(turnResponse.status, 200);
    const turn = await turnResponse.json();
    assert.equal(turn.protocolVersion, 1);
    assert.equal(turn.turnConfigured, true);
    assert.equal(turn.expiresInSeconds, 600);
    const turnEntry = turn.iceServers.find(entry => String(entry.urls).startsWith('turn:'));
    assert.ok(turnEntry && turnEntry.credential);
    assert(!JSON.stringify(turn).includes(process.env.TURN_SHARED_SECRET));

    console.log('[TEST] Session membership, scopes and SDP/input relay');
    const receivedOffer = receiver.next('SDP_OFFER');
    controller.sendJson({
      type: 'SDP_OFFER',
      targetDeviceId: deviceId,
      sessionToken: browserApproval.sessionToken,
      payload: { sdp: 'v=0\r\no=- integration-offer' }
    });
    const offer = await receivedOffer;
    assert.equal(offer.sessionId, browserApproval.sessionId);
    assert.ok(offer.payload.sdp.includes('integration-offer'));

    const receivedAnswer = controller.next('SDP_ANSWER');
    receiver.sendJson({
      type: 'SDP_ANSWER',
      sessionToken: receiverApproval.sessionToken,
      payload: { sdp: 'v=0\r\no=- integration-answer' }
    });
    const answer = await receivedAnswer;
    assert.equal(answer.sessionId, browserApproval.sessionId);

    const receivedInput = receiver.next('INPUT_EVENT');
    controller.sendJson({
      type: 'INPUT_EVENT',
      targetDeviceId: deviceId,
      sessionToken: browserApproval.sessionToken,
      payload: { command: { type: 'TAP', x: 120, y: 340 } }
    });
    assert.equal((await receivedInput).type, 'INPUT_EVENT');

    const invalidTargetWait = controller.next('SESSION_ERROR');
    controller.sendJson({
      type: 'INPUT_EVENT',
      targetDeviceId: 'someone-else-device',
      sessionToken: browserApproval.sessionToken,
      payload: { command: { type: 'TAP', x: 1, y: 1 } }
    });
    assert.equal((await invalidTargetWait).errorCode, 'NOT_SESSION_PARTICIPANT');

    const invalidFileChunk = controller.next('SESSION_ERROR');
    controller.sendJson({
      type: 'FILE_COMMAND',
      action: 'WRITE_CHUNK',
      path: '/storage/emulated/0/test.bin',
      data: 'x'.repeat(100_000),
      targetDeviceId: deviceId,
      sessionToken: browserApproval.sessionToken
    });
    assert.equal((await invalidFileChunk).errorCode, 'INVALID_REQUEST');

    const forbiddenAppAction = controller.next('SESSION_ERROR');
    controller.sendJson({
      type: 'APP_COMMAND',
      action: 'SHELL',
      targetDeviceId: deviceId,
      sessionToken: browserApproval.sessionToken
    });
    assert.equal((await forbiddenAppAction).errorCode, 'INVALID_REQUEST');

    console.log('[TEST] PostgreSQL reconnect preserves enrolled devices, consumed codes and active sessions');
    await Database.close();
    await Database.initialize();
    await Database.startSignalListener();
    const persistedDevice = await Database.query(
      'SELECT device_id, fingerprint FROM devices WHERE device_id = $1',
      [deviceId]
    );
    assert.equal(persistedDevice.rows[0].device_id, deviceId);
    assert.equal(persistedDevice.rows[0].fingerprint, challenge.fingerprint);
    const persistedSession = await Database.query(
      'SELECT session_id FROM support_sessions WHERE session_id = $1 AND status = \'ACTIVE\'',
      [browserApproval.sessionId]
    );
    assert.equal(persistedSession.rowCount, 1);
    const consumedCode = await Database.query(
      'SELECT consumed_at FROM pairing_codes WHERE device_id = $1 ORDER BY created_at DESC LIMIT 1',
      [deviceId]
    );
    assert.ok(consumedCode.rows[0].consumed_at);

    console.log('[TEST] Session termination revokes participant access');
    const terminate = await fetch(BASE_URL + '/api/v1/sessions/' + browserApproval.sessionId + '/terminate', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + browserApproval.sessionToken }
    });
    assert.equal(terminate.status, 200);
    const terminated = await terminate.json();
    assert.equal(terminated.success, true);

    const revokedSession = await fetch(BASE_URL + '/api/v1/turn-credentials', {
      headers: { Authorization: 'Bearer ' + browserApproval.sessionToken }
    });
    assert.equal(revokedSession.status, 401);


    console.log('[TEST] Device key rotation requires both old and new key signatures');
    const newPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const newPublicKey = newPair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const rotationChallenge = await post('/api/v1/devices/key-rotation/challenges', {
      newPublicKey: {
        format: 'spki-der-base64',
        algorithm: 'EC',
        curve: 'P-256',
        value: newPublicKey
      }
    }, enrolled.payload.deviceAccessToken);
    assert.equal(rotationChallenge.response.status, 201);
    const rotation = rotationChallenge.payload;
    const oldRotationSignature = signChallenge(rotation, firstPair.privateKey, deviceId);
    const newRotationSignature = signChallenge(rotation, newPair.privateKey, deviceId);
    const rotationResult = await post('/api/v1/devices/key-rotation/verify', {
      challengeId: rotation.challengeId,
      oldKeySignature: oldRotationSignature,
      newKeySignature: newRotationSignature
    }, enrolled.payload.deviceAccessToken);
    assert.equal(rotationResult.response.status, 200);
    assert.equal(rotationResult.payload.fingerprint, rotation.fingerprint);
    assert.notEqual(rotationResult.payload.deviceAccessToken, enrolled.payload.deviceAccessToken);

    const oldTokenWs = makeSocket(WS_URL + '?protocolVersion=1', {
      headers: {
        'Authorization': 'Bearer ' + enrolled.payload.deviceAccessToken,
        'X-Mahi-Protocol-Version': '1'
      }
    });
    const oldTokenClose = new Promise(resolve => oldTokenWs.once('close', code => resolve(code)));
    await waitOpen(oldTokenWs).catch(() => undefined);
    assert.equal(await oldTokenClose, 1008);
    await closeSocket(oldTokenWs);


    console.log('[TEST] Passed: protocol, PostgreSQL persistence, pairing, approval, session auth, TURN, scope checks, limits and key rotation.');
  } finally {
    await closeSocket(controller2);
    await closeSocket(controller);
    await closeSocket(receiver);
    if (hub) await hub.close();
    if (wss) await new Promise(resolve => wss.close(() => resolve()));
    if (server && server.listening) {
      await new Promise(resolve => server.close(() => resolve()));
    }
    await Database.close();
  }
}

runTests().catch(error => {
  console.error('BACKEND INTEGRATION TEST FAILURE:', error);
  process.exitCode = 1;
});
