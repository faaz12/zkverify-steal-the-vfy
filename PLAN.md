# zkVerify Agent Games — Steal the VFY: Build Plan + Status

**Status (16 Nov 2026, ~10:30 WIB): BUILT + TESTED LOCALLY, NOT YET
REGISTERED.** The agent is complete and all 10 local checks pass. What
remains needs the dashboard in the user's browser: agent registration
(+ strategy commitment), HMAC secret into Vercel env, preflight +
practice turn. See §5.

Competition account already registered 15 Nov via X `@nawijikk` (email
goletupo@gmail.com). GitHub `faaz12` connected. Sibling agent Proof
Gatekeeper (`faaz12/zkverify-gatekeeper`, https://gatekeeper-five-rho.vercel.app)
is live, practice 4/4 correct, Round 04 tonight 16 Nov 17:30 WIB.

Prize: 100,000 VFY (1st 50,000 / 2nd 30,000 / 3rd 20,000). Entry free.
Steal the VFY schedule 13–17 Nov 2026 — ENDS TOMORROW. Swiss 7 rounds,
200–300 agents, Top 16 knockout. Match 15–25 min, 20 turns, 5 min/turn.

---

## 1. Protocol (verified from the official docs + a working reference agent)

Sources: https://agentgames.zkverify.io/build (§06 Steal the VFY),
/events/steal-the-vfy, /api/circuit-info, /rules; reference implementation
https://github.com/DaddyUnikii/zkverify-agent (dev.to write-up 16 Nov
02:08 UTC — a live dual-track Gatekeeper + Steal the VFY agent).

### 1.1 Circuit artifacts — authentic, downloaded
- `circuits/vfy-policy.wasm` — 2,991,212 bytes, SHA-256
  `bc0998250d2baf75b89deef5306867ffa7085a08d4f7d2caf0dd63a060b134d2`
- `circuits/vfy-policy_final.zkey` — 810,586 bytes, SHA-256
  `f9666a1655279ef27f7fee6d535ac8aa9e39286ac40ff6279fea87c21ab6ce41`
- `circuits/vk.json` exported from the zkey with snarkjs: protocol
  `groth16`, curve `bn128`, **nPublic = 9**. Template name (from wasm
  strings): `VfyPolicyProof_154` (Poseidon + comparison gadgets).
- vkHash (from `/api/circuit-info`, matches the reference):
  `0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047`

### 1.2 Strategy commitment (Poseidon)
- Private: `strategyParams[0..7]` (8 integers) + random `salt`.
- Public commitment: `Poseidon([...params, salt])` — registered on the
  dashboard before the round pairs; frozen afterwards.
- This agent's commitment (params `8,18,8,0,0,0,0,0`, salt in
  `~/.zkverify/steal-vfy-salt`, mode 600):
  - hex: `0x19ac45e53990bfbd6219fab3b066bc549b2ad3851b9dba32e9eb117151416174`
  - dec: `11612201310111604043534722997388584275375417996504349326542353150641566736756`
- **Changing params or salt after registration breaks every proof.**
  Recompute with `npm run commitment` only BEFORE registering.

### 1.3 Policy (the circuit enforces exactly this shape)
- `selfBalance < params[1]` → FORTIFY
- `opponentBalance < params[2]` → HOLD
- otherwise → EXTRACT `params[0]` (1..10)

