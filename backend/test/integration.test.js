// Integration-only secret. Production must supply JWT_SECRET through its secret manager.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'integration-test-only-secret-change-before-production-0001';

const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocket, WebSocketServer } = require('ws');
const assert = require('assert');

// Import compiled backend modules
const { apiRouter } = require('../dist/api/routes');
const { SignalingHub } = require('../dist/signaling/SignalingHub');
const { DeviceService } = require('../dist/device-management/DeviceService');
const { AuthService } = require('../dist/authentication/AuthService');

async function runTests() {
  console.log('=== STARTING BACKEND INTEGRATION TESTS ===');
  
  // 1. Setup ephemeral test server
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use('/api/v1', apiRouter);

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  new SignalingHub(wss);

  await new Promise((resolve) => server.listen(8099, resolve));
  console.log('Test Server listening on port 8099');

  try {
    // 2. Test /api/v1/health
    console.log('[TEST] Checking /api/v1/health...');
    const healthRes = await fetch('http://localhost:8099/api/v1/health');
    assert.strictEqual(healthRes.status, 200);
    const healthData = await healthRes.json();
    assert.strictEqual(healthData.status, 'healthy');
    console.log('✓ /api/v1/health PASSED');

    // 3. Test Device Registration & Listing
    console.log('[TEST] Registering mock device in Noakhali...');
    DeviceService.registerDevice('MAHI-TEST-NOAKHALI', 'Samsung Test Device', 'AA:BB:CC:DD:EE:FF:11:22');
    const devRes = await fetch('http://localhost:8099/api/v1/devices');
    assert.strictEqual(devRes.status, 200);
    const devData = await devRes.json();
    const found = devData.devices.find(d => d.deviceId === 'MAHI-TEST-NOAKHALI');
    assert(found, 'Device not found in listing');
    console.log('✓ Device registration and listing PASSED');

    // 4. Ensure the legacy REST endpoint cannot mint a session before owner approval.
    console.log('[TEST] Verifying REST code-only pairing is disabled...');
    const pairingCode = '839-201';
    DeviceService.storePairingCode('MAHI-TEST-NOAKHALI', pairingCode, Date.now() + 300000);
    const pairRes = await fetch('http://localhost:8099/api/v1/pair/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pairingCode, operatorFingerprint: 'OPERATOR-SYLHET-99' })
    });
    assert.strictEqual(pairRes.status, 410, 'REST endpoint must not issue a token before receiver approval');
    assert(DeviceService.getPairingCode(pairingCode), 'Pairing code should remain available until owner approval');
    console.log('✓ Pre-approval REST token issuance blocked');

    // 5. Expired pairing codes are rejected without issuing a token.
    console.log('[TEST] Testing expired code lookup...');
    const expiredCode = '111-222';
    DeviceService.storePairingCode('MAHI-TEST-NOAKHALI', expiredCode, Date.now() - 1000);
    assert.strictEqual(DeviceService.getPairingCode(expiredCode), null);
    console.log('✓ Expired Pairing Code Rejection PASSED');

    // 6. Test Rate Limiting
    console.log('[TEST] Testing Rate Limiter threshold...');
    const clientKey = '192.168.1.99';
    let blocked = false;
    for (let i = 0; i < 70; i++) {
      if (!AuthService.checkRateLimit(clientKey, 50, 10000)) {
        blocked = true;
        break;
      }
    }
    assert(blocked, 'Rate limiter failed to block excessive requests');
    console.log('✓ Rate Limiter Threshold Enforcement PASSED');

    // 7. Verify code request -> receiver approval -> signed session -> protected SDP relay.
    console.log('[TEST] Testing approved WebSocket pairing and authorized SDP relay...');
    const wsDevice = new WebSocket('ws://localhost:8099/ws', {
      headers: {
        'x-device-id': 'MAHI-WS-DEVICE',
        'x-device-fingerprint': 'DEV-FP-1234',
        'x-device-name': 'Receiver Test Device',
        'x-client-role': 'RECEIVER'
      }
    });
    const wsOperator = new WebSocket('ws://localhost:8099/ws', {
      headers: {
        'x-operator-fingerprint': 'OP-FP-5678',
        'x-operator-name': 'Test Browser Operator'
      }
    });

    await Promise.all([
      new Promise(res => wsDevice.once('open', res)),
      new Promise(res => wsOperator.once('open', res))
    ]);

    const nextMessage = (ws, predicate, description) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for ' + description)), 3000);
      const listener = raw => {
        const msg = JSON.parse(raw.toString());
        if (!predicate(msg)) return;
        clearTimeout(timeout);
        ws.off('message', listener);
        resolve(msg);
      };
      ws.on('message', listener);
    });

    const testCode = '654321';
    DeviceService.storePairingCode('MAHI-WS-DEVICE', testCode, Date.now() + 300000);
    const requestToReceiver = nextMessage(wsDevice, msg => msg.type === 'PAIR_REQUEST', 'receiver approval prompt');
    const pendingToController = nextMessage(wsOperator, msg => msg.type === 'PAIR_PENDING', 'pair pending acknowledgement');
    wsOperator.send(JSON.stringify({
      type: 'PAIR_BY_CODE',
      code: testCode,
      fingerprint: 'OP-FP-5678',
      operatorName: 'Integration Test Browser',
      requestedScopes: ['Screen Mirroring', 'Remote Interaction']
    }));
    const [incomingRequest, pendingAck] = await Promise.all([requestToReceiver, pendingToController]);
    assert(incomingRequest.requestId);
    assert.strictEqual(incomingRequest.requestId, pendingAck.requestId);
    assert(DeviceService.getPairingCode(testCode), 'Code must not be consumed before owner approval');

    const approvalToController = nextMessage(wsOperator, msg => msg.type === 'PAIR_ACCEPT', 'controller session authorization');
    const authorizationToReceiver = nextMessage(wsDevice, msg => msg.type === 'PAIR_SESSION_AUTHORIZED', 'receiver session authorization');
    wsDevice.send(JSON.stringify({
      type: 'PAIR_ACCEPT',
      payload: {
        requestId: incomingRequest.requestId,
        status: 'APPROVED'
      }
    }));
    const [controllerApproval, receiverAuthorization] = await Promise.all([approvalToController, authorizationToReceiver]);
    assert.strictEqual(controllerApproval.sessionId, receiverAuthorization.sessionId);
    assert(controllerApproval.sessionToken, 'Controller token missing');
    assert(receiverAuthorization.sessionToken, 'Receiver token missing');
    assert.strictEqual(DeviceService.getPairingCode(testCode), null, 'Approved code must be consumed exactly once');
    console.log('✓ Pairing request is pending until explicit receiver approval');
    console.log('✓ Both participants receive separate signed tokens for one session');

    const sdpOfferPromise = nextMessage(wsDevice, msg => msg.type === 'SDP_OFFER', 'authorized SDP offer relay');
    wsOperator.send(JSON.stringify({
      type: 'SDP_OFFER',
      targetDeviceId: 'MAHI-WS-DEVICE',
      sessionToken: controllerApproval.sessionToken,
      payload: { sdp: 'v=0\\r\\no=- 1234 2 IN IP4 0.0.0.0...' }
    }));
    const receivedOffer = await sdpOfferPromise;
    assert.strictEqual(receivedOffer.type, 'SDP_OFFER');
    assert(receivedOffer.payload.sdp.includes('v=0'), 'SDP payload corrupted');
    console.log('✓ Authorized WebSocket SDP offer relay PASSED');

    const sdpAnswerPromise = nextMessage(wsOperator, msg => msg.type === 'SDP_ANSWER', 'authorized SDP answer relay');
    wsDevice.send(JSON.stringify({
      type: 'SDP_ANSWER',
      recipient: wsOperator ? controllerApproval.sender : '',
      sessionToken: receiverAuthorization.sessionToken,
      payload: { sdp: 'v=0\\r\\no=- 5678 2 IN IP4 0.0.0.0...' }
    }));
    const receivedAnswer = await sdpAnswerPromise;
    assert.strictEqual(receivedAnswer.type, 'SDP_ANSWER');
    console.log('✓ Authorized WebSocket SDP answer relay PASSED');

    // Missing/invalid session credentials must not be relayed.
    const unauthorizedPromise = nextMessage(wsDevice, msg => msg.type === 'SESSION_ERROR', 'unauthorized command rejection');
    wsOperator.send(JSON.stringify({
      type: 'INPUT_EVENT',
      targetDeviceId: 'MAHI-WS-DEVICE',
      payload: { command: { type: 'TAP', x: 100, y: 100 } }
    }));
    await unauthorizedPromise;
    console.log('✓ Unauthenticated input command rejected');
    wsDevice.close();
    wsOperator.close();

    console.log('====================================================');
    console.log(' BACKEND & APPROVED-SESSION INTEGRATION TESTS PASSED ');
    console.log('====================================================');

  } finally {
    server.close();
  }
}

runTests().catch(err => {
  console.error('INTEGRATION TEST FAILURE:', err);
  process.exit(1);
});
