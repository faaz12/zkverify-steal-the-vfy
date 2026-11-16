// Steal the VFY strategy: Poseidon-committed policy.
//
// The vfy-policy circuit enforces ONE policy shape. The strategy is fully
// described by 8 private parameters + a private salt; the public commitment
// is Poseidon([...params, salt]). The platform registers the commitment at
// agent registration; every turn's proof shows the chosen move follows from
// those committed parameters, without revealing them.
//
// Policy (exactly what the circuit enforces):
//   selfBalance < params[1]      -> FORTIFY
//   opponentBalance < params[2]  -> HOLD
//   otherwise                    -> EXTRACT params[0] (1..10)
//
// Default params "8,18,8,0,0,0,0,0" (same as the proven reference agent):
//   params[0] = 8   EXTRACT amount when both balances are healthy
//   params[1] = 18  FORTIFY when our balance drops below 18 (protect what's left)
//   params[2] = 8   HOLD when the opponent is nearly dead (nothing worth taking)
//   params[3..7] = 0  unused by this circuit version
//
// WARNING: params and salt are FROZEN at registration. Changing either
// afterwards produces a different commitment hash, and every proof will be
// rejected (circuitVersion / commitment mismatch). Change them only BEFORE
// registering, then re-run `npm run commitment` and register the new hash.
import { buildPoseidon } from 'circomlibjs';

export const DEFAULT_PARAMS = '8,18,8,0,0,0,0,0';

let poseidonPromise = null;
function getPoseidon() {
  if (!poseidonPromise) poseidonPromise = buildPoseidon();
  return poseidonPromise;
}

export function getStrategyConfig() {
  const rawParams = process.env.STEAL_VFY_PARAMS || DEFAULT_PARAMS;
  const parts = rawParams.split(',').map((x) => BigInt(x.trim()));
  if (parts.length !== 8) {
    throw new Error('STEAL_VFY_PARAMS must have exactly 8 comma-separated integers');
  }
  const saltRaw = process.env.STEAL_VFY_SALT;
  if (!saltRaw) {
    throw new Error('STEAL_VFY_SALT is not set — refusing to start (fail closed)');
  }
  const salt = BigInt(saltRaw.trim());
  return { params: parts, salt };
}

export async function computeCommitment(params, salt) {
  const poseidon = await getPoseidon();
  const hashBigInt = poseidon.F.toObject(poseidon([...params, salt]));
  const hex = '0x' + hashBigInt.toString(16).padStart(64, '0');
  return { decimal: hashBigInt.toString(), hex };
}

// Deterministic policy matching vfy-policy.wasm constraints.
export function decideMove(state, params) {
  const selfBalance = BigInt(state.selfBalance ?? 0);
  const opponentBalance = BigInt(state.opponentBalance ?? 0);
  if (selfBalance < params[1]) {
    return { type: 'FORTIFY', amountNum: 0 };
  }
  if (opponentBalance < params[2]) {
    return { type: 'HOLD', amountNum: 0 };
  }
  return { type: 'EXTRACT', amountNum: Number(params[0]) };
}

// matchId is a UUID ("9f4e1b2a-1111-2222-3333-444455556666"): strip the
// dashes (and any 0x prefix) and interpret the hex as a big integer.
export function matchIdToBigInt(matchId) {
  const hex = String(matchId).replace(/^0x/i, '').replace(/-/g, '');
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`matchId is not hex/UUID: ${JSON.stringify(matchId)}`);
  }
  return BigInt('0x' + hex);
}