Default params `8,18,8,0,0,0,0,0`: EXTRACT 8 when healthy, FORTIFY
below 18 (protect what's left), HOLD when the opponent is nearly dead
(< 8, nothing worth taking). The brief's suggested shape ("fortify when
own balance is HIGH") is NOT expressible in this circuit — the circuit
is authoritative; the committed thresholds are the only free choice.

### 1.4 Turn envelope (incoming)
```json
{
  "protocolVersion": "v1",
  "eventId": "steal-the-vfy",
  "mode": "practice",
  "matchId": "9f4e1b2a-1111-2222-3333-444455556666",
  "turn": 1,
  "state": { "selfBalance": "100", "opponentBalance": "100" },
  "strategyCommitment": { "hash": "0x..." }
}
```
- HMAC: hex HMAC-SHA256 over the raw body, header
  `x-agent-games-signature` (same scheme as Gatekeeper — proven).
- `matchId` is a UUID; the circuit takes it as a big integer of the
  dash-stripped hex.

### 1.5 Response (outgoing, signed the same way)
```json
{
  "matchId": "...", "turn": 1,
  "action": { "type": "EXTRACT", "amount": 8 },
  "policyProof": {
    "circuitVersion": "v1",
    "proof": { "pi_a": [...], "pi_b": [[...]], "pi_c": [...], "protocol": "groth16", "curve": "bn128" },
    "public_signals": ["...9 values..."],
    "publicInputsHash": "0x..."
  },
  "agentTimestamp": "...",
  "idempotencyKey": "uuid-v4"
}
```
- `HOLD` and `FORTIFY` MUST omit `action.amount` entirely (schema
  rejects it even when 0).
- `proof` and `public_signals` MUST sit INSIDE `policyProof`, not at the
  top level (#1 cause of lost turns).
- `publicInputsHash` = keccak256 of 8 × 32-byte big-endian values, in
  order: commitment, matchId, turn, selfBalance, opponentBalance,
  actionCode (HOLD 0 / FORTIFY 1 / EXTRACT 2), amount, circuitVersion
  (1). The platform recomputes it independently and rejects divergence.
- Circuit input uses `circuitVersion: "1"`; the response uses `"v1"`.
- `idempotencyKey` is fresh per turn but STABLE across retries of the
  same turn (response cached by `(matchId, turn)`).

### 1.6 Scoring
Win +18, draw +9, loss +3; verified-turn reliability +0 to +2; timeout
−1/turn; invalid policy proof −2/turn. A move without a proof resolves
as HOLD (−2) — so on proof failure we still return the move.

---

## 2. What was built

Under `~/workspace/zkverify/steal-the-vfy/` (Node.js ESM, no framework):

| File | What it does |
|---|---|
| `src/strategy.js` | params/salt config, Poseidon commitment, `decideMove`, `matchIdToBigInt` |
| `src/prove.js` | 10-field circuit input builder (validates FIRST), `fullProve` with 10 s budget, local `groth16.verify`, `publicInputsHash` (viem keccak256) |
| `src/hmac.js` | hex HMAC-SHA256 verify/sign (copied from Gatekeeper, proven) |
| `src/store.js` | turn-response cache, in-memory + GitHub-file `data/turns.jsonl` (same pattern as Gatekeeper's seen-set) |
| `src/handler.js` | HMAC → preflight → turn → dedupe → decide → prove → sign → record-before-respond |
| `api/task.js` | Vercel entry, POST /api/task, bodyParser off (raw-body HMAC) |
| `api/health.js`, `api/index.js` | GET preflight `{ok:true, protocolVersion:"v1"}` |
| `scripts/local-server.js` | plain-Node dev server (:3000) |
| `scripts/commitment.js` | prints commitment hex + dec for registration |
| `tests/policy-matrix.js` | 10 checks (see §3) |

Deps (pinned): `snarkjs 0.7.5`, `circomlibjs 0.1.7`, `viem 2.57.20`.

### Bugs found + fixed during build
1. **HOLD is falsy.** `ACTION_CODE = {HOLD: 0n, ...}` — the validation
   `!ACTION_CODE[move.type]` rejected HOLD because `0n` is falsy.
   Fixed to `ACTION_CODE[move.type] === undefined`. Caught by the test
   matrix (EXTRACT + FORTIFY passed first, HOLD failed), not by
   inspection.

---

## 3. Test results (16 Nov 2026, this VM)

`npm test` — **ALL 10 CHECKS PASSED**:
- HMAC sign & verify; preflight (explicit type); preflight (signed
  non-turn request); HMAC 401 on bad signature.
- EXTRACT (100/100) → `{"type":"EXTRACT","amount":8}`, proof verified,
  1,473 ms.
- FORTIFY (10/100) → `{"type":"FORTIFY"}`, proof verified, 854 ms.
- HOLD (100/5) → `{"type":"HOLD"}`, proof verified, 741 ms.
- Dedupe: duplicate turn returns the identical response (same
  idempotencyKey). Malformed envelope → 400. Unsupported event →
  preflight.

Prove latency ~0.7–1.5 s — far inside the 5 min turn deadline and the
10 s Vercel Hobby function cap. `npm run commitment` verified: prints
the hex + dec commitment above.

---

## 4. Registration status — NOT DONE (needs the dashboard)

The agent is NOT registered yet. Registration, preflight and practice
require the signed-in dashboard in the user's browser — a subagent
cannot do that part. What the parent must do (device browser):

1. **Create the agent** on https://agentgames.zkverify.io (dashboard →
   Register agent → event Steal the VFY):
   - Name, e.g. `faaz12-steal-the-vfy`
   - Repo: `https://github.com/faaz12/zkverify-steal-the-vfy` (public)
   - Endpoint: `https://<vercel-project>.vercel.app/api/task`
   - Strategy commitment hash: `0x19ac45e53990bfbd6219fab3b066bc549b2ad3851b9dba32e9eb117151416174`
     (from `npm run commitment`; decimal form also on file if the form
     wants it)
2. **Save the HMAC secret** shown exactly once → into Vercel env
   `HMAC_SECRET` (production) + `~/.zkverify/steal-vfy-hmac-secret`
   (mode 600). This agent gets its OWN secret — do NOT reuse the
   Gatekeeper's.
3. Set Vercel env `STEAL_VFY_PARAMS=8,18,8,0,0,0,0,0` and
   `STEAL_VFY_SALT=<value in ~/.zkverify/steal-vfy-salt>`, then
   `vercel --prod` to redeploy with the real env.
4. **Preflight** from the dashboard (must return
   `{ok:true, protocolVersion:"v1"}`).
5. **Practice turn** from the dashboard (≥1 required before scored
   rounds) — verify the move + proof are accepted.

### Open question: is the track still open?
- The event page says: "register mid-tournament to join from the next
  Swiss round, until the final round is paired."
- BUT one participant (Skylar, Medium 15 Nov) reports: "Steal the VFY
  had already locked. Entries lock once the tournament is paired, and
  the Swiss rounds started on 13 November."
- The dashboard is the only authority. If registration is refused, the
  agent is still complete and correct — it simply cannot enter this
  edition. Do NOT fake a registration or submit a broken agent.

---

## 5. Deployment

- Repo: https://github.com/faaz12/zkverify-steal-the-vfy (public, MIT)
- Vercel: https://<project>.vercel.app (fill in after deploy)
- Env (production): `HMAC_SECRET` (placeholder until registration),
  `STEAL_VFY_PARAMS=8,18,8,0,0,0,0,0`,
  `STEAL_VFY_SALT` (value in `~/.zkverify/steal-vfy-salt`).
- Secrets live ONLY in Vercel env + `~/.zkverify/` (mode 600). Never in
  the repo, never in chat.

## 6. Sources

- https://agentgames.zkverify.io/build
- https://agentgames.zkverify.io/events/steal-the-vfy
- https://agentgames.zkverify.io/api/circuit-info
- https://agentgames.zkverify.io/rules
- Reference implementation: https://github.com/DaddyUnikii/zkverify-agent
  + https://dev.to/0xxxxxxxx/shipping-verifiable-agents-for-zkverify-agentgames-proof-gatekeeper-steal-the-vfy-and-zkguard-2bm2
- Sibling agent: https://github.com/faaz12/zkverify-gatekeeper
