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

    // 4. Test 6-Digit Pairing Code Lifecycle (Single-use & Expiry)
    console.log('[TEST] Testing Pairing Code verification and single-use consumption...');
    const pairingCode = '839-201';
    DeviceService.storePairingCode('MAHI-TEST-NOAKHALI', pairingCode, Date.now() + 300000); // 5 min expiry

    // First attempt (Valid)
    const pairRes = await fetch('http://localhost:8099/api/v1/pair/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: pairingCode,
        operatorFingerprint: 'OPERATOR-SYLHET-99',
        operatorName: 'Sylhet Test Operator',
        operatorLocation: 'Sylhet, Bangladesh'
      })
    });
    assert.strictEqual(pairRes.status, 200);
    const pairData = await pairRes.json();
    assert.strictEqual(pairData.success, true);
    assert.strictEqual(pairData.deviceId, 'MAHI-TEST-NOAKHALI');
    assert(pairData.sessionToken, 'Session token missing');
    console.log('✓ Initial Pairing Verification PASSED (Token received)');

    // Second attempt with SAME code (Must fail - Single use enforce)
    const replayRes = await fetch('http://localhost:8099/api/v1/pair/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: pairingCode,
        operatorFingerprint: 'OPERATOR-SYLHET-99'
      })
    });
    assert.strictEqual(replayRes.status, 401, 'Replay of consumed pairing code was not rejected');
    console.log('✓ Single-Use Code Enforcement PASSED (Replay blocked with 401)');

    // 5. Test Expired Code
    console.log('[TEST] Testing expired code rejection...');
    const expiredCode = '111-222';
    DeviceService.storePairingCode('MAHI-TEST-NOAKHALI', expiredCode, Date.now() - 1000); // Expired 1s ago
    const expiredRes = await fetch('http://localhost:8099/api/v1/pair/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: expiredCode,
        operatorFingerprint: 'OPERATOR-SYLHET-99'
      })
    });
    assert.strictEqual(expiredRes.status, 401);
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

    // 7. Test WebSocket Signaling: Device and Operator connection and SDP relay
    console.log('[TEST] Testing WebSocket WebRTC signaling relay...');
    const wsDevice = new WebSocket('ws://localhost:8099/ws', {
      headers: {
        'x-device-id': 'MAHI-WS-DEVICE',
        'x-device-fingerprint': 'DEV-FP-1234'
      }
    });

    const wsOperator = new WebSocket('ws://localhost:8099/ws', {
      headers: {
        'x-operator-fingerprint': 'OP-FP-5678',
        'x-operator-name': 'Sylhet Operator',
        'x-operator-location': 'Sylhet'
      }
    });

    await Promise.all([
      new Promise(res => wsDevice.on('open', res)),
      new Promise(res => wsOperator.on('open', res))
    ]);
    console.log('  Both Device and Operator connected to WebSocket signaling');

    // Operator sends SDP Offer targeted to MAHI-WS-DEVICE
    const sdpOfferPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for SDP relay')), 3000);
      wsDevice.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'SDP_OFFER') {
          clearTimeout(timeout);
          resolve(msg);
        }
      });
    });

    wsOperator.send(JSON.stringify({
      type: 'SDP_OFFER',
      targetDeviceId: 'MAHI-WS-DEVICE',
      payload: { sdp: 'v=0\r\no=- 1234 2 IN IP4 0.0.0.0...' }
    }));

    const receivedOffer = await sdpOfferPromise;
    assert.strictEqual(receivedOffer.type, 'SDP_OFFER');
    assert(receivedOffer.payload.sdp.includes('v=0'), 'SDP payload corrupted');
    console.log('✓ WebSocket Signaling SDP Offer Relay PASSED');

    // Device responds with SDP Answer
    const sdpAnswerPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for SDP answer relay')), 3000);
      wsOperator.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'SDP_ANSWER') {
          clearTimeout(timeout);
          resolve(msg);
        }
      });
    });

    wsDevice.send(JSON.stringify({
      type: 'SDP_ANSWER',
      recipient: 'operator_OP-FP-56',
      payload: { sdp: 'v=0\r\no=- 5678 2 IN IP4 0.0.0.0...' }
    }));

    const receivedAnswer = await sdpAnswerPromise;
    assert.strictEqual(receivedAnswer.type, 'SDP_ANSWER');
    console.log('✓ WebSocket Signaling SDP Answer Relay PASSED');

    wsDevice.close();
    wsOperator.close();

    console.log('====================================================');
    console.log(' ALL 7 BACKEND & SIGNALING INTEGRATION TESTS PASSED ');
    console.log('====================================================');

  } finally {
    server.close();
  }
}

runTests().catch(err => {
  console.error('INTEGRATION TEST FAILURE:', err);
  process.exit(1);
});
