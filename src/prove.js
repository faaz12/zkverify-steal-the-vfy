// Groth16 proof generation for the vfy-policy circuit.
//
// HARD RULES (learned from the Gatekeeper build, same snarkjs behaviour):
//  1. VALIDATE every circuit input BEFORE calling fullProve — fullProve
//     with missing/incomplete inputs HANGS INDEFINITELY instead of erroring.
//  2. Never let proving block the turn past the 5-minute platform
//     deadline — prove with a ~10 s internal budget, then answer anyway
//     (a turn without a proof is resolved as HOLD, -2; a timeout is also
//     -2 but forfeits the action entirely).
//  3. Always groth16.verify locally before including a proof in a
//     response — never send a proof that does not verify locally.
//  4. The publicInputsHash MUST be computed from exactly the same values
//     as the circuit input, in exactly this order (the platform recomputes
//     it independently and rejects any divergence):
//       keccak256( commitment || matchId || turn || selfBalance
//                  || opponentBalance || action || amount || circuitVersion )
//     each as a 32-byte big-endian value.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';
import { concat, keccak256, numberToHex } from 'viem';
import { matchIdToBigInt } from './strategy.js';

export const PROVE_TIMEOUT_MS = Number(process.env.PROVE_TIMEOUT_MS || 10000);
export const ACTION_CODE = { HOLD: 0n, FORTIFY: 1n, EXTRACT: 2n };
// Circuit input uses "1"; the policyProof response uses "v1".
export const CIRCUIT_VERSION_INPUT = '1';
export const CIRCUIT_VERSION_RESPONSE = 'v1';

function resolveCircuitDir() {
  const fromModule = path.dirname(fileURLToPath(new URL('../circuits/', import.meta.url)));
  if (fs.existsSync(path.join(fromModule, 'vfy-policy.wasm'))) return fromModule;
  const fromCwd = path.join(process.cwd(), 'circuits');
  if (fs.existsSync(path.join(fromCwd, 'vfy-policy.wasm'))) return fromCwd;
  return fromModule; // let the file read fail loudly with the module path
}

export const CIRCUIT_DIR = resolveCircuitDir();
const WASM_PATH = path.join(CIRCUIT_DIR, 'vfy-policy.wasm');
const ZKEY_PATH = path.join(CIRCUIT_DIR, 'vfy-policy_final.zkey');
const VK_PATH = path.join(CIRCUIT_DIR, 'vk.json');

let vkCache = null;
export function loadVk() {
  if (!vkCache) vkCache = JSON.parse(fs.readFileSync(VK_PATH, 'utf8'));
  return vkCache;
}

function numToDecimal(value, field) {
  try {
    return BigInt(typeof value === 'string' ? value.trim() : value).toString();
  } catch {
    throw new Error(`field ${field}: expected a number, got ${JSON.stringify(value)}`);
  }
}

// Build the 10-field circuit input. Throws on ANY missing / malformed
// field — callers must catch and treat it as "cannot prove", never as a
// reason to hang or to change the move.
export function buildCircuitInput({ matchId, turn, state, move, commitmentDecimal, salt, params }) {
  if (matchId === undefined || matchId === null || matchId === '') {
    throw new Error('missing circuit input field: matchId');
  }
  if (turn === undefined || turn === null || turn === '') {
    throw new Error('missing circuit input field: turn');
  }
  if (!state || state.selfBalance === undefined || state.selfBalance === null || state.selfBalance === '') {
    throw new Error('missing circuit input field: state.selfBalance');
  }
  if (!state || state.opponentBalance === undefined || state.opponentBalance === null || state.opponentBalance === '') {
    throw new Error('missing circuit input field: state.opponentBalance');
  }
  if (!move || ACTION_CODE[move.type] === undefined) {
    throw new Error(`invalid move type: ${JSON.stringify(move?.type)}`);
  }
  if (!commitmentDecimal) throw new Error('missing circuit input field: commitment');
  if (salt === undefined || salt === null) throw new Error('missing circuit input field: salt');
  if (!params || params.length !== 8) throw new Error('strategyParams must have exactly 8 entries');
  return {
    commitment: numToDecimal(commitmentDecimal, 'commitment'),
    matchId: matchIdToBigInt(matchId).toString(),
    turnNumber: numToDecimal(turn, 'turn'),
    selfBalance: numToDecimal(state.selfBalance, 'selfBalance'),
    opponentBalance: numToDecimal(state.opponentBalance, 'opponentBalance'),
    action: ACTION_CODE[move.type].toString(),
    amount: numToDecimal(move.amountNum, 'amount'),
    circuitVersion: CIRCUIT_VERSION_INPUT,
    salt: numToDecimal(salt, 'salt'),
    strategyParams: params.map((p) => numToDecimal(p, 'strategyParams')),
  };
}

export function computePublicInputsHash({ commitmentDecimal, matchId, turn, state, move }) {
  return keccak256(
    concat([
      numberToHex(BigInt(commitmentDecimal), { size: 32 }),
      numberToHex(matchIdToBigInt(matchId), { size: 32 }),
      numberToHex(BigInt(turn), { size: 32 }),
      numberToHex(BigInt(state.selfBalance), { size: 32 }),
      numberToHex(BigInt(state.opponentBalance), { size: 32 }),
      numberToHex(ACTION_CODE[move.type], { size: 32 }),
      numberToHex(BigInt(move.amountNum), { size: 32 }),
      numberToHex(1n, { size: 32 }),
    ]),
  );
}

// Prove with an internal time budget. Returns:
//   { ok: true, proof, publicSignals, publicInputsHash, proveMs }
//   { ok: false, error }   (validation failure, timeout, witness assert, or
//                            local verify failure — the caller must still
//                            return the move WITHOUT the proof)
export async function prove({ matchId, turn, state, move, commitmentDecimal, salt, params }, timeoutMs = PROVE_TIMEOUT_MS) {
  let circuitInput;
  try {
    circuitInput = buildCircuitInput({ matchId, turn, state, move, commitmentDecimal, salt, params });
  } catch (e) {
    return { ok: false, error: `input validation: ${e.message}` };
  }

  const t0 = Date.now();
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  // NOTE: if fullProve hangs (the known incomplete-input quirk), the race
  // below still resolves on timeout, but the hung promise keeps the event
  // loop busy in the background. Validation above makes that path
  // unreachable for well-formed inputs; the timeout is a safety net.
  const work = snarkjs.groth16.fullProve(circuitInput, WASM_PATH, ZKEY_PATH)
    .then((r) => ({ ...r, timedOut: false }))
    .catch((e) => ({ error: e }));
  const result = await Promise.race([work, timeout]);
  clearTimeout(timeoutId);

  if (result.timedOut) return { ok: false, error: `prove timed out after ${timeoutMs} ms` };
  if (result.error) return { ok: false, error: `fullProve failed: ${String(result.error).slice(0, 300)}` };

  const { proof, publicSignals } = result;
  let verified = false;
  try {
    verified = await snarkjs.groth16.verify(loadVk(), publicSignals, proof);
  } catch (e) {
    return { ok: false, error: `local verify threw: ${String(e).slice(0, 200)}` };
  }
  if (!verified) return { ok: false, error: 'local groth16.verify returned false' };

  let publicInputsHash;
  try {
    publicInputsHash = computePublicInputsHash({ commitmentDecimal, matchId, turn, state, move });
  } catch (e) {
    return { ok: false, error: `publicInputsHash failed: ${String(e).slice(0, 200)}` };
  }
  return { ok: true, proof, publicSignals, publicInputsHash, proveMs: Date.now() - t0 };
}
