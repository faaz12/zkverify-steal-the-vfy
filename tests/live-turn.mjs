// Live end-to-end test against the DEPLOYED Vercel endpoint.
// Signs a practice turn with the (placeholder) HMAC secret, POSTs it,
// and locally verifies the returned Groth16 proof.
// Usage: HMAC_SECRET=<secret> node tests/live-turn.mjs
import crypto from 'node:crypto';
import * as snarkjs from 'snarkjs';
import fs from 'node:fs';

const ENDPOINT = 'https://zkverify-steal-the-vfy.vercel.app/api/task';
const SECRET = process.env.HMAC_SECRET;
if (!SECRET) { console.error('HMAC_SECRET env required'); process.exit(1); }

const COMMITMENT_HEX = '0x19ac45e53990bfbd6219fab3b066bc549b2ad3851b9dba32e9eb117151416174';

const envelope = {
  protocolVersion: 'v1',
  eventId: 'steal-the-vfy',
  mode: 'practice',
  matchId: '11111111-2222-3333-4444-555555555555',
  turn: 1,
  state: { selfBalance: '100', opponentBalance: '100' },
  strategyCommitment: { hash: COMMITMENT_HEX },
};

const raw = JSON.stringify(envelope);
const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
const t0 = Date.now();
const res = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-agent-games-signature': sig },
  body: raw,
});
const ms = Date.now() - t0;
console.log('HTTP', res.status, `(${ms} ms)`);
const sigOut = res.headers.get('x-agent-games-signature');
console.log('response signed:', Boolean(sigOut));
const body = await res.json();
console.log('action:', JSON.stringify(body.action));
console.log('policyProof present:', Boolean(body.policyProof));
if (!body.policyProof) { console.log('FULL BODY:', JSON.stringify(body)); process.exit(1); }
console.log('circuitVersion:', body.policyProof.circuitVersion);
console.log('public_signals:', body.policyProof.public_signals.length, 'values');
console.log('publicInputsHash:', body.policyProof.publicInputsHash);
console.log('idempotencyKey:', body.idempotencyKey);
const vk = JSON.parse(fs.readFileSync('circuits/vk.json', 'utf8'));
const verified = await snarkjs.groth16.verify(vk, body.policyProof.public_signals, body.policyProof.proof);
console.log('local Groth16 verify:', verified ? 'OK' : 'FAILED');
// Verify the response signature too
const resSigOk = sigOut === crypto.createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex');
console.log('response HMAC valid:', resSigOk);
if (!verified || !resSigOk) process.exit(1);
console.log('LIVE TURN TEST PASSED');
process.exit(0);
