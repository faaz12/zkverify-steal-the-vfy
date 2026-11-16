// Shared turn-handling flow, used by both the local plain-Node server
// (scripts/local-server.js) and the Vercel entry (api/task.js).
//
// Flow:
//   1. raw body -> verify HMAC -> 401 if bad (no work, no store poison)
//   2. parse JSON
//   3. preflight (type "agent-games.preflight.v1", or any signed request
//      that is not a turn) -> {ok:true, protocolVersion:"v1"}, signed
//   4. Steal the VFY turn (eventId "steal-the-vfy"):
//      a. validate matchId / turn / state -> 400 if unusable
//      b. dedupe by (matchId, turn) -> return the stored response if
//         already answered (same idempotencyKey — never re-decide/re-prove)
//      c. decide the move from the committed policy (strategy.js)
//      d. prove (10 s budget, local verify) — on ANY proof failure, still
//         return the move WITHOUT the proof. A turn without a proof is
//         resolved as HOLD (-2); a timeout forfeits the move entirely.
//         Never let proving block the move past the 5 min turn deadline.
//      e. respond {matchId, turn, action, policyProof?, agentTimestamp,
//         idempotencyKey} signed with x-agent-games-signature
//      f. record the response in the store BEFORE responding (Vercel
//         freezes a function right after it responds, so a fire-and-
//         forget write can be killed mid-retry — and a lost write means a
//         retried turn gets a NEW idempotencyKey, which the platform
//         rejects).
import crypto from 'node:crypto';
import { verifyHmac, signHmac } from './hmac.js';
import { getStrategyConfig, computeCommitment, decideMove } from './strategy.js';
import { prove, CIRCUIT_VERSION_RESPONSE } from './prove.js';
import { turnCacheKey } from './store.js';

export const PREFLIGHT = { ok: true, protocolVersion: 'v1' };

function log(msg, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), component: 'handler', msg, ...extra }));
}

export function createHandler({ hmacSecret, store }) {
  if (!hmacSecret) {
    throw new Error('HMAC_SECRET is not set — refusing to start (fail closed)');
  }

  async function handleTask(rawBody, headers) {
    const signature = headers['x-agent-games-signature'] || headers['X-Agent-Games-Signature'];
    if (!verifyHmac(hmacSecret, rawBody, signature)) {
      log('hmac verification failed', { signaturePresent: Boolean(signature) });
      return { status: 401, body: { error: 'invalid signature' } };
    }

    // The platform's signed preflight probe may carry no turn fields (and
    // its exact body shape is undocumented) — it only needs HTTP 200. Any
    // HMAC-signed request that is not a turn IS the preflight: answer it
    // with the preflight object, signed. Real turns always carry eventId
    // "steal-the-vfy" plus matchId and turn.
    let envelope;
    try {
      envelope = JSON.parse(rawBody.toString('utf8'));
    } catch {
      log('signed non-JSON body, answering preflight');
      const pre = JSON.stringify(PREFLIGHT);
      return { status: 200, body: PREFLIGHT, signature: signHmac(hmacSecret, Buffer.from(pre)) };
    }

    if (envelope.type === 'agent-games.preflight.v1') {
      const pre = JSON.stringify(PREFLIGHT);
      return { status: 200, body: PREFLIGHT, signature: signHmac(hmacSecret, Buffer.from(pre)) };
    }

    if (envelope.eventId !== 'steal-the-vfy') {
      log('signed request is not a steal-the-vfy turn, answering preflight', { eventId: envelope.eventId, type: envelope.type });
      const pre = JSON.stringify(PREFLIGHT);
      return { status: 200, body: PREFLIGHT, signature: signHmac(hmacSecret, Buffer.from(pre)) };
    }

    const { matchId, turn, state } = envelope;
    if (!matchId || turn === undefined || turn === null || !state
      || state.selfBalance === undefined || state.selfBalance === null
      || state.opponentBalance === undefined || state.opponentBalance === null) {
      log('turn envelope missing matchId/turn/state, cannot form a response', { matchId, turn, state });
      return { status: 400, body: { error: 'invalid turn envelope' } };
    }

    // Idempotency: the platform may retry after a network failure. Return
    // the exact stored response; do not re-decide and do not re-prove.
    const cacheKey = turnCacheKey(matchId, turn);
    const stored = store.getResponse(cacheKey);
    if (stored) {
      log('duplicate turn, returning stored response', { matchId, turn });
      return { status: 200, body: stored, signature: signHmac(hmacSecret, Buffer.from(JSON.stringify(stored))) };
    }

    const t0 = Date.now();
    let config;
    try {
      config = getStrategyConfig();
    } catch (e) {
      log('strategy config failed', { error: String(e).slice(0, 200) });
      return { status: 500, body: { error: 'strategy not configured' } };
    }
    const { params, salt } = config;

    // The frozen commitment hash arrives in the envelope; fall back to the
    // locally computed one (they must be identical — a mismatch means the
    // registered commitment differs from this server's params/salt, and
    // every proof will be rejected; log it loudly).
    let commitmentDecimal;
    try {
      const computed = await computeCommitment(params, salt);
      if (envelope.strategyCommitment?.hash) {
        commitmentDecimal = BigInt(envelope.strategyCommitment.hash).toString();
        if (commitmentDecimal !== computed.decimal) {
          log('WARNING: envelope commitment != locally computed commitment — registered params/salt differ from this server', {
            matchId, turn, envelopeCommitment: commitmentDecimal.slice(0, 20), localCommitment: computed.decimal.slice(0, 20),
          });
        }
      } else {
        commitmentDecimal = computed.decimal;
      }
    } catch (e) {
      log('commitment computation failed', { error: String(e).slice(0, 200) });
      return { status: 500, body: { error: 'commitment failed' } };
    }

    const move = decideMove(state, params);
    log('move decided', { matchId, turn, move: move.type, amount: move.amountNum, selfBalance: state.selfBalance, opponentBalance: state.opponentBalance, decideMs: Date.now() - t0 });

    // HOLD and FORTIFY must OMIT action.amount entirely — the schema
    // rejects the field even when it is 0.
    const action = move.type === 'EXTRACT'
      ? { type: 'EXTRACT', amount: move.amountNum }
      : { type: move.type };

    const response = {
      matchId,
      turn,
      action,
      agentTimestamp: new Date().toISOString(),
      idempotencyKey: crypto.randomUUID(),
    };

    const pr = await prove({ matchId, turn, state, move, commitmentDecimal, salt, params });
    if (pr.ok) {
      response.policyProof = {
        circuitVersion: CIRCUIT_VERSION_RESPONSE,
        proof: pr.proof,
        public_signals: pr.publicSignals,
        publicInputsHash: pr.publicInputsHash,
      };
      log('proof generated + locally verified', { matchId, turn, proveMs: pr.proveMs });
    } else {
      // Correct move without proof scores as HOLD, -2 — still better than
      // timing out (also -2 but forfeits the move). Log loudly.
      log('WARNING: proof not generated, returning move without proof', { matchId, turn, error: pr.error });
    }

    // Record BEFORE responding (see flow step 4f).
    await store.record(cacheKey, response).catch(() => {});

    const bodyStr = JSON.stringify(response);
    return { status: 200, body: response, signature: signHmac(hmacSecret, Buffer.from(bodyStr)) };
  }

  return { handleTask };
}
