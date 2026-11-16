# zkVerify Agent Games — Steal the VFY agent

Steal the VFY agent for [zkVerify Agent Games](https://agentgames.zkverify.io/events/steal-the-vfy).
A 20-turn head-to-head match: both agents start at 100 VFY and play
`HOLD`, `FORTIFY`, or `EXTRACT N` simultaneously. Every move carries a
Groth16 policy proof (`vfy-policy.wasm`, `nPublic: 9`, vkHash
`0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047`)
that the move follows the strategy committed before the round — without
revealing the strategy.

## How it works

1. **Strategy commitment (Poseidon).** Before the round pairs, the agent
   commits `Poseidon([...strategyParams, salt])` on the dashboard. The 8
   private params + private salt are never revealed; the proof shows the
   move follows from them.
2. **Policy (exactly what the circuit enforces).**
   - `selfBalance < params[1]` → `FORTIFY`
   - `opponentBalance < params[2]` → `HOLD`
   - otherwise → `EXTRACT params[0]` (1..10)
3. **Per turn.** The platform posts a signed turn envelope
   (`eventId: "steal-the-vfy"`, `matchId`, `turn`, `state: {selfBalance,
   opponentBalance}`, `strategyCommitment.hash`). The agent verifies the
   HMAC, decides the move, generates the Groth16 proof locally with
   `snarkjs`, computes the `publicInputsHash` (keccak256 of the 8 game-state
   values, each 32-byte big-endian), and responds signed.
4. **Idempotency.** Responses are cached by `(matchId, turn)` and persisted
   to `data/turns.jsonl` in this repo — a retried turn returns the exact
   stored response (same `idempotencyKey`), never a re-decision.

## Default strategy

Params `8,18,8,0,0,0,0,0` (same shape as the proven reference agent):

| Param | Value | Meaning |
|---|---|---|
| `params[0]` | 8 | EXTRACT 8 when both balances are healthy |
| `params[1]` | 18 | FORTIFY when our balance drops below 18 |
| `params[2]` | 8 | HOLD when the opponent is nearly dead (< 8) |
| `params[3..7]` | 0 | unused by this circuit version |

## Quick start

```bash
npm install
cp .env.example .env
# Set HMAC_SECRET from the dashboard (each agent gets its OWN secret),
# STEAL_VFY_PARAMS and STEAL_VFY_SALT.
npm test          # 10 checks: HMAC, preflight, 3 moves + local proof verify, dedupe
npm start         # local server on :3000
```

Generate the strategy commitment hash for dashboard registration:

```bash
STEAL_VFY_PARAMS=8,18,8,0,0,0,0,0 STEAL_VFY_SALT=<salt> npm run commitment
```

**Never change params or salt after registering** — the commitment is
frozen and every proof would be rejected.

## Deploy (Vercel, free Hobby)

```bash
vercel --prod
vercel env add HMAC_SECRET production
vercel env add STEAL_VFY_PARAMS production
vercel env add STEAL_VFY_SALT production
vercel --prod   # redeploy so the new env vars take effect
curl -s https://<project>.vercel.app/api/health
# {"ok":true,"protocolVersion":"v1"}
```

Register the endpoint (`https://<project>.vercel.app/api/task`) on the
[Agent Games dashboard](https://agentgames.zkverify.io) for the Steal the
VFY event, paste the commitment hash from `npm run commitment`, save the
HMAC secret shown once into the Vercel env, then run preflight + a
practice turn from the dashboard.

## Response shape

```json
{
  "matchId": "9f4e1b2a-1111-2222-3333-444455556666",
  "turn": 3,
  "action": { "type": "EXTRACT", "amount": 8 },
  "policyProof": {
    "circuitVersion": "v1",
    "proof": { "pi_a": [...], "pi_b": [[...]], "pi_c": [...], "protocol": "groth16", "curve": "bn128" },
    "public_signals": ["...", "...", "...", "...", "...", "...", "...", "...", "..."],
    "publicInputsHash": "0x..."
  },
  "agentTimestamp": "2026-11-16T03:30:00.000Z",
  "idempotencyKey": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

`HOLD` and `FORTIFY` omit `action.amount` entirely — the schema rejects
the field even when it is `0`. If proof generation fails, the move is
still returned without `policyProof` (the turn resolves as HOLD, −2);
the agent never times out a turn on purpose.

## Scoring (event page)

Match win +18, draw +9, loss +3; verified-turn reliability +0 to +2;
timeout −1/turn; invalid policy proof −2/turn. Swiss 7 rounds → Top 16
knockout. 100,000 VFY per track (1st 50k / 2nd 30k / 3rd 20k).

## Sources

- https://agentgames.zkverify.io/build (Builder Field Guide)
- https://agentgames.zkverify.io/events/steal-the-vfy
- https://agentgames.zkverify.io/api/circuit-info (vkHash + artifact URLs)
- Reference implementation (protocol reverse-engineered from it):
  https://github.com/DaddyUnikii/zkverify-agent
- Sibling agent (Proof Gatekeeper, same account):
  https://github.com/faaz12/zkverify-gatekeeper
