// Steal the VFY policy-matrix test.
//
// Covers: HMAC sign/verify + 401, preflight, the three moves
// (EXTRACT / FORTIFY / HOLD) with locally-verified Groth16 proofs,
// HOLD/FORTIFY omitting action.amount, publicInputsHash shape,
// turn dedupe (same matchId+turn returns the identical response),
// and the commitment round-trip (envelope hash == locally computed).
//
// Env for tests (in-memory store, no GitHub writes):
//   STORE_BACKEND=memory, HMAC_SECRET=test..., STEAL_VFY_SALT=test...
// Run: npm test
import assert from 'node:assert';

process.env.STORE_BACKEND = 'memory';
process.env.HMAC_SECRET = 'test_hmac_secret_32_bytes_1234567890';
process.env.STEAL_VFY_SALT = '12345678901234567890';
// STEAL_VFY_PARAMS left unset -> default "8,18,8,0,0,0,0,0"

const { createHandler, PREFLIGHT } = await import('../src/handler.js');
const { TurnStore } = await import('../src/store.js');
const { verifyHmac, signHmac } = await import('../src/hmac.js');
const { getStrategyConfig, computeCommitment } = await import('../src/strategy.js');
const { loadVk } = await import('../src/prove.js');
const snarkjs = await import('snarkjs');

const SECRET = process.env.HMAC_SECRET;
const store = new TurnStore();
await store.load();
const { handleTask } = createHandler({ hmacSecret: SECRET, store });
const vk = loadVk();

async function post(bodyObj, secret = SECRET) {
  const raw = Buffer.from(JSON.stringify(bodyObj));
  const sig = signHmac(secret, raw);
  return handleTask(raw, { 'x-agent-games-signature': sig });
}

let passed = 0;
function ok(name) {
  passed++;
  console.log(`[PASS] ${name}`);
}

// 1. HMAC sign & verify
{
  const body = JSON.stringify({ hello: 'world' });
  const sig = signHmac(SECRET, Buffer.from(body));
  assert.strictEqual(verifyHmac(SECRET, Buffer.from(body), sig), true);
  assert.strictEqual(verifyHmac(SECRET, Buffer.from(body), '0'.repeat(64)), false);
  ok('HMAC sign & verify');
}

// 2. Preflight (explicit type)
{
  const res = await post({ type: 'agent-games.preflight.v1' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, PREFLIGHT);
  assert.ok(res.signature, 'preflight response is signed');
  ok('preflight (explicit type)');
}

// 3. Preflight (signed non-turn request)
{
  const res = await post({ hello: 'probe' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, PREFLIGHT);
  ok('preflight (signed non-turn request)');
}

// 4. HMAC 401
{
  const res = await post({ type: 'agent-games.preflight.v1' }, 'wrong_secret_32_bytes_1234567890');
  assert.strictEqual(res.status, 401);
  ok('HMAC 401 on bad signature');
}

// 5. Commitment round-trip
const { params, salt } = getStrategyConfig();
const commitment = await computeCommitment(params, salt);
console.log(`  commitment hex: ${commitment.hex}`);
console.log(`  commitment dec: ${commitment.decimal}`);

// 6. The three moves + locally-verified proofs
const MATCH_ID = '9f4e1b2a-1111-2222-3333-444455556666';
const cases = [
  { name: 'EXTRACT', selfBalance: '100', opponentBalance: '100', expectedAction: 'EXTRACT', expectedAmount: 8 },
  { name: 'FORTIFY', selfBalance: '10', opponentBalance: '100', expectedAction: 'FORTIFY' },
  { name: 'HOLD', selfBalance: '100', opponentBalance: '5', expectedAction: 'HOLD' },
];

const responses = [];
for (let i = 0; i < cases.length; i++) {
  const vc = cases[i];
  const t0 = Date.now();
  const res = await post({
    protocolVersion: 'v1',
    eventId: 'steal-the-vfy',
    mode: 'practice',
    matchId: MATCH_ID,
    turn: i + 1,
    state: { selfBalance: vc.selfBalance, opponentBalance: vc.opponentBalance },
    strategyCommitment: { hash: commitment.hex },
  });
  assert.strictEqual(res.status, 200, `${vc.name}: status 200`);
  assert.strictEqual(res.body.matchId, MATCH_ID, `${vc.name}: matchId echo`);
  assert.strictEqual(res.body.turn, i + 1, `${vc.name}: turn echo`);
  assert.strictEqual(res.body.action.type, vc.expectedAction, `${vc.name}: action`);
  if (vc.expectedAction === 'EXTRACT') {
    assert.strictEqual(res.body.action.amount, vc.expectedAmount, `${vc.name}: amount`);
  } else {
    assert.strictEqual('amount' in res.body.action, false, `${vc.name}: HOLD/FORTIFY must omit amount`);
  }
  assert.ok(res.body.policyProof, `${vc.name}: policyProof present`);
  assert.strictEqual(res.body.policyProof.circuitVersion, 'v1', `${vc.name}: circuitVersion v1`);
  assert.ok(res.body.policyProof.proof, `${vc.name}: proof present`);
  assert.ok(Array.isArray(res.body.policyProof.public_signals), `${vc.name}: public_signals present`);
  assert.strictEqual(res.body.policyProof.public_signals.length, 9, `${vc.name}: 9 public signals`);
  assert.match(res.body.policyProof.publicInputsHash, /^0x[0-9a-f]{64}$/, `${vc.name}: publicInputsHash shape`);
  assert.ok(res.body.idempotencyKey, `${vc.name}: idempotencyKey present`);
  const verified = await snarkjs.groth16.verify(vk, res.body.policyProof.public_signals, res.body.policyProof.proof);
  assert.strictEqual(verified, true, `${vc.name}: Groth16 proof must verify`);
  assert.ok(res.signature, `${vc.name}: response signed`);
  responses.push(res.body);
  ok(`Steal the VFY ${vc.name} -> ${JSON.stringify(res.body.action)}, proof verified (${Date.now() - t0} ms)`);
}

// 7. Dedupe: same (matchId, turn) returns the IDENTICAL response
{
  const res = await post({
    protocolVersion: 'v1',
    eventId: 'steal-the-vfy',
    mode: 'practice',
    matchId: MATCH_ID,
    turn: 1,
    state: { selfBalance: '100', opponentBalance: '100' },
    strategyCommitment: { hash: commitment.hex },
  });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, responses[0], 'duplicate turn returns identical response');
  ok('dedupe: duplicate turn returns identical response (same idempotencyKey)');
}

// 8. Malformed turn envelope -> 400, not a crash
{
  const res = await post({ eventId: 'steal-the-vfy', matchId: MATCH_ID });
  assert.strictEqual(res.status, 400);
  ok('malformed turn envelope -> 400');
}

// 9. Unsupported event -> preflight (not a crash)
{
  const res = await post({ eventId: 'something-else' });
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body, PREFLIGHT);
  ok('unsupported event -> preflight');
}

console.log(`\nALL TESTS PASSED (${passed} checks)!`);
process.exit(0);
